// KOKO — サーバー無し（Firebase Spark プラン）版の通信。app.js から見たインターフェース（api / ApiError / Live）は今までと同じ。
// - api(method, path, body): 以前の /api/... を、Firebase Auth と Firestore を直接使って再現する。
// - Live: SSE の代わりに、Firestore のスナップショット購読でトーク・新着・届いた表示・全端末ログアウトを受け取る。
// 守りは firestore.rules。筆跡の中身の検査は public/js/validate.js（送る前と受け取った時に端末で行う）。
//
// ログイン（引き継ぎコード方式のまま）:
//   コード16文字 = 先頭6文字（ID）+ 残り10文字（秘密）。
//   Firebase Auth のメール/パスワードを内部で使う: メール = <ID>@koko.invalid、パスワード = 秘密のハッシュ。
//   メールアドレスは実在せず、メールも送らない。利用者には「引き継ぎコード」しか見えない。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updatePassword, deleteUser,
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, orderBy, limit,
  documentId, onSnapshot, runTransaction, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { ValidationError, validateTokens, validateMessageBody, validateName } from './validate.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);          // ログイン状態は端末内（IndexedDB）に残る。signOut で消える
const firestore = getFirestore(app); // Web SDK の既定はメモリのみ（会話を端末に保存しない方針のまま）

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  get network() { return this.status === 0; }
  get retryable() { return this.status === 0 || this.status >= 500 || this.status === 429; }
}

const INVITE_TTL = 7 * 24 * 3600 * 1000;

// ---------- 小さな道具 ----------
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい I O 0 1 を除く
const randB32 = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), x => B32[x % 32]).join('');
const rid = n => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sha256hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
}
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmtCode = (id, secret) => (id + secret).match(/.{4}/g).join('-');
const emailOf = id => `${id.toLowerCase()}@koko.invalid`;
const pwOf = async secret => 'k1' + await sha256hex('koko-pw:' + secret);
const tsMs = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : (Number(v) || Date.now());
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

function toApiError(e) {
  console.warn('通信エラーの原因:', e && e.code, e);   // ← この行を追加
  if (e instanceof ApiError) return e;
  if (e instanceof ValidationError) return new ApiError(422, e.code, e.message);
  const c = String((e && e.code) || '');
  if (c.includes('unavailable') || c.includes('network-request-failed') || c.includes('deadline-exceeded') || navigator.onLine === false) return new ApiError(0, 'network', '通信できませんでした');
  if (c.includes('resource-exhausted')) return new ApiError(429, 'quota', '今日の無料の利用上限に達しました。しばらくしてからもう一度試してください');
  if (c.includes('too-many-requests')) return new ApiError(429, 'rate_limited', '少し時間をおいてから試してください');
  if (c.includes('requires-recent-login')) return new ApiError(403, 'recent_login', '安全のため、いったんログアウトして引き継ぎコードで入り直してから、もう一度試してください');
  if (c.includes('permission-denied')) return new ApiError(403, 'denied', 'この操作はできません');
  console.error(e);
  return new ApiError(500, 'server', '問題が起きました');
}
// 権限エラーの理由を、操作に合った文言にする（ログイン切れとの区別は api() がする）
function denied(e, code, message, status = 403) {
  if (String((e && e.code) || '').includes('permission-denied')) e.kokoDenied = new ApiError(status, code, message);
  throw e;
}

