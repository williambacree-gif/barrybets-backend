// ═══════════════════════════════════════════════════════════════
// BARRY BETS — PUSH NOTIFICATIONS
//
// Reminders to get a pick in, delivered to the phone rather than to an
// inbox nobody reads.
//
// The VAPID keypair is the server's own identity to the push services.
// It is generated HERE on first use and kept in bb_push_keys, which is
// service-role only — so no private key is ever pasted into a dashboard,
// mailed to anyone, or typed into a chat window.
//
// Idempotency lives in bb_push_log, which has a unique key on
// (user_id, kind, ref). A missed cron tick therefore sends late rather
// than not at all, and a doubled tick cannot send twice.
// ═══════════════════════════════════════════════════════════════

const webpush = require('web-push');
const { supabaseAdmin } = require('./supabase');

const SITE_URL = process.env.SITE_URL || 'https://www.barrysbets.net';
const SUBJECT = process.env.PUSH_SUBJECT || 'mailto:picks@barrysbets.net';

const HOUR = 3600 * 1000;
const DAY_AHEAD = 24 * HOUR;   // the early warning
const LAST_CALL = 3 * HOUR;    // the last call

let cached = null;

// The keypair, made once and remembered. Two boots racing each other is
// handled by the single-row constraint: the loser's insert fails and it
// reads back the winner's key.
async function keys() {
  if (cached) return cached;

  const { data } = await supabaseAdmin
    .from('bb_push_keys').select('*').eq('id', 1).maybeSingle();
  if (data) {
    cached = data;
  } else {
    const made = webpush.generateVAPIDKeys();
    const { data: ins, error } = await supabaseAdmin
      .from('bb_push_keys')
      .insert({ id: 1, public_key: made.publicKey, private_key: made.privateKey, subject: SUBJECT })
      .select().maybeSingle();
    if (error) {
      const { data: again } = await supabaseAdmin
        .from('bb_push_keys').select('*').eq('id', 1).maybeSingle();
      if (!again) throw new Error(`Could not establish push keys: ${error.message}`);
      cached = again;
    } else {
      cached = ins;
      console.log('[Push] Generated a VAPID keypair and stored it');
    }
  }

  webpush.setVapidDetails(cached.subject || SUBJECT, cached.public_key, cached.private_key);
  return cached;
}

async function publicKey() {
  return (await keys()).public_key;
}

// ── sending ──────────────────────────────────────────────────

// A dead subscription is not an error worth shouting about — phones get
// wiped and apps get deleted. 404/410 means gone, so stop trying.
async function sendToUsers(userIds, payload) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return { sent: 0, gone: 0, failed: 0, targeted: 0 };

  await keys();

  const { data: subs } = await supabaseAdmin
    .from('bb_push_subs').select('*').in('user_id', ids);
  if (!subs || !subs.length) return { sent: 0, gone: 0, failed: 0, targeted: ids.length };

  const body = JSON.stringify(payload);
  let sent = 0, gone = 0, failed = 0;

  for (const s of subs) {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(sub, body, { TTL: 6 * 3600 });
      sent++;
      await supabaseAdmin.from('bb_push_subs')
        .update({ last_ok_at: new Date().toISOString(), fail_count: 0 }).eq('id', s.id);
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        gone++;
        await supabaseAdmin.from('bb_push_subs').delete().eq('id', s.id);
      } else {
        failed++;
        await supabaseAdmin.from('bb_push_subs')
          .update({ fail_count: (s.fail_count || 0) + 1 }).eq('id', s.id);
        console.error(`[Push] send failed (${code || '?'}): ${err.message}`);
      }
    }
  }
  return { sent, gone, failed, targeted: ids.length };
}

// Sends only to the men who have not already had THIS nudge, and records
// that they have. The unique key on the log is what makes it safe to run
// this loop every quarter of an hour.
async function sendOnce(kind, ref, userIds, payload) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return { sent: 0, skipped: 0 };

  const { data: already } = await supabaseAdmin
    .from('bb_push_log').select('user_id').eq('kind', kind).eq('ref', String(ref)).in('user_id', ids);
  const done = new Set((already || []).map(r => r.user_id));
  const fresh = ids.filter(id => !done.has(id));
  if (!fresh.length) return { sent: 0, skipped: ids.length };

  // Claim first. If the insert fails the send does not happen, which is
  // the safe direction — a missed reminder beats one sent every 15 minutes.
  const { error } = await supabaseAdmin.from('bb_push_log')
    .insert(fresh.map(user_id => ({ user_id, kind, ref: String(ref) })));
  if (error) {
    console.error(`[Push] could not claim ${kind}/${ref}: ${error.message}`);
    return { sent: 0, skipped: ids.length };
  }

  const res = await sendToUsers(fresh, payload);
  console.log(`[Push] ${kind} ref=${ref}: ${res.sent} sent to ${fresh.length} men` +
    (res.gone ? `, ${res.gone} dead subs pruned` : ''));
  return { sent: res.sent, skipped: done.size };
}

// ── working out who is owing, and when to say so ─────────────

