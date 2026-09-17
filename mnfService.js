// ═══════════════════════════════════════════════════════════════
// BARRY BETS — Monday Night Football data + grading service
//
//   Schedule & scores : ESPN  (site.api.espn.com, football/nfl)
//   Spreads           : The Odds API (americanfootball_nfl)
//
// House rules encoded here:
//   • The spread is frozen Wednesday morning. That number grades the
//     week no matter when a pick was made, and never moves again.
//   • A push counts as a loss for the picker — he had the choice.
//   • No pick by kickoff: the picker is given the favorite.
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const { supabaseAdmin } = require('./supabase');

const ESPN_NFL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_SPORT = 'americanfootball_nfl';
const ODDS_API_KEY = process.env.ODDS_API_KEY;

// ── Helpers ──────────────────────────────────────────────────

// ESPN and The Odds API both use "Kansas City Chiefs" style names, so
// matching is far simpler than the college side. Normalize defensively.
function normTeam(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ESPN returns UTC. Convert to Eastern before asking what day it is, or an
// 8:15pm Monday kickoff reads as Tuesday.
function inET(iso) {
  return new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function isMondayET(iso) {
  return inET(iso).getDay() === 1;
}

// Which primetime round a kickoff belongs to, or null for the Sunday
// afternoon games this pool has never cared about.
//
//   TNF : any Thursday game
//   SNF : a Sunday kickoff at 7pm ET or later, i.e. the night game
//   MNF : any Monday game
function slotFor(iso) {
  const et = inET(iso);
  const day = et.getDay();
  if (day === 4) return 'TNF';
  if (day === 1) return 'MNF';
  if (day === 0 && et.getHours() >= 19) return 'SNF';
  return null;
}

// ESPN's ?dates=YYYYMMDD parameter is Eastern-based, not UTC. An 8:15pm ET
// Monday kickoff is already the next day in UTC, so formatting the raw
// timestamp returns an empty scoreboard. Always ask in Eastern.
function etDateString(iso) {
  return new Date(iso)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })  // YYYY-MM-DD
    .replace(/-/g, '');
}

class MNFService {

  // ─────────────────────────────────────────────────────────────
  // SCHEDULE
  // ─────────────────────────────────────────────────────────────

  /**
   * One game per primetime slot for an NFL week, earliest kickoff first.
   *
   * At most one game per slot: the round is a single head-to-head on a
   * single number, so a Thursday doubleheader or a Thanksgiving triple
   * keeps only the late game — the one everybody actually watches.
   */
  static async fetchWeekGames(year, week) {
    try {
      const url = `${ESPN_NFL}?dates=${year}&seasontype=2&week=${week}`;
      const { data } = await axios.get(url, { timeout: 15000 });

      const bySlot = {};
      for (const event of (data && data.events) || []) {
        const slot = slotFor(event.date);
        if (!slot) continue;

        const comp = event.competitions && event.competitions[0];
        if (!comp) continue;
        const home = comp.competitors.find(c => c.homeAway === 'home');
        const away = comp.competitors.find(c => c.homeAway === 'away');
        if (!home || !away) continue;

        const row = {
          week_no: week,
          slot_name: slot,
          espn_event_id: String(event.id),
          home_team: home.team.displayName,
          away_team: away.team.displayName,
          home_abbr: home.team.abbreviation,
          away_abbr: away.team.abbreviation,
          kickoff_at: event.date,
        };

        const held = bySlot[slot];
        if (!held || new Date(row.kickoff_at) > new Date(held.kickoff_at)) {
          bySlot[slot] = row;
        }
      }

      return Object.values(bySlot)
        .sort((a, b) => new Date(a.kickoff_at) - new Date(b.kickoff_at));
    } catch (err) {
      console.error(`[MNF] ESPN week ${week} fetch failed:`, err.message);
      return [];
    }
  }

  /**
   * Just the Monday night game. Still used by the feed check and by
   * seedSeasonGames, which seeds weeks running on the old shape.
   */
  static async fetchWeekGame(year, week) {
    const games = await this.fetchWeekGames(year, week);
    return games.find(g => g.slot_name === 'MNF') || null;
  }

