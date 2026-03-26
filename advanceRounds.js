const { supabase } = require('./supabase');
const TOURNAMENT_ID = '00000000-0000-0000-0000-000000002026';

const E8_SCHEDULE = {
  'West':  { date: '2026-03-28', time: '6:09 PM ET', tv: 'TBS', venue: 'San Jose, CA' },
  'South': { date: '2026-03-28', time: '8:49 PM ET', tv: 'CBS', venue: 'Houston, TX' },
  'East':  { date: '2026-03-29', time: '2:20 PM ET', tv: 'CBS', venue: 'Washington, DC' },
  'Midwest': { date: '2026-03-29', time: '5:05 PM ET', tv: 'TBS', venue: 'Chicago, IL' },
};

const F4_MATCHUPS = [
  { regions: ['West', 'South'], date: '2026-04-04', time: '6:09 PM ET', tv: 'TBS', venue: 'Indianapolis, IN' },
  { regions: ['East', 'Midwest'], date: '2026-04-04', time: '8:49 PM ET', tv: 'TBS', venue: 'Indianapolis, IN' },
];

const CHAMP = { date: '2026-04-06', time: '9:20 PM ET', tv: 'TBS', venue: 'Indianapolis, IN' };

class RoundAdvancer {
  static async checkAndAdvance(tournamentId) {
    var tid = tournamentId || TOURNAMENT_ID;
    var log = [];
    await this.tryAdvance(tid, 3, 4, log);
    await this.tryAdvance(tid, 4, 5, log);
    await this.tryAdvance(tid, 5, 6, log);
    return { log: log };
  }

  static async tryAdvance(tid, currentRound, nextRound, log) {
    var { data: games } = await supabase.from('games')
      .select('id, region, winner_id, status, team_a_id, team_b_id')
      .eq('tournament_id', tid).eq('round', currentRound);
    if (!games || games.length === 0) { log.push('R' + currentRound + ': no games'); return; }
    var allFinal = games.every(function(g) { return g.status === 'final'; });
    if (!allFinal) { var p = games.filter(function(g){return g.status!=='final'}).length; log.push('R' + currentRound + ': ' + p + ' pending'); return; }
    var { data: next } = await supabase.from('games').select('id').eq('tournament_id', tid).eq('round', nextRound);
    if (next && next.length > 0) { log.push('R' + nextRound + ': already seeded'); return; }
    log.push('R' + currentRound + ': all final, seeding R' + nextRound);
    if (currentRound === 3) await this.seedE8(tid, games, log);
    if (currentRound === 4) await this.seedF4(tid, games, log);
    if (currentRound === 5) await this.seedChamp(tid, games, log);
  }

  static async seedE8(tid, s16, log) {
    var byRegion = {};
    s16.forEach(function(g) { if (!byRegion[g.region]) byRegion[g.region] = []; byRegion[g.region].push(g.winner_id); });
    var regions = Object.keys(byRegion);
    for (var i = 0; i < regions.length; i++) {
      var r = regions[i];
      var w = byRegion[r];
      if (w.length !== 2) { log.push('E8 ' + r + ': need 2 winners, got ' + w.length); continue; }
      var ta = await supabase.from('teams').select('seed').eq('id', w[0]).single();
      var tb = await supabase.from('teams').select('seed').eq('id', w[1]).single();
      var s = E8_SCHEDULE[r] || { date: '2026-03-28', time: 'TBD', tv: '', venue: '' };
      var { error } = await supabase.from('games').insert({
        tournament_id: tid, round: 4, game_date: s.date, game_time: s.time,
        region: r, team_a_id: w[0], team_b_id: w[1],
        team_a_seed: ta.data ? ta.data.seed : null, team_b_seed: tb.data ? tb.data.seed : null,
        status: 'scheduled', venue: s.venue, tv_network: s.tv
      });
      if (error) log.push('E8 ' + r + ' err: ' + error.message);
      else log.push('E8 ' + r + ': created');
    }
  }

  static async seedF4(tid, e8, log) {
    var winners = {};
    e8.forEach(function(g) { winners[g.region] = g.winner_id; });
    for (var i = 0; i < F4_MATCHUPS.length; i++) {
      var mu = F4_MATCHUPS[i];
      var a = winners[mu.regions[0]]; var b = winners[mu.regions[1]];
      if (!a || !b) { log.push('F4: missing winner for ' + mu.regions.join('/')); continue; }
      var ta = await supabase.from('teams').select('seed').eq('id', a).single();
      var tb = await supabase.from('teams').select('seed').eq('id', b).single();
      var { error } = await supabase.from('games').insert({
        tournament_id: tid, round: 5, game_date: mu.date, game_time: mu.time,
        region: 'Final Four', team_a_id: a, team_b_id: b,
        team_a_seed: ta.data ? ta.data.seed : null, team_b_seed: tb.data ? tb.data.seed : null,
        status: 'scheduled', venue: mu.venue, tv_network: mu.tv
      });
      if (error) log.push('F4 err: ' + error.message);
      else log.push('F4: ' + mu.regions.join(' vs ') + ' created');
    }
  }

  static async seedChamp(tid, f4, log) {
    if (f4.length !== 2) { log.push('Champ: need 2 F4 games'); return; }
    var ta = await supabase.from('teams').select('seed').eq('id', f4[0].winner_id).single();
    var tb = await supabase.from('teams').select('seed').eq('id', f4[1].winner_id).single();
    var { error } = await supabase.from('games').insert({
      tournament_id: tid, round: 6, game_date: CHAMP.date, game_time: CHAMP.time,
      region: 'Championship', team_a_id: f4[0].winner_id, team_b_id: f4[1].winner_id,
      team_a_seed: ta.data ? ta.data.seed : null, team_b_seed: tb.data ? tb.data.seed : null,
      status: 'scheduled', venue: CHAMP.venue, tv_network: CHAMP.tv
    });
    if (error) log.push('Champ err: ' + error.message);
    else log.push('Championship game created!');
  }
}

module.exports = RoundAdvancer;
