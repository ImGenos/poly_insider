import { FilteredTrade, Severity } from '../types/index';
import { TimeSeriesDB } from '../db/TimeSeriesDB';
import { RedisCache } from '../cache/RedisCache';
import { BlockchainAnalyzer } from '../blockchain/BlockchainAnalyzer';
import { Logger } from '../utils/Logger';

// Mots-clés pour filtrer les marchés de football
const FOOTBALL_KEYWORDS = [
  'football',
  'soccer',
  'champions league',
  'premier league',
  'la liga',
  'serie a',
  'bundesliga',
  'ligue 1',
  'uefa',
  'fifa',
  'world cup',
  'euro',
  'copa',
];

export interface SmartMoneyConfig {
  minTradeSizeUSDC: number;
  confidenceThreshold: number; // Score minimum pour déclencher une alerte (ex: 80)
  walletProfileTTL: number; // TTL en secondes pour le cache des profils (ex: 86400 = 24h)
}

export interface BettorConfidenceIndex {
  walletAddress: string;
  score: number; // 0-100
  metrics: {
    pnl: number; // Profit & Loss historique
    pnlScore: number;
    recentVolume: number;
    volumeScore: number;
    betSizeRatio: number; // Ratio mise actuelle / mise moyenne
    betSizeScore: number;
    winRate: number; // Taux de réussite (0-1)
    winRateScore: number;
  };
  calculatedAt: Date;
}

export interface SmartMoneyAlert {
  marketId: string;
  marketName: string;
  side: 'YES' | 'NO';
  amount: number;
  price: number;
  walletAddress: string;
  confidenceIndex: BettorConfidenceIndex;
  severity: Severity;
  detectedAt: Date;
}

export class SmartMoneyDetector {
  private readonly config: SmartMoneyConfig;
  private readonly timeSeriesDB: TimeSeriesDB;
  private readonly redisCache: RedisCache;
  private readonly logger: Logger;

  constructor(
    config: SmartMoneyConfig,
    timeSeriesDB: TimeSeriesDB,
    redisCache: RedisCache,
    _blockchainAnalyzer: BlockchainAnalyzer,
    logger: Logger,
  ) {
    this.config = config;
    this.timeSeriesDB = timeSeriesDB;
    this.redisCache = redisCache;
    // _blockchainAnalyzer is passed for future use but not currently needed
    this.logger = logger;
  }

  // ─── Filtre de Marché Football ────────────────────────────────────────────

  isFootballMarket(trade: FilteredTrade): boolean {
    const searchText = `${trade.marketName} ${trade.marketCategory || ''}`.toLowerCase();
    return FOOTBALL_KEYWORDS.some(keyword => searchText.includes(keyword));
  }

  // ─── Calcul de l'Index de Confiance ───────────────────────────────────────

  async calculateBettorConfidenceIndex(
    walletAddress: string,
    currentTradeSize: number,
  ): Promise<BettorConfidenceIndex | null> {
    // Vérifier le cache Redis d'abord
    const cached = await this.getCachedConfidenceIndex(walletAddress);
    if (cached) {
      this.logger.debug('SmartMoneyDetector: using cached confidence index', { walletAddress });
      return cached;
    }

    try {
      // Récupérer les métriques on-chain via Alchemy
      const metrics = await this.fetchWalletMetrics(walletAddress, currentTradeSize);
      
      if (!metrics) {
        return null;
      }

      // Calculer les scores individuels (0-100)
      const pnlScore = this.calculatePnLScore(metrics.pnl);
      const volumeScore = this.calculateVolumeScore(metrics.recentVolume);
      const betSizeScore = this.calculateBetSizeScore(metrics.betSizeRatio);
      const winRateScore = this.calculateWinRateScore(metrics.winRate);

      // Score final pondéré
      const finalScore = 
        pnlScore * 0.40 +      // 40% - Historique PnL (pondération forte)
        volumeScore * 0.20 +   // 20% - Volume récent
        betSizeScore * 0.25 +  // 25% - Ratio de mise
        winRateScore * 0.15;   // 15% - Taux de réussite

      const confidenceIndex: BettorConfidenceIndex = {
        walletAddress,
        score: Math.round(finalScore),
        metrics: {
          pnl: metrics.pnl,
          pnlScore,
          recentVolume: metrics.recentVolume,
          volumeScore,
          betSizeRatio: metrics.betSizeRatio,
          betSizeScore,
          winRate: metrics.winRate,
          winRateScore,
        },
        calculatedAt: new Date(),
      };

      // Mettre en cache
      await this.cacheConfidenceIndex(confidenceIndex);

      return confidenceIndex;
    } catch (err) {
      this.logger.warn('SmartMoneyDetector: failed to calculate confidence index', {
        walletAddress,
        error: String(err),
      });
      return null;
    }
  }

