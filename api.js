const express = require('express');
const router = express.Router();
const { requireAuth } = require('./auth');
const SurvivorEngine = require('./survivorEngine');
const OddsService = require('./oddsService');
const BracketSeeder = require('./bracketSeeder');
const { supabaseAdmin } = require('./supabase');
const { nanoid } = require('nanoid');

const TOURNAMENT_ID = '00000000-0000-0000-0000-000000002026';

// ═══════════════════════════════════════════════════════════════
// LEAGUES
// ═══════════════════════════════════════════════════════════════

// Create a league
router.post('/leagues', requireAuth, async (req, res) => {
  try {
    const { name, max_entries_per_member = 3 } = req.body;
    const code = `BARRY-${nanoid(4).toUpperCase()}`;

    const { data: league, error } = await supabaseAdmin
      .from('leagues')
      .insert({
        tournament_id: TOURNAMENT_ID,
        name,
        created_by: req.user.id,
        max_entries_per_member: Math.min(max_entries_per_member, 5),
        invite_code: code,
      })
      .select()
      .single();

    if (error) throw error;

    // Auto-add creator as owner
    await supabaseAdmin.from('league_members').insert({
      league_id: league.id,
      user_id: req.user.id,
      role: 'owner',
    });

    res.status(201).json(league);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get my leagues
router.get('/leagues', requireAuth, async (req, res) => {
  try {
    const { data: memberships } = await supabaseAdmin
      .from('league_members')
      .select('league_id, role')
      .eq('user_id', req.user.id);

    const leagueIds = (memberships || []).map(m => m.league_id);

    const { data: leagues } = await supabaseAdmin
      .from('leagues')
      .select('*, league_members(count)')
      .in('id', leagueIds);

    res.json(leagues || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Join via invite code
router.post('/leagues/join', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;

    const { data: league } = await supabaseAdmin
      .from('leagues')
      .select('id, name, max_entries_per_member')
      .eq('invite_code', code.toUpperCase())
      .single();

    if (!league) return res.status(404).json({ error: 'Invalid invite code' });

    // Check not already a member
    const { data: existing } = await supabaseAdmin
      .from('league_members')
      .select('id')
      .eq('league_id', league.id)
      .eq('user_id', req.user.id)
      .single();

    if (existing) return res.status(400).json({ error: 'Already a member' });

    await supabaseAdmin.from('league_members').insert({
      league_id: league.id,
      user_id: req.user.id,
      role: 'member',
    });

    res.json({ message: 'Joined!', league });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ENTRIES
// ═══════════════════════════════════════════════════════════════

// Create entries for myself in a league
router.post('/leagues/:leagueId/entries', requireAuth, async (req, res) => {
  try {
    const { count = 3 } = req.body;
    const entries = await SurvivorEngine.createEntries(
      req.params.leagueId,
      req.user.id,
      count
    );
    res.status(201).json(entries);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get my entries in a league
router.get('/leagues/:leagueId/entries', requireAuth, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('entries')
      .select('*')
      .eq('league_id', req.params.leagueId)
      .eq('user_id', req.user.id)
      .order('entry_number');

    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// PICKS
// ═══════════════════════════════════════════════════════════════

// Submit a pick for an entry
router.post('/picks', requireAuth, async (req, res) => {
  try {
    const { entry_id, game_id, team_id } = req.body;

    // Verify user owns entry
    const { data: entry } = await supabaseAdmin
      .from('entries')
      .select('user_id')
      .eq('id', entry_id)
      .single();

    if (!entry || entry.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your entry' });
    }

    const pick = await SurvivorEngine.submitPick(entry_id, game_id, team_id);
    res.status(201).json(pick);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get available teams for an entry
router.get('/entries/:entryId/available-teams', requireAuth, async (req, res) => {
  try {
    const teams = await SurvivorEngine.getAvailableTeams(req.params.entryId);
    res.json(teams);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get used teams for an entry
router.get('/entries/:entryId/used-teams', requireAuth, async (req, res) => {
  try {
    const teams = await SurvivorEngine.getUsedTeams(req.params.entryId);
    res.json(teams);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get pick history for an entry
router.get('/entries/:entryId/history', requireAuth, async (req, res) => {
  try {
    const history = await SurvivorEngine.getEntryHistory(req.params.entryId);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GAMES & BRACKET
// ═══════════════════════════════════════════════════════════════

// Get today's games
router.get('/games/today', requireAuth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const games = await SurvivorEngine.getTodaysGames(TOURNAMENT_ID, date);
    res.json(games);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get games by round
router.get('/games/round/:round', requireAuth, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('games')
      .select(`
        *,
        team_a:teams!games_team_a_id_fkey(id, name, seed, region, record, conference),
        team_b:teams!games_team_b_id_fkey(id, name, seed, region, record, conference),
        winner:teams!games_winner_id_fkey(id, name, seed)
      `)
      .eq('tournament_id', TOURNAMENT_ID)
      .eq('round', parseInt(req.params.round))
      .order('game_date')
      .order('game_time');

    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all teams
router.get('/teams', async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('teams')
      .select('*')
      .eq('tournament_id', TOURNAMENT_ID)
      .order('region')
      .order('seed');

    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// STANDINGS
// ═══════════════════════════════════════════════════════════════

// Entry-level standings
router.get('/leagues/:leagueId/standings', requireAuth, async (req, res) => {
  try {
    const standings = await SurvivorEngine.getLeagueStandings(req.params.leagueId);
    res.json(standings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Member-level standings (aggregated)
router.get('/leagues/:leagueId/standings/members', requireAuth, async (req, res) => {
  try {
    const standings = await SurvivorEngine.getMemberStandings(req.params.leagueId);
    res.json(standings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN (seed bracket, sync odds, score games)
// ═══════════════════════════════════════════════════════════════

router.post('/admin/seed-bracket', async (req, res) => {
  try {
    const result = await BracketSeeder.seedAll();
    res.json({ message: 'Bracket seeded', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/sync-odds', async (req, res) => {
  try {
    const result = await OddsService.syncOddsToGames(TOURNAMENT_ID);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/sync-scores', async (req, res) => {
  try {
    await OddsService.syncScoresToGames(TOURNAMENT_ID);
    const scored = await SurvivorEngine.scoreAllPendingGames(TOURNAMENT_ID);
    res.json({ message: 'Scores synced and games scored', scored });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/advance-bracket', async (req, res) => {
  try {
    const { completed_round } = req.body;
    const result = await BracketSeeder.advanceBracket(TOURNAMENT_ID, completed_round);
    res.json({ message: `Round ${completed_round + 1} games created`, games: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ESPN SCORE SYNC
// ═══════════════════════════════════════════════════════════════
const ESPNScoreService = require('./espnScoreService');
const RoundAdvancer = require('./advanceRounds');
const EmailReminder = require('./emailReminder');

router.get('/admin/espn-sync', async (req, res) => {
  try {
    const scoreResult = await ESPNScoreService.syncScoresToGames('00000000-0000-0000-0000-000000002026');
    let pickResult = { scored: 0 };
    if (scoreResult.updated > 0) {
      pickResult = await ESPNScoreService.scorePicks('00000000-0000-0000-0000-000000002026');
    }
    // Auto-advance rounds if all games in current round are final
    const advanceResult = await RoundAdvancer.checkAndAdvance();
    console.log('[ADVANCE]', advanceResult.log.join(', '));

    res.json({ message: 'ESPN sync complete', advance: advanceResult, scores: scoreResult, picks: pickResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/espn-sync', async (req, res) => {
  try {
    const scoreResult = await ESPNScoreService.syncScoresToGames('00000000-0000-0000-0000-000000002026');
    let pickResult = { scored: 0 };
    if (scoreResult.updated > 0) {
      pickResult = await ESPNScoreService.scorePicks('00000000-0000-0000-0000-000000002026');
    }
    res.json({ message: 'ESPN sync complete', scores: scoreResult, picks: pickResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════
// Send pick reminders to users without picks
// ═══════════════════════════════════════════
router.get('/admin/send-reminders', async (req, res) => {
  try {
    const result = await EmailReminder.sendPickReminders();
    res.json({ message: 'Reminders processed', ...result });
  } catch (err) {
    console.error('[REMINDER ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});


router.get("/admin/send-reminders", async (req, res) => {
  try {
    const result = await EmailReminder.sendPickReminders();
    res.json({ message: "Reminders processed", ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
