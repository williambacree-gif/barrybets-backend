// ═══════════════════════════════════════════════════════════════
// BARRY BETS — College Football Survivor routes
// Mounted at /api/cfb
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { requireAuth } = require('./auth');
const { supabaseAdmin } = require('./supabase');
const CFBService = require('./cfbService');

function requireAdmin(req, res, next) {
  const expected = process.env.MNF_ADMIN_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Admin token not configured' });
  const given = req.headers['x-admin-token'] || req.query.token;
  if (given !== expected) return res.status(403).json({ error: 'Forbidden' });
  next();
}

async function activeSeason() {
  const { data } = await supabaseAdmin
    .from('cfb_seasons').select('*').eq('status', 'active')
    .order('year', { ascending: false }).limit(1).maybeSingle();
  return data;
}

async function meIn(seasonId, userId) {
  const { data } = await supabaseAdmin
    .from('cfb_players').select('*').eq('season_id', seasonId).eq('user_id', userId).maybeSingle();
  return data;
}

// The week we should be showing: earliest week with unfinished games.
async function currentWeek(seasonId) {
  const { data: pending } = await supabaseAdmin
    .from('cfb_games').select('pool_week').eq('season_id', seasonId)
    .neq('status', 'final').order('pool_week').limit(1).maybeSingle();
  if (pending) return pending.pool_week;
  const { data: last } = await supabaseAdmin
    .from('cfb_games').select('pool_week').eq('season_id', seasonId)
    .order('pool_week', { ascending: false }).limit(1).maybeSingle();
  return last ? last.pool_week : 1;
}

// ─────────────────────────────────────────────────────────────

