// Quick diagnostic: Check if Polymarket WebSocket is sending trades
const WebSocket = require('ws');

const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

let messageCount = 0;
let tradeCount = 0;

ws.on('open', () => {
  console.log('✅ Connected to Polymarket WebSocket');
  
  // Subscribe to a popular market (Trump 2024 election)
  const subscribeMsg = {
    assets_ids: ['21742633143463906290569050155826241533067272736897614950488156847949938836455'],
    type: 'market'
  };
  
  ws.send(JSON.stringify(subscribeMsg));
  console.log('📡 Subscribed to Trump 2024 market');
  console.log('⏳ Waiting for trades (30 seconds)...\n');
  
  // Auto-close after 30 seconds
  setTimeout(() => {
    console.log(`\n📊 Results after 30 seconds:`);
    console.log(`   Total messages: ${messageCount}`);
    console.log(`   Trade events: ${tradeCount}`);
    
    if (tradeCount === 0) {
      console.log('\n⚠️  No trades detected. This could mean:');
      console.log('   1. Low market activity right now');
      console.log("   2. The market you subscribed to isn't trading");
      console.log('   3. Try running this again during US trading hours');
    } else {
      console.log('\n✅ Trades are flowing! Your system should be catching them.');
    }
    
    ws.close();
    process.exit(0);
  }, 30000);
});

ws.on('message', (data) => {
  messageCount++;
  
  try {
    const parsed = JSON.parse(data.toString());
    const events = Array.isArray(parsed) ? parsed : [parsed];
    
    for (const event of events) {
      if (event.event_type === 'last_trade_price') {
        tradeCount++;
        console.log(`🔔 Trade #${tradeCount}: ${event.side} ${event.size} @ $${event.price}`);
      }
    }
  } catch (e) {
    // Ignore parse errors
  }
});

ws.on('error', (err) => {
  console.error('❌ WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('\n👋 Disconnected');
});
