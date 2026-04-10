export interface RawTrade {
    market_id: string;
    market_name: string;
    side: 'YES' | 'NO';
    price: number;
    size: number;
    size_usd: number;
    timestamp: number;
    maker_address: string;
    taker_address: string;
    order_book_depth: {
        bid_liquidity: number;
        ask_liquidity: number;
    };
}
/** Canonical message pushed to trades:stream (snake_case) */
export interface NormalizedTrade {
    market_id: string;
    market_name: string;
    side: 'YES' | 'NO';
    price: number;
    size_usd: number;
    timestamp: number;
    maker_address: string;
    taker_address: string;
    bid_liquidity: number;
    ask_liquidity: number;
}
/** Trade that passed the minimum size threshold (camelCase) */
export interface FilteredTrade {
    marketId: string;
    marketName: string;
    side: 'YES' | 'NO';
    price: number;
    sizeUSDC: number;
    timestamp: Date;
    walletAddress: string;
    orderBookLiquidity: number;
    marketCategory?: string;
}
export type AnomalyType = 'RAPID_ODDS_SHIFT' | 'WHALE_ACTIVITY' | 'INSIDER_TRADING' | 'COORDINATED_MOVE';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export interface Anomaly {
    type: AnomalyType;
    severity: Severity;
    confidence: number;
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
export interface WalletProfile {
    address: string;
    firstTransactionTimestamp: number | null;
    transactionCount: number;
    ageHours: number | null;
    isNew: boolean;
    riskScore: number;
}
export interface MarketVolatility {
    marketId: string;
    avgPriceChange: number;
    stddevPriceChange: number;
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
export interface TelegramMessage {
    text: string;
    parse_mode: 'Markdown' | 'HTML';
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
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
//# sourceMappingURL=index.d.ts.map