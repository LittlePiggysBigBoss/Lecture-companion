import React, { useEffect, useMemo, useState } from 'react';
import {
  Calculator,
  CheckCircle2,
  CloudCog,
  CreditCard,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sliders,
  Users,
  Wallet,
} from 'lucide-react';
import type {
  AdminSystemOverview,
  DepthPreset,
  DocMode,
  PricingConfig,
  UserAccountProfile,
  UserCloudConfig,
} from '../types';
import {
  computeMonthlyPlanEconomics,
  DEFAULT_PRICING_CONFIG,
  estimateTaskTokenAndPrice,
  SUPER_ADMIN_EMAIL,
} from '../utils/billingAndQuota';

interface BillingAndCloudPanelProps {
  profile: UserAccountProfile | null;
  pricing: PricingConfig;
  isSigningIn: boolean;
  onRequestSignIn: () => Promise<string | null>;
  onTopUpWallet: (amountCny: number) => Promise<void>;
  onSubscribeMonthly: () => Promise<void>;
  onSaveCloudConfig: (patch: Partial<UserCloudConfig>) => Promise<void>;
  onFetchAdminOverview: () => Promise<AdminSystemOverview | null>;
  onAdminUpdatePricing: (patch: Partial<PricingConfig>) => Promise<void>;
  onAdminGrantUser: (params: {
    targetEmail: string;
    addBalanceCny: number;
    grantMonthlyDays: number;
  }) => Promise<AdminSystemOverview | null>;
}

