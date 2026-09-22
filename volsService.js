// ═══════════════════════════════════════════════════════════════
// BARRY BETS — VOLS NEWS
//
// All four men are Tennessee fans, so the app carries the news as well as
// the pools. Headline, source, time and a link out — never the article
// body. That is what an aggregator is allowed to do, and it is also all
// anyone wants on a phone.
//
// Two things deliberately NOT here:
//
//   Volquest. Will pays for it; Barry, Perk and Kirkland do not. Pulling
//   paid reporting into an app where non-subscribers read it is
//   infringement, and it takes money off the writers doing the work. The
//   app links out to it instead, so a subscriber reads it there.
//
//   Twitter. The free API no longer serves timelines and the cheapest tier
//   that does is $200 a month. Breaking Vols news lands in the free feeds
//   below within minutes anyway.
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');

const ESPN_CFB = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/news';

// Anything not exclusively about Tennessee gets filtered to stories that
// actually mention them, so a national outlet does not drown the feed.
const VOLS = /\b(tennessee|vols?|volunteers|neyland|heupel|knoxville|rocky top)\b/i;

// verified: confirmed returning items before this shipped.
// unverified: plausible but unconfirmed — kept because /health reports
// exactly which sources are working, so a dead one is visible rather than
// silently missing. Prune from here once the health check has spoken.
const SOURCES = [
  { key: 'rti',      name: 'Rocky Top Insider', url: 'https://rockytopinsider.com/feed/',            verified: true },
  { key: 'rtt',      name: 'Rocky Top Talk',    url: 'https://www.rockytoptalk.com/rss/current.xml', verified: true },
  { key: 'espn',     name: 'ESPN',              url: `${ESPN_CFB}?limit=50`, espn: true, filter: true, verified: true },
  { key: 'volswire', name: 'Vols Wire',         url: 'https://volswire.usatoday.com/feed/',          verified: false },
  { key: 'sds',      name: 'Saturday Down South', url: 'https://www.saturdaydownsouth.com/feed/', filter: true, verified: false },
  { key: 'on3',      name: 'On3 Tennessee',     url: 'https://www.on3.com/teams/tennessee-volunteers/feed/', verified: false },
  { key: 'outkick',  name: 'OutKick',           url: 'https://www.outkick.com/feed/', filter: true,  verified: false },
];

// ── video ────────────────────────────────────────────────────
// YouTube's public RSS feed is GONE. Channel pages still advertise
// /feeds/videos.xml?channel_id=... in a <link rel=alternate>, and it still
// 404s — checked Sep 22 2026 against both channels below with a clean
// same-origin request. So video needs the official Data API.
//
// The key is optional on purpose. Without one these channels appear as
// link-outs, which is worse than thumbnails but better than a feature that
// silently shows nothing. Set YOUTUBE_API_KEY in Railway to switch it on.
//
// Quota note: playlistItems costs 1 unit per call against a 10,000/day free
// allowance. The search endpoint costs 100 and is not needed — a channel's
// uploads playlist id is just its channel id with UC swapped for UU.
const YT_KEY = process.env.YOUTUBE_API_KEY || '';

const CHANNELS = [
  { key: 'pate', name: 'Pate State', handle: '@JoshPateCFB',
    id: 'UCg-q_MDeWQrjizr1VPLEpYg' },
  { key: 'outkicktv', name: 'OutKick', handle: '@OutKick',
    id: 'UCw66uyR1uMkn8rxLilWoFUA', filter: true },
];

// Twitter cannot be read without paying — see the note at the top — so
// these are one-tap links to the feeds themselves. Correct or extend the
// list freely; a wrong handle here is a dead link, not an error.
const X_FOLLOW = [
  { name: 'Clay Travis', handle: 'ClayTravis' },
  { name: 'Josh Pate',   handle: 'JoshPateCFB' },
  { name: 'Vols on X',   search: 'Tennessee Vols football' },
];

// ── a small, tolerant feed parser ────────────────────────────
// Not worth a dependency for this. It has to cope with RSS 2.0 and Atom,
// CDATA, attribute-carried links and the usual entity soup.

