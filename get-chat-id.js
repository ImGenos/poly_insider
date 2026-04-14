const https = require('https');

const token = '8507906204:AAE4PhDKK4Jk2syJ9AZ4r8D93SaLi1DlWpQ';

console.log('Fetching updates from Telegram bot...\n');

https.get(`https://api.telegram.org/bot${token}/getUpdates`, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    if (!json.ok) {
      console.log('Error:', json.description);
      return;
    }
    
    if (json.result.length === 0) {
      console.log('❌ No messages found!');
      console.log('\nPlease:');
      console.log('1. Open Telegram');
      console.log('2. Search for @Mon_Paque_bot');
      console.log('3. Click START or send /start');
      console.log('4. Run this script again\n');
      return;
    }
    
    console.log('✅ Found messages! Your chat IDs:\n');
    const chatIds = new Set();
    json.result.forEach(update => {
      if (update.message?.chat?.id) {
        const chatId = update.message.chat.id;
        const username = update.message.chat.username || update.message.chat.first_name || 'Unknown';
        chatIds.add(JSON.stringify({ id: chatId, username }));
      }
    });
    
    chatIds.forEach(chatInfo => {
      const info = JSON.parse(chatInfo);
      console.log(`Chat ID: ${info.id}`);
      console.log(`User: ${info.username}`);
      console.log('---');
    });
    
    console.log('\nUpdate your .env file with:');
    const firstChat = JSON.parse([...chatIds][0]);
    console.log(`TELEGRAM_CHAT_ID=${firstChat.id}`);
  });
}).on('error', e => console.error('Error:', e.message));
