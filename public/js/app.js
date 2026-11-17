import { api, ApiError, Live } from './api.js';
import { store } from './store.js';
import { Composer } from './composer.js';
import { renderFlow } from './ink.js';
import { createRecognizer } from './recognizer.js';

// ---------- ホーム画面に追加 ----------
// Android / PC の Chrome・Edge: ブラウザが出す beforeinstallprompt を取っておき、ボタンで確認を出す。
// iPhone の Safari: プログラムからは追加できないので、手順を案内する。
let installEvt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
window.addEventListener('appinstalled', () => { installEvt = null; document.getElementById('st-install')?.remove(); });

const $ = id => document.getElementById(id);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.filter(k => k !== null && k !== undefined));
  return el;
};
const BUILD = 'KOKO web MVP · payload v1';

// ---------- 状態 ----------
const S = {
  me: null, convs: new Map(), msgs: new Map(), more: new Map(), current: null,
  outbox: [], seen: {}, settings: store.settings(), live: null, recognizer: { available: false, reason: '確認中…' },
  composer: null, rendered: new Set(), fresh: new Set(), sending: false, retryTimer: null, retryDelay: 2000, acked: new Set(), ackQueue: new Map(), ackTimer: null,
  conn: 'idle',
};

// ---------- 小さな UI 部品 ----------
let toastTimer;
function toast(text, ms = 3200) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  document.body.dataset.screen = id;
}
// 確認用のシート。confirm() の代わり（画面を止めない）
function sheet({ title, body, actions, input }) {
  const dlg = $('sheet'), form = $('sheet-form');
  form.replaceChildren();
  form.append(h('h3', { text: title }));
  for (const b of [].concat(body || [])) form.append(typeof b === 'string' ? h('p', { text: b }) : b);
  let inp = null;
  if (input) { inp = h('input', { placeholder: input.placeholder || '', 'aria-label': input.label || title, value: input.value || '', readonly: input.readonly }); form.append(inp); }
  const row = h('div', { class: 'row end' });
  for (const a of actions) row.append(h('button', { value: a.value, class: a.class || '', type: a.type || 'submit', onclick: a.onclick }, a.label));
  form.append(row);
  return new Promise(resolve => {
    dlg.onclose = () => resolve({ value: dlg.returnValue || null, input: inp?.value ?? null });
    dlg.returnValue = '';
    dlg.showModal();
    if (inp && !input.readonly) inp.focus();
  });
}
function rid() {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const timeText = ts => {
  const d = new Date(ts), n = new Date();
  const hm = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
const partnerName = c => c?.partner?.name || '退会したユーザー';

// ---------- 起動 ----------
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const m = /[#&]invite=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) { store.setPendingInvite(m[1]); history.replaceState(null, '', location.pathname); }
  $('st-build').textContent = BUILD;
  bindStatic();
  let me;
  try { me = await api('GET', '/api/me'); }
  catch (e) {
    if (e.status === 401) return showWelcome();
    // サーバーに届かない（オフラインなど）: 前回の利用者がいれば、下書きを書ける状態で開く
    const cached = store.me();
    if (cached) return startSession(cached, 0, { offline: true });
    showWelcome('サーバーにつながりません。通信を確認して、もう一度開いてください。');
    return;
  }
  await startSession(me.user, me.latestEventSeq);
}

async function showWelcome(err) {
  show('s-welcome');
  $('w-err').textContent = err || '';
  const code = store.pendingInvite();
  const b = $('w-invite');
  b.hidden = true;
  if (code) {
    try {
      const p = await api('GET', `/api/invites/${code}`);
      b.textContent = `${p.inviterName} さんが KOKO に招待しています。名前を入れてはじめると、ふたりのトークができます。`;
      b.hidden = false;
    } catch (e) { b.textContent = e.message; b.hidden = false; store.setPendingInvite(null); }
  }
}

async function startSession(user, latestSeq, { fromRegister = false, offline = false } = {}) {
  S.me = user;
  store.saveMe(user);
  S.outbox = store.outbox(user.id).map(x => x.state === 'sending' ? { ...x, state: 'waiting' } : x);
  S.seen = store.seen(user.id);
  S.settings = store.settings();
  $('h-me').textContent = `${user.name} として利用中`;
  ensureComposer();
  show('s-home');
  renderHome();
  await loadConversations();
  S.live = new Live({ onEvent, onState: setConn });
  S.live.start(latestSeq);
  initRecognizer();
  processOutbox();
  const code = store.pendingInvite();
  if (code) acceptInvite(code, fromRegister);
}

async function initRecognizer() {
  if (!S.settings.recognition) { S.recognizer = { available: false, reason: 'オフにしています' }; }
  else S.recognizer = await createRecognizer();
  S.composer?.setRecognizer(S.recognizer);
  $('st-recog-status').textContent = S.recognizer.reason || '';
}

function ensureComposer() {
  if (S.composer) return;
  S.composer = new Composer($('composer'), {
    settings: () => S.settings,
    onChange: d => { if (S.current && S.me) { if (!store.saveDraft(S.me.id, S.current, d)) S.composer.say('この端末に下書きを保存できません。送るまで画面を閉じないでね。'); } },
    onSend: queueSend,
    recognizer: S.recognizer,
  });
  S.composer.onSettings = s => { S.settings = s; store.saveSettings(s); };
}

// ---------- 接続状態 ----------
function setConn(state) {
  S.conn = state;
  const text = {
    idle: '', online: '', connecting: '接続中…',
    reconnecting: '再接続しています… 書いた字は下書きに残ります',
    offline: 'オフライン · 書いた字は下書きに残り、つながったら送ります',
  }[state] || '';
  for (const id of ['h-conn', 'c-conn']) { $(id).textContent = text; $(id).dataset.state = state; }
  if (state === 'online') { S.retryDelay = 2000; processOutbox(); }
}

// ---------- トーク一覧 ----------
async function loadConversations() {
  try {
    const r = await api('GET', '/api/conversations');
    S.convs = new Map(r.conversations.map(c => [c.id, c]));
    store.saveConvs(S.me.id, r.conversations.map(c => ({ ...c, last: c.last })));
    renderHome();
    if (S.current) renderChatHeader();
  } catch (e) {
    if (e.status === 401) return loggedOut(true);
    if (!S.convs.size) { S.convs = new Map(store.convs(S.me.id).map(c => [c.id, c])); renderHome(); }
  }
}

function renderHome() {
  const el = $('conv-list');
  el.replaceChildren();
  const list = [...S.convs.values()].sort((a, b) => (b.last?.serverTimestamp || b.createdAt) - (a.last?.serverTimestamp || a.createdAt));
  if (!list.length) {
    el.append(h('div', { class: 'empty' },
      h('p', { class: 'big', text: 'いつものひと言も、きみの字なら。' }),
      h('p', { text: 'まずは KOKO で話したい人をひとり招待しよう。招待リンクを作って、あなたから送ってね。' })));
    return;
  }
  for (const c of list) {
    const isNew = c.last && c.last.senderId !== S.me.id && c.last.seq > (S.seen[c.id] || 0);
    const waiting = S.outbox.filter(x => x.conversationId === c.id).length;
    const sub = c.partner ? (c.last ? `${c.last.senderId === S.me.id ? 'あなた' : partnerName(c)} · ${timeText(c.last.serverTimestamp)}` : 'まだメッセージはありません') : 'このトークは終了しました';
    el.append(h('button', { class: 'conv', type: 'button', onclick: () => openChat(c.id) },
      h('span', { class: 'avatar', 'aria-hidden': 'true', text: Array.from(partnerName(c))[0] }),
      h('span', { class: 'cbody' }, h('b', { text: partnerName(c) }), h('small', { text: sub + (waiting ? ` · 送信待ち ${waiting}` : '') })),
      isNew ? h('span', { class: 'dot', 'aria-label': '新しいメッセージ' }) : null));
  }
}

// ---------- トーク ----------
async function openChat(cid) {
  S.current = cid;
  show('s-chat');
  renderChatHeader();
  S.composer.load(store.draft(S.me.id, cid));
  S.composer.setCollapsed(false);
  renderMessages(true);
  if (!S.msgs.has(cid)) await fetchMessages(cid);
  markSeen();
}

function renderChatHeader() {
  const c = S.convs.get(S.current);
  if (!c) return;
  $('c-name').textContent = partnerName(c);
  let lock = null;
  if (!c.partner) lock = '相手は KOKO を退会しました。このトークには送れません。';
  else if (c.blockedByMe) lock = 'ブロック中です。右上の ⋯ から解除できます。';
  S.composer.setDisabled(lock);
}

async function fetchMessages(cid, before) {
  try {
    const qs = before ? `?before=${before}&limit=50` : '?limit=50';
    const r = await api('GET', `/api/conversations/${cid}/messages${qs}`);
    const map = S.msgs.get(cid) || new Map();
    for (const m of r.messages) map.set(m.id, m);
    S.msgs.set(cid, map);
    if (!before || r.messages.length) S.more.set(cid, r.messages.length === 50);
    ackAll(cid, r.messages);
    for (const m of r.messages) dropOutbox(m.clientMessageId, m.senderId);
    if (S.current === cid) renderMessages(!before);
  } catch (e) {
    if (e.status === 401) return loggedOut(true);
    if (S.current === cid) renderMessages(false, e.network ? 'オフラインのため、届いたメッセージを読み込めません。つながると表示します。' : e.message);
  }
}

async function fetchNewer(cid) {
  const map = S.msgs.get(cid);
  if (!map) return;
  const after = Math.max(0, ...[...map.values()].map(m => m.seq));
  try {
    const r = await api('GET', `/api/conversations/${cid}/messages?after=${after}&limit=100`);
    for (const m of r.messages) { map.set(m.id, m); dropOutbox(m.clientMessageId, m.senderId); }
    ackAll(cid, r.messages);
    if (S.current === cid) { renderMessages(true); markSeen(); }
  } catch {}
}

function renderMessages(scroll, note) {
  const el = $('chat');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const cid = S.current;
  const c = S.convs.get(cid);
  const map = S.msgs.get(cid);
  el.replaceChildren();
  if (S.more.get(cid)) {
    const minSeq = Math.min(...[...map.values()].map(m => m.seq));
    el.append(h('button', { class: 'link center', type: 'button', onclick: () => fetchMessages(cid, minSeq) }, 'もっと前を見る'));
  }
  const list = map ? [...map.values()].sort((a, b) => a.seq - b.seq) : [];
  const pending = S.outbox.filter(x => x.conversationId === cid);
  if (note) el.append(h('div', { class: 'note', text: note }));
  if (!list.length && !pending.length && map) {
    el.append(h('div', { class: 'empty' }, h('p', { class: 'big', text: `${partnerName(c)} さんとのトーク` }), h('p', { text: '下のマスに、いつものひと言を書いてみよう。' })));
  }
  for (const m of list) el.append(bubble(m, c));
  for (const p of pending) el.append(pendingBubble(p));
  if (scroll || atBottom) el.scrollTop = el.scrollHeight;
}

function inkBlock(tokens, alt, who) {
  const n = tokens.filter(t => t.kind === 'ink').length;
  const ink = h('div', { class: 'inkflow' });
  renderFlow(ink, tokens, { label: alt ? `${who}の手書き：${alt}` : `${who}の手書きメッセージ（${n}文字）` });
  return ink;
}

function bubble(m, c) {
  const mine = m.senderId === S.me.id;
  const who = mine ? 'あなた' : partnerName(c);
  const fresh = S.fresh.delete(m.id); // いま届いたものだけ軽く動かす
  const wrap = h('article', { class: 'msg' + (mine ? ' mine' : '') + (fresh ? ' fresh' : '') });
  wrap.append(inkBlock(m.tokens, m.altText, who));
  let altEl = null;
  if (m.altText) { altEl = h('p', { class: 'alt', hidden: true, text: m.altText }); wrap.append(altEl); }
  const meta = h('div', { class: 'meta' }, h('span', { text: timeText(m.serverTimestamp) }));
  if (mine) meta.append(h('span', { class: 'st', text: m.deliveredAt ? '届きました' : '送信済み' }));
  if (altEl) meta.append(h('button', { class: 'link tiny', type: 'button', 'aria-label': '読み上げ用テキストを表示', onclick: () => { altEl.hidden = !altEl.hidden; } }, 'Aa'));
  if (!mine && c?.partner) meta.append(h('button', { class: 'link tiny', type: 'button', onclick: () => reportMessage(m) }, '通報'));
  wrap.append(meta);
  return wrap;
}

function pendingBubble(p) {
  const fresh = !S.rendered.has(p.clientMessageId);
  S.rendered.add(p.clientMessageId);
  const wrap = h('article', { class: 'msg mine pending' + (p.state === 'failed' ? ' failed' : '') + (fresh ? ' fresh' : '') });
  wrap.append(inkBlock(p.tokens, p.altText, 'あなた'));
  const label = { sending: '送信中…', waiting: '未送信 · つながったら自動で送ります', failed: `送れませんでした：${p.error || ''}` }[p.state];
  const meta = h('div', { class: 'meta' }, h('span', { class: 'st', text: label }));
  if (p.state === 'failed') {
    meta.append(
      h('button', { class: 'link tiny', type: 'button', onclick: () => { p.state = 'waiting'; saveOutbox(); processOutbox(true); } }, 'もう一度'),
      h('button', { class: 'link tiny', type: 'button', onclick: () => backToDraft(p) }, '下書きに戻す'),
      h('button', { class: 'link tiny', type: 'button', onclick: () => { S.outbox = S.outbox.filter(x => x !== p); saveOutbox(); renderMessages(); } }, '取り消す'));
  } else if (p.state === 'waiting') {
    meta.append(h('button', { class: 'link tiny', type: 'button', onclick: () => processOutbox(true) }, '今すぐ送る'));
  }
  wrap.append(meta);
  return wrap;
}

function backToDraft(p) {
  const cur = S.composer.draft();
  if (cur.tokens.length) { toast('いま書いている下書きがあります。送るか消してから戻してね。'); return; }
  S.outbox = S.outbox.filter(x => x !== p); saveOutbox();
  S.composer.load({ tokens: p.tokens, cursor: p.tokens.length, alt: p.altText || '' });
  store.saveDraft(S.me.id, S.current, S.composer.draft());
  renderMessages();
}

function markSeen() {
  const map = S.msgs.get(S.current);
  if (!map || document.visibilityState !== 'visible') return;
  const max = Math.max(0, ...[...map.values()].map(m => m.seq));
  if (max > (S.seen[S.current] || 0)) { S.seen[S.current] = max; store.saveSeen(S.me.id, S.seen); }
}

// ---------- 送信（送信待ちの列で順番を守る・再送で二重にならない） ----------
function saveOutbox() {
  if (!store.saveOutbox(S.me.id, S.outbox)) toast('この端末に送信待ちを保存できません。送り終わるまで画面を閉じないでね。', 5000);
}
async function queueSend({ tokens, altText, composeMs }) {
  const c = S.convs.get(S.current);
  if (!c || !c.partner || c.blockedByMe) return false;
  S.outbox.push({ clientMessageId: rid(), conversationId: S.current, tokens, altText, composeMs, createdAt: Date.now(), state: 'waiting' });
  saveOutbox();
  renderMessages(true);
  processOutbox(true);
  return true;
}
function dropOutbox(clientMessageId, senderId) {
  if (senderId !== S.me?.id) return;
  const before = S.outbox.length;
  S.outbox = S.outbox.filter(x => x.clientMessageId !== clientMessageId);
  if (S.outbox.length !== before) saveOutbox();
}
async function processOutbox(now) {
  if (!S.me) return;
  if (now) { clearTimeout(S.retryTimer); S.retryTimer = null; }
  if (S.sending || S.retryTimer) return;
  S.sending = true;
  try {
    for (;;) {
      const item = S.outbox.find(x => x.state === 'waiting' || x.state === 'sending');
      if (!item) break;
      item.state = 'sending';
      if (S.current === item.conversationId) renderMessages();
      try {
        const r = await api('POST', `/api/conversations/${item.conversationId}/messages`, {
          clientMessageId: item.clientMessageId, payloadVersion: 1, tokens: item.tokens,
          altText: item.altText || undefined, composeMs: item.composeMs ?? undefined,
        });
        addMessage(r.message);
        S.outbox = S.outbox.filter(x => x !== item); saveOutbox();
        S.retryDelay = 2000;
      } catch (e) {
        if (e.status === 401) { item.state = 'waiting'; saveOutbox(); loggedOut(true); return; }
        if (e instanceof ApiError && e.retryable) {
          item.state = 'waiting'; saveOutbox();
          if (S.current === item.conversationId) renderMessages();
          S.retryTimer = setTimeout(() => { S.retryTimer = null; processOutbox(); }, S.retryDelay);
          S.retryDelay = Math.min(30000, S.retryDelay * 2);
          break;
        }
        item.state = 'failed'; item.error = e.message; saveOutbox();
        if (S.current === item.conversationId) renderMessages();
      }
    }
  } finally {
    S.sending = false;
    renderHome();
  }
}

// ---------- 届いたもの ----------
function addMessage(m) {
  const map = S.msgs.get(m.conversationId);
  if (map) {
    const old = map.get(m.id);
    map.set(m.id, old && old.deliveredAt && !m.deliveredAt ? { ...m, deliveredAt: old.deliveredAt } : m);
  }
  dropOutbox(m.clientMessageId, m.senderId);
  const c = S.convs.get(m.conversationId);
  if (c && (!c.last || c.last.seq < m.seq)) c.last = { senderId: m.senderId, serverTimestamp: m.serverTimestamp, seq: m.seq };
  if (m.senderId !== S.me.id) ackAll(m.conversationId, [m]);
  if (S.current === m.conversationId && document.body.dataset.screen === 's-chat') { renderMessages(); markSeen(); }
  renderHome();
}

function ackAll(cid, msgs) {
  for (const m of msgs) {
    if (m.senderId === S.me.id || S.acked.has(m.id)) continue;
    S.acked.add(m.id);
    if (!S.ackQueue.has(cid)) S.ackQueue.set(cid, new Set());
    S.ackQueue.get(cid).add(m.id);
  }
  clearTimeout(S.ackTimer);
  S.ackTimer = setTimeout(flushAcks, 250);
}
async function flushAcks() {
  const q = S.ackQueue; S.ackQueue = new Map();
  for (const [cid, ids] of q) {
    try { await api('POST', `/api/conversations/${cid}/delivered`, { messageIds: [...ids] }); }
    catch { for (const id of ids) S.acked.delete(id); } // 次の接続でもう一度
  }
}

function notifyNew(m) {
  if (m.senderId === S.me.id || !S.me.notify) return;
  const visibleHere = document.visibilityState === 'visible' && S.current === m.conversationId && document.body.dataset.screen === 's-chat';
  if (visibleHere) return;
  if (document.visibilityState === 'visible') { toast(`${partnerName(S.convs.get(m.conversationId))} さんから手書きのメッセージ`); return; }
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('KOKO', { body: `${partnerName(S.convs.get(m.conversationId))} さんから手書きのメッセージ`, icon: 'icons/icon-192.png', tag: m.conversationId });
    }
  } catch {}
}

