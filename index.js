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
const cfbRoutes = require('./cfbRoutes');
const authRoutes = require('./authRoutes');
const CFBService = require('./cfbService');
const { supabaseAdmin } = require('./supabase');

const app = express();

// Railway terminates TLS at its edge, so every request arrives with an
// X-Forwarded-For header. Without this, express-rate-limit refuses to
// trust it (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR in the logs) and buckets
// everyone under the proxy's single IP — meaning one player burning
// through the password-reset limit would lock out the rest.
app.set('trust proxy', 1);
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
app.use('/api/cfb', cfbRoutes);
app.use('/api/auth', authRoutes);

app.get('/api/health', (req, res) => {
    res.json({ status: 'alive', app: 'Barry Bets', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════
// MARCH MADNESS — FEED TURNED OFF (Sep 2026)
//
// The 2026 bracket competition is over and did not work well enough
// to run again as-is. These two crons scraped ESPN every 5 minutes
// through March and April and graded picks off it. They are off so
// they do not wake up next March against a stale 2026 bracket.
//
// The data is untouched — the tables, the 2026 tournament row and
// every pick are all still there.
//
// TO TURN THE FEED BACK ON next spring: uncomment the two blocks
// below and point TOURNAMENT_ID (top of this file) at the new
// season's tournament row. Do not reuse the 2026 id.
// ═══════════════════════════════════════════════════════════════

// cron.schedule('*/5 11-23 * 3-4 *', async () => {
//     try {
//         const r = await ESPNScoreService.syncScoresToGames(TOURNAMENT_ID);
//         if (r.updated > 0) await ESPNScoreService.scorePicks(TOURNAMENT_ID);
//     } catch (err) { console.error('[Cron] MM sync failed:', err.message); }
// });

// cron.schedule('*/5 0-1 * 3-4 *', async () => {
//     try {
//         const r = await ESPNScoreService.syncScoresToGames(TOURNAMENT_ID);
//         if (r.updated > 0) await ESPNScoreService.scorePicks(TOURNAMENT_ID);
//     } catch (err) { console.error('[Cron] MM late sync failed:', err.message); }
// });

// ═══════════════════════════════════════════════════════════════
// SEASON LOOKUPS
// ═══════════════════════════════════════════════════════════════

async function activeMnfSeason() {
    const { data } = await supabaseAdmin
        .from('mnf_seasons').select('id, year').eq('status', 'active')
        .order('year', { ascending: false }).limit(1).maybeSingle();
    return data;
}

async function activeCfbSeason() {
    const { data } = await supabaseAdmin
        .from('cfb_seasons').select('id, year').eq('status', 'active')
        .order('year', { ascending: false }).limit(1).maybeSingle();
    return data;
}

// pool_week 0 is the parking lot: ranked games deliberately kept off the
// board. Skip it, or every cron below works on the week nobody can pick.
async function cfbCurrentWeek(seasonId) {
    const { data: pending } = await supabaseAdmin
        .from('cfb_games').select('pool_week').eq('season_id', seasonId)
        .gt('pool_week', 0)
        .neq('status', 'final').order('pool_week').limit(1).maybeSingle();
    return pending ? pending.pool_week : null;
}

// ═══════════════════════════════════════════════════════════════
// MONDAY NIGHT FOOTBALL
// ═══════════════════════════════════════════════════════════════

// Freeze the line Wednesday 9:00 AM ET — only for the game inside the
// next seven days, never the whole rest of the season.
cron.schedule('0 9 * * 3', async () => {
    try {
        const s = await activeMnfSeason();
        if (s) console.log('[MNF Cron] Freeze:', JSON.stringify(await MNFService.freezeSpreads(s.id)));
    } catch (err) { console.error('[MNF Cron] Freeze failed:', err.message); }
}, ET);

cron.schedule('0 13 * * 3', async () => {
    try { const s = await activeMnfSeason(); if (s) await MNFService.freezeSpreads(s.id); }
    catch (err) { console.error('[MNF Cron] Freeze retry failed:', err.message); }
}, ET);

cron.schedule('0 9 * * 4', async () => {
    try { const s = await activeMnfSeason(); if (s) await MNFService.freezeSpreads(s.id); }
    catch (err) { console.error('[MNF Cron] Thursday freeze failed:', err.message); }
}, ET);

// Monday night: auto-assign missed picks at kickoff, track the score, grade.
cron.schedule('*/5 20-23 * * 1', async () => {
    try {
        const s = await activeMnfSeason();
        if (!s) return;
        const r = await MNFService.runWeeklyPipeline(s.id);
        if (r.graded.graded > 0 || r.assigned.assigned > 0) console.log('[MNF Cron]', JSON.stringify(r));
    } catch (err) { console.error('[MNF Cron] Monday pipeline failed:', err.message); }
}, ET);

cron.schedule('*/5 0-1 * * 2', async () => {
    try { const s = await activeMnfSeason(); if (s) await MNFService.runWeeklyPipeline(s.id); }
    catch (err) { console.error('[MNF Cron] Late pipeline failed:', err.message); }
}, ET);

// Safety net. The two crons above only cover Monday 8pm through Tuesday
// 2am ET. A game that runs long, or a Railway restart landing inside that
// six-hour window, would leave the week ungraded until the FOLLOWING
// Monday — the same shape as the college survivor bug that quietly ate a
// whole weekend. So: one sweep a day, every day. The pipeline is
// idempotent (grading only touches matchups still marked pending), so a
// run with nothing to do costs nothing.
cron.schedule('0 9 * * *', async () => {
    try {
        const s = await activeMnfSeason();
        if (!s) return;
        const r = await MNFService.runWeeklyPipeline(s.id);
        if (r.graded.graded > 0 || r.assigned.assigned > 0) {
            console.log('[MNF Catch-up] Caught something the Monday run missed:', JSON.stringify(r));
        }
    } catch (err) { console.error('[MNF Catch-up] Failed:', err.message); }
}, ET);

// No frozen spread means no week. autoAssignMissingPicks skips games with
// no favorite and coveringSide() returns null without one, so a game that
// reaches kickoff unfrozen can never be graded at all — silently. Check
// daily, shout while there is still time, and try the freeze once more.
cron.schedule('0 10 * * *', async () => {
    try {
        const s = await activeMnfSeason();
        if (!s) return;
        const now = new Date();
        const { data: unfrozen } = await supabaseAdmin
            .from('mnf_games')
            .select('week_no, away_team, home_team, kickoff_at')
            .eq('season_id', s.id)
            .neq('status', 'final')
            .is('spread_frozen_at', null)
            .gte('kickoff_at', now.toISOString())
            .lte('kickoff_at', new Date(now.getTime() + 48 * 3600 * 1000).toISOString());

        if (!unfrozen || !unfrozen.length) return;
        for (const g of unfrozen) {
            console.error(
                `[MNF ALERT] Week ${g.week_no} (${g.away_team} at ${g.home_team}, kickoff ` +
                `${g.kickoff_at}) is inside 48 hours with NO FROZEN SPREAD. Without one ` +
                `the week cannot grade. Freeze it by hand if this retry fails.`
            );
        }
        console.log('[MNF ALERT] Freeze retry:', JSON.stringify(await MNFService.freezeSpreads(s.id)));
    } catch (err) { console.error('[MNF Cron] Line check failed:', err.message); }
}, ET);

// ═══════════════════════════════════════════════════════════════
// COLLEGE FOOTBALL SURVIVOR
// ═══════════════════════════════════════════════════════════════

// Rebuild the board after the new poll lands, and again Friday in case
// of rank changes or kickoff moves.
for (const expr of ['0 10 * * 2', '0 10 * * 5']) {
    cron.schedule(expr, async () => {
        try {
            const s = await activeCfbSeason();
            if (!s) return;
            const wk = await cfbCurrentWeek(s.id);
            if (wk) console.log('[CFB Cron] Sync week', wk, JSON.stringify(await CFBService.syncWeek(s.id, wk)));
        } catch (err) { console.error('[CFB Cron] Week sync failed:', err.message); }
    }, ET);
}

// Scores and eliminations across the college football weekend.
cron.schedule('*/10 12-23 * * 4,5,6,0', async () => {
    try {
        const s = await activeCfbSeason();
        if (!s) return;
        const wk = await cfbCurrentWeek(s.id);
        if (!wk) return;
        const r = await CFBService.runWeeklyPipeline(s.id, wk);
        if (r.graded.graded > 0) console.log('[CFB Cron]', JSON.stringify(r));
    } catch (err) { console.error('[CFB Cron] Weekend pipeline failed:', err.message); }
}, ET);

cron.schedule('*/10 0-2 * * 5,6,0,1', async () => {
    try {
        const s = await activeCfbSeason();
        if (!s) return;
        const wk = await cfbCurrentWeek(s.id);
        if (wk) await CFBService.runWeeklyPipeline(s.id, wk);
    } catch (err) { console.error('[CFB Cron] Late pipeline failed:', err.message); }
}, ET);

// The same safety net the NFL pool has. The weekend crons above already
// cover Thursday through Monday, so the gap here is much smaller — but a
// restart landing in the wrong hour, or a game that finishes after 2am
// Monday, would still leave the week ungraded, and checking costs nothing.
cron.schedule('0 9 * * *', async () => {
    try {
        const s = await activeCfbSeason();
        if (!s) return;
        const wk = await cfbCurrentWeek(s.id);
        if (!wk) return;
        const r = await CFBService.runWeeklyPipeline(s.id, wk);
        if (r.graded.graded > 0) {
            console.log('[CFB Catch-up] Caught something the weekend runs missed:', JSON.stringify(r));
        }
    } catch (err) { console.error('[CFB Catch-up] Failed:', err.message); }
}, ET);

// ═══════════════════════════════════════════════════════════════

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

app.listen(PORT, () => {
    console.log('Barry Bets running on port ' + PORT);
    setTimeout(async () => {
        // March Madness startup sync — OFF (Sep 2026). This one ran on
        // every boot, all year, not just in March. Uncomment along with
        // the two crons above to bring the feed back next spring.
        //
        // try {
        //     const r = await ESPNScoreService.syncScoresToGames(TOURNAMENT_ID);
        //     if (r.updated > 0) await ESPNScoreService.scorePicks(TOURNAMENT_ID);
        // } catch (err) { console.error('[Startup] MM sync failed:', err.message); }

        try {
            const s = await activeMnfSeason();
            if (s) console.log('[Startup] MNF:', JSON.stringify(await MNFService.runWeeklyPipeline(s.id)));
        } catch (err) { console.error('[Startup] MNF sync failed:', err.message); }

        try {
            const s = await activeCfbSeason();
            if (s) {
                const wk = await cfbCurrentWeek(s.id);
                if (wk) console.log('[Startup] CFB:', JSON.stringify(await CFBService.runWeeklyPipeline(s.id, wk)));
            }
        } catch (err) { console.error('[Startup] CFB sync failed:', err.message); }
    }, 5000);
});

module.exports = app;