  /**
   * Seed every MNF game for a season. Idempotent — re-running refreshes
   * kickoff times and ESPN ids but never touches a frozen spread or a score.
   */
  static async seedSeasonGames(seasonId, year, weeks = 18) {
    let seeded = 0;
    const log = [];

    for (let wk = 1; wk <= weeks; wk++) {
      const game = await this.fetchWeekGame(year, wk);
      if (!game) { log.push(`Week ${wk}: no Monday game`); continue; }

      const { data: existing } = await supabaseAdmin
        .from('mnf_games')
        .select('id, spread_frozen_at, status')
        .eq('season_id', seasonId)
        .eq('week_no', wk)
        .maybeSingle();

      const payload = { ...game, season_id: seasonId, updated_at: new Date().toISOString() };

      if (existing) {
        if (existing.status === 'final') { log.push(`Week ${wk}: final, left alone`); continue; }
        await supabaseAdmin.from('mnf_games').update(payload).eq('id', existing.id);
        log.push(`Week ${wk}: refreshed ${game.away_team} at ${game.home_team}`);
      } else {
        await supabaseAdmin.from('mnf_games').insert(payload);
        log.push(`Week ${wk}: added ${game.away_team} at ${game.home_team}`);
      }
      seeded++;
    }

    console.log(`[MNF] Seeded/refreshed ${seeded} games`);
    return { seeded, log };
  }

  /**
   * Seed the three primetime rounds — Thursday, Sunday night, Monday
   * night — across a range of weeks.
   *
   * It takes a starting week on purpose. Weeks 1 and 2 were played on the
   * old one-Monday-game shape with results already on the board, and
   * widening a week that players have picked in would rewrite history.
   */
  static async seedPrimetimeGames(seasonId, year, fromWeek, toWeek = 18) {
    let added = 0, refreshed = 0;
    const log = [];

    for (let wk = fromWeek; wk <= toWeek; wk++) {
      const slate = await this.fetchWeekGames(year, wk);
      if (!slate.length) { log.push(`Week ${wk}: no primetime games`); continue; }

      for (const game of slate) {
        // Matching on the slot means the Monday game already seeded the old
        // way is found and updated rather than duplicated.
        const { data: existing } = await supabaseAdmin
          .from('mnf_games')
          .select('id, status')
          .eq('season_id', seasonId)
          .eq('week_no', wk)
          .eq('slot_name', game.slot_name)
          .maybeSingle();

        const payload = { ...game, season_id: seasonId, updated_at: new Date().toISOString() };

        if (existing) {
          if (existing.status === 'final') continue;
          await supabaseAdmin.from('mnf_games').update(payload).eq('id', existing.id);
          refreshed++;
        } else {
          await supabaseAdmin.from('mnf_games').insert(payload);
          added++;
        }
      }

      log.push(`Week ${wk}: ` +
        slate.map(g => `${g.slot_name} ${g.away_abbr}@${g.home_abbr}`).join(', '));
    }

    console.log(`[MNF] Primetime slate: ${added} added, ${refreshed} refreshed`);
    return { added, refreshed, log };
  }

  // ─────────────────────────────────────────────────────────────
  // SPREADS — frozen Wednesday morning
  // ─────────────────────────────────────────────────────────────

  static async fetchSpreads() {
    if (!ODDS_API_KEY) {
      console.error('[MNF] ODDS_API_KEY is not set — cannot fetch spreads');
      return [];
    }
    try {
      const { data, headers } = await axios.get(
        `${ODDS_BASE}/sports/${ODDS_SPORT}/odds`,
        {
          params: {
            apiKey: ODDS_API_KEY,
            regions: 'us',
            markets: 'spreads',
            oddsFormat: 'american',
            dateFormat: 'iso',
          },
          timeout: 15000,
        }
      );
      console.log(`[MNF] Odds API: ${data.length} games, ${headers['x-requests-remaining']} requests left`);
      return data;
    } catch (err) {
      console.error('[MNF] Odds fetch failed:', err.response?.status, err.message);
      return [];
    }
  }

  /**
   * Consensus spread across books.
   * Books occasionally disagree on who is favored (a pick-em drifting either
   * way), so take the majority favorite first and average only those books.
   */
  static consensusSpread(bookmakers, homeName, awayName) {
    if (!bookmakers || !bookmakers.length) return null;

    const votes = { home: [], away: [] };
    for (const book of bookmakers) {
      const market = (book.markets || []).find(m => m.key === 'spreads');
      if (!market || !market.outcomes) continue;
      const fav = market.outcomes.find(o => typeof o.point === 'number' && o.point < 0);
      if (!fav) continue;
      const side =
        normTeam(fav.name) === normTeam(homeName) ? 'home'
        : normTeam(fav.name) === normTeam(awayName) ? 'away'
        : null;
      if (side) votes[side].push(Math.abs(fav.point));
    }

    const side = votes.home.length >= votes.away.length ? 'home' : 'away';
    const vals = votes[side];
    if (!vals.length) return null;

    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return {
      favorite: side,
      spread_value: Math.round(avg * 2) / 2,   // nearest half point
      books: vals.length,
    };
  }

