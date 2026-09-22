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

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { supabaseAdmin } = require('./supabase');

const RESEND_KEY = process.env.RESEND_API_KEY;
// Barry Bets sends from its own domain, verified in Resend on Sep 21 2026
// with DKIM at resend._domainkey. Sending from the1788s.org meant the
// address, the branding and the reset link all disagreed, which is exactly
// the shape spam filters punish — and did: Perk's reset never reached him.
const FROM = 'Barry Bets <picks@barrysbets.net>';
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

// A reset link handed back, rather than emailed.
//
// Email is the weak link in this flow. The message leaves here fine and
// then Gmail decides what to do with it, which is how Perk sat locked out
// for two days over a link that had been minted and accepted. When someone
// is locked out and the mail has vanished, mint a link here and text it.
//
// Guarded by the same shared secret as the other admin routes, and narrowed
// further: it will only mint for somebody who is actually a player in one
// of the pools. A leaked token is then worth four accounts, not every
// account, and not a stranger's.
router.get('/admin-link', async (req, res) => {
  const expected = process.env.MNF_ADMIN_TOKEN;
  if (!expected) return res.status(503).json({ error: 'MNF_ADMIN_TOKEN not configured' });
  if ((req.headers['x-admin-token'] || req.query.token) !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') < 1) {
    return res.status(400).json({ error: 'Pass ?email=' });
  }

  try {
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: email,
      options: { redirectTo: SITE_URL },
    });

    const link = data && data.properties && data.properties.action_link;
    if (error || !link) {
      return res.status(404).json({ error: error ? error.message : 'No account for that address' });
    }

    const uid = data.user && data.user.id;
    const [cfb, mnf] = await Promise.all([
      supabaseAdmin.from('cfb_players').select('id').eq('user_id', uid).limit(1),
      supabaseAdmin.from('mnf_players').select('id').eq('user_id', uid).limit(1),
    ]);
    if (!(cfb.data || []).length && !(mnf.data || []).length) {
      return res.status(403).json({ error: 'That address is not a player in either pool' });
    }

    console.log('[Reset] admin minted a link for', email);
    res.json({
      ok: true,
      email: email,
      link: link,
      note: 'Send this to him directly. Good for one hour, and only once.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// REDEEM A COMMISSIONER-ISSUED RESET LINK
//
// Open to signed-out people by necessity — the whole point is that the
// man cannot get in. So it is rate limited hard, says nothing about which
// links exist, and the token is matched by hash, never stored in the
// clear.
//
// A link is good for one password and then it is spent, so a text message
// sitting in someone's history is worth nothing after it has been used.
// ─────────────────────────────────────────────────────────────
const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/redeem-reset', redeemLimiter, async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || '');
    const password = String((req.body && req.body.password) || '');

    if (!token) return res.status(400).json({ error: 'That link is missing its code' });
    if (password.length < 8) {
      return res.status(400).json({ error: 'Pick a password of at least 8 characters' });
    }

    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const { data: row } = await supabaseAdmin
      .from('bb_reset_tokens')
      .select('id, user_id, email, expires_at, used_at')
      .eq('token_hash', hash)
      .maybeSingle();

    // One message for every failure: wrong code, already used, expired.
    // Distinguishing them would tell a stranger which codes are real.
    const dead = !row || row.used_at || new Date(row.expires_at) <= new Date();
    if (dead) {
      return res.status(400).json({
        error: 'That link has expired or has already been used. Ask Will for a fresh one.',
      });
    }

    const { error: uErr } = await supabaseAdmin.auth.admin
      .updateUserById(row.user_id, { password });
    if (uErr) throw uErr;

    // Spend it only after the password actually changed, so a failure here
    // does not burn the link and leave him locked out twice.
    await supabaseAdmin.from('bb_reset_tokens')
      .update({ used_at: new Date().toISOString() }).eq('id', row.id);

    console.log(`[Reset] Commissioner link redeemed for ${row.email}`);
    res.json({ ok: true, email: row.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
