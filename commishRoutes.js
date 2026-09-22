// ═══════════════════════════════════════════════════════════════
// BARRY BETS — COMMISSIONER PANEL
// Mounted at /api/commish
//
// Everything here used to require either a secret token pasted into a URL
// or raw SQL against the live database. Both bit us: a token URL that
// returned 403 looked identical to one that worked, so a locked-out
// player stayed locked out while everyone assumed it had been handled.
//
// So this router is gated by WHO IS SIGNED IN, not by a shared secret.
// Same check the Money view already uses. No token to mislay, no URL to
// paste, and every action reports what it actually did.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { requireAuth } = require('./auth');
const { supabaseAdmin } = require('./supabase');
const CFBService = require('./cfbService');
const MNFService = require('./mnfService');

const ADMIN_USER_ID = process.env.CFB_ADMIN_USER_ID
  || '2bd9768c-8a46-47ee-93cf-53be1e2f4fb6';
const SITE_URL = process.env.SITE_URL || 'https://www.barrysbets.net';

const RESET_HOURS = 4;

// Every route below is commissioner-only. Mounting the guard once means a
// route added later cannot forget it.
router.use(requireAuth, (req, res, next) => {
  if (!req.user || req.user.id !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'Commissioner only' });
  }
  next();
});

// Minting links and firing syncs are cheap but not free — the sync calls
// out to ESPN. A fat finger on a button should not hammer either.
const actionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const ET = { timeZone: 'America/New_York' };
const etLabel = iso => iso
  ? new Date(iso).toLocaleString('en-US',
      { ...ET, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  : null;

async function activeCfbSeason() {
  const { data } = await supabaseAdmin
    .from('cfb_seasons').select('*').eq('status', 'active')
    .order('year', { ascending: false }).limit(1).maybeSingle();
  return data;
}

async function activeMnfSeason() {
  const { data } = await supabaseAdmin
    .from('mnf_seasons').select('*').eq('status', 'active')
    .order('year', { ascending: false }).limit(1).maybeSingle();
  return data;
}

// pool_week 0 is the parking lot — games that had already kicked off when
// the board was first built. Never the current week.
async function cfbCurrentWeek(seasonId) {
  const { data } = await supabaseAdmin
    .from('cfb_games').select('pool_week').eq('season_id', seasonId)
    .gt('pool_week', 0).neq('status', 'final')
    .order('pool_week').limit(1).maybeSingle();
  return data ? data.pool_week : null;
}

async function mnfCurrentWeek(seasonId) {
  const { data } = await supabaseAdmin
    .from('mnf_games').select('week_no').eq('season_id', seasonId)
    .neq('status', 'final').order('kickoff_at').limit(1).maybeSingle();
  return data ? data.week_no : null;
}

// ─────────────────────────────────────────────────────────────
// STATUS — the screen that answers "is anything quietly broken?"
//
// Week 2 of the survivor pool was lost because nothing anywhere said the
// week had opened. This is the fix for that class of problem: one glance,
// both pools, what is open and who owes a pick.
//
// It deliberately does NOT reveal which team anyone picked. The whole
// point of the pool is that you cannot see a rival's hand, and the
// commissioner is a player too.
// ─────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const out = { generated_at: new Date().toISOString(), cfb: null, nfl: null, warnings: [] };

    // ── College survivor
    const cfb = await activeCfbSeason();
    if (!cfb) {
      out.warnings.push('No active college survivor season');
    } else {
      const week = await cfbCurrentWeek(cfb.id);
      const { data: players } = await supabaseAdmin
        .from('cfb_players').select('id, display_name, status, eliminated_week')
        .eq('season_id', cfb.id).order('display_name');

      let lock = null, locked = false, games = 0, owe = [];
      if (week) {
        lock = await CFBService.lockTime(cfb.id, week);
        locked = await CFBService.isLocked(cfb.id, week);
        const { count } = await supabaseAdmin
          .from('cfb_games').select('id', { count: 'exact', head: true })
          .eq('season_id', cfb.id).eq('pool_week', week);
        games = count || 0;

        const { data: picks } = await supabaseAdmin
          .from('cfb_picks').select('player_id')
          .eq('season_id', cfb.id).eq('pool_week', week);
        const picked = new Set((picks || []).map(p => p.player_id));
        owe = (players || [])
          .filter(p => p.status === 'alive' && !picked.has(p.id))
          .map(p => p.display_name);
      } else {
        out.warnings.push('College survivor has no open week — every game on the board is final');
      }

      out.cfb = {
        season: cfb.name || `CFB ${cfb.year}`,
        week, games, locked,
        lock_at: lock, lock_label: etLabel(lock),
        alive: (players || []).filter(p => p.status === 'alive').map(p => p.display_name),
        out: (players || []).filter(p => p.status !== 'alive')
          .map(p => `${p.display_name} (wk ${p.eliminated_week})`),
        owe_picks: owe,
      };

      if (week && !games) out.warnings.push(`Survivor week ${week} exists but has no games on the board`);
      if (week && !locked && owe.length) {
        out.warnings.push(`${owe.join(' and ')} owe a survivor pick — locks ${etLabel(lock)}`);
      }
    }

    // ── NFL primetime
    const nfl = await activeMnfSeason();
    if (!nfl) {
      out.warnings.push('No active NFL primetime season');
    } else {
      const week = await mnfCurrentWeek(nfl.id);
      let rounds = [];
      if (week) {
        const { data: slate } = await supabaseAdmin
          .from('mnf_games')
          .select('slot_name, away_team, home_team, kickoff_at, spread_frozen_at, favorite, spread_value, status')
          .eq('season_id', nfl.id).eq('week_no', week).order('kickoff_at');

        // Two plain reads rather than an embedded join: the join needs the
        // foreign key's exact constraint name, which is a thing to get wrong
        // silently. A four-row lookup costs nothing.
        const { data: ms } = await supabaseAdmin
          .from('mnf_matchups')
          .select('slot_name, picked_side, picker_id')
          .eq('season_id', nfl.id).eq('week_no', week);
        const { data: roster } = await supabaseAdmin
          .from('mnf_players').select('id, display_name').eq('season_id', nfl.id);
        const nameOf = Object.fromEntries((roster || []).map(p => [p.id, p.display_name]));

        rounds = (slate || []).map(g => {
          const mine = (ms || []).filter(m => m.slot_name === g.slot_name);
          const open = mine.filter(m => !m.picked_side);
          return {
            slot: g.slot_name,
            game: `${g.away_team} at ${g.home_team}`,
            kickoff_label: etLabel(g.kickoff_at),
            locked: new Date(g.kickoff_at) <= new Date(),
            line_frozen: !!g.spread_frozen_at,
            line: g.favorite && g.spread_value != null
              ? `${g.favorite === 'home' ? g.home_team : g.away_team} -${g.spread_value}` : null,
            owe_picks: open.map(m => nameOf[m.picker_id] || 'someone'),
          };
        });
      } else {
        out.warnings.push('NFL primetime has no open week');
      }

      out.nfl = { season: nfl.name || `NFL ${nfl.year}`, week, rounds };

      for (const r of rounds) {
        if (!r.locked && !r.line_frozen) {
          out.warnings.push(`No frozen line on the week ${week} ${r.slot} game — it cannot be graded until there is one`);
        }
        if (!r.locked && r.owe_picks.length) {
          out.warnings.push(`${r.owe_picks.join(' and ')} owe the ${r.slot} pick — kicks off ${r.kickoff_label}`);
        }
      }
    }

    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// ROSTER — who is in the pools, and can each of them actually be reset
//
// Deliberately not read from the leaderboard view: that view exists to
// render a leaderboard and its columns can change without anyone
// thinking about this screen. This asks the player tables directly.
// ─────────────────────────────────────────────────────────────
router.get('/roster', async (req, res) => {
  try {
    const cfb = await activeCfbSeason();
    const nfl = await activeMnfSeason();

    const { data: cfbP } = cfb ? await supabaseAdmin
      .from('cfb_players').select('id, display_name, user_id, status')
      .eq('season_id', cfb.id).order('display_name') : { data: [] };

    const { data: nflP } = nfl ? await supabaseAdmin
      .from('mnf_players').select('id, display_name, user_id')
      .eq('season_id', nfl.id).order('display_name') : { data: [] };

    // One row per person, whichever pools he is in. A man with no login
    // attached cannot be sent a reset link, and the screen should say so
    // rather than offering a button that fails.
    const byName = {};
    for (const p of cfbP || []) {
      byName[p.display_name] = {
        name: p.display_name, cfb_id: p.id, nfl_id: null,
        user_id: p.user_id, status: p.status,
      };
    }
    for (const p of nflP || []) {
      const row = byName[p.display_name] || {
        name: p.display_name, cfb_id: null, nfl_id: null,
        user_id: p.user_id, status: null,
      };
      row.nfl_id = p.id;
      row.user_id = row.user_id || p.user_id;
      byName[p.display_name] = row;
    }

    const players = Object.values(byName)
      .map(p => ({
        name: p.name,
        player_id: p.cfb_id || p.nfl_id,
        pool: p.cfb_id ? 'cfb' : 'nfl',
        can_reset: !!p.user_id,
        status: p.status,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ players });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// NUDGE — the text to send, ready to copy
// ─────────────────────────────────────────────────────────────
function andList(names) {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

router.get('/nudge', async (req, res) => {
  try {
    const lines = [];

    const cfb = await activeCfbSeason();
    if (cfb) {
      const week = await cfbCurrentWeek(cfb.id);
      if (week && !(await CFBService.isLocked(cfb.id, week))) {
        const { data: players } = await supabaseAdmin
          .from('cfb_players').select('id, display_name')
          .eq('season_id', cfb.id).eq('status', 'alive');
        const { data: picks } = await supabaseAdmin
          .from('cfb_picks').select('player_id')
          .eq('season_id', cfb.id).eq('pool_week', week);
        const picked = new Set((picks || []).map(p => p.player_id));
        const owe = (players || []).filter(p => !picked.has(p.id)).map(p => p.display_name);
        if (owe.length) {
          const lock = await CFBService.lockTime(cfb.id, week);
          lines.push(`${andList(owe)} — no survivor pick for week ${week} yet. Locks ${etLabel(lock)} ET.`);
        }
      }
    }

    const nfl = await activeMnfSeason();
    if (nfl) {
      const week = await mnfCurrentWeek(nfl.id);
      if (week) {
        const { data: slate } = await supabaseAdmin
          .from('mnf_games').select('slot_name, kickoff_at')
          .eq('season_id', nfl.id).eq('week_no', week).order('kickoff_at');
        const { data: ms } = await supabaseAdmin
          .from('mnf_matchups')
          .select('slot_name, picked_side, picker_id')
          .eq('season_id', nfl.id).eq('week_no', week).is('picked_side', null);
        const { data: roster } = await supabaseAdmin
          .from('mnf_players').select('id, display_name').eq('season_id', nfl.id);
        const nameOf = Object.fromEntries((roster || []).map(p => [p.id, p.display_name]));

        const WORD = { TNF: 'Thursday', SNF: 'Sunday night', MNF: 'Monday night' };
        for (const g of slate || []) {
          if (new Date(g.kickoff_at) <= new Date()) continue;
          const owe = (ms || []).filter(m => m.slot_name === g.slot_name)
            .map(m => nameOf[m.picker_id] || 'someone');
          if (owe.length) {
            lines.push(`${andList(owe)} — ${WORD[g.slot_name] || g.slot_name} pick is open until kickoff, ${etLabel(g.kickoff_at)} ET.`);
          }
        }
      }
    }

    const text = lines.length ? `${lines.join(' ')} barrysbets.net` : '';
    res.json({ text, owed: lines.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// RESET LINK — get a locked-out player back in
//
// Returns a link instead of sending mail. Email is exactly what failed
// before: Resend reported "Delivered" and Gmail filed it as spam, so the
// player never saw it and nothing in the system looked wrong.
//
// The raw token is returned once, here, and never stored — only its hash
// is kept, so this table leaking cannot be replayed into a takeover.
// ─────────────────────────────────────────────────────────────
router.post('/reset-link', actionLimiter, async (req, res) => {
  try {
    const { player_id, pool } = req.body || {};
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const table = pool === 'nfl' ? 'mnf_players' : 'cfb_players';
    const { data: player } = await supabaseAdmin
      .from(table).select('id, display_name, user_id').eq('id', player_id).maybeSingle();
    if (!player) return res.status(404).json({ error: 'No such player' });
    if (!player.user_id) {
      return res.status(400).json({ error: `${player.display_name} has no login attached to his player row` });
    }

    // Confirm the account exists before minting anything for it.
    const { data: got, error: uErr } = await supabaseAdmin.auth.admin.getUserById(player.user_id);
    if (uErr || !got || !got.user) return res.status(404).json({ error: 'That player has no account' });

    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + RESET_HOURS * 3600 * 1000);

    // Any earlier link for this man stops working the moment a new one is
    // issued, so a stale text cannot be used later.
    await supabaseAdmin.from('bb_reset_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', player.user_id).is('used_at', null);

    const { error: iErr } = await supabaseAdmin.from('bb_reset_tokens').insert({
      token_hash: hash,
      user_id: player.user_id,
      email: got.user.email,
      issued_by: req.user.id,
      expires_at: expires.toISOString(),
    });
    if (iErr) throw iErr;

    console.log(`[Commish] Reset link issued for ${player.display_name}, good until ${expires.toISOString()}`);

    res.json({
      player: player.display_name,
      url: `${SITE_URL}/?reset=${token}`,
      expires_at: expires.toISOString(),
      expires_label: etLabel(expires.toISOString()),
      hours: RESET_HOURS,
      message: `Text this to ${player.display_name}. It works once and expires ${etLabel(expires.toISOString())} ET.`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// RE-SYNC — pull the board again from ESPN
// ─────────────────────────────────────────────────────────────
router.post('/resync', actionLimiter, async (req, res) => {
  try {
    const { pool } = req.body || {};

    if (pool === 'nfl') {
      const nfl = await activeMnfSeason();
      if (!nfl) return res.status(404).json({ error: 'No active NFL season' });
      const week = await mnfCurrentWeek(nfl.id);
      if (!week) return res.json({ ok: true, message: 'No open NFL week to sync' });
      const seeded = await MNFService.seedPrimetimeGames(nfl.id, nfl.year, week, week);
      const scores = await MNFService.syncScores(nfl.id);
      return res.json({ ok: true, week, seeded, scores, message: `NFL week ${week} refreshed` });
    }

    const cfb = await activeCfbSeason();
    if (!cfb) return res.status(404).json({ error: 'No active survivor season' });
    const week = await cfbCurrentWeek(cfb.id);
    if (!week) return res.json({ ok: true, message: 'No open survivor week to sync' });
    const synced = await CFBService.syncWeek(cfb.id, week);
    const scores = await CFBService.syncScores(cfb.id, week);
    res.json({ ok: true, week, synced, scores, message: `Survivor week ${week} refreshed` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// VOID A SURVIVOR WEEK
//
// What had to be done by hand when the roll-forward bug meant nobody knew
// week 2 had opened: three players were auto-assigned the same team, it
// lost, and all three were out of a pool they never got to play.
//
// Backs the picks up before deleting them, and needs the week number
// typed back to confirm, because there is no undo button in a chat window
// at 11pm.
// ─────────────────────────────────────────────────────────────
router.post('/void-week', actionLimiter, async (req, res) => {
  try {
    const { pool_week, confirm } = req.body || {};
    const week = Number(pool_week);
    if (!week) return res.status(400).json({ error: 'pool_week is required' });
    if (Number(confirm) !== week) {
      return res.status(400).json({ error: `Type ${week} to confirm voiding week ${week}` });
    }

    const cfb = await activeCfbSeason();
    if (!cfb) return res.status(404).json({ error: 'No active survivor season' });

    const { data: picks } = await supabaseAdmin
      .from('cfb_picks').select('*').eq('season_id', cfb.id).eq('pool_week', week);
    if (!picks || !picks.length) {
      return res.json({ ok: true, voided: 0, reinstated: 0, message: `Week ${week} had no picks to void` });
    }

    // Keep a copy first. Same shape as the manual backup taken on Sep 21.
    const { error: bErr } = await supabaseAdmin.from('bb_voided_picks').insert(
      picks.map(p => ({
        season_id: p.season_id, pool_week: p.pool_week, player_id: p.player_id,
        game_id: p.game_id, picked_team: p.picked_team, picked_team_id: p.picked_team_id,
        picked_side: p.picked_side, result: p.result, auto_assigned: p.auto_assigned,
        voided_by: req.user.id,
      }))
    );
    if (bErr) throw new Error(`Refusing to void — the backup failed: ${bErr.message}`);

    await supabaseAdmin.from('cfb_picks')
      .delete().eq('season_id', cfb.id).eq('pool_week', week);

    const { data: back } = await supabaseAdmin.from('cfb_players')
      .update({ status: 'alive', eliminated_week: null })
      .eq('season_id', cfb.id).eq('eliminated_week', week)
      .select('display_name');

    const names = (back || []).map(p => p.display_name);
    console.log(`[Commish] Voided survivor week ${week}: ${picks.length} picks, back in: ${names.join(', ') || 'nobody'}`);

    res.json({
      ok: true,
      voided: picks.length,
      reinstated: names,
      message: `Week ${week} is off the board. ${picks.length} picks backed up and removed` +
        (names.length ? `, and ${andList(names)} ${names.length === 1 ? 'is' : 'are'} back in.` : '.'),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