  /**
   * Freeze the spread for every upcoming game that does not have one yet.
   * Runs Wednesday morning. Will not overwrite an already-frozen number —
   * that is the whole point of freezing it.
   */
  static async freezeSpreads(seasonId, { force = false, week = null, windowDays = 7 } = {}) {
    let q = supabaseAdmin
      .from('mnf_games')
      .select('id, week_no, slot_name, home_team, away_team, kickoff_at, spread_frozen_at')
      .eq('season_id', seasonId)
      .neq('status', 'final');
    if (week) q = q.eq('week_no', week);

    const { data: games, error } = await q;
    if (error) throw error;

    // Only freeze the games actually coming up. Without this the first
    // Wednesday run would grab every remaining week at once — locking
    // January's lines in September, months before the books mean anything
    // by them. A seven-day window covers all three of this week's rounds.
    const now = Date.now();
    const horizon = now + windowDays * 24 * 60 * 60 * 1000;

    const pending = (games || []).filter(g => {
      if (!force && g.spread_frozen_at) return false;
      if (week) return true;                       // explicit week overrides the window
      const kick = new Date(g.kickoff_at).getTime();
      return kick >= now && kick <= horizon;
    });
    if (!pending.length) return { frozen: 0, message: 'No game inside the freeze window' };

    const odds = await this.fetchSpreads();
    if (!odds.length) return { frozen: 0, message: 'No odds returned' };

    let frozen = 0;
    const log = [];

    for (const game of pending) {
      const match = odds.find(o =>
        normTeam(o.home_team) === normTeam(game.home_team) &&
        normTeam(o.away_team) === normTeam(game.away_team)
      );
      if (!match) { log.push(`Week ${game.week_no}: no odds line yet`); continue; }

      const spread = this.consensusSpread(match.bookmakers, game.home_team, game.away_team);
      if (!spread) { log.push(`Week ${game.week_no}: no usable spread`); continue; }

      await supabaseAdmin.from('mnf_games').update({
        odds_event_id: match.id,
        favorite: spread.favorite,
        spread_value: spread.spread_value,
        spread_frozen_at: new Date().toISOString(),
        spread_source: `the-odds-api consensus (${spread.books} books)`,
        updated_at: new Date().toISOString(),
      }).eq('id', game.id);

      const favName = spread.favorite === 'home' ? game.home_team : game.away_team;
      log.push(`Week ${game.week_no} ${game.slot_name}: ${favName} ` +
        `-${spread.spread_value} (${spread.books} books)`);
      frozen++;
    }

    console.log(`[MNF] Froze ${frozen} spreads`);
    return { frozen, log };
  }

  // ─────────────────────────────────────────────────────────────
  // AUTO-ASSIGN — missed deadline gets the favorite
  // ─────────────────────────────────────────────────────────────

  /**
   * A picker who lets his round's kickoff pass is handed that game's
   * favorite. Each round stands alone: missing Thursday says nothing about
   * Sunday, so only the matchups on the game that has started are touched.
   */
  static async autoAssignMissingPicks(seasonId) {
    const now = new Date();

    const { data: games } = await supabaseAdmin
      .from('mnf_games')
      .select('week_no, slot_name, kickoff_at, favorite, spread_value, home_team, away_team')
      .eq('season_id', seasonId)
      .not('favorite', 'is', null);

    const live = (games || []).filter(g => new Date(g.kickoff_at) <= now);
    if (!live.length) return { assigned: 0 };

    let assigned = 0;
    const log = [];

    for (const game of live) {
      const { data: open } = await supabaseAdmin
        .from('mnf_matchups')
        .select('id, picker_id')
        .eq('season_id', seasonId)
        .eq('week_no', game.week_no)
        .eq('slot_name', game.slot_name)
        .is('picked_side', null);

      for (const m of open || []) {
        await supabaseAdmin.from('mnf_matchups').update({
          picked_side: game.favorite,
          picked_at: new Date().toISOString(),
          auto_assigned: true,
        }).eq('id', m.id);

        const favName = game.favorite === 'home' ? game.home_team : game.away_team;
        log.push(`Week ${game.week_no} ${game.slot_name}: auto-assigned ${favName} -${game.spread_value}`);
        assigned++;
      }
    }

    if (assigned) console.log(`[MNF] Auto-assigned ${assigned} missed picks`);
    return { assigned, log };
  }

  // ─────────────────────────────────────────────────────────────
  // SCORES
  // ─────────────────────────────────────────────────────────────

