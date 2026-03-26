const { supabase } = require('./supabase');

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM = 'Barry Bets <picks@the1788s.org>';
const SITE_URL = 'https://barrysbets.net';
const TOURNAMENT_ID = '00000000-0000-0000-0000-000000002026';

class EmailReminder {
  static async sendPickReminders() {
    if (!RESEND_KEY) return { error: 'No RESEND_API_KEY configured' };
    var today = new Date().toISOString().split('T')[0];
    var log = [];

    // Get today's games
    var { data: games } = await supabase.from('games')
      .select('id, game_date, game_time, team_a_id, team_b_id, status')
      .eq('tournament_id', TOURNAMENT_ID)
      .eq('game_date', today)
      .eq('status', 'scheduled');

    if (!games || games.length === 0) {
      return { sent: 0, log: ['No scheduled games today (' + today + ')'] };
    }

    var firstGameTime = games.map(function(g) { return g.game_time; }).sort()[0];
    log.push(games.length + ' games today, first at ' + firstGameTime);

    // Get all active entries
    var { data: entries } = await supabase.from('entries')
      .select('id, user_id, status')
      .eq('tournament_id', TOURNAMENT_ID)
      .eq('status', 'alive');

    if (!entries || entries.length === 0) {
      return { sent: 0, log: log.concat(['No alive entries']) };
    }

    // Get today's picks
    var gameIds = games.map(function(g) { return g.id; });
    var { data: picks } = await supabase.from('picks')
      .select('entry_id, game_id')
      .in('game_id', gameIds);

    var pickedEntries = new Set((picks || []).map(function(p) { return p.entry_id; }));

    // Find entries without picks
    var unpicked = entries.filter(function(e) { return !pickedEntries.has(e.id); });

    if (unpicked.length === 0) {
      return { sent: 0, log: log.concat(['All alive entries have picks for today']) };
    }

    // Get user emails
    var userIds = unpicked.map(function(e) { return e.user_id; });
    var { data: users } = await supabase.from('users')
      .select('id, email, display_name')
      .in('id', userIds);

    var sent = 0;
    for (var i = 0; i < (users || []).length; i++) {
      var user = users[i];
      try {
        var res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM,
            to: user.email,
            subject: 'Pick Reminder - Games Today at ' + firstGameTime,
            html: '<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px">' +
              '<div style="text-align:center;padding:16px 0;border-bottom:2px solid #1a2744">' +
              '<h1 style="font-size:24px;color:#1a2744;margin:0">BARRY BETS</h1>' +
              '<p style="font-size:11px;letter-spacing:3px;color:#8b6914;margin:4px 0 0">EST. 2026</p></div>' +
              '<div style="padding:24px 0">' +
              '<p style="font-size:16px;color:#1a2744">Hey ' + (user.display_name || 'there') + ',</p>' +
              '<p style="font-size:15px;color:#555;line-height:1.6">You haven\'t made your pick yet for today\'s games. First tip is at <strong>' + firstGameTime + '</strong>. Picks lock 30 minutes before game time.</p>' +
              '<div style="text-align:center;margin:24px 0">' +
              '<a href="' + SITE_URL + '" style="background:#8b6914;color:#f5f0e8;padding:12px 32px;text-decoration:none;font-size:13px;letter-spacing:2px;display:inline-block">MAKE YOUR PICK</a></div>' +
              '<p style="font-size:13px;color:#999;text-align:center">barrysbets.net</p></div></div>'
          })
        });
        if (res.ok) { sent++; log.push('Sent to ' + user.email); }
        else { var err = await res.text(); log.push('Failed ' + user.email + ': ' + err); }
      } catch(e) { log.push('Error ' + user.email + ': ' + e.message); }
    }

    return { sent: sent, total: unpicked.length, log: log };
  }
}

module.exports = EmailReminder;
