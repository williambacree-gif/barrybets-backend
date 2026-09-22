// ═══════════════════════════════════════════════════════════════
// BARRY BETS — GAS PRICE ROUTE
// Mounted at /api/gas
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { requireAuth } = require('./auth');
const Gas = require('./gasService');

// Cached for an hour upstream, so this only exists to stop a stuck client
// from spinning.
const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/', requireAuth, limiter, async (req, res) => {
  try {
    const out = await Gas.current();
    // null means we have never had a good read. The ticker hides itself.
    res.json(out || { price: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
