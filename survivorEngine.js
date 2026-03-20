// ═══════════════════════════════════════════════════════════════
// BARRY BETS — Survivor League Engine
// Core game logic: picks, validation, scoring, elimination
// ═══════════════════════════════════════════════════════════════

const { supabase, supabaseAdmin } = require('./supabase');

class SurvivorEngine {

  // ─── ENTRY MANAGEMENT ────────────────────────────────────

  /**
   * Create entries for a member (up to league max, default 3)
   * Each entry is an independent survival path
   */
  static async createEntries(leagueId, userId, count = 3) {
    // Verify membership
    const { data: member } = await supabaseAdmin
      .from('league_members')
      .select('id')
      .eq('league_id', leagueId)
      .eq('user_id', userId)
      .single();

    if (!member) throw new Error('Not a member of this league');

    // Get league config
    const { data: league } = await supabaseAdmin
      .from('leagues')
      .select('max_entries_per_member')
      .eq('id', leagueId)
      .single();

    // Check existing entries
    const { data: existing } = await supabaseAdmin
      .from('entries')
      .select('entry_number')
      .eq('league_id', leagueId)
      .eq('user_id', userId);

    const existingCount = existing?.length || 0;
    const maxEntries = league.max_entries_per_member;
    const toCreate = Math.min(count, maxEntries - existingCount);

    if (toCreate <= 0) {
      throw new Error(`Already have ${existingCount} entries (max: ${maxEntries})`);
    }

    const entries = [];
    for (let i = 0; i < toCreate; i++) {
      const entryNumber = existingCount + i + 1;
      entries.push({
        league_id: leagueId,
        user_id: userId,
        entry_number: entryNumber,
        name: `Entry ${entryNumber}`,
        status: 'alive',
        total_points: 0,
        current_streak: 0,
      });
    }

    const { data, error } = await supabaseAdmin
      .from('entries')
      .insert(entries)
      .select();

    if (error) throw error;
    return data;
  }

  // ─── PICK MANAGEMENT ─────────────────────────────────────

  /**
   * Submit a pick for an entry
   * Validates: entry alive, team not used, game scheduled, one pick per day
   */
  static async submitPick(entryId, gameId, teamId) {
    // Get entry details
    const { data: entry, error: entryErr } = await supabaseAdmin
      .from('entries')
      .select('*, leagues(tournament_id, scoring)')
      .eq('id', entryId)
      .single();

    if (entryErr || !entry) throw new Error('Entry not found');
    if (entry.status !== 'alive') throw new Error('Entry has been eliminated');

    // Get game details
    const { data: game, error: gameErr } = await supabaseAdmin
      .from('games')
      .select('*')
      .eq('id', gameId)
      .single();

    if (gameErr || !game) throw new Error('Game not found');
    if (game.status !== 'scheduled') throw new Error('Game has already started or completed');

    // Verify team is in this game
    if (game.team_a_id !== teamId && game.team_b_id !== teamId) {
      throw new Error('Selected team is not playing in this game');
    }

    // Check team hasn't been used by this entry
    const { data: usedTeam } = await supabaseAdmin
      .from('used_teams')
      .select('id')
      .eq('entry_id', entryId)
      .eq('team_id', teamId)
      .single();

    if (usedTeam) throw new Error('You already used this team in a previous round');

    // Check no existing pick for this entry on this game date
    const { data: existingPick } = await supabaseAdmin
      .from('picks')
      .select('id')
      .eq('entry_id', entryId)
      .eq('pick_date', game.game_date)
      .single();

    if (existingPick) {
      // Allow changing pick if game hasn't started
      await supabaseAdmin.from('picks').delete().eq('id', existingPick.id);
      await supabaseAdmin.from('used_teams').delete()
        .eq('entry_id', entryId)
        .eq('used_in_round', game.round);
    }

    // Insert pick
    const { data: pick, error: pickErr } = await supabaseAdmin
      .from('picks')
      .insert({
        entry_id: entryId,
        game_id: gameId,
        team_id: teamId,
        round: game.round,
        pick_date: game.game_date,
        result: 'pending',
      })
      .select()
      .single();

    if (pickErr) throw pickErr;

    // Record team as used
    await supabaseAdmin.from('used_teams').insert({
      entry_id: entryId,
      team_id: teamId,
      used_in_round: game.round,
      used_on: game.game_date,
    });

    return pick;
  }