async function onEvent(type, data) {
  if (type === 'hello') {
    if (data?.resync) S.msgs.clear();
    await loadConversations();
    if (S.current) { if (S.msgs.has(S.current)) fetchNewer(S.current); else fetchMessages(S.current); }
    // 取りこぼしたかもしれない受信確認を送り直す
    for (const [cid, map] of S.msgs) ackAll(cid, [...map.values()]);
    processOutbox(true);
  } else if (type === 'message') {
    if (!S.convs.has(data.conversationId)) await loadConversations();
    if (data.senderId !== S.me.id && !S.msgs.get(data.conversationId)?.has(data.id)) S.fresh.add(data.id);
    addMessage(data);
    notifyNew(data);
  } else if (type === 'delivered') {
    const map = S.msgs.get(data.conversationId);
    if (map) for (const id of data.messageIds) { const m = map.get(id); if (m) m.deliveredAt = data.deliveredAt; }
    if (S.current === data.conversationId) renderMessages();
  } else if (type === 'conversation') {
    const isNew = !S.convs.has(data.id);
    S.convs.set(data.id, data);
    renderHome();
    if (isNew) toast(`${partnerName(data)} さんとトークできるようになりました`);
  } else if (type === 'partner_left') {
    await loadConversations();
    S.msgs.delete(data.conversationId);
    if (S.current === data.conversationId) fetchMessages(data.conversationId);
  } else if (type === 'logout') {
    loggedOut(false, 'この端末はログアウトされました。');
  } else if (type === 'closed') {
    try { await api('GET', '/api/me'); } catch (e) { if (e.status === 401) loggedOut(true); }
  }
}

