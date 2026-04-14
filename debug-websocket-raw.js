// Debug: See ALL raw WebSocket messages from Polymarket
const WebSocket = require('ws');

const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

let messageCount = 0;
let eventTypes = {};

ws.on('open', () => {
  console.log('✅ Connected to Polymarket WebSocket\n');
  
  // Subscribe to a few popular tokens
  const subscribeMsg = {
    assets_ids: [
      '21742633143463906290569050155826241533067272736897614950488156847949938836455', // Trump 2024
      '48331043336612883890938759509493159234755048973500640148014422747788308965732'  // Another popular market
    ],
    type: 'market'
  };
  
  ws.send(JSON.stringify(subscribeMsg));
  console.log('📡 Subscribed to 2 tokens');
  console.log('⏳ Listening for 60 seconds...\n');
  
  // Auto-close after 60 seconds
  setTimeout(() => {
    console.log(`\n📊 Summary after 60 seconds:`);
    console.log(`   Total messages: ${messageCount}`);
    console.log(`\n   Event types received:`);
    Object.entries(eventTypes).forEach(([type, count]) => {
      console.log(`   - ${type || '(no event_type)'}: ${count}`);
    });
    
    if (!eventTypes['last_trade_price']) {
      console.log('\n⚠️  NO last_trade_price events received!');
      console.log('   This explains why your system isn\'t catching trades.');
      console.log('\n   Possible reasons:');
      console.log('   1. No trades happening on subscribed markets');
      console.log('   2. WebSocket format changed');
      console.log('   3. Need to subscribe differently');
    }
    
    ws.close();
    process.exit(0);
  }, 60000);
  
  // Send PING every 10 seconds
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('PING');
    }
  }, 10000);
});

ws.on('message', (data) => {
  messageCount++;
  const raw = data.toString();
  
  // Skip PONG responses
  if (raw === 'PONG') {
    return;
  }
  
  try {
    const parsed = JSON.parse(raw);
    const events = Array.isArray(parsed) ? parsed : [parsed];
    
    events.forEach((event, i) => {
      const eventType = event.event_type || '(no event_type)';
      eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;
      
      // Show first few messages of each type
      if (eventTypes[eventType] <= 3) {
        console.log(`\n📨 Message #${messageCount} - Event: ${eventType}`);
        console.log(JSON.stringify(event, null, 2).slice(0, 500));
      }
    });
  } catch (e) {
    console.log(`\n⚠️  Non-JSON message: ${raw.slice(0, 100)}`);
  }
});

ws.on('error', (err) => {
  console.error('\n❌ WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('\n👋 Disconnected');
});
