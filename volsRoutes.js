// ═══════════════════════════════════════════════════════════════
// BARRY BETS — VOLS NEWS ROUTES
// Mounted at /api/vols
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { requireAuth } = require('./auth');
const Vols = require('./volsService');

const ADMIN_USER_ID = process.env.CFB_ADMIN_USER_ID
  || '2bd9768c-8a46-47ee-93cf-53be1e2f4fb6';

// The feed is cached for fifteen minutes, so this limit exists to stop a
// stuck client hammering the endpoint, not to protect the sources.
const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/stories', requireAuth, limiter, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 60);
    const out = await Vols.stories({ limit });
    // Which sources answered goes out with the stories: a thin feed should
    // be explainable from the screen, not a mystery.
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forces a real fetch of every source and says what came back. Commissioner
// only — it bypasses the cache and is the tool for pruning a dead feed.
router.get('/health', requireAuth, async (req, res) => {
  try {
    if (!req.user || req.user.id !== ADMIN_USER_ID) {
      return res.status(403).json({ error: 'Commissioner only' });
    }
    res.json(await Vols.health());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
