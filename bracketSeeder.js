// ═══════════════════════════════════════════════════════════════
// BARRY BETS — Bracket Seeder (Round of 64 Only)
// Seeds all first round matchups for the 2026 NCAA Tournament
// First Four winners slotted as TBD until resolved
// ═══════════════════════════════════════════════════════════════

const { supabaseAdmin } = require('./supabase');

const TOURNAMENT_ID = '00000000-0000-0000-0000-000000002026';

// Thursday March 19 — East & South regions
// Friday March 20 — West & Midwest regions
const R64_MATCHUPS = [
  // ═══ EAST REGION — Thursday March 19 ═══
  { region: 'East', date: '2026-03-19', seedA: 1, teamA: 'Duke',           seedB: 16, teamB: 'Siena' },
  { region: 'East', date: '2026-03-19', seedA: 8, teamA: 'Ohio State',     seedB: 9,  teamB: 'TCU' },
  { region: 'East', date: '2026-03-19', seedA: 5, teamA: "St. John's",     seedB: 12, teamB: 'Northern Iowa' },
  { region: 'East', date: '2026-03-19', seedA: 4, teamA: 'Kansas',         seedB: 13, teamB: 'Cal Baptist' },
  { region: 'East', date: '2026-03-19', seedA: 6, teamA: 'Louisville',     seedB: 11, teamB: 'South Florida' },
  { region: 'East', date: '2026-03-19', seedA: 3, teamA: 'Michigan State', seedB: 14, teamB: 'North Dakota State' },
  { region: 'East', date: '2026-03-19', seedA: 7, teamA: 'UCLA',           seedB: 10, teamB: 'UCF' },
  { region: 'East', date: '2026-03-19', seedA: 2, teamA: 'UConn',          seedB: 15, teamB: 'Furman' },

  // ═══ SOUTH REGION — Thursday March 19 ═══
  { region: 'South', date: '2026-03-19', seedA: 1, teamA: 'Florida',        seedB: 16, teamB: null }, // First Four winner (Prairie View/Lehigh)
  { region: 'South', date: '2026-03-19', seedA: 8, teamA: 'Clemson',        seedB: 9,  teamB: 'Iowa' },
  { region: 'South', date: '2026-03-19', seedA: 5, teamA: 'Vanderbilt',     seedB: 12, teamB: 'McNeese' },
  { region: 'South', date: '2026-03-19', seedA: 4, teamA: 'Nebraska',       seedB: 13, teamB: 'Troy' },
  { region: 'South', date: '2026-03-19', seedA: 6, teamA: 'North Carolina', seedB: 11, teamB: 'VCU' },
  { region: 'South', date: '2026-03-19', seedA: 3, teamA: 'Illinois',       seedB: 14, teamB: 'Penn' },
  { region: 'South', date: '2026-03-19', seedA: 7, teamA: "Saint Mary's",   seedB: 10, teamB: 'Texas A&M' },
  { region: 'South', date: '2026-03-19', seedA: 2, teamA: 'Houston',        seedB: 15, teamB: 'Idaho' },

  // ═══ WEST REGION — Friday March 20 ═══
  { region: 'West', date: '2026-03-20', seedA: 1, teamA: 'Arizona',     seedB: 16, teamB: 'LIU' },
  { region: 'West', date: '2026-03-20', seedA: 8, teamA: 'Villanova',   seedB: 9,  teamB: 'Utah State' },
  { region: 'West', date: '2026-03-20', seedA: 5, teamA: 'Wisconsin',   seedB: 12, teamB: 'High Point' },
  { region: 'West', date: '2026-03-20', seedA: 4, teamA: 'Arkansas',    seedB: 13, teamB: 'Hawaii' },
  { region: 'West', date: '2026-03-20', seedA: 6, teamA: 'BYU',         seedB: 11, teamB: null }, // First Four winner (Texas/NC State)
  { region: 'West', date: '2026-03-20', seedA: 3, teamA: 'Gonzaga',     seedB: 14, teamB: 'Kennesaw State' },
  { region: 'West', date: '2026-03-20', seedA: 7, teamA: 'Miami (FL)',  seedB: 10, teamB: 'Missouri' },
  { region: 'West', date: '2026-03-20', seedA: 2, teamA: 'Purdue',      seedB: 15, teamB: 'Queens' },

  // ═══ MIDWEST REGION — Friday March 20 ═══
  { region: 'Midwest', date: '2026-03-20', seedA: 1, teamA: 'Michigan',    seedB: 16, teamB: null }, // First Four winner (UMBC/Howard)
  { region: 'Midwest', date: '2026-03-20', seedA: 8, teamA: 'Georgia',     seedB: 9,  teamB: 'Saint Louis' },
  { region: 'Midwest', date: '2026-03-20', seedA: 5, teamA: 'Texas Tech',  seedB: 12, teamB: 'Akron' },
  { region: 'Midwest', date: '2026-03-20', seedA: 4, teamA: 'Alabama',     seedB: 13, teamB: 'Hofstra' },
  { region: 'Midwest', date: '2026-03-20', seedA: 6, teamA: 'Tennessee',   seedB: 11, teamB: null }, // First Four winner (Miami OH/SMU)
  { region: 'Midwest', date: '2026-03-20', seedA: 3, teamA: 'Virginia',    seedB: 14, teamB: 'Wright State' },
  { region: 'Midwest', date: '2026-03-20', seedA: 7, teamA: 'Kentucky',    seedB: 10, teamB: 'Santa Clara' },
  { region: 'Midwest', date: '2026-03-20', seedA: 2, teamA: 'Iowa State',  seedB: 15, teamB: 'Tennessee State' },
];

