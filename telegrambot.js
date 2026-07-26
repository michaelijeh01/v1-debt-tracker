const { TelegramBot } = require('node-telegram-bot-api');
const crypto = require('crypto');
const { getDb } = require('./db');

const MENU = {
  NEW_DEBT: '➕ New Debt',
  MY_DEBTS: '📋 My Debts',
  LOG_PAYMENT: '💰 Log Payment',
  DASHBOARD: '📊 Dashboard',
};

const menuKeyboard = {
  reply_markup: {
    keyboard: [
      [MENU.NEW_DEBT, MENU.MY_DEBTS],
      [MENU.LOG_PAYMENT, MENU.DASHBOARD],
    ],
    resize_keyboard: true,
  },
};

function startBot(token, dashboardBaseUrl, adminChatId) {
  const bot = new TelegramBot(token, { polling: true });

  bot.setMyCommands([
    { command: 'newdebt', description: 'Log a new debt' },
    { command: 'debts', description: 'See everyone who owes you' },
    { command: 'paid', description: 'Log a payment (full or partial)' },
    { command: 'dashboard', description: 'Get your web dashboard link' },
  ]);

  const sessions = {};

  function newSession() {
    return { step: 'awaiting_name' };
  }

  // A debt is only "paid" once the full amount has been collected.
  // Anything collected but less than the full amount is "partial".
  function remaining(debt) {
    return debt.amount - (debt.amountPaid || 0);
  }

  function formatDebtLine(debt, index) {
    let status = '🔴 UNPAID';
    if (debt.paid) {
      status = '✅ PAID';
    } else if (debt.amountPaid > 0) {
      status = `🟡 PARTIAL (₦${debt.amountPaid.toLocaleString()} of ₦${debt.amount.toLocaleString()})`;
    }
    return `${index + 1}. ${debt.customerName} — ₦${debt.amount.toLocaleString()} — ${status}`;
  }

  function cleanPhoneForWhatsApp(rawPhone) {
    let digits = rawPhone.replace(/[^0-9]/g, '');
    if (digits.startsWith('0')) {
      digits = '234' + digits.slice(1);
    }
    return digits;
  }

  function isAdmin(chatId) {
    return adminChatId && chatId === adminChatId;
  }

  function safe(handler) {
    return async (...args) => {
      try {
        await handler(...args);
      } catch (err) {
        console.error('❌ Bot handler error:', err);
        const chatId = args[0]?.chat?.id;
        if (chatId) {
          bot.sendMessage(chatId, "Something went wrong on my end. Please try again in a moment.")
            .catch(() => {});
        }
      }
    };
  }

  // ---- ACCESS CONTROL ----
  async function checkAccess(chatId, fromUser) {
    if (isAdmin(chatId)) return true;

    const db = await getDb();
    if (db.data.allowedUsers.includes(chatId)) return true;

    const alreadyRequested = db.data.accessRequests.some(r => r.chatId === chatId);
    if (!alreadyRequested) {
      const name = fromUser.username ? `@${fromUser.username}` : (fromUser.first_name || 'Someone');
      db.data.accessRequests.push({ chatId, name, requestedAt: new Date().toISOString() });
      await db.write();

      if (adminChatId) {
        bot.sendMessage(adminChatId,
          `🔒 New access request from ${name} (chat ID: ${chatId}).\n\n` +
          `Reply with:\n/approve ${chatId}\n\nto let them in.`
        );
      }
    }

    bot.sendMessage(chatId,
      `This bot is currently invite-only. I've let the owner know you're interested — they'll approve you shortly.`
    );
    return false;
  }

  // ---- ADMIN-ONLY COMMANDS ----
  bot.onText(/\/approve (.+)/, safe(async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return;
    const targetId = Number(match[1].trim());
    if (!targetId) {
      bot.sendMessage(msg.chat.id, "Couldn't read that chat ID. Use: /approve 123456789");
      return;
    }
    const db = await getDb();
    if (!db.data.allowedUsers.includes(targetId)) {
      db.data.allowedUsers.push(targetId);
    }
    db.data.accessRequests = db.data.accessRequests.filter(r => r.chatId !== targetId);
    await db.write();

    bot.sendMessage(msg.chat.id, `✅ Approved chat ID ${targetId}. They can now use the bot.`);
    bot.sendMessage(targetId, `You've been approved ✅ Send /start to get going.`);
  }));

  bot.onText(/\/revoke (.+)/, safe(async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return;
    const targetId = Number(match[1].trim());
    const db = await getDb();
    db.data.allowedUsers = db.data.allowedUsers.filter(id => id !== targetId);
    await db.write();
    bot.sendMessage(msg.chat.id, `Access revoked for chat ID ${targetId}.`);
  }));

  bot.onText(/\/pending/, safe(async (msg) => {
    if (!isAdmin(msg.chat.id)) return;
    const db = await getDb();
    if (db.data.accessRequests.length === 0) {
      bot.sendMessage(msg.chat.id, "No pending access requests.");
      return;
    }
    const lines = db.data.accessRequests
      .map(r => `${r.name} — chat ID: ${r.chatId}`)
      .join('\n');
    bot.sendMessage(msg.chat.id, `Pending requests:\n\n${lines}`);
  }));

  // ---- REGULAR ACTIONS ----

  // Makes sure this chat has an owner record with a business name AND a
  // dashboard access token (a long random secret so random/guessed chat
  // IDs can't view someone else's debts from the dashboard link).
  async function ensureOwner(chatId) {
    const db = await getDb();
    if (!db.data.owners[chatId]) {
      db.data.owners[chatId] = {};
    }
    if (!db.data.owners[chatId].dashboardToken) {
      db.data.owners[chatId].dashboardToken = crypto.randomBytes(16).toString('hex');
      await db.write();
    }
    return db.data.owners[chatId];
  }

  async function requireBusinessName(chatId, next) {
    const owner = await ensureOwner(chatId);
    if (owner.businessName) {
      next();
      return;
    }
    sessions[chatId] = { step: 'awaiting_business_name', next };
    bot.sendMessage(chatId,
      `First, what's your business name?\n\n` +
      `This appears on the payment reminders your customers receive, ` +
      `so they know it's really from you (e.g. "David's Electricals").`
    );
  }

  function sendWelcome(chatId) {
    bot.sendMessage(chatId,
      `Welcome to V1 👋\n\nI help you track who owes you money.\n\n` +
      `Use the menu below anytime — no need to type commands.`,
      menuKeyboard
    );
  }

  // Looks up everyone this tradesperson has logged before, so returning
  // customers can be picked from a list instead of retyped every time.
  async function getKnownCustomers(chatId) {
    const db = await getDb();
    const myDebts = db.data.debts.filter(d => d.ownerChatId === chatId);
    const seen = new Map(); // phone -> {customerName, phone}
    for (const d of myDebts) {
      if (!seen.has(d.phone)) {
        seen.set(d.phone, { customerName: d.customerName, phone: d.phone });
      }
    }
    return [...seen.values()];
  }

  async function beginNewDebt(chatId) {
    const knownCustomers = await getKnownCustomers(chatId);

    if (knownCustomers.length === 0) {
      sessions[chatId] = newSession();
      bot.sendMessage(chatId, "Let's log a new debt.\n\nWhat's the customer's name?");
      return;
    }

    const lines = knownCustomers.map((c, i) => `${i + 1}. ${c.customerName}`).join('\n');
    bot.sendMessage(chatId,
      `Who is this for?\n\n${lines}\n\n` +
      `Reply with a number to pick one, or type a new customer's name.`
    );
    sessions[chatId] = { step: 'awaiting_name_or_pick', knownCustomers };
  }

  async function showDebts(chatId) {
    const db = await getDb();
    const myDebts = db.data.debts.filter(d => d.ownerChatId === chatId);
    const unpaid = myDebts.filter(d => !d.paid);
    const paid = myDebts.filter(d => d.paid);

    if (myDebts.length === 0) {
      bot.sendMessage(chatId, "No debts logged yet. Tap ➕ New Debt to add your first one.");
      return;
    }

    if (unpaid.length === 0) {
      bot.sendMessage(chatId, "No unpaid debts logged. Nice and clean ✅");
      return;
    }

    const total = unpaid.reduce((sum, d) => sum + remaining(d), 0);
    const lines = unpaid.map((d, i) => formatDebtLine(d, i)).join('\n');
    const paidTotal = paid.reduce((sum, d) => sum + d.amount, 0);

    bot.sendMessage(chatId,
      `📋 Outstanding debts:\n\n${lines}\n\n` +
      `Total still owed to you: ₦${total.toLocaleString()}\n\n` +
      (paid.length > 0
        ? `✅ ${paid.length} paid debt${paid.length === 1 ? '' : 's'} (₦${paidTotal.toLocaleString()} collected) — view them on your dashboard.`
        : '')
    );
  }

  async function showDashboard(chatId) {
    const owner = await ensureOwner(chatId);
    const link = `${dashboardBaseUrl}/dashboard.html?chat=${chatId}&token=${owner.dashboardToken}`;
    bot.sendMessage(chatId,
      `📊 Here's your personal dashboard link:\n\n${link}\n\n` +
      `Bookmark it — it works on your phone and your computer, and always shows your latest debts.\n\n` +
      `⚠️ Keep this link private — anyone who has it can see and update your debts.`
    );
  }

  async function beginLogPayment(chatId) {
    const db = await getDb();
    const myDebts = db.data.debts.filter(d => d.ownerChatId === chatId && !d.paid);

    if (myDebts.length === 0) {
      bot.sendMessage(chatId, "You have no unpaid or partially paid debts right now.");
      return;
    }

    const lines = myDebts.map((d, i) => formatDebtLine(d, i)).join('\n');
    bot.sendMessage(chatId, `Who paid? Reply with the number:\n\n${lines}`);
    sessions[chatId] = { step: 'awaiting_payment_selection', list: myDebts };
  }

  // ---- SLASH COMMANDS ----
  bot.onText(/^\/start$/, safe(async (msg) => {
    if (!(await checkAccess(msg.chat.id, msg.from))) return;
    requireBusinessName(msg.chat.id, () => sendWelcome(msg.chat.id));
  }));
  bot.onText(/^\/newdebt$/, safe(async (msg) => {
    if (!(await checkAccess(msg.chat.id, msg.from))) return;
    requireBusinessName(msg.chat.id, () => beginNewDebt(msg.chat.id));
  }));
  bot.onText(/^\/debts$/, safe(async (msg) => {
    if (!(await checkAccess(msg.chat.id, msg.from))) return;
    showDebts(msg.chat.id);
  }));
  bot.onText(/^\/dashboard$/, safe(async (msg) => {
    if (!(await checkAccess(msg.chat.id, msg.from))) return;
    showDashboard(msg.chat.id);
  }));
  bot.onText(/^\/paid$/, safe(async (msg) => {
    if (!(await checkAccess(msg.chat.id, msg.from))) return;
    beginLogPayment(msg.chat.id);
  }));

  // ---- MAIN MESSAGE HANDLER ----
  bot.on('message', safe(async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';

    if (text.startsWith('/')) return;

    if (!(await checkAccess(chatId, msg.from))) return;

    if (text === MENU.NEW_DEBT) return requireBusinessName(chatId, () => beginNewDebt(chatId));
    if (text === MENU.MY_DEBTS) return showDebts(chatId);
    if (text === MENU.DASHBOARD) return showDashboard(chatId);
    if (text === MENU.LOG_PAYMENT) return beginLogPayment(chatId);

    const session = sessions[chatId];
    if (!session) return;

    const db = await getDb();

    if (session.step === 'awaiting_business_name') {
      const next = session.next;
      const owner = await ensureOwner(chatId);
      owner.businessName = text;
      await db.write();
      delete sessions[chatId];
      bot.sendMessage(chatId, `Got it — reminders will go out as "${text}" ✅`);
      if (next) next();
      return;
    }

    // --- Picking an existing customer, or typing a new name ---
    if (session.step === 'awaiting_name_or_pick') {
      const choice = parseInt(text, 10);
      if (choice && choice >= 1 && choice <= session.knownCustomers.length) {
        const picked = session.knownCustomers[choice - 1];
        session.customerName = picked.customerName;
        session.phone = picked.phone;
        session.step = 'awaiting_amount';
        bot.sendMessage(chatId, `Got it. How much does ${picked.customerName} owe you? (numbers only, e.g. 8000)`);
        return;
      }
      // Not a valid number — treat it as a brand new customer's name
      session.customerName = text;
      session.step = 'awaiting_phone';
      bot.sendMessage(chatId, `What's ${text}'s phone number? (needed for the WhatsApp reminder, e.g. 08031234567)`);
      return;
    }

    if (session.step === 'awaiting_name') {
      session.customerName = text;
      session.step = 'awaiting_phone';
      bot.sendMessage(chatId, `What's ${text}'s phone number? (needed for the WhatsApp reminder, e.g. 08031234567)`);
      return;
    }

    if (session.step === 'awaiting_phone') {
      const digits = text.replace(/[^0-9]/g, '');
      if (digits.length < 10) {
        bot.sendMessage(chatId, "That doesn't look like a valid phone number. Please try again, e.g. 08031234567");
        return;
      }
      session.phone = cleanPhoneForWhatsApp(text);
      session.step = 'awaiting_amount';
      bot.sendMessage(chatId, `Got it. How much does ${session.customerName} owe you? (numbers only, e.g. 8000)`);
      return;
    }

    if (session.step === 'awaiting_amount') {
      const amount = Number(text.replace(/[^0-9.]/g, ''));
      if (!amount || amount <= 0) {
        bot.sendMessage(chatId, "That doesn't look like a valid amount. Please send a number, e.g. 8000");
        return;
      }

      const debt = {
        id: Date.now().toString(),
        ownerChatId: chatId,
        customerName: session.customerName,
        phone: session.phone,
        amount,
        amountPaid: 0,
        paid: false,
        createdAt: new Date().toISOString(),
      };
      db.data.debts.push(debt);
      await db.write();

      bot.sendMessage(chatId,
        `Saved ✅ ${session.customerName} — ₦${amount.toLocaleString()}\n\n` +
        `Made a mistake? Reply "undo" in the next minute to remove it.`
      );

      sessions[chatId] = { step: 'just_saved', debtId: debt.id };
      setTimeout(() => {
        if (sessions[chatId] && sessions[chatId].debtId === debt.id) {
          delete sessions[chatId];
        }
      }, 60000);
      return;
    }

    if (session.step === 'just_saved') {
      if (text.toLowerCase() === 'undo') {
        db.data.debts = db.data.debts.filter(d => d.id !== session.debtId);
        await db.write();
        bot.sendMessage(chatId, "Removed. That debt is no longer logged.");
      }
      delete sessions[chatId];
      return;
    }

    // --- Logging a payment (full or partial) ---
    if (session.step === 'awaiting_payment_selection') {
      const choice = parseInt(text, 10);
      if (!choice || choice < 1 || choice > session.list.length) {
        bot.sendMessage(chatId, "Please reply with a valid number from the list.");
        return;
      }
      const selected = session.list[choice - 1];
      const left = remaining(selected);
      bot.sendMessage(chatId,
        `${selected.customerName} still owes ₦${left.toLocaleString()}.\n\n` +
        `How much did they just pay? Reply with an amount, or type "full" for the whole ₦${left.toLocaleString()}.`
      );
      sessions[chatId] = { step: 'awaiting_payment_amount', debtId: selected.id };
      return;
    }

    if (session.step === 'awaiting_payment_amount') {
      const debtInDb = db.data.debts.find(d => d.id === session.debtId);
      if (!debtInDb) {
        bot.sendMessage(chatId, "Couldn't find that debt anymore — it may have been removed.");
        delete sessions[chatId];
        return;
      }
      const left = remaining(debtInDb);
      let paymentAmount;
      if (text.toLowerCase() === 'full') {
        paymentAmount = left;
      } else {
        paymentAmount = Number(text.replace(/[^0-9.]/g, ''));
      }

      if (!paymentAmount || paymentAmount <= 0) {
        bot.sendMessage(chatId, `That doesn't look like a valid amount. Reply with a number, or "full" for ₦${left.toLocaleString()}.`);
        return;
      }
      if (paymentAmount > left) {
        bot.sendMessage(chatId, `That's more than they owe (₦${left.toLocaleString()} left). Please enter a smaller amount.`);
        return;
      }

      debtInDb.amountPaid = (debtInDb.amountPaid || 0) + paymentAmount;
      if (debtInDb.amountPaid >= debtInDb.amount) {
        debtInDb.paid = true;
      }
      await db.write();

      const stillOwed = remaining(debtInDb);
      bot.sendMessage(chatId,
        debtInDb.paid
          ? `Marked as fully paid ✅ ${debtInDb.customerName} — ₦${debtInDb.amount.toLocaleString()}`
          : `Payment logged ✅ ₦${paymentAmount.toLocaleString()} from ${debtInDb.customerName}.\n\n` +
            `Remaining balance: ₦${stillOwed.toLocaleString()}`
      );
      delete sessions[chatId];
      return;
    }
  }));

  return bot;
}

module.exports = { startBot };