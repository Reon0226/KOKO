'use strict';
// KOKO MVP サーバー。Node.js 22 標準機能のみ（http / crypto / node:sqlite）。
// - 認証: 端末ごとのセッション（HttpOnly Cookie）。引き継ぎコードで別端末・再ログイン。
// - 招待: 本人が作るリンク（1回限り・7日で失効）。連絡先は集めない。
// - 1対1チャット、SSE（Last-Event-ID で取りこぼし再送）、clientMessageId で重複排除、配信状態。
// - payload 検証（送信者・参加権限・サイズ・点数・座標・未知の項目）。

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb } = require('./db');
const { LIMITS, ValidationError, validateMessageBody, validateName } = require('./validate');

const DAY = 24 * 3600 * 1000;
const SESSION_TTL = 30 * DAY;
const INVITE_TTL = 7 * DAY;
const EVENT_TTL = 30 * DAY;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rid = (n = 16) => crypto.randomBytes(n).toString('base64url');
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい I O 0 1 を除く
function loginCode() {
  const b = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += B32[b[i] % 32];
  return s.match(/.{4}/g).join('-');
}
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

function createApp(opts = {}) {
  const db = openDb(opts.dbFile || path.join(__dirname, '..', 'data', 'koko.db'));
  const publicDir = opts.publicDir || path.join(__dirname, '..', 'public');
  const secureCookie = !!opts.secureCookie;
  const now = opts.now || (() => Date.now());
  const streams = new Map(); // userId -> Set<res>
  const rate = new Map();

  const q = {};
  const prep = (name, sql) => { q[name] = db.prepare(sql); };
  prep('userById', 'SELECT * FROM users WHERE id = ?');
  prep('userByLogin', 'SELECT * FROM users WHERE login_hash = ?');
  prep('insUser', 'INSERT INTO users (id, name, login_hash, notify, created_at) VALUES (?, ?, ?, 1, ?)');
  prep('insSession', 'INSERT INTO sessions (token_hash, user_id, created_at, last_seen, label) VALUES (?, ?, ?, ?, ?)');
  prep('session', 'SELECT * FROM sessions WHERE token_hash = ?');
  prep('touchSession', 'UPDATE sessions SET last_seen = ? WHERE token_hash = ?');
  prep('delSession', 'DELETE FROM sessions WHERE token_hash = ?');
  prep('delSessionsOf', 'DELETE FROM sessions WHERE user_id = ?');
  prep('isMember', 'SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ?');
  prep('membersOf', 'SELECT user_id FROM members WHERE conversation_id = ?');
  prep('convsOf', `SELECT c.id, c.created_at FROM conversations c JOIN members m ON m.conversation_id = c.id WHERE m.user_id = ?`);
  prep('lastMsg', 'SELECT sender_id, server_ts, seq FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1');
  prep('pairConv', `SELECT a.conversation_id AS id FROM members a JOIN members b ON a.conversation_id = b.conversation_id
                    WHERE a.user_id = ? AND b.user_id = ? AND (SELECT COUNT(*) FROM members c WHERE c.conversation_id = a.conversation_id) = 2`);
  prep('insConv', 'INSERT INTO conversations (id, created_at) VALUES (?, ?)');
  prep('insMember', 'INSERT OR IGNORE INTO members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)');
  prep('insInvite', 'INSERT INTO invites (code_hash, inviter_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
  prep('invite', 'SELECT * FROM invites WHERE code_hash = ?');
  prep('useInvite', 'UPDATE invites SET used_by = ?, used_at = ?, conversation_id = ? WHERE code_hash = ? AND used_by IS NULL');
  prep('activeInvites', 'SELECT COUNT(*) AS n FROM invites WHERE inviter_id = ? AND used_by IS NULL AND expires_at > ?');
  prep('msgByClient', 'SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?');
  prep('msgById', 'SELECT * FROM messages WHERE id = ?');
  prep('insMsg', `INSERT INTO messages (id, conversation_id, sender_id, client_message_id, server_ts, payload_version, tokens, alt_text)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  prep('msgsAfter', 'SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?');
  prep('msgsBefore', 'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC');
  prep('receipt', 'SELECT delivered_at FROM receipts WHERE message_id = ? AND user_id != ?');
  prep('insReceipt', 'INSERT OR IGNORE INTO receipts (message_id, user_id, delivered_at) VALUES (?, ?, ?)');
  prep('insEvent', 'INSERT INTO events (user_id, type, data, created_at) VALUES (?, ?, ?, ?)');
  prep('eventsAfter', 'SELECT * FROM events WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT 500');
  prep('maxEvent', 'SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE user_id = ?');
  prep('isBlocked', 'SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)');
  prep('blockedByMe', 'SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?');
  prep('insBlock', 'INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)');
  prep('delBlock', 'DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?');
  prep('insReport', 'INSERT INTO reports (id, reporter_id, message_id, reported_user_id, conversation_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  prep('insMetric', 'INSERT INTO metrics (type, user_id, conversation_id, value, created_at) VALUES (?, ?, ?, ?, ?)');

  const metric = (type, userId, convId, value) => q.insMetric.run(type, userId || null, convId || null, value ?? null, now());

  // ---------- events / SSE ----------
  function emit(userId, type, data) {
    const r = q.insEvent.run(userId, type, JSON.stringify(data), now());
    const seq = Number(r.lastInsertRowid);
    const set = streams.get(userId);
    if (set) for (const res of set) writeEvent(res, seq, type, data);
  }
  function writeEvent(res, seq, type, data) {
    res.write(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function closeStreams(userId, sessionHash) {
    const set = streams.get(userId);
    if (!set) return;
    for (const res of set) if (!sessionHash || res.kokoSession === sessionHash) { try { writeEvent(res, 0, 'logout', {}); res.end(); } catch {} }
  }

  // ---------- helpers ----------
  function msgJson(m, viewerId) {
    const rc = q.receipt.get(m.id, m.sender_id);
    return {
      id: m.id, seq: Number(m.seq), conversationId: m.conversation_id, senderId: m.sender_id,
      clientMessageId: m.client_message_id, serverTimestamp: Number(m.server_ts), payloadVersion: Number(m.payload_version),
      tokens: JSON.parse(m.tokens), altText: m.alt_text || null,
      deliveredAt: rc ? Number(rc.delivered_at) : null,
    };
  }
  function partnerOf(convId, userId) {
    const ms = q.membersOf.all(convId).map(r => r.user_id).filter(id => id !== userId);
    return ms[0] ? q.userById.get(ms[0]) : null;
  }
  function convJson(convId, userId, createdAt) {
    const p = partnerOf(convId, userId);
    const last = q.lastMsg.get(convId);
    return {
      id: convId, createdAt: Number(createdAt),
      partner: p ? { id: p.id, name: p.name } : null,
      blockedByMe: p ? !!q.blockedByMe.get(userId, p.id) : false,
      last: last ? { senderId: last.sender_id, serverTimestamp: Number(last.server_ts), seq: Number(last.seq) } : null,
    };
  }
  function requireMember(convId, userId) {
    if (typeof convId !== 'string' || !q.isMember.get(convId, userId)) throw new HttpError(404, 'not_found', 'トークが見つかりません');
  }
  function limit(key, max, windowMs) {
    const t = now();
    const e = rate.get(key);
    if (!e || t - e.start > windowMs) { rate.set(key, { start: t, n: 1 }); return; }
    if (++e.n > max) throw new HttpError(429, 'rate_limited', '少し時間をおいてから試してください');
  }
  function newSession(res, userId, label) {
    const token = rid(32);
    const t = now();
    q.insSession.run(sha(token), userId, t, t, String(label || '').slice(0, 120));
    setCookie(res, token, SESSION_TTL / 1000);
  }
  function setCookie(res, token, maxAge) {
    const parts = [`koko_sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAge)}`];
    if (secureCookie) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
  function getAuth(req) {
    const m = /(?:^|;\s*)koko_sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
    if (!m) return null;
    const h = sha(m[1]);
    const s = q.session.get(h);
    if (!s) return null;
    const t = now();
    if (t - Number(s.last_seen) > SESSION_TTL) { q.delSession.run(h); return null; }
    if (t - Number(s.last_seen) > 60000) q.touchSession.run(t, h);
    const user = q.userById.get(s.user_id);
    return user ? { user, sessionHash: h } : null;
  }
  function needAuth(req) {
    const a = getAuth(req);
    if (!a) throw new HttpError(401, 'unauthorized', 'ログインが必要です');
    return a;
  }
  function userJson(u) { return { id: u.id, name: u.name, notify: !!u.notify, createdAt: Number(u.created_at) }; }

  function deleteAccount(user) {
    const convs = q.convsOf.all(user.id);
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM messages WHERE sender_id = ?').run(user.id);
      db.prepare('DELETE FROM receipts WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM members WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?').run(user.id, user.id);
      db.prepare('DELETE FROM events WHERE user_id = ?').run(user.id);
      db.prepare('UPDATE metrics SET user_id = NULL WHERE user_id = ?').run(user.id);
      db.prepare('UPDATE reports SET reporter_id = \'deleted\' WHERE reporter_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id); // sessions / invites は CASCADE
      for (const c of convs) {
        const rest = q.membersOf.all(c.id);
        if (!rest.length) db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    for (const c of convs) for (const r of q.membersOf.all(c.id)) emit(r.user_id, 'partner_left', { conversationId: c.id });
    closeStreams(user.id);
  }

  function prune() {
    const t = now();
    db.prepare('DELETE FROM events WHERE created_at < ?').run(t - EVENT_TTL);
    db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(t - SESSION_TTL);
    db.prepare('DELETE FROM invites WHERE used_by IS NULL AND expires_at < ?').run(t - DAY);
    for (const [k, v] of rate) if (t - v.start > 3600000) rate.delete(k);
  }
  const pruneTimer = setInterval(prune, 3600000); pruneTimer.unref();

  // ---------- routing ----------
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9_-]+)') + '$'), fn });

  route('GET', '/api/health', () => ({ ok: true, payloadVersion: LIMITS.payloadVersion }));

  route('POST', '/api/register', ({ req, res, body, ip }) => {
    limit('reg:' + ip, 20, 3600000);
    const name = validateName(body.name);
    const id = 'u_' + rid(12);
    const code = loginCode();
    q.insUser.run(id, name, sha(normCode(code)), now());
    newSession(res, id, req.headers['user-agent']);
    metric('register', id);
    return { status: 201, body: { user: userJson(q.userById.get(id)), loginCode: code } };
  });

  route('POST', '/api/login', ({ req, res, body, ip }) => {
    limit('login:' + ip, 15, 600000);
    const u = q.userByLogin.get(sha(normCode(body.loginCode)));
    if (!u) throw new HttpError(401, 'bad_code', '引き継ぎコードが違います');
    newSession(res, u.id, req.headers['user-agent']);
    return { user: userJson(u) };
  });

  route('POST', '/api/logout', ({ req, res }) => {
    const a = getAuth(req);
    if (a) { q.delSession.run(a.sessionHash); closeStreams(a.user.id, a.sessionHash); }
    setCookie(res, '', 0);
    return { ok: true };
  });

  route('POST', '/api/logout-all', ({ req, res }) => {
    const a = needAuth(req);
    q.delSessionsOf.run(a.user.id);
    closeStreams(a.user.id);
    setCookie(res, '', 0);
    return { ok: true };
  });

  route('GET', '/api/me', ({ req }) => {
    const a = needAuth(req);
    return { user: userJson(a.user), latestEventSeq: Number(q.maxEvent.get(a.user.id).seq) };
  });

  route('PATCH', '/api/me', ({ req, body }) => {
    const a = needAuth(req);
    if (body.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(validateName(body.name), a.user.id);
    if (body.notify !== undefined) db.prepare('UPDATE users SET notify = ? WHERE id = ?').run(body.notify ? 1 : 0, a.user.id);
    return { user: userJson(q.userById.get(a.user.id)) };
  });

  route('POST', '/api/me/login-code', ({ req }) => {
    const a = needAuth(req);
    const code = loginCode();
    db.prepare('UPDATE users SET login_hash = ? WHERE id = ?').run(sha(normCode(code)), a.user.id);
    return { loginCode: code };
  });

  route('DELETE', '/api/me', ({ req, res, body }) => {
    const a = needAuth(req);
    if (body.confirm !== 'DELETE') throw new HttpError(400, 'confirm', '確認が必要です');
    deleteAccount(a.user);
    setCookie(res, '', 0);
    return { ok: true };
  });

  route('POST', '/api/invites', ({ req }) => {
    const a = needAuth(req);
    limit('inv:' + a.user.id, 30, 3600000);
    if (q.activeInvites.get(a.user.id, now()).n >= 20) throw new HttpError(429, 'too_many_invites', '未使用の招待が多すぎます');
    const code = rid(18);
    const t = now();
    q.insInvite.run(sha(code), a.user.id, t, t + INVITE_TTL);
    metric('invite_created', a.user.id);
    return { status: 201, body: { code, expiresAt: t + INVITE_TTL } };
  });

  function loadInvite(code) {
    const inv = q.invite.get(sha(String(code)));
    if (!inv) throw new HttpError(404, 'invite_invalid', 'この招待は見つかりません');
    if (inv.used_by) throw new HttpError(410, 'invite_used', 'この招待はすでに使われています');
    if (Number(inv.expires_at) < now()) throw new HttpError(410, 'invite_expired', 'この招待は期限切れです');
    const inviter = q.userById.get(inv.inviter_id);
    if (!inviter) throw new HttpError(410, 'invite_invalid', 'この招待は使えません');
    return { inv, inviter };
  }

  route('GET', '/api/invites/:code', ({ params, ip }) => {
    limit('invq:' + ip, 60, 600000);
    const { inv, inviter } = loadInvite(params.code);
    return { inviterName: inviter.name, expiresAt: Number(inv.expires_at) };
  });

  route('POST', '/api/invites/:code/accept', ({ req, params, ip }) => {
    const a = needAuth(req);
    limit('inva:' + ip, 30, 600000);
    const { inv, inviter } = loadInvite(params.code);
    if (inviter.id === a.user.id) throw new HttpError(400, 'invite_self', '自分の招待は使えません。相手に送ってください');
    if (q.isBlocked.get(a.user.id, inviter.id, inviter.id, a.user.id)) throw new HttpError(403, 'blocked', 'この招待は使えません');
    let convId = q.pairConv.get(a.user.id, inviter.id)?.id;
    const t = now();
    db.exec('BEGIN');
    try {
      if (!convId) {
        convId = 'c_' + rid(12);
        q.insConv.run(convId, t);
        q.insMember.run(convId, inviter.id, t);
        q.insMember.run(convId, a.user.id, t);
      }
      const r = q.useInvite.run(a.user.id, t, convId, inv.code_hash);
      if (r.changes !== 1) throw new HttpError(410, 'invite_used', 'この招待はすでに使われています');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    metric('invite_accepted', a.user.id, convId);
    const c = db.prepare('SELECT created_at FROM conversations WHERE id = ?').get(convId);
    emit(inviter.id, 'conversation', convJson(convId, inviter.id, c.created_at));
    emit(a.user.id, 'conversation', convJson(convId, a.user.id, c.created_at));
    return { conversation: convJson(convId, a.user.id, c.created_at) };
  });

  route('GET', '/api/conversations', ({ req }) => {
    const a = needAuth(req);
    const list = q.convsOf.all(a.user.id).map(c => convJson(c.id, a.user.id, c.created_at));
    list.sort((x, y) => (y.last?.serverTimestamp || y.createdAt) - (x.last?.serverTimestamp || x.createdAt));
    return { conversations: list };
  });

  route('GET', '/api/conversations/:id/messages', ({ req, params, url }) => {
    const a = needAuth(req);
    requireMember(params.id, a.user.id);
    const lim = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
    const after = url.searchParams.get('after');
    const before = url.searchParams.get('before');
    let rows;
    if (after !== null) rows = q.msgsAfter.all(params.id, Number(after) || 0, lim);
    else rows = q.msgsBefore.all(params.id, before !== null ? Number(before) || 0 : Number.MAX_SAFE_INTEGER, lim);
    return { messages: rows.map(m => msgJson(m, a.user.id)) };
  });

  route('POST', '/api/conversations/:id/messages', ({ req, params, body }) => {
    const a = needAuth(req);
    requireMember(params.id, a.user.id);
    limit('msg:' + a.user.id, 120, 60000);
    const v = validateMessageBody(body);
    const existing = q.msgByClient.get(a.user.id, v.clientMessageId);
    if (existing) {
      if (existing.conversation_id !== params.id) throw new HttpError(409, 'client_id_conflict', 'clientMessageId が別のトークで使われています');
      return { status: 200, body: { message: msgJson(existing, a.user.id), duplicate: true } };
    }
    const partner = partnerOf(params.id, a.user.id);
    if (!partner) throw new HttpError(410, 'partner_gone', '相手はKOKOを退会しました');
    if (q.isBlocked.get(a.user.id, partner.id, partner.id, a.user.id)) throw new HttpError(403, 'blocked', 'このトークには送れません');
    const id = 'm_' + rid(12);
    const t = now();
    q.insMsg.run(id, params.id, a.user.id, v.clientMessageId, t, v.payloadVersion, JSON.stringify(v.tokens), v.altText);
    const msg = msgJson(q.msgById.get(id), a.user.id);
    metric('message_sent', a.user.id, params.id, v.composeMs);
    for (const r of q.membersOf.all(params.id)) emit(r.user_id, 'message', msg);
    return { status: 201, body: { message: msg, duplicate: false } };
  });

  route('POST', '/api/conversations/:id/delivered', ({ req, params, body }) => {
    const a = needAuth(req);
    requireMember(params.id, a.user.id);
    const ids = Array.isArray(body.messageIds) ? body.messageIds.slice(0, 200) : [];
    const t = now();
    const bySender = new Map();
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const m = q.msgById.get(id);
      if (!m || m.conversation_id !== params.id || m.sender_id === a.user.id) continue;
      if (q.insReceipt.run(id, a.user.id, t).changes) {
        if (!bySender.has(m.sender_id)) bySender.set(m.sender_id, []);
        bySender.get(m.sender_id).push(id);
      }
    }
    for (const [sender, mids] of bySender) emit(sender, 'delivered', { conversationId: params.id, messageIds: mids, deliveredAt: t });
    return { ok: true, count: [...bySender.values()].reduce((s, x) => s + x.length, 0) };
  });

  route('POST', '/api/blocks', ({ req, body }) => {
    const a = needAuth(req);
    const target = typeof body.userId === 'string' ? q.userById.get(body.userId) : null;
    if (!target || target.id === a.user.id) throw new HttpError(404, 'not_found', '相手が見つかりません');
    if (!q.pairConv.get(a.user.id, target.id)) throw new HttpError(404, 'not_found', '相手が見つかりません');
    q.insBlock.run(a.user.id, target.id, now());
    return { ok: true };
  });

  route('DELETE', '/api/blocks/:id', ({ req, params }) => {
    const a = needAuth(req);
    q.delBlock.run(a.user.id, params.id);
    return { ok: true };
  });

  route('POST', '/api/reports', ({ req, body }) => {
    const a = needAuth(req);
    limit('rep:' + a.user.id, 20, 3600000);
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : '';
    let msg = null, convId = null, reported = null;
    if (typeof body.messageId === 'string') {
      msg = q.msgById.get(body.messageId);
      if (!msg) throw new HttpError(404, 'not_found', 'メッセージが見つかりません');
      requireMember(msg.conversation_id, a.user.id);
      convId = msg.conversation_id; reported = msg.sender_id;
    } else if (typeof body.conversationId === 'string') {
      requireMember(body.conversationId, a.user.id);
      convId = body.conversationId; reported = partnerOf(convId, a.user.id)?.id || null;
    } else throw new HttpError(400, 'report_target', '通報の対象がありません');
    q.insReport.run('r_' + rid(10), a.user.id, msg?.id || null, reported, convId, reason, now());
    console.log(`[report] conversation=${convId} message=${msg?.id || '-'} reason=${JSON.stringify(reason)}`);
    return { status: 201, body: { ok: true } };
  });

  // SSE
  function handleEvents(req, res, url) {
    const a = getAuth(req);
    if (!a) { sendJson(res, 401, { error: 'unauthorized', message: 'ログインが必要です' }); return; }
    const lastId = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0) || 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.kokoSession = a.sessionHash;
    res.write('retry: 3000\n\n');
    // 取りこぼしを再送（最大500件。超える場合 resync で全体を取り直す）
    const missed = lastId > 0 ? q.eventsAfter.all(a.user.id, lastId) : [];
    for (const e of missed) writeEvent(res, Number(e.seq), e.type, JSON.parse(e.data));
    const latest = Number(q.maxEvent.get(a.user.id).seq);
    writeEvent(res, latest, 'hello', { latestEventSeq: latest, replayed: missed.length, resync: missed.length >= 500 });
    if (!streams.has(a.user.id)) streams.set(a.user.id, new Set());
    streams.get(a.user.id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); streams.get(a.user.id)?.delete(res); });
  }

  // ---------- http ----------
  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  function sendJson(res, status, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(s);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > LIMITS.maxBodyBytes) { reject(new HttpError(413, 'too_large', 'メッセージが大きすぎます')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!size) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'bad_json', 'JSONが不正です')); }
      });
      req.on('error', reject);
    });
  }
  function serveStatic(req, res, url) {
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '/index.html') p = '/index.html';
    const file = path.normalize(path.join(publicDir, p));
    if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
      const ext = path.extname(file);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  async function handler(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://local');
    const ip = req.socket.remoteAddress || '?';
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method');
        return serveStatic(req, res, url);
      }
      if (url.pathname === '/api/events' && req.method === 'GET') return handleEvents(req, res, url);
      if (req.method !== 'GET') {
        // CSRF 対策: 独自ヘッダー必須（クロスサイトからはプリフライトで止まる）＋ Origin 一致
        if (req.headers['x-koko'] !== '1') throw new HttpError(403, 'csrf', '不正なリクエストです');
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'origin', '不正なリクエストです');
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const body = req.method === 'GET' ? {} : await readBody(req);
        const out = await r.fn({ req, res, body: body && typeof body === 'object' ? body : {}, params: m.groups || {}, url, ip });
        if (out && out.status) return sendJson(res, out.status, out.body);
        return sendJson(res, 200, out);
      }
      throw new HttpError(404, 'not_found', '見つかりません');
    } catch (e) {
      if (e instanceof ValidationError) return sendJson(res, 422, { error: e.code, message: e.message });
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.code, message: e.message });
      console.error(e);
      return sendJson(res, 500, { error: 'server', message: 'サーバーで問題が起きました' });
    }
  }

  function close() {
    clearInterval(pruneTimer);
    for (const set of streams.values()) for (const r of set) try { r.end(); } catch {}
    db.close();
  }
  return { handler, db, close, emit };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const tlsKey = process.env.TLS_KEY, tlsCert = process.env.TLS_CERT;
  const useTls = !!(tlsKey && tlsCert);
  const app = createApp({ dbFile: process.env.KOKO_DB, secureCookie: useTls || process.env.COOKIE_SECURE === '1' });
  const server = useTls
    ? https.createServer({ key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) }, app.handler)
    : http.createServer(app.handler);
  server.listen(port, host, () => {
    console.log(`KOKO server: ${useTls ? 'https' : 'http'}://${host}:${port}`);
    if (!useTls && host !== '127.0.0.1' && host !== 'localhost') console.log('注意: HTTP で公開しています。実利用では HTTPS（TLS_KEY/TLS_CERT かリバースプロキシ）を使ってください。');
  });
  const stop = () => { server.close(); app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

module.exports = { createApp };
