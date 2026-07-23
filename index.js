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

startServer(port);
startBot(token, dashboardBaseUrl);

console.log('✅ V1 is fully running: bot + dashboard.');
console.log(`   Dashboard base URL: ${dashboardBaseUrl}`);