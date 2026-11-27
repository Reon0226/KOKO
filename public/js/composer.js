// 手書きマス（キーボードの代わり）。
// 方針:
// - 1マス1文字。文字の確定はタイマーで決めない。画の途中でマスが動いたり確定したりしない。
// - マスの移動は本人の操作（別のマスに書き始める／‹ ›／下書きの文字をタップ）だけ。
// - 戻す（↶）は直前の操作を1つずつ取り消す（1画・削除・空白・改行）。他の文字は壊さない。
// - お手本と読み取り結果は表示だけ。tokens には入らない。
import { hasInk, cleanTokens, renderFlow, drawToken, drawStroke, makePoint, farEnough } from './ink.js';
import { DEFAULTS, searchGuides, suggestFromRecognized } from './guides.js';

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
};

export class Composer {
  constructor(root, { settings, onChange, onSend, recognizer }) {
    this.root = root;
    this.settings = settings;          // () => {cells, hand, guideMode, guideVisible}
    this.onChange = onChange;          // (draft) => void
    this.onSend = onSend;              // ({tokens, altText, composeMs}) => Promise<boolean>
    this.recognizer = recognizer || { available: false };
    this.tokens = []; this.cursor = 0; this.startedAt = null; this.alt = '';
    this.undoStack = []; this.guide = null; this.drawing = null; this.zoom = false;
    this.penSeen = false; this.recog = new WeakMap(); this.recogTimer = null; this.query = '';
    this.layoutKey = '';
    this.build();
  }

  // ---------- 外部 API ----------
  load(draft) {
    this.tokens = Array.isArray(draft?.tokens) ? draft.tokens.filter(t => t && (t.kind !== 'ink' || hasInk(t))) : [];
    this.cursor = Math.min(this.tokens.length, Math.max(0, draft?.cursor ?? this.tokens.length));
    this.startedAt = draft?.startedAt || null;
    this.alt = draft?.alt || '';
    this.altInput.value = this.alt; this.altInput.hidden = !this.alt;
    this.undoStack = []; this.guide = null; this.layoutKey = '';
    this.render();
  }
  draft() { return { tokens: this.tokens, cursor: this.cursor, startedAt: this.startedAt, alt: this.alt }; }
  setRecognizer(r) { this.recognizer = r; this.updateCandidates(); }
  setDisabled(reason) {
    this.disabledReason = reason || null;
    this.root.classList.toggle('locked', !!reason);
    this.lockNote.textContent = reason || '';
    this.lockNote.hidden = !reason;
    this.updateButtons();
  }
  relayout() { this.layoutKey = ''; this.render(); }
  // キーボードを閉じるのと同じように、会話を読むときはマスをしまえる（下書きはそのまま）
  setCollapsed(on) {
    if (this.drawing) return;
    this.collapsed = !!on;
    this.root.classList.toggle('collapsed', this.collapsed);
    if (!on) this.relayout();
    this.onLayout?.();
  }

