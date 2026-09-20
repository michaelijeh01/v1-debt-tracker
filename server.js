const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { getDb } = require('./db');
const { sendOtpEmail } = require('./email');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-this';
const COOKIE_NAME = 'v1_session';

// Requires at least one uppercase letter, one number, and one symbol.
function isStrongPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8
    && /[A-Z]/.test(pw)
    && /[0-9]/.test(pw)
    && /[^A-Za-z0-9]/.test(pw);
}

function startServer(port) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- Telegram-linked owners: token-in-URL auth (unchanged, existing users) ----

  async function verifyToken(ownerId, token) {
    const db = await getDb();
    const owner = db.data.owners[ownerId];
    return !!(owner && owner.dashboardToken && owner.dashboardToken === token);
  }

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

  app.post('/api/debts/:id/mark-paid', async (req, res) => {
    const { ok, db, debt } = await verifyTokenForDebt(req.params.id, req.body.token);
    if (!debt) return res.status(404).json({ error: 'Debt not found' });
    if (!ok) return res.status(403).json({ error: 'Invalid or missing access token' });
    debt.amountPaid = debt.amount;
    debt.paid = true;
    await db.write();
    res.json(debt);
  });

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
    if (debt.amountPaid >= debt.amount) debt.paid = true;
    await db.write();
    res.json(debt);
  });

  app.delete('/api/debts/:id', async (req, res) => {
    const { ok, db, debt } = await verifyTokenForDebt(req.params.id, req.query.token);
    if (!debt) return res.status(404).json({ error: 'Debt not found' });
    if (!ok) return res.status(403).json({ error: 'Invalid or missing access token' });
    db.data.debts = db.data.debts.filter(d => d.id !== req.params.id);
    await db.write();
    res.json({ deleted: true });
  });

  // ---- Web signup/login: JWT session in an httpOnly cookie ----

  function setSessionCookie(res, ownerId) {
    const token = jwt.sign({ ownerId }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  app.use((req, res, next) => {
    const token = req.cookies[COOKIE_NAME];
    if (token) {
      try {
        req.ownerId = jwt.verify(token, JWT_SECRET).ownerId;
      } catch (err) {
        // expired/invalid — treat as logged out
      }
    }
    next();
  });

  function requireWebAuth(req, res, next) {
    if (!req.ownerId) return res.status(401).json({ error: 'Not logged in' });
    next();
  }

  // ---- Web signup: two steps — start (send OTP) then verify (create account) ----

  app.post('/api/auth/signup/start', async (req, res) => {
    const { email, password, businessName, phone } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password must be 8+ characters with an uppercase letter, a number, and a symbol.' });
    }
    const db = await getDb();
    const normalizedEmail = email.trim().toLowerCase();
    if (db.data.webUsersByEmail[normalizedEmail]) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit code
    const passwordHash = await bcrypt.hash(password, 10);
    db.data.pendingSignups[normalizedEmail] = {
      code,
      businessName: businessName || '',
      phone: phone || '',
      passwordHash,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    };
    await db.write();

    try {
      await sendOtpEmail(normalizedEmail, code);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ ok: true });
  });

  app.post('/api/auth/signup/verify', async (req, res) => {
    const { email, code } = req.body;
    const db = await getDb();
    const normalizedEmail = (email || '').trim().toLowerCase();
    const pending = db.data.pendingSignups[normalizedEmail];

    if (!pending) return res.status(400).json({ error: 'No signup in progress for that email. Please start again.' });
    if (Date.now() > pending.expiresAt) {
      delete db.data.pendingSignups[normalizedEmail];
      await db.write();
      return res.status(400).json({ error: 'That code expired. Please request a new one.' });
    }
    if (String(code).trim() !== pending.code) {
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    }

    const ownerId = 'web_' + crypto.randomBytes(12).toString('hex');
    db.data.owners[ownerId] = {
      businessName: pending.businessName,
      email: normalizedEmail,
      phone: pending.phone,
      passwordHash: pending.passwordHash,
      dashboardToken: crypto.randomBytes(16).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    db.data.webUsersByEmail[normalizedEmail] = ownerId;
    delete db.data.pendingSignups[normalizedEmail];
    await db.write();

    setSessionCookie(res, ownerId);
    res.json({ ok: true, ownerId, businessName: db.data.owners[ownerId].businessName });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const db = await getDb();
    const normalizedEmail = (email || '').trim().toLowerCase();
    const ownerId = db.data.webUsersByEmail[normalizedEmail];
    const owner = ownerId ? db.data.owners[ownerId] : null;
    if (!owner || !(await bcrypt.compare(password || '', owner.passwordHash || ''))) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    setSessionCookie(res, ownerId);
    res.json({ ok: true, ownerId, businessName: owner.businessName });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', async (req, res) => {
    if (!req.ownerId) return res.json({ loggedIn: false });
    const db = await getDb();
    const owner = db.data.owners[req.ownerId];
    if (!owner) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, ownerId: req.ownerId, businessName: owner.businessName || '' });
  });

  app.post('/api/auth/business-name', requireWebAuth, async (req, res) => {
    const db = await getDb();
    const owner = db.data.owners[req.ownerId];
    owner.businessName = (req.body.businessName || '').trim();
    await db.write();
    res.json({ ok: true, businessName: owner.businessName });
  });

  // ---- Debt management for logged-in web users (cookie-authenticated) ----

  app.get('/api/web/debts', requireWebAuth, async (req, res) => {
    const db = await getDb();
    const debts = db.data.debts
      .filter(d => d.ownerChatId === req.ownerId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(debts);
  });

  app.post('/api/web/debts', requireWebAuth, async (req, res) => {
    const { customerName, phone, amount, dueDate } = req.body;
    const cleanAmount = Number(amount);
    if (!customerName || !phone || !cleanAmount || cleanAmount <= 0) {
      return res.status(400).json({ error: 'Customer name, phone, and a valid amount are required' });
    }
    let digits = String(phone).replace(/[^0-9]/g, '');
    if (digits.startsWith('0')) digits = '234' + digits.slice(1);
    const db = await getDb();
    const debt = {
      id: Date.now().toString(),
      ownerChatId: req.ownerId,
      customerName: customerName.trim(),
      phone: digits,
      amount: cleanAmount,
      amountPaid: 0,
      paid: false,
      dueDate: dueDate || null, // optional, e.g. "2026-10-15"
      createdAt: new Date().toISOString(),
    };
    db.data.debts.push(debt);
    await db.write();
    res.json(debt);
  });

  // SMS reminders need a paid provider (e.g. Termii) — this is honest about
  // that instead of pretending to send something it can't.
  app.post('/api/web/debts/:id/send-sms', requireWebAuth, async (req, res) => {
    if (!process.env.TERMII_API_KEY) {
      return res.status(501).json({
        error: 'SMS reminders need a paid SMS provider connected first (e.g. Termii). Ask your developer to set this up — WhatsApp reminders work today for free.',
      });
    }
    // Once TERMII_API_KEY is set, the actual send call goes here.
    res.status(501).json({ error: 'SMS provider is configured but sending isn\'t wired up yet.' });
  });

  app.post('/api/web/debts/:id/log-payment', requireWebAuth, async (req, res) => {
    const db = await getDb();
    const debt = db.data.debts.find(d => d.id === req.params.id && d.ownerChatId === req.ownerId);
    if (!debt) return res.status(404).json({ error: 'Debt not found' });
    const amount = Number(req.body.amount);
    const owed = debt.amount - (debt.amountPaid || 0);
    if (!amount || amount <= 0 || amount > owed) {
      return res.status(400).json({ error: `Amount must be between 1 and ${owed}` });
    }
    debt.amountPaid = (debt.amountPaid || 0) + amount;
    if (debt.amountPaid >= debt.amount) debt.paid = true;
    await db.write();
    res.json(debt);
  });

  app.post('/api/web/debts/:id/mark-paid', requireWebAuth, async (req, res) => {
    const db = await getDb();
    const debt = db.data.debts.find(d => d.id === req.params.id && d.ownerChatId === req.ownerId);
    if (!debt) return res.status(404).json({ error: 'Debt not found' });
    debt.amountPaid = debt.amount;
    debt.paid = true;
    await db.write();
    res.json(debt);
  });

  app.delete('/api/web/debts/:id', requireWebAuth, async (req, res) => {
    const db = await getDb();
    const debt = db.data.debts.find(d => d.id === req.params.id && d.ownerChatId === req.ownerId);
    if (!debt) return res.status(404).json({ error: 'Debt not found' });
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