// ═══════════════════════════════════════════════════════════════
// BARRY BETS — NFL primetime head-to-head schedule generator
//
// Four players. Three primetime games a week — Thursday night, Sunday
// night, Monday night — and each night is its own round: two matchups,
// all four players in action.
//
// Four players split into two pairs exactly three ways, which is the
// whole point: in one week every player faces each of the other three
// once, on a different night each time.
//
//     THU   A vs B    C vs D
//     SUN   A vs C    B vs D
//     MON   A vs D    B vs C
//
// Which of those rounds lands on which night rotates by week, so nobody
// gets stuck drawing the Thursday game against the same man all season.
//
// Exactly one player in each matchup holds the pick. He takes a side of
// that night's game against the frozen spread; his opponent gets the
// other side. Pick duty is handed out greedily — always to whichever of
// the two has picked less so far — which keeps every player within one
// pick of every other across the season.
// ═══════════════════════════════════════════════════════════════

const { supabaseAdmin } = require('./supabase');

const NIGHTS = ['TNF', 'SNF', 'MNF'];

// The three distinct ways to split four players into two pairs.
function rounds(players) {
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
 * Build the schedule.
 *
 * @param {string[]} playerNames  exactly 4 names
 * @param {Object[]} weeks        [{ week_no, slots: ['TNF','SNF','MNF'] }]
 *                                slots is which primetime games that week
 *                                actually has, so a week the league gives
 *                                no Thursday game simply plays two rounds.
 * @param {string}   seed         optional; omit to draw a fresh one
 */
function generateSchedule(playerNames, weeks, seed) {
  if (!playerNames || playerNames.length !== 4) {
    throw new Error('This pool needs exactly 4 players');
  }

  const seedStr = seed || String(Math.floor(Math.random() * 1e9));
  const rand = mulberry32(
    [...seedStr].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
  );

  // Randomize the seating once, so which pairing is "round 0" is drawn
  // rather than alphabetical.
  const seated = shuffle(playerNames, rand);
  const table = rounds(seated);

  // Pick duty goes to whoever is behind. Tie-break is a fixed random
  // order rather than alphabetical, so no name is quietly favoured.
  const picks = Object.fromEntries(playerNames.map(p => [p, 0]));
  const tieBreak = Object.fromEntries(shuffle(playerNames, rand).map((p, i) => [p, i]));

  const schedule = [];

  for (const wk of weeks) {
    const available = NIGHTS.filter(n => (wk.slots || []).includes(n));
    if (!available.length) continue;

    // Rotate which round plays which night. With all three nights present
    // this is a clean rotation; with fewer, the rounds that do not fit are
    // dropped this week and the rotation moves them along next week.
    const matchups = [];
    for (let i = 0; i < table.length && i < available.length; i++) {
      const round = table[(i + wk.week_no) % table.length];
      const night = available[i];

      round.forEach((pair, slot) => {
        const [x, y] = picks[pair[0]] !== picks[pair[1]]
          ? (picks[pair[0]] < picks[pair[1]] ? pair : [pair[1], pair[0]])
          : (tieBreak[pair[0]] < tieBreak[pair[1]] ? pair : [pair[1], pair[0]]);
        picks[x]++;
        matchups.push({ slot_name: night, slot: slot + 1, picker: x, opponent: y });
      });
    }

    schedule.push({ week_no: wk.week_no, matchups });
  }

  return { seed: seedStr, weeks: schedule, balance: summarize(playerNames, schedule) };
}

function summarize(players, schedule) {
  const picks = {}, plays = {}, nights = {};
  players.forEach(p => {
    picks[p] = 0; plays[p] = 0;
    nights[p] = { TNF: 0, SNF: 0, MNF: 0 };
  });
  for (const w of schedule) {
    for (const m of w.matchups) {
      picks[m.picker]++;
      plays[m.picker]++; plays[m.opponent]++;
      nights[m.picker][m.slot_name]++;
      nights[m.opponent][m.slot_name]++;
    }
  }
  return { picks, plays, nights };
}

/**
 * Sanity checks. Throws if the draw breaks a house rule.
 */
function validate(players, schedule) {
  const { picks, plays } = summarize(players, schedule);
  const errs = [];

  for (const w of schedule) {
    const byNight = {};
    for (const m of w.matchups) (byNight[m.slot_name] = byNight[m.slot_name] || []).push(m);

    for (const [night, ms] of Object.entries(byNight)) {
      if (ms.length !== 2) {
        errs.push(`week ${w.week_no} ${night} has ${ms.length} matchups, not 2`);
      }
      const named = ms.flatMap(m => [m.picker, m.opponent]);
      if (new Set(named).size !== named.length) {
        errs.push(`week ${w.week_no} ${night} uses a player twice`);
      }
    }

    // Nobody should meet the same man twice in one week.
    const seen = new Set();
    for (const m of w.matchups) {
      const k = [m.picker, m.opponent].sort().join('|');
      if (seen.has(k)) errs.push(`week ${w.week_no} pairs ${k} twice`);
      seen.add(k);
    }
  }

  const spread = list => Math.max(...list) - Math.min(...list);
  if (spread(Object.values(picks)) > 1) {
    errs.push(`pick duty is uneven: ${JSON.stringify(picks)}`);
  }
  if (spread(Object.values(plays)) > 0) {
    errs.push(`games played are uneven: ${JSON.stringify(plays)}`);
  }

  if (errs.length) throw new Error('Schedule validation failed: ' + errs.join('; '));
  return true;
}

/**
 * Write the schedule into mnf_matchups.
 *
 * Takes a starting week and never touches anything before it. Weeks 1 and
 * 2 of this season were played on the old one-Monday-game shape, and
 * rewriting them would move results that are already on the board.
 *
 * Refuses to run if any pick has been made in the range it would write.
 */
async function seedSchedule(seasonId, fromWeek, toWeek = 18, seed) {
  if (!fromWeek) throw new Error('fromWeek is required — refusing to rewrite the whole season');

  const { data: players, error: pErr } = await supabaseAdmin
    .from('mnf_players')
    .select('id, display_name')
    .eq('season_id', seasonId)
    .order('display_name');
  if (pErr) throw pErr;
  if (!players || players.length !== 4) {
    throw new Error(`Season needs exactly 4 players, found ${players ? players.length : 0}`);
  }

  // Which primetime games each week actually has. The schedule is drawn
  // from the games, not from an assumption about the calendar.
  const { data: games } = await supabaseAdmin
    .from('mnf_games')
    .select('week_no, slot_name')
    .eq('season_id', seasonId)
    .gte('week_no', fromWeek)
    .lte('week_no', toWeek);

  const slotsByWeek = {};
  for (const g of games || []) {
    if (!g.slot_name) continue;
    (slotsByWeek[g.week_no] = slotsByWeek[g.week_no] || new Set()).add(g.slot_name);
  }
  const weeks = Object.keys(slotsByWeek)
    .map(Number)
    .sort((a, b) => a - b)
    .map(w => ({ week_no: w, slots: [...slotsByWeek[w]] }));

  if (!weeks.length) {
    throw new Error(`No primetime games seeded for weeks ${fromWeek}–${toWeek} yet — seed the games first`);
  }

  const { data: existing } = await supabaseAdmin
    .from('mnf_matchups')
    .select('id, picked_side, week_no')
    .eq('season_id', seasonId)
    .gte('week_no', fromWeek);
  if ((existing || []).some(m => m.picked_side)) {
    throw new Error('Picks already exist in that range — refusing to regenerate the schedule');
  }

  const names = players.map(p => p.display_name);
  const idByName = Object.fromEntries(players.map(p => [p.display_name, p.id]));

  const { seed: usedSeed, weeks: sched, balance } = generateSchedule(names, weeks, seed);
  validate(names, sched);

  const rows = sched.flatMap(w =>
    w.matchups.map(m => ({
      season_id: seasonId,
      week_no: w.week_no,
      slot_name: m.slot_name,
      slot: m.slot,
      picker_id: idByName[m.picker],
      opponent_id: idByName[m.opponent],
    }))
  );

  // Clear only the range being rewritten.
  await supabaseAdmin.from('mnf_matchups')
    .delete().eq('season_id', seasonId).gte('week_no', fromWeek);

  const { error: iErr } = await supabaseAdmin.from('mnf_matchups').insert(rows);
  if (iErr) throw iErr;

  await supabaseAdmin.from('mnf_seasons').update({ schedule_seed: usedSeed }).eq('id', seasonId);

  console.log(`[MNF] Seeded ${rows.length} matchups across ${sched.length} weeks (seed ${usedSeed})`);
  return { seed: usedSeed, matchups: rows.length, weeks: sched.length, balance };
}

module.exports = { generateSchedule, seedSchedule, validate, summarize, NIGHTS };
