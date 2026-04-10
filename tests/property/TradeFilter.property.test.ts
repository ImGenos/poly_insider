import * as fc from 'fast-check';
import { TradeFilter } from '../../src/filters/TradeFilter';
import { RawTrade } from '../../src/types/index';

// ─── Arbitrary ────────────────────────────────────────────────────────────────

const arbRawTrade: fc.Arbitrary<RawTrade> = fc.record({
  market_id: fc.string({ minLength: 1 }),
  market_name: fc.string({ minLength: 1 }),
  side: fc.constantFrom('YES' as const, 'NO' as const),
  price: fc.float({ min: 0, max: 1, noNaN: true }),
  size: fc.float({ min: Math.fround(0.01), max: 1000000, noNaN: true }),
  size_usd: fc.float({ min: 0, max: 1000000, noNaN: true }),
  timestamp: fc.integer({ min: 1000000000000, max: 9999999999999 }),
  maker_address: fc.constant('0xaAbBcCdDeEfF0011223344556677889900aAbBcC'),
  taker_address: fc.constant('0x1122334455667788990011223344556677889900'),
  order_book_depth: fc.record({
    bid_liquidity: fc.float({ min: 0, max: 100000, noNaN: true }),
    ask_liquidity: fc.float({ min: 0, max: 100000, noNaN: true }),
  }),
});

const arbThreshold = fc.float({ min: 0, max: 1000000, noNaN: true });

// ─── Property 1: Trade Filtering Consistency ──────────────────────────────────

/**
 * Property 1: Trade Filtering Consistency
 * filter(trade, threshold) returns non-null iff trade.size_usd >= threshold
 * Validates: Requirements 2.1, 2.2
 */
describe('Property 1: Trade Filtering Consistency', () => {
  it('filter returns non-null iff size_usd >= threshold', () => {
    fc.assert(
      fc.property(arbRawTrade, arbThreshold, (trade, threshold) => {
        const filter = new TradeFilter(threshold);
        const result = filter.filter(trade);

        if (trade.size_usd >= threshold) {
          return result !== null;
        } else {
          return result === null;
        }
      }),
      { numRuns: 1000 }
    );
  });
});

// ─── Property 2: Filtering Monotonicity ──────────────────────────────────────

/**
 * Property 2: Filtering Monotonicity
 * For any array of trades and two thresholds t1 <= t2,
 * trades passing t2 is a subset of trades passing t1.
 * Validates: Requirements 2.1, 2.2
 */
describe('Property 2: Filtering Monotonicity', () => {
  it('trades passing a higher threshold are a subset of trades passing a lower threshold', () => {
    fc.assert(
      fc.property(
        fc.array(arbRawTrade, { minLength: 0, maxLength: 50 }),
        arbThreshold,
        arbThreshold,
        (trades, ta, tb) => {
          const t1 = Math.min(ta, tb);
          const t2 = Math.max(ta, tb);

          const filter1 = new TradeFilter(t1);
          const filter2 = new TradeFilter(t2);

          const passing1 = trades.filter(t => filter1.filter(t) !== null);
          const passing2 = trades.filter(t => filter2.filter(t) !== null);

          // Every trade that passes t2 must also pass t1
          return passing2.every(t => passing1.includes(t));
        }
      ),
      { numRuns: 500 }
    );
  });
});
