// Test Polymarket Data API to see recent trades
const https = require('https');

console.log('🔍 Fetching recent trades from Polymarket Data API...\n');

const options = {
  hostname: 'data-api.polymarket.com',
  path: '/trades?limit=10&takerOnly=true',
  method: 'GET',
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
};

const req = https.request(options, (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const trades = JSON.parse(data);
      
      if (!trades || trades.length === 0) {
        console.log('❌ No trades found');
        return;
      }
      
      console.log(`✅ Found ${trades.length} recent trades:\n`);
      
      trades.forEach((trade, i) => {
        const date = new Date(trade.timestamp * 1000);
        const sizeUsd = (trade.size * trade.price).toFixed(2);
        
        console.log(`${i + 1}. ${trade.title}`);
        console.log(`   Side: ${trade.side} | Size: ${trade.size.toFixed(2)} @ $${trade.price}`);
        console.log(`   USD Value: $${sizeUsd}`);
        console.log(`   Time: ${date.toLocaleString()}`);
        console.log(`   Market: ${trade.conditionId}`);
        console.log('');
      });
      
      // Calculate stats
      const totalVolume = trades.reduce((sum, t) => sum + (t.size * t.price), 0);
      const avgTradeSize = totalVolume / trades.length;
      const now = Date.now() / 1000;
      const oldestTrade = trades[trades.length - 1];
      const timeSpan = now - oldestTrade.timestamp;
      
      console.log('📊 Statistics:');
      console.log(`   Total Volume: $${totalVolume.toFixed(2)}`);
      console.log(`   Average Trade: $${avgTradeSize.toFixed(2)}`);
      console.log(`   Time Span: ${(timeSpan / 60).toFixed(1)} minutes`);
      console.log(`   Trade Rate: ${(trades.length / (timeSpan / 60)).toFixed(2)} trades/min`);
      
      console.log('\n💡 Your system should be catching these trades!');
      console.log('   If not, there may be an issue with the WebSocket subscription.');
      
    } catch (e) {
      console.error('❌ Error parsing response:', e.message);
      console.error('Response:', data.slice(0, 500));
    }
  });
});

req.on('error', (e) => {
  console.error('❌ Request error:', e.message);
});

req.end();
