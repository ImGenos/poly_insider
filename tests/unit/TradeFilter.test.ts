import { TradeFilter } from '../../src/filters/TradeFilter';
import { RawTrade } from '../../src/types/index';

function makeTrade(overrides: Partial<RawTrade> = {}): RawTrade {
  return {
    market_id: 'mkt-001',
    market_name: 'Will it rain?',
    side: 'YES',
    price: 0.65,
    size: 100,
    size_usd: 5000,
    timestamp: 1700000000000,
    maker_address: '0xMAKER',
    taker_address: '0xTAKER',
    order_book_depth: { bid_liquidity: 3000, ask_liquidity: 2000 },
    ...overrides,
  };
}

describe('TradeFilter', () => {
  const THRESHOLD = 5000;
  let filter: TradeFilter;

  beforeEach(() => {
    filter = new TradeFilter(THRESHOLD);
  });

  // ── Threshold boundary tests (Requirements 2.1, 2.2) ──────────────────────

  it('passes a trade exactly at the threshold', () => {
    const trade = makeTrade({ size_usd: THRESHOLD });
    expect(filter.filter(trade)).not.toBeNull();
  });

  it('returns null for a trade just below the threshold', () => {
    const trade = makeTrade({ size_usd: THRESHOLD - 0.01 });
    expect(filter.filter(trade)).toBeNull();
  });

  it('passes a trade just above the threshold', () => {
    const trade = makeTrade({ size_usd: THRESHOLD + 0.01 });
    expect(filter.filter(trade)).not.toBeNull();
  });

  // ── camelCase normalization (Requirements 2.3) ────────────────────────────

  it('maps snake_case input fields to camelCase output fields', () => {
    const trade = makeTrade({ size_usd: THRESHOLD });
    const result = filter.filter(trade)!;

    expect(result.marketId).toBe(trade.market_id);
    expect(result.marketName).toBe(trade.market_name);
    expect(result.sizeUSDC).toBe(trade.size_usd);
    expect(result.orderBookLiquidity).toBe(
      trade.order_book_depth.bid_liquidity + trade.order_book_depth.ask_liquidity
    );
  });

  it('converts timestamp (Unix ms) to a Date object', () => {
    const trade = makeTrade({ size_usd: THRESHOLD });
    const result = filter.filter(trade)!;

    expect(result.timestamp).toBeInstanceOf(Date);
    expect(result.timestamp.getTime()).toBe(trade.timestamp);
  });

  it('sums bid and ask liquidity into orderBookLiquidity', () => {
    const trade = makeTrade({
      size_usd: THRESHOLD,
      order_book_depth: { bid_liquidity: 1500, ask_liquidity: 2500 },
    });
    const result = filter.filter(trade)!;
    expect(result.orderBookLiquidity).toBe(4000);
  });

  // ── walletAddress selection (Requirements 2.4) ────────────────────────────

  it('uses taker_address as walletAddress for YES (buy) trades', () => {
    const trade = makeTrade({ side: 'YES', size_usd: THRESHOLD });
    const result = filter.filter(trade)!;
    expect(result.walletAddress).toBe(trade.taker_address);
  });

  it('uses maker_address as walletAddress for NO (sell) trades', () => {
    const trade = makeTrade({ side: 'NO', size_usd: THRESHOLD });
    const result = filter.filter(trade)!;
    expect(result.walletAddress).toBe(trade.maker_address);
  });

  // ── Input immutability (Requirements 2.3) ────────────────────────────────

  it('does not mutate the input trade object', () => {
    const trade = makeTrade({ size_usd: THRESHOLD });
    const snapshot = JSON.stringify(trade);
    filter.filter(trade);
    expect(JSON.stringify(trade)).toBe(snapshot);
  });

  it('does not mutate the input trade when it is filtered out', () => {
    const trade = makeTrade({ size_usd: 1 });
    const snapshot = JSON.stringify(trade);
    filter.filter(trade);
    expect(JSON.stringify(trade)).toBe(snapshot);
  });

  // ── marketCategory is optional ────────────────────────────────────────────

  it('leaves marketCategory undefined on the output', () => {
    const result = filter.filter(makeTrade({ size_usd: THRESHOLD }))!;
    expect(result.marketCategory).toBeUndefined();
  });

  // ── Default threshold ─────────────────────────────────────────────────────

  it('uses 5000 as the default minimum size', () => {
    const defaultFilter = new TradeFilter();
    expect(defaultFilter.getMinimumSize()).toBe(5000);
  });
});