function strip(s) {
  return String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')              // last, or it double-decodes
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? strip(m[1]) : '';
}

// Atom puts the article URL in an attribute, RSS in the element body.
function linkOf(block) {
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
           || block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (alt) return alt[1];
  const body = tag(block, 'link');
  if (body) return body;
  return tag(block, 'guid');
}

function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  return blocks.map(b => {
    const when = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const t = when ? new Date(when) : null;
    return {
      title: tag(b, 'title'),
      url: linkOf(b),
      published_at: t && !isNaN(t) ? t.toISOString() : null,
      // A one-line taste, hard-capped. Enough to decide whether to tap.
      summary: (tag(b, 'description') || tag(b, 'summary') || '').slice(0, 220),
    };
  }).filter(x => x.title && x.url);
}

// Data API shape. The thumbnail is derived from the video id rather than
// read out of the payload — same URL YouTube's own share and embed use, and
// it survives the snippet arriving without a thumbnails block.
function parseYouTubeApi(payload) {
  return (payload.items || []).map(it => {
    const sn = it.snippet || {};
    const vid = (sn.resourceId && sn.resourceId.videoId) || null;
    if (!vid || sn.title === 'Private video' || sn.title === 'Deleted video') return null;
    const t = sn.publishedAt ? new Date(sn.publishedAt) : null;
    return {
      title: strip(sn.title),
      url: `https://www.youtube.com/watch?v=${vid}`,
      published_at: t && !isNaN(t) ? t.toISOString() : null,
      summary: '',
      video_id: vid,
      thumbnail: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
    };
  }).filter(Boolean);
}

// Kept for the day YouTube brings the feed back, and because it is the only
// parser that can read a channel feed without a key.
function parseYouTube(xml) {
  const blocks = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    const vid = (b.match(/<yt:videoId>([\w-]+)<\/yt:videoId>/) || [])[1]
      || (b.match(/watch\?v=([\w-]+)/) || [])[1];
    if (!vid) return null;
    const when = tag(b, 'published') || tag(b, 'updated');
    const t = when ? new Date(when) : null;
    return {
      title: tag(b, 'title'),
      url: `https://www.youtube.com/watch?v=${vid}`,
      published_at: t && !isNaN(t) ? t.toISOString() : null,
      summary: '',
      video_id: vid,
      thumbnail: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
    };
  }).filter(x => x && x.title);
}

// A handle resolves to a channel id once and is then remembered for a day.
const channelIds = new Map();

async function resolveChannel(handle) {
  const hit = channelIds.get(handle);
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.id;

  const res = await axios.get(`https://www.youtube.com/${handle}`, {
    timeout: 10000,
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    responseType: 'text',
    maxContentLength: 8 * 1024 * 1024,
  });
  const m = String(res.data).match(/"(?:channelId|externalId)":"(UC[\w-]{20,26})"/);
  if (!m) throw new Error('no channel id in page');
  channelIds.set(handle, { id: m[1], at: Date.now() });
  return m[1];
}

function parseEspn(payload) {
  return (payload.articles || []).map(a => ({
    title: a.headline || '',
    url: (a.links && a.links.web && a.links.web.href) || '',
    published_at: a.published || null,
    summary: String(a.description || '').slice(0, 220),
  })).filter(x => x.title && x.url);
}

// ── fetch with a cache ───────────────────────────────────────
// Four men refreshing a phone should not mean four hits on someone's
// WordPress. Also keeps the last good copy, so one flaky source does not
// blank the screen.

const TTL_MS = 15 * 60 * 1000;
const cache = new Map();   // key -> { at, stories, error }

const UA = 'BarryBets/1.0 (+https://www.barrysbets.net)';