async function readUser(uid) {
  const s = await getDoc(doc(firestore, 'users', uid));
  if (!s.exists()) return null;
  const d = s.data();
  return { id: uid, name: d.name, notify: !!d.notify, createdAt: Number(d.createdAt) };
}
function metric(type, userId, conversationId, value) {
  addDoc(collection(firestore, 'metrics'), { type, userId, conversationId: conversationId || null, value: value ?? null, createdAt: Date.now() }).catch(() => {});
}
async function convFull(cid, c, uid) {
  const pid = c.members.find(m => m !== uid);
  let partner = null, blockedByMe = false;
  if (pid) {
    const [p, b] = await Promise.all([
      getDoc(doc(firestore, 'users', pid)).catch(() => null),
      getDoc(doc(firestore, 'blocks', `${uid}_${pid}`)).catch(() => null),
    ]);
    if (p && p.exists()) partner = { id: pid, name: p.data().name };
    blockedByMe = !!(b && b.exists());
  }
  const last = c.last ? { senderId: c.last.senderId, serverTimestamp: tsMs(c.last.serverTimestamp), seq: Number(c.last.seq) } : null;
  return { id: cid, createdAt: Number(c.createdAt), partner, blockedByMe, last };
}
// 受け取った筆跡は必ず検査する。形式が不正なら、描画せず「読み込めない」と表示する（アプリを壊さない）
function msgJson(id, cid, m) {
  let tokens, alt = m.altText || null;
  try { tokens = validateTokens(JSON.parse(m.tokens)).tokens; }
  catch { tokens = []; alt = alt || '（読み込めないメッセージです）'; }
  return {
    id, seq: Number(m.seq), conversationId: cid, senderId: m.senderId, clientMessageId: m.clientMessageId,
    serverTimestamp: tsMs(m.serverTimestamp), payloadVersion: 1, tokens, altText: alt,
    deliveredAt: m.deliveredAt ? tsMs(m.deliveredAt) : null,
  };
}
async function myConvs(uid) {
  return (await getDocs(query(collection(firestore, 'conversations'), where('members', 'array-contains', uid)))).docs;
}
async function loadInvite(code) {
  const hash = await sha256hex(String(code));
  const s = await getDoc(doc(firestore, 'invites', hash));
  if (!s.exists()) throw new ApiError(404, 'invite_invalid', 'この招待は見つかりません');
  const inv = s.data();
  if (inv.usedBy) throw new ApiError(410, 'invite_used', 'この招待はすでに使われています');
  if (Number(inv.expiresAt) < Date.now()) throw new ApiError(410, 'invite_expired', 'この招待は期限切れです');
  return { ref: s.ref, inv, hash };
}
async function recentLoginOrThrow() {
  const r = await auth.currentUser.getIdTokenResult();
  if (Date.now() - Date.parse(r.authTime) > 4 * 60 * 1000) throw toApiError({ code: 'auth/requires-recent-login' });
}

// ---------- ルート（以前の /api/... と同じ形） ----------
const routes = [];
const route = (method, pattern, fn, opts = {}) =>
  routes.push({ method, public: !!opts.public, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9_-]+)') + '$'), fn });

route('GET', '/api/health', async () => ({ ok: true, payloadVersion: 1 }), { public: true });

route('POST', '/api/register', async ({ body }) => {
  const name = validateName(body.name);
  let cred = null, id, secret;
  for (let i = 0; i < 5 && !cred; i++) {
    id = randB32(6); secret = randB32(10);
    try { cred = await createUserWithEmailAndPassword(auth, emailOf(id), await pwOf(secret)); }
    catch (e) { if (!(e && e.code === 'auth/email-already-in-use')) throw e; }
  }
  if (!cred) throw new ApiError(500, 'server', '登録できませんでした。もう一度試してください');
  const uid = cred.user.uid, t = Date.now();
  try { await setDoc(doc(firestore, 'users', uid), { name, notify: true, createdAt: t, revokedBefore: null }); }
  catch (e) { try { await deleteUser(cred.user); } catch {} throw e; }
  metric('register', uid);
  return { user: { id: uid, name, notify: true, createdAt: t }, loginCode: fmtCode(id, secret) };
}, { public: true });

route('POST', '/api/login', async ({ body }) => {
  const n = normCode(body.loginCode);
  const bad = new ApiError(401, 'bad_code', '引き継ぎコードが違います');
  if (n.length !== 16) throw bad;
  try { await signInWithEmailAndPassword(auth, emailOf(n.slice(0, 6)), await pwOf(n.slice(6))); }
  catch (e) { if (/invalid-credential|user-not-found|wrong-password|invalid-email/.test(String(e && e.code))) throw bad; throw e; }
  const u = await readUser(auth.currentUser.uid);
  if (!u) { try { await signOut(auth); } catch {} throw bad; }
  return { user: u };
}, { public: true });

route('POST', '/api/logout-all', async ({ uid }) => {
  // 古いログインはルールが拒否する（auth_time が revokedBefore より前）。他の端末は Live が検知してログアウトする
  await updateDoc(doc(firestore, 'users', uid), { revokedBefore: serverTimestamp() });
  try { await signOut(auth); } catch {}
  return { ok: true };
});

