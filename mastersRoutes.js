const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PICKS_LOCK = new Date('2026-04-09T12:00:00Z');
const MISSED_CUT_STROKES = 80;

const GOLFER_SEED = [
  {name:'Scottie Scheffler',tier:1,world_ranking:1},{name:'Rory McIlroy',tier:1,world_ranking:2},
  {name:'Xander Schauffele',tier:1,world_ranking:3},{name:'Collin Morikawa',tier:1,world_ranking:4},
  {name:'Bryson DeChambeau',tier:1,world_ranking:5},
  {name:'Viktor Hovland',tier:2,world_ranking:6},{name:'Jordan Spieth',tier:2,world_ranking:7},
  {name:'Ludvig Aberg',tier:2,world_ranking:8},{name:'Patrick Cantlay',tier:2,world_ranking:9},
  {name:'Tommy Fleetwood',tier:2,world_ranking:10},{name:'Jon Rahm',tier:2,world_ranking:11},
  {name:'Alex Noren',tier:3,world_ranking:12},{name:'Robert MacIntyre',tier:3,world_ranking:13},
  {name:'Cameron Young',tier:3,world_ranking:14},{name:'Hideki Matsuyama',tier:3,world_ranking:15},
  {name:'Shane Lowry',tier:3,world_ranking:16},{name:'Wyndham Clark',tier:3,world_ranking:17},
  {name:'Sungjae Im',tier:3,world_ranking:18},{name:'Justin Thomas',tier:3,world_ranking:19},
  {name:'Max Homa',tier:3,world_ranking:20},
  {name:'Sahith Theegala',tier:4,world_ranking:21},{name:'Tony Finau',tier:4,world_ranking:22},
  {name:'Russell Henley',tier:4,world_ranking:23},{name:'Keegan Bradley',tier:4,world_ranking:24},
  {name:'Brooks Koepka',tier:4,world_ranking:25},{name:'Sam Burns',tier:4,world_ranking:26},
  {name:'Corey Conners',tier:4,world_ranking:27},{name:'Cameron Smith',tier:4,world_ranking:28},
  {name:'Rickie Fowler',tier:4,world_ranking:29},{name:'Joaquin Niemann',tier:4,world_ranking:30},
  {name:'Matt Fitzpatrick',tier:5,world_ranking:31},{name:'Sepp Straka',tier:5,world_ranking:32},
  {name:'Akshay Bhatia',tier:5,world_ranking:33},{name:'Jason Day',tier:5,world_ranking:34},
  {name:'Denny McCarthy',tier:5,world_ranking:35},{name:'Tom Kim',tier:5,world_ranking:36},
  {name:'Chris Kirk',tier:5,world_ranking:37},{name:'Byeong Hun An',tier:5,world_ranking:38},
  {name:'Taylor Moore',tier:5,world_ranking:39},{name:'Nico Echavarria',tier:5,world_ranking:40},
  {name:'Dustin Johnson',tier:6,world_ranking:50},{name:'Patrick Reed',tier:6,world_ranking:55},
  {name:'Sergio Garcia',tier:6,world_ranking:60},{name:'Bubba Watson',tier:6,world_ranking:70},
  {name:'Adam Scott',tier:6,world_ranking:85},{name:'Danny Willett',tier:6,world_ranking:90},
  {name:'Fred Couples',tier:6,world_ranking:200},{name:'Zach Johnson',tier:6,world_ranking:210},
  {name:'Jose Maria Olazabal',tier:6,world_ranking:230},{name:'Mike Weir',tier:6,world_ranking:240}
];

const TIER_LABELS = {1:'The Favorites',2:'Contenders',3:'Dark Horses',4:'Value Picks',5:'Sleepers',6:'Long Shots'};
const isLocked = () => new Date() >= PICKS_LOCK;

