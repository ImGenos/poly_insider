import { WalletProfile, FundingAnalysis } from '../types/index';
import { RedisCache } from '../cache/RedisCache';
import { Logger } from '../utils/Logger';
export declare class BlockchainAnalyzer {
    private readonly alchemyApiKey;
    private readonly moralisApiKey;
    private readonly knownExchangeWallets;
    private readonly logger;
    private lastAlchemyCallTime;
    private readonly minAlchemyIntervalMs;
    private redisCache;
    constructor(alchemyApiKey: string, moralisApiKey: string, knownExchangeWallets: string[], logger: Logger);
    private throttleAlchemy;
    /**
     * Call alchemy_getAssetTransfers to get the first inbound transaction for an address.
     * Uses HTTPS per Req 19.5. Rate-limited per Req 20.3.
     */
    private alchemyGetFirstInboundTransfer;
    /**
     * Fallback: call Moralis verbose endpoint to get transaction history.
     * Uses HTTPS per Req 19.5.
     */
    private moralisGetWalletInfo;
    private buildProfile;
    private buildFallbackProfile;
    /**
     * Analyze a wallet profile with cache-first strategy.
     * Requirements 5.1–5.5
     */
    analyzeWalletProfile(address: string, redisCache: RedisCache): Promise<WalletProfile>;
    /**
     * Get the funder (from address) of the first inbound transaction.
     * Checks Redis cache first; caches result after Alchemy call.
     * Requirements 7.1, 7.2
     */
    getWalletFunder(address: string): Promise<string | null>;
    /**
     * Analyze cluster funding relationships.
     * Requirements 7.3–7.7
     */
    analyzeClusterFunding(wallets: string[]): Promise<FundingAnalysis>;
}
//# sourceMappingURL=BlockchainAnalyzer.d.ts.map