  /**
   * Get available teams for an entry (not eliminated, not already used)
   */
  static async getAvailableTeams(entryId) {
    const { data: entry } = await supabaseAdmin
      .from('entries')
      .select('league_id, leagues(tournament_id)')
      .eq('id', entryId)
      .single();

    if (!entry) throw new Error('Entry not found');

    // Get all used team IDs for this entry
    const { data: usedTeams } = await supabaseAdmin
      .from('used_teams')
      .select('team_id')
      .eq('entry_id', entryId);

    const usedIds = (usedTeams || []).map(ut => ut.team_id);

    // Get all tournament teams that are still alive and not used
    let query = supabaseAdmin
      .from('teams')
      .select('*')
      .eq('tournament_id', entry.leagues.tournament_id)
      .eq('eliminated', false)
      .order('seed', { ascending: true });

    if (usedIds.length > 0) {
      query = query.not('id', 'in', `(${usedIds.join(',')})`);
    }

    const { data: teams } = await query;
    return teams || [];
  }

  /**
   * Get today's games that are available for picking
   */
  static async getTodaysGames(tournamentId, date = null) {
    const gameDate = date || new Date().toISOString().split('T')[0];

    const { data: games } = await supabaseAdmin
      .from('games')
      .select(`
        *,
        team_a:teams!games_team_a_id_fkey(id, name, seed, region, record, conference),
        team_b:teams!games_team_b_id_fkey(id, name, seed, region, record, conference)
      `)
      .eq('tournament_id', tournamentId)
      .eq('game_date', gameDate)
      .in('status', ['scheduled', 'live'])
      .order('game_time', { ascending: true });

    return games || [];
  }

  // ─── SCORING ENGINE ──────────────────────────────────────

  /**
   * Score a completed game — update all picks, eliminate losers
   */
  static async scoreGame(gameId) {
    const { data: game } = await supabaseAdmin
      .from('games')
      .select('*')
      .eq('id', gameId)
      .single();

    if (!game) throw new Error('Game not found');
    if (game.status !== 'final') throw new Error('Game is not final');
    if (!game.winner_id) throw new Error('Game has no winner');

    // Get round points from tournament config
    const { data: tournament } = await supabaseAdmin
      .from('tournaments')
      .select('rounds')
      .eq('id', game.tournament_id)
      .single();

    const roundConfig = tournament.rounds.find(r => r.round === game.round);
    const pointsForRound = roundConfig?.points || 0;

    // Get all pending picks for this game
    const { data: picks } = await supabaseAdmin
      .from('picks')
      .select('id, entry_id, team_id')
      .eq('game_id', gameId)
      .eq('result', 'pending');

    if (!picks || picks.length === 0) return { scored: 0 };

    let winners = 0;
    let losers = 0;

    for (const pick of picks) {
      if (pick.team_id === game.winner_id) {
        // ✓ Correct pick — award points, stay alive
        await supabaseAdmin
          .from('picks')
          .update({ result: 'win', points_earned: pointsForRound })
          .eq('id', pick.id);

        await supabaseAdmin.rpc('increment_entry_points', {
          p_entry_id: pick.entry_id,
          p_points: pointsForRound,
        });

        winners++;
      } else {
        // ✗ Wrong pick — eliminate entry
        await supabaseAdmin
          .from('picks')
          .update({ result: 'loss', points_earned: 0 })
          .eq('id', pick.id);

        await supabaseAdmin
          .from('entries')
          .update({
            status: 'eliminated',
            eliminated_round: game.round,
            current_streak: 0,
          })
          .eq('id', pick.entry_id);

        losers++;
      }
    }

    // Mark losing team as eliminated from tournament
    const loserId = game.team_a_id === game.winner_id ? game.team_b_id : game.team_a_id;
    await supabaseAdmin
      .from('teams')
      .update({ eliminated: true, eliminated_round: game.round })
      .eq('id', loserId);

    return { scored: picks.length, winners, losers, pointsAwarded: pointsForRound };
  }

  /**
   * Score all final games that haven't been scored yet
   */
  static async scoreAllPendingGames(tournamentId) {
    const { data: games } = await supabaseAdmin
      .from('games')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('status', 'final')
      .not('winner_id', 'is', null);

    // Only score games that still have pending picks
    const results = [];
    for (const game of (games || [])) {
      const { data: pendingPicks } = await supabaseAdmin
        .from('picks')
        .select('id')
        .eq('game_id', game.id)
        .eq('result', 'pending')
        .limit(1);

      if (pendingPicks && pendingPicks.length > 0) {
        const result = await this.scoreGame(game.id);
        results.push({ gameId: game.id, ...result });
      }
    }

    return results;
  }

  // ─── STANDINGS & STATS ───────────────────────────────────

