import fs from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import type {
  AdminSystemOverview,
  BillingTransaction,
  CostEstimateBreakdown,
  PricingConfig,
  UserAccountProfile,
  UserCloudConfig,
  UserRole,
} from '../types.ts';
import {
  checkJobBillingAuthorization,
  DEFAULT_PRICING_CONFIG,
  evaluateQuotaWindow,
  isSuperAdminEmail,
  normalizeEmail,
  SUPER_ADMIN_EMAIL,
} from '../utils/billingAndQuota.ts';
import type { UsageLogItem } from '../utils/billingAndQuota.ts';

const DATA_DIR = path.resolve(process.cwd(), '.carbon-jobs');
const USERS_FILE = path.join(DATA_DIR, 'users_billing.json');

interface StoredUserRecord {
  email: string;
  uid: string;
  displayName: string;
  photoURL?: string;
  role: UserRole;
  walletBalanceCny: number;
  subscriptionExpiresAt?: string;
  cloudConfig: UserCloudConfig;
  usageEvents: UsageLogItem[];
  totalSpentCny: number;
  totalApiCostCny: number;
  totalGeneratedPages: number;
  totalTokensConsumed: number;
  transactions: BillingTransaction[];
  createdAt: string;
  updatedAt: string;
}

interface PersistedAccountStore {
  pricing: PricingConfig;
  users: StoredUserRecord[];
}

export interface VerifiedRequestIdentity {
  email: string;
  uid: string;
  displayName: string;
  photoURL?: string;
  driveAccessToken?: string;
}

const usersMap = new Map<string, StoredUserRecord>();
let activePricingConfig: PricingConfig = { ...DEFAULT_PRICING_CONFIG };

// Short-lived in-memory cache of verified Google tokens -> identity (never written to disk)
const verifiedTokenCache = new Map<
  string,
  { identity: Omit<VerifiedRequestIdentity, 'driveAccessToken'>; expiresAtMs: number }
>();

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultCloudConfig(): UserCloudConfig {
  return {
    mode: 'google_drive',
    driveRootFolder: 'Carbon 学术归档',
    gcpProjectId: '',
    gcsBucketName: '',
    downloadOnDemandOnly: true,
  };
}

