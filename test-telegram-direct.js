/**
 * Direct Telegram Test
 * Tests if the TelegramNotifier class works correctly
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

console.log('🧪 Testing Telegram Notification Directly\n');
console.log('Token:', token ? '✅ Set' : '❌ Missing');
console.log('Chat ID:', chatId ? `✅ ${chatId}` : '❌ Missing');
console.log('');

if (!token || !chatId) {
  console.error('❌ Missing Telegram configuration!');
  process.exit(1);
}

const bot = new TelegramBot(token);

const testMessage = {
  text: `🐋 *WHALE ACTIVITY DETECTED*

*Market:* TEST Market
*Side:* YES
*Size:* $112,500 USDC
*Price:* 0\\.75
*Wallet:* \`0xDDDD...DDDD\`

*Detection:* Whale activity detected via size threshold
*Confidence:* 95%
*Severity:* HIGH`,
  parse_mode: 'MarkdownV2',
  disable_web_page_preview: true
};

console.log('Sending test whale alert...\n');

bot.sendMessage(chatId, testMessage.text, {
  parse_mode: testMessage.parse_mode,
  disable_web_page_preview: testMessage.disable_web_page_preview
})
.then(() => {
  console.log('✅ Message sent successfully!');
  console.log('\nCheck your Telegram - you should have received a whale alert! 🎉');
  process.exit(0);
})
.catch(err => {
  console.error('❌ Failed to send message:');
  console.error(err.message);
  if (err.response && err.response.body) {
    console.error('Response:', err.response.body);
  }
  process.exit(1);
});
