import * as dotenv from 'dotenv';
dotenv.config();

import { ConfigManager } from '../config/ConfigManager';
import { Logger } from '../utils/Logger';
import { RedisCache } from '../cache/RedisCache';
import { TimeSeriesDB } from '../db/TimeSeriesDB';
import { TradeFilter } from '../filters/TradeFilter';
import { BlockchainAnalyzer } from '../blockchain/BlockchainAnalyzer';
import { AnomalyDetector } from '../detectors/AnomalyDetector';
import { ClusterDetector } from '../detectors/ClusterDetector';
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

function deserializeStreamFields(fields: Record<string, string>): RawTrade {
  return {
    market_id: fields['market_id'] ?? '',
    market_name: fields['market_name'] ?? '',
    side: (fields['side'] as 'YES' | 'NO') ?? 'YES',
    price: Number(fields['price'] ?? 0),
    size: Number(fields['size_usd'] ?? 0),
    size_usd: Number(fields['size_usd'] ?? 0),
    timestamp: Number(fields['timestamp'] ?? 0),
    maker_address: fields['maker_address'] ?? '',
    taker_address: fields['taker_address'] ?? '',
    order_book_depth: {
      bid_liquidity: Number(fields['bid_liquidity'] ?? 0),
      ask_liquidity: Number(fields['ask_liquidity'] ?? 0),
    },
  };
}

// ─── AnalyzerService ──────────────────────────────────────────────────────────

export class AnalyzerService {
  private readonly config: ConfigManager;
  private readonly logger: Logger;
  private readonly redisCache: RedisCache;
  private readonly timeSeriesDB: TimeSeriesDB;
  private readonly tradeFilter: TradeFilter;
  private readonly blockchainAnalyzer: BlockchainAnalyzer;
  private readonly anomalyDetector: AnomalyDetector;
  private readonly clusterDetector: ClusterDetector;
  private readonly alertFormatter: AlertFormatter;
  private readonly telegramNotifier: TelegramNotifier;

  private running = false;
  private depthCheckTimer: ReturnType<typeof setInterval> | null = null;

  // ─── Health tracking ───────────────────────────────────────────────────────

  /** Sliding window of booleans: true = malformed, false = ok (last 100 messages) */
  private malformedWindow: boolean[] = [];

  /** Consecutive Alchemy failure counter (resets on success) */
  private alchemyConsecutiveFails = 0;
  private alchemyDegradedAlertSent = false;

  /** Timestamp of last successful TimescaleDB write */
  private lastSuccessfulDbWrite: number = Date.now();
  private timescaleDbAlertSent = false;

  constructor() {
    this.config = new ConfigManager();
    this.logger = new Logger(this.config.getLogLevel(), this.config.getLogFilePath());

    const thresholds = this.config.getThresholds();

    this.redisCache = new RedisCache(this.config.getRedisUrl(), this.logger);
    this.timeSeriesDB = new TimeSeriesDB(this.config.getTimescaleDbUrl(), this.logger);
    this.tradeFilter = new TradeFilter(thresholds.minTradeSizeUSDC);
    this.blockchainAnalyzer = new BlockchainAnalyzer(
      this.config.getAlchemyApiKey(),
      this.config.getMoralisApiKey() ?? '',
      this.config.getKnownExchangeWallets(),
      this.logger,
    );
    this.anomalyDetector = new AnomalyDetector(
      thresholds,
      this.timeSeriesDB,
      this.redisCache,
      this.blockchainAnalyzer,
      this.logger,
    );
    this.clusterDetector = new ClusterDetector(
      thresholds,
      this.timeSeriesDB,
      this.redisCache,
      this.blockchainAnalyzer,
      this.logger,
      this.config.getClusterDedupTtl(),
    );
    this.alertFormatter = new AlertFormatter();
    this.telegramNotifier = new TelegramNotifier(this.config.getTelegramConfig(), this.logger);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.logger.info('AnalyzerService starting');

    // Connect dependencies
    await this.redisCache.connect();
    await this.timeSeriesDB.connect();

    // Req 11.4: test Telegram connection; exit with code 1 on failure
    const telegramOk = await this.telegramNotifier.testConnection();
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

    await this.redisCache.disconnect();
    await this.timeSeriesDB.disconnect();
    this.logger.info('AnalyzerService stopped');
  }

  // ─── Stream depth monitor ──────────────────────────────────────────────────

