import type {
  AttachmentSummary,
  CostEstimateBreakdown,
  DepthPreset,
  DocMode,
  PricingConfig,
  UsageWindowSnapshot,
  UserAccountProfile,
} from '../types.ts';

export const SUPER_ADMIN_EMAIL = 'howardli00101@gmail.com';

export const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Default Pricing & Rate Limit Standards derived from Gemini 4 Carbon token economics:
 * - Input tokens: $2.50 / 1M = ¥18.00 / 1M tokens
 * - Output + Thinking tokens: $15.00 / 1M = ¥108.00 / 1M tokens
 * - Pay-Per-PDF Gross Margin: 50% (Retail Price = API Cost / (1 - 0.50) = 2.0x API Cost)
 * - Monthly Pro Plan: ¥300 / month at 30% Gross Margin
 *   -> Max Monthly API Cost Budget = ¥300 * (1 - 0.30) = ¥210.00 / month (¥49.00 / week)
 *   -> Weekly Limit (7-day rolling): 570,000 Carbon tokens (~140 A4 pages / 14 tasks)
 *   -> 6-Hour Window Limit (Gemini Web style): 120,000 Carbon tokens (~30 A4 pages / 4 tasks)
 */
export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  inputTokenPricePerMillionCny: 18.0,
  outputTokenPricePerMillionCny: 108.0,
  payPerPdfGrossMargin: 0.5,
  monthlyPriceCny: 300.0,
  monthlyGrossMargin: 0.3,
  sixHourTokenLimit: 120_000,
  sixHourTaskLimit: 4,
  weeklyTokenLimit: 570_000,
  weeklyTaskLimit: 14,
};

export interface UsageLogItem {
  id: string;
  timestampMs: number;
  tokens: number;
  apiCostCny: number;
  pages: number;
  jobId?: string;
}

export function normalizeEmail(email?: string | null): string {
  return (email || '').trim().toLowerCase();
}

export function isSuperAdminEmail(email?: string | null): boolean {
  return normalizeEmail(email) === SUPER_ADMIN_EMAIL;
}

function roundCny(val: number): number {
  return Math.round(val * 100) / 100;
}

/**
 * Estimates multimodal attachment input tokens without restricting file size.
 */
export function estimateAttachmentInputTokens(
  attachments: Pick<AttachmentSummary, 'kind' | 'size'>[]
): number {
  let total = 0;
  for (const att of attachments) {
    if (att.kind === 'image') {
      // Gemini standard vision tiling (~760 tokens per image)
      total += 760;
    } else if (att.kind === 'pdf') {
      // ~260 tokens per PDF page; estimate ~75KB per page, bounded reasonably for massive scans
      const approxPages = Math.max(1, Math.min(800, Math.ceil(att.size / (75 * 1024))));
      total += approxPages * 260;
    } else if (att.kind === 'audio') {
      // ~32 tokens/sec, ~16KB/sec compressed webm/mp3
      const approxSeconds = Math.max(5, Math.min(7200, Math.ceil(att.size / (16 * 1024))));
      total += approxSeconds * 32;
    } else {
      // DOCX / Markdown / LaTeX / Text (~1 token per 3.5 bytes UTF-8)
      total += Math.min(250_000, Math.ceil(att.size / 3.5));
    }
  }
  return total;
}

/**
 * Per-page Carbon token profile by depth preset:
 * - Standard (MEDIUM thinking): ~8 pages default, 1,600 in + 2,200 out+thinking tokens/page
 * - Comprehensive (HIGH thinking): ~14 pages default, 1,800 in + 2,950 out+thinking tokens/page
 * - Exhaustive (HIGH thinking + multi-pass): ~22 pages default, 2,200 in + 3,500 out+thinking tokens/page
 */