router.get('/season', requireAuth, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active CFB season' });

    const { data: players } = await supabaseAdmin
      .from('cfb_players').select('id, display_name, user_id, status, eliminated_week, buybacks')
      .eq('season_id', season.id).order('display_name');

    const me = (players || []).find(p => p.user_id === req.user.id) || null;
    const week = await currentWeek(season.id);

    const { count: buybackCount } = await supabaseAdmin
      .from('cfb_buybacks').select('*', { count: 'exact', head: true }).eq('season_id', season.id);

    res.json({
      season, players: players || [], me, current_week: week,
      pot: Number(season.entry_fee) * (players || []).length
         + Number(season.buyback_fee) * (buybackCount || 0),
      can_buy_back: !!me && me.status === 'eliminated' && week <= season.buyback_through_week,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The board for one week, plus my pick and my burned teams.
router.get('/week/:week', requireAuth, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active CFB season' });
    const week = parseInt(req.params.week, 10);
    const me = await meIn(season.id, req.user.id);

    const { data: games } = await supabaseAdmin
      .from('cfb_games').select('*')
      .eq('season_id', season.id).eq('pool_week', week).order('kickoff_at');

    const lockAt = await CFBService.lockTime(season.id, week);
    const locked = lockAt ? new Date(lockAt) <= new Date() : false;

    // Every pick this player has ever made — these teams are gone for good.
    const { data: allMine } = me ? await supabaseAdmin
      .from('cfb_picks').select('picked_team_id, picked_team, pool_week')
      .eq('season_id', season.id).eq('player_id', me.id) : { data: [] };

    const myPick = (allMine || []).find(p => p.pool_week === week) || null;
    const usedTeamIds = (allMine || [])
      .filter(p => p.pool_week !== week)          // this week's own pick is still switchable
      .map(p => p.picked_team_id);

    // Other people's picks stay hidden until the board locks.
    let picks = [];
    if (locked) {
      const { data } = await supabaseAdmin
        .from('cfb_picks')
        .select('player_id, picked_team, picked_side, result, game_id')
        .eq('season_id', season.id).eq('pool_week', week);
      picks = data || [];
    }

    const { data: myFull } = me ? await supabaseAdmin
      .from('cfb_picks').select('*').eq('season_id', season.id)
      .eq('pool_week', week).eq('player_id', me.id).maybeSingle() : { data: null };

    res.json({
      week, games: games || [], lock_at: lockAt, locked,
      my_pick: myFull || null, used_team_ids: usedTeamIds,
      picks, me,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/leaderboard', requireAuth, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active CFB season' });
    const { data, error } = await supabaseAdmin
      .from('cfb_leaderboard').select('*').eq('season_id', season.id);
    if (error) throw error;

    const rows = (data || []).sort((a, b) =>
      (a.status === b.status ? 0 : a.status === 'alive' ? -1 : 1)
      || b.wins - a.wins
      || a.display_name.localeCompare(b.display_name)
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// PICK
// ─────────────────────────────────────────────────────────────

router.post('/pick', requireAuth, async (req, res) => {
  try {
    const { game_id, side } = req.body;
    if (!['home', 'away'].includes(side)) {
      return res.status(400).json({ error: "side must be 'home' or 'away'" });
    }

    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active CFB season' });

    const me = await meIn(season.id, req.user.id);
    if (!me) return res.status(403).json({ error: "You're not in this pool" });
    if (me.status !== 'alive') {
      return res.status(400).json({ error: 'You are eliminated. Buy back in to keep playing.' });
    }

    const { data: game } = await supabaseAdmin
      .from('cfb_games').select('*').eq('id', game_id).eq('season_id', season.id).maybeSingle();
    if (!game) return res.status(404).json({ error: 'Game not found' });

    if (await CFBService.isLocked(season.id, game.pool_week)) {
      return res.status(400).json({ error: 'Picks are locked for this week' });
    }

    const teamId = side === 'home' ? game.home_team_id : game.away_team_id;
    const teamName = side === 'home' ? game.home_team : game.away_team;

    // A team is one and done, and buying back in does not hand it back.
    const { data: prior } = await supabaseAdmin
      .from('cfb_picks').select('id, pool_week')
      .eq('season_id', season.id).eq('player_id', me.id).eq('picked_team_id', teamId);
    if ((prior || []).some(p => p.pool_week !== game.pool_week)) {
      return res.status(400).json({ error: `You already used ${teamName} in week ${prior[0].pool_week}` });
    }

    const payload = {
      season_id: season.id, pool_week: game.pool_week, player_id: me.id, game_id: game.id,
      picked_side: side, picked_team: teamName, picked_team_id: teamId,
      picked_at: new Date().toISOString(), result: 'pending',
    };

    const { data: existing } = await supabaseAdmin
      .from('cfb_picks').select('id')
      .eq('season_id', season.id).eq('pool_week', game.pool_week).eq('player_id', me.id).maybeSingle();

    if (existing) {
      await supabaseAdmin.from('cfb_picks').update(payload).eq('id', existing.id);
    } else {
      const { error } = await supabaseAdmin.from('cfb_picks').insert(payload);
      if (error) throw error;
    }

    res.json({ ok: true, summary: `You took ${teamName}` });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/buyback', requireAuth, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active CFB season' });
    const me = await meIn(season.id, req.user.id);
    if (!me) return res.status(403).json({ error: "You're not in this pool" });

    const week = await currentWeek(season.id);
    const result = await CFBService.buyBack(season.id, me.id, week);
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────────────────────

router.post('/admin/create-season', requireAdmin, async (req, res) => {
  try {
    const {
      name = 'CFB Survivor 2026', year = 2026, entry_fee = 150, buyback_fee = 75,
      buyback_through_week = 5, first_cfb_week = 3, players = [],
    } = req.body;

    const { data: season, error } = await supabaseAdmin
      .from('cfb_seasons')
      .upsert({ name, year, entry_fee, buyback_fee, buyback_through_week, first_cfb_week, status: 'active' },
              { onConflict: 'year' })
      .select().single();
    if (error) throw error;

    for (const p of players) {
      await supabaseAdmin.from('cfb_players').upsert(
        { season_id: season.id, display_name: p.display_name, user_id: p.user_id || null },
        { onConflict: 'season_id,display_name' }
      );
    }
    const { data: roster } = await supabaseAdmin
      .from('cfb_players').select('*').eq('season_id', season.id);
    res.json({ season, players: roster });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/admin/sync-week', requireAdmin, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active CFB season' });
    const week = parseInt(req.body.week, 10) || await currentWeek(season.id);
    res.json(await CFBService.syncWeek(season.id, week));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/admin/sync', requireAdmin, async (req, res) => {
  try {
    const season = await activeSeason();
    if (!season) return res.status(404).json({ error: 'No active CFB season' });
    const week = parseInt(req.body.week, 10) || await currentWeek(season.id);
    res.json(await CFBService.runWeeklyPipeline(season.id, week));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