// ---------- 招待 ----------
async function makeInvite() {
  let r;
  try { r = await api('POST', '/api/invites'); } catch (e) { toast(e.message); return; }
  const url = `${location.origin}/#invite=${r.code}`;
  const days = Math.round((r.expiresAt - Date.now()) / 86400000);
  const actions = [];
  if (navigator.share) actions.push({ label: '共有する', value: 'share', type: 'button', onclick: async () => { try { await navigator.share({ title: 'KOKO', text: 'KOKOで話そう。', url }); } catch {} } });
  actions.push({ label: 'コピー', value: 'copy', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(url); toast('コピーしました'); } catch { toast('コピーできませんでした。長押しで選んでね'); } } });
  actions.push({ label: '閉じる', value: 'close', class: 'primary' });
  await sheet({
    title: '招待リンク',
    body: [`KOKO で話したい人に、あなたから送ってね。1回だけ使えて、${days}日で使えなくなります。`, h('p', { class: 'fine', text: '連絡先の読み取りや自動送信はしません。' })],
    input: { value: url, readonly: true, label: '招待リンク' },
    actions,
  });
}

async function acceptInvite(code, fromRegister) {
  store.setPendingInvite(null);
  let preview;
  try { preview = await api('GET', `/api/invites/${code}`); } catch (e) { toast(e.message, 5000); return; }
  if (!fromRegister) {
    const r = await sheet({ title: `${preview.inviterName} さんからの招待`, body: ['ふたりのトークをはじめますか？'], actions: [{ label: 'やめる', value: 'no' }, { label: 'はじめる', value: 'yes', class: 'primary' }] });
    if (r.value !== 'yes') return;
  }
  try {
    const res = await api('POST', `/api/invites/${code}/accept`);
    S.convs.set(res.conversation.id, res.conversation);
    renderHome();
    openChat(res.conversation.id);
  } catch (e) { toast(e.message, 5000); }
}

