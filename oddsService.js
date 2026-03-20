// ═══════════════════════════════════════════════════════════════
// BARRY BETS — March Madness Odds & Scores Service
// Fetches lines, spreads, and results from The Odds API
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const { supabaseAdmin } = require('./supabase');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_BASE_URL = 'https://api.the-odds-api.com/v4';
const SPORT_KEY = 'basketball_ncaab'; // NCAA Basketball

class OddsService {

  /**
   * Fetch upcoming game odds (spreads) for NCAA tournament
   */
  static async fetchOdds() {
    try {
      const response = await axios.get(`${ODDS_BASE_URL}/sports/${SPORT_KEY}/odds`, {
        params: {
          apiKey: ODDS_API_KEY,
          regions: 'us',
          markets: 'spreads,h2h',
          oddsFormat: 'american',
          dateFormat: 'iso',
        },
      });

      console.log(`[Odds] Fetched ${response.data.length} games, remaining requests: ${response.headers['x-requests-remaining']}`);
      return response.data;
    } catch (error) {
      console.error('[Odds] Error fetching odds:', error.message);
      return [];
    }
  }

  /**
   * Fetch completed scores for NCAA tournament games
   */
  static async fetchScores(daysFrom = 1) {
    try {
      const response = await axios.get(`${ODDS_BASE_URL}/sports/${SPORT_KEY}/scores`, {
        params: {
          apiKey: ODDS_API_KEY,
          daysFrom,
          dateFormat: 'iso',
        },
      });

      console.log(`[Scores] Fetched ${response.data.length} games`);
      return response.data;
    } catch (error) {
      console.error('[Scores] Error fetching scores:', error.message);
      return [];
    }
  }

  /**
   * Match an Odds API team name to our database team
   * Handles variations like "Duke Blue Devils" -> "Duke"
   */
  static normalizeTeamName(apiName) {
    // Common NCAA naming patterns
    const nameMap = {
      'Duke Blue Devils': 'Duke',
      'Arizona Wildcats': 'Arizona',
      'Michigan Wolverines': 'Michigan',
      'Florida Gators': 'Florida',
      'UConn Huskies': 'UConn',
      'Kansas Jayhawks': 'Kansas',
      'Purdue Boilermakers': 'Purdue',
      'Houston Cougars': 'Houston',
      'Iowa State Cyclones': 'Iowa State',
      'Alabama Crimson Tide': 'Alabama',
      'Michigan State Spartans': 'Michigan State',
      'Gonzaga Bulldogs': 'Gonzaga',
      'Virginia Cavaliers': 'Virginia',
      'Illinois Fighting Illini': 'Illinois',
      'North Carolina Tar Heels': 'North Carolina',
      'Kentucky Wildcats': 'Kentucky',
      'Tennessee Volunteers': 'Tennessee',
      'Arkansas Razorbacks': 'Arkansas',
      'BYU Cougars': 'BYU',
      'Louisville Cardinals': 'Louisville',
      'Wisconsin Badgers': 'Wisconsin',
      'UCLA Bruins': 'UCLA',
      'Ohio State Buckeyes': 'Ohio State',
      'TCU Horned Frogs': 'TCU',
      'Texas Tech Red Raiders': 'Texas Tech',
      'Nebraska Cornhuskers': 'Nebraska',
      'Vanderbilt Commodores': 'Vanderbilt',
      'Clemson Tigers': 'Clemson',
      'Iowa Hawkeyes': 'Iowa',
      'Georgia Bulldogs': 'Georgia',
      'Missouri Tigers': 'Missouri',
      'Texas A&M Aggies': 'Texas A&M',
      'Saint Mary\'s Gaels': 'Saint Mary\'s',
      'Villanova Wildcats': 'Villanova',
      'St. John\'s Red Storm': 'St. John\'s',
    };

    if (nameMap[apiName]) return nameMap[apiName];

    // Strip common suffixes
    const stripped = apiName
      .replace(/ (Blue Devils|Wildcats|Wolverines|Gators|Huskies|Jayhawks|Boilermakers|Cougars|Cyclones|Crimson Tide|Spartans|Bulldogs|Cavaliers|Fighting Illini|Tar Heels|Razorbacks|Cardinals|Badgers|Bruins|Buckeyes|Horned Frogs|Red Raiders|Cornhuskers|Commodores|Tigers|Hawkeyes|Aggies|Gaels|Volunteers|Musketeers|Bearcats|Friars|Hoyas|Mountaineers|Beavers|Ducks|Bears|Longhorns|Cowboys|Sooners|Panthers|Hurricanes|Seminoles|Yellow Jackets|Demon Deacons|Wolfpack)$/i, '');

    return stripped;
  }