class BracketSeeder {

  /**
   * Seed all 32 Round of 64 matchups
   * Games with null teamB are First Four placeholders (resolved later)
   */
  static async seedRoundOf64() {
    // Get all teams by name for ID lookup
    const { data: allTeams } = await supabaseAdmin
      .from('teams')
      .select('id, name, seed')
      .eq('tournament_id', TOURNAMENT_ID);

    const teamByName = {};
    for (const t of allTeams) {
      teamByName[t.name] = t;
    }

    const games = [];

    for (const matchup of R64_MATCHUPS) {
      const teamA = teamByName[matchup.teamA];
      const teamB = matchup.teamB ? teamByName[matchup.teamB] : null;

      if (!teamA) {
        console.warn(`[Seeder] Team not found: ${matchup.teamA}`);
        continue;
      }

      games.push({
        tournament_id: TOURNAMENT_ID,
        round: 1,
        game_date: matchup.date,
        region: matchup.region,
        team_a_id: teamA.id,
        team_b_id: teamB?.id || null,
        team_a_seed: matchup.seedA,
        team_b_seed: matchup.seedB,
        status: 'scheduled',
      });
    }

    // Clear existing R64 games first (idempotent)
    await supabaseAdmin
      .from('games')
      .delete()
      .eq('tournament_id', TOURNAMENT_ID)
      .eq('round', 1);

    const { data, error } = await supabaseAdmin
      .from('games')
      .insert(games)
      .select();

    if (error) {
      console.error('[Seeder] Error:', error);
      throw error;
    }

    console.log(`[Seeder] Seeded ${data.length} Round of 64 games (${games.filter(g => !g.team_b_id).length} pending First Four winners)`);
    return data;
  }

  /**
   * Slot a First Four winner into their R64 game
   * Call this after each First Four game finishes
   */
  static async slotFirstFourWinner(winnerId, region, seed) {
    const { data: game } = await supabaseAdmin
      .from('games')
      .select('id')
      .eq('tournament_id', TOURNAMENT_ID)
      .eq('round', 1)
      .eq('region', region)
      .is('team_b_id', null)
      .single();

    if (!game) {
      console.warn(`[Seeder] No empty R64 slot found for ${region} seed ${seed}`);
      return null;
    }

    const { data } = await supabaseAdmin
      .from('games')
      .update({ team_b_id: winnerId, team_b_seed: seed })
      .eq('id', game.id)
      .select()
      .single();

    console.log(`[Seeder] Slotted First Four winner into R64: ${region}`);
    return data;
  }

  /**
   * Generate next round matchups after current round completes
   * Bracket structure: 1/16 winner vs 8/9 winner, 5/12 vs 4/13, 6/11 vs 3/14, 7/10 vs 2/15
   */
  static async advanceToNextRound(completedRound) {
    const nextRound = completedRound + 1;

    const roundDates = {
      2: { 'East': '2026-03-21', 'South': '2026-03-21', 'West': '2026-03-22', 'Midwest': '2026-03-22' },
      3: { 'East': '2026-03-26', 'South': '2026-03-26', 'West': '2026-03-27', 'Midwest': '2026-03-27' },
      4: { 'East': '2026-03-28', 'South': '2026-03-28', 'West': '2026-03-29', 'Midwest': '2026-03-29' },
      5: { '_all': '2026-04-04' },
      6: { '_all': '2026-04-06' },
    };

    // Get completed games from this round, ordered by bracket position
    const { data: games } = await supabaseAdmin
      .from('games')
      .select('id, region, winner_id, team_a_seed, team_b_seed')
      .eq('tournament_id', TOURNAMENT_ID)
      .eq('round', completedRound)
      .eq('status', 'final')
      .not('winner_id', 'is', null)
      .order('region')
      .order('team_a_seed');

    // Group by region
    const byRegion = {};
    for (const g of (games || [])) {
      if (!byRegion[g.region]) byRegion[g.region] = [];
      byRegion[g.region].push(g.winner_id);
    }

    const newGames = [];

    for (const [region, winners] of Object.entries(byRegion)) {
      const date = roundDates[nextRound]?.[region] || roundDates[nextRound]?.['_all'] || '2026-04-04';

      // Pair adjacent winners: [0,1], [2,3], [4,5], [6,7]
      for (let i = 0; i < winners.length - 1; i += 2) {
        const { data: tA } = await supabaseAdmin.from('teams').select('seed').eq('id', winners[i]).single();
        const { data: tB } = await supabaseAdmin.from('teams').select('seed').eq('id', winners[i + 1]).single();

        newGames.push({
          tournament_id: TOURNAMENT_ID,
          round: nextRound,
          game_date: date,
          region: nextRound <= 4 ? region : null, // Final Four+ has no region
          team_a_id: winners[i],
          team_b_id: winners[i + 1],
          team_a_seed: tA?.seed,
          team_b_seed: tB?.seed,
          status: 'scheduled',
        });
      }
    }

    if (newGames.length === 0) return [];

    const { data, error } = await supabaseAdmin
      .from('games')
      .insert(newGames)
      .select();

    if (error) throw error;

    const roundNames = { 2: 'Round of 32', 3: 'Sweet 16', 4: 'Elite Eight', 5: 'Final Four', 6: 'Championship' };
    console.log(`[Seeder] Created ${data.length} ${roundNames[nextRound] || `Round ${nextRound}`} games`);
    return data;
  }
}

module.exports = BracketSeeder;
