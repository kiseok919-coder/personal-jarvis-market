// RSI double-bottom study signal (from a YouTube lesson attributed to Ross Cameron). FOR STUDY ONLY.
//   1. RSI(14) <= 30 and a candle closes below the lower Bollinger band (20, 2)
//      after a bearish engulfing or three red candles in a row      -> yellow "watch"
//   2. A bullish engulfing appears (first bounce)
//   3. Price pulls back to a second bottom that stays INSIDE the band
//   4. A bullish engulfing off that second bottom closes             -> blue "entry"
//      stop = second bottom low, target = 3 x the stop distance
// The short side is the mirror (RSI >= 70, upper band, double top)  -> purple.
// Input: arrays of open/high/low/close. Output: marks, signals with outcomes, and the current state.

function rsiSeries(c, n = 14) {
  const out = Array(c.length).fill(null);
  if (c.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; d > 0 ? g += d : l -= d; }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

function bands(c, n = 20, k = 2) {
  const up = Array(c.length).fill(null), mid = up.slice(), lo = up.slice();
  for (let i = n - 1; i < c.length; i++) {
    const w = c.slice(i - n + 1, i + 1), m = w.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    mid[i] = m; up[i] = m + k * sd; lo[i] = m - k * sd;
  }
  return { up, mid, lo };
}

function analyze({ o, h, l, c }) {
  const n = c.length, rsi = rsiSeries(c), { up, mid, lo } = bands(c);
  const red = i => c[i] < o[i], green = i => c[i] > o[i];
  const bullEng = i => i > 0 && green(i) && red(i - 1) && c[i] >= o[i - 1] && o[i] <= c[i - 1];
  const bearEng = i => i > 0 && red(i) && green(i - 1) && c[i] <= o[i - 1] && o[i] >= c[i - 1];
  const three = (i, f) => i >= 2 && f(i) && f(i - 1) && f(i - 2);
  const setupL = i => rsi[i] != null && lo[i] != null && rsi[i] <= 30 && c[i] < lo[i] && (bearEng(i) || three(i, red) || (red(i) && o[i] - c[i] > (h[i] - l[i]) * 0.6));
  const setupS = i => rsi[i] != null && up[i] != null && rsi[i] >= 70 && c[i] > up[i] && (bullEng(i) || three(i, green) || (green(i) && c[i] - o[i] > (h[i] - l[i]) * 0.6));

  const mark = Array(n).fill(''), sigs = [];
  // One state machine per side. phase 1 = waiting for the first engulfing, 2 = waiting for the second bottom / top.
  const side = (dir) => {
    const L = dir === 'long';
    const setup = L ? setupL : setupS, eng = L ? bullEng : bearEng, pull = L ? red : green;
    let ph = 0, s = -1, e1 = -1, ext = null, extI = -1, pulled = false;
    for (let i = 20; i < n; i++) {
      if (setup(i)) { ph = 1; s = i; mark[i] = mark[i] || 'y'; continue; }
      if (ph && i - s > 48) ph = 0;                       // too old, forget it
      if (ph === 1) { if (eng(i)) { ph = 2; e1 = i; ext = null; extI = -1; pulled = false; } continue; }
      if (ph === 2) {
        if (pull(i)) pulled = true;
        const x = L ? l[i] : h[i];
        if (ext == null || (L ? x < ext : x > ext)) { ext = x; extI = i; }
        if (eng(i) && pulled && extI > e1) {
          const inside = L ? l[extI] >= lo[extI] : h[extI] <= up[extI];
          if (inside) {
            const entry = c[i], stop = L ? Math.min(ext, l[i]) : Math.max(ext, h[i]), risk = Math.abs(entry - stop);
            if (risk > 0) {
              mark[i] = L ? 'b' : 'p';
              sigs.push({ i, side: dir, entry, stop, target: L ? entry + 3 * risk : entry - 3 * risk, s, e1, b2: extI });
              ph = 0; continue;
            }
          }
          e1 = i; ext = null; extI = -1; pulled = false;  // second bottom left the band: treat this bounce as the new first one
        }
      }
    }
    return { ph, s, e1 };
  };
  const stL = side('long'), stS = side('short');

  for (const g of sigs) {
    g.result = '진행 중';
    for (let j = g.i + 1; j < n; j++) {
      const L = g.side === 'long';
      if (L ? l[j] <= g.stop : h[j] >= g.stop) { g.result = '손절'; g.end = j; break; }
      if (L ? h[j] >= g.target : l[j] <= g.target) { g.result = '목표 도달'; g.end = j; break; }
    }
  }
  sigs.sort((a, b) => a.i - b.i);

  const r = rsi[n - 1], fresh = sigs.filter(g => g.i >= n - 2 && g.result === '진행 중').pop();
  let st;
  if (fresh?.side === 'long') st = { code: 'buy', text: '🔵 4단계 완성 — 영상 기준 매수 자리', detail: '두 번째 바닥이 밴드 안에서 버티고 상승 장악형이 나왔습니다. 영상대로라면 손절을 먼저 걸고 들어가는 자리입니다.' };
  else if (fresh?.side === 'short') st = { code: 'no', text: '⛔ 사면 안 됨 — 과열이 꺾이는 신호', detail: '쌍봉 뒤 하락 장악형이 나왔습니다(영상에선 숏 자리). 사는 쪽에겐 가장 나쁜 자리입니다.' };
  else if (stL.ph === 2) st = { code: 'wait', text: '🟡 3단계 — 첫 반등 나옴, 두 번째 바닥 기다리는 중', detail: '한 번 더 눌릴 때 밴드 안에서 버티는지, 그다음 상승 장악형이 나오는지 봅니다. 아직 사지 않습니다.' };
  else if (stL.ph === 1) st = { code: 'wait', text: '🟡 1~2단계 — 너무 팔리고 밴드 밖까지 밀림', detail: '노란 캔들 = 지켜보기 시작. 상승 장악형이 나오기 전엔 사면 안 됩니다(더 빠질 수 있음).' };
  else if (stS.ph) st = { code: 'no', text: '⛔ 추격 금지 — 과열된 뒤 꺾일 준비', detail: 'RSI 70 위 + 밴드 위로 튄 뒤입니다. 이런 데서 사면 물리기 쉽습니다.' };
  else if (r != null && r >= 70) st = { code: 'no', text: '⛔ 추격 금지 — 너무 오름(RSI 70+)', detail: '과열 구간입니다. RSI가 높다고 바로 빠지진 않지만, 새로 사기엔 가장 비싼 자리입니다.' };
  else if (r != null && r <= 30) st = { code: 'low', text: '🟠 많이 빠졌지만 아직 아님', detail: 'RSI는 30 아래인데 밴드 밖으로 마감한 캔들이 없습니다. 영상 기준 1단계도 아닙니다.' };
  else if (r != null && r >= 40 && r <= 60) st = { code: 'no', text: '⛔ 절대 아님 — RSI 50 근처, 이도 저도 아닌 구간', detail: '영상에서 "건드리지 말라"고 한 가운데 구간입니다.' };
  else st = { code: 'none', text: '⚪ 신호 없음 — 기다리기', detail: '어느 쪽으로도 끝까지 쏠리지 않았습니다.' };
  st.rsi = r == null ? null : Math.round(r);

  return { rsi, up, mid, lo, mark, sigs, st };
}

// Compact form for the app: last `keep` bars + signals that touch them.
const P = v => v == null ? null : +(+v).toPrecision(6);
function pack(t, o, h, l, c, keep = 50) {
  const a = analyze({ o, h, l, c }), n = c.length, from = Math.max(0, n - keep);
  const bars = [];
  for (let i = from; i < n; i++) bars.push([t[i], P(o[i]), P(h[i]), P(l[i]), P(c[i]), P(a.up[i]), P(a.lo[i]), a.rsi[i] == null ? null : Math.round(a.rsi[i]), a.mark[i]]);
  const sigs = a.sigs.map(g => ({ k: g.i - from, side: g.side, entry: P(g.entry), stop: P(g.stop), target: P(g.target), result: g.result, end: g.end == null ? null : g.end - from, t: t[g.i] }));
  const done = sigs.filter(g => g.result !== '진행 중'), win = done.filter(g => g.result === '목표 도달').length;
  return { bars, sigs: sigs.slice(-6), st: a.st, score: { n: done.length, win } };
}

module.exports = { analyze, pack, rsiSeries, bands };
