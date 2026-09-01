// ═══════════════════════════════════════════════════════════════
// BARRY BETS — College Football Top 25 Survivor service
//
//   Games, ranks, spreads and scores all come from ESPN's college
//   football scoreboard. The spread rides along in the same payload,
//   so this pool costs nothing against the Odds API quota.
//
// House rules encoded here:
//   • A game is listed if EITHER side is ranked in the AP Top 25.
//     Georgia vs Furman is on the board.
//   • Picks are straight up. The spread is displayed, never scored.
//   • A team can only ever be used once, and buying back in does not
//     give those teams back.
//   • Everything locks at the first ranked kickoff of the week.
//   • Lose, and you are out. You may buy back in through week 5.
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const { supabaseAdmin } = require('./supabase');

const ESPN_CFB = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
const FBS_GROUP = 80;

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * ESPN hands the line over as a string like "TTU -13.5", "PK", or nothing
 * at all for a mismatch nobody books. Turn it into a side and a number.
 */
function parseEspnOdds(details, homeAbbr, awayAbbr) {
  if (!details) return null;
  const txt = String(details).trim();
  if (/^(even|pk|pick)$/i.test(txt)) return { favorite: 'home', spread_value: 0 };

  const m = txt.match(/^([A-Za-z&.'-]+)\s*([+-]?\d+(?:\.\d+)?)$/);
  if (!m) return null;

  const [, abbr, num] = m;
  const value = Math.abs(parseFloat(num));
  if (Number.isNaN(value)) return null;

  const a = norm(abbr);
  const favorite = a === norm(homeAbbr) ? 'home' : a === norm(awayAbbr) ? 'away' : null;
  if (!favorite) return null;

  // A positive number next to a team would mean that team is the dog.
  const flipped = parseFloat(num) > 0;
  return {
    favorite: flipped ? (favorite === 'home' ? 'away' : 'home') : favorite,
    spread_value: value,
  };
}

class CFBService {

  static poolToCfbWeek(season, poolWeek) {
    return (season.first_cfb_week || 3) + poolWeek - 1;
  }

  static async fetchWeek(cfbWeek, year) {
    try {
      const url = `${ESPN_CFB}?dates=${year}&seasontype=2&week=${cfbWeek}&groups=${FBS_GROUP}&limit=300`;
      const { data } = await axios.get(url, { timeout: 20000 });
      return data.events || [];
    } catch (err) {
      console.error(`[CFB] ESPN week ${cfbWeek} fetch failed:`, err.message);
      return [];
    }
  }

  /**
   * Pull every game involving a Top 25 team for one pool week.
   * Idempotent — refreshes ranks, kickoff times and lines, but never
   * touches a game that has already gone final.
   */
  static async syncWeek(seasonId, poolWeek) {
    const { data: season } = await supabaseAdmin
      .from('cfb_seasons').select('*').eq('id', seasonId).single();
    if (!season) throw new Error('Season not found');

    const cfbWeek = this.poolToCfbWeek(season, poolWeek);
    const events = await this.fetchWeek(cfbWeek, season.year);
    if (!events.length) return { synced: 0, message: `No ESPN events for CFB week ${cfbWeek}` };

    let synced = 0;
    const log = [];

    for (const ev of events) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;

      const hr = home.curatedRank?.current;
      const ar = away.curatedRank?.current;
      const homeRank = hr && hr <= 25 ? hr : null;
      const awayRank = ar && ar <= 25 ? ar : null;
      if (!homeRank && !awayRank) continue;          // no ranked team, not our game

      const odds = parseEspnOdds(comp.odds?.[0]?.details, home.team.abbreviation, away.team.abbreviation);

      const row = {
        season_id: seasonId,
        pool_week: poolWeek,
        cfb_week: cfbWeek,
        espn_event_id: String(ev.id),
        away_team: away.team.displayName,
        home_team: home.team.displayName,
        away_team_id: String(away.team.id),
        home_team_id: String(home.team.id),
        away_abbr: away.team.abbreviation,
        home_abbr: home.team.abbreviation,
        away_rank: awayRank,
        home_rank: homeRank,
        kickoff_at: ev.date,
        favorite: odds?.favorite ?? null,
        spread_value: odds?.spread_value ?? null,
        spread_source: odds ? 'espn' : null,
        updated_at: new Date().toISOString(),
      };

      const { data: existing } = await supabaseAdmin
        .from('cfb_games').select('id, status')
        .eq('season_id', seasonId).eq('espn_event_id', String(ev.id)).maybeSingle();

      if (existing) {
        if (existing.status === 'final') continue;
        await supabaseAdmin.from('cfb_games').update(row).eq('id', existing.id);
      } else {
        await supabaseAdmin.from('cfb_games').insert(row);
      }
      synced++;
      log.push(`${awayRank ? '#'+awayRank+' ' : ''}${row.away_team} at ${homeRank ? '#'+homeRank+' ' : ''}${row.home_team}`);
    }

    console.log(`[CFB] Week ${poolWeek} (CFB ${cfbWeek}): ${synced} ranked games`);
    return { synced, cfb_week: cfbWeek, log };
  }

  /** Picks lock at the first ranked kickoff of the week. */
  static async lockTime(seasonId, poolWeek) {
    const { data } = await supabaseAdmin
      .from('cfb_games').select('kickoff_at')
      .eq('season_id', seasonId).eq('pool_week', poolWeek)
      .order('kickoff_at').limit(1).maybeSingle();
    return data ? data.kickoff_at : null;
  }

  static async isLocked(seasonId, poolWeek) {
    const t = await this.lockTime(seasonId, poolWeek);
    return t ? new Date(t) <= new Date() : false;
  }

  static async syncScores(seasonId, poolWeek) {
    const { data: season } = await supabaseAdmin
      .from('cfb_seasons').select('*').eq('id', seasonId).single();
    const cfbWeek = this.poolToCfbWeek(season, poolWeek);

    const { data: games } = await supabaseAdmin
      .from('cfb_games').select('id, espn_event_id, status')
      .eq('season_id', seasonId).eq('pool_week', poolWeek).neq('status', 'final');
    if (!games || !games.length) return { updated: 0, message: 'Nothing pending' };

    const events = await this.fetchWeek(cfbWeek, season.year);
    const byId = Object.fromEntries(events.map(e => [String(e.id), e]));

    let updated = 0;
    for (const g of games) {
      const ev = byId[g.espn_event_id];
      if (!ev) continue;
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;

      const complete = comp.status?.type?.completed === true;
      const hs = parseInt(home.score, 10);
      const as = parseInt(away.score, 10);
      const scored = Number.isFinite(hs) && Number.isFinite(as);

      await supabaseAdmin.from('cfb_games').update({
        home_score: scored ? hs : null,
        away_score: scored ? as : null,
        winner_side: complete && scored ? (hs > as ? 'home' : as > hs ? 'away' : null) : null,
        status: complete ? 'final' : (scored ? 'in_progress' : 'scheduled'),
        updated_at: new Date().toISOString(),
      }).eq('id', g.id);
      updated++;
    }
    return { updated };
  }

  /**
   * Grade a week: mark picks, knock out anyone who lost, and knock out
   * anyone who never picked once every game is final.
   */
  static async gradeWeek(seasonId, poolWeek) {
    const { data: games } = await supabaseAdmin
      .from('cfb_games').select('id, winner_side, status, home_team, away_team')
      .eq('season_id', seasonId).eq('pool_week', poolWeek);
    if (!games || !games.length) return { graded: 0 };

    const finals = Object.fromEntries(
      games.filter(g => g.status === 'final' && g.winner_side).map(g => [g.id, g.winner_side])
    );

    const { data: picks } = await supabaseAdmin
      .from('cfb_picks').select('id, player_id, game_id, picked_side, result')
      .eq('season_id', seasonId).eq('pool_week', poolWeek).eq('result', 'pending');

    let graded = 0, eliminated = 0;
    const log = [];

    for (const p of picks || []) {
      const winner = finals[p.game_id];
      if (!winner) continue;
      const won = p.picked_side === winner;

      await supabaseAdmin.from('cfb_picks')
        .update({ result: won ? 'win' : 'loss', graded_at: new Date().toISOString() })
        .eq('id', p.id);
      graded++;

      if (!won) {
        await supabaseAdmin.from('cfb_players')
          .update({ status: 'eliminated', eliminated_week: poolWeek })
          .eq('id', p.player_id).eq('status', 'alive');
        eliminated++;
      }
    }

    // Everyone still alive who never submitted a pick, once the week is done.
    const allFinal = games.every(g => g.status === 'final');
    let missed = 0;
    if (allFinal) {
      const { data: alive } = await supabaseAdmin
        .from('cfb_players').select('id, display_name')
        .eq('season_id', seasonId).eq('status', 'alive');
      for (const pl of alive || []) {
        const { data: has } = await supabaseAdmin
          .from('cfb_picks').select('id')
          .eq('season_id', seasonId).eq('pool_week', poolWeek).eq('player_id', pl.id).maybeSingle();
        if (!has) {
          await supabaseAdmin.from('cfb_players')
            .update({ status: 'eliminated', eliminated_week: poolWeek }).eq('id', pl.id);
          log.push(`${pl.display_name} made no pick and is out`);
          missed++;
        }
      }
    }

    console.log(`[CFB] Week ${poolWeek}: graded ${graded}, eliminated ${eliminated + missed}`);
    return { graded, eliminated, missed_picks: missed, log };
  }

  /**
   * Buy back in. Allowed while the buy-back window is open. Used teams
   * are deliberately NOT returned — what you burned stays burned.
   */
  static async buyBack(seasonId, playerId, poolWeek) {
    const { data: season } = await supabaseAdmin
      .from('cfb_seasons').select('*').eq('id', seasonId).single();
    if (!season) throw new Error('Season not found');

    const { data: player } = await supabaseAdmin
      .from('cfb_players').select('*').eq('id', playerId).single();
    if (!player) throw new Error('Player not found');
    if (player.status !== 'eliminated') throw new Error('You are still alive');

    if (poolWeek > season.buyback_through_week) {
      throw new Error(`Buy-backs closed after week ${season.buyback_through_week}`);
    }

    await supabaseAdmin.from('cfb_players')
      .update({ status: 'alive', eliminated_week: null, buybacks: (player.buybacks || 0) + 1 })
      .eq('id', playerId);

    await supabaseAdmin.from('cfb_buybacks').insert({
      season_id: seasonId, player_id: playerId, pool_week: poolWeek, amount: season.buyback_fee,
    });

    return { ok: true, fee: season.buyback_fee, buybacks: (player.buybacks || 0) + 1 };
  }

  static async runWeeklyPipeline(seasonId, poolWeek) {
    const scores = await this.syncScores(seasonId, poolWeek);
    const graded = await this.gradeWeek(seasonId, poolWeek);
    return { scores, graded };
  }
}

module.exports = CFBService;
module.exports.parseEspnOdds = parseEspnOdds;