export function getDepthPerPageTokenSpec(depth: DepthPreset, mode: DocMode): {
  defaultPages: number;
  inputTokensPerPage: number;
  outputAndThinkingTokensPerPage: number;
} {
  const workbookMultiplier = mode === 'workbook' ? 1.08 : 1.0;
  if (depth === 'standard') {
    return {
      defaultPages: 8,
      inputTokensPerPage: Math.round(1600 * workbookMultiplier),
      outputAndThinkingTokensPerPage: Math.round(2200 * workbookMultiplier),
    };
  }
  if (depth === 'exhaustive') {
    return {
      defaultPages: 22,
      inputTokensPerPage: Math.round(2200 * workbookMultiplier),
      outputAndThinkingTokensPerPage: Math.round(3500 * workbookMultiplier),
    };
  }
  return {
    defaultPages: 14,
    inputTokensPerPage: Math.round(1800 * workbookMultiplier),
    outputAndThinkingTokensPerPage: Math.round(2950 * workbookMultiplier),
  };
}

/**
 * Calculates token estimation, upstream API cost, and Pay-Per-PDF price at exact target gross margin (default 50%).
 */
export function estimateTaskTokenAndPrice(params: {
  mode: DocMode;
  depth: DepthPreset;
  promptLength?: number;
  attachments?: Pick<AttachmentSummary, 'kind' | 'size'>[];
  customPageCount?: number;
  pricing?: PricingConfig;
}): CostEstimateBreakdown {
  const pricing = params.pricing || DEFAULT_PRICING_CONFIG;
  const spec = getDepthPerPageTokenSpec(params.depth, params.mode);
  const pages = Math.max(
    1,
    Math.round(params.customPageCount ?? spec.defaultPages)
  );

  // Planner stage base tokens (~3,500 input + 4,500 output/thinking)
  const plannerInputTokens = 3500 + Math.ceil((params.promptLength || 200) / 2);
  const plannerOutputTokens = 4500;

  const attachmentTokens = estimateAttachmentInputTokens(params.attachments || []);
  // Attachments are passed to planner + batches (avg ~2.5 passes)
  const effectiveAttachmentTokens = Math.round(attachmentTokens * 2.2);

  const estimatedInputTokens =
    plannerInputTokens + effectiveAttachmentTokens + pages * spec.inputTokensPerPage;
  const estimatedOutputAndThinkingTokens =
    plannerOutputTokens + pages * spec.outputAndThinkingTokensPerPage;
  const estimatedTotalTokens =
    estimatedInputTokens + estimatedOutputAndThinkingTokens;

  const plannerApiCostCny =
    (plannerInputTokens / 1_000_000) * pricing.inputTokenPricePerMillionCny +
    (plannerOutputTokens / 1_000_000) * pricing.outputTokenPricePerMillionCny;

  const rawUpstreamCostCny =
    (estimatedInputTokens / 1_000_000) * pricing.inputTokenPricePerMillionCny +
    (estimatedOutputAndThinkingTokens / 1_000_000) *
      pricing.outputTokenPricePerMillionCny;

  const margin = Math.min(0.9, Math.max(0.05, pricing.payPerPdfGrossMargin));
  // Gross Margin = (Price - Cost) / Price = margin  =>  Price = Cost / (1 - margin)
  const rawPriceCny = rawUpstreamCostCny / (1 - margin);
  const basePlanningFeeCny = roundCny(plannerApiCostCny / (1 - margin));

  const upstreamApiCostCny = roundCny(rawUpstreamCostCny);
  const payPerPdfPriceCny = roundCny(upstreamApiCostCny / (1 - margin));
  const perPageMarginalCost =
    (spec.inputTokensPerPage / 1_000_000) * pricing.inputTokenPricePerMillionCny +
    (spec.outputAndThinkingTokensPerPage / 1_000_000) *
      pricing.outputTokenPricePerMillionCny;
  const perPagePriceCny = roundCny(perPageMarginalCost / (1 - margin));
  const grossProfitCny = roundCny(payPerPdfPriceCny - upstreamApiCostCny);
  const grossMarginRate =
    payPerPdfPriceCny > 0
      ? Math.round(((payPerPdfPriceCny - upstreamApiCostCny) / payPerPdfPriceCny) * 1000) /
        1000
      : margin;

  void rawPriceCny;

  return {
    estimatedPages: pages,
    estimatedInputTokens,
    estimatedOutputAndThinkingTokens,
    estimatedTotalTokens,
    attachmentTokens: effectiveAttachmentTokens,
    upstreamApiCostCny,
    payPerPdfPriceCny,
    perPagePriceCny,
    basePlanningFeeCny,
    grossProfitCny,
    grossMarginRate,
  };
}

