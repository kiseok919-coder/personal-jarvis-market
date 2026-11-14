// Personal Jarvis — market robot
// Runs on GitHub Actions. Fetches prices + RSI(14) + Fear & Greed and writes them to ONE Firestore document.
// It knows only the symbol list. No holdings, quantities, account data or plan ever pass through here.
// The document path is secret (BOT_KEY, stored in GitHub Secrets); Firestore rules allow only that one document.
// News briefing (news.js) is made at 07:00 and 23:00 KST, or when the app leaves a request ("req").

const { makeNews } = require('./news.js');
const { pack } = require('./signal.js');
const { upbit } = require('./upbit.js');
const KEY = process.env.BOT_KEY;
if (!KEY) throw new Error('BOT_KEY secret is missing');
const DOC = `https://firestore.googleapis.com/v1/projects/sales-board-4904c/databases/(default)/documents/econ_bot/${KEY}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

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

// Study signal (signal.js): OHLC candles -> RSI double-bottom state. Daily reuses the quote fetch; hourly is one more call.
function ohlc(res) {
  const q = res.indicators.quote[0], t = res.timestamp || [];
  const k = t.map((_, i) => i).filter(i => [q.open[i], q.high[i], q.low[i], q.close[i]].every(v => v != null));
  return k.length < 40 ? null : [k.map(i => t[i]), ...['open', 'high', 'low', 'close'].map(f => k.map(i => q[f][i]))];
}
function upStudy(o) {
  const out = {};
  try { out.d = pack(...o.d); } catch {}
  try { if (o.h) out.h = pack(...o.h); } catch {}
  return out.d || out.h ? out : null;
}
async function study(sym, daily) {
  const out = {};
  try { const d = ohlc(daily); if (d) out.d = pack(...d); } catch {}
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=60m`, { headers: { 'User-Agent': UA } });
      const res = (await r.json()).chart.result?.[0]; if (!res) continue;
      const h = ohlc(res); if (h) out.h = pack(...h);
      break;
    } catch {}
  }
  return out.d || out.h ? out : null;
}

// Coins (BTC-USD ...) come from Upbit in won when listed there; everything else (and unlisted coins) from Yahoo.
async function price(x) {
  const u = await upbit(x.s);
  if (u) { const { hist, ...q } = u; return { ...q, name: x.n || x.s }; }
  return quote(x.s, x.n);
}

async function quote(sym, name) {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=6mo&interval=1d`, { headers: { 'User-Agent': UA } });
      const res = (await r.json()).chart.result?.[0];
      if (!res) continue;
      const ts = res.timestamp, cl = res.indicators.quote[0].close, lastP = res.meta.regularMarketPrice;
      const pts = ts.map((t, i) => [t * 1000, cl[i] ?? (i === ts.length - 1 ? lastP : null)]).filter(p => p[1] != null);
      const c = pts.map(p => p[1]), last = c[c.length - 1], prev = c[c.length - 2];
      return {
        sym, name: name || res.meta.shortName || sym, cur: res.meta.currency, price: last,
        chg: prev ? (last / prev - 1) * 100 : 0, rsi: rsi(c), day: new Date(pts[pts.length - 1][0]).toISOString().slice(0, 10),
        spark: c.slice(-30).map(v => +v.toFixed(2)), _d: res
      };
    } catch {}
  }
  return null;
}

const FNG_KO = { 'extreme fear': '극도의 공포', fear: '공포', neutral: '중립', greed: '탐욕', 'extreme greed': '극도의 탐욕' };
async function fng() {
  const out = { stock: null, crypto: null };
  try {
    const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://edition.cnn.com/', Origin: 'https://edition.cnn.com' } });
    const f = (await r.json()).fear_and_greed;
    out.stock = { score: Math.round(f.score), label: FNG_KO[f.rating] || f.rating, week: Math.round(f.previous_1_week), month: Math.round(f.previous_1_month), day: f.timestamp.slice(0, 10) };
  } catch {}
  try {
    const d = (await (await fetch('https://api.alternative.me/fng/?limit=8')).json()).data;
    out.crypto = { score: +d[0].value, label: FNG_KO[d[0].value_classification.toLowerCase()] || d[0].value_classification, week: +d[7].value, day: new Date(d[0].timestamp * 1000).toISOString().slice(0, 10) };
  } catch {}
  return out;
}

const patch = (url, fields) => fetch(`${url}?${Object.keys(fields).map(f => 'updateMask.fieldPaths=' + f).join('&')}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { stringValue: v }])) })
}).then(async w => { if (!w.ok) throw new Error('write failed: ' + w.status + ' ' + (await w.text()).slice(0, 200)); });

