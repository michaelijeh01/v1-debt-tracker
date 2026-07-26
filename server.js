const express = require('express');
const path = require('path');
const { getDb } = require('./db');

function startServer(port) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // Checks that the request's token matches the real token for this chatId.
  // Without this, anyone who knew or guessed a chat ID could see/edit
  // someone else's debts just from the URL alone.
  async function verifyToken(chatId, token) {
    const db = await getDb();
    const owner = db.data.owners[chatId];
    return !!(owner && owner.dashboardToken && owner.dashboardToken === token);
  }

  // Same check, but starting from a debt id instead of a chat id directly
  // (used by endpoints that only receive a debt id, like mark-paid/delete)
  async function verifyTokenForDebt(debtId, token) {
    const db = await getDb();
    const debt = db.data.debts.find(d => d.id === debtId);
    if (!debt) return { ok: false, db, debt: null };
    const ok = await verifyToken(debt.ownerChatId, token);
    return { ok, db, debt };
  }

  app.get('/api/debts/:chatId', async (req, res) => {
    const chatId = Number(req.params.chatId);
    if (!(await verifyToken(chatId, req.query.token))) {
      return res.status(403).json({ error: 'Invalid or missing access token' });
    }
    const db = await getDb();
    const debts = db.data.debts
      .filter(d => d.ownerChatId === chatId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(debts);
  });

  app.get('/api/owner/:chatId', async (req, res) => {
    const chatId = Number(req.params.chatId);
    if (!(await verifyToken(chatId, req.query.token))) {
      return res.status(403).json({ error: 'Invalid or missing access token' });
    }
    const db = await getDb();
    const owner = db.data.owners[chatId] || {};
    res.json({ businessName: owner.businessName || null });
  });

  // Marks a debt as fully paid from the dashboard
  app.post('/api/debts/:id/mark-paid', async (req, res) => {
    const { ok, db, debt } = await verifyTokenForDebt(req.params.id, req.body.token);
    if (!debt) return res.status(404).json({ error: 'Debt not found' });
    if (!ok) return res.status(403).json({ error: 'Invalid or missing access token' });

    debt.amountPaid = debt.amount;
    debt.paid = true;
    await db.write();
    res.json(debt);
  });

  // Logs a payment (full or partial) from the dashboard
  app.post('/api/debts/:id/log-payment', async (req, res) => {
    const { ok, db, debt } = await verifyTokenForDebt(req.params.id, req.body.token);
    if (!debt) return res.status(404).json({ error: 'Debt not found' });
    if (!ok) return res.status(403).json({ error: 'Invalid or missing access token' });

    const amount = Number(req.body.amount);
    const owed = debt.amount - (debt.amountPaid || 0);
    if (!amount || amount <= 0 || amount > owed) {
      return res.status(400).json({ error: `Amount must be between 1 and ${owed}` });
    }

    debt.amountPaid = (debt.amountPaid || 0) + amount;
    if (debt.amountPaid >= debt.amount) {
      debt.paid = true;
    }
    await db.write();
    res.json(debt);
  });

  // Deletes a debt entirely — the fix for mistakes noticed after the
  // bot's 60-second "undo" window has already passed.
  app.delete('/api/debts/:id', async (req, res) => {
    const { ok, db, debt } = await verifyTokenForDebt(req.params.id, req.query.token);
    if (!debt) return res.status(404).json({ error: 'Debt not found' });
    if (!ok) return res.status(403).json({ error: 'Invalid or missing access token' });

    db.data.debts = db.data.debts.filter(d => d.id !== req.params.id);
    await db.write();
    res.json({ deleted: true });
  });

  app.listen(port, () => {
    console.log(`✅ Dashboard server running on port ${port}`);
  });

  return app;
}

module.exports = { startServer };