  /**
   * Extract consensus spread from bookmakers
   */
  static extractSpread(bookmakers) {
    if (!bookmakers || bookmakers.length === 0) return null;

    const spreads = [];
    for (const book of bookmakers) {
      const spreadMarket = book.markets?.find(m => m.key === 'spreads');
      if (spreadMarket?.outcomes) {
        for (const outcome of spreadMarket.outcomes) {
          if (outcome.point < 0) {
            spreads.push({
              team: outcome.name,
              value: Math.abs(outcome.point),
            });
            break; // Just need the favorite
          }
        }
      }
    }

    if (spreads.length === 0) return null;

    // Average across bookmakers
    const avgSpread = spreads.reduce((sum, s) => sum + s.value, 0) / spreads.length;
    return {
      team: spreads[0].team,
      value: Math.round(avgSpread * 2) / 2, // Round to nearest 0.5
    };
  }

  /**
   * Sync odds data into our games table
   * Matches API games to our tournament games by team names
   */
  static async syncOddsToGames(tournamentId) {
    const oddsData = await this.fetchOdds();
    if (!oddsData.length) return { synced: 0 };

    // Get all teams for matching
    const { data: teams } = await supabaseAdmin
      .from('teams')
      .select('id, name')
      .eq('tournament_id', tournamentId);

    const teamByName = {};
    for (const t of teams) {
      teamByName[t.name.toLowerCase()] = t;
    }

    let synced = 0;

    for (const apiGame of oddsData) {
      const homeNorm = this.normalizeTeamName(apiGame.home_team);
      const awayNorm = this.normalizeTeamName(apiGame.away_team);

      const homeTeam = teamByName[homeNorm.toLowerCase()];
      const awayTeam = teamByName[awayNorm.toLowerCase()];

      if (!homeTeam || !awayTeam) continue;

      const spread = this.extractSpread(apiGame.bookmakers);

      // Find matching game in our DB
      const { data: existingGame } = await supabaseAdmin
        .from('games')
        .select('id')
        .eq('tournament_id', tournamentId)
        .or(`and(team_a_id.eq.${homeTeam.id},team_b_id.eq.${awayTeam.id}),and(team_a_id.eq.${awayTeam.id},team_b_id.eq.${homeTeam.id})`)
        .single();

      if (existingGame && spread) {
        const spreadTeam = teamByName[this.normalizeTeamName(spread.team)?.toLowerCase()];
        await supabaseAdmin
          .from('games')
          .update({
            spread_team_id: spreadTeam?.id,
            spread_value: spread.value,
            external_id: apiGame.id,
          })
          .eq('id', existingGame.id);
        synced++;
      }
    }

    console.log(`[Odds] Synced spreads for ${synced} tournament games`);
    return { synced };
  }

  /**
   * Sync final scores and determine winners
   */
  static async syncScoresToGames(tournamentId) {
    const scoresData = await this.fetchScores(3);
    if (!scoresData.length) return { updated: 0 };

    const { data: teams } = await supabaseAdmin
      .from('teams')
      .select('id, name')
      .eq('tournament_id', tournamentId);

    const teamByName = {};
    for (const t of teams) {
      teamByName[t.name.toLowerCase()] = t;
    }

    let updated = 0;

    for (const apiGame of scoresData) {
      if (!apiGame.completed) continue;

      const homeNorm = this.normalizeTeamName(apiGame.home_team);
      const awayNorm = this.normalizeTeamName(apiGame.away_team);
      const homeTeam = teamByName[homeNorm.toLowerCase()];
      const awayTeam = teamByName[awayNorm.toLowerCase()];

      if (!homeTeam || !awayTeam) continue;

      const homeScore = apiGame.scores?.find(s => s.name === apiGame.home_team)?.score;
      const awayScore = apiGame.scores?.find(s => s.name === apiGame.away_team)?.score;

      if (homeScore == null || awayScore == null) continue;

      const winnerId = parseInt(homeScore) > parseInt(awayScore) ? homeTeam.id : awayTeam.id;

      // Update game
      const { data: existingGame } = await supabaseAdmin
        .from('games')
        .select('id, status')
        .eq('tournament_id', tournamentId)
        .or(`and(team_a_id.eq.${homeTeam.id},team_b_id.eq.${awayTeam.id}),and(team_a_id.eq.${awayTeam.id},team_b_id.eq.${homeTeam.id})`)
        .neq('status', 'final')
        .single();

      if (existingGame) {
        await supabaseAdmin
          .from('games')
          .update({
            team_a_score: homeTeam.id === existingGame.team_a_id ? parseInt(homeScore) : parseInt(awayScore),
            team_b_score: homeTeam.id === existingGame.team_b_id ? parseInt(homeScore) : parseInt(awayScore),
            winner_id: winnerId,
            status: 'final',
          })
          .eq('id', existingGame.id);
        updated++;
      }
    }

    console.log(`[Scores] Updated ${updated} final game scores`);
    return { updated };
  }
}

module.exports = OddsService;