// ---------- ブロック・通報 ----------
async function chatMenu() {
  const c = S.convs.get(S.current);
  if (!c) return;
  const actions = [];
  if (c.partner) actions.push(c.blockedByMe ? { label: 'ブロックを解除', value: 'unblock' } : { label: 'ブロックする', value: 'block', class: 'danger' });
  if (c.partner) actions.push({ label: 'このトークを通報', value: 'report' });
  actions.push({ label: '閉じる', value: 'close', class: 'primary' });
  const r = await sheet({ title: partnerName(c), body: [], actions });
  if (r.value === 'block') {
    const ok = await sheet({ title: 'ブロックしますか？', body: ['お互いにこのトークへ送れなくなります。相手に通知はしませんが、相手が送ろうとすると送れないことは分かります。'], actions: [{ label: 'やめる', value: 'no' }, { label: 'ブロック', value: 'yes', class: 'danger' }] });
    if (ok.value !== 'yes') return;
    try { await api('POST', '/api/blocks', { userId: c.partner.id }); c.blockedByMe = true; renderChatHeader(); toast('ブロックしました'); } catch (e) { toast(e.message); }
  } else if (r.value === 'unblock') {
    try { await api('DELETE', `/api/blocks/${c.partner.id}`); c.blockedByMe = false; renderChatHeader(); toast('ブロックを解除しました'); } catch (e) { toast(e.message); }
  } else if (r.value === 'report') {
    const rr = await sheet({ title: 'このトークを通報', body: ['運営に知らせます。相手には通知しません。'], input: { placeholder: '理由（任意）' }, actions: [{ label: 'やめる', value: 'no' }, { label: '通報する', value: 'yes', class: 'danger' }] });
    if (rr.value !== 'yes') return;
    try { await api('POST', '/api/reports', { conversationId: c.id, reason: rr.input || '' }); toast('通報を受け付けました。必要ならブロックもできます。'); } catch (e) { toast(e.message); }
  }
}
async function reportMessage(m) {
  const rr = await sheet({ title: 'このメッセージを通報', body: ['運営に知らせます。相手には通知しません。'], input: { placeholder: '理由（任意）' }, actions: [{ label: 'やめる', value: 'no' }, { label: '通報する', value: 'yes', class: 'danger' }] });
  if (rr.value !== 'yes') return;
  try { await api('POST', '/api/reports', { messageId: m.id, reason: rr.input || '' }); toast('通報を受け付けました。'); } catch (e) { toast(e.message); }
}

