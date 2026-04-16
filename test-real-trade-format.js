/**
 * Test avec le format exact du trade réel Counter-Strike
 * Simule le format BUY/SELL de l'API Data
 */

const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const STREAM_KEY = 'trades:stream';

// Format exact du trade réel Counter-Strike avec BUY au lieu de YES
const realFormatTrade = {
  market_id: 'counter-strike-furia-mouz-test',
  market_name: 'Counter-Strike: FURIA vs MOUZ - Map 2 Winner',
  outcome: 'FURIA',
  side: 'BUY',  // Format API Data (sera normalisé en YES)
  price: '0.62',
  size: '29658',
  size_usd: '18387.96',
  timestamp: String(Date.now()),
  bid_liquidity: '0',
  ask_liquidity: '0',
  market_category: 'esports',
  taker_address: '0x1234567890123456789012345678901234567890'
};

console.log('🧪 Test avec format réel BUY/SELL\n');
console.log('Trade Details:');
console.log('  Market:', realFormatTrade.market_name);
console.log('  Side: BUY (sera normalisé en YES)');
console.log('  Size: $' + realFormatTrade.size_usd);
console.log('  Expected: WHALE_ACTIVITY alert\n');

const fields = [];
Object.entries(realFormatTrade).forEach(([key, value]) => {
  if (value !== undefined && value !== '') {
    fields.push(key, value);
  }
});

redis.xadd(STREAM_KEY, '*', ...fields)
  .then(() => {
    console.log('✅ Trade pushed to stream!\n');
    console.log('⏳ Checking analyzer logs in 5 seconds...');
    return redis.quit();
  })
  .catch(err => {
    console.error('❌ Error:', err.message);
    redis.quit();
    process.exit(1);
  });