  private startDepthMonitor(): void {
    this.depthCheckTimer = setInterval(async () => {
      try {
        const depth = await this.redisCache.getStreamDepth(STREAM_KEY);

        if (depth > STREAM_DEPTH_ALERT_THRESHOLD) {
          // Req 12.7: send Telegram alert
          this.logger.warn('Stream depth critically high, sending Telegram alert', { depth });
          await this.telegramNotifier.sendAlert({
            text: `⚠️ Stream backlog critical: ${depth.toLocaleString()} messages pending. Consider horizontal scaling.`,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
          });
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
        messages = await this.redisCache.readFromStream(
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
      let rawTrade: RawTrade;
      try {
        rawTrade = deserializeStreamFields(fields);
      } catch (err) {
        this.logger.warn('AnalyzerService: failed to deserialize stream message', {
          id,
          error: String(err),
        });
        this.trackMalformed(true);
        await this.ackMessage(id);
        return;
      }

      // Apply TradeFilter (Req 2.2)
      const filteredTrade = this.tradeFilter.filter(rawTrade);
      if (filteredTrade === null) {
        // Req 2.2, 12.3: filtered out — XACK and continue
        this.trackMalformed(false);
        await this.ackMessage(id);
        return;
      }

      this.trackMalformed(false);

      // Run ClusterDetector and AnomalyDetector in parallel
      const [clusterAnomaly, anomalies] = await Promise.all([
        this.runClusterDetector(filteredTrade),
        this.runAnomalyDetector(filteredTrade),
      ]);

      // Handle cluster anomaly alert (Req 9.1, 9.2, 9.3)
      if (clusterAnomaly !== null) {
        const msg = this.alertFormatter.formatClusterMessage(clusterAnomaly);
        await this.telegramNotifier.sendAlert(msg);
      }

      // Handle anomaly alerts (Req 9.1, 9.2, 9.3)
      for (const anomaly of anomalies) {
        const alreadySent = await this.redisCache.hasAlertBeenSent(
          anomaly.type,
          filteredTrade.marketId,
          filteredTrade.walletAddress,
        );
        if (!alreadySent) {
          const msg = this.alertFormatter.format(anomaly, filteredTrade);
          await this.telegramNotifier.sendAlert(msg);
          await this.redisCache.recordSentAlert(
            anomaly.type,
            filteredTrade.marketId,
            filteredTrade.walletAddress,
            this.config.getAlertDedupTtl(),
          );
        }
      }

      // Req 8.1: append price point to TimescaleDB after processing
      await this.appendPricePoint(filteredTrade.marketId, filteredTrade.price, filteredTrade.timestamp);

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
      await this.redisCache.acknowledgeMessage(STREAM_KEY, CONSUMER_GROUP, id);
    } catch (err) {
      this.logger.warn('AnalyzerService: failed to XACK message', { id, error: String(err) });
    }
  }

  private async runAnomalyDetector(filteredTrade: Parameters<AnomalyDetector['analyze']>[0]) {
    try {
      const anomalies = await this.anomalyDetector.analyze(filteredTrade);
      // Reset consecutive Alchemy fail counter on success (Req 16.6)
      this.alchemyConsecutiveFails = 0;
      this.alchemyDegradedAlertSent = false;
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
        await this.telegramNotifier.sendAlert({
          text: 'Alchemy API degraded — insider detection using fallback',
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }).catch(() => {/* non-blocking */});
      }
      return [];
    }
  }

  private async runClusterDetector(filteredTrade: Parameters<ClusterDetector['detectCluster']>[0]) {
    try {
      return await this.clusterDetector.detectCluster(filteredTrade);
    } catch (err) {
      this.logger.warn('AnalyzerService: clusterDetector.detectCluster threw', { error: String(err) });
      return null;
    }
  }

  private async appendPricePoint(marketId: string, price: number, timestamp: Date): Promise<void> {
    try {
      await this.timeSeriesDB.appendPricePoint(marketId, price, timestamp);
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
        await this.telegramNotifier.sendAlert({
          text: 'TimescaleDB unavailable — Z-score detection using static thresholds',
          parse_mode: 'Markdown',
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
        this.logger.warn('Malformed trade error rate exceeds 10%', {
          errorRate: (errorRate * 100).toFixed(1) + '%',
          errorCount,
          windowSize: this.malformedWindow.length,
        });
        // Send Telegram notification (Req 16.5) — fire-and-forget
        this.telegramNotifier.sendAlert({
          text: `⚠️ Malformed trade error rate: ${(errorRate * 100).toFixed(1)}% of last ${MALFORMED_WINDOW_SIZE} messages`,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }).catch(() => {/* non-blocking */});
        // Reset window to avoid repeated alerts on every message
        this.malformedWindow = [];
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