route('GET', '/api/me', async ({ uid }) => {
  const user = await readUser(uid);
  if (!user) throw new ApiError(401, 'unauthorized', 'ログインが必要です');
  return { user, latestEventSeq: 0 };
});

route('PATCH', '/api/me', async ({ uid, body }) => {
  const upd = {};
  if (body.name !== undefined) upd.name = validateName(body.name);
  if (body.notify !== undefined) upd.notify = !!body.notify;
  if (Object.keys(upd).length) await updateDoc(doc(firestore, 'users', uid), upd);
  return { user: await readUser(uid) };
});

route('POST', '/api/me/login-code', async ({ uid }) => {
  // ID（先頭6文字）はそのまま、秘密の部分だけを新しくする。古いコードは使えなくなる
  const id = auth.currentUser.email.split('@')[0].toUpperCase();
  const secret = randB32(10);
  await updatePassword(auth.currentUser, await pwOf(secret)); // しばらく前のログインだと requires-recent-login
  return { loginCode: fmtCode(id, secret) };
});

route('DELETE', '/api/me', async ({ uid, body }) => {
  if (body.confirm !== 'DELETE') throw new ApiError(400, 'confirm', '確認が必要です');
  await recentLoginOrThrow(); // Auth のアカウント削除は直近のログインが必要。先に確認して、データだけ消えた状態を避ける
  for (const c of await myConvs(uid)) {
    const members = c.data().members;
    const col = collection(c.ref, 'messages');
    const msgs = members.length === 1 ? await getDocs(col) : await getDocs(query(col, where('senderId', '==', uid)));
    for (const part of chunk(msgs.docs, 400)) { const b = writeBatch(firestore); part.forEach(d => b.delete(d.ref)); await b.commit(); }
    if (members.length === 1) await deleteDoc(c.ref);
    else await updateDoc(c.ref, { members: members.filter(x => x !== uid) });
  }
  for (const d of (await getDocs(query(collection(firestore, 'invites'), where('inviterId', '==', uid)))).docs) await deleteDoc(d.ref);
  for (const d of (await getDocs(query(collection(firestore, 'blocks'), where('blockerId', '==', uid)))).docs) await deleteDoc(d.ref);
  await deleteDoc(doc(firestore, 'users', uid)); // これ以降 Firestore は使えないので最後
  await deleteUser(auth.currentUser);
  return { ok: true };
});

route('POST', '/api/invites', async ({ uid }) => {
  const me = await readUser(uid);
  const t = Date.now();
  const mine = await getDocs(query(collection(firestore, 'invites'), where('inviterId', '==', uid)));
  if (mine.docs.filter(d => !d.data().usedBy && d.data().expiresAt > t).length >= 20) throw new ApiError(429, 'too_many_invites', '未使用の招待が多すぎます');
  const code = rid(18);
  await setDoc(doc(firestore, 'invites', await sha256hex(code)), {
    inviterId: uid, inviterName: me.name, createdAt: t, expiresAt: t + INVITE_TTL, usedBy: null, usedAt: null, conversationId: null,
  });
  metric('invite_created', uid);
  return { code, expiresAt: t + INVITE_TTL };
});

route('GET', '/api/invites/:code', async ({ params }) => {
  const { inv } = await loadInvite(params.code);
  return { inviterName: inv.inviterName, expiresAt: Number(inv.expiresAt) };
}, { public: true });

route('POST', '/api/invites/:code/accept', async ({ uid, params }) => {
  const { ref, inv } = await loadInvite(params.code);
  if (inv.inviterId === uid) throw new ApiError(400, 'invite_self', '自分の招待は使えません。相手に送ってください');
  const found = (await myConvs(uid)).find(d => { const m = d.data().members; return m.length === 2 && m.includes(inv.inviterId); });
  const t = Date.now();
  let convId, conv;
  try {
    await runTransaction(firestore, async tx => {
      const s = await tx.get(ref);
      if (!s.exists() || s.data().usedBy) throw new ApiError(410, 'invite_used', 'この招待はすでに使われています');
      if (found) { convId = found.id; conv = found.data(); }
      else {
        convId = 'c_' + rid(12);
        conv = { members: [inv.inviterId, uid], createdAt: t, msgSeq: 0, last: null, inviteHash: ref.id };
        tx.set(doc(firestore, 'conversations', convId), conv);
      }
      tx.update(ref, { usedBy: uid, usedAt: t, conversationId: convId });
    });
  } catch (e) { denied(e, 'blocked', 'この招待は使えません'); }
  metric('invite_accepted', uid, convId);
  return { conversation: await convFull(convId, conv, uid) };
});

