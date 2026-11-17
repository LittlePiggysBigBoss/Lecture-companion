import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkJobBillingAuthorization,
  computeMonthlyPlanEconomics,
  DEFAULT_PRICING_CONFIG,
  estimateTaskTokenAndPrice,
  evaluateQuotaWindow,
  isSuperAdminEmail,
  SIX_HOURS_MS,
  SUPER_ADMIN_EMAIL,
} from './billingAndQuota.ts';

test('howardli00101@gmail.com is recognized as Super Admin case-insensitively', () => {
  assert.equal(isSuperAdminEmail('howardli00101@gmail.com'), true);
  assert.equal(isSuperAdminEmail('  HowardLi00101@gmail.com '), true);
  assert.equal(isSuperAdminEmail('newuser@example.com'), false);
  assert.equal(SUPER_ADMIN_EMAIL, 'howardli00101@gmail.com');
});

test('Pay-Per-PDF pricing maintains exact 50% gross margin across depth presets and attachments', () => {
  for (const depth of ['standard', 'comprehensive', 'exhaustive'] as const) {
    const est = estimateTaskTokenAndPrice({
      mode: 'lecture_notes',
      depth,
      promptLength: 320,
      attachments: [{ kind: 'pdf', size: 25 * 1024 * 1024 }], // 25MB PDF
    });
    assert.ok(est.upstreamApiCostCny > 0);
    assert.equal(est.payPerPdfPriceCny, Number((est.upstreamApiCostCny * 2).toFixed(2)));
    assert.ok(Math.abs(est.grossMarginRate - 0.5) <= 0.005);
  }
});

test('Monthly ¥300 subscription enforces 30% gross margin ceiling (¥210 monthly API cost budget)', () => {
  const econ = computeMonthlyPlanEconomics(DEFAULT_PRICING_CONFIG);
  assert.equal(econ.monthlyPriceCny, 300);
  assert.equal(econ.targetGrossMargin, 0.3);
  assert.equal(econ.maxMonthlyApiCostBudgetCny, 210);
  assert.equal(econ.targetGrossProfitCny, 90);
  assert.equal(econ.maxWeeklyApiCostBudgetCny, 49);
});

test('Rolling 6-hour and weekly quota windows reset accurately as usage events age out', () => {
  const now = 1_800_000_000_000;
  const events = [
    // 7 hours ago: outside 6h window, inside 7-day weekly window
    { id: 'e1', timestampMs: now - 7 * 3600 * 1000, tokens: 95_000, apiCostCny: 8.2, pages: 20 },
    // 2 hours ago: inside both 6h and weekly windows
    { id: 'e2', timestampMs: now - 2 * 3600 * 1000, tokens: 80_000, apiCostCny: 6.8, pages: 16 },
  ];

  const snap = evaluateQuotaWindow(events, now, DEFAULT_PRICING_CONFIG);
  assert.equal(snap.sixHourTokensUsed, 80_000);
  assert.equal(snap.sixHourTasksUsed, 1);
  assert.equal(snap.weeklyTokensUsed, 175_000);
  assert.equal(snap.weeklyTasksUsed, 2);
  assert.equal(
    Date.parse(snap.sixHourResetAt),
    now - 2 * 3600 * 1000 + SIX_HOURS_MS
  );
});

test('checkJobBillingAuthorization grants unlimited free execution to Super Admin and enforces quota/wallet for regular users', () => {
  const est = estimateTaskTokenAndPrice({
    mode: 'workbook',
    depth: 'comprehensive',
  });
  const emptyUsage = evaluateQuotaWindow([], Date.now());

  // 1. Super Admin always free & allowed even if usage is maxed
  const adminRes = checkJobBillingAuthorization({
    profile: {
      email: 'howardli00101@gmail.com',
      role: 'super_admin',
      isSuperAdmin: true,
      subscriptionActive: false,
      walletBalanceCny: 0,
      usage: { ...emptyUsage, sixHourTokensUsed: 999_999 },
    },
    estimate: est,
  });
  assert.equal(adminRes.allowed, true);
  assert.equal(adminRes.billingMode, 'super_admin_free');
  assert.equal(adminRes.chargeAmountCny, 0);

  // 2. New user with ¥0 wallet and no subscription is prompted to top up or subscribe
  const unpaidUserRes = checkJobBillingAuthorization({
    profile: {
      email: 'student@university.edu',
      role: 'pay_per_use',
      isSuperAdmin: false,
      subscriptionActive: false,
      walletBalanceCny: 0,
      usage: emptyUsage,
    },
    estimate: est,
  });
  assert.equal(unpaidUserRes.allowed, false);
  assert.equal(unpaidUserRes.chargeAmountCny, est.payPerPdfPriceCny);

  // 3. New user with sufficient wallet balance pays exact 50%-margin Pay-Per-PDF price
  const paidUserRes = checkJobBillingAuthorization({
    profile: {
      email: 'student@university.edu',
      role: 'pay_per_use',
      isSuperAdmin: false,
      subscriptionActive: false,
      walletBalanceCny: 50,
      usage: emptyUsage,
    },
    estimate: est,
  });
  assert.equal(paidUserRes.allowed, true);
  assert.equal(paidUserRes.billingMode, 'pay_per_pdf');
  assert.equal(paidUserRes.chargeAmountCny, est.payPerPdfPriceCny);

  // 4. Monthly Pro subscriber blocked when 6-hour token limit is exceeded (and wallet is 0)
  const exhaustedProRes = checkJobBillingAuthorization({
    profile: {
      email: 'pro@university.edu',
      role: 'pro_monthly',
      isSuperAdmin: false,
      subscriptionActive: true,
      walletBalanceCny: 0,
      usage: { ...emptyUsage, sixHourTokensUsed: 110_000 },
    },
    estimate: est,
  });
  assert.equal(exhaustedProRes.allowed, false);
  assert.ok(exhaustedProRes.reason?.includes('6 小时'));
});
