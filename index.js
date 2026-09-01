require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const apiRoutes = require('./api');
const ESPNScoreService = require('./espnScoreService');
const mastersRoutes = require('./mastersRoutes');
const mnfRoutes = require('./mnfRoutes');
const MNFService = require('./mnfService');
const { supabaseAdmin } = require('./supabase');

const app = express();
const PORT = process.env.PORT || 3000;
const TOURNAMENT_ID = '00000000-0000-0000-0000-000000002026';
const ET = { timezone: 'America/New_York' };

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(morgan('dev'));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));
app.use('/api', apiRoutes);
app.use('/api/masters', mastersRoutes);
app.use('/api/mnf', mnfRoutes);

app.get('/api/health', (req, res) => {
    res.json({ status: 'alive', app: 'Barry Bets', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════
// MARCH MADNESS — unchanged, only runs in March/April
// ═══════════════════════════════════════════════════════════════

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

cron.schedule('*/5 0-1 * 3-4 *', async () => {
    try {
        const scoreResult = await ESPNScoreService.syncScoresToGames(TOURNAMENT_ID);
        if (scoreResult.updated > 0) await ESPNScoreService.scorePicks(TOURNAMENT_ID);
    } catch (err) { console.error('[Cron] Late sync failed:', err.message); }
});

// ═══════════════════════════════════════════════════════════════
// MONDAY NIGHT FOOTBALL
// ═══════════════════════════════════════════════════════════════

async function activeMnfSeason() {
    const { data } = await supabaseAdmin
        .from('mnf_seasons').select('id, year')
        .eq('status', 'active').order('year', { ascending: false })
        .limit(1).maybeSingle();
    return data;
}

// Freeze the spread Wednesday 9:00 AM ET. This is the number that grades
// the week — once written it is never overwritten.
cron.schedule('0 9 * * 3', async () => {
    try {
        const season = await activeMnfSeason();
        if (!season) return;
        const result = await MNFService.freezeSpreads(season.id);
        console.log('[MNF Cron] Freeze:', JSON.stringify(result));
    } catch (err) { console.error('[MNF Cron] Freeze failed:', err.message); }
}, ET);

// Retries, in case the books had not posted a line at 9am.
cron.schedule('0 13 * * 3', async () => {
    try {
        const season = await activeMnfSeason();
        if (season) await MNFService.freezeSpreads(season.id);
    } catch (err) { console.error('[MNF Cron] Freeze retry failed:', err.message); }
}, ET);

cron.schedule('0 9 * * 4', async () => {
    try {
        const season = await activeMnfSeason();
        if (season) await MNFService.freezeSpreads(season.id);
    } catch (err) { console.error('[MNF Cron] Thursday freeze failed:', err.message); }
}, ET);

// Monday night: auto-assign missed picks at kickoff, then track the score
// and grade as soon as it goes final.
cron.schedule('*/5 20-23 * * 1', async () => {
    try {
        const season = await activeMnfSeason();
        if (!season) return;
        const result = await MNFService.runWeeklyPipeline(season.id);
        if (result.graded.graded > 0 || result.assigned.assigned > 0) {
            console.log('[MNF Cron] Pipeline:', JSON.stringify(result));
        }
    } catch (err) { console.error('[MNF Cron] Monday pipeline failed:', err.message); }
}, ET);

// Games run past midnight ET.
cron.schedule('*/5 0-1 * * 2', async () => {
    try {
        const season = await activeMnfSeason();
        if (season) await MNFService.runWeeklyPipeline(season.id);
    } catch (err) { console.error('[MNF Cron] Late pipeline failed:', err.message); }
}, ET);

// ═══════════════════════════════════════════════════════════════

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

app.listen(PORT, () => {
    console.log('Barry Bets running on port ' + PORT);
    setTimeout(async () => {
        try {
            const result = await ESPNScoreService.syncScoresToGames(TOURNAMENT_ID);
            if (result.updated > 0) await ESPNScoreService.scorePicks(TOURNAMENT_ID);
        } catch (err) { console.error('[Startup] MM sync failed:', err.message); }

        try {
            const season = await activeMnfSeason();
            if (season) {
                const r = await MNFService.runWeeklyPipeline(season.id);
                console.log('[Startup] MNF pipeline:', JSON.stringify(r));
            }
        } catch (err) { console.error('[Startup] MNF sync failed:', err.message); }
    }, 5000);
});

module.exports = app;
