"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimeSeriesDB = void 0;
const pg_1 = require("pg");
const INIT_SQL = `
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS price_history (
  time        TIMESTAMPTZ NOT NULL,
  market_id   TEXT NOT NULL,
  price       DOUBLE PRECISION NOT NULL
);
SELECT create_hypertable('price_history', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_price_history_market ON price_history(market_id, time DESC);

CREATE TABLE IF NOT EXISTS cluster_trades (
  time            TIMESTAMPTZ NOT NULL,
  market_id       TEXT NOT NULL,
  side            TEXT NOT NULL,
  wallet_address  TEXT NOT NULL,
  size_usd        DOUBLE PRECISION NOT NULL
);
SELECT create_hypertable('cluster_trades', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_cluster_trades_market_side ON cluster_trades(market_id, side, time DESC);

CREATE MATERIALIZED VIEW IF NOT EXISTS market_volatility_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS bucket,
  market_id,
  AVG(price) AS avg_price,
  STDDEV(price) AS stddev_price,
  COUNT(*) AS trade_count
FROM price_history
GROUP BY bucket, market_id;
`;
class TimeSeriesDB {
    constructor(connectionString, logger) {
        this.pool = null;
        this.connectionString = connectionString;
        this.logger = logger;
    }
    async connect() {
        this.pool = new pg_1.Pool({ connectionString: this.connectionString });
        await this.initSchema();
    }
    async disconnect() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
        }
    }
    async initSchema() {
        if (!this.pool)
            return;
        let client = null;
        try {
            client = await this.pool.connect();
            // Run each statement individually — CREATE EXTENSION and SELECT
            // create_hypertable cannot run inside a multi-statement transaction block
            // together with DDL on some TimescaleDB versions, so we execute them
            // sequentially outside a transaction.
            const statements = INIT_SQL
                .split(';')
                .map(s => s.trim())
                .filter(s => s.length > 0);
            for (const stmt of statements) {
                await client.query(stmt);
            }
            this.logger.info('TimeSeriesDB schema initialised');
        }
        catch (err) {
            this.logger.error('TimeSeriesDB initSchema failed', err);
        }
        finally {
            client?.release();
        }
    }
    // ─── Price History ────────────────────────────────────────────────────────
    async appendPricePoint(marketId, price, timestamp) {
        if (!this.pool)
            return;
        try {
            await this.pool.query('INSERT INTO price_history (time, market_id, price) VALUES ($1, $2, $3)', [timestamp, marketId, price]);
        }
        catch (err) {
            this.logger.error('appendPricePoint failed', err, { marketId });
        }
    }
    async getPriceHistory(marketId, since) {
        if (!this.pool)
            return [];
        try {
            const result = await this.pool.query('SELECT time, market_id, price FROM price_history WHERE market_id = $1 AND time >= $2 ORDER BY time ASC', [marketId, since]);
            return result.rows.map(row => ({
                marketId: row.market_id,
                price: row.price,
                timestamp: row.time,
            }));
        }
        catch (err) {
            this.logger.error('getPriceHistory failed', err, { marketId });
            return [];
        }
    }
    // ─── Market Volatility ────────────────────────────────────────────────────
    async getMarketVolatility(marketId, _windowMinutes) {
        const zero = {
            marketId,
            avgPriceChange: 0,
            stddevPriceChange: 0,
            avgTradeSize: 0,
            stddevTradeSize: 0,
            sampleCount: 0,
            lastUpdated: new Date(),
        };
        if (!this.pool)
            return zero;
        try {
            const result = await this.pool.query(`SELECT avg_price, stddev_price, trade_count
         FROM market_volatility_1h
         WHERE market_id = $1
         ORDER BY bucket DESC
         LIMIT 1`, [marketId]);
            if (result.rows.length === 0)
                return zero;
            const row = result.rows[0];
            return {
                marketId,
                avgPriceChange: parseFloat(row.avg_price) || 0,
                stddevPriceChange: row.stddev_price !== null ? parseFloat(row.stddev_price) : 0,
                avgTradeSize: 0,
                stddevTradeSize: 0,
                sampleCount: parseInt(row.trade_count, 10) || 0,
                lastUpdated: new Date(),
            };
        }
        catch (err) {
            this.logger.error('getMarketVolatility failed', err, { marketId });
            return zero;
        }
    }
    // ─── Cluster Trades ───────────────────────────────────────────────────────
    async recordClusterTrade(trade) {
        if (!this.pool)
            return;
        try {
            await this.pool.query('INSERT INTO cluster_trades (time, market_id, side, wallet_address, size_usd) VALUES ($1, $2, $3, $4, $5)', [trade.timestamp, trade.marketId, trade.side, trade.walletAddress, trade.sizeUSDC]);
        }
        catch (err) {
            this.logger.error('recordClusterTrade failed', err, { marketId: trade.marketId });
        }
    }
    async getClusterWallets(marketId, side, since) {
        if (!this.pool)
            return [];
        try {
            const result = await this.pool.query(`SELECT DISTINCT wallet_address
         FROM cluster_trades
         WHERE market_id = $1 AND side = $2 AND time >= $3`, [marketId, side, since]);
            return result.rows.map(row => row.wallet_address);
        }
        catch (err) {
            this.logger.error('getClusterWallets failed', err, { marketId, side });
            return [];
        }
    }
    async getClusterTotalSize(marketId, side, since) {
        if (!this.pool)
            return 0;
        try {
            const result = await this.pool.query(`SELECT SUM(size_usd) AS total
         FROM cluster_trades
         WHERE market_id = $1 AND side = $2 AND time >= $3`, [marketId, side, since]);
            const total = result.rows[0]?.total;
            return total !== null && total !== undefined ? parseFloat(total) : 0;
        }
        catch (err) {
            this.logger.error('getClusterTotalSize failed', err, { marketId, side });
            return 0;
        }
    }
}
exports.TimeSeriesDB = TimeSeriesDB;
//# sourceMappingURL=TimeSeriesDB.js.map