  // ─── Récupération des Métriques Wallet ────────────────────────────────────

  private async fetchWalletMetrics(
    walletAddress: string,
    currentTradeSize: number,
  ): Promise<{
    pnl: number;
    recentVolume: number;
    betSizeRatio: number;
    winRate: number;
  } | null> {
    // Récupérer l'historique des transactions Polymarket via Alchemy
    // Note: Polymarket utilise le contrat CTF Exchange sur Polygon
    const history = await this.getPolymarketHistory(walletAddress);
    
    if (!history || history.length === 0) {
      return null;
    }

    // Calculer PnL (simplifié: somme des gains - pertes)
    const pnl = this.calculatePnL(history);

    // Volume récent (30 derniers jours)
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentTrades = history.filter(tx => tx.timestamp > thirtyDaysAgo);
    const recentVolume = recentTrades.reduce((sum, tx) => sum + tx.value, 0);

    // Ratio de mise (mise actuelle / mise moyenne)
    const avgTradeSize = history.reduce((sum, tx) => sum + tx.value, 0) / history.length;
    const betSizeRatio = avgTradeSize > 0 ? currentTradeSize / avgTradeSize : 1;

    // Taux de réussite (positions gagnantes / total)
    const winRate = this.calculateWinRate(history);

    return {
      pnl,
      recentVolume,
      betSizeRatio,
      winRate,
    };
  }

  private async getPolymarketHistory(walletAddress: string): Promise<PolymarketTransaction[]> {
    // Utiliser l'API Alchemy pour récupérer les transactions du wallet
    // Filtrer uniquement les interactions avec le contrat Polymarket CTF Exchange
    const POLYMARKET_CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'.toLowerCase();
    
    try {
      const alchemyApiKey = process.env.ALCHEMY_API_KEY || '';
      const url = `https://polygon-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
      
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [{
          fromAddress: walletAddress,
          toAddress: POLYMARKET_CTF_EXCHANGE,
          category: ['external', 'erc20'],
          maxCount: 100,
          order: 'desc',
        }],
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Alchemy HTTP error: ${response.status}`);
      }

      const data = await response.json() as AlchemyAssetTransferResponse;
      
      if (data.error) {
        throw new Error(`Alchemy RPC error: ${data.error.message}`);
      }

      const transfers = data.result?.transfers || [];
      