route('GET', '/api/conversations', async ({ uid }) => {
  const list = await Promise.all((await myConvs(uid)).map(d => convFull(d.id, d.data(), uid)));
  list.sort((x, y) => (y.last?.serverTimestamp || y.createdAt) - (x.last?.serverTimestamp || x.createdAt));
  return { conversations: list };
});

route('GET', '/api/conversations/:id/messages', async ({ params, url }) => {
  const lim = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const after = url.searchParams.get('after'), before = url.searchParams.get('before');
  const col = collection(firestore, 'conversations', params.id, 'messages');
  let docs;
  try {
    if (after !== null) docs = (await getDocs(query(col, where('seq', '>', Number(after) || 0), orderBy('seq', 'asc'), limit(lim)))).docs;
    else {
      const cond = before !== null ? [where('seq', '<', Number(before) || 0)] : [];
      docs = (await getDocs(query(col, ...cond, orderBy('seq', 'desc'), limit(lim)))).docs.reverse();
    }
  } catch (e) { denied(e, 'not_found', 'トークが見つかりません', 404); }
  return { messages: docs.map(d => msgJson(d.id, params.id, d.data())) };
});

route('POST', '/api/conversations/:id/messages', async ({ uid, params, body }) => {
  const v = validateMessageBody(body); // 送る前に端末で検査（お手本・認識文字などの未知の項目は拒否）
  const cid = params.id;
  const mid = 'm_' + (await sha256hex(uid + ':' + v.clientMessageId)).slice(0, 22); // 同じ送信は同じ ID＝二重にならない
  const convRef = doc(firestore, 'conversations', cid);
  const msgRef = doc(firestore, 'conversations', cid, 'messages', mid);
  let dup = false;
  try {
    await runTransaction(firestore, async tx => {
      dup = false;
      const cs = await tx.get(convRef);
      if (!cs.exists() || !cs.data().members.includes(uid)) throw new ApiError(404, 'not_found', 'トークが見つかりません');
      const c = cs.data();
      if ((await tx.get(msgRef)).exists()) { dup = true; return; }
      if (c.members.length !== 2) throw new ApiError(410, 'partner_gone', '相手はKOKOを退会しました');
      const seq = (c.msgSeq || 0) + 1;
      tx.update(convRef, { msgSeq: seq, last: { senderId: uid, serverTimestamp: serverTimestamp(), seq } });
      tx.set(msgRef, {
        seq, senderId: uid, clientMessageId: v.clientMessageId, serverTimestamp: serverTimestamp(), payloadVersion: 1,
        tokens: JSON.stringify(v.tokens), altText: v.altText, deliveredAt: null,
      });
    });
  } catch (e) { denied(e, 'blocked', 'このトークには送れません'); }
  const snap = await getDoc(msgRef);
  if (!dup) metric('message_sent', uid, cid, v.composeMs);
  return { message: msgJson(mid, cid, snap.data()), duplicate: dup };
});

route('POST', '/api/conversations/:id/delivered', async ({ uid, params, body }) => {
  const ids = (Array.isArray(body.messageIds) ? body.messageIds : []).filter(x => typeof x === 'string' && /^m_[A-Za-z0-9_-]+$/.test(x)).slice(0, 200);
  const col = collection(firestore, 'conversations', params.id, 'messages');
  const todo = [];
  try {
    for (const part of chunk(ids, 30)) {
      const s = await getDocs(query(col, where(documentId(), 'in', part)));
      for (const d of s.docs) if (d.data().senderId !== uid && !d.data().deliveredAt) todo.push(d.ref);
    }
    for (const part of chunk(todo, 400)) { const b = writeBatch(firestore); part.forEach(r => b.update(r, { deliveredAt: serverTimestamp() })); await b.commit(); }
  } catch (e) { denied(e, 'not_found', 'トークが見つかりません', 404); }
  return { ok: true, count: todo.length };
});

