/**
 * test-position-tracker.js
 *
 * Runs PositionTracker for 2 minutes against the real Polymarket Data API
 * and prints any accumulation events to the console.
 *
 * Usage:  node test-position-tracker.js
 *
 * No Redis or TimescaleDB needed — purely tests the polling + detection logic.
 */

const https = require('https');

// ─── Minimal inline replica of PositionTracker ────────────────────────────────
// (so we don't need to compile TypeScript to run this test)

const ACCUMULATION_THRESHOLD_USDC = 5_000;   // low threshold for testing
const ACCUMULATION_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const TOP_MARKETS = 10;
const MIN_TRADE_SIZE_USDC = 100;

const marketCursors = new Map();
const buckets = new Map();
let topMarkets = [];

function fetchJSON(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: 'GET', headers: { Accept: 'application/json' }, timeout: 8_000 };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function refreshTopMarkets() {
  const path = `/markets?active=true&closed=false&limit=${TOP_MARKETS}&order=volume24hr&ascending=false`;
  const markets = await fetchJSON('gamma-api.polymarket.com', path);
  if (!Array.isArray(markets)) return;
  topMarkets = markets.map(m => ({
    conditionId: m.conditionId ?? m.condition_id ?? '',
    slug: m.slug ?? m.conditionId ?? '',
    title: m.question ?? m.title ?? m.slug ?? '',
  })).filter(m => m.conditionId);
  console.log(`[PositionTracker] Tracking ${topMarkets.length} markets`);
}

async function pollMarket(market) {
  const cursor = marketCursors.get(market.conditionId) ?? 0;
  const sinceParam = cursor > 0 ? `&since=${cursor}` : '';
  const path = `/trades?conditionId=${market.conditionId}&limit=200&takerOnly=false${sinceParam}`;

  let trades;
  try {
    trades = await fetchJSON('data-api.polymarket.com', path);
    if (!Array.isArray(trades)) return;
  } catch (err) {
    console.warn(`[PositionTracker] Error fetching ${market.conditionId}: ${err.message}`);
    return;
  }

  if (trades.length === 0) return;

  const latestTs = Math.max(...trades.map(t => t.timestamp));
  marketCursors.set(market.conditionId, latestTs);

  for (const trade of trades) {
    const sizeUsd = trade.side === 'BUY'
      ? trade.size * trade.price
      : trade.size * (1 - trade.price);

    if (sizeUsd < MIN_TRADE_SIZE_USDC) continue;
    if (!trade.proxyWallet) continue;

    const side = trade.side === 'BUY' ? 'YES' : 'NO';
    const key = `${trade.proxyWallet}:${market.conditionId}:${side}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        walletAddress: trade.proxyWallet,
        marketId: market.slug ?? market.conditionId,
        marketName: market.title,
        side,
        trades: [],
        totalSizeUsd: 0,
        alertedAt: null,
      };
      buckets.set(key, bucket);
    }

    bucket.trades.push({ sizeUsd, timestampMs: trade.timestamp * 1000, price: trade.price });
    bucket.totalSizeUsd += sizeUsd;
    checkBucket(bucket);
  }
}

function checkBucket(bucket) {
  const now = Date.now();
  const windowStart = now - ACCUMULATION_WINDOW_MS;
  bucket.trades = bucket.trades.filter(t => t.timestampMs >= windowStart);
  bucket.totalSizeUsd = bucket.trades.reduce((s, t) => s + t.sizeUsd, 0);

  if (bucket.totalSizeUsd < ACCUMULATION_THRESHOLD_USDC) return;
  if (bucket.alertedAt !== null && now - bucket.alertedAt < ACCUMULATION_WINDOW_MS) return;

  bucket.alertedAt = now;

  console.log('\n🎯 ACCUMULATION DETECTED!');
  console.log(`   Market   : ${bucket.marketName}`);
  console.log(`   Side     : ${bucket.side}`);
  console.log(`   Total    : $${bucket.totalSizeUsd.toFixed(0)} USDC`);
  console.log(`   Fills    : ${bucket.trades.length} trades in ${(ACCUMULATION_WINDOW_MS / 3_600_000).toFixed(1)}h window`);
  console.log(`   Wallet   : ${bucket.walletAddress}`);
  console.log(`   Avg price: ${(bucket.trades.reduce((s, t) => s + t.price, 0) / bucket.trades.length * 100).toFixed(1)}%`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔍 PositionTracker Test — 2 minute run\n');
  console.log(`   Threshold  : $${ACCUMULATION_THRESHOLD_USDC.toLocaleString()} USDC`);
  console.log(`   Window     : ${(ACCUMULATION_WINDOW_MS / 3_600_000).toFixed(1)} hours`);
  console.log(`   Top markets: ${TOP_MARKETS}`);
  console.log('');

  await refreshTopMarkets();

  let polls = 0;
  const interval = setInterval(async () => {
    polls++;
    process.stdout.write(`\r[Poll #${polls}] Active buckets: ${buckets.size}   `);

    for (const market of topMarkets) {
      try { await pollMarket(market); }
      catch { /* ignore */ }
    }
  }, 10_000);

  // Initial poll
  for (const market of topMarkets) {
    try { await pollMarket(market); }
    catch { /* ignore */ }
  }

  // Stop after 2 minutes
  setTimeout(() => {
    clearInterval(interval);
    console.log('\n\n📊 Final state:');
    const sorted = [...buckets.values()]
      .sort((a, b) => b.totalSizeUsd - a.totalSizeUsd)
      .slice(0, 10);

    if (sorted.length === 0) {
      console.log('   No accumulation activity detected in this window.');
      console.log('   Try lowering ACCUMULATION_THRESHOLD_USDC or running during US market hours.');
    } else {
      sorted.forEach((b, i) => {
        console.log(`   ${i + 1}. ${b.marketName.slice(0, 40)} | ${b.side} | $${b.totalSizeUsd.toFixed(0)} | ${b.trades.length} fills`);
      });
    }
    process.exit(0);
  }, 2 * 60 * 1000);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
