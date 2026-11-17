'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server/server');

function start() {
  const app = createApp({ dbFile: ':memory:' });
  const server = http.createServer(app.handler);
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ app, server, base: `http://127.0.0.1:${server.address().port}` })));
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, path, body, extra = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-KOKO': '1', ...extra };
    if (this.cookie) headers.Cookie = this.cookie;
    const r = await fetch(this.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) { const m = /koko_sid=([^;]*)/.exec(sc); this.cookie = m && m[1] ? `koko_sid=${m[1]}` : ''; }
    const j = await r.json().catch(() => null);
    return { status: r.status, body: j };
  }
}

const ink = (n = 3) => ({ kind: 'ink', strokes: [Array.from({ length: n }, (_, i) => ({ x: i / n, y: 0.5, t: i * 16 }))] });
let seq = 0;
const cid = () => 'cid_' + (++seq).toString().padStart(8, '0');

async function pair(base) {
  const a = new Client(base), b = new Client(base);
  const ra = await a.req('POST', '/api/register', { name: 'あおい' });
  const rb = await b.req('POST', '/api/register', { name: 'りく' });
  const inv = await a.req('POST', '/api/invites');
  const acc = await b.req('POST', `/api/invites/${inv.body.code}/accept`);
  return { a, b, ua: ra.body.user, ub: rb.body.user, loginA: ra.body.loginCode, conv: acc.body.conversation, invCode: inv.body.code };
}

test('認証・招待・1対1・順序と改行の保持・重複排除・配信状態', async t => {
  const { app, server, base } = await start();
  t.after(() => { server.close(); app.close(); });
  const { a, b, ua, ub, conv, invCode, loginA } = await pair(base);
  assert.ok(conv.id);
  assert.equal(conv.partner.name, 'あおい');

  // 招待は1回限り
  const c = new Client(base); await c.req('POST', '/api/register', { name: 'みお' });
  assert.equal((await c.req('POST', `/api/invites/${invCode}/accept`)).status, 410);
  // 自分の招待は使えない
  const inv2 = await a.req('POST', '/api/invites');
  assert.equal((await a.req('POST', `/api/invites/${inv2.body.code}/accept`)).status, 400);

  const tokens = [ink(5), ink(2), { kind: 'space' }, ink(4), { kind: 'newline' }, ink(7)];
  const id = cid();
  const s1 = await a.req('POST', `/api/conversations/${conv.id}/messages`, { clientMessageId: id, payloadVersion: 1, tokens, altText: 'またね' });
  assert.equal(s1.status, 201);
  const m = s1.body.message;
  for (const k of ['id', 'conversationId', 'senderId', 'clientMessageId', 'serverTimestamp', 'payloadVersion', 'tokens']) assert.ok(m[k] !== undefined, k);
  assert.equal(m.senderId, ua.id);
  // 再送しても同じメッセージ（二重にならない）
  const s2 = await a.req('POST', `/api/conversations/${conv.id}/messages`, { clientMessageId: id, payloadVersion: 1, tokens });
  assert.equal(s2.status, 200); assert.equal(s2.body.duplicate, true); assert.equal(s2.body.message.id, m.id);

  const list = await b.req('GET', `/api/conversations/${conv.id}/messages`);
  assert.equal(list.body.messages.length, 1);
  assert.deepEqual(list.body.messages[0].tokens, tokens, '順序・空白・改行・座標がそのまま届く');
  assert.equal(list.body.messages[0].altText, 'またね');
  assert.equal(list.body.messages[0].deliveredAt, null);

  // 配信状態
  const d = await b.req('POST', `/api/conversations/${conv.id}/delivered`, { messageIds: [m.id] });
  assert.equal(d.body.count, 1);
  const again = await a.req('GET', `/api/conversations/${conv.id}/messages`);
  assert.ok(again.body.messages[0].deliveredAt > 0);
  // 自分のメッセージに自分で配信済みは付けられない
  assert.equal((await a.req('POST', `/api/conversations/${conv.id}/delivered`, { messageIds: [m.id] })).body.count, 0);

  // 参加していない人は読めない・送れない
  assert.equal((await c.req('GET', `/api/conversations/${conv.id}/messages`)).status, 404);
  assert.equal((await c.req('POST', `/api/conversations/${conv.id}/messages`, { clientMessageId: cid(), payloadVersion: 1, tokens })).status, 404);

  // ログアウト→引き継ぎコードで再ログイン
  await a.req('POST', '/api/logout');
  assert.equal((await a.req('GET', '/api/me')).status, 401);
  assert.equal((await a.req('POST', '/api/login', { loginCode: loginA.toLowerCase() })).status, 200);
  assert.equal((await a.req('GET', '/api/conversations')).body.conversations.length, 1);
  void ub;
});