      return transfers.map(tx => ({
        hash: tx.hash || '',
        timestamp: tx.metadata?.blockTimestamp 
          ? new Date(tx.metadata.blockTimestamp).getTime() 
          : Date.now(),
        value: tx.value ? parseFloat(tx.value) : 0,
        asset: tx.asset || 'USDC',
      }));
    } catch (err) {
      this.logger.warn('SmartMoneyDetector: failed to fetch Polymarket history', {
        walletAddress,
        error: String(err),
      });
      return [];
    }
  }

  // ─── Calculs de Scores ─────────────────────────────────────────────────────

  private calculatePnL(history: PolymarketTransaction[]): number {
    // Simplification: on estime le PnL basé sur le volume total
    // Dans une implémentation réelle, il faudrait tracker les positions ouvertes/fermées
    const totalVolume = history.reduce((sum, tx) => sum + tx.value, 0);
    // Estimation: 10% de profit sur le volume total pour un bon trader
    return totalVolume * 0.1;
  }

  private calculatePnLScore(pnl: number): number {
    // Score basé sur le PnL
    // PnL > $50k = 100, PnL < 0 = 0
    if (pnl <= 0) return 0;
    if (pnl >= 50000) return 100;
    return (pnl / 50000) * 100;
  }

  private calculateVolumeScore(recentVolume: number): number {
    // Score basé sur le volume récent (30 jours)
    // Volume > $100k = 100, Volume < $1k = 0
    if (recentVolume <= 1000) return 0;
    if (recentVolume >= 100000) return 100;
    return ((recentVolume - 1000) / 99000) * 100;
  }

  private calculateBetSizeScore(betSizeRatio: number): number {
    // Score basé sur le ratio de mise
    // Ratio > 10x = 100 (conviction très forte)
    // Ratio < 0.5x = 0 (mise plus faible que d'habitude)
    if (betSizeRatio <= 0.5) return 0;
    if (betSizeRatio >= 10) return 100;
    return ((betSizeRatio - 0.5) / 9.5) * 100;
  }

  private calculateWinRate(history: PolymarketTransaction[]): number {
    // Simplification: on estime un win rate de 60% pour les traders actifs
    // Dans une implémentation réelle, il faudrait tracker les résultats des positions
    if (history.length === 0) return 0;
    return 0.6; // 60% de réussite estimé
  }

  private calculateWinRateScore(winRate: number): number {
    // Score basé sur le taux de réussite
    // Win rate > 70% = 100, Win rate < 40% = 0
    if (winRate <= 0.4) return 0;
    if (winRate >= 0.7) return 100;
    return ((winRate - 0.4) / 0.3) * 100;
  }

  // ─── Cache Redis ───────────────────────────────────────────────────────────

  private async getCachedConfidenceIndex(
    walletAddress: string,
  ): Promise<BettorConfidenceIndex | null> {
    try {
      const key = `smart_money:${walletAddress}`;
      const cached = await this.redisCache.get(key);
      
      if (!cached) return null;

      return JSON.parse(cached) as BettorConfidenceIndex;
    } catch (err) {
      this.logger.warn('SmartMoneyDetector: failed to get cached confidence index', {
        walletAddress,
        error: String(err),
      });
      return null;
    }
  }

  private async cacheConfidenceIndex(index: BettorConfidenceIndex): Promise<void> {
    try {
      const key = `smart_money:${index.walletAddress}`;
      await this.redisCache.set(
        key,
        JSON.stringify(index),
        this.config.walletProfileTTL,
      );
    } catch (err) {
      this.logger.warn('SmartMoneyDetector: failed to cache confidence index', {
        walletAddress: index.walletAddress,
        error: String(err),
      });
    }
  }

  // ─── Détection Principale ──────────────────────────────────────────────────

  async detect(trade: FilteredTrade): Promise<SmartMoneyAlert | null> {
    // Filtre 1: Vérifier que c'est un marché de football
    if (!this.isFootballMarket(trade)) {
      return null;
    }

    // Filtre 2: Vérifier le seuil de taille minimum
    if (trade.sizeUSDC < this.config.minTradeSizeUSDC) {
      return null;
    }

    // Filtre 3: Vérifier qu'on a une adresse wallet
    if (!trade.walletAddress) {
      this.logger.debug('SmartMoneyDetector: no wallet address available', {
        marketId: trade.marketId,
      });
      return null;
    }

    // Calculer l'Index de Confiance
    const confidenceIndex = await this.calculateBettorConfidenceIndex(
      trade.walletAddress,
      trade.sizeUSDC,
    );

    if (!confidenceIndex) {
      return null;
    }

    // Vérifier le seuil de confiance
    if (confidenceIndex.score < this.config.confidenceThreshold) {
      return null;
    }

    // Déterminer la sévérité
    let severity: Severity;
    if (confidenceIndex.score >= 90) {
      severity = 'CRITICAL';
    } else if (confidenceIndex.score >= 85) {
      severity = 'HIGH';
    } else {
      severity = 'MEDIUM';
    }

    // Enregistrer dans TimescaleDB
    await this.recordSmartMoneyTrade(trade, confidenceIndex);

    return {
      marketId: trade.marketId,
      marketName: trade.marketName,
      side: trade.side,
      amount: trade.sizeUSDC,
      price: trade.price,
      walletAddress: trade.walletAddress,
      confidenceIndex,
      severity,
      detectedAt: new Date(),
    };
  }

  // ─── Stockage TimescaleDB ──────────────────────────────────────────────────

  private async recordSmartMoneyTrade(
    trade: FilteredTrade,
    confidenceIndex: BettorConfidenceIndex,
  ): Promise<void> {
    try {
      await this.timeSeriesDB.recordSmartMoneyTrade({
        timestamp: trade.timestamp,
        marketId: trade.marketId,
        marketName: trade.marketName,
        side: trade.side,
        walletAddress: trade.walletAddress!,
        sizeUSDC: trade.sizeUSDC,
        price: trade.price,
        confidenceScore: confidenceIndex.score,
        pnl: confidenceIndex.metrics.pnl,
        recentVolume: confidenceIndex.metrics.recentVolume,
        betSizeRatio: confidenceIndex.metrics.betSizeRatio,
        winRate: confidenceIndex.metrics.winRate,
      });
    } catch (err) {
      this.logger.warn('SmartMoneyDetector: failed to record smart money trade', {
        marketId: trade.marketId,
        error: String(err),
      });
    }
  }
}

// ─── Types Internes ────────────────────────────────────────────────────────

interface PolymarketTransaction {
  hash: string;
  timestamp: number;
  value: number;
  asset: string;
}

interface AlchemyAssetTransferResponse {
  jsonrpc: string;
  id: number;
  result?: {
    transfers: Array<{
      hash?: string;
      value?: string;
      asset?: string;
      metadata?: {
        blockTimestamp?: string;
      };
    }>;
  };
  error?: {
    code: number;
    message: string;
  };
}