  static async syncScores(seasonId) {
    const { data: games } = await supabaseAdmin
      .from('mnf_games')
      .select('id, week_no, espn_event_id, home_team, away_team, kickoff_at')
      .eq('season_id', seasonId)
      .neq('status', 'final');

    const started = (games || []).filter(g => new Date(g.kickoff_at) <= new Date());
    if (!started.length) return { updated: 0, message: 'No games in progress' };

    let updated = 0;
    const log = [];

    for (const game of started) {
      try {
        const { data } = await axios.get(
          `${ESPN_NFL}?dates=${etDateString(game.kickoff_at)}`, { timeout: 15000 }
        );

        const event = (data.events || []).find(e => String(e.id) === String(game.espn_event_id));
        if (!event) { log.push(`Week ${game.week_no}: event not on ESPN board`); continue; }

        const comp = event.competitions[0];
        const home = comp.competitors.find(c => c.homeAway === 'home');
        const away = comp.competitors.find(c => c.homeAway === 'away');
        const complete = comp.status?.type?.completed === true;

        await supabaseAdmin.from('mnf_games').update({
          home_score: parseInt(home.score, 10),
          away_score: parseInt(away.score, 10),
          status: complete ? 'final' : 'in_progress',
          updated_at: new Date().toISOString(),
        }).eq('id', game.id);

        log.push(`Week ${game.week_no}: ${away.score}-${home.score} ${complete ? '(final)' : '(live)'}`);
        updated++;
      } catch (err) {
        log.push(`Week ${game.week_no}: ${err.message}`);
      }
    }

    return { updated, log };
  }

  // ─────────────────────────────────────────────────────────────
  // GRADING
  // ─────────────────────────────────────────────────────────────

  /**
   * Which side covered, using the frozen spread.
   * Returns 'home' | 'away' | 'push'.
   */
  static coveringSide(game) {
    const { favorite, spread_value, home_score, away_score } = game;
    if (favorite == null || spread_value == null) return null;
    if (home_score == null || away_score == null) return null;

    const favScore = favorite === 'home' ? home_score : away_score;
    const dogScore = favorite === 'home' ? away_score : home_score;
    const margin = favScore - dogScore;
    const underdog = favorite === 'home' ? 'away' : 'home';

    if (margin > spread_value) return favorite;
    if (margin < spread_value) return underdog;
    return 'push';
  }

  static async gradeSeason(seasonId) {
    const { data: games } = await supabaseAdmin
      .from('mnf_games')
      .select('*')
      .eq('season_id', seasonId)
      .eq('status', 'final');

    if (!games || !games.length) return { graded: 0 };

    let graded = 0;
    const log = [];

    for (const game of games) {
      const cover = this.coveringSide(game);
      if (!cover) { log.push(`Week ${game.week_no}: missing spread or score`); continue; }

      // Only this round's matchups. A week now holds three games, and
      // keying on week_no alone would grade all six matchups off whichever
      // game happened to go final first.
      const { data: matchups } = await supabaseAdmin
        .from('mnf_matchups')
        .select('id, picked_side, result')
        .eq('season_id', seasonId)
        .eq('week_no', game.week_no)
        .eq('slot_name', game.slot_name)
        .eq('result', 'pending');

      for (const m of matchups || []) {
        if (!m.picked_side) continue;   // auto-assign should have handled this

        // House rule: a push goes to the non-picker.
        const isPush = cover === 'push';
        const result = isPush
          ? 'opponent'
          : (m.picked_side === cover ? 'picker' : 'opponent');

        await supabaseAdmin.from('mnf_matchups').update({
          result,
          is_push: isPush,
          graded_at: new Date().toISOString(),
        }).eq('id', m.id);

        graded++;
      }

      const favName = game.favorite === 'home' ? game.home_team : game.away_team;
      log.push(
        `Week ${game.week_no} ${game.slot_name}: ${game.away_team} ${game.away_score} - ` +
        `${game.home_score} ${game.home_team} | ${favName} -${game.spread_value} | ` +
        (cover === 'push' ? 'PUSH (picker loses)' : `${cover} covered`)
      );
    }

    console.log(`[MNF] Graded ${graded} matchups`);
    return { graded, log };
  }

  /**
   * The whole Monday-night pipeline in one call.
   */
  static async runWeeklyPipeline(seasonId) {
    const assigned = await this.autoAssignMissingPicks(seasonId);
    const scores = await this.syncScores(seasonId);
    const graded = await this.gradeSeason(seasonId);
    return { assigned, scores, graded };
  }
}

module.exports = MNFService;