  // ---------- 組み立て ----------
  build() {
    const r = this.root;
    r.classList.add('composer');
    this.draftEl = h('div', { class: 'draft', 'aria-label': '下書き（タップでその字へ移動）' });
    this.readout = h('span', { class: 'readout', hidden: '' });
    this.cands = h('div', { class: 'cands', role: 'group', 'aria-label': 'お手本の候補（押しても本文には入りません）' });
    this.searchBtn = h('button', { class: 'icon', type: 'button', 'aria-label': 'お手本を読みで探す', 'aria-expanded': 'false', onclick: () => this.toggleSearch() }, '🔍');
    this.guideToggle = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'true', title: 'お手本の表示を切り替え', onclick: () => this.toggleGuideVisible() }, '見本');
    this.cellBtns = {};
    this.cellsSeg = h('div', { class: 'seg cellseg', role: 'radiogroup', 'aria-label': '1行のマスの数' }, h('span', { class: 'cellseg-label', text: 'マス' }));
    for (const v of [2, 3]) {
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': `${v}マス`, onclick: () => this.setCells(v) }, String(v));
      this.cellBtns[v] = b; this.cellsSeg.append(b);
    }
    const bar = h('div', { class: 'guidebar' }, this.readout, this.cands, this.searchBtn, this.cellsSeg, this.guideToggle);
    this.searchInput = h('input', { type: 'search', class: 'search', placeholder: 'お手本を読みで探す（例：きもち）', 'aria-label': 'お手本を読みで探す', enterkeyhint: 'search' });
    this.searchInput.addEventListener('input', () => { this.query = this.searchInput.value; this.updateCandidates(); });
    this.searchRow = h('div', { class: 'searchrow', hidden: '' }, this.searchInput);
    this.modelText = h('span', { class: 'model-text' });
    this.model = h('div', { class: 'model', hidden: '' }, h('span', { class: 'model-label', text: 'お手本' }), this.modelText,
      h('button', { class: 'icon small', type: 'button', 'aria-label': 'お手本を閉じる', onclick: () => { this.guide = null; this.render(); } }, '✕'));
    this.cellsEl = h('div', { class: 'cells' });
    this.prevBtn = h('button', { class: 'pg', type: 'button', 'aria-label': '前の字へ', onclick: () => this.move(-1) }, '‹');
    this.nextBtn = h('button', { class: 'pg', type: 'button', 'aria-label': '次の字へ', onclick: () => this.move(1) }, '›');
    const pad = h('div', { class: 'pad' }, this.prevBtn, this.cellsEl, this.nextBtn);
    const tool = (cls, icon, label, fn) => h('button', { class: 'tool ' + cls, type: 'button', 'aria-label': label, onclick: fn }, h('span', { class: 'ti', 'aria-hidden': 'true', text: icon }), h('small', { text: label }));
    this.undoBtn = tool('undo', '↶', '戻す', () => this.undo());
    this.delBtn = tool('del', '⌫', '削除', () => this.del());
    this.spaceBtn = tool('space', '␣', '空白', () => this.insert('space'));
    this.nlBtn = tool('nl', '↵', '改行', () => this.insert('newline'));
    this.zoomBtn = tool('zoom', '⤢', '大きく', () => { this.zoom = !this.zoom; this.zoomBtn.setAttribute('aria-pressed', String(this.zoom)); this.relayout(); });
    this.sendBtn = h('button', { class: 'tool primary send', type: 'button', onclick: () => this.send() }, h('span', { class: 'ti', text: '↑' }), h('small', { text: '送る' }));
    this.tools = h('div', { class: 'tools' }, this.undoBtn, this.delBtn, this.spaceBtn, this.nlBtn, this.zoomBtn, this.sendBtn);
    this.altInput = h('input', { class: 'alt', type: 'text', maxlength: '500', placeholder: '読み上げ用のテキスト（任意・筆跡と一緒に届きます）', 'aria-label': '読み上げ用のテキスト（任意）', hidden: '' });
    this.altInput.addEventListener('input', () => { this.alt = this.altInput.value; this.changed(); });
    this.altBtn = h('button', { class: 'link', type: 'button', onclick: () => { this.altInput.hidden = !this.altInput.hidden; if (!this.altInput.hidden) this.altInput.focus(); } }, '＋ 読み上げ用テキスト');
    this.hint = h('div', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    this.lockNote = h('div', { class: 'locknote', hidden: '' });
    this.expandBtn = h('button', { class: 'expand', type: 'button', onclick: () => this.setCollapsed(false) }, '✎ マスを出して書く');
    r.append(this.expandBtn, this.draftEl, bar, this.searchRow, this.model, pad, this.tools, h('div', { class: 'altrow' }, this.altBtn, this.altInput), this.hint, this.lockNote);
    // 書いている間に画面がスクロール・拡大しないように
    pad.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    pad.addEventListener('contextmenu', e => e.preventDefault());
    new ResizeObserver(() => { if (!this.drawing) this.relayout(); }).observe(pad);
  }

  // ---------- 表示 ----------
  N() { return this.zoom ? 1 : Math.max(1, Math.min(4, Number(this.settings().cells) || 3)); }
  base() { const n = this.N(); return Math.floor(this.cursor / n) * n; }

  render() {
    if (this.drawing) return;
    const s = this.settings();
    this.root.classList.toggle('lefty', s.hand === 'left');
    this.renderDraft();
    this.renderCells();
    this.renderModel();
    this.updateButtons();
    this.updateCandidates();
  }

  renderDraft() {
    if (!this.tokens.length) {
      this.draftEl.replaceChildren(); // 空のときも欄は残す（消すと書き始めにマスが動いて、線の位置がずれる）
      return;
    }
    renderFlow(this.draftEl, this.tokens, { cursor: this.cursor, onTap: i => { if (!this.drawing) { this.cursor = i; if (this.collapsed) this.setCollapsed(false); this.render(); } } });
    if (this.cursor === this.tokens.length) this.draftEl.append(h('span', { class: 'caret', 'aria-hidden': 'true' }));
    const at = this.draftEl.querySelector('.at, .caret');
    at?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  renderCells() {
    const n = this.N(), base = this.base();
    // 横幅から決まる大きさ: 矢印の実際の幅と、CSS の gap を読んで、空きをむだにしない
    const pad = this.cellsEl.parentElement;
    const gap = parseFloat(getComputedStyle(this.cellsEl).columnGap) || 8;
    const padGap = parseFloat(getComputedStyle(pad).columnGap) || 4;
    const wrapped = getComputedStyle(pad).flexWrap === 'wrap'; // 矢印がマスの下の行にあるとき
    const padW = wrapped ? pad.clientWidth : pad.clientWidth - (this.prevBtn.offsetWidth || 30) - (this.nextBtn.offsetWidth || 30) - 2 * padGap;
    const maxCell = Math.floor(window.innerHeight * (this.zoom ? 0.46 : 0.31)); // 縦の上限（以前は 0.40 / 0.24）
    const size = Math.max(64, Math.min(Math.floor((padW - gap * (n - 1)) / n), maxCell, this.zoom ? 480 : 340)); // 通常は最大 340px（以前は 260）。⤢ のときは横幅いっぱいまで
    const key = [n, base, size].join(':');
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.cellsEl.style.gridTemplateColumns = `repeat(${n}, ${size}px)`;
      this.cellsEl.replaceChildren();
      this.cells = [];
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      for (let k = 0; k < n; k++) {
        const i = base + k;
        const canvas = h('canvas', { width: String(Math.round(size * dpr)), height: String(Math.round(size * dpr)) });
        const target = h('span', { class: 'target', 'aria-hidden': 'true' });
        const mark = h('span', { class: 'mark', 'aria-hidden': 'true' });
        const cell = h('div', { class: 'cell', role: 'img' }, target, mark, canvas);
        cell.style.width = cell.style.height = size + 'px';
        target.style.fontSize = Math.round(size * 0.72) + 'px';
        this.bindCanvas(canvas, i);
        this.cellsEl.append(cell);
        this.cells.push({ cell, canvas, target, mark, i });
      }
    }
    this.updateCells();
  }

  updateCells() {
    const s = this.settings();
    const len = this.tokens.length;
    const gchars = this.guide ? Array.from(this.guide.text) : [];
    for (const c of this.cells || []) {
      const t = this.tokens[c.i];
      c.cell.classList.toggle('active', c.i === this.cursor);
      c.cell.classList.toggle('next', c.i === len && c.i !== this.cursor);
      c.cell.classList.toggle('off', c.i > len);
      c.cell.setAttribute('aria-label', `${c.i + 1}文字目のマス${t ? (t.kind === 'ink' ? '（書いてあります）' : t.kind === 'space' ? '（空白）' : '（改行）') : c.i === len ? '（ここに書けます）' : ''}`);
      c.mark.textContent = t?.kind === 'space' ? '空白' : t?.kind === 'newline' ? '改行' : '';
      const gi = this.guideIndex(c.i);
      c.target.textContent = (s.guideVisible && s.guideMode === 'cell' && gi >= 0 && gi < gchars.length && (!t || t.kind === 'ink')) ? gchars[gi] : '';
      drawToken(c.canvas, t);
    }
  }

  // お手本の何文字目がマス i に当たるか（空白・改行のマスは飛ばす）
  guideIndex(i) {
    if (!this.guide || i < this.guide.start) return -1;
    const t = this.tokens[i];
    if (t && t.kind !== 'ink') return -1;
    let k = 0;
    for (let j = this.guide.start; j < i; j++) { const u = this.tokens[j]; if (!u || u.kind === 'ink') k++; }
    return k;
  }

  renderModel() {
    const s = this.settings();
    const show = !!this.guide && s.guideVisible;
    this.model.hidden = !show;
    if (!show) return;
    this.modelText.replaceChildren();
    Array.from(this.guide.text).forEach((ch, k) => {
      const span = h('span', { text: ch });
      if (this.guideIndex(this.cursor) === k) span.className = 'now';
      this.modelText.append(span);
    });
  }

  updateButtons() {
    const len = this.tokens.length;
    const locked = !!this.disabledReason;
    this.prevBtn.disabled = this.cursor === 0;
    this.nextBtn.disabled = this.cursor >= len;
    // 最後のマスまで書いたら › を目立たせる（勝手には動かさない）
    const n = this.N();
    this.nextBtn.classList.toggle('nudge', this.cursor === len - 1 && (this.cursor % n) === n - 1);
    this.undoBtn.disabled = !this.undoStack.length;
    this.delBtn.disabled = !len;
    this.sendBtn.disabled = locked || !this.tokens.some(hasInk);
    this.guideToggle.setAttribute('aria-pressed', String(!!this.settings().guideVisible));
    this.guideToggle.textContent = this.settings().guideVisible ? '見本 ON' : '見本 OFF';
    const cur = Number(this.settings().cells) || 3;
    for (const [v, b] of Object.entries(this.cellBtns)) { const on = Number(v) === cur; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
  }

  say(text, action) {
    this.hint.style.visibility = '';
    this.hint.replaceChildren(text);
    if (action) this.hint.append(' ', h('button', { class: 'link', type: 'button', onclick: () => { action.fn(); } }, action.label));
  }

  changed() {
    if (!this.startedAt && this.tokens.length) this.startedAt = Date.now();
    if (!this.tokens.length && !this.alt) this.startedAt = null;
    this.onChange?.(this.draft());
  }

  // ---------- 書く ----------
  bindCanvas(canvas, i) {
    canvas.addEventListener('pointerdown', e => this.down(e, canvas, i));
    canvas.addEventListener('pointermove', e => this.moveDraw(e));
    const end = e => this.up(e);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('lostpointercapture', end);
  }

  down(e, canvas, i) {
    if (this.drawing || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.pointerType === 'pen') this.penSeen = true;
    if (e.pointerType === 'touch' && this.penSeen) return; // ペン使用中は手のひらの接触を無視
    const len = this.tokens.length;
    if (i > len) { this.cursor = len; this.render(); this.say('このマスにはまだ書けません。光っているマスから書いてね。'); return; }
    const t = this.tokens[i];
    if (t && t.kind !== 'ink') { this.cursor = i; this.render(); this.say('空白／改行のマスです。⌫ で消すと書けます。'); return; }
    e.preventDefault();
    let created = false;
    if (i === len) { this.tokens.push({ kind: 'ink', strokes: [] }); created = true; }
    this.cursor = i;
    const stroke = [];
    this.tokens[i].strokes.push(stroke);
    const usePressure = e.pointerType === 'pen';
    stroke.push(makePoint(canvas, e, e.timeStamp, usePressure));
    this.undoStack.push({ type: 'stroke', index: i, created });
    if (this.undoStack.length > 300) this.undoStack.shift();
    const ctx = canvas.getContext('2d');
    this.drawing = { id: e.pointerId, canvas, ctx, stroke, i, t0: e.timeStamp, usePressure, drawn: 0 };
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    for (const c of this.cells) { c.cell.classList.toggle('active', c.i === i); c.cell.classList.remove('next'); }
    drawStroke(ctx, stroke, canvas.width, canvas.height, 0);
    // ヒントの行は消さない（消すとマスが上にずれて、書き始めの線の位置が狂う）。場所は残して見えなくするだけ
    this.hint.style.visibility = 'hidden';
  }

  moveDraw(e) {
    const d = this.drawing;
    if (!d || d.id !== e.pointerId) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const before = d.stroke.length;
    for (const ev of (evs.length ? evs : [e])) {
      const pt = makePoint(d.canvas, ev, d.t0, d.usePressure);
      if (farEnough(d.stroke[d.stroke.length - 1], pt)) d.stroke.push(pt);
    }
    if (d.stroke.length > before) drawStroke(d.ctx, d.stroke, d.canvas.width, d.canvas.height, before);
  }

  up(e) {
    const d = this.drawing;
    if (!d || d.id !== e.pointerId) return;
    if (e.type === 'pointerup') {
      const pt = makePoint(d.canvas, e, d.t0, d.usePressure);
      if (farEnough(d.stroke[d.stroke.length - 1], pt)) d.stroke.push(pt);
    }
    this.drawing = null;
    this.changed();
    this.renderDraft(); this.updateCells(); this.renderModel(); this.updateButtons();
    this.scheduleRecognition(d.i);
  }

  // ---------- 操作 ----------
  move(dir) {
    if (this.drawing) return;
    this.cursor = Math.max(0, Math.min(this.tokens.length, this.cursor + dir));
    this.render();
  }

  del() {
    if (this.drawing || !this.tokens.length) return;
    const len = this.tokens.length;
    const idx = this.cursor >= len ? len - 1 : this.cursor;
    const [token] = this.tokens.splice(idx, 1);
    this.undoStack.push({ type: 'delete', index: idx, token, cursorBefore: this.cursor });
    this.cursor = Math.min(idx, this.tokens.length);
    this.changed(); this.render();
    this.say(token.kind === 'ink' ? '1字消しました。' : (token.kind === 'space' ? '空白を消しました。' : '改行を消しました。'), { label: '↶ 戻す', fn: () => this.undo() });
  }

  insert(kind) {
    if (this.drawing) return;
    const len = this.tokens.length;
    const at = this.cursor < len ? this.cursor + 1 : len;
    this.tokens.splice(at, 0, { kind });
    this.undoStack.push({ type: 'insert', index: at, cursorBefore: this.cursor });
    this.cursor = at + 1;
    if (this.guide && this.guide.start >= at) this.guide.start++;
    this.changed(); this.render();
  }

  undo() {
    if (this.drawing) return;
    const op = this.undoStack.pop();
    if (!op) return;
    if (op.type === 'stroke') {
      const t = this.tokens[op.index];
      t?.strokes?.pop();
      if (op.created && t && !t.strokes.length) this.tokens.splice(op.index, 1);
      this.cursor = Math.min(op.index, this.tokens.length);
      this.say('1画戻しました。');
    } else if (op.type === 'delete') {
      this.tokens.splice(op.index, 0, op.token); this.cursor = op.cursorBefore; this.say('消した字を戻しました。');
    } else if (op.type === 'deleteRange') {
      this.tokens.splice(op.index, 0, ...op.tokens); this.cursor = op.cursorBefore; this.guide = op.guideBefore; this.say('書いた字を戻しました。');
    } else if (op.type === 'insert') {
      this.tokens.splice(op.index, 1); this.cursor = op.cursorBefore; this.say('取り消しました。');
    }
    this.changed(); this.render();
  }

  async send() {
    if (this.drawing || this.disabledReason) return;
    const tokens = cleanTokens(this.tokens);
    if (!tokens.some(hasInk)) { this.say('手書きの文字を1つ以上書いてね。'); return; }
    const altText = this.alt.trim() || null;
    const composeMs = this.startedAt ? Math.min(6 * 3600 * 1000, Math.max(0, Date.now() - this.startedAt)) : null;
    const ok = await this.onSend({ tokens, altText, composeMs });
    if (!ok) return; // 送信キューに入れられなかった（下書きはそのまま）
    this.tokens = []; this.cursor = 0; this.undoStack = []; this.guide = null; this.alt = '';
    this.altInput.value = ''; this.altInput.hidden = true; this.startedAt = null;
    this.searchInput.value = ''; this.query = ''; this.searchRow.hidden = true;
    this.changed(); this.layoutKey = ''; this.render();
    this.hint.textContent = '';
  }

  // ---------- お手本 ----------
  toggleSearch() {
    this.searchRow.hidden = !this.searchRow.hidden;
    this.searchBtn.setAttribute('aria-expanded', String(!this.searchRow.hidden));
    if (!this.searchRow.hidden) this.searchInput.focus();
    else { this.query = ''; this.searchInput.value = ''; this.updateCandidates(); }
  }
  setCells(v) {
    if (this.drawing) return; // 書いている最中は動かさない（マスが動くと線がずれる）
    const s = this.settings();
    if (Number(s.cells) === v) return;
    s.cells = v;
    this.onSettings?.(s);
    this.relayout();
  }
  toggleGuideVisible() {
    const s = this.settings();
    s.guideVisible = !s.guideVisible;
    this.onSettings?.(s);
    this.render();
  }

  recognizedRun() {
    // 直前の連続した文字（空白・改行で区切る）の読み取り結果をつなげる
    const end = this.cursor < this.tokens.length && hasInk(this.tokens[this.cursor]) ? this.cursor : this.cursor - 1;
    let text = '', count = 0;
    for (let i = end; i >= 0 && count < 8; i--) {
      const t = this.tokens[i];
      if (!t || t.kind !== 'ink') break;
      const r = this.recog.get(t);
      if (!r || r.n !== t.strokes.length || !r.texts[0]) break;
      text = r.texts[0] + text; count++;
    }
    return { text, end, count };
  }

  updateCandidates() {
    let words, fromRecog = null;
    const run = this.recognizer.available ? this.recognizedRun() : { text: '' };
    if (this.query.trim()) words = searchGuides(this.query).map(w => ({ word: w, span: 0 }));
    else if (run.text) { fromRecog = run; words = suggestFromRecognized(run.text); if (!words.length) words = DEFAULTS.map(w => ({ word: w, span: 0 })); }
    else words = DEFAULTS.map(w => ({ word: w, span: 0 }));
    this.readout.hidden = !fromRecog;
    this.readout.textContent = fromRecog ? `読み取り：${fromRecog.text}` : '';
    this.readout.title = '端末内の読み取り結果（参考）。送信はされません。';
    this.cands.replaceChildren();
    if (!words.length) { this.cands.append(h('span', { class: 'none', text: '辞書にありません。そのまま書いてOK' })); return; }
    for (const c of words) {
      const b = h('button', { type: 'button', class: 'cand' + (this.guide?.text === c.word ? ' on' : '') }, c.word);
      b.addEventListener('click', () => this.chooseGuide(c, fromRecog));
      this.cands.append(b);
    }
  }

  chooseGuide(c, run) {
    if (this.drawing) return;
    const len = this.tokens.length;
    const start = this.cursor < len && hasInk(this.tokens[this.cursor]) ? this.cursor + 1 : this.cursor;
    this.guide = { text: c.word, start };
    if (start > this.cursor) this.cursor = Math.min(start, len);
    this.render();
    if (run && c.span > 0 && run.end >= 0) {
      const from = run.end - c.span + 1;
      this.say(`「${c.word}」を見ながら、自分の字で書いてね。`, {
        label: `書いた${c.span}字を消してここに書く`,
        fn: () => this.replaceRun(from, c.span),
      });
    } else this.say(`「${c.word}」を見ながら、自分の字で書いてね。本文には入りません。`);
  }

  replaceRun(from, count) {
    if (this.drawing) return;
    const guideBefore = this.guide ? { ...this.guide } : null;
    const removed = this.tokens.splice(from, count);
    this.undoStack.push({ type: 'deleteRange', index: from, tokens: removed, cursorBefore: this.cursor, guideBefore });
    this.cursor = from;
    if (this.guide) this.guide.start = from;
    this.changed(); this.render();
    this.say(`${count}字を消しました。お手本の上に書いてね。`, { label: '↶ 戻す', fn: () => this.undo() });
  }

  scheduleRecognition(i) {
    if (!this.recognizer.available || !this.settings().recognition) return;
    clearTimeout(this.recogTimer);
    // 読み取りは候補を出すためだけ。文字の確定とは無関係なので待ち時間で判断しても線は変わらない
    this.recogTimer = setTimeout(async () => {
      const t = this.tokens[i];
      if (!t || t.kind !== 'ink' || !t.strokes.length) return;
      const n = t.strokes.length;
      try {
        const texts = await this.recognizer.recognize(t.strokes, '');
        this.recog.set(t, { n, texts });
        if (!this.drawing) this.updateCandidates();
      } catch { /* 認識に失敗しても線はそのまま */ }
    }, 450);
  }
}