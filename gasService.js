// ═══════════════════════════════════════════════════════════════
// BARRY BETS — NATIONAL AVERAGE GAS PRICE
//
// AAA publishes the number everyone means when they say "the national
// average", and refreshes it daily. Their robots.txt disallows nothing on
// this path and asks only for a ten-second crawl delay; we read the page
// once an hour, so we are three orders of magnitude inside that.
//
// One number, cached, with the last good value kept if a read fails. If we
// have never had a good read, this returns null and the ticker hides itself
// rather than showing a guess.
// ═══════════════════════════════════════════════════════════════

const SRC = 'https://gasprices.aaa.com/';
const TTL_MS = 60 * 60 * 1000;          // an hour; the source moves once a day
const TIMEOUT_MS = 8000;
const UA = 'BarryBets/1.0 (+https://www.barrysbets.net)';

let cache = null;                        // { at, data }

// The table reads: <td>Current Avg.</td><td>$4.4786</td><td>…
// Regular is always the first price column, which is the one we want.
function cell(html, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '<td[^>]*>\\s*' + esc + '\\s*</td>\\s*<td[^>]*>\\s*\\$?\\s*([0-9]+\\.[0-9]+)',
    'i'
  );
  const m = html.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  // A pump price outside this range means the page changed shape, not that
  // gas got interesting. Better to report nothing than something absurd.
  return n > 0.5 && n < 25 ? n : null;
}

async function scrape() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SRC, {
      headers: { 'user-agent': UA, accept: 'text/html' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();

    const price = cell(html, 'Current Avg.');
    if (price == null) throw new Error('current average not found on the page');

    const asOf = (html.match(
      /Price as of\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i
    ) || [])[1] || null;

    return {
      price,
      yesterday: cell(html, 'Yesterday Avg.'),
      week_ago:  cell(html, 'Week Ago Avg.'),
      month_ago: cell(html, 'Month Ago Avg.'),
      year_ago:  cell(html, 'Year Ago Avg.'),
      as_of: asOf,
      source: 'AAA',
      fetched_at: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function current() {
  if (cache && cache.data && Date.now() - cache.at < TTL_MS) {
    return { ...cache.data, cached: true };
  }
  try {
    const data = await scrape();
    cache = { at: Date.now(), data };
    return { ...data, cached: false };
  } catch (err) {
    // Yesterday's number beats a blank strip. No number beats a wrong one.
    if (cache && cache.data) return { ...cache.data, stale: true };
    return null;
  }
}

module.exports = { current };
