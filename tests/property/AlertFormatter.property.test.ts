import * as fc from 'fast-check';
import { AlertFormatter } from '../../src/alerts/AlertFormatter';
import { Anomaly, AnomalyType, ClusterAnomaly, FilteredTrade, FundingAnalysis, Severity } from '../../src/types/index';

const formatter = new AlertFormatter();

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const arbSeverity: fc.Arbitrary<Severity> = fc.constantFrom('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
const arbAnomalyType: fc.Arbitrary<AnomalyType> = fc.constantFrom(
  'RAPID_ODDS_SHIFT',
  'WHALE_ACTIVITY',
  'INSIDER_TRADING',
  'COORDINATED_MOVE',
);
const arbSide = fc.constantFrom<'YES' | 'NO'>('YES', 'NO');
const arbClusterSeverity = fc.constantFrom<'MEDIUM' | 'HIGH' | 'CRITICAL'>('MEDIUM', 'HIGH', 'CRITICAL');

/** Generates a plausible wallet address string (not necessarily valid hex) */
const arbWalletAddress = fc.string({ minLength: 5, maxLength: 42 });

/** Generates a market name that may contain Telegram Markdown special characters */
const arbMarketName = fc.string({ minLength: 1, maxLength: 200 });

const arbAnomaly: fc.Arbitrary<Anomaly> = fc.record({
  type: arbAnomalyType,
  severity: arbSeverity,
  confidence: fc.float({ min: 0, max: 1, noNaN: true }),
  details: fc.record({
    description: fc.string({ minLength: 0, maxLength: 100 }),
    metrics: fc.oneof(
      fc.constant({}),
      fc.record({ zScore: fc.float({ min: -10, max: 10, noNaN: true }) }),
      fc.record({
        zScore: fc.float({ min: -10, max: 10, noNaN: true }),
        liquidityConsumedPercent: fc.float({ min: 0, max: 100, noNaN: true }),
      }),
      fc.record({
        walletAgeHours: fc.float({ min: 0, max: 1000, noNaN: true }),
        transactionCount: fc.integer({ min: 0, max: 1000 }),
        riskScore: fc.integer({ min: 0, max: 100 }),
      }),
      fc.record({ priceChangePercent: fc.float({ min: 0, max: 100, noNaN: true }) }),
    ),
  }),
  detectedAt: fc.date(),
});

const arbFilteredTrade: fc.Arbitrary<FilteredTrade> = fc.record({
  marketId: fc.string({ minLength: 1, maxLength: 50 }),
  marketName: arbMarketName,
  side: arbSide,
  price: fc.float({ min: 0, max: 1, noNaN: true }),
  sizeUSDC: fc.float({ min: 0, max: 1_000_000, noNaN: true }),
  timestamp: fc.date(),
  walletAddress: arbWalletAddress,
  orderBookLiquidity: fc.float({ min: 0, max: 10_000_000, noNaN: true }),
  marketCategory: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
});

const arbClusterAnomaly: fc.Arbitrary<ClusterAnomaly> = fc.record({
  type: fc.constant<'COORDINATED_MOVE'>('COORDINATED_MOVE'),
  marketId: fc.string({ minLength: 1, maxLength: 50 }),
  marketName: arbMarketName,
  side: arbSide,
  wallets: fc.array(arbWalletAddress, { minLength: 1, maxLength: 20 }),
  totalSizeUSDC: fc.float({ min: 0, max: 10_000_000, noNaN: true }),
  windowMinutes: fc.integer({ min: 1, max: 60 }),
  detectedAt: fc.date(),
  severity: arbClusterSeverity,
  fundingAnalysis: fc.option(
    fc.record<FundingAnalysis>({
      wallets: fc.array(arbWalletAddress, { minLength: 1, maxLength: 10 }),
      funders: fc.constant(new Map<string, string>()),
      sharedFunders: fc.constant(new Map<string, string[]>()),
      hasCommonNonExchangeFunder: fc.boolean(),
      commonFunderAddress: fc.option(arbWalletAddress, { nil: null }),
      isKnownExchange: fc.boolean(),
      exchangeName: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: null }),
    }),
    { nil: undefined },
  ),
});

// ─── Property 8: Telegram Message Length Compliance ──────────────────────────

/**
 * Property 8: Telegram Message Length Compliance
 *
 * For any anomaly and trade combination, the formatted message length is
 * always <= 4096 characters (Telegram's maximum message length).
 *
 * **Validates: Requirements 10.7**
 */
describe('Property 8: Telegram Message Length Compliance', () => {
  it('format(anomaly, trade).text.length <= 4096 for any anomaly and trade', () => {
    fc.assert(
      fc.property(arbAnomaly, arbFilteredTrade, (anomaly, trade) => {
        const msg = formatter.format(anomaly, trade);
        return msg.text.length <= 4096;
      }),
      { numRuns: 500 },
    );
  });

  it('formatClusterMessage(anomaly).text.length <= 4096 for any cluster anomaly', () => {
    fc.assert(
      fc.property(arbClusterAnomaly, (anomaly) => {
        const msg = formatter.formatClusterMessage(anomaly);
        return msg.text.length <= 4096;
      }),
      { numRuns: 500 },
    );
  });
});