route('POST', '/api/blocks', async ({ uid, body }) => {
  const tid = typeof body.userId === 'string' && /^[A-Za-z0-9_-]+$/.test(body.userId) ? body.userId : null;
  const nf = new ApiError(404, 'not_found', '相手が見つかりません');
  if (!tid || tid === uid) throw nf;
  if (!(await myConvs(uid)).some(d => d.data().members.includes(tid))) throw nf;
  await setDoc(doc(firestore, 'blocks', `${uid}_${tid}`), { blockerId: uid, blockedId: tid, createdAt: Date.now() });
  return { ok: true };
});

route('DELETE', '/api/blocks/:id', async ({ uid, params }) => {
  await deleteDoc(doc(firestore, 'blocks', `${uid}_${params.id}`));
  return { ok: true };
});

route('POST', '/api/reports', async ({ uid, body }) => {
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : '';
  let convId = null, messageId = null, reported = null;
  const convs = await myConvs(uid);
  if (typeof body.messageId === 'string' && /^m_[A-Za-z0-9_-]+$/.test(body.messageId)) {
    for (const c of convs) {
      const m = await getDoc(doc(c.ref, 'messages', body.messageId));
      if (m.exists()) { convId = c.id; messageId = m.id; reported = m.data().senderId; break; }
    }
    if (!convId) throw new ApiError(404, 'not_found', 'メッセージが見つかりません');
  } else if (typeof body.conversationId === 'string') {
    const c = convs.find(d => d.id === body.conversationId);
    if (!c) throw new ApiError(404, 'not_found', 'トークが見つかりません');
    convId = c.id; reported = c.data().members.find(x => x !== uid) || null;
  } else throw new ApiError(400, 'report_target', '通報の対象がありません');
  await addDoc(collection(firestore, 'reports'), { reporterId: uid, messageId, reportedUserId: reported, conversationId: convId, reason, createdAt: Date.now() });
  return { ok: true };
});

export async function api(method, path, body) {
  await auth.authStateReady();
  if (path === '/api/logout') { try { await signOut(auth); } catch {} return { ok: true }; }
  const url = new URL(path, 'http://local');
  const r = routes.find(x => x.method === method && x.re.test(url.pathname));
  if (!r) throw new ApiError(404, 'not_found', '見つかりません');
  const uid = auth.currentUser ? auth.currentUser.uid : null;
  if (!uid && !r.public) throw new ApiError(401, 'unauthorized', 'ログインが必要です');
  try {
    return await r.fn({ uid, body: body && typeof body === 'object' ? body : {}, params: r.re.exec(url.pathname).groups || {}, url });
  } catch (e) {
    let ae = toApiError(e);
    if (uid && String((e && e.code) || '').includes('permission-denied')) {
      let alive = true;
      try { await getDoc(doc(firestore, 'users', uid)); } catch { alive = false; }
      if (!alive) ae = new ApiError(401, 'unauthorized', 'ログインが必要です'); // 全端末ログアウト済みなど
      else if (e.kokoDenied) ae = e.kokoDenied;
    }
    if (ae.status === 401 && ae.code === 'unauthorized') { try { await signOut(auth); } catch {} }
    throw ae;
  }
}