/**
 * Computes Monthly Subscription Economics Summary (¥300/month at 30% Gross Margin).
 */
export function computeMonthlyPlanEconomics(pricing: PricingConfig = DEFAULT_PRICING_CONFIG): {
  monthlyPriceCny: number;
  targetGrossMargin: number;
  targetGrossProfitCny: number;
  maxMonthlyApiCostBudgetCny: number;
  maxWeeklyApiCostBudgetCny: number;
  maxSixHourApiCostBudgetCny: number;
  sixHourApproxPages: number;
  weeklyApproxPages: number;
  monthlyApproxPages: number;
} {
  const monthlyPriceCny = pricing.monthlyPriceCny;
  const targetGrossMargin = pricing.monthlyGrossMargin;
  const maxMonthlyApiCostBudgetCny = roundCny(monthlyPriceCny * (1 - targetGrossMargin));
  const targetGrossProfitCny = roundCny(monthlyPriceCny - maxMonthlyApiCostBudgetCny);
  const maxWeeklyApiCostBudgetCny = roundCny(maxMonthlyApiCostBudgetCny / (30 / 7));
  const maxSixHourApiCostBudgetCny = roundCny(maxWeeklyApiCostBudgetCny / 4.65);

  // Average comprehensive page ~ 4,750 total tokens
  const avgTokensPerPage = 4000;
  const sixHourApproxPages = Math.floor(pricing.sixHourTokenLimit / avgTokensPerPage);
  const weeklyApproxPages = Math.floor(pricing.weeklyTokenLimit / avgTokensPerPage);
  const monthlyApproxPages = Math.floor((weeklyApproxPages * 30) / 7);

  return {
    monthlyPriceCny,
    targetGrossMargin,
    targetGrossProfitCny,
    maxMonthlyApiCostBudgetCny,
    maxWeeklyApiCostBudgetCny,
    maxSixHourApiCostBudgetCny,
    sixHourApproxPages,
    weeklyApproxPages,
    monthlyApproxPages,
  };
}

/**
 * Evaluates Gemini-Web-style rolling 6-hour and 7-day weekly usage windows.
 */
export function evaluateQuotaWindow(
  events: UsageLogItem[],
  nowMs = Date.now(),
  pricing: PricingConfig = DEFAULT_PRICING_CONFIG
): UsageWindowSnapshot {
  const sixHourCutoff = nowMs - SIX_HOURS_MS;
  const weeklyCutoff = nowMs - SEVEN_DAYS_MS;

  const sixHourEvents = events
    .filter((e) => e.timestampMs > sixHourCutoff)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const weeklyEvents = events
    .filter((e) => e.timestampMs > weeklyCutoff)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const sixHourTokensUsed = sixHourEvents.reduce((sum, e) => sum + e.tokens, 0);
  const sixHourTasksUsed = sixHourEvents.length;

  const weeklyTokensUsed = weeklyEvents.reduce((sum, e) => sum + e.tokens, 0);
  const weeklyTasksUsed = weeklyEvents.length;

  const sixHourResetAt =
    sixHourEvents.length > 0
      ? new Date(sixHourEvents[0].timestampMs + SIX_HOURS_MS).toISOString()
      : new Date(nowMs + SIX_HOURS_MS).toISOString();

  const weeklyResetAt =
    weeklyEvents.length > 0
      ? new Date(weeklyEvents[0].timestampMs + SEVEN_DAYS_MS).toISOString()
      : new Date(nowMs + SEVEN_DAYS_MS).toISOString();

  return {
    sixHourTokensUsed,
    sixHourTokensLimit: pricing.sixHourTokenLimit,
    sixHourTasksUsed,
    sixHourTasksLimit: pricing.sixHourTaskLimit,
    sixHourResetAt,
    weeklyTokensUsed,
    weeklyTokensLimit: pricing.weeklyTokenLimit,
    weeklyTasksUsed,
    weeklyTasksLimit: pricing.weeklyTaskLimit,
    weeklyResetAt,
  };
}

