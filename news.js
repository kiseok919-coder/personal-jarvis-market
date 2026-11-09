// AI news briefing: Gemini (with Google Search) writes a short Korean + English market briefing,
// edge-tts turns it into Jarvis voices. Input is public market data only (symbols, prices, RSI, Fear & Greed).
// It never sees holdings, quantities or any personal plan, and it gives no buy/sell advice.
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');

// Google retires model names often; the error message names the current one. Tried in order.
const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];
const VOICE = { ko: ['ko-KR-InJoonNeural', '-6Hz'], en: ['en-GB-RyanNeural', '-4Hz'] };

function prompt(market, fng, now) {
  const kst = new Date(now.getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
  const rows = market.map(m => `${m.name} (${m.sym}): ${m.price} ${m.cur || ''}, ${m.chg >= 0 ? '+' : ''}${m.chg.toFixed(2)}%, RSI ${m.rsi ?? '-'}, ${m.day}`).join('\n');
  return `You are "Jarvis", a calm market news assistant. Current time: ${kst} KST.
Use Google Search to find TODAY's most important market news (Korea and US stocks, semiconductors/AI, rates, FX, crypto) and news about the instruments below.

Latest prices (already verified):
${rows}
Fear & Greed: stocks ${fng.stock?.score ?? 'n/a'} (${fng.stock?.label ?? ''}), crypto ${fng.crypto?.score ?? 'n/a'}.

Rules:
- Facts only, from search results or the prices above. If you could not confirm a number, say so ("확인 못 함"). Never invent numbers.
- No buy/sell/hold advice and no personal recommendations. Describe what happened and what is scheduled next.
- Korean must be easy enough for a middle-school student. Short sentences.
- "speech" is read aloud: about 50-60 seconds, no symbols, no bullet marks, numbers written so they read naturally.
- English speech is in a polite British butler tone and addresses the listener as "sir".

Return ONLY this JSON, nothing else:
{"ko":{"title":"","summary":"2-3 sentences","sections":[{"h":"오늘 시장","body":""},{"h":"관심 종목 소식","body":""},{"h":"다음 일정","body":""}],"speech":""},
 "en":{"title":"","summary":"","sections":[{"h":"Markets today","body":""},{"h":"Watchlist news","body":""},{"h":"Coming up","body":""}],"speech":""}}`;
}

const NO_SEARCH = '\n\nSearch is unavailable: describe ONLY the prices above, and say in the first section that news search was unavailable this time.';
async function gemini(key, text) {
  const errs = [];
  // First with Google Search (real news). If the free quota refuses search, fall back to prices only.
  for (const [model, search] of [...MODELS.map(m => [m, true]), ...MODELS.slice(0, 2).map(m => [m, false])]) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: search ? text : text + NO_SEARCH }] }], ...(search ? { tools: [{ google_search: {} }] } : {}), generationConfig: { temperature: 0.3 } })
      });
      const j = await r.json();
      if (!r.ok) { errs.push(`${model}${search ? '+search' : ''}: ${r.status} ${(j.error?.message || '').replace(/\s+/g, ' ')}`.slice(0, 400)); continue; }
      const c = j.candidates?.[0], out = (c?.content?.parts || []).map(p => p.text || '').join('');
      const s = out.indexOf('{'), e = out.lastIndexOf('}');
      const brief = JSON.parse(out.slice(s, e + 1));
      const src = (c.groundingMetadata?.groundingChunks || []).map(g => g.web).filter(Boolean).slice(0, 6).map(w => ({ t: w.title, u: w.uri }));
      return { brief, src, model: model + (search ? '+search' : '') };
    } catch (e) { errs.push(`${model}: ${e.message}`.slice(0, 160)); }
  }
  throw new Error(errs.join(' | ') || 'gemini failed');
}

// Ubuntu blocks system-wide pip installs, so edge-tts goes into its own small virtual env
let EDGE = null;
function edgeTts() {
  if (EDGE) return EDGE;
  const v = path.join(os.tmpdir(), 'ttsenv');
  execFileSync('python3', ['-m', 'venv', v], { stdio: 'ignore' });
  execFileSync(path.join(v, 'bin', 'pip'), ['install', '-q', 'edge-tts>=7,<8'], { stdio: 'ignore' });
  return (EDGE = path.join(v, 'bin', 'edge-tts'));
}

function tts(text, lang) {
  const [voice, pitch] = VOICE[lang], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
  const tf = path.join(dir, 't.txt'), out = path.join(dir, 'o.mp3');
  fs.writeFileSync(tf, text, 'utf8');
  for (const extra of [[`--pitch=${pitch}`], []]) {   // the voice server sometimes rejects a pitch setting
    try { execFileSync(edgeTts(), ['--voice', voice, ...extra, '-f', tf, '--write-media', out], { stdio: 'ignore' }); return fs.readFileSync(out).toString('base64'); } catch {}
  }
  return null;
}

async function makeNews(key, market, fng) {
  const now = new Date();
  const { brief, src, model } = await gemini(key, prompt(market, fng, now));
  const audio = { ko: tts(brief.ko.speech, 'ko'), en: tts(brief.en.speech, 'en') };
  return { news: { at: now.toISOString(), model, ko: brief.ko, en: brief.en, src, voice: { ko: !!audio.ko, en: !!audio.en } }, audio };
}

module.exports = { makeNews };
