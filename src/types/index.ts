// ─── Raw / Normalized / Filtered Trade ───────────────────────────────────────

export interface RawTrade {
  market_id: string;
  market_name: string;
  /** The specific outcome being traded, e.g. "Kamilla Rakhimova" in a head-to-head market. */
  outcome?: string;
  side: 'YES' | 'NO';
  price: number; // 0–1
  size: number;
  size_usd: number;
  timestamp: number; // Unix ms
  /** Wallet address of the maker. Optional — not exposed by the Polymarket CLOB WS market channel. */
  maker_address?: string;
  /** Wallet address of the taker. Optional — not exposed by the Polymarket CLOB WS market channel. */
  taker_address?: string;
  order_book_depth: {
    bid_liquidity: number;
    ask_liquidity: number;
  };
  market_category?: string;
}

/** Canonical message pushed to trades:stream (snake_case) */
export interface NormalizedTrade {
  market_id: string;
  market_name: string;
  /** The specific outcome being traded, e.g. "Kamilla Rakhimova" in a head-to-head market. */
  outcome?: string;
  side: 'YES' | 'NO';
  price: number;
  size: number;   // raw share quantity
  size_usd: number;
  timestamp: number; // Unix ms
  /** Absent when the source (e.g. Polymarket CLOB WS) does not expose wallet addresses. */
  maker_address?: string;
  /** Absent when the source (e.g. Polymarket CLOB WS) does not expose wallet addresses. */
  taker_address?: string;
  bid_liquidity: number;
  ask_liquidity: number;
  market_category?: string;
}

/** Trade that passed the minimum size threshold (camelCase) */
export interface FilteredTrade {
  marketId: string;
  marketName: string;
  /** The specific outcome being traded, e.g. "Kamilla Rakhimova" in a head-to-head market. */
  outcome?: string;
  side: 'YES' | 'NO';
  price: number;
  sizeUSDC: number;
  timestamp: Date;
  /** Absent when the source does not expose wallet addresses (e.g. Polymarket CLOB WS market channel). */
  walletAddress?: string;
  orderBookLiquidity: number;
  marketCategory?: string;
}

// ─── Anomaly ─────────────────────────────────────────────────────────────────

export type AnomalyType =
  | 'RAPID_ODDS_SHIFT'
  | 'WHALE_ACTIVITY'
  | 'INSIDER_TRADING'
  | 'COORDINATED_MOVE';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Anomaly {
  type: AnomalyType;
  severity: Severity;
  confidence: number; // 0–1
  details: {
    description: string;
    metrics: Record<string, unknown>;
  };
  detectedAt: Date;
}

export interface ClusterAnomaly {
  type: 'COORDINATED_MOVE';
  marketId: string;
  marketName: string;
  side: 'YES' | 'NO';
  wallets: string[];
  totalSizeUSDC: number;
  windowMinutes: number;
  detectedAt: Date;
  severity: 'MEDIUM' | 'HIGH' | 'CRITICAL';
  fundingAnalysis?: FundingAnalysis;
}

// ─── Wallet / Market State ────────────────────────────────────────────────────

export interface WalletProfile {
  address: string;
  firstTransactionTimestamp: number | null;
  transactionCount: number;
  ageHours: number | null;
  isNew: boolean;
  riskScore: number; // 0–100
}

export interface MarketVolatility {
  marketId: string;
  /** Mean of absolute price values over the window (AVG(price) from TimescaleDB) */
  avgPrice: number;
  /** Standard deviation of absolute price values over the window (STDDEV(price)) */
  stddevPrice: number;
  avgTradeSize: number;
  stddevTradeSize: number;
  sampleCount: number;
  lastUpdated: Date;
}

export interface FundingAnalysis {
  wallets: string[];
  funders: Map<string, string>;
  sharedFunders: Map<string, string[]>;
  hasCommonNonExchangeFunder: boolean;
  commonFunderAddress: string | null;
  isKnownExchange: boolean;
  exchangeName: string | null;
}

export interface PricePoint {
  marketId: string;
  price: number;
  timestamp: Date;
}

// ─── Configuration / Thresholds ───────────────────────────────────────────────

export interface DetectionThresholds {
  minTradeSizeUSDC: number;
  rapidOddsShiftPercent: number;
  rapidOddsShiftWindowMinutes: number;
  whaleActivityPercent: number;
  insiderWalletAgeHours: number;
  insiderMinTradeSize: number;
  nicheMarketCategories: string[];
  clusterWindowMinutes: number;
  clusterMinWallets: number;
  zScoreThreshold: number;
  zScoreMinSamples: number;
  zScoreBaselineWindow: number;
}

export interface InsiderThresholds {
  walletAgeHours: number;
  minTradeSize: number;
  nicheCategories: string[];
}

export interface ConnectionOptions {
  url: string;
  timeout: number;
  maxRetries: number;
}

// ─── Telegram / Stream ────────────────────────────────────────────────────────

export interface TelegramMessage {
  text: string;
  parse_mode: 'MarkdownV2' | 'HTML' | 'Markdown';
  disable_web_page_preview: boolean;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface StreamMessage {
  id: string;
  fields: Record<string, string>;
}

// ─── Logging ──────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