// ---------- リアルタイム受信 ----------
// 3種類を購読する: 自分のユーザー文書（全端末ログアウトの検知）／自分のトーク一覧（新しいトーク・相手の退会）／
// 各トークの直近30件（新着・「届きました」）。つなぎ直すたびに 'hello' を出す（app.js が一覧と送信待ちを取り直す）。
export class Live {
  constructor({ onEvent, onState }) {
    this.onEvent = onEvent; this.onState = onState;
    this.unsubs = []; this.msgUnsubs = new Map(); this.memberCount = new Map(); this.deliveredSeen = new Set();
    this.retry = 1000; this.timer = null; this.stopped = true; this.state = 'idle'; this.needHello = true;
    this.onOffline = () => this.setState('offline');
  }
  setState(s) { if (s !== this.state) { this.state = s; this.onState?.(s); } }
  start() { this.stopped = false; addEventListener('offline', this.onOffline); this.connect(); }
  stop() {
    this.stopped = true; clearTimeout(this.timer); this.timer = null;
    this.cleanup();
    removeEventListener('offline', this.onOffline);
    this.setState('idle');
  }
  cleanup() {
    for (const u of this.unsubs) try { u(); } catch {}
    for (const u of this.msgUnsubs.values()) try { u(); } catch {}
    this.unsubs = []; this.msgUnsubs.clear(); this.memberCount.clear();
  }
  onErr(err) {
    if (this.stopped) return;
    const c = String((err && err.code) || '');
    if (c.includes('permission-denied') || c.includes('unauthenticated')) { this.onEvent('closed', null); return; } // app が /api/me で確認する
    if (this.timer) return;
    this.setState(navigator.onLine === false ? 'offline' : 'reconnecting');
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, this.retry);
    this.retry = Math.min(30000, this.retry * 2);
    this.onEvent('closed', null);
  }
  async connect() {
    if (this.stopped) return;
    this.cleanup();
    await auth.authStateReady();
    const uid = auth.currentUser && auth.currentUser.uid;
    if (!uid) { this.onEvent('closed', null); return; }
    this.setState(navigator.onLine === false ? 'offline' : 'connecting');
    this.needHello = true;
    const err = e => this.onErr(e);

    // 1) 全端末ログアウトの検知
    this.unsubs.push(onSnapshot(doc(firestore, 'users', uid), async snap => {
      const rb = snap.exists() ? snap.data().revokedBefore : null;
      if (!rb || typeof rb.toMillis !== 'function' || !auth.currentUser) return;
      const r = await auth.currentUser.getIdTokenResult();
      if (rb.toMillis() > Date.parse(r.authTime)) this.onEvent('logout', {});
    }, err));

    // 2) トーク一覧
    const cq = query(collection(firestore, 'conversations'), where('members', 'array-contains', uid));
    this.unsubs.push(onSnapshot(cq, { includeMetadataChanges: true }, snap => {
      if (this.stopped) return;
      if (snap.metadata.fromCache) { this.setState(navigator.onLine === false ? 'offline' : 'reconnecting'); this.needHello = true; return; }
      const first = this.needHello;
      for (const ch of snap.docChanges()) {
        const cid = ch.doc.id, d = ch.doc.data();
        if (ch.type === 'removed') { this.msgUnsubs.get(cid)?.(); this.msgUnsubs.delete(cid); this.memberCount.delete(cid); continue; }
        const prev = this.memberCount.get(cid);
        this.memberCount.set(cid, d.members.length);
        this.watchMessages(cid, uid);
        if (first) continue;
        if (ch.type === 'added') convFull(cid, d, uid).then(c => this.onEvent('conversation', c)).catch(() => {});
        else if (prev != null && d.members.length < prev) this.onEvent('partner_left', { conversationId: cid });
      }
      this.retry = 1000;
      this.setState('online');
      if (first) { this.needHello = false; this.onEvent('hello', { latestEventSeq: 0, replayed: 0, resync: false }); }
    }, err));
  }
  watchMessages(cid, uid) {
    if (this.msgUnsubs.has(cid)) return;
    const q = query(collection(firestore, 'conversations', cid, 'messages'), orderBy('seq', 'desc'), limit(30));
    let initial = true;
    this.msgUnsubs.set(cid, onSnapshot(q, snap => {
      if (this.stopped) return;
      const wasInitial = initial; initial = false;
      const changes = snap.docChanges().sort((a, b) => a.doc.data().seq - b.doc.data().seq);
      for (const ch of changes) {
        const d = ch.doc.data(), id = ch.doc.id;
        if (ch.doc.metadata.hasPendingWrites) continue;
        if (d.senderId === uid && d.deliveredAt && !this.deliveredSeen.has(id)) { // 自分の送信が「届いた」
          this.deliveredSeen.add(id);
          this.onEvent('delivered', { conversationId: cid, messageIds: [id], deliveredAt: tsMs(d.deliveredAt) });
        }
        if (!wasInitial && ch.type === 'added') this.onEvent('message', msgJson(id, cid, d)); // 最初の一括分は app 側が取得するので出さない
      }
    }, e => this.onErr(e)));
  }
}