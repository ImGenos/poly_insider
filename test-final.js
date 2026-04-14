/**
 * Final Test - Fresh Extreme Trade
 * This will be processed immediately by the running analyzer
 */

const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const STREAM_KEY = 'trades:stream';

const megaTrade = {
  market_id: 'final-test-999',
  market_name: '🎯 FINAL TEST: Will Kiro send notification?',
  side: 'YES',
  price: '0.80',
  size: '200000',
  size_usd: '160000', // MASSIVE 160k USDC!
  timestamp: String(Date.now()),
  maker_address: '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
  taker_address: '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
  bid_liquidity: '0', // No liquidity data - forces fallback detection
  ask_liquidity: '0',
  market_category: 'sports'
};

console.log('🎯 FINAL TEST\n');
console.log('Trade Details:');
console.log('  Market:', megaTrade.market_name);
console.log('  Size: $160,000 USDC (MASSIVE!)');
console.log('  Detection Path: Size threshold fallback');
console.log('  Threshold: $2,000 (INSIDER_MIN_TRADE_SIZE)');
console.log('  Expected: WHALE_ACTIVITY alert with HIGH severity\n');

redis.xadd(
  STREAM_KEY,
  '*',
  'market_id', megaTrade.market_id,
  'market_name', megaTrade.market_name,
  'side', megaTrade.side,
  'price', megaTrade.price,
  'size', megaTrade.size,
  'size_usd', megaTrade.size_usd,
  'timestamp', megaTrade.timestamp,
  'maker_address', megaTrade.market_address,
  'taker_address', megaTrade.taker_address,
  'bid_liquidity', megaTrade.bid_liquidity,
  'ask_liquidity', megaTrade.ask_liquidity,
  'market_category', megaTrade.market_category
).then(() => {
  console.log('✅ Trade pushed to stream!\n');
  console.log('⏳ The analyzer should process it within 5-10 seconds...');
  console.log('📱 CHECK YOUR TELEGRAM NOW!\n');
  console.log('If you receive a whale alert, the system is 100% working! 🎉');
  return redis.quit();
}).catch(err => {
  console.error('❌ Error:', err.message);
  redis.quit();
  process.exit(1);
});
