// Debug: See ALL raw WebSocket messages with full content
const WebSocket = require('ws');

const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

let messageCount = 0;

ws.on('open', () => {
  console.log('✅ Connected\n');
  
  // Try subscribing to ALL active markets (like your system does)
  const subscribeMsg = {
    assets_ids: [
      '21742633143463906290569050155826241533067272736897614950488156847949938836455',
      '48331043336612883890938759509493159234755048973500640148014422747788308965732',
      '70018807773238020915361161897719073078804647330583488591369599275024873820020'
    ],
    type: 'market',
    custom_feature_enabled: true  // Enable all event types
  };
  
  ws.send(JSON.stringify(subscribeMsg));
  console.log('📡 Subscribed with custom_feature_enabled: true');
  console.log('⏳ Listening for 30 seconds...\n');
  
  setTimeout(() => {
    console.log(`\n📊 Total messages: ${messageCount}`);
    if (messageCount === 0) {
      console.log('\n⚠️  NO messages received at all!');
      console.log('   The subscription might not be working.');
    }
    ws.close();
    process.exit(0);
  }, 30000);
  
  // Send PING every 10 seconds
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('PING');
    }
  }, 10000);
});

ws.on('message', (data) => {
  const raw = data.toString();
  
  if (raw === 'PONG') {
    return;
  }
  
  messageCount++;
  console.log(`\n━━━ Message #${messageCount} ━━━`);
  console.log(raw);
  
  try {
    const parsed = JSON.parse(raw);
    if (parsed.event_type) {
      console.log(`Event Type: ${parsed.event_type}`);
    }
  } catch (e) {
    // Not JSON
  }
});

ws.on('error', (err) => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('\n👋 Disconnected');
});
