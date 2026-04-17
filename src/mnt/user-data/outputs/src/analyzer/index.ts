import * as dotenv from 'dotenv';
dotenv.config();

import { ConfigManager } from '../config/ConfigManager';
import { Logger } from '../utils/Logger';
import { RedisCache } from '../cache/RedisCache';
import { TimeSeriesDB } from '../db/TimeSeriesDB';
import { TradeFilter } from '../filters/TradeFilter';
import { BlockchainAnalyzer } from '../blockchain/BlockchainAnalyzer';
import { PolymarketAPI } from '../blockchain/PolymarketAPI';
import { AnomalyDetector } from '../detectors/AnomalyDetector';
import { ClusterDetector } from '../detectors/ClusterDetector';
import { SmartMoneyDetector } from '../detectors/SmartMoneyDetector';
import { AccumulationDetector } from '../detectors/AccumulationDetector';
import { WalletHistoryFetcher } from '../ingestor/WalletHistoryFetcher';
import { AlertFormatter } from '../alerts/AlertFormatter';
import { TelegramNotifier } from '../notifications/TelegramNotifier';
import { RawTrade, StreamMessage } from '../types/index';

const STREAM_KEY = 'trades:stream';
const CONSUMER_GROUP = 'analyzers';
const CONSUMER_NAME = 'analyzer-1';
const STREAM_READ_COUNT = 100;
const STREAM_DEPTH_CHECK_INTERVAL_MS = 30_000;
const STREAM_DEPTH_WARN_THRESHOLD = 10_000;
const STREAM_DEPTH_ALERT_THRESHOLD = 50_000;
const MALFORMED_WINDOW_SIZE = 100;
const MALFORMED_ERROR_RATE_THRESHOLD = 0.1;
const ALCHEMY_CONSECUTIVE_FAIL_THRESHOLD = 10;
const TIMESCALEDB_UNAVAILABLE_THRESHOLD_MS = 5 * 60 * 1000;

// ─── Stream field deserialization ─────────────────────────────────────────────

function deserializeStreamFields(fields: Record<string, string>): RawTrade | null {
  const price = Number(fields['price'] ?? NaN);
  const sizeUsd = Number(fields['size_usd'] ?? NaN);
  const rawSide = fields['side'];

  if (!Number.isFinite(price) || price < 0 || price > 1) return null;
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return null;

  let side: 'YES' | 'NO';
  if (rawSide === 'YES' || rawSide === 'BUY') {
    side = 'YES';
  } else if (rawSide === 'NO' || rawSide === 'SELL') {
    side = 'NO';
  } else {
    return null;
  }

  return {
    market_id: fields['market_id'] ?? '',
    market_name: fields['market_name'] ?? '',
    outcome: fields['outcome'] || undefined,
    side,
    price,
    size: Number(fields['size'] ?? 0),
    size_usd: sizeUsd,
    timestamp: Number(fields['timestamp'] ?? 0),
    maker_address: fields['maker_address'] !== undefined ? fields['maker_address'] : undefined,
    taker_address: fields['taker_address'] !== undefined ? fields['taker_address'] : undefined,
    order_book_depth: {
      bid_liquidity: Number(fields['bid_liquidity'] ?? 0),
      ask_liquidity: Number(fields['ask_liquidity'] ?? 0),
    },
    market_category: fields['market_category'] || undefined,
  };
}

// ─── AnalyzerService ──────────────────────────────────────────────────────────

export class AnalyzerService {
  private config: ConfigManager | null;
  private logger: Logger;
  private redisCache: RedisCache | null = null;
  private timeSeriesDB: TimeSeriesDB | null = null;
  private tradeFilter: TradeFilter | null = null;
  private blockchainAnalyzer: BlockchainAnalyzer | null = null;
  private polymarketAPI: PolymarketAPI | null = null;
  private anomalyDetector: AnomalyDetector | null = null;
  private clusterDetector: ClusterDetector | null = null;
  private smartMoneyDetector: SmartMoneyDetector | null = null;
  private accumulationDetector: AccumulationDetector | null = null;
  private readonly alertFormatter: AlertFormatter;
  private telegramNotifier: TelegramNotifier | null = null;

