// Coin prices from Upbit (Korean won, public API, no key). Symbols stay "BTC-USD" style so watch lists don't change;
// "BTC-USD" -> market "KRW-BTC". Returns null when the coin isn't listed in won on Upbit (caller falls back to Yahoo).

const API = 'https://api.upbit.com/v1/';
// Upbit allows about 10 requests a second per IP: queue calls ~120 ms apart and retry on 429.
const wait = ms => new Promise(r => setTimeout(r, ms));
let gate = Promise.resolve();
const slot = () => { const g = gate.then(() => wait(120)); gate = g; return g; };
const get = async p => {
  for (let t = 0; t < 4; t++) {
    await slot();
    const r = await fetch(API + p, { headers: { Accept: 'application/json' } });
    if (r.status === 429) { await wait(600 * (t + 1)); continue; }
    if (!r.ok) throw new Error('upbit ' + r.status);
    return r.json();
  }
  throw new Error('upbit 429');
};
const sec = c => Date.parse(c.candle_date_time_utc + 'Z') / 1000;
const cols = arr => [arr.map(sec), arr.map(c => c.opening_price), arr.map(c => c.high_price), arr.map(c => c.low_price), arr.map(c => c.trade_price)];

function rsi(c, n = 14) {
  if (c.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; d > 0 ? g += d : l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : Math.round(100 - 100 / (1 + g / l));
}

async function upbit(sym, { hourlyPages = 4 } = {}) {
  const m = /^([A-Z0-9]+)-USD$/.exec(sym);
  if (!m) return null;
  const mk = 'KRW-' + m[1];
  try {
    const day = await get(`candles/days?market=${mk}&count=200`);
    if (!Array.isArray(day) || day.length < 20) return null;
    day.reverse();
    // Hourly: 200 per call, newest first. Page back with "to" for about a month.
    let hr = [];
    for (let p = 0; p < hourlyPages; p++) {
      const to = hr.length ? `&to=${encodeURIComponent(hr[0].candle_date_time_utc + 'Z')}` : '';
      const got = await get(`candles/minutes/60?market=${mk}&count=200${to}`);
      if (!Array.isArray(got) || !got.length) break;
      hr = [...got.reverse(), ...hr];
      if (got.length < 200) break;
    }
    const c = day.map(d => d.trade_price), last = c[c.length - 1], prev = c[c.length - 2];
    return {
      sym, cur: 'KRW', price: last, chg: prev ? (last / prev - 1) * 100 : 0, rsi: rsi(c),
      day: day[day.length - 1].candle_date_time_kst.slice(0, 10), spark: c.slice(-30), src: 'upbit',
      hist: day.map(d => [sec(d) * 1000, d.trade_price]),
      ohlc: { d: cols(day), h: hr.length >= 40 ? cols(hr) : null }
    };
  } catch { return null; }
}

module.exports = { upbit };