test('payload検証: お手本・認識文字・範囲外座標・過大サイズを拒否', async t => {
  const { app, server, base } = await start();
  t.after(() => { server.close(); app.close(); });
  const { a, conv } = await pair(base);
  const post = body => a.req('POST', `/api/conversations/${conv.id}/messages`, { clientMessageId: cid(), payloadVersion: 1, ...body });
  assert.equal((await post({ tokens: [{ ...ink(), guide: '気' }] })).status, 422, 'お手本の文字は入れられない');
  assert.equal((await post({ tokens: [{ ...ink(), recognized: 'き' }] })).status, 422, '認識文字は入れられない');
  assert.equal((await post({ tokens: [ink()], guide: '気持ち' })).status, 422);
  assert.equal((await post({ tokens: [{ kind: 'ink', strokes: [[{ x: 1.2, y: 0 }]] }] })).status, 422);
  assert.equal((await post({ tokens: [{ kind: 'ink', strokes: [[{ x: 0.2, y: 0.1, color: 'red' }]] }] })).status, 422);
  assert.equal((await post({ tokens: [{ kind: 'space' }] })).status, 422, '手書きがない');
  assert.equal((await post({ tokens: [{ kind: 'ink', strokes: [] }] })).status, 422);
  assert.equal((await post({ tokens: Array.from({ length: 301 }, () => ink(1)) })).status, 422);
  assert.equal((await a.req('POST', `/api/conversations/${conv.id}/messages`, { clientMessageId: cid(), payloadVersion: 2, tokens: [ink()] })).status, 422);
  const big = { kind: 'ink', strokes: Array.from({ length: 80 }, () => Array.from({ length: 1100 }, () => ({ x: 0.5, y: 0.5 }))) };
  assert.ok([413, 422].includes((await post({ tokens: [big] })).status));
  // CSRF ヘッダーなしは拒否
  const r = await fetch(base + '/api/invites', { method: 'POST', headers: { Cookie: a.cookie } });
  assert.equal(r.status, 403);
});

test('ブロック・通報・アカウント削除', async t => {
  const { app, server, base } = await start();
  t.after(() => { server.close(); app.close(); });
  const { a, b, ua, ub, conv } = await pair(base);
  const sent = await a.req('POST', `/api/conversations/${conv.id}/messages`, { clientMessageId: cid(), payloadVersion: 1, tokens: [ink()] });
  assert.equal((await b.req('POST', '/api/reports', { messageId: sent.body.message.id, reason: 'test' })).status, 201);
  assert.equal((await b.req('POST', '/api/blocks', { userId: ua.id })).status, 200);
  assert.equal((await a.req('POST', `/api/conversations/${conv.id}/messages`, { clientMessageId: cid(), payloadVersion: 1, tokens: [ink()] })).status, 403);
  assert.equal((await b.req('POST', `/api/conversations/${conv.id}/messages`, { clientMessageId: cid(), payloadVersion: 1, tokens: [ink()] })).status, 403);
  assert.equal((await b.req('DELETE', `/api/blocks/${ua.id}`)).status, 200);
  assert.equal((await a.req('POST', `/api/conversations/${conv.id}/messages`, { clientMessageId: cid(), payloadVersion: 1, tokens: [ink()] })).status, 201);

  assert.equal((await a.req('DELETE', '/api/me', { confirm: 'DELETE' })).status, 200);
  assert.equal((await a.req('GET', '/api/me')).status, 401);
  const after = await b.req('GET', `/api/conversations/${conv.id}/messages`);
  assert.equal(after.body.messages.length, 0, '退会した人の筆跡はサーバーから消える');
  const convs = await b.req('GET', '/api/conversations');
  assert.equal(convs.body.conversations[0].partner, null);
  assert.equal((await b.req('POST', `/api/conversations/${conv.id}/messages`, { clientMessageId: cid(), payloadVersion: 1, tokens: [ink()] })).status, 410);
  void ub;
});

test('SSE: 再接続時に Last-Event-ID 以降を取りこぼさず届ける', async t => {
  const { app, server, base } = await start();
  t.after(() => { server.close(); app.close(); });
  const { a, b, conv } = await pair(base);
  const readEvents = (cookie, lastId, want) => new Promise((resolve, reject) => {
    const req = http.get(base + '/api/events', { headers: { Cookie: cookie, ...(lastId ? { 'Last-Event-ID': String(lastId) } : {}) } }, res => {
      let buf = ''; const evs = [];
      res.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = {}; for (const line of chunk.split('\n')) { const m = /^(id|event|data): (.*)$/.exec(line); if (m) ev[m[1]] = m[2]; }
          if (ev.event) { evs.push(ev); if (evs.filter(e => e.event === want).length >= 1 && ev.event === 'hello') { req.destroy(); resolve(evs); } }
        }
      });
    });
    req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { req.destroy(); resolve([]); }, 3000);
  });
  const first = await readEvents(b.cookie, 0, 'hello');
  const helloSeq = Number(first.find(e => e.event === 'hello').id);
  // b がオフラインの間に 2 通
  for (let i = 0; i < 2; i++) await a.req('POST', `/api/conversations/${conv.id}/messages`, { clientMessageId: cid(), payloadVersion: 1, tokens: [ink()] });
  const replay = await readEvents(b.cookie, helloSeq, 'hello');
  assert.equal(replay.filter(e => e.event === 'message').length, 2);
});
