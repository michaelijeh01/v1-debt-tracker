const { TelegramBot } = require('node-telegram-bot-api');
const { getDb } = require('./db');

function startBot(token, dashboardBaseUrl) {
  const bot = new TelegramBot(token, { polling: true });

  // ---- IN-MEMORY CONVERSATION STATE ----
  // Tracks where each user is in the "log a new debt" flow.
  const sessions = {};

  function newSession() {
    return { step: 'awaiting_name' };
  }

  function formatDebtLine(debt, index) {
    const status = debt.paid ? '✅ PAID' : '🔴 UNPAID';
    return `${index + 1}. ${debt.customerName} — ₦${debt.amount.toLocaleString()} — ${status}`;
  }

  // Cleans a phone number into WhatsApp's expected format (digits only, country code, no +/spaces)
  function cleanPhoneForWhatsApp(rawPhone) {
    let digits = rawPhone.replace(/[^0-9]/g, '');
    // Nigerian numbers typed as 0803... need the leading 0 replaced with 234
    if (digits.startsWith('0')) {
      digits = '234' + digits.slice(1);
    }
    return digits;
  }

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
      `Welcome to V1 👋\n\nI help you track who owes you money.\n\n` +
      `Commands:\n` +
      `/newdebt - log a new debt\n` +
      `/debts - see everyone who owes you\n` +
      `/paid - mark a debt as paid\n` +
      `/dashboard - get your web dashboard link`
    );
  });

  bot.onText(/\/newdebt/, (msg) => {
    const chatId = msg.chat.id;
    sessions[chatId] = newSession();
    bot.sendMessage(chatId, "Let's log a new debt.\n\nWhat's the customer's name?");
  });

  bot.onText(/\/debts/, async (msg) => {
    const chatId = msg.chat.id;
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
      `Total owed to you: ₦${total.toLocaleString()}\n\n` +
      `See the full dashboard and send reminders at your dashboard link.`
    );
  });

  bot.onText(/\/dashboard/, (msg) => {
    const chatId = msg.chat.id;
    const link = `${dashboardBaseUrl}/dashboard.html?chat=${chatId}`;
    bot.sendMessage(chatId,
      `📊 Here's your personal dashboard link:\n\n${link}\n\n` +
      `Bookmark it — it works on your phone and your computer, and always shows your latest debts.`
    );
  });

  bot.onText(/\/paid/, async (msg) => {
    const chatId = msg.chat.id;
    const db = await getDb();
    const myDebts = db.data.debts.filter(d => d.ownerChatId === chatId && !d.paid);

    if (myDebts.length === 0) {
      bot.sendMessage(chatId, "You have no unpaid debts to mark.");
      return;
    }

    const lines = myDebts.map((d, i) => formatDebtLine(d, i)).join('\n');
    bot.sendMessage(chatId, `Which one got paid? Reply with the number:\n\n${lines}`);
    sessions[chatId] = { step: 'awaiting_paid_selection', list: myDebts };
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';

    if (text.startsWith('/')) return;

    const session = sessions[chatId];
    if (!session) return;

    const db = await getDb();

    // --- Flow: logging a new debt ---
    if (session.step === 'awaiting_name') {
      session.customerName = text;
      session.step = 'awaiting_phone';
      bot.sendMessage(chatId, `What's ${text}'s phone number? (this is needed to send them a WhatsApp reminder later, e.g. 08031234567)`);
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
      session.amount = amount;
      session.step = 'awaiting_confirm';
      bot.sendMessage(chatId,
        `Confirm:\n\n${session.customerName} owes ₦${amount.toLocaleString()}\n\n` +
        `Reply "yes" to save, or "cancel" to stop.`
      );
      return;
    }

    if (session.step === 'awaiting_confirm') {
      if (text.toLowerCase() === 'yes') {
        const debt = {
          id: Date.now().toString(),
          ownerChatId: chatId,
          customerName: session.customerName,
          phone: session.phone,
          amount: session.amount,
          paid: false,
          createdAt: new Date().toISOString(),
        };
        db.data.debts.push(debt);
        await db.write();
        bot.sendMessage(chatId, `Saved ✅ ${session.customerName} — ₦${session.amount.toLocaleString()}\n\nUse /debts anytime to see everyone who owes you.`);
      } else {
        bot.sendMessage(chatId, "Cancelled. Nothing was saved.");
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