require('dotenv').config();
const { startBot } = require('./telegrambot');
const { startServer } = require('./server');

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('❌ Missing BOT_TOKEN. Add it to your .env file first.');
  process.exit(1);
}

// This is the web address people will use to reach the dashboard.
// Locally it's just your computer. Once deployed to Railway, this becomes
// your live Railway URL (we'll set that as an environment variable there).
const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || 'http://localhost:3000';
const port = process.env.PORT || 3000;

// Your own Telegram chat ID — the only person who can approve new users.
// Without this set, nobody can be approved (including you), so double-check it.
const adminChatId = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;
if (!adminChatId) {
  console.warn('⚠️  ADMIN_CHAT_ID is not set — nobody will be able to approve new users, including you.');
}

startServer(port);
startBot(token, dashboardBaseUrl, adminChatId);

console.log('✅ V1 is fully running: bot + dashboard.');
console.log(`   Dashboard base URL: ${dashboardBaseUrl}`);