/**
 * Test Whale Alert - Simulate the $18k Counter-Strike trade
 */

const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const STREAM_KEY = 'trades:stream';

// Simulate the real Counter-Strike trade
const whaleTrade = {
  market_id: 'counter-strike-furia-vs-mouz-map-2',
  market_name: 'Counter-Strike: FURIA vs MOUZ - Map 2 Winner',
  outcome: 'FURIA',
  side: 'YES',  // Must be YES or NO, not BUY/SELL
  price: '0.62',
  size: '29658',
  size_usd: '18387.96', // Should trigger WHALE_ACTIVITY
  timestamp: String(Date.now()),
  bid_liquidity: '0', // No liquidity data
  ask_liquidity: '0',
  market_category: 'esports'
};

console.log('🐋 Testing Whale Alert Detection\n');
console.log('Trade Details:');
console.log('  Market:', whaleTrade.market_name);
console.log('  Size: $' + whaleTrade.size_usd + ' USDC');
console.log('  Threshold: $10,000 (INSIDER_MIN_TRADE_SIZE)');
console.log('  Expected: WHALE_ACTIVITY alert\n');

// Only include non-empty fields to avoid validation issues
const fields = ['market_id', whaleTrade.market_id];
fields.push('market_name', whaleTrade.market_name);
if (whaleTrade.outcome) fields.push('outcome', whaleTrade.outcome);
fields.push('side', whaleTrade.side);
fields.push('price', whaleTrade.price);
fields.push('size', whaleTrade.size);
fields.push('size_usd', whaleTrade.size_usd);
fields.push('timestamp', whaleTrade.timestamp);
fields.push('bid_liquidity', whaleTrade.bid_liquidity);
fields.push('ask_liquidity', whaleTrade.ask_liquidity);
if (whaleTrade.market_category) fields.push('market_category', whaleTrade.market_category);

redis.xadd(STREAM_KEY, '*', ...fields).then(() => {
  console.log('✅ Trade pushed to Redis stream!\n');
  console.log('⏳ Waiting for analyzer to process...');
  console.log('📱 Check your Telegram in 5-10 seconds!\n');
  return redis.quit();
}).catch(err => {
  console.error('❌ Error:', err.message);
  redis.quit();
  process.exit(1);
});
