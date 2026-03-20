require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const apiRoutes = require('./api');
const ESPNScoreService = require('./espnScoreService');

const app = express();
const PORT = process.env.PORT || 3000;
const TOURNAMENT_ID = '00000000-0000-0000-0000-000000002026';

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(morgan('dev'));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));
app.use('/api', apiRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'alive', app: 'Barry Bets Survivor', tournament: '2026 NCAA March Madness', timestamp: new Date().toISOString() });
});

// Check ESPN scores every 5 minutes during game hours
cron.schedule('*/5 11-23 * 3-4 *', async () => {
  console.log('[Cron] Checking ESPN for scores...');
  try {
    const scoreResult = await ESPNScoreService.syncScoresToGames(TOURNAMENT_ID);
    if (scoreResult.updated > 0) {
      console.log('[Cron] Updated ' + scoreResult.updated + ' scores');
      const pickResult = await ESPNScoreService.scorePicks(TOURNAMENT_ID);
      console.log('[Cron] Scored ' + pickResult.scored + ' picks');
    }
  } catch (err) { console.error('[Cron] Score sync failed:', err.message); }
});

// Late night check
cron.schedule('*/5 0-1 * 3-4 *', async () => {
  try {
    const scoreResult = await ESPNScoreService.syncScoresToGames(TOURNAMENT_ID);
    if (scoreResult.updated > 0) {
      await ESPNScoreService.scorePicks(TOURNAMENT_ID);
    }
  } catch (err) { console.error('[Cron] Late sync failed:', err.message); }
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

app.listen(PORT, () => {
  console.log('Barry Bets Survivor running on port ' + PORT);
  // Run initial score check on startup
  setTimeout(async () => {
    console.log('[Startup] Running initial score sync...');
    try {
      const result = await ESPNScoreService.syncScoresToGames(TOURNAMENT_ID);
      console.log('[Startup] Synced ' + result.updated + ' scores');
      if (result.updated > 0) {
        const pickResult = await ESPNScoreService.scorePicks(TOURNAMENT_ID);
        console.log('[Startup] Scored ' + pickResult.scored + ' picks');
      }
    } catch(err) { console.error('[Startup] Initial sync failed:', err.message); }
  }, 5000);
});
module.exports = app;