// ---------- 設定 ----------
function seg(el, options, value, onChange) {
  el.replaceChildren();
  for (const [v, label] of options) {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '' }, label);
    b.addEventListener('click', () => { onChange(v); seg(el, options, v, onChange); });
    el.append(b);
  }
}
function openSettings() {
  show('s-settings');
  $('st-name').value = S.me.name;
  const save = () => { store.saveSettings(S.settings); S.composer.relayout(); };
  seg($('st-cells'), [[2, '2'], [3, '3'], [4, '4']], Number(S.settings.cells), v => { S.settings.cells = v; save(); });
  seg($('st-hand'), [['right', '右手向き'], ['left', '左手向き']], S.settings.hand, v => { S.settings.hand = v; save(); });
  seg($('st-guide'), [['cell', 'マスに薄く出す'], ['bar', 'マスの上に出すだけ']], S.settings.guideMode, v => { S.settings.guideMode = v; save(); });
  $('st-recog').checked = !!S.settings.recognition;
  $('st-recog-status').textContent = S.recognizer.reason || '';
  $('st-notify').checked = !!S.me.notify;
}

async function loggedOut(expired, message) {
  if (!S.me && !expired) return;
  S.live?.stop(); S.live = null;
  clearTimeout(S.retryTimer); S.retryTimer = null;
  if (!expired) store.wipe(); // 自分でログアウト／他の端末から全ログアウト: この端末のデータを消す
  S.me = null; S.convs.clear(); S.msgs.clear(); S.current = null; S.outbox = []; S.acked.clear();
  $('chat').replaceChildren(); $('conv-list').replaceChildren();
  S.composer?.load(null);
  showWelcome(message || (expired ? 'ログインの期限が切れました。引き継ぎコードでログインし直してください。この端末の下書きは残っています。' : ''));
  if (expired) { $('f-register').hidden = true; $('f-login').hidden = false; }
}

