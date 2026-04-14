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
import { AlertFormatter } from '../alerts/AlertFormatter';
import { TelegramNotifier } from '../notifications/TelegramNotifier';
import { RawTrade, StreamMessage } from '../types/index';

const STREAM_KEY = 'trades:stream';
const CONSUMER_GROUP = 'analyzers';
const CONSUMER_NAME = 'analyzer-1';
const STREAM_READ_COUNT = 10;
const STREAM_DEPTH_CHECK_INTERVAL_MS = 30_000;
const STREAM_DEPTH_WARN_THRESHOLD = 10_000;
const STREAM_DEPTH_ALERT_THRESHOLD = 50_000;
const MALFORMED_WINDOW_SIZE = 100;
const MALFORMED_ERROR_RATE_THRESHOLD = 0.1;
const ALCHEMY_CONSECUTIVE_FAIL_THRESHOLD = 10;
const TIMESCALEDB_UNAVAILABLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ─── Stream field deserialization ─────────────────────────────────────────────

function deserializeStreamFields(fields: Record<string, string>): RawTrade | null {
  const price = Number(fields['price'] ?? NaN);
  const sizeUsd = Number(fields['size_usd'] ?? NaN);
  const side = fields['side'];

  // Validate price: must be finite and in [0, 1]
  if (!Number.isFinite(price) || price < 0 || price > 1) {
    return null;
  }

  // Validate size_usd: must be positive and finite
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
    return null;
  }

  // Validate side: must be exactly 'YES' or 'NO'
  if (side !== 'YES' && side !== 'NO') {
    return null;
  }

  return {
    market_id: fields['market_id'] ?? '',
    market_name: fields['market_name'] ?? '',
    side: side as 'YES' | 'NO',
    price,
    size: Number(fields['size'] ?? 0),
    size_usd: sizeUsd,
    timestamp: Number(fields['timestamp'] ?? 0),
    // Addresses are optional — absent when the ingestor source did not expose them.
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
  private readonly alertFormatter: AlertFormatter;
  private telegramNotifier: TelegramNotifier | null = null;

  private running = false;
  private depthCheckTimer: ReturnType<typeof setInterval> | null = null;

  // ─── Health tracking ───────────────────────────────────────────────────────

  /** Sliding window of booleans: true = malformed, false = ok (last 100 messages) */
  private malformedWindow: boolean[] = [];
  /** Timestamp of the last malformed-rate alert, for 5-minute cooldown */
  private lastMalformedAlertAt: number = 0;
  /** Timestamp of the last stream-depth alert, for 10-minute cooldown */
  private lastDepthAlertAt: number = 0;

  /** Consecutive Alchemy failure counter (resets on success) */
  private alchemyConsecutiveFails = 0;
  private alchemyDegradedAlertSent = false;

  /** Timestamp of last successful TimescaleDB write */
  private lastSuccessfulDbWrite: number = Date.now();
  private timescaleDbAlertSent = false;

  /**
   * @param config Pre-constructed ConfigManager. When omitted, a new one is
   *   created inside start() so that env vars are only required at runtime,
   *   not at construction time — making the service unit-testable without a
   *   full environment.
   */
  constructor(config?: ConfigManager) {
    this.config = config ?? null;
    // Temporary info-level logger until config is available in start()
    this.logger = new Logger('info', undefined);
    this.alertFormatter = new AlertFormatter();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Build config and all dependent services here if not injected
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
    this.telegramNotifier = new TelegramNotifier(config.getTelegramConfig(), this.logger);

    this.logger.info('AnalyzerService starting');

    // Connect dependencies
    await this.redisCache!.connect();
    await this.redisCache!.createConsumerGroup(STREAM_KEY, CONSUMER_GROUP);
    await this.timeSeriesDB!.connect();

    // Req 11.4: test Telegram connection; exit with code 1 on failure
    const telegramOk = await this.telegramNotifier!.testConnection();
    if (!telegramOk) {
      this.logger.error('AnalyzerService: Telegram connection test failed, exiting');
      process.exit(1);
    }

    this.logger.info('AnalyzerService: all connections established');

    this.running = true;

    // Start stream depth monitor (Req 12.6, 12.7)
    this.startDepthMonitor();

    // SIGINT handler
    process.on('SIGINT', () => {
      this.stop().then(() => process.exit(0));
    });

    // Main consumer loop
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
        const depth = await this.redisCache!.getStreamDepth(STREAM_KEY);

        if (depth > STREAM_DEPTH_ALERT_THRESHOLD) {
          // Req 12.7: send Telegram alert, throttled to once per 10 minutes
          this.logger.warn('Stream depth critically high, sending Telegram alert', { depth });
          const now = Date.now();
          if (now - this.lastDepthAlertAt > 10 * 60 * 1000) {
            this.lastDepthAlertAt = now;
            await this.telegramNotifier!.sendAlert({
              text: `⚠️ Stream backlog critical: ${depth.toLocaleString()} messages pending. Consider horizontal scaling.`,
              parse_mode: 'MarkdownV2',
              disable_web_page_preview: true,
            });
          }
        } else if (depth > STREAM_DEPTH_WARN_THRESHOLD) {
          // Req 12.6: log warning
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
        // Req 12.2: XREADGROUP COUNT 10 BLOCK 100
        messages = await this.redisCache!.readFromStream(
          STREAM_KEY,
          CONSUMER_GROUP,
          CONSUMER_NAME,
          STREAM_READ_COUNT,
        );
      } catch (err) {
        this.logger.warn('AnalyzerService: readFromStream failed', { error: String(err) });
        // Brief pause before retrying to avoid tight error loop
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }

      for (const message of messages) {
        await this.processMessage(message);
      }
    }
  }

  // ─── Per-message processing ────────────────────────────────────────────────

  private async processMessage(message: StreamMessage): Promise<void> {
    const { id, fields } = message;

    try {
      // Deserialize stream fields → RawTrade
      const rawTrade = deserializeStreamFields(fields);
      if (rawTrade === null) {
        this.logger.warn('AnalyzerService: malformed stream message with invalid fields', { id });
        this.trackMalformed(true);
        await this.ackMessage(id);
        return;
      }

      // Apply TradeFilter (Req 2.2)
      const filteredTrade = this.tradeFilter!.filter(rawTrade);
      if (filteredTrade === null) {
        // Req 2.2, 12.3: filtered out — XACK and continue
        this.trackMalformed(false);
        await this.ackMessage(id);
        return;
      }

      this.trackMalformed(false);

      // Run ClusterDetector, AnomalyDetector, and SmartMoneyDetector in parallel
      const [clusterAnomaly, anomalies, smartMoneyAlert] = await Promise.all([
        this.runClusterDetector(filteredTrade),
        this.runAnomalyDetector(filteredTrade),
        this.runSmartMoneyDetector(filteredTrade),
      ]);

      // Handle cluster anomaly alert (Req 9.1, 9.2, 9.3)
      if (clusterAnomaly !== null) {
        const msg = this.alertFormatter.formatClusterMessage(clusterAnomaly);
        await this.telegramNotifier!.sendAlert(msg);
      }

      // Handle smart money alert
      if (smartMoneyAlert !== null) {
        const msg = this.alertFormatter.formatSmartMoneyMessage(smartMoneyAlert);
        await this.telegramNotifier!.sendAlert(msg);
      }

      // Handle anomaly alerts (Req 9.1, 9.2, 9.3)
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

      // Req 8.1: append price point to TimescaleDB after processing
      await this.appendPricePoint(filteredTrade.marketId, filteredTrade.price, filteredTrade.sizeUSDC, filteredTrade.timestamp);

    } catch (err) {
      this.logger.error('AnalyzerService: unhandled error processing message', err, { id });
    } finally {
      // Req 12.4: XACK every message — even on processing error — to prevent infinite redelivery
      await this.ackMessage(id);
    }
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
      // Req 16.6: only reset the consecutive-fail counter when Alchemy actually
      // succeeded — not when analyze() silently fell back to Moralis/static.
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
          text: 'Alchemy API degraded — insider detection using fallback',
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        }).catch(() => {/* non-blocking */});
      }
      return anomalies;
    } catch (err) {
      this.logger.warn('AnalyzerService: anomalyDetector.analyze threw', { error: String(err) });
      // Req 16.6: track consecutive Alchemy failures
      this.alchemyConsecutiveFails++;
      if (
        this.alchemyConsecutiveFails > ALCHEMY_CONSECUTIVE_FAIL_THRESHOLD &&
        !this.alchemyDegradedAlertSent
      ) {
        this.alchemyDegradedAlertSent = true;
        this.logger.warn('Alchemy API degraded — insider detection using fallback', {
          consecutiveFails: this.alchemyConsecutiveFails,
        });
        await this.telegramNotifier!.sendAlert({
          text: 'Alchemy API degraded — insider detection using fallback',
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
      // Req 16.7: reset unavailability tracking on success
      this.lastSuccessfulDbWrite = Date.now();
      this.timescaleDbAlertSent = false;
    } catch (err) {
      this.logger.warn('AnalyzerService: appendPricePoint failed', { marketId, error: String(err) });
      // Req 16.7: check if DB has been unavailable > 5 minutes
      const unavailableMs = Date.now() - this.lastSuccessfulDbWrite;
      if (unavailableMs > TIMESCALEDB_UNAVAILABLE_THRESHOLD_MS && !this.timescaleDbAlertSent) {
        this.timescaleDbAlertSent = true;
        this.logger.warn('TimescaleDB unavailable — Z-score detection using static thresholds', {
          unavailableMs,
        });
        await this.telegramNotifier!.sendAlert({
          text: 'TimescaleDB unavailable — Z-score detection using static thresholds',
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        }).catch(() => {/* non-blocking */});
      }
    }
  }

  // ─── Malformed trade tracking (Req 16.5) ──────────────────────────────────

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
          // Send Telegram notification (Req 16.5) — fire-and-forget
          this.telegramNotifier!.sendAlert({
            text: `⚠️ Malformed trade error rate: ${(errorRate * 100).toFixed(1)}% of last ${MALFORMED_WINDOW_SIZE} messages`,
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

main().catch((err) => {
  console.error('Fatal error in analyzer:', err);
  process.exit(1);
});