  private running = false;
  private depthCheckTimer: ReturnType<typeof setInterval> | null = null;

  private malformedWindow: boolean[] = [];
  private lastMalformedAlertAt: number = 0;
  private lastDepthAlertAt: number = 0;

  private alchemyConsecutiveFails = 0;
  private alchemyDegradedAlertSent = false;

  private lastSuccessfulDbWrite: number = Date.now();
  private timescaleDbAlertSent = false;

  constructor(config?: ConfigManager) {
    this.config = config ?? null;
    this.logger = new Logger('info', undefined);
    this.alertFormatter = new AlertFormatter();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.config) {
      this.config = new ConfigManager();
    }
    const config = this.config;

    this.logger = new Logger(config.getLogLevel(), config.getLogFilePath());
    const thresholds = config.getThresholds();

    this.redisCache = new RedisCache(config.getRedisUrl(), this.logger);
    this.timeSeriesDB = new TimeSeriesDB(config.getTimescaleDbUrl(), this.logger);
    this.tradeFilter = new TradeFilter(thresholds.minTradeSizeUSDC);
    this.blockchainAnalyzer = new BlockchainAnalyzer(
      config.getAlchemyApiKey(),
      config.getMoralisApiKey() ?? '',
      config.getKnownExchangeWallets(),
      this.logger,
    );
    this.polymarketAPI = new PolymarketAPI(this.logger);
    this.anomalyDetector = new AnomalyDetector(
      thresholds,
      this.timeSeriesDB,
      this.redisCache,
      this.blockchainAnalyzer,
      this.polymarketAPI,
      this.logger,
    );
    this.clusterDetector = new ClusterDetector(
      thresholds,
      this.timeSeriesDB,
      this.redisCache,
      this.blockchainAnalyzer,
      this.logger,
      config.getClusterDedupTtl(),
    );
    this.smartMoneyDetector = new SmartMoneyDetector(
      {
        minTradeSizeUSDC: config.getSmartMoneyMinTradeSize(),
        confidenceThreshold: config.getSmartMoneyConfidenceThreshold(),
        walletProfileTTL: config.getSmartMoneyWalletCacheTTL(),
      },
      this.timeSeriesDB,
      this.redisCache,
      this.blockchainAnalyzer,
      this.logger,
    );

    // AccumulationDetector: needs WalletHistoryFetcher for wallet context enrichment
    const walletHistoryFetcher = new WalletHistoryFetcher(this.redisCache, this.logger);
    const accWindowMs = Number(process.env['POSITION_ACCUMULATION_WINDOW_MS'] ?? 4 * 60 * 60 * 1000);
    this.accumulationDetector = new AccumulationDetector(
      walletHistoryFetcher,
      this.redisCache,
      this.logger,
      accWindowMs,
    );

    this.telegramNotifier = new TelegramNotifier(config.getTelegramConfig(), this.logger);

    this.logger.info('AnalyzerService starting');

    await this.alertFormatter.init(this.logger);

    await this.redisCache!.connect();
    await this.redisCache!.createConsumerGroup(STREAM_KEY, CONSUMER_GROUP);
    await this.timeSeriesDB!.connect();

    const telegramOk = await this.telegramNotifier!.testConnection();
    if (!telegramOk) {
      this.logger.error('AnalyzerService: Telegram connection test failed, exiting');
      process.exit(1);
    }

    this.logger.info('AnalyzerService: all connections established');

    this.running = true;
    this.startDepthMonitor();

    process.on('SIGINT', () => {
      this.stop().then(() => process.exit(0));
    });

