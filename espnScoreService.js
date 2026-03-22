const axios = require('axios');
const { supabase } = require('./supabase');

const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard';
const TOURNAMENT_ID = '00000000-0000-0000-0000-000000002026';

class ESPNScoreService {
  static async fetchScores(dateStr) {
    try {
      const d = dateStr ? dateStr.replace(/-/g, '') : new Date().toISOString().slice(0,10).replace(/-/g,'');
      const url = ESPN_SCOREBOARD + '?dates=' + d + '&limit=100&groups=100';
      console.log('[ESPN] Fetching:', url);
      const response = await axios.get(url);
      const events = response.data && response.data.events ? response.data.events : [];
      console.log('[ESPN] Found ' + events.length + ' games for ' + d);
      return events;
    } catch (error) {
      console.error('[ESPN] Fetch error:', error.message);
      return [];
    }
  }

  static normalizeTeamName(espnName) {
    if (!espnName) return '';
    var map = {
      'Duke':'Duke','Arizona':'Arizona','Michigan':'Michigan','Florida':'Florida',
      'UConn':'UConn','Kansas':'Kansas','Purdue':'Purdue','Houston':'Houston',
      'Iowa State':'Iowa State','Iowa St':'Iowa State','Alabama':'Alabama',
      'Michigan State':'Michigan State','Michigan St':'Michigan State',
      'Gonzaga':'Gonzaga','Virginia':'Virginia','Illinois':'Illinois',
      'North Carolina':'North Carolina','UNC':'North Carolina',
      'Kentucky':'Kentucky','Tennessee':'Tennessee',
      'Arkansas':'Arkansas','BYU':'BYU','Louisville':'Louisville',
      'Wisconsin':'Wisconsin','UCLA':'UCLA',
      'Ohio State':'Ohio State','Ohio St':'Ohio State',
      'TCU':'TCU','Texas Tech':'Texas Tech','Nebraska':'Nebraska',
      'Vanderbilt':'Vanderbilt','Clemson':'Clemson','Iowa':'Iowa',
      'Georgia':'Georgia','Missouri':'Missouri',
      'Texas A&M':'Texas A&M','Texas A&M Aggies':'Texas A&M',
      "Saint Mary's":"Saint Mary's","St. Mary's":"Saint Mary's","Saint Mary's (CA)":"Saint Mary's",
      'Villanova':'Villanova',"St. John's":"St. John's","St. John's (NY)":"St. John's",
      'High Point':'High Point','Siena':'Siena','Troy':'Troy',
      'South Florida':'South Florida','USF':'South Florida','S Florida':'South Florida','S. Florida':'South Florida',
      'McNeese':'McNeese','McNeese State':'McNeese','McNeese St':'McNeese',
      'Cal Baptist':'Cal Baptist','California Baptist':'Cal Baptist','CBU':'Cal Baptist',
      'Northern Iowa':'Northern Iowa','UNI':'Northern Iowa','N Iowa':'Northern Iowa','N. Iowa':'Northern Iowa',
      'North Dakota State':'North Dakota State','North Dakota St':'North Dakota State',
      'NDSU':'North Dakota State','N Dakota St':'North Dakota State','N. Dakota St':'North Dakota State',
      'N. Dakota St.':'North Dakota State','ND State':'North Dakota State',
      'VCU':'VCU','Howard':'Howard','Idaho':'Idaho',
      'Penn':'Penn','Pennsylvania':'Penn',
      'Hawaii':'Hawaii',"Hawai'i":'Hawaii',"Hawai\'i":'Hawaii',
      'Kennesaw State':'Kennesaw State','Kennesaw St':'Kennesaw State',
      'Saint Louis':'Saint Louis','St. Louis':'Saint Louis','SLU':'Saint Louis',
      'Texas':'Texas','NC State':'NC State','N.C. State':'NC State',
      'Miami':'Miami (FL)','Miami FL':'Miami (FL)','Miami (FL)':'Miami (FL)',
      'Miami Ohio':'Miami (OH)','Miami (OH)':'Miami (OH)',
      'SMU':'SMU','UMBC':'UMBC',
      'Prairie View A&M':'Prairie View A&M','Prairie View':'Prairie View A&M',
      'Lehigh':'Lehigh',
      'LIU':'LIU','Long Island':'LIU','Long Island University':'LIU','LIU Brooklyn':'LIU',
      'Utah State':'Utah State','Utah St':'Utah State',
      'Queens':'Queens','Queens (NC)':'Queens',
      'Akron':'Akron','Hofstra':'Hofstra',
      'Wright State':'Wright State','Wright St':'Wright State',
      'Santa Clara':'Santa Clara',
      'Tennessee State':'Tennessee State','Tennessee St':'Tennessee State','Tenn St':'Tennessee State',
      'UCF':'UCF','Furman':'Furman',
    };
    if (map[espnName]) return map[espnName];
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      if (espnName.toLowerCase() === keys[i].toLowerCase()) return map[keys[i]];
    }
    // Fallback: try removing common suffixes
    var stripped = espnName.replace(/ (Wildcats|Blue Devils|Wolverines|Gators|Huskies|Jayhawks|Boilermakers|Cougars|Cyclones|Crimson Tide|Spartans|Bulldogs|Cavaliers|Fighting Illini|Tar Heels|Volunteers|Razorbacks|Cardinals|Badgers|Bruins|Buckeyes|Horned Frogs|Red Raiders|Cornhuskers|Commodores|Tigers|Hawkeyes|Aggies|Gaels|Panthers|Hurricanes|Rams|Billikens|Bison|Bears|Cowboys|Mountaineers|Bearcats|Friars|Hoyas|Ducks|Beavers|Demon Deacons|Yellow Jackets|Wolfpack|Seminoles|Longhorns|Sooners|Mustangs|Owls|Quakers)$/i, '');
    if (map[stripped]) return map[stripped];
    for (var j = 0; j < keys.length; j++) {
      if (stripped.toLowerCase() === keys[j].toLowerCase()) return map[keys[j]];
    }
    return espnName;
  }

  static async syncScoresToGames(tournamentId) {
    var tid = tournamentId || TOURNAMENT_ID;
    var result = await supabase.from('teams').select('id, name').eq('tournament_id', tid);
    var teams = result.data;
    var tErr = result.error;
    console.log('[ESPN] Teams loaded:', teams ? teams.length : 0, 'Error:', tErr ? tErr.message : 'none');
    if (!teams || teams.length === 0) return { updated: 0, error: tErr ? tErr.message : 'No teams found' };

    var teamByName = {};
    for (var i = 0; i < teams.length; i++) { teamByName[teams[i].name.toLowerCase()] = teams[i]; }

    var gResult = await supabase.from('games').select('id, game_date, team_a_id, team_b_id, status').eq('tournament_id', tid).neq('status', 'final');
    var pendingGames = gResult.data;
    console.log('[ESPN] Pending games:', pendingGames ? pendingGames.length : 0);
    if (!pendingGames || pendingGames.length === 0) return { updated: 0, message: 'No pending games' };

    var dateSet = {};
    for (var j = 0; j < pendingGames.length; j++) { dateSet[pendingGames[j].game_date] = true; }
    var dates = Object.keys(dateSet);
    var updated = 0;
    var log = [];

    for (var di = 0; di < dates.length; di++) {
      var espnGames = await this.fetchScores(dates[di]);

      for (var ei = 0; ei < espnGames.length; ei++) {
        var event = espnGames[ei];
        var comp = event.competitions && event.competitions[0];
        if (!comp) continue;
        var isComplete = comp.status && comp.status.type && comp.status.type.completed === true;
        if (!isComplete) continue;

        var competitors = comp.competitors || [];
        if (competitors.length !== 2) continue;

        var rawName1 = competitors[0].team ? (competitors[0].team.shortDisplayName || competitors[0].team.displayName || '') : '';
        var rawName2 = competitors[1].team ? (competitors[1].team.shortDisplayName || competitors[1].team.displayName || '') : '';
        var name1 = this.normalizeTeamName(rawName1);
        var name2 = this.normalizeTeamName(rawName2);

        var dbTeam1 = teamByName[name1.toLowerCase()];
        var dbTeam2 = teamByName[name2.toLowerCase()];

        if (!dbTeam1 || !dbTeam2) {
          log.push('No match: "' + rawName1 + '" (' + name1 + ') or "' + rawName2 + '" (' + name2 + ')');
          continue;
        }

        var score1 = parseInt(competitors[0].score);
        var score2 = parseInt(competitors[1].score);
        var winnerId = score1 > score2 ? dbTeam1.id : dbTeam2.id;

        var match = null;
        for (var mi = 0; mi < pendingGames.length; mi++) {
          var g = pendingGames[mi];
          if ((g.team_a_id === dbTeam1.id && g.team_b_id === dbTeam2.id) || (g.team_a_id === dbTeam2.id && g.team_b_id === dbTeam1.id)) {
            match = g;
            break;
          }
        }
        if (!match) continue;

        var teamAScore = match.team_a_id === dbTeam1.id ? score1 : score2;
        var teamBScore = match.team_a_id === dbTeam1.id ? score2 : score1;

        var upResult = await supabase.from('games').update({ team_a_score: teamAScore, team_b_score: teamBScore, winner_id: winnerId, status: 'final' }).eq('id', match.id);
        if (upResult.error) {
          log.push('Update error: ' + upResult.error.message);
        } else {
          log.push('Updated: ' + name1 + ' ' + score1 + ' - ' + score2 + ' ' + name2);
          updated++;
        }
      }
    }
    console.log('[ESPN] Updated ' + updated + ' scores');
    return { updated: updated, log: log };
  }

  static async scorePicks(tournamentId) {
    var tid = tournamentId || TOURNAMENT_ID;
    var fResult = await supabase.from('games').select('id, winner_id').eq('tournament_id', tid).eq('status', 'final');
    var finalGames = fResult.data;
    if (!finalGames || finalGames.length === 0) return { scored: 0 };
    var wins = 0, losses = 0;

    for (var i = 0; i < finalGames.length; i++) {
      var game = finalGames[i];
      var winResult = await supabase.from('picks').update({ result: 'win' }).eq('game_id', game.id).eq('team_id', game.winner_id).eq('result', 'pending').select();
      if (winResult.data && winResult.data.length > 0) {
        for (var w = 0; w < winResult.data.length; w++) {
          var pick = winResult.data[w];
          var entryResult = await supabase.from('entries').select('total_points').eq('id', pick.entry_id).single();
          await supabase.from('entries').update({ total_points: ((entryResult.data && entryResult.data.total_points) || 0) + (pick.round || 1) }).eq('id', pick.entry_id);
        }
        wins += winResult.data.length;
      }
      var lossResult = await supabase.from('picks').update({ result: 'loss' }).eq('game_id', game.id).neq('team_id', game.winner_id).eq('result', 'pending').select();
      if (lossResult.data && lossResult.data.length > 0) {
        for (var l = 0; l < lossResult.data.length; l++) {
          await supabase.from('entries').update({ status: 'eliminated' }).eq('id', lossResult.data[l].entry_id);
        }
        losses += lossResult.data.length;
      }
    }
    console.log('[ESPN] Scored: ' + wins + ' wins, ' + losses + ' losses');
    return { scored: wins + losses, wins: wins, losses: losses };
  }
}

module.exports = ESPNScoreService;
