// ═══════════════════════════════════════════════════════════════
// BARRY BETS — PUSH SUBSCRIPTION ROUTES
// Mounted at /api/push
//
// A phone subscribes itself here. Nothing in this file can send anything
// to anyone else: /test only ever reaches the man who called it.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { requireAuth } = require('./auth');
const { supabaseAdmin } = require('./supabase');
const Push = require('./pushService');

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(requireAuth, limiter);

// The browser needs the public key before it can subscribe.
router.get('/key', async (req, res) => {
  try {
    res.json({ key: await Push.publicKey() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Is this man already set up, and on how many devices?
router.get('/status', async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('bb_push_subs').select('id, label, created_at').eq('user_id', req.user.id);
    res.json({ devices: (data || []).length, list: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/subscribe', async (req, res) => {
  try {
    const { subscription, label } = req.body || {};
    const ep = subscription && subscription.endpoint;
    const k = (subscription && subscription.keys) || {};
    if (!ep || !k.p256dh || !k.auth) {
      return res.status(400).json({ error: 'That is not a usable subscription' });
    }

    // The endpoint is the identity of a device. Re-subscribing on the same
    // phone must not pile up rows, and a phone handed to someone else must
    // follow its new owner.
    const { error } = await supabaseAdmin.from('bb_push_subs').upsert({
      user_id: req.user.id,
      endpoint: ep,
      p256dh: k.p256dh,
      auth: k.auth,
      label: (label || '').toString().slice(0, 60) || null,
      fail_count: 0,
    }, { onConflict: 'endpoint' });
    if (error) throw error;

    console.log(`[Push] subscribed a device for ${req.user.id}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    const q = supabaseAdmin.from('bb_push_subs').delete().eq('user_id', req.user.id);
    // No endpoint means "this man, everywhere" — used by a Turn off button.
    const { error } = endpoint ? await q.eq('endpoint', endpoint) : await q;
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Proves the whole chain works, to the caller and nobody else.
router.post('/test', async (req, res) => {
  try {
    const out = await Push.sendToUsers([req.user.id], {
      title: 'Barry Bets',
      body: 'That worked. This is what a pick reminder will look like.',
      url: (process.env.SITE_URL || 'https://www.barrysbets.net') + '/',
      tag: 'test',
    });
    if (!out.sent) {
      return res.status(400).json({
        error: out.targeted && !out.gone
          ? 'No device is subscribed yet on this account'
          : 'The subscription was rejected — turn notifications off and on again',
        detail: out,
      });
    }
    res.json({ ok: true, ...out });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
