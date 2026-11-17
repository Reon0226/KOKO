// 筆跡データの描画と記録。
// token: {kind:'ink', strokes:[[{x,y,t?,p?}...]...]} | {kind:'space'} | {kind:'newline'}
// x,y は 0〜1 の正規化座標。線の形は補正しない（美文字化・平滑化なし）。
// 線幅は一定の基準幅。筆圧のあるペンのときだけ記録された筆圧で太さが変わる。
const NS = 'http://www.w3.org/2000/svg';
export const INK = '#244650';
export const WIDTH = 0.036; // マス幅に対する線幅

const r4 = n => Math.round(n * 10000) / 10000;

export function hasInk(t) { return t && t.kind === 'ink' && t.strokes.some(s => s.length); }
export function cleanTokens(tokens) {
  // 送信用: 空のマスを除き、お手本などの付属情報を持たない純粋な token だけにする
  const out = [];
  for (const t of tokens) {
    if (t.kind === 'ink') {
      const strokes = t.strokes.filter(s => s.length).map(s => s.map(p => {
        const q = { x: p.x, y: p.y };
        if (Number.isInteger(p.t)) q.t = p.t;
        if (typeof p.p === 'number') q.p = p.p;
        return q;
      }));
      if (strokes.length) out.push({ kind: 'ink', strokes });
    } else if (t.kind === 'space' || t.kind === 'newline') out.push({ kind: t.kind });
  }
  // 末尾の空白・改行は相手の画面でも意味があるので残す
  return out;
}

const widthAt = (p, base) => (typeof p.p === 'number' ? base * (0.55 + 0.9 * p.p) : base);

export function inkSvg(token, label) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 100 100');
  s.setAttribute('aria-hidden', 'true');
  if (label) { s.setAttribute('role', 'img'); s.setAttribute('aria-label', label); s.removeAttribute('aria-hidden'); }
  const base = WIDTH * 100;
  for (const stroke of token.strokes) {
    if (!stroke.length) continue;
    const pressured = stroke.some(p => typeof p.p === 'number');
    if (stroke.length === 1) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', (stroke[0].x * 100).toFixed(2)); c.setAttribute('cy', (stroke[0].y * 100).toFixed(2));
      c.setAttribute('r', (widthAt(stroke[0], base) / 2).toFixed(2)); c.setAttribute('fill', INK);
      s.append(c); continue;
    }
    if (!pressured) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', stroke.map((pt, i) => (i ? 'L' : 'M') + (pt.x * 100).toFixed(2) + ',' + (pt.y * 100).toFixed(2)).join(''));
      setStroke(p, base); s.append(p);
    } else {
      for (let i = 1; i < stroke.length; i++) {
        const a = stroke[i - 1], b = stroke[i];
        const l = document.createElementNS(NS, 'line');
        l.setAttribute('x1', (a.x * 100).toFixed(2)); l.setAttribute('y1', (a.y * 100).toFixed(2));
        l.setAttribute('x2', (b.x * 100).toFixed(2)); l.setAttribute('y2', (b.y * 100).toFixed(2));
        setStroke(l, (widthAt(a, base) + widthAt(b, base)) / 2); s.append(l);
      }
    }
  }
  return s;
}
function setStroke(el, w) {
  el.setAttribute('fill', 'none'); el.setAttribute('stroke', INK); el.setAttribute('stroke-width', w.toFixed(2));
  el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
}

// 文章として並べる（チャット吹き出し・下書き）
export function renderFlow(el, tokens, { onTap, cursor = -1, label } = {}) {
  el.replaceChildren();
  tokens.forEach((t, i) => {
    let node;
    if (t.kind === 'ink') { node = document.createElement('span'); node.className = 'glyph'; node.append(inkSvg(t)); }
    else if (t.kind === 'space') { node = document.createElement('span'); node.className = 'sp'; }
    else { node = document.createElement('span'); node.className = 'br'; }
    if (i === cursor) node.classList.add('at');
    if (onTap) { node.dataset.i = i; node.addEventListener('click', () => onTap(i)); }
    el.append(node);
  });
  if (label) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', label); }
}

export function drawToken(canvas, token) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!token || token.kind !== 'ink') return;
  for (const s of token.strokes) drawStroke(ctx, s, w, h, 0);
}
// from: 何点目から描くか（書いている最中は差分だけ描いて遅延を減らす）
export function drawStroke(ctx, s, w, h, from) {
  if (!s.length) return;
  const base = WIDTH * w;
  ctx.strokeStyle = INK; ctx.fillStyle = INK; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (s.length === 1) {
    ctx.beginPath(); ctx.arc(s[0].x * w, s[0].y * h, widthAt(s[0], base) / 2, 0, Math.PI * 2); ctx.fill(); return;
  }
  for (let i = Math.max(1, from); i < s.length; i++) {
    const a = s[i - 1], b = s[i];
    ctx.lineWidth = (widthAt(a, base) + widthAt(b, base)) / 2;
    ctx.beginPath(); ctx.moveTo(a.x * w, a.y * h); ctx.lineTo(b.x * w, b.y * h); ctx.stroke();
  }
}

// ポインターの位置を正規化。線がマスの外に出ても 0〜1 に収める（マス外は記録しない）
export function makePoint(canvas, e, t0, usePressure) {
  const r = canvas.getBoundingClientRect();
  const pt = {
    x: r4(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))),
    y: r4(Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))),
    t: Math.max(0, Math.round(e.timeStamp - t0)),
  };
  if (usePressure && e.pressure > 0) pt.p = Math.round(e.pressure * 100) / 100;
  return pt;
}
// 同じ位置に重なった点だけを間引く（形は変えない）
export function farEnough(a, b) { return !a || Math.hypot(a.x - b.x, a.y - b.y) >= 0.003; }