export const BillingAndCloudPanel: React.FC<BillingAndCloudPanelProps> = ({
  profile,
  pricing = DEFAULT_PRICING_CONFIG,
  isSigningIn,
  onRequestSignIn,
  onTopUpWallet,
  onSubscribeMonthly,
  onSaveCloudConfig,
  onFetchAdminOverview,
  onAdminUpdatePricing,
  onAdminGrantUser,
}) => {
  // Interactive Cost Estimator State
  const [calcPages, setCalcPages] = useState(14);
  const [calcDepth, setCalcDepth] = useState<DepthPreset>('comprehensive');
  const [calcMode, setCalcMode] = useState<DocMode>('lecture_notes');

  // Wallet & Subscription Action State
  const [customTopUp, setCustomTopUp] = useState('50');
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);

  // Personal Google Cloud Config State
  const [cloudMode, setCloudMode] = useState<UserCloudConfig['mode']>(
    profile?.cloudConfig.mode || 'google_drive'
  );
  const [driveRootFolder, setDriveRootFolder] = useState(
    profile?.cloudConfig.driveRootFolder || 'Carbon 学术归档'
  );
  const [gcpProjectId, setGcpProjectId] = useState(profile?.cloudConfig.gcpProjectId || '');
  const [gcsBucketName, setGcsBucketName] = useState(profile?.cloudConfig.gcsBucketName || '');
  const [downloadOnDemandOnly, setDownloadOnDemandOnly] = useState(
    profile?.cloudConfig.downloadOnDemandOnly ?? true
  );
  const [isSavingCloud, setIsSavingCloud] = useState(false);

  // Super Admin Console State
  const [adminOverview, setAdminOverview] = useState<AdminSystemOverview | null>(null);
  const [isLoadingAdmin, setIsLoadingAdmin] = useState(false);
  const [grantEmail, setGrantEmail] = useState('');
  const [grantBalance, setGrantBalance] = useState('50');
  const [grantDays, setGrantDays] = useState('30');
  const [editSixHourTokens, setEditSixHourTokens] = useState(String(pricing.sixHourTokenLimit));
  const [editWeeklyTokens, setEditWeeklyTokens] = useState(String(pricing.weeklyTokenLimit));
  const [editMonthlyPrice, setEditMonthlyPrice] = useState(String(pricing.monthlyPriceCny));

  useEffect(() => {
    if (profile?.cloudConfig) {
      setCloudMode(profile.cloudConfig.mode);
      setDriveRootFolder(profile.cloudConfig.driveRootFolder);
      setGcpProjectId(profile.cloudConfig.gcpProjectId);
      setGcsBucketName(profile.cloudConfig.gcsBucketName);
      setDownloadOnDemandOnly(profile.cloudConfig.downloadOnDemandOnly);
    }
  }, [profile?.cloudConfig]);

  useEffect(() => {
    setEditSixHourTokens(String(pricing.sixHourTokenLimit));
    setEditWeeklyTokens(String(pricing.weeklyTokenLimit));
    setEditMonthlyPrice(String(pricing.monthlyPriceCny));
  }, [pricing]);

  useEffect(() => {
    if (profile?.isSuperAdmin) {
      setIsLoadingAdmin(true);
      void onFetchAdminOverview()
        .then((ov) => {
          if (ov) setAdminOverview(ov);
        })
        .finally(() => setIsLoadingAdmin(false));
    }
  }, [profile?.isSuperAdmin, onFetchAdminOverview]);

  const calcEstimate = useMemo(
    () =>
      estimateTaskTokenAndPrice({
        mode: calcMode,
        depth: calcDepth,
        customPageCount: calcPages,
        pricing,
      }),
    [calcMode, calcDepth, calcPages, pricing]
  );

  const tierComparison = useMemo(
    () => [
      {
        label: '标准精编档 (Medium 推理)',
        est: estimateTaskTokenAndPrice({
          mode: 'lecture_notes',
          depth: 'standard',
          customPageCount: 10,
          pricing,
        }),
      },
      {
        label: '深度详尽档 (High 推理)',
        est: estimateTaskTokenAndPrice({
          mode: 'lecture_notes',
          depth: 'comprehensive',
          customPageCount: 14,
          pricing,
        }),
      },
      {
        label: '全书穷尽档 (极限续写)',
        est: estimateTaskTokenAndPrice({
          mode: 'workbook',
          depth: 'exhaustive',
          customPageCount: 22,
          pricing,
        }),
      },
    ],
    [pricing]
  );

  const monthlyEcon = useMemo(() => computeMonthlyPlanEconomics(pricing), [pricing]);

  const handleTopUpClick = async (amount: number) => {
    if (!profile) {
      const tok = await onRequestSignIn();
      if (!tok) return;
    }
    setIsProcessingPayment(true);
    try {
      await onTopUpWallet(amount);
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const handleSubscribeClick = async () => {
    if (!profile) {
      const tok = await onRequestSignIn();
      if (!tok) return;
    }
    setIsProcessingPayment(true);
    try {
      await onSubscribeMonthly();
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const handleCloudSaveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) {
      const tok = await onRequestSignIn();
      if (!tok) return;
    }
    setIsSavingCloud(true);
    try {
      await onSaveCloudConfig({
        mode: cloudMode,
        driveRootFolder,
        gcpProjectId,
        gcsBucketName,
        downloadOnDemandOnly,
      });
    } finally {
      setIsSavingCloud(false);
    }
  };

  const sixHourPercent = profile
    ? Math.min(
        100,
        Math.round((profile.usage.sixHourTokensUsed / Math.max(1, profile.usage.sixHourTokensLimit)) * 100)
      )
    : 0;
  const weeklyPercent = profile
    ? Math.min(
        100,
        Math.round((profile.usage.weeklyTokensUsed / Math.max(1, profile.usage.weeklyTokensLimit)) * 100)
      )
    : 0;

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-slate-900">
            云端托管配置、计费标准与配额中心
          </h1>
          <p className="text-sm text-slate-600">
            基于个人 Google Cloud 独立托管与多终端同步；支持按页预估 Token 付费（50% 毛利标准）与 ¥300/月 包月会员（30% 毛利标准 · 每 6 小时与每周动态限额）。
          </p>
        </div>

        {!profile && (
          <button
            type="button"
            disabled={isSigningIn}
            onClick={() => void onRequestSignIn()}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto"
          >
            {isSigningIn ? (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : (
              <ShieldCheck className="w-4 h-4" aria-hidden="true" />
            )}
            <span>登录 Google 绑定多端同步与个人云</span>
          </button>
        )}
      </div>

      {/* Section 1: Current Account Identity & Gemini-Style Rolling 6-Hour / Weekly Usage Bars */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-100">
          <div className="space-y-1">
            <div className="text-xs text-slate-500">当前登录账号与权限等级</div>
            {profile ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-lg font-bold text-slate-900">{profile.email}</span>
                <span className="text-xs font-semibold text-blue-700">
                  {profile.isSuperAdmin
                    ? '超级管理员（永久免计费 · 免除一切窗口配额限制）'
                    : profile.subscriptionActive
                      ? `包月专业版会员（有效期至 ${new Date(profile.subscriptionExpiresAt!).toLocaleDateString('zh-CN')}）`
                      : '按页计费标准用户'}
                </span>
              </div>
            ) : (
              <div className="text-sm font-medium text-slate-700">
                尚未登录账号（超级管理员预设邮箱：<span className="font-mono">{SUPER_ADMIN_EMAIL}</span>，登录后自动激活超管权限与跨设备任务同步）
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-6 shrink-0">
            <div>
              <div className="text-xs text-slate-500">按次钱包余额</div>
              <div className="text-xl font-bold text-slate-900 font-mono tabular-nums">
                ¥{(profile?.walletBalanceCny ?? 0).toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">累计已生成页数</div>
              <div className="text-xl font-bold text-slate-900 font-mono tabular-nums">
                {profile?.totalGeneratedPages ?? 0} 页
              </div>
            </div>
          </div>
        </div>

        {/* Gemini Web Style 6h & Weekly Quota Meters */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-800">
                每 6 小时动态窗口用量（仿 Gemini 网页版配额机制）
              </span>
              <span className="font-mono tabular-nums text-slate-600">
                {profile?.isSuperAdmin
                  ? '无限制 (Super Admin)'
                  : `${(profile?.usage.sixHourTokensUsed ?? 0).toLocaleString()} / ${pricing.sixHourTokenLimit.toLocaleString()} Tokens`}
              </span>
            </div>
            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-transform duration-200 origin-left"
                style={{
                  width: '100%',
                  transform: `scaleX(${profile?.isSuperAdmin ? 0.04 : Math.max(0.02, sixHourPercent / 100)})`,
                }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono tabular-nums">
              <span>
                任务次数：{profile?.usage.sixHourTasksUsed ?? 0} /{' '}
                {profile?.isSuperAdmin ? '∞' : pricing.sixHourTaskLimit} 次（约合{' '}
                {monthlyEcon.sixHourApproxPages} 页 A4）
              </span>
              {profile && !profile.isSuperAdmin && (
                <span>
                  窗口刷新：
                  {new Date(profile.usage.sixHourResetAt).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-800">
                每周 (7天滚动) 包月总配额进度
              </span>
              <span className="font-mono tabular-nums text-slate-600">
                {profile?.isSuperAdmin
                  ? '无限制 (Super Admin)'
                  : `${(profile?.usage.weeklyTokensUsed ?? 0).toLocaleString()} / ${pricing.weeklyTokenLimit.toLocaleString()} Tokens`}
              </span>
            </div>
            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-600 transition-transform duration-200 origin-left"
                style={{
                  width: '100%',
                  transform: `scaleX(${profile?.isSuperAdmin ? 0.04 : Math.max(0.02, weeklyPercent / 100)})`,
                }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono tabular-nums">
              <span>
                本周任务：{profile?.usage.weeklyTasksUsed ?? 0} /{' '}
                {profile?.isSuperAdmin ? '∞' : pricing.weeklyTaskLimit} 次（约合{' '}
                {monthlyEcon.weeklyApproxPages} 页 A4）
              </span>
              {profile && !profile.isSuperAdmin && (
                <span>
                  下周重置：{new Date(profile.usage.weeklyResetAt).toLocaleDateString('zh-CN')}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Section 2: Two Plans (50% Margin Pay-Per-PDF vs. ¥300/mo 30% Margin Pro) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Card A: Pay-per-PDF (50% Gross Margin) */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wallet className="w-4 h-4 text-blue-600" aria-hidden="true" />
                <h2 className="text-base font-bold text-slate-900">新用户按页单次付费生成</h2>
              </div>
              <span className="text-xs font-mono font-semibold text-slate-700 tabular-nums">
                定价毛利率 {(pricing.payPerPdfGrossMargin * 100).toFixed(0)}%
              </span>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              无需包月，按每页预估 Gemini 4 Carbon 上游 Token 消耗成本核算，严格按{' '}
              <span className="font-semibold text-slate-900">50% 毛利率</span>（即{' '}
              <span className="font-mono">收费价 = API 成本 ÷ (1 - 50%) = 2.0 × 成本</span>）透明计收：
            </p>

            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="py-2 px-3 font-semibold">生成深度档位</th>
                    <th className="py-2 px-3 font-semibold text-right">每页边际价</th>
                    <th className="py-2 px-3 font-semibold text-right">典型整本总价</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                  {tierComparison.map((row) => (
                    <tr key={row.label}>
                      <td className="py-2 px-3 font-sans text-slate-800">{row.label}</td>
                      <td className="py-2 px-3 text-right text-slate-900 font-semibold">
                        ¥{row.est.perPagePriceCny.toFixed(2)}/页
                      </td>
                      <td className="py-2 px-3 text-right text-blue-700 font-semibold">
                        ¥{row.est.payPerPdfPriceCny.toFixed(2)} ({row.est.estimatedPages}页)
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-500 font-mono tabular-nums">
              注：每次任务另含全书大纲扩写规划基础费 ¥{calcEstimate.basePlanningFeeCny.toFixed(2)}（约 8k 规划 Tokens）。
            </p>
          </div>

          <div className="space-y-3 pt-4 border-t border-slate-100">
            <div className="text-xs font-semibold text-slate-800">充值按次生成钱包</div>
            <div className="flex flex-wrap items-center gap-2">
              {[20, 50, 100].map((amt) => (
                <button
                  key={amt}
                  type="button"
                  disabled={isProcessingPayment}
                  onClick={() => void handleTopUpClick(amt)}
                  className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 disabled:opacity-50 font-mono tabular-nums whitespace-nowrap shrink-0"
                >
                  充值 ¥{amt}
                </button>
              ))}
              <div className="flex items-center gap-1.5 flex-1 min-w-[150px]">
                <label htmlFor="custom-topup-input" className="sr-only">
                  自定义充值金额
                </label>
                <input
                  id="custom-topup-input"
                  type="number"
                  min={1}
                  step={1}
                  value={customTopUp}
                  onChange={(e) => setCustomTopUp(e.target.value)}
                  className="w-24 px-2.5 py-2 text-xs font-mono tabular-nums text-slate-900 bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                />
                <button
                  type="button"
                  disabled={isProcessingPayment}
                  onClick={() => void handleTopUpClick(Math.max(1, Number(customTopUp) || 20))}
                  className="px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  立即充值
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Card B: Monthly Pro Plan (¥300/mo at 30% Gross Margin) */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-blue-600" aria-hidden="true" />
                <h2 className="text-base font-bold text-slate-900">
                  Carbon 教研专业版包月会员
                </h2>
              </div>
              <span className="text-lg font-bold text-blue-700 font-mono tabular-nums">
                ¥{pricing.monthlyPriceCny.toFixed(0)} / 月
              </span>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              按照 <span className="font-semibold text-slate-900">¥300/月 · 30% 目标毛利率</span> 精算核定：每月预留{' '}
              <span className="font-mono font-semibold text-slate-900">
                ¥{monthlyEcon.maxMonthlyApiCostBudgetCny.toFixed(2)}
              </span>{' '}
              纯模型推理成本池（毛利 ¥{monthlyEcon.targetGrossProfitCny.toFixed(2)}/月），折合每周成本上限{' '}
              <span className="font-mono">¥{monthlyEcon.maxWeeklyApiCostBudgetCny.toFixed(2)}/周</span>，仿照 Gemini 网页版执行双窗口动态控流：
            </p>

            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-2 text-xs text-slate-700">
              <div className="flex items-center justify-between">
                <span>每 6 小时动态窗口限额：</span>
                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                  {pricing.sixHourTokenLimit.toLocaleString()} Tokens / {pricing.sixHourTaskLimit} 次任务（约 {monthlyEcon.sixHourApproxPages} 页）
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>每周 (7天滚动) 总配额：</span>
                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                  {pricing.weeklyTokenLimit.toLocaleString()} Tokens / {pricing.weeklyTaskLimit} 次任务（约 {monthlyEcon.weeklyApproxPages} 页）
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>整月满额等效编纂总页数：</span>
                <span className="font-mono font-semibold text-emerald-700 tabular-nums">
                  约 {monthlyEcon.monthlyApproxPages} 页出版级 A4 讲义/题册
                </span>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <span className="text-xs text-slate-500">
              {profile?.subscriptionActive
                ? `当前已生效，到期日：${new Date(profile.subscriptionExpiresAt!).toLocaleDateString('zh-CN')}`
                : '开通后立享 30 天双窗口高频教研生成权益'}
            </span>
            <button
              type="button"
              disabled={isProcessingPayment}
              onClick={() => void handleSubscribeClick()}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
            >
              {isProcessingPayment ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
              )}
              <span>
                {profile?.subscriptionActive
                  ? `续费包月会员 (¥${pricing.monthlyPriceCny})`
                  : `开通 ¥${pricing.monthlyPriceCny}/月 包月会员`}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Section 3: Interactive Per-Page Token & Gross Margin Calculator */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Calculator className="w-4 h-4 text-blue-600" aria-hidden="true" />
            <h2 className="text-base font-bold text-slate-900">
              按页 Token 消耗与 50% 毛利收费透明测算器
            </h2>
          </div>
          <span className="text-xs text-slate-500 font-mono tabular-nums">
            基准成本：输入 ¥{pricing.inputTokenPricePerMillionCny}/1M · 输出与思考 ¥
            {pricing.outputTokenPricePerMillionCny}/1M
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="calc-pages-range" className="text-xs font-medium text-slate-700 flex justify-between">
              <span>预估 PDF 页数</span>
              <span className="font-mono font-semibold text-blue-700 tabular-nums">{calcPages} 页 A4</span>
            </label>
            <input
              id="calc-pages-range"
              type="range"
              min={2}
              max={60}
              value={calcPages}
              onChange={(e) => setCalcPages(Number(e.target.value))}
              className="w-full accent-blue-600 cursor-pointer"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="calc-mode-select" className="text-xs font-medium text-slate-700 block">
              文档形态
            </label>
            <select
              id="calc-mode-select"
              value={calcMode}
              onChange={(e) => setCalcMode(e.target.value as DocMode)}
              className="w-full px-3 py-2 text-xs text-slate-900 bg-slate-50 border border-slate-200 rounded-lg"
            >
              <option value="lecture_notes">深度课程讲义 PDF</option>
              <option value="workbook">分级练习题册 PDF（含全解）</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="calc-depth-select" className="text-xs font-medium text-slate-700 block">
              单次调用打包深度
            </label>
            <select
              id="calc-depth-select"
              value={calcDepth}
              onChange={(e) => setCalcDepth(e.target.value as DepthPreset)}
              className="w-full px-3 py-2 text-xs text-slate-900 bg-slate-50 border border-slate-200 rounded-lg"
            >
              <option value="standard">标准精编</option>
              <option value="comprehensive">深度详尽 (Carbon High)</option>
              <option value="exhaustive">全书穷尽 (多轮满载续写)</option>
            </select>
          </div>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
          <div className="p-4 space-y-1">
            <div className="text-xs text-slate-500">预估总消耗 Tokens</div>
            <div className="text-lg font-bold text-slate-900 font-mono tabular-nums">
              {calcEstimate.estimatedTotalTokens.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-500 font-mono tabular-nums">
              输入 {(calcEstimate.estimatedInputTokens / 1000).toFixed(1)}k + 输出{' '}
              {(calcEstimate.estimatedOutputAndThinkingTokens / 1000).toFixed(1)}k
            </div>
          </div>
          <div className="p-4 space-y-1">
            <div className="text-xs text-slate-500">上游模型 API 裸成本</div>
            <div className="text-lg font-bold text-slate-900 font-mono tabular-nums">
              ¥{calcEstimate.upstreamApiCostCny.toFixed(2)}
            </div>
            <div className="text-[11px] text-slate-500">按实际 Token 权重折算</div>
          </div>
          <div className="p-4 space-y-1">
            <div className="text-xs text-slate-500">按次收费价格 (50% 毛利)</div>
            <div className="text-lg font-bold text-blue-700 font-mono tabular-nums">
              ¥{calcEstimate.payPerPdfPriceCny.toFixed(2)}
            </div>
            <div className="text-[11px] text-slate-500 font-mono tabular-nums">
              每页单价 ¥{calcEstimate.perPagePriceCny.toFixed(2)} · 毛利 ¥
              {calcEstimate.grossProfitCny.toFixed(2)}
            </div>
          </div>
          <div className="p-4 space-y-1">
            <div className="text-xs text-slate-500">占包月 6 小时窗口比例</div>
            <div className="text-lg font-bold text-emerald-700 font-mono tabular-nums">
              {Math.round((calcEstimate.estimatedTotalTokens / pricing.sixHourTokenLimit) * 100)}%
            </div>
            <div className="text-[11px] text-slate-500">包月会员周期内免额外单次扣费</div>
          </div>
        </div>
      </div>

      {/* Section 4: Per-User Personal Google Cloud Hosting & On-Demand Local Download */}
      <form
        onSubmit={handleCloudSaveSubmit}
        className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CloudCog className="w-4 h-4 text-blue-600" aria-hidden="true" />
            <h2 className="text-base font-bold text-slate-900">
              个人专属 Google Cloud 云端托管与按需下载策略
            </h2>
          </div>
          <span className="text-xs text-slate-500">
            每个账号严格隔离，仅使用您本人的 Google Cloud / Drive 存储文件与任务快照
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="user-cloud-mode" className="text-xs font-medium text-slate-700 block">
              个人云存储引擎模式
            </label>
            <select
              id="user-cloud-mode"
              value={cloudMode}
              onChange={(e) => setCloudMode(e.target.value as UserCloudConfig['mode'])}
              className="w-full px-3 py-2 text-xs text-slate-900 bg-slate-50 border border-slate-200 rounded-lg"
            >
              <option value="google_drive">个人 Google Drive 云盘自动建夹托管（推荐）</option>
              <option value="google_cloud_storage_and_drive">
                个人 Google Cloud Storage (GCS Bucket) + Google Drive 双重归档
              </option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="user-drive-folder" className="text-xs font-medium text-slate-700 block">
              默认云端归档总目录名称
            </label>
            <input
              id="user-drive-folder"
              type="text"
              value={driveRootFolder}
              onChange={(e) => setDriveRootFolder(e.target.value)}
              placeholder="Carbon 学术归档"
              className="w-full px-3 py-2 text-xs text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
            />
          </div>

          {cloudMode === 'google_cloud_storage_and_drive' && (
            <>
              <div className="space-y-1.5">
                <label htmlFor="user-gcp-project" className="text-xs font-medium text-slate-700 block">
                  您的 Google Cloud Project ID（选填）
                </label>
                <input
                  id="user-gcp-project"
                  type="text"
                  value={gcpProjectId}
                  onChange={(e) => setGcpProjectId(e.target.value)}
                  placeholder="例如：my-personal-gcp-project"
                  className="w-full px-3 py-2 text-xs font-mono text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="user-gcs-bucket" className="text-xs font-medium text-slate-700 block">
                  您的 Google Cloud Storage Bucket 名称
                </label>
                <input
                  id="user-gcs-bucket"
                  type="text"
                  value={gcsBucketName}
                  onChange={(e) => setGcsBucketName(e.target.value)}
                  placeholder="例如：gs://my-academic-pdfs"
                  className="w-full px-3 py-2 text-xs font-mono text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                />
              </div>
            </>
          )}
        </div>

        <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg flex items-start justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <HardDriveDownload className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" aria-hidden="true" />
            <div className="space-y-0.5">
              <label
                htmlFor="on-demand-download-checkbox"
                className="text-xs font-semibold text-slate-900 cursor-pointer"
              >
                纯云端驻留模式：仅当点击「下载 PDF」按钮时才将文件拉取到本地设备
              </label>
              <p className="text-xs text-slate-500">
                开启后，生成的 PDF 与实时源稿全程保存在您自己的 Google Cloud 云端，关闭电脑或切换手机/平板登录均可直接在线预览，绝不自动弹窗下载占用本地存储。
              </p>
            </div>
          </div>
          <input
            id="on-demand-download-checkbox"
            type="checkbox"
            checked={downloadOnDemandOnly}
            onChange={(e) => setDownloadOnDemandOnly(e.target.checked)}
            className="w-4 h-4 mt-1 rounded border-slate-300 text-blue-600 cursor-pointer shrink-0"
          />
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={isSavingCloud}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
          >
            {isSavingCloud ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
            )}
            <span>保存个人云端托管设置</span>
          </button>
        </div>
      </form>

      {/* Section 5: Super Admin Global Console (Visible ONLY to verified Super Admin howardli00101@gmail.com) */}
      {profile?.isSuperAdmin && (
        <div className="bg-white border border-slate-300 rounded-xl p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-blue-600" aria-hidden="true" />
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  超级管理员全局控制台 ({SUPER_ADMIN_EMAIL})
                </h2>
                <p className="text-xs text-slate-500">
                  实时监控全站营收毛利、动态调整全局定价与窗口配额，或为指定用户发放余额与会员天数。
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={isLoadingAdmin}
              onClick={() => {
                setIsLoadingAdmin(true);
                void onFetchAdminOverview()
                  .then((ov) => {
                    if (ov) setAdminOverview(ov);
                  })
                  .finally(() => setIsLoadingAdmin(false));
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 whitespace-nowrap shrink-0"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isLoadingAdmin ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>刷新全局数据</span>
            </button>
          </div>

          {adminOverview && (
            <>
              <div className="bg-slate-50 border border-slate-200 rounded-xl grid grid-cols-2 lg:grid-cols-5 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
                <div className="p-4 space-y-1">
                  <div className="text-xs text-slate-500">累计账户数 / 包月会员</div>
                  <div className="text-lg font-bold text-slate-900 font-mono tabular-nums">
                    {adminOverview.totalUsers} / {adminOverview.activeSubscribers}
                  </div>
                </div>
                <div className="p-4 space-y-1">
                  <div className="text-xs text-slate-500">累计总营收</div>
                  <div className="text-lg font-bold text-slate-900 font-mono tabular-nums">
                    ¥{adminOverview.totalRevenueCny.toFixed(2)}
                  </div>
                </div>
                <div className="p-4 space-y-1">
                  <div className="text-xs text-slate-500">累计 API 成本</div>
                  <div className="text-lg font-bold text-slate-900 font-mono tabular-nums">
                    ¥{adminOverview.totalApiCostCny.toFixed(2)}
                  </div>
                </div>
                <div className="p-4 space-y-1">
                  <div className="text-xs text-slate-500">实际综合毛利率</div>
                  <div className="text-lg font-bold text-emerald-700 font-mono tabular-nums">
                    {(adminOverview.realizedGrossMargin * 100).toFixed(1)}%
                  </div>
                </div>
                <div className="p-4 space-y-1">
                  <div className="text-xs text-slate-500">活跃执行中 / 总任务</div>
                  <div className="text-lg font-bold text-blue-700 font-mono tabular-nums">
                    {adminOverview.activeRunningJobsCount} / {adminOverview.totalJobsCount}
                  </div>
                </div>
              </div>

              {/* Admin Controls: Quota Tuning + User Privilege Grant */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="p-4 border border-slate-200 rounded-xl space-y-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
                    <Sliders className="w-3.5 h-3.5 text-blue-600" aria-hidden="true" />
                    <span>全局包月收费与双窗口 Token 上限微调</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label htmlFor="adm-monthly-price" className="text-[11px] text-slate-500 block">
                        包月月费 (¥)
                      </label>
                      <input
                        id="adm-monthly-price"
                        type="number"
                        value={editMonthlyPrice}
                        onChange={(e) => setEditMonthlyPrice(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-200 rounded-lg"
                      />
                    </div>
                    <div>
                      <label htmlFor="adm-6h-tokens" className="text-[11px] text-slate-500 block">
                        6小时限额 (Tokens)
                      </label>
                      <input
                        id="adm-6h-tokens"
                        type="number"
                        value={editSixHourTokens}
                        onChange={(e) => setEditSixHourTokens(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-200 rounded-lg"
                      />
                    </div>
                    <div>
                      <label htmlFor="adm-week-tokens" className="text-[11px] text-slate-500 block">
                        每周限额 (Tokens)
                      </label>
                      <input
                        id="adm-week-tokens"
                        type="number"
                        value={editWeeklyTokens}
                        onChange={(e) => setEditWeeklyTokens(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-200 rounded-lg"
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void onAdminUpdatePricing({
                        monthlyPriceCny: Number(editMonthlyPrice) || 300,
                        sixHourTokenLimit: Number(editSixHourTokens) || 120000,
                        weeklyTokenLimit: Number(editWeeklyTokens) || 570000,
                      })
                    }
                    className="px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap"
                  >
                    更新全局收费与配额参数
                  </button>
                </div>

                <div className="p-4 border border-slate-200 rounded-xl space-y-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
                    <Users className="w-3.5 h-3.5 text-blue-600" aria-hidden="true" />
                    <span>指定账号定向充值 / 赠送包月会员</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input
                      type="email"
                      value={grantEmail}
                      onChange={(e) => setGrantEmail(e.target.value)}
                      placeholder="用户邮箱 user@gmail.com"
                      aria-label="目标用户邮箱"
                      className="sm:col-span-1 px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg"
                    />
                    <input
                      type="number"
                      value={grantBalance}
                      onChange={(e) => setGrantBalance(e.target.value)}
                      placeholder="增加余额 ¥"
                      aria-label="增加钱包余额"
                      className="px-2.5 py-1.5 text-xs font-mono border border-slate-200 rounded-lg"
                    />
                    <input
                      type="number"
                      value={grantDays}
                      onChange={(e) => setGrantDays(e.target.value)}
                      placeholder="增加包月天数"
                      aria-label="增加包月会员天数"
                      className="px-2.5 py-1.5 text-xs font-mono border border-slate-200 rounded-lg"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!grantEmail.trim()) return;
                      const ov = await onAdminGrantUser({
                        targetEmail: grantEmail.trim(),
                        addBalanceCny: Number(grantBalance) || 0,
                        grantMonthlyDays: Number(grantDays) || 0,
                      });
                      if (ov) {
                        setAdminOverview(ov);
                        setGrantEmail('');
                      }
                    }}
                    className="px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 whitespace-nowrap"
                  >
                    确认发放权益
                  </button>
                </div>
              </div>

              {/* Registered Users Table */}
              <div className="border border-slate-200 rounded-xl overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-4 font-semibold">用户邮箱</th>
                      <th className="py-2.5 px-4 font-semibold">角色等级</th>
                      <th className="py-2.5 px-4 font-semibold text-right">钱包余额</th>
                      <th className="py-2.5 px-4 font-semibold text-right">6h 已用 Tokens</th>
                      <th className="py-2.5 px-4 font-semibold text-right">本周已用 Tokens</th>
                      <th className="py-2.5 px-4 font-semibold text-right">累计消费</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                    {adminOverview.users.map((u) => (
                      <tr key={u.email}>
                        <td className="py-2.5 px-4 font-sans font-medium text-slate-900">
                          {u.email}
                        </td>
                        <td className="py-2.5 px-4 font-sans text-slate-700">
                          {u.role === 'super_admin'
                            ? '超级管理员'
                            : u.role === 'pro_monthly'
                              ? '包月会员'
                              : '按次计费'}
                        </td>
                        <td className="py-2.5 px-4 text-right">¥{u.walletBalanceCny.toFixed(2)}</td>
                        <td className="py-2.5 px-4 text-right">
                          {u.sixHourTokensUsed.toLocaleString()}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          {u.weeklyTokensUsed.toLocaleString()}
                        </td>
                        <td className="py-2.5 px-4 text-right font-semibold text-slate-900">
                          ¥{u.totalSpentCny.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
