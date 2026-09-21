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
// The admin endpoints take their token in the query string for
// convenience, which means morgan would otherwise write it into the logs
// in plain text and leave it sitting there. Keep the path, lose the secret.
morgan.token('url', req => req.originalUrl.replace(/([?&]token=)[^&]*/gi, '$1[redacted]'));
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
// The week whose BOARD should be built next — a different question from
// which week to grade, and the distinction this pool got wrong.
//
// cfbCurrentWeek below returns the earliest week still holding an
// unfinished game, and null once every game is final. The weekly sync used
// to call that: the moment a week went final there was no week to sync, so
// the following week was never created and the pool simply stopped at the
// last board it had. Week 2 of the 2026 season disappeared exactly this
// way — the board was not stale, the week did not exist.
async function cfbWeekToSync(seasonId) {
    const { data: pending } = await supabaseAdmin
        .from('cfb_games').select('pool_week').eq('season_id', seasonId)
        .gt('pool_week', 0)
        .neq('status', 'final').order('pool_week').limit(1).maybeSingle();
    if (pending) return pending.pool_week;

    const { data: last } = await supabaseAdmin
        .from('cfb_games').select('pool_week').eq('season_id', seasonId)
        .gt('pool_week', 0)
        .order('pool_week', { ascending: false }).limit(1).maybeSingle();
    return last ? last.pool_week + 1 : 1;
}

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

// Primetime nights: auto-assign missed picks at kickoff, track the score,
// grade. There is no single weekly deadline — a week holds three rounds on
// three different nights, and each one locks at its own kickoff. Miss your
// Thursday and you are handed that game's favorite off the frozen line;
// your Sunday and Monday are untouched and still yours to make.
//
// So this has to run on all three nights (Thu=4, Sun=0, Mon=1), not Monday
// alone. Running it Monday-only would leave a missed Thursday pick sitting
// unassigned, and the Thursday game ungraded, until the next morning sweep.
cron.schedule('*/5 20-23 * * 0,1,4', async () => {
    try {
        const s = await activeMnfSeason();
        if (!s) return;
        const r = await MNFService.runWeeklyPipeline(s.id);
        if (r.graded.graded > 0 || r.assigned.assigned > 0) console.log('[MNF Cron]', JSON.stringify(r));
    } catch (err) { console.error('[MNF Cron] Primetime pipeline failed:', err.message); }
}, ET);

// The small hours after each of those nights, for a game that runs past
// midnight ET. Friday, Monday and Tuesday are the mornings after.
cron.schedule('*/5 0-2 * * 1,2,5', async () => {
    try { const s = await activeMnfSeason(); if (s) await MNFService.runWeeklyPipeline(s.id); }
    catch (err) { console.error('[MNF Cron] Late pipeline failed:', err.message); }
}, ET);

