const express = require('express');
const path = require('path');
const { getDb } = require('./db');

function startServer(port) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // Returns all debts belonging to one tradesperson (identified by their Telegram chat ID)
  app.get('/api/debts/:chatId', async (req, res) => {
    const db = await getDb();
    const chatId = Number(req.params.chatId);
    const debts = db.data.debts
      .filter(d => d.ownerChatId === chatId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(debts);
  });

  // Marks a specific debt as paid from the dashboard (not just from Telegram)
  app.post('/api/debts/:id/mark-paid', async (req, res) => {
    const db = await getDb();
    const debt = db.data.debts.find(d => d.id === req.params.id);
    if (!debt) return res.status(404).json({ error: 'Debt not found' });
    debt.paid = true;
    await db.write();
    res.json(debt);
  });

  app.listen(port, () => {
    console.log(`✅ Dashboard server running on port ${port}`);
  });

  return app;
}

module.exports = { startServer };