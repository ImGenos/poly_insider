/**
 * test-wallet-history.js
 *
 * Fetch the full trading history for a known Polymarket whale wallet and
 * print a breakdown of their positions by market.
 *
 * Usage:  node test-wallet-history.js [walletAddress]
 *
 * Default wallet is a known Polymarket heavy trader for testing.
 */

const https = require('https');

const walletAddress = process.argv[2] ?? '0x2e35cfe2f2a0a3a8c57e3d2a2a7e6cfd93555b9e';
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

function fetchJSON(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeout: 10_000,
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse error on ${path}: ${e}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function fetchAllPages(role) {
  const allTrades = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const path = `/trades?${role}=${walletAddress}&limit=${PAGE_SIZE}&offset=${offset}`;
    process.stdout.write(`   Fetching page ${page + 1} (${role})...\r`);

    const batch = await fetchJSON('data-api.polymarket.com', path);
    if (!Array.isArray(batch) || batch.length === 0) break;

    allTrades.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return allTrades;
}

async function main() {
  console.log(`\n📊 Wallet History Fetcher Test`);
  console.log(`   Wallet: ${walletAddress}\n`);

  const [makerTrades, takerTrades] = await Promise.all([
    fetchAllPages('maker'),
    fetchAllPages('taker'),
  ]);

  console.log(`\n   Maker trades : ${makerTrades.length}`);
  console.log(`   Taker trades : ${takerTrades.length}`);

  // Deduplicate
  const seen = new Set();
  const allTrades = [];
  for (const t of [...makerTrades, ...takerTrades]) {
    const key = `${t.conditionId}:${t.timestamp}:${t.size}:${t.side}`;
    if (!seen.has(key)) { seen.add(key); allTrades.push(t); }
  }
  console.log(`   Unique trades: ${allTrades.length}\n`);

  if (allTrades.length === 0) {
    console.log('⚠️  No trades found. Try a different wallet address.');
    console.log('   Usage: node test-wallet-history.js 0xYOURWALLET');
    return;
  }

  // Aggregate by market + side
  const positions = new Map();
  let totalVolume = 0;

  for (const t of allTrades) {
    const side = t.side === 'BUY' ? 'YES' : 'NO';
    const costUsdc = t.side === 'BUY' ? t.size * t.price : t.size * (1 - t.price);
    const key = `${t.slug ?? t.conditionId}:${side}`;

    let pos = positions.get(key);
    if (!pos) {
      pos = {
        marketId: t.slug ?? t.conditionId,
        marketName: t.title ?? t.slug ?? t.conditionId,
        side,
        totalCostUsdc: 0,
        fillCount: 0,
        prices: [],
        firstFill: Infinity,
        lastFill: 0,
      };
      positions.set(key, pos);
    }

    pos.totalCostUsdc += costUsdc;
    pos.fillCount++;
    pos.prices.push(t.price);
    pos.firstFill = Math.min(pos.firstFill, t.timestamp);
    pos.lastFill = Math.max(pos.lastFill, t.timestamp);
    totalVolume += costUsdc;
  }

  // Sort by position size
  const sorted = [...positions.values()].sort((a, b) => b.totalCostUsdc - a.totalCostUsdc);

  console.log('📈 Top Positions:\n');
  console.log('   Market'.padEnd(50) + 'Side  Total USDC  Fills  Avg Price  Duration');
  console.log('   ' + '─'.repeat(90));

  sorted.slice(0, 20).forEach(pos => {
    const avgPrice = pos.prices.reduce((a, b) => a + b, 0) / pos.prices.length;
    const durationMs = (pos.lastFill - pos.firstFill) * 1000;
    const durationH = durationMs / 3_600_000;
    const durationStr = durationH < 1
      ? `${(durationH * 60).toFixed(0)}m`
      : `${durationH.toFixed(1)}h`;

    const name = pos.marketName.slice(0, 46).padEnd(46);
    const side = pos.side.padEnd(4);
    const cost = `$${pos.totalCostUsdc.toFixed(0)}`.padStart(10);
    const fills = String(pos.fillCount).padStart(5);
    const price = `${(avgPrice * 100).toFixed(1)}%`.padStart(9);
    const dur = durationStr.padStart(8);

    console.log(`   ${name} ${side} ${cost} ${fills} ${price} ${dur}`);
  });

  console.log(`\n   Total volume: $${totalVolume.toFixed(0)} USDC across ${positions.size} positions in ${new Set(sorted.map(p => p.marketId)).size} markets`);

  // Identify likely accumulation: positions with > 2 fills over > 30 minutes
  const accumulated = sorted.filter(p => p.fillCount >= 3 && (p.lastFill - p.firstFill) * 1000 > 30 * 60_000);
  if (accumulated.length > 0) {
    console.log('\n🎯 Likely accumulated positions (≥3 fills, >30min window):');
    accumulated.slice(0, 5).forEach(pos => {
      const durationH = ((pos.lastFill - pos.firstFill) * 1000) / 3_600_000;
      console.log(`   • ${pos.marketName.slice(0, 50)} | ${pos.side} | $${pos.totalCostUsdc.toFixed(0)} | ${pos.fillCount} fills over ${durationH.toFixed(1)}h`);
    });
  } else {
    console.log('\n   No slow-accumulation patterns found for this wallet.');
  }
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
