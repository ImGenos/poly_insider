import { WalletProfile, FundingAnalysis } from '../types/index';
import { RedisCache } from '../cache/RedisCache';
import { Logger } from '../utils/Logger';
import { isValidEthAddress, sleep } from '../utils/helpers';

const EXCHANGE_LABEL = 'Exchange';

export class BlockchainAnalyzer {
  private readonly alchemyApiKey: string;
  private readonly moralisApiKey: string;
  private readonly knownExchangeWallets: Set<string>;
  private readonly logger: Logger;

  // Rate limiting: max 5 Alchemy requests/second → >= 200ms between calls (Req 20.3)
  private lastAlchemyCallTime = 0;
  private readonly minAlchemyIntervalMs = 200;

  /**
   * Set to true after any analyzeWalletProfile call that fell back to Moralis
   * or the static fallback because Alchemy failed. Reset to false on a clean
   * Alchemy success. Read by AnalyzerService to drive the consecutive-fail counter.
   */
  lastCallUsedFallback = false;

  // Optional stored RedisCache — set when analyzeWalletProfile is called
  private redisCache: RedisCache | null = null;

  constructor(
    alchemyApiKey: string,
    moralisApiKey: string,
    knownExchangeWallets: string[],
    logger: Logger,
  ) {
    this.alchemyApiKey = alchemyApiKey;
    this.moralisApiKey = moralisApiKey;
    this.knownExchangeWallets = new Set(knownExchangeWallets.map(a => a.toLowerCase()));
    this.logger = logger;
  }

  // ─── Rate Limiting ────────────────────────────────────────────────────────

  private async throttleAlchemy(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastAlchemyCallTime;
    if (elapsed < this.minAlchemyIntervalMs) {
      await sleep(this.minAlchemyIntervalMs - elapsed);
    }
    this.lastAlchemyCallTime = Date.now();
  }

  // ─── Alchemy API ──────────────────────────────────────────────────────────