/**
 * Determines whether a user can start a new PDF generation task under Super Admin,
 * Monthly Pro Quota (enforcing 6h & weekly windows), or Pay-Per-PDF wallet settlement (50% margin).
 */
export function checkJobBillingAuthorization(params: {
  profile: Pick<
    UserAccountProfile,
    'email' | 'role' | 'isSuperAdmin' | 'subscriptionActive' | 'walletBalanceCny' | 'usage'
  >;
  estimate: CostEstimateBreakdown;
  preferredMethod?: 'auto' | 'monthly_quota' | 'pay_per_pdf';
}): {
  allowed: boolean;
  billingMode: 'super_admin_free' | 'monthly_pro_quota' | 'pay_per_pdf';
  chargeAmountCny: number;
  reason?: string;
} {
  const { profile, estimate, preferredMethod = 'auto' } = params;

  if (profile.isSuperAdmin || isSuperAdminEmail(profile.email) || profile.role === 'super_admin') {
    return {
      allowed: true,
      billingMode: 'super_admin_free',
      chargeAmountCny: 0,
    };
  }

  const u = profile.usage;
  const withinSixHour =
    u.sixHourTokensUsed + estimate.estimatedTotalTokens <= u.sixHourTokensLimit &&
    u.sixHourTasksUsed < u.sixHourTasksLimit;
  const withinWeekly =
    u.weeklyTokensUsed + estimate.estimatedTotalTokens <= u.weeklyTokensLimit &&
    u.weeklyTasksUsed < u.weeklyTasksLimit;

  if (profile.subscriptionActive && preferredMethod !== 'pay_per_pdf') {
    if (withinSixHour && withinWeekly) {
      return {
        allowed: true,
        billingMode: 'monthly_pro_quota',
        chargeAmountCny: 0,
      };
    }

    // If Monthly Pro user hit 6h or weekly window limit, allow Pay-per-PDF overflow if they explicitly chose or have wallet balance
    if (preferredMethod === 'auto' && profile.walletBalanceCny >= estimate.payPerPdfPriceCny) {
      return {
        allowed: true,
        billingMode: 'pay_per_pdf',
        chargeAmountCny: estimate.payPerPdfPriceCny,
      };
    }

    const resetHint = !withinSixHour
      ? `已达每 6 小时动态窗口限额（下次额度恢复时间：${new Date(u.sixHourResetAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）`
      : `已达本周包月额度上限（下次恢复时间：${new Date(u.weeklyResetAt).toLocaleDateString('zh-CN')}）`;

    return {
      allowed: false,
      billingMode: 'monthly_pro_quota',
      chargeAmountCny: 0,
      reason: `${resetHint}。您可等待窗口刷新，或充值钱包按单份 PDF（¥${estimate.payPerPdfPriceCny.toFixed(2)}）加急生成。`,
    };
  }

  // Pay-per-PDF mode (50% gross margin)
  if (profile.walletBalanceCny >= estimate.payPerPdfPriceCny) {
    return {
      allowed: true,
      billingMode: 'pay_per_pdf',
      chargeAmountCny: estimate.payPerPdfPriceCny,
    };
  }

  return {
    allowed: false,
    billingMode: 'pay_per_pdf',
    chargeAmountCny: estimate.payPerPdfPriceCny,
    reason: `当前账户余额（¥${profile.walletBalanceCny.toFixed(2)}）不足支付本次预计生成费用（¥${estimate.payPerPdfPriceCny.toFixed(2)}，预估 ${estimate.estimatedPages} 页 A4 / ${(estimate.estimatedTotalTokens / 1000).toFixed(1)}k Tokens）。请前往「计费与云端托管」单次充值或开通 ¥300/月 包月会员。`,
  };
}