// Latest 07:00 or 23:00 KST slot at or before now (UTC 22:00 / 14:00)
function lastSlot(now) {
  const slots = [];
  for (let d = -1; d <= 0; d++) for (const h of [14, 22]) {
    const t = new Date(now); t.setUTCDate(t.getUTCDate() + d); t.setUTCHours(h, 0, 0, 0); slots.push(t);
  }
  return slots.filter(t => t <= now).sort((a, b) => b - a)[0];
}

(async () => {
  const r = await fetch(DOC);
  if (!r.ok) throw new Error('symbol list read failed: ' + r.status);
  const f = (await r.json()).fields;
  const syms = JSON.parse(f.syms.stringValue);   // [{ s, n }]
  const market = [];
  for (let i = 0; i < syms.length; i += 6) {
    const got = await Promise.all(syms.slice(i, i + 6).map(x => price(x)));
    market.push(...got.filter(Boolean));
  }
  const sig = {};
  for (let i = 0; i < market.length; i += 6) {
    const got = await Promise.all(market.slice(i, i + 6).map(m => m.ohlc ? upStudy(m.ohlc) : study(m.sym, m._d)));
    got.forEach((g, j) => { if (g) sig[market[i + j].sym] = g; });
  }
  market.forEach(m => { delete m._d; delete m.ohlc; });
  const live = { at: new Date().toISOString(), market, fng: await fng() };
  const sigS = JSON.stringify({ at: live.at, s: sig });
  await patch(DOC, sigS.length <= 300000 ? { live: JSON.stringify(live), sig: sigS } : { live: JSON.stringify(live) });
  console.log(`ok: ${market.length}/${syms.length} quotes, study ${Object.keys(sig).length} (${sigS.length} chars), F&G stock ${live.fng.stock?.score ?? '-'} crypto ${live.fng.crypto?.score ?? '-'}`);

  // News briefing: on request from the app, or once per 07:00 / 23:00 slot
  const newsAt = [f.news, f.newsErr].filter(Boolean).map(x => JSON.parse(x.stringValue).at || '').sort().pop() || '';
  const req = f.req?.stringValue || '';
  const due = (req && req > newsAt) || newsAt < lastSlot(new Date()).toISOString() || process.env.FORCE_NEWS === '1';
  if (!due) return;
  if (!process.env.GEMINI_KEY) { console.log('news skipped: GEMINI_KEY secret is missing'); return; }
  try {
    const { news, audio } = await makeNews(process.env.GEMINI_KEY, market, live.fng);
    for (const l of ['ko', 'en']) if (audio[l]) await patch(`${DOC}/news/${l}`, { b64: audio[l] });
    await patch(DOC, { news: JSON.stringify(news), newsErr: '{}' });
    console.log(`news ok: ${news.model}, voice ko ${news.voice.ko} en ${news.voice.en}`);
  } catch (e) {
    // Record the failure so the app can say so, and so a request does not retry every 10 minutes
    await patch(DOC, { newsErr: JSON.stringify({ at: new Date().toISOString(), error: e.message.slice(0, 600) }) });
    console.log('news failed: ' + e.message);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
