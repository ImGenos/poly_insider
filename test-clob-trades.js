// Test CLOB API /trades endpoint
const https = require('https');

console.log('🔍 Testing CLOB API /trades endpoint...\n');

const options = {
  hostname: 'clob.polymarket.com',
  path: '/trades?limit=10',
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
    console.log(`Status: ${res.statusCode}\n`);
    
    try {
      const response = JSON.parse(data);
      
      if (response.data && Array.isArray(response.data)) {
        console.log(`✅ Found ${response.data.length} trades:\n`);
        
        response.data.slice(0, 5).forEach((trade, i) => {
          const matchTime = new Date(parseInt(trade.match_time) * 1000);
          const sizeDecimal = parseFloat(trade.size) / 1e6; // Convert from wei
          const sizeUsd = sizeDecimal * parseFloat(trade.price);
          
          console.log(`${i + 1}. Trade ID: ${trade.id}`);
          console.log(`   Market: ${trade.market}`);
          console.log(`   Side: ${trade.side} ${trade.outcome}`);
          console.log(`   Size: ${sizeDecimal.toFixed(2)} @ $${trade.price}`);
          console.log(`   USD Value: $${sizeUsd.toFixed(2)}`);
          console.log(`   Time: ${matchTime.toLocaleString()}`);
          console.log(`   Status: ${trade.status}`);
          console.log('');
        });
        
        console.log('\n📊 Comparison:');
        console.log('   CLOB API: More detailed (includes order IDs, fees, status)');
        console.log('   Data API: Simpler, includes market names and user profiles');
        console.log('\n💡 Both work! Data API is simpler for monitoring.');
        
      } else {
        console.log('Response:', JSON.stringify(response, null, 2));
      }
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
