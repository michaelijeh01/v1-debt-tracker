# V1 — Step 2: Web Dashboard (Phone + PC access)

## What changed from Step 1

- `bot.js` is gone — replaced by 3 organized files: `db.js` (shared database), `telegramBot.js` (bot logic), `server.js` (dashboard API)
- `index.js` is now the file you run — it starts both the bot AND the dashboard together
- The bot now asks for the customer's **phone number** too (needed to send WhatsApp reminders)
- New command: `/dashboard` — sends you your personal dashboard link

## Update your files

1. Delete your old `bot.js` if it's still in your folder (it's replaced)
2. Add the new files: `db.js`, `telegramBot.js`, `server.js`, `index.js`, and the `public` folder with `dashboard.html` inside it
3. In your terminal:
   ```
   npm install
   ```
   (this pulls in Express, needed for the dashboard)

## Test it locally first

```
npm start
```

You should see:

```
✅ Dashboard server running on port 3000
✅ V1 is fully running: bot + dashboard.
   Dashboard base URL: http://localhost:3000
```

On Telegram, send `/dashboard` to your bot. It'll reply with a link like:
`http://localhost:3000/dashboard.html?chat=123456789`

Open that link **on the same computer** (localhost only works on the machine running the server) — you should see your debts, a total, and a green "Remind" button that opens WhatsApp with a pre-written message.

Test the full loop:

1. `/newdebt` on Telegram → now asks for name, phone, then amount
2. Open your dashboard link → see the debt appear
3. Tap "Remind" → confirm WhatsApp opens with the message pre-filled
4. Tap "Mark Paid" on the dashboard → refresh → debt should disappear from outstanding

## Getting it on your phone too (deploying online)

Right now this only works on your PC because it's running on `localhost`. To access it from your phone, we deploy it to Railway (free tier) so it has a real public web address. Once you've confirmed the local test works cleanly, tell me and we'll do the Railway deployment step together — it needs a couple of settings (your `BOT_TOKEN` and the live URL) added there.

Don't deploy yet if local testing hasn't fully worked — easier to catch issues here first.
