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

async function loadSource(src) {
  const hit = cache.get(src.key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit, cached: true };

  try {
    const res = await axios.get(src.url, {
      timeout: 10000,
      // Some hosts refuse a request with no User-Agent at all.
      headers: { 'User-Agent': 'BarryBets/1.0 (+https://www.barrysbets.net)', Accept: '*/*' },
      // Feeds are text; stop axios guessing.
      responseType: src.espn ? 'json' : 'text',
      maxContentLength: 5 * 1024 * 1024,
    });

    let stories = src.espn ? parseEspn(res.data) : parseFeed(String(res.data));
    if (src.filter) stories = stories.filter(s => VOLS.test(s.title + ' ' + s.summary));
    stories = stories.map(s => ({ ...s, source: src.name, source_key: src.key }));

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
  const results = await Promise.all(SOURCES.map(async s => ({ src: s, got: await loadSource(s) })));

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
    sources: results.map(({ src, got }) => ({
      name: src.name,
      count: got.stories.length,
      ok: !got.error,
      error: got.error || null,
    })),
  };
}

// What is actually working. Worth having: a feed that quietly dies just
// looks like a slow news week.
async function health() {
  const results = await Promise.all(SOURCES.map(async s => {
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
  return { checked_at: new Date().toISOString(), sources: results };
}

module.exports = { stories, health, SOURCES, parseFeed, parseEspn, strip };
