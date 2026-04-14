/**
 * End-to-End Pipeline Test V2
 * 
 * This creates an EXTREME trade that should definitely trigger multiple alerts:
 * - Massive size (100k USDC)
 * - Rapid price change
 * - New wallet
 */

const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const STREAM_KEY = 'trades:stream';

// First, let's add a baseline trade to establish price history
const baselineTrade = {
  market_id: 'test-market-456',
  market_name: '🚨 EXTREME TEST: Massive Whale Alert',
  side: 'YES',
  price: '0.50',
  size: '10000',
  size_usd: '5000',
  timestamp: String(Date.now() - 10000), // 10 seconds ago
  maker_address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  taker_address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  bid_liquidity: '100000',
  ask_liquidity: '100000',
  market_category: 'sports'
};

// Then a MASSIVE trade with rapid price change
const extremeTrade = {
  market_id: 'test-market-456',
  market_name: '🚨 EXTREME TEST: Massive Whale Alert',
  side: 'YES',
  price: '0.75', // 50% price jump from 0.50!
  size: '150000',
  size_usd: '112500', // MASSIVE 112k USDC trade!
  timestamp: String(Date.now()),
  maker_address: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  taker_address: '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
  bid_liquidity: '200000',
  ask_liquidity: '200000',
  market_category: 'sports'
};

console.log('🚨 EXTREME Pipeline Test\n');
console.log('This test will:');
console.log('1. Push a baseline trade (5k USDC at price 0.50)');
console.log('2. Push an EXTREME trade (112k USDC at price 0.75)');
console.log('3. Should trigger MULTIPLE alerts:');
console.log('   - WHALE_ACTIVITY (112k >> 10k threshold)');
console.log('   - RAPID_ODDS_SHIFT (50% price change >> 5% threshold)');
console.log('   - Possibly INSIDER_TRADING (new wallet, large trade, niche market)\n');

async function pushTrade(trade, label) {
  console.log(`Pushing ${label}...`);
  await redis.xadd(
    STREAM_KEY,
    '*',
    'market_id', trade.market_id,
    'market_name', trade.market_name,
    'side', trade.side,
    'price', trade.price,
    'size', trade.size,
    'size_usd', trade.size_usd,
    'timestamp', trade.timestamp,
    'maker_address', trade.maker_address,
    'taker_address', trade.taker_address,
    'bid_liquidity', trade.bid_liquidity,
    'ask_liquidity', trade.ask_liquidity,
    'market_category', trade.market_category
  );
  console.log(`✅ ${label} pushed\n`);
}

(async () => {
  try {
    await pushTrade(baselineTrade, 'Baseline trade');
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    await pushTrade(extremeTrade, 'EXTREME trade');
    
    console.log('⏳ Check your Telegram in the next 10-15 seconds...');
    console.log('You should receive MULTIPLE notifications! 🎉\n');
    
    await redis.quit();
  } catch (err) {
    console.error('❌ Error:', err.message);
    await redis.quit();
    process.exit(1);
  }
})();
