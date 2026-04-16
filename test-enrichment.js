/**
 * Test Trade Enrichment
 * Simule un trade WebSocket qui devrait être enrichi avec un wallet de l'API
 */

const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const STREAM_KEY = 'trades:stream';

async function test() {
  console.log('🔬 Test Trade Enrichment\n');

  // 1. Simuler un trade de l'API Data (avec wallet)
  const dataAPITrade = {
    market_id: 'test-enrichment-market',
    market_name: 'Test Enrichment Market',
    outcome: 'YES',
    side: 'YES',
    price: '0.65',
    size: '1000',
    size_usd: '650.00',
    timestamp: String(Date.now()),
    taker_address: '0x1234567890abcdef1234567890abcdef12345678',
    bid_liquidity: '1000',
    ask_liquidity: '1000',
    market_category: 'test'
  };

  console.log('1️⃣ Pushing Data API trade (with wallet)...');
  const fields1 = [];
  Object.entries(dataAPITrade).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      fields1.push(key, value);
    }
  });
  await redis.xadd(STREAM_KEY, '*', ...fields1);
  console.log('   ✅ Data API trade pushed');
  console.log('   Wallet:', dataAPITrade.taker_address);

  // Attendre 2 secondes pour que le cache soit rempli
  console.log('\n⏳ Waiting 2 seconds for cache to populate...\n');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 2. Simuler un trade WebSocket similaire (sans wallet)
  const webSocketTrade = {
    market_id: 'test-enrichment-market',
    market_name: 'Test Enrichment Market',
    outcome: 'YES',
    side: 'YES',
    price: '0.65',  // Même prix
    size: '1000',
    size_usd: '650.00',  // Même montant
    timestamp: String(Date.now()),  // Timestamp proche
    // PAS de taker_address - devrait être enrichi !
    bid_liquidity: '1000',
    ask_liquidity: '1000',
    market_category: 'test'
  };

  console.log('2️⃣ Pushing WebSocket trade (without wallet)...');
  const fields2 = [];
  Object.entries(webSocketTrade).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      fields2.push(key, value);
    }
  });
  await redis.xadd(STREAM_KEY, '*', ...fields2);
  console.log('   ✅ WebSocket trade pushed');
  console.log('   Expected: Should be enriched with wallet from cache\n');

  console.log('📊 Check the ingestor logs for enrichment messages!');
  console.log('   Look for: "TradeEnricher: enriched WebSocket trade with wallet"\n');

  await redis.quit();
}

test().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
