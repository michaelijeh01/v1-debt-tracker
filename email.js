const nodemailer = require('nodemailer');

// Uses a Gmail account + "App Password" (not your real Gmail password —
// a special 16-character code Google generates for apps like this).
// This is genuinely free — no paid email service needed.
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
    return null;
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_APP_PASSWORD,
    },
    connectionTimeout: 10000, // fail after 10s instead of hanging forever
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
  return transporter;
}

async function sendOtpEmail(toEmail, code) {
  const t = getTransporter();
  if (!t) {
    console.error('❌ Email not configured — set EMAIL_USER and EMAIL_APP_PASSWORD');
    throw new Error('Email sending is not configured on the server yet.');
  }
  await t.sendMail({
    from: `"V1 Debt Tracker" <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject: `Your V1 verification code: ${code}`,
    text: `Your V1 Debt Tracker verification code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    html: `
      <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto;">
        <h2 style="color:#0A0F1F;">V1 <span style="color:#0066FF;">Debt Tracker</span></h2>
        <p>Your verification code is:</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #0066FF;">${code}</p>
        <p style="color:#6B7280; font-size: 13px;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

module.exports = { sendOtpEmail };