  /**
   * Get league standings (all entries ranked)
   */
  static async getLeagueStandings(leagueId) {
    const { data } = await supabaseAdmin
      .from('entries')
      .select(`
        id,
        entry_number,
        name,
        status,
        total_points,
        current_streak,
        eliminated_round,
        user_id,
        profiles(display_name, initials, avatar_color)
      `)
      .eq('league_id', leagueId)
      .order('total_points', { ascending: false })
      .order('status', { ascending: true })  // alive first
      .order('current_streak', { ascending: false });

    return (data || []).map((entry, i) => ({
      rank: i + 1,
      ...entry,
    }));
  }

  /**
   * Get member standings (aggregated across entries)
   */
  static async getMemberStandings(leagueId) {
    const { data: entries } = await supabaseAdmin
      .from('entries')
      .select(`
        user_id,
        status,
        total_points,
        current_streak,
        profiles(display_name, initials, avatar_color)
      `)
      .eq('league_id', leagueId);

    // Aggregate by member
    const memberMap = {};
    for (const entry of (entries || [])) {
      if (!memberMap[entry.user_id]) {
        memberMap[entry.user_id] = {
          user_id: entry.user_id,
          display_name: entry.profiles.display_name,
          initials: entry.profiles.initials,
          avatar_color: entry.profiles.avatar_color,
          total_points: 0,
          alive_entries: 0,
          eliminated_entries: 0,
          best_streak: 0,
        };
      }
      const m = memberMap[entry.user_id];
      m.total_points += entry.total_points;
      if (entry.status === 'alive') m.alive_entries++;
      else m.eliminated_entries++;
      m.best_streak = Math.max(m.best_streak, entry.current_streak);
    }

    return Object.values(memberMap)
      .sort((a, b) => b.total_points - a.total_points || b.alive_entries - a.alive_entries)
      .map((m, i) => ({ rank: i + 1, ...m }));
  }

  /**
   * Get pick history for an entry (which teams used, results)
   */
  static async getEntryHistory(entryId) {
    const { data } = await supabaseAdmin
      .from('picks')
      .select(`
        id,
        round,
        pick_date,
        result,
        points_earned,
        team:teams(id, name, seed, region),
        game:games(id, team_a:teams!games_team_a_id_fkey(name, seed),
                       team_b:teams!games_team_b_id_fkey(name, seed),
                       team_a_score, team_b_score, status)
      `)
      .eq('entry_id', entryId)
      .order('round', { ascending: true })
      .order('pick_date', { ascending: true });

    return data || [];
  }

  /**
   * Get used teams for an entry
   */
  static async getUsedTeams(entryId) {
    const { data } = await supabaseAdmin
      .from('used_teams')
      .select(`
        team:teams(id, name, seed, region),
        used_in_round,
        used_on
      `)
      .eq('entry_id', entryId)
      .order('used_in_round', { ascending: true });

    return data || [];
  }

  // ─── DEADLINE MANAGEMENT ─────────────────────────────────

  /**
   * Lock all picks for games that have started
   * Called periodically to prevent late changes
   */
  static async lockPicksForStartedGames(tournamentId) {
    const { data: liveGames } = await supabaseAdmin
      .from('games')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('status', 'live');

    if (!liveGames || liveGames.length === 0) return;

    const gameIds = liveGames.map(g => g.id);

    const { data } = await supabaseAdmin
      .from('picks')
      .update({ locked_at: new Date().toISOString() })
      .in('game_id', gameIds)
      .is('locked_at', null)
      .select();

    return data;
  }

  /**
   * Check for entries that didn't make a pick today (auto-eliminate option)
   * This is optional — leagues can decide if missing a pick = elimination
   */
  static async checkMissedPicks(leagueId, gameDate) {
    const { data: league } = await supabaseAdmin
      .from('leagues')
      .select('tournament_id')
      .eq('id', leagueId)
      .single();

    // Get games on this date
    const { data: games } = await supabaseAdmin
      .from('games')
      .select('id')
      .eq('tournament_id', league.tournament_id)
      .eq('game_date', gameDate)
      .eq('status', 'final');

    if (!games || games.length === 0) return [];

    // Get alive entries that didn't pick today
    const { data: aliveEntries } = await supabaseAdmin
      .from('entries')
      .select('id')
      .eq('league_id', leagueId)
      .eq('status', 'alive');

    const { data: picksToday } = await supabaseAdmin
      .from('picks')
      .select('entry_id')
      .eq('pick_date', gameDate)
      .in('entry_id', (aliveEntries || []).map(e => e.id));

    const pickedEntryIds = new Set((picksToday || []).map(p => p.entry_id));
    const missedEntries = (aliveEntries || []).filter(e => !pickedEntryIds.has(e.id));

    return missedEntries;
  }
}

module.exports = SurvivorEngine;