  /**
   * Call alchemy_getAssetTransfers to get the first inbound transaction for an address.
   * Uses HTTPS per Req 19.5. Rate-limited per Req 20.3.
   */
  private async alchemyGetFirstInboundTransfer(address: string): Promise<AlchemyTransfer | null> {
    await this.throttleAlchemy();

    const url = `https://polygon-mainnet.g.alchemy.com/v2/${this.alchemyApiKey}`;
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [
        {
          fromBlock: '0x0',
          toAddress: address,
          maxCount: 1,
          order: 'asc',
          category: ['external', 'internal', 'erc20', 'erc721', 'erc1155'],
        },
      ],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Alchemy HTTP error: ${response.status}`);
    }

    const data = await response.json() as AlchemyResponse;

    if (data.error) {
      throw new Error(`Alchemy RPC error: ${data.error.message}`);
    }

    const transfers = data.result?.transfers ?? [];
    return transfers.length > 0 ? transfers[0] : null;
  }

  // ─── Moralis Fallback ─────────────────────────────────────────────────────

  /**
   * Fallback: call Moralis verbose endpoint to get transaction history.
   * Uses HTTPS per Req 19.5.
   */
  private async moralisGetWalletInfo(address: string): Promise<MoralisResult | null> {
    const url = `https://deep-index.moralis.io/api/v2.2/${address}/verbose?chain=polygon`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-API-Key': this.moralisApiKey },
    });

    if (!response.ok) {
      throw new Error(`Moralis HTTP error: ${response.status}`);
    }

    const data = await response.json() as MoralisVerboseResponse;
    const txs = data.result ?? [];

    if (txs.length === 0) {
      return { firstTimestamp: null, txCount: 0 };
    }

    // Moralis returns newest first; find the oldest
    const oldest = txs.reduce((prev, curr) => {
      const prevTs = new Date(prev.block_timestamp).getTime();
      const currTs = new Date(curr.block_timestamp).getTime();
      return currTs < prevTs ? curr : prev;
    });

    return {
      firstTimestamp: new Date(oldest.block_timestamp).getTime(),
      txCount: txs.length,
    };
  }

  // ─── Profile Building ─────────────────────────────────────────────────────

  private buildProfile(
    address: string,
    firstTimestamp: number | null,
    txCount: number,
  ): WalletProfile {
    const ageHours = firstTimestamp !== null
      ? (Date.now() - firstTimestamp) / 3600000
      : null;

    const isNew = ageHours !== null ? ageHours < 48 : false;

    let riskScore: number;
    if (ageHours === null) {
      riskScore = 10;
    } else if (isNew) {
      riskScore = 80;
    } else if (ageHours < 168) {
      riskScore = 40;
    } else {
      riskScore = 10;
    }

    return {
      address,
      firstTransactionTimestamp: firstTimestamp,
      transactionCount: txCount,
      ageHours,
      isNew,
      riskScore,
    };
  }

  private buildFallbackProfile(address: string): WalletProfile {
    // Req 5.5: assume wallet is 1 year old
    const firstTransactionTimestamp = Date.now() - 365 * 24 * 3600 * 1000;
    return {
      address,
      firstTransactionTimestamp,
      transactionCount: 0,
      ageHours: 8760,
      isNew: false,
      riskScore: 10,
    };
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Analyze a wallet profile with cache-first strategy.
   * Requirements 5.1–5.5
   */
  async analyzeWalletProfile(address: string, redisCache: RedisCache): Promise<WalletProfile> {
    // Store for use by getWalletFunder / analyzeClusterFunding
    this.redisCache = redisCache;

    if (!isValidEthAddress(address)) {
      this.logger.warn('BlockchainAnalyzer: invalid address, using fallback', { address });
      return this.buildFallbackProfile(address);
    }

    // Cache-first: return immediately on Redis hit (Req 5.1)
    const cached = await redisCache.getWalletProfile(address);
    if (cached) {
      return cached;
    }

    // Cache miss: try Alchemy (Req 5.2)
    let profile: WalletProfile | null = null;

    try {
      const transfer = await this.alchemyGetFirstInboundTransfer(address);
      const firstTimestamp = transfer?.metadata?.blockTimestamp
        ? new Date(transfer.metadata.blockTimestamp).getTime()
        : null;
      profile = this.buildProfile(address, firstTimestamp, transfer ? 1 : 0);
      this.lastCallUsedFallback = false;
      this.logger.debug('BlockchainAnalyzer: fetched profile via Alchemy', { address });
    } catch (err) {
      this.lastCallUsedFallback = true;
      this.logger.warn('BlockchainAnalyzer: Alchemy failed, trying Moralis', {
        address,
        error: String(err),
      });

      // Fallback to Moralis (Req 5.4)
      try {
        const moralisResult = await this.moralisGetWalletInfo(address);
        if (moralisResult) {
          profile = this.buildProfile(address, moralisResult.firstTimestamp, moralisResult.txCount);
          this.logger.debug('BlockchainAnalyzer: fetched profile via Moralis', { address });
        }
      } catch (moralisErr) {
        this.logger.warn('BlockchainAnalyzer: Moralis also failed, using 1-year fallback', {
          address,
          error: String(moralisErr),
        });
      }
    }

    // Both failed: assume 1 year old (Req 5.5)
    if (!profile) {
      profile = this.buildFallbackProfile(address);
    }

    // Persist to Redis before returning (Req 5.3)
    await redisCache.saveWalletProfile(profile);

    return profile;
  }

  /**
   * Get the funder (from address) of the first inbound transaction.
   * Checks Redis cache first; caches result after Alchemy call.
   * Requirements 7.1, 7.2
   */
  async getWalletFunder(address: string): Promise<string | null> {
    if (!isValidEthAddress(address)) {
      this.logger.warn('BlockchainAnalyzer: invalid address for funder lookup', { address });
      return null;
    }

    const cache = this.redisCache;

    // Check Redis cache first (Req 7.1)
    if (cache) {
      const cachedFunder = await cache.getWalletFunder(address);
      if (cachedFunder !== null) {
        return cachedFunder;
      }
    }

    // Call Alchemy
    try {
      const transfer = await this.alchemyGetFirstInboundTransfer(address);
      const funder = transfer?.from ?? null;

      if (funder && cache) {
        // Cache in Redis (Req 7.2)
        await cache.cacheWalletFunder(address, funder);
      }

      return funder;
    } catch (err) {
      this.logger.warn('BlockchainAnalyzer: Alchemy failed for funder lookup', {
        address,
        error: String(err),
      });
      return null;
    }
  }

  /**
   * Analyze cluster funding relationships.
   * Requirements 7.3–7.7
   */
  async analyzeClusterFunding(wallets: string[]): Promise<FundingAnalysis> {
    const validWallets = wallets.filter(w => isValidEthAddress(w));

    const funders = new Map<string, string>();        // wallet -> funder
    const sharedFunders = new Map<string, string[]>(); // funder (lowercase) -> wallets[]

    // For each wallet, get funder (Req 7.3)
    for (const wallet of validWallets) {
      try {
        const funder = await this.getWalletFunder(wallet);
        if (funder) {
          funders.set(wallet, funder);
          const funderLower = funder.toLowerCase();
          const existing = sharedFunders.get(funderLower) ?? [];
          existing.push(wallet);
          sharedFunders.set(funderLower, existing);
        }
      } catch {
        // Skip individual wallet on failure (Req 7.5) — non-blocking
        this.logger.warn('BlockchainAnalyzer: skipping wallet in cluster funding analysis', { wallet });
      }
    }

    // If all lookups failed, return safe default (Req 7.6)
    if (funders.size === 0) {
      return {
        wallets,
        funders,
        sharedFunders,
        hasCommonNonExchangeFunder: false,
        commonFunderAddress: null,
        isKnownExchange: false,
        exchangeName: null,
      };
    }

    // Find funders that funded >= 2 wallets (Req 7.3)
    let hasCommonNonExchangeFunder = false;
    let commonFunderAddress: string | null = null;
    let isKnownExchange = false;
    let exchangeName: string | null = null;

    for (const [funderAddr, fundedWallets] of sharedFunders.entries()) {
      if (fundedWallets.length >= 2) {
        if (this.knownExchangeWallets.has(funderAddr)) {
          // Known exchange: set exchange info but do NOT set hasCommonNonExchangeFunder (Req 7.4)
          isKnownExchange = true;
          exchangeName = EXCHANGE_LABEL;
          commonFunderAddress = funderAddr;
        } else {
          // Non-exchange common funder found (Req 7.3)
          hasCommonNonExchangeFunder = true;
          commonFunderAddress = funderAddr;
          break;
        }
      }
    }

    return {
      wallets,
      funders,
      sharedFunders,
      hasCommonNonExchangeFunder,
      commonFunderAddress,
      isKnownExchange,
      exchangeName,
    };
  }
}

// ─── Internal Types ───────────────────────────────────────────────────────────

interface AlchemyTransfer {
  from: string;
  to: string;
  metadata?: {
    blockTimestamp?: string;
  };
}

interface AlchemyResponse {
  jsonrpc: string;
  id: number;
  result?: {
    transfers: AlchemyTransfer[];
  };
  error?: {
    code: number;
    message: string;
  };
}

interface MoralisTransaction {
  block_timestamp: string;
  from_address: string;
  to_address: string;
}

interface MoralisVerboseResponse {
  result?: MoralisTransaction[];
}

interface MoralisResult {
  firstTimestamp: number | null;
  txCount: number;
}
