/**
 * Test MEGA TRADE - Trade ≥ $30,000
 */

const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const STREAM_KEY = 'trades:stream';

// Trade de $35k - devrait déclencher l'alerte MEGA TRADE
const megaTrade = {
  market_id: 'test-mega-' + Date.now(),
  market_name: '🏈 NFL: Chiefs vs 49ers - Super Bowl Winner',
  outcome: 'Chiefs',
  side: 'YES',
  price: '0.58',
  size: '60345',
  size_usd: '35000.00', // $35k - au-dessus du seuil de $30k
  timestamp: String(Date.now()),
  bid_liquidity: '50000',
  ask_liquidity: '45000',
  market_category: 'sports'
};

console.log('💰 Test MEGA TRADE Alert\n');
console.log('Trade Details:');
console.log('  Market:', megaTrade.market_name);
console.log('  Outcome:', megaTrade.outcome);
console.log('  Side:', megaTrade.side);
console.log('  Size: $' + megaTrade.size_usd);
console.log('  Threshold: $30,000');
console.log('  Expected: MEGA TRADE alert 💰\n');

const fields = [];
Object.entries(megaTrade).forEach(([key, value]) => {
  if (value !== undefined && value !== '') {
    fields.push(key, value);
  }
});

redis.xadd(STREAM_KEY, '*', ...fields)
  .then(() => {
    console.log('✅ Trade pushed to stream!');
    console.log('📱 Check your Telegram NOW!\n');
    return redis.quit();
  })
  .catch(err => {
    console.error('❌ Error:', err.message);
    redis.quit();
    process.exit(1);
  });
