// ═══════════════════════════════════════════════════════════════
// BARRY BETS — Monday Night Football routes
// Mounted at /api/mnf
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { requireAuth } = require('./auth');
const { supabaseAdmin } = require('./supabase');
const MNFService = require('./mnfService');
const { seedSchedule, generateSchedule } = require('./mnfSchedule');

// Admin routes need a shared secret. Set MNF_ADMIN_TOKEN in Railway.
// (The existing /api/admin/* routes are wide open — worth locking down too.)
function requireAdmin(req, res, next) {
  const expected = process.env.MNF_ADMIN_TOKEN;
  if (!expected) return res.status(503).json({ error: 'MNF_ADMIN_TOKEN not configured' });
  const given = req.headers['x-admin-token'] || req.query.token;
  if (given !== expected) return res.status(403).json({ error: 'Forbidden' });
  next();
}

async function activeSeason() {
  const { data } = await supabaseAdmin
    .from('mnf_seasons')
    .select('*')
    .eq('status', 'active')
    .order('year', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

const PLAYER_FIELDS = 'id, display_name, user_id';

// Attach player objects to matchup rows.
async function hydrate(seasonId, matchups) {
  const { data: players } = await supabaseAdmin
    .from('mnf_players').select(PLAYER_FIELDS).eq('season_id', seasonId);
  const byId = Object.fromEntries((players || []).map(p => [p.id, p]));
  return matchups.map(m => ({
    ...m,
    picker: byId[m.picker_id] || null,
    opponent: byId[m.opponent_id] || null,
  }));
}

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

// Season + roster + where we are in the calendar
router.get('/season', requireAuth, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active MNF season' });

    const { data: players } = await supabaseAdmin
      .from('mnf_players').select(PLAYER_FIELDS).eq('season_id', season.id).order('display_name');

    const { data: next } = await supabaseAdmin
      .from('mnf_games')
      .select('week_no')
      .eq('season_id', season.id)
      .neq('status', 'final')
      .order('week_no')
      .limit(1)
      .maybeSingle();

    res.json({
      season,
      players: players || [],
      current_week: next ? next.week_no : null,
      me: (players || []).find(p => p.user_id === req.user.id) || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One week: the game, the frozen spread, both matchups
router.get('/week/:week', requireAuth, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active MNF season' });
    const week = parseInt(req.params.week, 10);

    const { data: game } = await supabaseAdmin
      .from('mnf_games').select('*')
      .eq('season_id', season.id).eq('week_no', week).maybeSingle();

    const { data: raw } = await supabaseAdmin
      .from('mnf_matchups').select('*')
      .eq('season_id', season.id).eq('week_no', week).order('slot');

    const matchups = await hydrate(season.id, raw || []);
    const locked = game ? new Date(game.kickoff_at) <= new Date() : false;

    res.json({ week, game: game || null, matchups, locked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Whole season at a glance
router.get('/schedule', requireAuth, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active MNF season' });

    const { data: games } = await supabaseAdmin
      .from('mnf_games').select('*').eq('season_id', season.id).order('week_no');
    const { data: raw } = await supabaseAdmin
      .from('mnf_matchups').select('*').eq('season_id', season.id).order('week_no').order('slot');

    const matchups = await hydrate(season.id, raw || []);
    const gameByWeek = Object.fromEntries((games || []).map(g => [g.week_no, g]));

    const weeks = [...new Set(matchups.map(m => m.week_no))].sort((a, b) => a - b);
    res.json(weeks.map(w => ({
      week_no: w,
      game: gameByWeek[w] || null,
      matchups: matchups.filter(m => m.week_no === w),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/standings', requireAuth, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active MNF season' });

    const { data, error } = await supabaseAdmin
      .from('mnf_standings').select('*').eq('season_id', season.id);
    if (error) throw error;

    const rows = (data || []).sort((a, b) =>
      b.points - a.points || a.losses - b.losses || a.display_name.localeCompare(b.display_name)
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PICK
// ─────────────────────────────────────────────────────────────

router.post('/pick', requireAuth, async (req, res) => {
  try {
    const { matchup_id, side } = req.body;
    if (!['home', 'away'].includes(side)) {
      return res.status(400).json({ error: "side must be 'home' or 'away'" });
    }

    const { data: matchup } = await supabaseAdmin
      .from('mnf_matchups').select('*').eq('id', matchup_id).maybeSingle();
    if (!matchup) return res.status(404).json({ error: 'Matchup not found' });

    // Only the player holding the pick can submit one.
    const { data: picker } = await supabaseAdmin
      .from('mnf_players').select('user_id, display_name').eq('id', matchup.picker_id).maybeSingle();
    if (!picker || picker.user_id !== req.user.id) {
      return res.status(403).json({ error: "It isn't your pick this week" });
    }

    const { data: game } = await supabaseAdmin
      .from('mnf_games').select('*')
      .eq('season_id', matchup.season_id).eq('week_no', matchup.week_no).maybeSingle();
    if (!game) return res.status(400).json({ error: 'No game scheduled for that week yet' });

    if (!game.spread_frozen_at) {
      return res.status(400).json({ error: 'The spread has not been set yet — it freezes Wednesday morning' });
    }
    if (new Date(game.kickoff_at) <= new Date()) {
      return res.status(400).json({ error: 'Picks are locked — the game has kicked off' });
    }
    if (matchup.result !== 'pending') {
      return res.status(400).json({ error: 'That matchup is already graded' });
    }

    const { data: updated, error } = await supabaseAdmin
      .from('mnf_matchups')
      .update({ picked_side: side, picked_at: new Date().toISOString(), auto_assigned: false })
      .eq('id', matchup_id)
      .select()
      .single();
    if (error) throw error;

    const pickedName = side === 'home' ? game.home_team : game.away_team;
    const line = game.favorite === side ? `-${game.spread_value}` : `+${game.spread_value}`;

    res.json({ matchup: updated, summary: `${picker.display_name} takes ${pickedName} ${line}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────────────────────

// Preview a schedule draw without writing anything
router.post('/admin/preview-schedule', requireAdmin, (req, res) => {
  try {
    const { players, weeks = 17, seed } = req.body;
    res.json(generateSchedule(players, weeks, seed));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/create-season', requireAdmin, async (req, res) => {
  try {
    const { name = 'MNF 2026', year = 2026, entry_fee = 0, players = [] } = req.body;
    if (players.length !== 4) return res.status(400).json({ error: 'Need exactly 4 players' });

    const { data: season, error } = await supabaseAdmin
      .from('mnf_seasons')
      .upsert({ name, year, entry_fee, status: 'active' }, { onConflict: 'year' })
      .select().single();
    if (error) throw error;

    for (const p of players) {
      await supabaseAdmin.from('mnf_players').upsert(
        { season_id: season.id, display_name: p.display_name, user_id: p.user_id || null },
        { onConflict: 'season_id,display_name' }
      );
    }

    const { data: roster } = await supabaseAdmin
      .from('mnf_players').select(PLAYER_FIELDS).eq('season_id', season.id);

    res.json({ season, players: roster });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/seed-games', requireAdmin, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active MNF season' });
    const { weeks = 18 } = req.body;
    res.json(await MNFService.seedSeasonGames(season.id, season.year, weeks));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/seed-schedule', requireAdmin, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active MNF season' });
    const { weeks = 17, seed } = req.body;
    res.json(await seedSchedule(season.id, weeks, seed));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/freeze-spreads', requireAdmin, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active MNF season' });
    const { force = false, week = null } = req.body || {};
    res.json(await MNFService.freezeSpreads(season.id, { force, week }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/sync', requireAdmin, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active MNF season' });
    res.json(await MNFService.runWeeklyPipeline(season.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check that actually tells you whether the feeds work
router.get('/admin/feed-check', requireAdmin, async (req, res) => {
  try {
    const season = await activeSeason();
    const espn = await MNFService.fetchWeekGame(season ? season.year : 2026, 1);
    const odds = await MNFService.fetchSpreads();
    res.json({
      season: season ? { name: season.name, year: season.year } : null,
      espn: { ok: !!espn, sample: espn },
      odds_api: {
        key_present: !!process.env.ODDS_API_KEY,
        ok: odds.length > 0,
        games_returned: odds.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