async function doLogout(all) {
  const waiting = S.outbox.length;
  const r = await sheet({
    title: all ? 'すべての端末からログアウト' : 'この端末からログアウト',
    body: [
      'この端末の下書き・送信待ち・設定を消します。届いたメッセージはサーバーに残り、引き継ぎコードで再ログインすると見られます。',
      waiting ? h('p', { class: 'warn', text: `まだ送れていないメッセージが ${waiting} 件あります。ログアウトすると消えます。` }) : null,
    ].filter(Boolean),
    actions: [{ label: 'やめる', value: 'no' }, { label: 'ログアウト', value: 'yes', class: 'danger' }],
  });
  if (r.value !== 'yes') return;
  try { await api('POST', all ? '/api/logout-all' : '/api/logout'); }
  catch (e) { if (e.network) { toast('通信できないためログアウトできません。つながってからもう一度試してね。', 5000); return; } }
  await loggedOut(false, 'ログアウトしました。');
}

async function installApp() {
  if (installEvt) {
    const ev = installEvt; installEvt = null; // prompt() は1回しか使えない
    try { ev.prompt(); const r = await ev.userChoice; if (r.outcome === 'accepted') toast('ホーム画面に追加しました'); else installEvt = null; } catch {}
    return;
  }
  const ios = isIos();
  await sheet({
    title: 'ホーム画面に追加',
    body: ios
      ? ['画面の下（または上）の共有ボタン（□に↑）を押して、「ホーム画面に追加」を選んでね。', 'Safari で開いているときだけ出ることがあります。']
      : ['ブラウザのメニュー（︙）から「ホーム画面に追加」または「アプリをインストール」を選んでね。', '出ないときは、Chrome で開いているか確認してね。'],
    actions: [{ label: '閉じる', value: 'ok', class: 'primary' }],
  });
}

