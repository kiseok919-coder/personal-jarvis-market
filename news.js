// AI news briefing: the robot collects today's public headlines (Google News RSS), Gemini summarises them
// with the verified prices into a short Korean + English briefing, and edge-tts turns it into Jarvis voices.
// Input is public data only (symbols, prices, RSI, Fear & Greed, headlines). It never sees holdings,
// quantities or any personal plan, and it gives no buy/sell advice.
// Gemini's built-in Google Search is not included in the free quota, so headlines are fetched here instead.
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');

// Google retires model names often; a 404 error message names the current one. Tried in order.
const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest'];
const VOICE = { ko: ['ko-KR-InJoonNeural', '-6Hz'], en: ['en-GB-RyanNeural', '-4Hz'] };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(`[news ${new Date().toISOString().slice(11, 19)}] ${m}`);

// ── Headlines: a few fixed market topics + up to 6 watchlist names, newest first, last 24 hours ──
const TOPICS = [['코스피 증시', 'ko'], ['미국 증시 뉴욕증시', 'ko'], ['반도체 엔비디아 삼성전자', 'ko'], ['환율 금리 연준', 'ko'], ['stock market today', 'en']];
const unxml = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
async function rss(q, lang) {
  const loc = lang === 'ko' ? 'hl=ko&gl=KR&ceid=KR:ko' : 'hl=en-US&gl=US&ceid=US:en';
  try {
    const x = await (await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:1d')}&${loc}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })).text();
    return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5).map(m => ({
      t: unxml((m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''),
      u: unxml((m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1] || ''),
      d: (m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || ''
    })).filter(h => h.t);
  } catch { return []; }
}
async function headlines(market) {
  const watch = market.filter(m => !m.sym.startsWith('^') && m.sym !== 'KRW=X').slice(0, 6).map(m => [m.name.replace(/\(.*\)/, '').trim() + ' 주가', 'ko']);
  const all = (await Promise.all([...TOPICS, ...watch].map(([q, l]) => rss(q, l)))).flat();
  const seen = new Set();
  return all.filter(h => !seen.has(h.t) && seen.add(h.t)).slice(0, 40);
}

function prompt(market, fng, heads, now) {
  const kst = new Date(now.getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
  const rows = market.map(m => `${m.name} (${m.sym}): ${m.price} ${m.cur || ''}, ${m.chg >= 0 ? '+' : ''}${m.chg.toFixed(2)}%, RSI ${m.rsi ?? '-'}, ${m.day}`).join('\n');
  const news = heads.map((h, i) => `[${i + 1}] ${h.t} (${h.d})`).join('\n') || '(no headlines could be fetched)';
  return `You are "Jarvis", a calm market news assistant. Current time: ${kst} KST.
Write today's market briefing from ONLY the verified prices and the headlines below.

Latest prices (verified):
${rows}
Fear & Greed: stocks ${fng.stock?.score ?? 'n/a'} (${fng.stock?.label ?? ''}), crypto ${fng.crypto?.score ?? 'n/a'}.

Today's headlines (last 24 hours, numbered):
${news}

Rules:
- Use only facts found in the prices or headlines above. Never invent numbers, dates or events. If something is unclear, say "확인 못 함".
- Pick the 3-5 most important stories. Mention watchlist instruments only when a headline is about them.
- "Coming up" lists scheduled events only if a headline mentions them.
- No buy/sell/hold advice and no personal recommendations.
- Korean must be easy enough for a middle-school student. Short sentences.
- "speech" is read aloud: about 50-60 seconds, no symbols, no bullet marks, numbers written so they read naturally.
- English speech is in a polite British butler tone and addresses the listener as "sir".
- "used" is the list of headline numbers you relied on.

Return ONLY this JSON, nothing else:
{"ko":{"title":"","summary":"2-3 sentences","sections":[{"h":"오늘 시장","body":""},{"h":"관심 종목 소식","body":""},{"h":"다음 일정","body":""}],"speech":""},
 "en":{"title":"","summary":"","sections":[{"h":"Markets today","body":""},{"h":"Watchlist news","body":""},{"h":"Coming up","body":""}],"speech":""},
 "used":[1,2]}`;
}

async function gemini(key, text) {
  const errs = [];
  for (let round = 0; round < 2; round++) {          // 503 "high demand" is usually gone within a minute
    for (const model of MODELS) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { temperature: 0.3, responseMimeType: 'application/json' } }),
          signal: AbortSignal.timeout(90000)
        });
        const j = await r.json();
        log(`${model}: ${r.status}`);
        if (!r.ok) { errs.push(`${model}: ${r.status} ${(j.error?.message || '').replace(/\s+/g, ' ')}`.slice(0, 300)); continue; }
        const out = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        return { brief: JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)), model };
      } catch (e) { errs.push(`${model}: ${e.message}`.slice(0, 200)); }
    }
    if (round === 0) await sleep(20000);
  }
  throw new Error([...new Set(errs)].join(' | ') || 'gemini failed');
}

// Ubuntu blocks system-wide pip installs, so edge-tts goes into its own small virtual env
let EDGE = null;
function edgeTts() {
  if (EDGE) return EDGE;
  const v = path.join(os.tmpdir(), 'ttsenv');
  execFileSync('python3', ['-m', 'venv', v], { stdio: 'ignore', timeout: 60000 });
  execFileSync(path.join(v, 'bin', 'pip'), ['install', '-q', 'edge-tts>=7,<8'], { stdio: 'ignore', timeout: 120000 });
  return (EDGE = path.join(v, 'bin', 'edge-tts'));
}

function tts(text, lang) {
  const [voice, pitch] = VOICE[lang], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
  const tf = path.join(dir, 't.txt'), out = path.join(dir, 'o.mp3');
  fs.writeFileSync(tf, text, 'utf8');
  for (const extra of [[`--pitch=${pitch}`], []]) {   // the voice server sometimes rejects a pitch setting
    try { execFileSync(edgeTts(), ['--voice', voice, ...extra, '-f', tf, '--write-media', out], { stdio: 'ignore', timeout: 90000 }); return fs.readFileSync(out).toString('base64'); } catch {}
  }
  return null;
}

async function makeNews(key, market, fng) {
  const now = new Date();
  const heads = await headlines(market);
  log(`headlines ${heads.length}`);
  const { brief, model } = await gemini(key, prompt(market, fng, heads, now));
  const used = (Array.isArray(brief.used) ? brief.used : []).map(n => heads[n - 1]).filter(Boolean);
  const src = (used.length ? used : heads).slice(0, 6).map(h => ({ t: h.t, u: h.u }));
  log(`text ok (${model})`);
  const audio = { ko: tts(brief.ko.speech, 'ko'), en: tts(brief.en.speech, 'en') };
  log(`voice ko ${!!audio.ko} en ${!!audio.en}`);
  return { news: { at: now.toISOString(), model, heads: heads.length, ko: brief.ko, en: brief.en, src, voice: { ko: !!audio.ko, en: !!audio.en } }, audio };
}

module.exports = { makeNews, headlines };
