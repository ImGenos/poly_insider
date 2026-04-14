/**
 * End-to-End Pipeline Test
 * 
 * This script simulates a large trade being pushed through the entire system:
 * 1. Pushes a simulated trade to Redis stream (bypassing WebSocket)
 * 2. The analyzer picks it up
 * 3. Detectors analyze it
 * 4. Alert is sent to Telegram
 */

const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const STREAM_KEY = 'trades:stream';

// Simulate a WHALE trade that should trigger alerts
const simulatedTrade = {
  market_id: 'test-market-123',
  market_name: '🧪 TEST: Will this notification system work?',
  side: 'YES',
  price: '0.65',
  size: '20000',
  size_usd: '13000', // Large trade - should trigger whale detection
  timestamp: String(Date.now()),
  maker_address: '0x1234567890123456789012345678901234567890',
  taker_address: '0x0987654321098765432109876543210987654321',
  bid_liquidity: '50000',
  ask_liquidity: '50000',
  market_category: 'test'
};

console.log('🧪 Testing End-to-End Pipeline\n');
console.log('Simulated Trade Details:');
console.log('  Market:', simulatedTrade.market_name);
console.log('  Side:', simulatedTrade.side);
console.log('  Price:', simulatedTrade.price);
console.log('  Size USD:', simulatedTrade.size_usd, 'USDC');
console.log('  Expected Detection: WHALE_ACTIVITY (size > 10k USDC)\n');

console.log('Pushing trade to Redis stream...');

redis.xadd(
  STREAM_KEY,
  '*',
  'market_id', simulatedTrade.market_id,
  'market_name', simulatedTrade.market_name,
  'side', simulatedTrade.side,
  'price', simulatedTrade.price,
  'size', simulatedTrade.size,
  'size_usd', simulatedTrade.size_usd,
  'timestamp', simulatedTrade.timestamp,
  'maker_address', simulatedTrade.maker_address,
  'taker_address', simulatedTrade.taker_address,
  'bid_liquidity', simulatedTrade.bid_liquidity,
  'ask_liquidity', simulatedTrade.ask_liquidity,
  'market_category', simulatedTrade.market_category
).then(() => {
  console.log('✅ Trade pushed to stream successfully!\n');
  console.log('The analyzer should now:');
  console.log('  1. Read the trade from the stream');
  console.log('  2. Filter it (passes - size > 500 USDC)');
  console.log('  3. Detect WHALE_ACTIVITY (13k USDC trade)');
  console.log('  4. Send Telegram notification\n');
  console.log('⏳ Check your Telegram in the next 5-10 seconds...\n');
  console.log('If you receive a notification about a whale trade, the system is working! 🎉');
  
  return redis.quit();
}).catch(err => {
  console.error('❌ Error:', err.message);
  redis.quit();
  process.exit(1);
});