function persistAccountStore(): void {
  try {
    ensureDataDir();
    const payload: PersistedAccountStore = {
      pricing: activePricingConfig,
      users: Array.from(usersMap.values()),
    };
    const tmp = `${USERS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmp, USERS_FILE);
  } catch (err) {
    console.error('Failed to persist account store:', err);
  }
}

export function loadAccountStoreFromDisk(): void {
  try {
    ensureDataDir();
    if (fs.existsSync(USERS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')) as Partial<PersistedAccountStore>;
      if (parsed.pricing) {
        activePricingConfig = { ...DEFAULT_PRICING_CONFIG, ...parsed.pricing };
      }
      if (Array.isArray(parsed.users)) {
        for (const u of parsed.users) {
          const email = normalizeEmail(u.email);
          if (!email) continue;
          const forceSuper = isSuperAdminEmail(email);
          usersMap.set(email, {
            ...u,
            email,
            role: forceSuper ? 'super_admin' : u.role,
            cloudConfig: { ...defaultCloudConfig(), ...(u.cloudConfig || {}) },
            usageEvents: Array.isArray(u.usageEvents) ? u.usageEvents : [],
            transactions: Array.isArray(u.transactions) ? u.transactions : [],
          });
        }
      }
    }

    // Always ensure the Super Admin account record exists
    if (!usersMap.has(SUPER_ADMIN_EMAIL)) {
      const now = new Date().toISOString();
      usersMap.set(SUPER_ADMIN_EMAIL, {
        email: SUPER_ADMIN_EMAIL,
        uid: 'super-admin-owner',
        displayName: 'Howard Li (Super Admin)',
        role: 'super_admin',
        walletBalanceCny: 0,
        cloudConfig: defaultCloudConfig(),
        usageEvents: [],
        totalSpentCny: 0,
        totalApiCostCny: 0,
        totalGeneratedPages: 0,
        totalTokensConsumed: 0,
        transactions: [],
        createdAt: now,
        updatedAt: now,
      });
      persistAccountStore();
    }
  } catch (err) {
    console.error('Failed to load account store:', err);
  }
}

export function getPricingConfig(): PricingConfig {
  return { ...activePricingConfig };
}

export function updatePricingConfigByAdmin(patch: Partial<PricingConfig>): PricingConfig {
  activePricingConfig = {
    ...activePricingConfig,
    ...patch,
  };
  persistAccountStore();
  return getPricingConfig();
}

function getOrCreateUserRecord(identity: {
  email: string;
  uid: string;
  displayName?: string;
  photoURL?: string;
}): StoredUserRecord {
  const email = normalizeEmail(identity.email);
  const isSuper = isSuperAdminEmail(email);
  const existing = usersMap.get(email);
  const nowIso = new Date().toISOString();

  if (existing) {
    let mutated = false;
    if (isSuper && existing.role !== 'super_admin') {
      existing.role = 'super_admin';
      mutated = true;
    }
    if (identity.uid && existing.uid === 'super-admin-owner') {
      existing.uid = identity.uid;
      mutated = true;
    }
    if (identity.displayName && identity.displayName !== existing.displayName) {
      existing.displayName = identity.displayName;
      mutated = true;
    }
    if (identity.photoURL && identity.photoURL !== existing.photoURL) {
      existing.photoURL = identity.photoURL;
      mutated = true;
    }
    if (mutated) {
      existing.updatedAt = nowIso;
      persistAccountStore();
    }
    return existing;
  }

  const created: StoredUserRecord = {
    email,
    uid: identity.uid || `uid-${Date.now()}`,
    displayName: identity.displayName || email.split('@')[0],
    photoURL: identity.photoURL,
    role: isSuper ? 'super_admin' : 'pay_per_use',
    walletBalanceCny: 0,
    cloudConfig: defaultCloudConfig(),
    usageEvents: [],
    totalSpentCny: 0,
    totalApiCostCny: 0,
    totalGeneratedPages: 0,
    totalTokensConsumed: 0,
    transactions: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  usersMap.set(email, created);
  persistAccountStore();
  return created;
}

function isSubscriptionCurrentlyActive(record: StoredUserRecord, nowMs = Date.now()): boolean {
  if (!record.subscriptionExpiresAt) return false;
  return Date.parse(record.subscriptionExpiresAt) > nowMs;
}

export function toPublicUserProfile(record: StoredUserRecord, nowMs = Date.now()): UserAccountProfile {
  const isSuper = isSuperAdminEmail(record.email) || record.role === 'super_admin';
  const subActive = isSubscriptionCurrentlyActive(record, nowMs);
  const effectiveRole: UserRole = isSuper
    ? 'super_admin'
    : subActive
      ? 'pro_monthly'
      : 'pay_per_use';

  const usage = evaluateQuotaWindow(record.usageEvents, nowMs, activePricingConfig);

  return {
    email: record.email,
    uid: record.uid,
    displayName: record.displayName,
    photoURL: record.photoURL,
    role: effectiveRole,
    isSuperAdmin: isSuper,
    walletBalanceCny: Math.round(record.walletBalanceCny * 100) / 100,
    subscriptionActive: subActive,
    subscriptionExpiresAt: record.subscriptionExpiresAt,
    cloudConfig: record.cloudConfig,
    usage,
    totalSpentCny: Math.round(record.totalSpentCny * 100) / 100,
    totalApiCostCny: Math.round(record.totalApiCostCny * 100) / 100,
    totalGeneratedPages: record.totalGeneratedPages,
    totalTokensConsumed: record.totalTokensConsumed,
    recentTransactions: record.transactions.slice(0, 20),
  };
}

export function getUserProfileByEmail(email: string): UserAccountProfile | null {
  const rec = usersMap.get(normalizeEmail(email));
  return rec ? toPublicUserProfile(rec) : null;
}

export function getUserCloudConfig(email?: string | null): UserCloudConfig {
  if (!email) return defaultCloudConfig();
  const rec = usersMap.get(normalizeEmail(email));
  return rec ? rec.cloudConfig : defaultCloudConfig();
}

export function updateUserCloudConfig(
  email: string,
  patch: Partial<UserCloudConfig>
): UserAccountProfile {
  const rec = getOrCreateUserRecord({ email, uid: '' });
  rec.cloudConfig = {
    ...rec.cloudConfig,
    ...patch,
    driveRootFolder: (patch.driveRootFolder ?? rec.cloudConfig.driveRootFolder).trim() || 'Carbon 学术归档',
    gcpProjectId: (patch.gcpProjectId ?? rec.cloudConfig.gcpProjectId).trim(),
    gcsBucketName: (patch.gcsBucketName ?? rec.cloudConfig.gcsBucketName)
      .trim()
      .replace(/^gs:\/\//i, '')
      .replace(/\/+$/, ''),
  };
  rec.updatedAt = new Date().toISOString();
  persistAccountStore();
  return toPublicUserProfile(rec);
}

export function topUpUserWallet(
  email: string,
  amountCny: number,
  note = '账户钱包充值（用于按页生成 PDF）'
): UserAccountProfile {
  const cleanAmount = Math.round(Math.max(0.01, amountCny) * 100) / 100;
  const rec = getOrCreateUserRecord({ email, uid: '' });
  rec.walletBalanceCny = Math.round((rec.walletBalanceCny + cleanAmount) * 100) / 100;
  rec.transactions.unshift({
    id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    type: 'topup',
    amountCny: cleanAmount,
    description: note,
  });
  rec.updatedAt = new Date().toISOString();
  persistAccountStore();
  return toPublicUserProfile(rec);
}

export function activateMonthlySubscription(
  email: string,
  useWalletIfEnough = false
): UserAccountProfile {
  const rec = getOrCreateUserRecord({ email, uid: '' });
  const price = activePricingConfig.monthlyPriceCny;

  if (useWalletIfEnough && rec.walletBalanceCny >= price) {
    rec.walletBalanceCny = Math.round((rec.walletBalanceCny - price) * 100) / 100;
  }

  const nowMs = Date.now();
  const baseMs =
    rec.subscriptionExpiresAt && Date.parse(rec.subscriptionExpiresAt) > nowMs
      ? Date.parse(rec.subscriptionExpiresAt)
      : nowMs;
  const nextExpiry = new Date(baseMs + 30 * 24 * 3600 * 1000).toISOString();

  rec.subscriptionExpiresAt = nextExpiry;
  if (!isSuperAdminEmail(rec.email)) {
    rec.role = 'pro_monthly';
  }
  rec.totalSpentCny = Math.round((rec.totalSpentCny + price) * 100) / 100;
  rec.transactions.unshift({
    id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    type: 'monthly_subscription',
    amountCny: price,
    description: `开通/续费 Carbon 包月专业版会员（¥${price}/月 · 有效期至 ${new Date(nextExpiry).toLocaleDateString('zh-CN')}）`,
  });
  rec.updatedAt = new Date().toISOString();
  persistAccountStore();
  return toPublicUserProfile(rec);
}

export function adminGrantUserPrivilege(params: {
  targetEmail: string;
  addBalanceCny?: number;
  grantMonthlyDays?: number;
}): UserAccountProfile {
  const rec = getOrCreateUserRecord({ email: params.targetEmail, uid: '' });
  if (params.addBalanceCny && params.addBalanceCny !== 0) {
    rec.walletBalanceCny = Math.max(
      0,
      Math.round((rec.walletBalanceCny + params.addBalanceCny) * 100) / 100
    );
    rec.transactions.unshift({
      id: `tx-${Date.now()}-adm`,
      createdAt: new Date().toISOString(),
      type: 'admin_grant',
      amountCny: params.addBalanceCny,
      description: `超级管理员调整钱包额度 ¥${params.addBalanceCny.toFixed(2)}`,
    });
  }
  if (params.grantMonthlyDays && params.grantMonthlyDays > 0) {
    const nowMs = Date.now();
    const baseMs =
      rec.subscriptionExpiresAt && Date.parse(rec.subscriptionExpiresAt) > nowMs
        ? Date.parse(rec.subscriptionExpiresAt)
        : nowMs;
    rec.subscriptionExpiresAt = new Date(
      baseMs + params.grantMonthlyDays * 24 * 3600 * 1000
    ).toISOString();
    if (!isSuperAdminEmail(rec.email)) {
      rec.role = 'pro_monthly';
    }
    rec.transactions.unshift({
      id: `tx-${Date.now()}-sub`,
      createdAt: new Date().toISOString(),
      type: 'admin_grant',
      amountCny: 0,
      description: `超级管理员授予包月会员权益 ${params.grantMonthlyDays} 天`,
    });
  }
  rec.updatedAt = new Date().toISOString();
  persistAccountStore();
  return toPublicUserProfile(rec);
}

/**
 * Authorizes and settles initial job launch against Super Admin / Monthly Quota / Pay-Per-PDF Wallet.
 */
export function authorizeAndSettleJobLaunch(params: {
  email: string;
  jobId: string;
  jobTitleHint: string;
  estimate: CostEstimateBreakdown;
  preferredMethod?: 'auto' | 'monthly_quota' | 'pay_per_pdf';
}): {
  allowed: boolean;
  billingMode: 'super_admin_free' | 'monthly_pro_quota' | 'pay_per_pdf';
  chargedCny: number;
  reason?: string;
  profile: UserAccountProfile;
} {
  const rec = getOrCreateUserRecord({ email: params.email, uid: '' });
  const profileBefore = toPublicUserProfile(rec);
  const decision = checkJobBillingAuthorization({
    profile: profileBefore,
    estimate: params.estimate,
    preferredMethod: params.preferredMethod,
  });

  if (!decision.allowed) {
    return {
      allowed: false,
      billingMode: decision.billingMode,
      chargedCny: decision.chargeAmountCny,
      reason: decision.reason,
      profile: profileBefore,
    };
  }

  if (decision.billingMode === 'pay_per_pdf' && decision.chargeAmountCny > 0) {
    rec.walletBalanceCny = Math.max(
      0,
      Math.round((rec.walletBalanceCny - decision.chargeAmountCny) * 100) / 100
    );
    rec.totalSpentCny = Math.round((rec.totalSpentCny + decision.chargeAmountCny) * 100) / 100;
    rec.transactions.unshift({
      id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
      type: 'pay_per_pdf_charge',
      amountCny: -decision.chargeAmountCny,
      jobId: params.jobId,
      description: `按页预估生成 PDF 扣费（50% 毛利标准 · 预估 ${params.estimate.estimatedPages} 页）：${params.jobTitleHint.slice(0, 32)}`,
    });
  }

  // Record initial usage slot in rolling 6-hour & weekly window
  rec.usageEvents.push({
    id: `use-${params.jobId}`,
    jobId: params.jobId,
    timestampMs: Date.now(),
    tokens: params.estimate.estimatedTotalTokens,
    apiCostCny: params.estimate.upstreamApiCostCny,
    pages: params.estimate.estimatedPages,
  });
  // Prune events older than 14 days to keep store compact
  const twoWeeksAgo = Date.now() - 14 * 24 * 3600 * 1000;
  rec.usageEvents = rec.usageEvents.filter((e) => e.timestampMs > twoWeeksAgo);

  rec.totalApiCostCny =
    Math.round((rec.totalApiCostCny + params.estimate.upstreamApiCostCny) * 100) / 100;
  rec.totalGeneratedPages += params.estimate.estimatedPages;
  rec.totalTokensConsumed += params.estimate.estimatedTotalTokens;
  rec.updatedAt = new Date().toISOString();
  persistAccountStore();

  return {
    allowed: true,
    billingMode: decision.billingMode,
    chargedCny: decision.chargeAmountCny,
    profile: toPublicUserProfile(rec),
  };
}

/**
 * Reconciles actual measured token consumption once a job completes.
 */
export function reconcileActualJobTokens(params: {
  email?: string;
  jobId: string;
  actualInputTokens: number;
  actualOutputTokens: number;
  actualPages: number;
}): void {
  if (!params.email) return;
  const rec = usersMap.get(normalizeEmail(params.email));
  if (!rec) return;

  const actualTotal = params.actualInputTokens + params.actualOutputTokens;
  if (actualTotal <= 0) return;

  const actualCost =
    (params.actualInputTokens / 1_000_000) * activePricingConfig.inputTokenPricePerMillionCny +
    (params.actualOutputTokens / 1_000_000) * activePricingConfig.outputTokenPricePerMillionCny;

  const existingEvt = rec.usageEvents.find((e) => e.jobId === params.jobId);
  if (existingEvt) {
    const tokenDelta = actualTotal - existingEvt.tokens;
    const costDelta = actualCost - existingEvt.apiCostCny;
    const pageDelta = params.actualPages - existingEvt.pages;

    existingEvt.tokens = actualTotal;
    existingEvt.apiCostCny = Math.round(actualCost * 100) / 100;
    existingEvt.pages = params.actualPages;

    rec.totalTokensConsumed = Math.max(0, rec.totalTokensConsumed + tokenDelta);
    rec.totalApiCostCny = Math.max(0, Math.round((rec.totalApiCostCny + costDelta) * 100) / 100);
    rec.totalGeneratedPages = Math.max(0, rec.totalGeneratedPages + pageDelta);
    persistAccountStore();
  }
}

export function buildAdminOverview(stats: {
  activeRunningJobsCount: number;
  totalJobsCount: number;
}): AdminSystemOverview {
  const nowMs = Date.now();
  const allUsers = Array.from(usersMap.values());
  let totalRevenueCny = 0;
  let totalApiCostCny = 0;
  let activeSubscribers = 0;

  const summaries = allUsers.map((u) => {
    const subActive = isSubscriptionCurrentlyActive(u, nowMs);
    if (subActive) activeSubscribers += 1;
    totalRevenueCny += u.totalSpentCny;
    totalApiCostCny += u.totalApiCostCny;
    const usage = evaluateQuotaWindow(u.usageEvents, nowMs, activePricingConfig);
    const isSuper = isSuperAdminEmail(u.email) || u.role === 'super_admin';
    return {
      email: u.email,
      displayName: u.displayName,
      role: (isSuper ? 'super_admin' : subActive ? 'pro_monthly' : 'pay_per_use') as UserRole,
      walletBalanceCny: Math.round(u.walletBalanceCny * 100) / 100,
      subscriptionActive: subActive,
      subscriptionExpiresAt: u.subscriptionExpiresAt,
      sixHourTokensUsed: usage.sixHourTokensUsed,
      weeklyTokensUsed: usage.weeklyTokensUsed,
      totalSpentCny: Math.round(u.totalSpentCny * 100) / 100,
      totalApiCostCny: Math.round(u.totalApiCostCny * 100) / 100,
    };
  });

  const realizedGrossMargin =
    totalRevenueCny > 0
      ? Math.round(((totalRevenueCny - totalApiCostCny) / totalRevenueCny) * 1000) / 1000
      : 0;

  return {
    superAdminEmail: SUPER_ADMIN_EMAIL,
    pricing: getPricingConfig(),
    totalUsers: allUsers.length,
    activeSubscribers,
    totalRevenueCny: Math.round(totalRevenueCny * 100) / 100,
    totalApiCostCny: Math.round(totalApiCostCny * 100) / 100,
    realizedGrossMargin,
    activeRunningJobsCount: stats.activeRunningJobsCount,
    totalJobsCount: stats.totalJobsCount,
    users: summaries.sort((a, b) => (a.role === 'super_admin' ? -1 : b.totalSpentCny - a.totalSpentCny)),
  };
}

/**
 * Server-side verification of Google OAuth Access Token and/or Firebase ID Token.
 * Never trusts unverified client email claims.
 */
export async function verifyRequestGoogleUser(
  req: Request
): Promise<(VerifiedRequestIdentity & { profile: UserAccountProfile }) | null> {
  const authHeader = req.headers.authorization || '';
  const driveAccessToken = authHeader.replace(/^Bearer\s+/i, '').trim() || undefined;
  const firebaseIdToken = String(req.headers['x-firebase-id-token'] || '').trim() || undefined;

  const cacheKey = firebaseIdToken || driveAccessToken;
  if (!cacheKey) return null;

  const nowMs = Date.now();
  const cached = verifiedTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs) {
    const rec = getOrCreateUserRecord(cached.identity);
    return {
      ...cached.identity,
      driveAccessToken,
      profile: toPublicUserProfile(rec, nowMs),
    };
  }

  // 1. Verify Firebase Google ID Token via Google's tokeninfo endpoint
  if (firebaseIdToken) {
    try {
      const res = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(firebaseIdToken)}`
      );
      if (res.ok) {
        const info = (await res.json()) as {
          email?: string;
          sub?: string;
          name?: string;
          picture?: string;
          email_verified?: string | boolean;
        };
        if (info.email && (info.email_verified === 'true' || info.email_verified === true)) {
          const identity = {
            email: normalizeEmail(info.email),
            uid: info.sub || info.email,
            displayName: info.name || info.email.split('@')[0],
            photoURL: info.picture,
          };
          verifiedTokenCache.set(firebaseIdToken, {
            identity,
            expiresAtMs: nowMs + 15 * 60 * 1000,
          });
          const rec = getOrCreateUserRecord(identity);
          return {
            ...identity,
            driveAccessToken,
            profile: toPublicUserProfile(rec, nowMs),
          };
        }
      }
    } catch {
      // Fall through to OAuth access token check
    }
  }

  // 2. Verify Google OAuth 2.0 Access Token via tokeninfo / userinfo
  if (driveAccessToken) {
    try {
      const res = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(driveAccessToken)}`
      );
      if (res.ok) {
        const info = (await res.json()) as {
          email?: string;
          sub?: string;
        };
        if (info.email) {
          const identity = {
            email: normalizeEmail(info.email),
            uid: info.sub || info.email,
            displayName: info.email.split('@')[0],
          };
          verifiedTokenCache.set(driveAccessToken, {
            identity,
            expiresAtMs: nowMs + 15 * 60 * 1000,
          });
          const rec = getOrCreateUserRecord(identity);
          return {
            ...identity,
            driveAccessToken,
            profile: toPublicUserProfile(rec, nowMs),
          };
        }
      }
    } catch {
      // Ignore network error
    }
  }

  return null;
}