async function loadSource(src) {
  const hit = cache.get(src.key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit, cached: true };

  try {
    let url = src.url;
    if (src.channel) {
      if (!YT_KEY) throw new Error('no YOUTUBE_API_KEY set');
      const id = src.channel.id || await resolveChannel(src.channel.handle);
      const uploads = 'UU' + id.slice(2);
      url = 'https://www.googleapis.com/youtube/v3/playlistItems'
          + `?part=snippet&maxResults=10&playlistId=${uploads}&key=${YT_KEY}`;
    }

    const res = await axios.get(url, {
      timeout: 10000,
      // Some hosts refuse a request with no User-Agent at all.
      headers: { 'User-Agent': UA, Accept: '*/*' },
      // Feeds are text; stop axios guessing.
      responseType: (src.espn || src.channel) ? 'json' : 'text',
      maxContentLength: 5 * 1024 * 1024,
    });

    let stories = src.espn ? parseEspn(res.data)
      : src.channel ? parseYouTubeApi(res.data)
      : parseFeed(String(res.data));
    if (src.filter) stories = stories.filter(s => VOLS.test(s.title + ' ' + s.summary));
    stories = stories.map(s => ({
      ...s, source: src.name, source_key: src.key,
      kind: src.channel ? 'video' : 'article',
    }));

    const fresh = { at: Date.now(), stories, error: null };
    cache.set(src.key, fresh);
    return { ...fresh, cached: false };
  } catch (err) {
    const why = err.response ? `HTTP ${err.response.status}` : err.code || err.message;
    // Serve the last good copy rather than nothing.
    if (hit) return { ...hit, error: why, stale: true };
    const bad = { at: Date.now(), stories: [], error: why };
    cache.set(src.key, bad);
    return { ...bad, cached: false };
  }
}

async function stories({ limit = 40 } = {}) {
  // Video sources only join the run when there is a key to call the API
  // with. Otherwise they would each report the same failure on every load.
  const active = YT_KEY
    ? SOURCES.concat(CHANNELS.map(c => ({
        key: c.key, name: c.name, channel: c, filter: c.filter, verified: false })))
    : SOURCES;

  const results = await Promise.all(active.map(async s => ({ src: s, got: await loadSource(s) })));

  const seen = new Set();
  const all = [];
  for (const { got } of results) {
    for (const s of got.stories) {
      // The same story syndicated twice is still one story.
      const k = s.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      all.push(s);
    }
  }

  all.sort((a, b) => {
    if (!a.published_at) return 1;
    if (!b.published_at) return -1;
    return new Date(b.published_at) - new Date(a.published_at);
  });

  return {
    stories: all.slice(0, limit),
    // Channels to watch. Thumbnails need the API key; without it these are
    // still one tap away, which is the honest version of the feature.
    watch: CHANNELS.map(c => ({
      name: c.name,
      url: `https://www.youtube.com/${c.handle}`,
      inline: !!YT_KEY,
    })),
    video_enabled: !!YT_KEY,
    follow: X_FOLLOW.map(f => ({
      name: f.name,
      url: f.search
        ? `https://x.com/search?q=${encodeURIComponent(f.search)}&f=live`
        : `https://x.com/${f.handle}`,
    })),
    sources: results.map(({ src, got }) => ({
      name: src.name,
      kind: src.youtube ? 'video' : 'article',
      count: got.stories.length,
      ok: !got.error,
      error: got.error || null,
    })),
  };
}

// What is actually working. Worth having: a feed that quietly dies just
// looks like a slow news week.
async function health() {
  const all = SOURCES.concat(CHANNELS.map(c => ({
    key: c.key, name: c.name + ' (video)', channel: c, filter: c.filter, verified: false })));
  const results = await Promise.all(all.map(async s => {
    cache.delete(s.key);                       // force a real fetch
    const got = await loadSource(s);
    return {
      key: s.key, name: s.name, expected: s.verified ? 'verified' : 'unverified',
      ok: !got.error && got.stories.length > 0,
      items: got.stories.length,
      error: got.error || null,
      newest: got.stories[0] ? got.stories[0].title.slice(0, 80) : null,
    };
  }));
  return {
    checked_at: new Date().toISOString(),
    youtube_key_set: !!YT_KEY,
    sources: results,
  };
}

module.exports = {
  stories, health, SOURCES, CHANNELS, X_FOLLOW,
  parseFeed, parseEspn, parseYouTube, parseYouTubeApi, strip,
};