function windowFor(deadlineIso) {
  const t = new Date(deadlineIso).getTime();
  return { day: t - DAY_AHEAD, last: t - LAST_CALL, deadline: t };
}

// Which nudge, if any, is live right now. Returns null outside both windows
// and once the deadline has passed.
function dueNow(deadlineIso, now) {
  const w = windowFor(deadlineIso);
  if (now >= w.deadline) return null;
  if (now >= w.last) return 'last';
  if (now >= w.day) return 'day';
  return null;
}

const ET = { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' };
const etLabel = iso => new Date(iso).toLocaleString('en-US', ET);

async function cfbReminders(now) {
  const { data: season } = await supabaseAdmin
    .from('cfb_seasons').select('*').eq('status', 'active')
    .order('year', { ascending: false }).limit(1).maybeSingle();
  if (!season) return null;

  const { data: games } = await supabaseAdmin
    .from('cfb_games').select('id, pool_week, kickoff_at, status')
    .eq('season_id', season.id).gt('pool_week', 0);
  if (!games || !games.length) return null;

  // The live week is the first with a game still to play.
  const weeks = [...new Set(games.map(g => g.pool_week))].sort((a, b) => a - b);
  const week = weeks.find(w => games.some(g => g.pool_week === w && g.status !== 'final'));
  if (!week) return null;

  const lock = games.filter(g => g.pool_week === week)
    .reduce((min, g) => (!min || g.kickoff_at < min ? g.kickoff_at : min), null);
  if (!lock) return null;

  const which = dueNow(lock, now);
  if (!which) return null;

  const { data: players } = await supabaseAdmin
    .from('cfb_players').select('id, user_id, display_name')
    .eq('season_id', season.id).eq('status', 'alive');
  const { data: picks } = await supabaseAdmin
    .from('cfb_picks').select('player_id').eq('season_id', season.id).eq('pool_week', week);

  const have = new Set((picks || []).map(p => p.player_id));
  const owing = (players || []).filter(p => !have.has(p.id));
  if (!owing.length) return null;

  const payload = which === 'last'
    ? {
        title: 'Last call — survivor pick',
        body: `The board locks ${etLabel(lock)}. Miss it and you take the auto-pick.`,
        url: `${SITE_URL}/?p=cfb`, tag: `cfb-${week}`,
      }
    : {
        title: 'Survivor pick due tomorrow',
        body: `Week ${week} locks ${etLabel(lock)}. Pick before then.`,
        url: `${SITE_URL}/?p=cfb`, tag: `cfb-${week}`,
      };

  return sendOnce(`cfb-${which}`, `w${week}`, owing.map(p => p.user_id), payload);
}

async function nflReminders(now) {
  const { data: season } = await supabaseAdmin
    .from('mnf_seasons').select('*').eq('status', 'active')
    .order('year', { ascending: false }).limit(1).maybeSingle();
  if (!season) return null;

  // Each round stands on its own: a missed Thursday says nothing about Sunday.
  const horizon = new Date(now + DAY_AHEAD + HOUR).toISOString();
  const { data: games } = await supabaseAdmin
    .from('mnf_games').select('id, week_no, slot_name, kickoff_at, away_team, home_team, status')
    .eq('season_id', season.id)
    .gt('kickoff_at', new Date(now).toISOString())
    .lt('kickoff_at', horizon);
  if (!games || !games.length) return null;

  const out = [];
  for (const g of games) {
    const which = dueNow(g.kickoff_at, now);
    if (!which) continue;

    const { data: ms } = await supabaseAdmin
      .from('mnf_matchups').select('picker_id, picked_side')
      .eq('season_id', season.id).eq('week_no', g.week_no).eq('slot_name', g.slot_name);
    const owing = (ms || []).filter(m => !m.picked_side).map(m => m.picker_id);
    if (!owing.length) continue;

    const { data: players } = await supabaseAdmin
      .from('mnf_players').select('id, user_id').in('id', owing);

    const matchup = `${g.away_team} at ${g.home_team}`;
    const payload = which === 'last'
      ? {
          title: 'Last call — your pick',
          body: `${matchup} kicks ${etLabel(g.kickoff_at)}. No pick and you get the favorite.`,
          url: `${SITE_URL}/?p=nfl`, tag: `nfl-${g.id}`,
        }
      : {
          title: 'You pick tomorrow night',
          body: `${matchup}, ${etLabel(g.kickoff_at)}. Take your side.`,
          url: `${SITE_URL}/?p=nfl`, tag: `nfl-${g.id}`,
        };

    out.push(await sendOnce(`nfl-${which}`, g.id, (players || []).map(p => p.user_id), payload));
  }
  return out.length ? out : null;
}

async function runReminders() {
  const now = Date.now();
  try {
    const a = await cfbReminders(now);
    const b = await nflReminders(now);
    return { cfb: a, nfl: b };
  } catch (err) {
    console.error(`[Push] reminder run failed: ${err.message}`);
    return { error: err.message };
  }
}

module.exports = { publicKey, sendToUsers, sendOnce, runReminders, dueNow, windowFor };