    await this.consumeLoop();
  }

  async stop(): Promise<void> {
    this.logger.info('AnalyzerService stopping');
    this.running = false;

    if (this.depthCheckTimer !== null) {
      clearInterval(this.depthCheckTimer);
      this.depthCheckTimer = null;
    }

    await this.redisCache?.disconnect();
    await this.timeSeriesDB?.disconnect();
    this.logger.info('AnalyzerService stopped');
  }

  // ─── Stream depth monitor ──────────────────────────────────────────────────

  private startDepthMonitor(): void {
    this.depthCheckTimer = setInterval(async () => {
      try {
        const depth = await this.redisCache!.getStreamDepth(STREAM_KEY, CONSUMER_GROUP);

        if (depth > STREAM_DEPTH_ALERT_THRESHOLD) {
          this.logger.warn('Stream depth critically high, sending Telegram alert', { depth });
          const now = Date.now();
          if (now - this.lastDepthAlertAt > 10 * 60 * 1000) {
            this.lastDepthAlertAt = now;
            await this.telegramNotifier!.sendAlert({
              text: `⚠️ File d'attente critique : ${depth.toLocaleString()} messages en attente\\. Envisagez une mise à l'échelle horizontale\\.`,
              parse_mode: 'MarkdownV2',
              disable_web_page_preview: true,
            });
          }
        } else if (depth > STREAM_DEPTH_WARN_THRESHOLD) {
          this.logger.warn('Stream depth exceeds warning threshold', { depth });
        }
      } catch (err) {
        this.logger.warn('AnalyzerService: stream depth check failed', { error: String(err) });
      }
    }, STREAM_DEPTH_CHECK_INTERVAL_MS);
  }

  // ─── Main consumer loop ────────────────────────────────────────────────────

  private async consumeLoop(): Promise<void> {
    this.logger.info('AnalyzerService: starting consumer loop');

    while (this.running) {
      let messages: StreamMessage[] = [];

      try {
        messages = await this.redisCache!.readFromStream(
          STREAM_KEY,
          CONSUMER_GROUP,
          CONSUMER_NAME,
          STREAM_READ_COUNT,
        );
      } catch (err) {
        this.logger.warn('AnalyzerService: readFromStream failed', { error: String(err) });
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }

      await Promise.all(messages.map(async (message) => {
        try {
          await this.processMessage(message);
        } catch (err) {
          this.logger.error('AnalyzerService: processMessage panicked — ACKing to prevent redelivery', err, { id: message.id });
          await this.ackMessage(message.id);
        }
      }));
    }
  }

  // ─── Per-message processing ────────────────────────────────────────────────

  private async processMessage(message: StreamMessage): Promise<void> {
    const { id, fields } = message;

    try {
      const rawTrade = deserializeStreamFields(fields);
      if (rawTrade === null) {
        this.logger.warn('AnalyzerService: malformed stream message with invalid fields', { id });
        this.trackMalformed(true);
        await this.ackMessage(id);
        return;
      }

      // ── Accumulation trades bypass the normal filter & detectors ──────────
      // They were already threshold-checked in PositionTracker; running them
      // through TradeFilter would re-apply the min-size check (which uses the
      // taker min size, not the accumulation threshold), so we short-circuit.
      if (rawTrade.market_category === 'accumulation') {
        await this._handleAccumulationTrade(rawTrade);
        this.trackMalformed(false);
        await this.ackMessage(id);
        return;
      }

      const filteredTrade = this.tradeFilter!.filter(rawTrade);
      if (filteredTrade === null) {
        this.trackMalformed(false);
        await this.ackMessage(id);
        return;
      }

      this.trackMalformed(false);

      // MEGA TRADE ALERT
      const MEGA_TRADE_THRESHOLD = 30000;
      if (filteredTrade.sizeUSDC >= MEGA_TRADE_THRESHOLD) {
        const alreadySent = await this.redisCache!.hasAlertBeenSent(
          'MEGA_TRADE',
          filteredTrade.marketId,
          filteredTrade.walletAddress || '',
        );
        if (!alreadySent) {
          const msg = this.alertFormatter.formatMegaTradeAlert(filteredTrade);
          await this.telegramNotifier!.sendAlert(msg);
          await this.redisCache!.recordSentAlert(
            'MEGA_TRADE',
            filteredTrade.marketId,
            filteredTrade.walletAddress || '',
            this.config!.getAlertDedupTtl(),
          );
        }
      }

      const [clusterAnomaly, anomalies, smartMoneyAlert] = await Promise.all([
        this.runClusterDetector(filteredTrade),
        this.runAnomalyDetector(filteredTrade),
        this.runSmartMoneyDetector(filteredTrade),
      ]);

      if (clusterAnomaly !== null) {
        const msg = this.alertFormatter.formatClusterMessage(clusterAnomaly);
        await this.telegramNotifier!.sendAlert(msg);
      }

      if (smartMoneyAlert !== null) {
        const msg = this.alertFormatter.formatSmartMoneyMessage(smartMoneyAlert);
        await this.telegramNotifier!.sendAlert(msg);
      }

      for (const anomaly of anomalies) {
        const alreadySent = await this.redisCache!.hasAlertBeenSent(
          anomaly.type,
          filteredTrade.marketId,
          filteredTrade.walletAddress || '',
        );
        if (!alreadySent) {
          const msg = this.alertFormatter.format(anomaly, filteredTrade);
          await this.telegramNotifier!.sendAlert(msg);
          await this.redisCache!.recordSentAlert(
            anomaly.type,
            filteredTrade.marketId,
            filteredTrade.walletAddress || '',
            this.config!.getAlertDedupTtl(),
          );
        }
      }

      await this.appendPricePoint(filteredTrade.marketId, filteredTrade.price, filteredTrade.sizeUSDC, filteredTrade.timestamp);

    } catch (err) {
      this.logger.error('AnalyzerService: unhandled error processing message', err, { id });
    } finally {
      await this.ackMessage(id);
    }
  }

  // ─── Accumulation trade handler ────────────────────────────────────────────

  private async _handleAccumulationTrade(rawTrade: RawTrade): Promise<void> {
    if (!rawTrade.taker_address) return;

    // Build a minimal FilteredTrade for the detectors
    const filteredTrade = {
      marketId: rawTrade.market_id,
      marketName: rawTrade.market_name,
      side: rawTrade.side,
      price: rawTrade.price,
      sizeUSDC: rawTrade.size_usd,
      timestamp: new Date(rawTrade.timestamp),
      walletAddress: rawTrade.taker_address,
      orderBookLiquidity: 0,
      marketCategory: rawTrade.market_category,
    };

    const accumAnomaly = await this.accumulationDetector!.detect(filteredTrade).catch(err => {
      this.logger.warn('AccumulationDetector threw', { error: String(err) });
      return null;
    });

    if (!accumAnomaly) return;

    const dedupKey = `ACCUMULATION:${filteredTrade.marketId}:${filteredTrade.walletAddress}`;
    const alreadySent = await this.redisCache!.hasAlertBeenSent(
      'ACCUMULATION',
      filteredTrade.marketId,
      filteredTrade.walletAddress,
    );

    if (!alreadySent) {
      const msg = this.alertFormatter.formatAccumulationMessage(accumAnomaly, filteredTrade);
      await this.telegramNotifier!.sendAlert(msg);
      // Dedup for 4 hours (matches accumulation window)
      const dedupTtl = Number(process.env['POSITION_ACCUMULATION_WINDOW_MS'] ?? 4 * 60 * 60 * 1000) / 1000;
      await this.redisCache!.recordSentAlert(
        'ACCUMULATION',
        filteredTrade.marketId,
        filteredTrade.walletAddress,
        dedupTtl,
      );
      this.logger.info('AnalyzerService: accumulation alert sent', {
        marketId: filteredTrade.marketId,
        wallet: filteredTrade.walletAddress.slice(0, 10),
      });
    }
    void dedupKey;  // suppress unused-variable warning
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async ackMessage(id: string): Promise<void> {
    try {
      await this.redisCache!.acknowledgeMessage(STREAM_KEY, CONSUMER_GROUP, id);
    } catch (err) {
      this.logger.warn('AnalyzerService: failed to XACK message', { id, error: String(err) });
    }
  }

  private async runAnomalyDetector(filteredTrade: Parameters<AnomalyDetector['analyze']>[0]) {
    try {
      const anomalies = await this.anomalyDetector!.analyze(filteredTrade);
      if (this.blockchainAnalyzer!.lastCallUsedFallback) {
        this.alchemyConsecutiveFails++;
      } else {
        this.alchemyConsecutiveFails = 0;
        this.alchemyDegradedAlertSent = false;
      }
      if (
        this.alchemyConsecutiveFails > ALCHEMY_CONSECUTIVE_FAIL_THRESHOLD &&
        !this.alchemyDegradedAlertSent
      ) {
        this.alchemyDegradedAlertSent = true;
        this.logger.warn('Alchemy API degraded — insider detection using fallback', {
          consecutiveFails: this.alchemyConsecutiveFails,
        });
        await this.telegramNotifier!.sendAlert({
          text: 'API Alchemy dégradée — détection initié utilisant le fallback',
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        }).catch(() => {/* non-blocking */});
      }
      return anomalies;
    } catch (err) {
      this.logger.warn('AnalyzerService: anomalyDetector.analyze threw (Alchemy failure)', { error: String(err) });
      this.alchemyConsecutiveFails++;
      if (
        this.alchemyConsecutiveFails > ALCHEMY_CONSECUTIVE_FAIL_THRESHOLD &&
        !this.alchemyDegradedAlertSent
      ) {
        this.alchemyDegradedAlertSent = true;
        await this.telegramNotifier!.sendAlert({
          text: 'API Alchemy dégradée — détection initié utilisant le fallback',
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        }).catch(() => {/* non-blocking */});
      }
      return [];
    }
  }

  private async runClusterDetector(filteredTrade: Parameters<ClusterDetector['detectCluster']>[0]) {
    try {
      return await this.clusterDetector!.detectCluster(filteredTrade);
    } catch (err) {
      this.logger.warn('AnalyzerService: clusterDetector.detectCluster threw', { error: String(err) });
      return null;
    }
  }

  private async runSmartMoneyDetector(filteredTrade: Parameters<SmartMoneyDetector['detect']>[0]) {
    try {
      return await this.smartMoneyDetector!.detect(filteredTrade);
    } catch (err) {
      this.logger.warn('AnalyzerService: smartMoneyDetector.detect threw', { error: String(err) });
      return null;
    }
  }

  private async appendPricePoint(marketId: string, price: number, sizeUsd: number, timestamp: Date): Promise<void> {
    try {
      await this.timeSeriesDB!.appendPricePoint(marketId, price, sizeUsd, timestamp);
      this.lastSuccessfulDbWrite = Date.now();
      this.timescaleDbAlertSent = false;
    } catch (err) {
      this.logger.warn('AnalyzerService: appendPricePoint failed', { marketId, error: String(err) });
      const unavailableMs = Date.now() - this.lastSuccessfulDbWrite;
      if (unavailableMs > TIMESCALEDB_UNAVAILABLE_THRESHOLD_MS && !this.timescaleDbAlertSent) {
        this.timescaleDbAlertSent = true;
        this.logger.warn('TimescaleDB unavailable — Z-score detection using static thresholds', { unavailableMs });
        await this.telegramNotifier!.sendAlert({
          text: 'TimescaleDB indisponible — détection Z\\-score utilisant les seuils statiques',
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        }).catch(() => {/* non-blocking */});
      }
    }
  }

  // ─── Malformed trade tracking ──────────────────────────────────────────────

  private trackMalformed(isMalformed: boolean): void {
    this.malformedWindow.push(isMalformed);
    if (this.malformedWindow.length > MALFORMED_WINDOW_SIZE) {
      this.malformedWindow.shift();
    }

    if (this.malformedWindow.length >= MALFORMED_WINDOW_SIZE) {
      const errorCount = this.malformedWindow.filter(Boolean).length;
      const errorRate = errorCount / this.malformedWindow.length;

      if (errorRate > MALFORMED_ERROR_RATE_THRESHOLD) {
        const now = Date.now();
        if (now - this.lastMalformedAlertAt >= 5 * 60 * 1000) {
          this.lastMalformedAlertAt = now;
          this.logger.warn('Malformed trade error rate exceeds 10%', {
            errorRate: (errorRate * 100).toFixed(1) + '%',
            errorCount,
            windowSize: this.malformedWindow.length,
          });
          this.telegramNotifier!.sendAlert({
            text: `⚠️ Taux d'erreur trades malformés : ${(errorRate * 100).toFixed(1)}% des ${MALFORMED_WINDOW_SIZE} derniers messages`,
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: true,
          }).catch(() => {/* non-blocking */});
        }
      }
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default async function main(): Promise<void> {
  const service = new AnalyzerService();
  await service.start();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error in analyzer:', err);
    process.exit(1);
  });
}