// GET /api/masters/golfers
router.get('/golfers', async (req, res) => {
  try {
    const { data, error } = await supabase.from('masters_golfers').select('*').order('tier').order('world_ranking');
    if (error) throw error;
    const grouped = {};
    for (let t = 1; t <= 6; t++) {
      grouped[t] = { label: TIER_LABELS[t], golfers: data.filter(g => g.tier === t) };
    }
    res.json({ tiers: grouped, locked: isLocked(), locksAt: PICKS_LOCK.toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/masters/picks/:competitionId/:userId
router.get('/picks/:competitionId/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase.from('masters_picks')
      .select('*').eq('competition_id', req.params.competitionId).eq('user_id', req.params.userId).single();
    if (error && error.code !== 'PGRST116') throw error;
    res.json({ picks: data || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/masters/picks
router.post('/picks', async (req, res) => {
  if (isLocked()) return res.status(403).json({ error: 'Picks are locked' });
  try {
    const { competition_id, user_id, tier1_golfer_id, tier2_golfer_id, tier3_golfer_id, tier4_golfer_id, tier5_golfer_id, tier6_golfer_id } = req.body;
    const { data, error } = await supabase.from('masters_picks').upsert({
      competition_id, user_id, tier1_golfer_id, tier2_golfer_id, tier3_golfer_id,
      tier4_golfer_id, tier5_golfer_id, tier6_golfer_id,
      submitted: !!(tier1_golfer_id && tier2_golfer_id && tier3_golfer_id && tier4_golfer_id && tier5_golfer_id && tier6_golfer_id),
      updated_at: new Date().toISOString()
    }, { onConflict: 'competition_id,user_id' }).select().single();
    if (error) throw error;
    res.json({ picks: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/masters/leaderboard/:competitionId
router.get('/leaderboard/:competitionId', async (req, res) => {
  try {
    const { data: picks, error: pErr } = await supabase.from('masters_picks')
      .select('*').eq('competition_id', req.params.competitionId).eq('submitted', true);
    if (pErr) throw pErr;
    const { data: scores } = await supabase.from('masters_scores').select('*');
    const { data: golfers } = await supabase.from('masters_golfers').select('id, name, tier');
    const { data: users } = await supabase.from('users').select('id, display_name');
    const scoreMap = {}; (scores || []).forEach(s => { scoreMap[s.golfer_id] = s; });
    const golferMap = {}; (golfers || []).forEach(g => { golferMap[g.id] = g; });
    const userMap = {}; (users || []).forEach(u => { userMap[u.id] = u; });
    const board = (picks || []).map(p => {
      const tierKeys = ['tier1_golfer_id','tier2_golfer_id','tier3_golfer_id','tier4_golfer_id','tier5_golfer_id','tier6_golfer_id'];
      const golferScores = tierKeys.map(k => {
        const gid = p[k]; if (!gid) return { golfer: null, total: 999 };
        const g = golferMap[gid] || {}; const s = scoreMap[gid] || {};
        const r1 = s.round1 || 0, r2 = s.round2 || 0;
        const r3 = s.made_cut === false ? MISSED_CUT_STROKES : (s.round3 || 0);
        const r4 = s.made_cut === false ? MISSED_CUT_STROKES : (s.round4 || 0);
        return { golfer: g.name, tier: g.tier, total: r1+r2+r3+r4, status: s.status || 'pending', position: s.position, made_cut: s.made_cut };
      });
      golferScores.sort((a, b) => a.total - b.total);
      const best4 = golferScores.slice(0, 4);
      return { user_id: p.user_id, display_name: (userMap[p.user_id] || {}).display_name || 'Unknown', total_score: best4.reduce((sum, gs) => sum + gs.total, 0), golfer_scores: golferScores, best4_indices: [0,1,2,3] };
    });
    board.sort((a, b) => a.total_score - b.total_score);
    res.json({ leaderboard: board, locked: isLocked() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/masters/admin/seed
router.post('/admin/seed', async (req, res) => {
  try {
    const { data, error } = await supabase.from('masters_golfers').upsert(
      GOLFER_SEED.map(g => ({ name: g.name, tier: g.tier, world_ranking: g.world_ranking, is_active: true })),
      { onConflict: 'name' }
    ).select();
    if (error) throw error;
    await supabase.from('masters_competitions').upsert([
      { league_id: 'a0000000-0000-0000-0000-000000000001', name: "2026 Masters - Barry's Crew", entry_fee: 20, picks_lock_at: PICKS_LOCK.toISOString(), status: 'open' },
      { league_id: 'c0000000-0000-0000-0000-000000001788', name: '2026 Masters - The 1788s', entry_fee: 20, picks_lock_at: PICKS_LOCK.toISOString(), status: 'open' }
    ], { onConflict: 'league_id' });
    res.json({ message: 'Seeded ' + data.length + ' golfers + 2 competitions' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/masters/admin/sync-scores
router.post('/admin/sync-scores', async (req, res) => {
  try {
    const espnRes = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard');
    const espnData = await espnRes.json();
    const event = espnData.events?.[0];
    if (!event) return res.json({ message: 'No active event found' });
    const competitors = event.competitions?.[0]?.competitors || [];
    const { data: golfers } = await supabase.from('masters_golfers').select('id, name');
    const normalize = n => n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/['.]/g,'').trim();
    let matched = 0, unmatched = [];
    for (const c of competitors) {
      const espnName = c.athlete?.displayName || '';
      const golfer = golfers.find(g => normalize(g.name) === normalize(espnName));
      if (!golfer) { unmatched.push(espnName); continue; }
      const ls = c.linescores || []; const st = c.status?.type?.name || 'STATUS_SCHEDULED'; const isCut = st === 'STATUS_CUT';
      await supabase.from('masters_scores').upsert({
        golfer_id: golfer.id, round1: ls[0]?.value||null, round2: ls[1]?.value||null,
        round3: isCut ? MISSED_CUT_STROKES : (ls[2]?.value||null), round4: isCut ? MISSED_CUT_STROKES : (ls[3]?.value||null),
        made_cut: !isCut, status: isCut ? 'cut' : (st === 'STATUS_FINISH' ? 'complete' : 'active'),
        position: c.status?.position?.displayName||null, updated_at: new Date().toISOString()
      }, { onConflict: 'golfer_id' });
      matched++;
    }
    res.json({ message: 'Synced', matched, unmatched, event: event.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/masters/competitions/:leagueId
router.get('/competitions/:leagueId', async (req, res) => {
  try {
    const { data, error } = await supabase.from('masters_competitions')
      .select('*').eq('league_id', req.params.leagueId).single();
    if (error) throw error;
    res.json({ competition: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