// Safety net. The crons above cover the three primetime evenings and the
// small hours after each. A game that runs very long, or a Railway restart
// landing inside one of those windows, would still leave a round ungraded
// until the next primetime night — the same shape as the college survivor
// bug that quietly ate a whole weekend. So: one sweep a day, every day. The
// pipeline is idempotent (grading only touches matchups still marked
// pending), so a run with nothing to do costs nothing.
cron.schedule('0 9 * * *', async () => {
    try {
        const s = await activeMnfSeason();
        if (!s) return;
        const r = await MNFService.runWeeklyPipeline(s.id);
        if (r.graded.graded > 0 || r.assigned.assigned > 0) {
            console.log('[MNF Catch-up] Caught something the nightly runs missed:', JSON.stringify(r));
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
// THE NUDGE
//
// Who still owes a pick, and the exact sentence to send them.
//
// It deliberately sends nothing itself. Email gets ignored, and no server
// can send from somebody's iMessage — Apple has no API for it and this box
// is in a datacentre, not in Will's pocket. So the app does the knowing and
// the phone does the sending: open this in a browser and copy it, tap the
// button in the admin view, or let an iPhone Shortcut fetch ?format=text on
// a schedule and drop it straight into the group thread.
//
// No phone numbers live here. The roster stays off this server.
// ═══════════════════════════════════════════════════════════════

const HOURS = ms => Math.max(0, Math.round(ms / 3600000 * 10) / 10);
const when = iso => new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit',
});

async function cfbNudge() {
    const s = await activeCfbSeason();
    if (!s) return null;
    const week = await cfbCurrentWeek(s.id);
    if (!week) return null;

    const { data: games } = await supabaseAdmin
        .from('cfb_games').select('kickoff_at')
        .eq('season_id', s.id).eq('pool_week', week)
        .order('kickoff_at').limit(1);
    const lockAt = games && games[0] ? games[0].kickoff_at : null;
    if (!lockAt) return null;
    const locked = new Date(lockAt) <= new Date();

    const { data: alive } = await supabaseAdmin
        .from('cfb_players').select('id, display_name')
        .eq('season_id', s.id).eq('status', 'alive');
    const { data: picks } = await supabaseAdmin
        .from('cfb_picks').select('player_id')
        .eq('season_id', s.id).eq('pool_week', week);

    const done = new Set((picks || []).map(p => p.player_id));
    const missing = (alive || []).filter(p => !done.has(p.id)).map(p => p.display_name).sort();

    return { pool: 'College survivor', week, lock_at: lockAt, locked,
        hours_left: locked ? 0 : HOURS(new Date(lockAt) - Date.now()), missing };
}

async function mnfNudge() {
    const s = await activeMnfSeason();
    if (!s) return null;
    const { data: next } = await supabaseAdmin
        .from('mnf_games').select('week_no')
        .eq('season_id', s.id).neq('status', 'final')
        .order('week_no').limit(1).maybeSingle();
    if (!next) return null;
    const week = next.week_no;

    const { data: games } = await supabaseAdmin
        .from('mnf_games').select('slot_name, kickoff_at, status')
        .eq('season_id', s.id).eq('week_no', week).order('kickoff_at');
    const { data: raw } = await supabaseAdmin
        .from('mnf_matchups').select('slot_name, picker_id, picked_side')
        .eq('season_id', s.id).eq('week_no', week);
    const { data: players } = await supabaseAdmin
        .from('mnf_players').select('id, display_name').eq('season_id', s.id);

    const nameOf = Object.fromEntries((players || []).map(p => [p.id, p.display_name]));
    const rounds = [];
    for (const g of games || []) {
        // A round that has kicked off is settled one way or the other;
        // nagging about it only annoys people.
        if (new Date(g.kickoff_at) <= new Date()) continue;
        const owed = (raw || [])
            .filter(m => m.slot_name === g.slot_name && !m.picked_side)
            .map(m => nameOf[m.picker_id]).filter(Boolean).sort();
        if (owed.length) {
            rounds.push({ slot_name: g.slot_name, lock_at: g.kickoff_at,
                hours_left: HOURS(new Date(g.kickoff_at) - Date.now()), missing: owed });
        }
    }
    return { pool: 'NFL', week, rounds };
}

const SLOT_WORD = { TNF: 'Thursday night', SNF: 'Sunday night', MNF: 'Monday night' };
const andList = xs => xs.length < 2 ? (xs[0] || '')
    : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];

function nudgeText(cfb, mnf) {
    const lines = [];
    if (cfb && !cfb.locked && cfb.missing.length) {
        lines.push(`${andList(cfb.missing)} — no survivor pick for week ${cfb.week} yet. `
            + `Locks ${when(cfb.lock_at)} ET. barrysbets.net`);
    }
    for (const r of (mnf && mnf.rounds) || []) {
        lines.push(`${andList(r.missing)} — ${SLOT_WORD[r.slot_name] || r.slot_name} pick is open. `
            + `Locks ${when(r.lock_at)} ET. barrysbets.net`);
    }
    return lines.join('\n\n');
}

app.get('/api/nudge', async (req, res) => {
    const expected = process.env.MNF_ADMIN_TOKEN;
    if (!expected) return res.status(503).json({ error: 'MNF_ADMIN_TOKEN not configured' });
    if ((req.headers['x-admin-token'] || req.query.token) !== expected) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const [cfb, mnf] = await Promise.all([cfbNudge(), mnfNudge()]);
        const text = nudgeText(cfb, mnf);
        if (req.query.format === 'text') {
            res.type('text/plain');
            // Empty body on purpose: a Shortcut can check for it and send
            // nothing rather than texting the group "all clear" every week.
            return res.send(text);
        }
        res.json({ ok: true, text, nobody_owes: !text, cfb, mnf });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// COLLEGE FOOTBALL SURVIVOR
// ═══════════════════════════════════════════════════════════════

// Build the board after the new poll lands Tuesday, again Friday for rank
// changes and kickoff moves, and once every morning besides. A board that
// never gets built is the one failure nobody notices until Saturday, so it
// gets checked far more often than it should ever need to be.
for (const expr of ['0 10 * * 2', '0 10 * * 5', '30 6 * * *']) {
    cron.schedule(expr, async () => {
        try {
            const s = await activeCfbSeason();
            if (!s) return;
            const wk = await cfbWeekToSync(s.id);
            if (wk) console.log('[CFB Cron] Sync week', wk, JSON.stringify(await CFBService.syncWeek(s.id, wk)));
        } catch (err) { console.error('[CFB Cron] Week sync failed:', err.message); }
    }, ET);
}

// Crons never fire on boot. A deploy or restart landing after Tuesday's run
// means the coming week's board is never built at all, and nobody finds out
// until kickoff. One sweep shortly after start closes that.
//
// Board only. Grading and auto-assign stay on their own schedule, so a week
// that first appears here can never hand out picks in the same breath.
setTimeout(async () => {
    try {
        const s = await activeCfbSeason();
        if (!s) return;
        const wk = await cfbWeekToSync(s.id);
        if (wk) console.log('[CFB Boot] Board sync week', wk,
            JSON.stringify(await CFBService.syncWeek(s.id, wk)));
    } catch (err) { console.error('[CFB Boot] Board sync failed:', err.message); }
}, 20000);

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
