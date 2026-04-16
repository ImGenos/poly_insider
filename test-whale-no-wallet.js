/**
 * Test Whale sans wallet address - devrait utiliser le fallback de taille
 */

const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const STREAM_KEY = 'trades:stream';

// Trade sans wallet - devrait déclencher via size threshold fallback
const whaleTrade = {
  market_id: 'test-whale-' + Date.now(),
  market_name: '🐋 Test Whale Alert - No Wallet',
  outcome: 'YES',
  side: 'BUY',  // Sera normalisé en YES
  price: '0.75',
  size: '50000',
  size_usd: '37500.00', // $37.5k - bien au-dessus du seuil de $10k
  timestamp: String(Date.now()),
  bid_liquidity: '0',
  ask_liquidity: '0',
  market_category: 'test'
};

console.log('🐋 Test Whale Alert (No Wallet)\n');
console.log('Trade Details:');
console.log('  Market:', whaleTrade.market_name);
console.log('  Side:', whaleTrade.side, '(sera normalisé en YES)');
console.log('  Size: $' + whaleTrade.size_usd);
console.log('  Wallet: None (fallback sur size threshold)');
console.log('  Threshold: $10,000');
console.log('  Expected: WHALE_ACTIVITY alert via size fallback\n');

const fields = [];
Object.entries(whaleTrade).forEach(([key, value]) => {
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