// ---------- 引き継ぎコードの端末内保存（任意・初期はオフ） ----------
// 保存先はこの端末のブラウザの中だけ（サーバーには送らない）。ログアウトで消える。この端末を使える人にはコードが見える。
function ensureCodeSaveBox() {
  let box = $('code-save');
  if (box) return box;
  box = h('input', { type: 'checkbox', id: 'code-save' });
  const wrap = h('div', { class: 'code-save-wrap' },
    h('label', { class: 'code-save' }, box, h('span', { text: 'この端末にコードを保存する（あとで設定から見られます）' })),
    h('p', { class: 'code-save-note', text: '家族や学校・職場など、ほかの人も使う端末ではオフのままにしてね。' }));
  $('code-text').insertAdjacentElement('afterend', wrap);
  return box;
}

async function showSavedCode() {
  const code = S.me && store.code(S.me.id);
  if (!code) {
    await sheet({
      title: 'コードは保存されていません',
      body: ['この端末には、引き継ぎコードを保存していません。', '「引き継ぎコードを作り直す」で新しいコードを作るとき、この端末に保存することもできます。'],
      actions: [{ label: '閉じる', value: 'ok', class: 'primary' }],
    });
    return;
  }
  const r = await sheet({
    title: 'この端末に保存した引き継ぎコード',
    body: ['別の端末からこのコードで入れます。ほかの人には見せないでね。'],
    input: { value: code, readonly: true },
    actions: [{ label: '保存を消す', value: 'forget' }, { label: '閉じる', value: 'ok', class: 'primary' }],
  });
  if (r.value === 'forget') { store.clearCode(); toast('この端末の保存を消しました'); }
}

