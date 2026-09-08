// ═══════════════════════════════════════════════════════════════
// BARRY BETS — password reset that actually delivers
// Mounted at /api/auth
//
// Why this exists: Supabase Auth here runs on the built-in email
// service, which only delivers to members of the Supabase org and is
// rate limited to a handful an hour. Every other player who hit
// "Forgot password?" got a green success message and no email, ever.
//
// So the recovery link is minted here with the service role and sent
// through Resend — the same sender the pick reminders already use —
// rather than trusting Supabase to deliver the mail.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { supabaseAdmin } = require('./supabase');

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM = 'Barry Bets <picks@the1788s.org>';
const SITE_URL = process.env.SITE_URL || 'https://www.barrysbets.net';

// This endpoint has to be open to signed-out people, so it gets a
// tighter limit than the app-wide one.
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: true },
});

function resetEmailHtml(link, name) {
  return '<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px">' +
    '<div style="text-align:center;padding:16px 0;border-bottom:2px solid #1a2744">' +
    '<h1 style="font-size:24px;color:#1a2744;margin:0">BARRY BETS</h1>' +
    '<p style="font-size:11px;letter-spacing:3px;color:#8b6914;margin:4px 0 0">EST. 2026</p></div>' +
    '<div style="padding:24px 0">' +
    '<p style="font-size:16px;color:#1a2744">Hey ' + (name || 'there') + ',</p>' +
    '<p style="font-size:15px;color:#555;line-height:1.6">Someone asked to reset the password on your ' +
    'Barry Bets account. Tap below and you can set a new one. The link is good for one hour.</p>' +
    '<div style="text-align:center;margin:28px 0">' +
    '<a href="' + link + '" style="background:#8b6914;color:#f5f0e8;padding:14px 34px;' +
    'text-decoration:none;font-size:13px;letter-spacing:2px;display:inline-block">SET A NEW PASSWORD</a></div>' +
    '<p style="font-size:13px;color:#999;line-height:1.6">If you didn\'t ask for this, ignore it — ' +
    'nothing changes until you use the link.</p>' +
    '<p style="font-size:13px;color:#999;text-align:center;margin-top:24px">barrysbets.net</p>' +
    '</div></div>';
}

router.post('/request-reset', resetLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();

  // The answer is the same no matter what happens below. Anything more
  // honest would let a stranger test which addresses have accounts.
  const done = () => res.json({ ok: true });

  if (!email || email.indexOf('@') < 1) return done();

  try {
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: email,
      options: { redirectTo: SITE_URL },
    });

    const link = data && data.properties && data.properties.action_link;
    if (error || !link) {
      console.log('[Reset] no link for', email, '—', error ? error.message : 'no action_link');
      return done();
    }
    if (!RESEND_KEY) {
      console.error('[Reset] RESEND_API_KEY is not set — link minted but cannot be sent');
      return done();
    }

    const name = (data.user && data.user.user_metadata && data.user.user_metadata.display_name) || '';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: email,
        subject: 'Reset your Barry Bets password',
        html: resetEmailHtml(link, name),
      }),
    });

    if (r.ok) console.log('[Reset] sent to', email);
    else console.error('[Reset] Resend refused:', r.status, await r.text());
  } catch (err) {
    console.error('[Reset] failed:', err.message);
  }

  return done();
});

module.exports = router;
