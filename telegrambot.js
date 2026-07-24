const { TelegramBot } = require('node-telegram-bot-api');
const { getDb } = require('./db');

const MENU = {
  NEW_DEBT: '➕ New Debt',
  MY_DEBTS: '📋 My Debts',
  MARK_PAID: '✅ Mark Paid',
  DASHBOARD: '📊 Dashboard',
};

const menuKeyboard = {
  reply_markup: {
    keyboard: [
      [MENU.NEW_DEBT, MENU.MY_DEBTS],
      [MENU.MARK_PAID, MENU.DASHBOARD],
    ],
    resize_keyboard: true,
  },
};

// adminChatId identifies YOU — the only person who can approve new users.
function startBot(token, dashboardBaseUrl, adminChatId) {
  const bot = new TelegramBot(token, { polling: true });

  bot.setMyCommands([
    { command: 'newdebt', description: 'Log a new debt' },
    { command: 'debts', description: 'See everyone who owes you' },
    { command: 'paid', description: 'Mark a debt as paid' },
    { command: 'dashboard', description: 'Get your web dashboard link' },
  ]);

  const sessions = {};

  function newSession() {
    return { step: 'awaiting_name' };
  }

  function formatDebtLine(debt, index) {
    const status = debt.paid ? '✅ PAID' : '🔴 UNPAID';
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

  // ---- ACCESS CONTROL ----
  // Returns true if this chatId is allowed to use the bot. If not, it
  // politely blocks them AND notifies you (once) so you can approve them.
  async function checkAccess(chatId, fromUser) {
    if (isAdmin(chatId)) return true;

    const db = await getDb();
    if (db.data.allowedUsers.includes(chatId)) return true;

    // Not approved — let them know, and notify the admin (only the first time)
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
  bot.onText(/\/approve (.+)/, async (msg, match) => {
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
  });

  bot.onText(/\/revoke (.+)/, async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return;
    const targetId = Number(match[1].trim());
    const db = await getDb();
    db.data.allowedUsers = db.data.allowedUsers.filter(id => id !== targetId);
    await db.write();
    bot.sendMessage(msg.chat.id, `Access revoked for chat ID ${targetId}.`);
  });

  bot.onText(/\/pending/, async (msg) => {
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
  });

  // ---- REGULAR ACTIONS (shared by slash commands AND menu button taps) ----

  async function requireBusinessName(chatId, next) {
    const db = await getDb();
    const owner = db.data.owners[chatId];
    if (owner && owner.businessName) {
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

  function beginNewDebt(chatId) {
    sessions[chatId] = newSession();
    bot.sendMessage(chatId, "Let's log a new debt.\n\nWhat's the customer's name?");
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

    const total = unpaid.reduce((sum, d) => sum + d.amount, 0);
    const lines = unpaid.map((d, i) => formatDebtLine(d, i)).join('\n');
    const paidTotal = paid.reduce((sum, d) => sum + d.amount, 0);

    bot.sendMessage(chatId,
      `📋 Outstanding debts:\n\n${lines}\n\n` +
      `Total owed to you: ₦${total.toLocaleString()}\n\n` +
      (paid.length > 0
        ? `✅ ${paid.length} paid debt${paid.length === 1 ? '' : 's'} (₦${paidTotal.toLocaleString()} collected) — view them on your dashboard.`
        : '')
    );
  }

  function showDashboard(chatId) {
    const link = `${dashboardBaseUrl}/dashboard.html?chat=${chatId}`;
    bot.sendMessage(chatId,
      `📊 Here's your personal dashboard link:\n\n${link}\n\n` +
      `Bookmark it — it works on your phone and your computer, and always shows your latest debts.`
    );
  }

  async function beginMarkPaid(chatId) {
    const db = await getDb();
    const myDebts = db.data.debts.filter(d => d.ownerChatId === chatId && !d.paid);

    if (myDebts.length === 0) {
      bot.sendMessage(chatId, "You have no unpaid debts to mark.");
      return;
    }

    const lines = myDebts.map((d, i) => formatDebtLine(d, i)).join('\n');
    bot.sendMessage(chatId, `Which one got paid? Reply with the number:\n\n${lines}`);
    sessions[chatId] = { step: 'awaiting_paid_selection', list: myDebts };
  }

  // ---- SLASH COMMANDS (gated behind access check) ----
  bot.onText(/^\/start$/, async (msg) => {
    if (!(await checkAccess(msg.chat.id, msg.from))) return;
    requireBusinessName(msg.chat.id, () => sendWelcome(msg.chat.id));
  });
  bot.onText(/^\/newdebt$/, async (msg) => {
    if (!(await checkAccess(msg.chat.id, msg.from))) return;
    requireBusinessName(msg.chat.id, () => beginNewDebt(msg.chat.id));
  });
  bot.onText(/^\/debts$/, async (msg) => {
    if (!(await checkAccess(msg.chat.id, msg.from))) return;
    showDebts(msg.chat.id);
  });
  bot.onText(/^\/dashboard$/, async (msg) => {
    if (!(await checkAccess(msg.chat.id, msg.from))) return;
    showDashboard(msg.chat.id);
  });
  bot.onText(/^\/paid$/, async (msg) => {
    if (!(await checkAccess(msg.chat.id, msg.from))) return;
    beginMarkPaid(msg.chat.id);
  });

  // ---- MAIN MESSAGE HANDLER (menu button taps + conversation flow) ----
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';

    if (text.startsWith('/')) return; // handled by onText above

    if (!(await checkAccess(chatId, msg.from))) return;

    if (text === MENU.NEW_DEBT) return requireBusinessName(chatId, () => beginNewDebt(chatId));
    if (text === MENU.MY_DEBTS) return showDebts(chatId);
    if (text === MENU.DASHBOARD) return showDashboard(chatId);
    if (text === MENU.MARK_PAID) return beginMarkPaid(chatId);

    const session = sessions[chatId];
    if (!session) return;

    const db = await getDb();

    if (session.step === 'awaiting_business_name') {
      const next = session.next;
      db.data.owners[chatId] = { businessName: text };
      await db.write();
      delete sessions[chatId];
      bot.sendMessage(chatId, `Got it — reminders will go out as "${text}" ✅`);
      if (next) next();
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

    if (session.step === 'awaiting_paid_selection') {
      const choice = parseInt(text, 10);
      if (!choice || choice < 1 || choice > session.list.length) {
        bot.sendMessage(chatId, "Please reply with a valid number from the list.");
        return;
      }
      const selected = session.list[choice - 1];
      const debtInDb = db.data.debts.find(d => d.id === selected.id);
      debtInDb.paid = true;
      await db.write();
      bot.sendMessage(chatId, `Marked as paid ✅ ${debtInDb.customerName} — ₦${debtInDb.amount.toLocaleString()}`);
      delete sessions[chatId];
      return;
    }
  });

  return bot;
}

module.exports = { startBot };