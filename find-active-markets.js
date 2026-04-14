// Find the most active Polymarket markets
const https = require('https');

console.log('🔍 Fetching active Polymarket markets...\n');

const options = {
  hostname: 'gamma-api.polymarket.com',
  path: '/markets?limit=10&active=true',
  method: 'GET',
  headers: {
    'Accept': 'application/json'
  }
};

const req = https.request(options, (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const markets = JSON.parse(data);
      
      console.log('📊 Top 10 Most Active Markets:\n');
      
      markets.slice(0, 10).forEach((market, i) => {
        console.log(`${i + 1}. ${market.question}`);
        console.log(`   Volume: $${(market.volume || 0).toLocaleString()}`);
        console.log(`   Liquidity: $${(market.liquidity || 0).toLocaleString()}`);
        console.log(`   Condition ID: ${market.condition_id}`);
        console.log('');
      });
      
      console.log('\n💡 Your system is subscribed to 2000 tokens from these markets.');
      console.log('   Trades will be detected automatically when they occur.');
      
    } catch (e) {
      console.error('❌ Error parsing response:', e.message);
    }
  });
});

req.on('error', (e) => {
  console.error('❌ Request error:', e.message);
});

req.end();