// ---------- イベントの結線 ----------
function bindStatic() {
  $('to-login').onclick = () => { $('f-register').hidden = true; $('f-login').hidden = false; $('to-login').hidden = true; $('l-code').focus(); };
  $('to-register').onclick = () => { $('f-register').hidden = false; $('f-login').hidden = true; $('to-login').hidden = false; };
  $('f-register').onsubmit = async e => {
    e.preventDefault();
    const btn = e.submitter; if (btn) btn.disabled = true;
    try {
      const r = await api('POST', '/api/register', { name: $('r-name').value });
      $('code-text').textContent = r.loginCode;
      ensureCodeSaveBox().checked = false;
      show('s-code');
      $('code-done').onclick = async () => {
        const me = await api('GET', '/api/me');
        if (ensureCodeSaveBox().checked) store.saveCode(me.user.id, r.loginCode);
        await startSession(me.user, me.latestEventSeq, { fromRegister: true });
      };
    } catch (err) { $('w-err').textContent = err.message; }
    finally { if (btn) btn.disabled = false; }
  };
  $('code-copy').onclick = async () => { try { await navigator.clipboard.writeText($('code-text').textContent); toast('コピーしました'); } catch { toast('コピーできませんでした。書き写してね'); } };
  $('f-login').onsubmit = async e => {
    e.preventDefault();
    try {
      await api('POST', '/api/login', { loginCode: $('l-code').value });
      const me = await api('GET', '/api/me');
      $('l-code').value = '';
      await startSession(me.user, me.latestEventSeq);
    } catch (err) { $('w-err').textContent = err.message; }
  };
  $('make-invite').onclick = makeInvite;
  $('back').onclick = () => { S.current = null; show('s-home'); renderHome(); };
  $('c-menu').onclick = chatMenu;
  // 会話の部分をタップするとマスをしまう（キーボードを閉じる感覚）
  $('chat').addEventListener('click', e => { if (!e.target.closest('button') && S.composer && !S.composer.collapsed) S.composer.setCollapsed(true); });
  $('to-settings').onclick = openSettings;
  $('settings-back').onclick = () => { show('s-home'); renderHome(); };
  $('st-name-save').onclick = async () => {
    try { const r = await api('PATCH', '/api/me', { name: $('st-name').value }); S.me = r.user; store.saveMe(r.user); $('h-me').textContent = `${S.me.name} として利用中`; toast('保存しました'); } catch (e) { toast(e.message); }
  };
  $('st-recog').onchange = e => { S.settings.recognition = e.target.checked; store.saveSettings(S.settings); initRecognizer(); };
  $('st-notify').onchange = async e => {
    const on = e.target.checked;
    if (on && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
    try { const r = await api('PATCH', '/api/me', { notify: on }); S.me = r.user; store.saveMe(r.user); } catch (err) { toast(err.message); e.target.checked = !on; }
  };
  const viewBtn = h('button', { id: 'st-code-view', type: 'button', class: $('st-code').className }, '引き継ぎコードを見る');
  $('st-code').before(viewBtn);
  viewBtn.onclick = showSavedCode;
  if (!isStandalone()) {
    const inst = h('button', { id: 'st-install', type: 'button', class: $('st-code').className }, 'ホーム画面に追加');
    $('st-code').before(inst);
    inst.onclick = installApp;
  }
  $('st-code').onclick = async () => {
    const r = await sheet({ title: '引き継ぎコードを作り直す', body: ['今のコードは使えなくなります。'], actions: [{ label: 'やめる', value: 'no' }, { label: '作り直す', value: 'yes', class: 'primary' }] });
    if (r.value !== 'yes') return;
    try {
      const c = await api('POST', '/api/me/login-code');
      const box = h('input', { type: 'checkbox' }); box.checked = !!store.code(S.me.id);
      const label = h('label', { class: 'code-save' }, box, h('span', { text: 'この端末にコードを保存する（共有の端末ではオフのままにしてね）' }));
      await sheet({ title: '新しい引き継ぎコード', body: ['この画面でしか表示されません。', label], input: { value: c.loginCode, readonly: true }, actions: [{ label: '保存した', value: 'ok', class: 'primary' }] });
      if (box.checked) store.saveCode(S.me.id, c.loginCode); else store.clearCode(); // 古いコードの控えが残らないようにする
    } catch (e) { toast(e.message); }
  };
  $('st-logout').onclick = () => doLogout(false);
  $('st-logout-all').onclick = () => doLogout(true);
  $('st-delete').onclick = async () => {
    const r = await sheet({
      title: 'アカウントを削除', body: ['あなたが送った筆跡・トーク・招待をサーバーから削除します。元に戻せません。続けるなら「削除」と入力してください。'],
      input: { placeholder: '削除' }, actions: [{ label: 'やめる', value: 'no' }, { label: '削除する', value: 'yes', class: 'danger' }],
    });
    if (r.value !== 'yes') return;
    if ((r.input || '').trim() !== '削除') { toast('「削除」と入力してね'); return; }
    try { await api('DELETE', '/api/me', { confirm: 'DELETE' }); await loggedOut(false, 'アカウントを削除しました。'); } catch (e) { toast(e.message); }
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.current) markSeen(); });
  window.addEventListener('resize', () => S.composer?.relayout());
}

boot();