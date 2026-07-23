const { TelegramBot } = require('node-telegram-bot-api');
const { getDb } = require('./db');

// These are the labels shown on the button menu at the bottom of the chat.
// Keep them here so the menu and the message-matching logic always agree.
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
    resize_keyboard: true, // keeps the buttons compact instead of huge
  },
};

function startBot(token, dashboardBaseUrl) {
  const bot = new TelegramBot(token, { polling: true });

  // This registers the "/" menu icon inside Telegram's own UI too,
  // so both the button menu AND the native slash-command list work.
  bot.setMyCommands([
    { command: 'newdebt', description: 'Log a new debt' },
    { command: 'debts', description: 'See everyone who owes you' },
    { command: 'paid', description: 'Mark a debt as paid' },
    { command: 'dashboard', description: 'Get your web dashboard link' },
  ]);

  // ---- IN-MEMORY CONVERSATION STATE ----
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

  // ---- ACTIONS (shared by both slash commands AND menu button taps) ----

  // Makes sure we know the tradesperson's business name before letting them
  // do anything that eventually sends a message to a customer. Asked once.
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
    const myDebts = db.data.debts.filter(d => d.ownerChatId === chatId && !d.paid);

    if (myDebts.length === 0) {
      bot.sendMessage(chatId, "No unpaid debts logged. Nice and clean ✅");
      return;
    }

    const total = myDebts.reduce((sum, d) => sum + d.amount, 0);
    const lines = myDebts.map((d, i) => formatDebtLine(d, i)).join('\n');
    bot.sendMessage(chatId,
      `📋 Outstanding debts:\n\n${lines}\n\n` +
      `Total owed to you: ₦${total.toLocaleString()}`
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

  // ---- SLASH COMMANDS (still work, in case someone types them) ----
  bot.onText(/\/start/, (msg) => requireBusinessName(msg.chat.id, () => sendWelcome(msg.chat.id)));
  bot.onText(/\/newdebt/, (msg) => requireBusinessName(msg.chat.id, () => beginNewDebt(msg.chat.id)));
  bot.onText(/\/debts/, (msg) => showDebts(msg.chat.id));
  bot.onText(/\/dashboard/, (msg) => showDashboard(msg.chat.id));
  bot.onText(/\/paid/, (msg) => beginMarkPaid(msg.chat.id));

  // ---- MAIN MESSAGE HANDLER (menu button taps + conversation flow) ----
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';

    if (text.startsWith('/')) return; // handled by onText above

    // Menu button taps arrive as plain text matching the button label
    if (text === MENU.NEW_DEBT) return requireBusinessName(chatId, () => beginNewDebt(chatId));
    if (text === MENU.MY_DEBTS) return showDebts(chatId);
    if (text === MENU.DASHBOARD) return showDashboard(chatId);
    if (text === MENU.MARK_PAID) return beginMarkPaid(chatId);

    const session = sessions[chatId];
    if (!session) return;

    const db = await getDb();

    // --- Flow: capturing the business name (asked once, before anything else) ---
    if (session.step === 'awaiting_business_name') {
      const next = session.next;
      db.data.owners[chatId] = { businessName: text };
      await db.write();
      delete sessions[chatId];
      bot.sendMessage(chatId, `Got it — reminders will go out as "${text}" ✅`);
      if (next) next();
      return;
    }

    // --- Flow: logging a new debt ---
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

      // Save right away instead of asking for a separate "yes" — one less step.
      // If it was a mistake, "undo" removes it within the next 60 seconds.
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
      // After 60 seconds, "undo" no longer applies — clear the session quietly.
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

    // --- Flow: marking a debt as paid ---
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