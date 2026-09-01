// ═══════════════════════════════════════════════════════════════
// BARRY BETS — MNF head-to-head schedule generator
//
// Four players, one MNF game a week, two matchups per week.
// Every player plays every week. Opponents rotate on a 3-week cycle.
// Exactly one player in each matchup holds the pick.
//
// Over a 17-week season there are 34 picks for 4 players, so the
// split can only ever be 9/9/8/8. Which two get the extra one is
// drawn at random when the season is created.
// ═══════════════════════════════════════════════════════════════

const { supabaseAdmin } = require('./supabase');

// The three distinct ways to split four players into two pairs.
function roundRobin(players) {
  const [a, b, c, d] = players;
  return [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
}

function shuffle(arr, rand) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Deterministic PRNG so a season's draw can be reproduced from its seed.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the full season schedule.
 *
 * @param {string[]} playerNames  exactly 4 names
 * @param {number}   weeks        number of MNF weeks (17 for a normal season)
 * @param {string}   seed         optional; omit to draw a fresh random one
 * @returns {{seed:string, weeks:Array, balance:Object}}
 */
function generateSchedule(playerNames, weeks = 17, seed) {
  if (!playerNames || playerNames.length !== 4) {
    throw new Error('MNF schedule needs exactly 4 players');
  }

  const seedStr = seed || String(Math.floor(Math.random() * 1e9));
  const rand = mulberry32(
    [...seedStr].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
  );

  // Randomizing the order of the three rounds decides which pairing lands
  // in the short slot (5 meetings instead of 6), and randomizing who opens
  // the alternation inside each pairing decides who gets the extra pick.
  const rounds = shuffle(roundRobin(playerNames), rand)
    .map(round => round.map(pair => shuffle(pair, rand)));

  const seen = {};
  const key = pair => pair.slice().sort().join('|');

  const schedule = [];
  for (let wk = 1; wk <= weeks; wk++) {
    const round = rounds[(wk - 1) % rounds.length];
    const matchups = round.map((pair, i) => {
      const k = key(pair);
      const n = (seen[k] = (seen[k] || 0) + 1) - 1;   // 0-indexed meeting number
      return {
        slot: i + 1,
        picker: pair[n % 2],                          // alternate the pick each meeting
        opponent: pair[(n + 1) % 2],
      };
    });
    schedule.push({ week_no: wk, matchups });
  }

  return { seed: seedStr, weeks: schedule, balance: summarize(playerNames, schedule) };
}

function summarize(players, schedule) {
  const picks = {}, plays = {}, opponents = {};
  players.forEach(p => { picks[p] = 0; plays[p] = 0; opponents[p] = {}; });
  for (const w of schedule) {
    for (const m of w.matchups) {
      picks[m.picker]++;
      plays[m.picker]++; plays[m.opponent]++;
      opponents[m.picker][m.opponent] = (opponents[m.picker][m.opponent] || 0) + 1;
      opponents[m.opponent][m.picker] = (opponents[m.opponent][m.picker] || 0) + 1;
    }
  }
  return { picks, plays, opponents };
}

/**
 * Sanity checks. Throws if the generated schedule breaks a house rule.
 */
function validate(players, schedule) {
  const { picks, plays } = summarize(players, schedule);
  const weeks = schedule.length;
  const errs = [];

  for (const p of players) {
    if (plays[p] !== weeks) errs.push(`${p} plays ${plays[p]} of ${weeks} weeks`);
  }
  const counts = Object.values(picks);
  if (Math.max(...counts) - Math.min(...counts) > 1) {
    errs.push(`pick duty is uneven: ${JSON.stringify(picks)}`);
  }
  for (const w of schedule) {
    const named = w.matchups.flatMap(m => [m.picker, m.opponent]);
    if (new Set(named).size !== 4) errs.push(`week ${w.week_no} does not use all 4 players once`);
  }
  if (errs.length) throw new Error('Schedule validation failed: ' + errs.join('; '));
  return true;
}

/**
 * Write the schedule into mnf_matchups for a season.
 * Refuses to overwrite a season that already has picks recorded.
 */
async function seedSchedule(seasonId, weeks = 17, seed) {
  const { data: players, error: pErr } = await supabaseAdmin
    .from('mnf_players')
    .select('id, display_name')
    .eq('season_id', seasonId)
    .order('display_name');
  if (pErr) throw pErr;
  if (!players || players.length !== 4) {
    throw new Error(`Season needs exactly 4 players, found ${players ? players.length : 0}`);
  }

  const { data: existing } = await supabaseAdmin
    .from('mnf_matchups')
    .select('id, picked_side')
    .eq('season_id', seasonId);
  if (existing && existing.some(m => m.picked_side)) {
    throw new Error('Picks already exist for this season — refusing to regenerate the schedule');
  }

  const names = players.map(p => p.display_name);
  const idByName = Object.fromEntries(players.map(p => [p.display_name, p.id]));

  const { seed: usedSeed, weeks: sched, balance } = generateSchedule(names, weeks, seed);
  validate(names, sched);

  const rows = sched.flatMap(w =>
    w.matchups.map(m => ({
      season_id: seasonId,
      week_no: w.week_no,
      slot: m.slot,
      picker_id: idByName[m.picker],
      opponent_id: idByName[m.opponent],
    }))
  );

  if (existing && existing.length) {
    await supabaseAdmin.from('mnf_matchups').delete().eq('season_id', seasonId);
  }
  const { error: iErr } = await supabaseAdmin.from('mnf_matchups').insert(rows);
  if (iErr) throw iErr;

  await supabaseAdmin
    .from('mnf_seasons')
    .update({ schedule_seed: usedSeed })
    .eq('id', seasonId);

  console.log(`[MNF] Seeded ${rows.length} matchups across ${weeks} weeks (seed ${usedSeed})`);
  return { seed: usedSeed, matchups: rows.length, balance };
}

module.exports = { generateSchedule, seedSchedule, validate, summarize };
