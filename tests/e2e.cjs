// 二端末 E2E: 別々のブラウザコンテキスト（Cookie・保存領域が別＝別端末相当）で
// 登録→招待→1対1→手書き送信→受信→配信済み→オフライン送信→再接続→重複なし→下書き保護→ログアウト消去 を確認する。
// 使い方: node tests/e2e.cjs [スクリーンショット保存先]
const { chromium, devices } = require('playwright');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createApp } = require('../server/server');

const shots = process.argv[2];
const results = [];
const check = (name, fn) => { fn(); results.push('✔ ' + name); console.log('✔', name); };

async function drawStroke(page, cellIndex, pts, { touch } = {}) {
  const c = page.locator('#composer .cells canvas').nth(cellIndex);
  const bb = await c.boundingBox();
  const P = ([x, y]) => [bb.x + x * bb.width, bb.y + y * bb.height];
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    const [x0, y0] = P(pts[0]);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    for (const p of pts.slice(1)) { const [x, y] = P(p); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    const [x0, y0] = P(pts[0]);
    await page.mouse.move(x0, y0); await page.mouse.down();
    for (const p of pts.slice(1)) { const [x, y] = P(p); await page.mouse.move(x, y, { steps: 4 }); }
    await page.mouse.up();
  }
}
const H = [[0.2, 0.3], [0.8, 0.3]], V = [[0.5, 0.15], [0.5, 0.9]], D = [[0.2, 0.2], [0.8, 0.8]], DOT = [[0.5, 0.5]];
const draftOf = page => page.evaluate(() => {
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('koko:v2:draft:')) return JSON.parse(localStorage.getItem(k)); }
  return null;
});

(async () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'koko-')), 'e2e.db');
  const app = createApp({ dbFile });
  const server = http.createServer(app.handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const mk = async () => {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(e.message));
    return { ctx, page };
  };
  const A = await mk(), B = await mk();
  const shot = async (p, n) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await p.screenshot({ path: path.join(shots, n + '.png') }); } };
  try {
    // --- 登録と招待 ---
    await A.page.goto(base);
    await A.page.fill('#r-name', 'あおい');
    await A.page.click('#f-register button[type=submit]');
    await A.page.click('#code-done');
    await A.page.waitForSelector('#s-home:not([hidden])');
    await A.page.click('#make-invite');
    const url = await A.page.locator('#sheet input').inputValue();
    await shot(A.page, '01-invite');
    await A.page.click('#sheet button[value=close]');
    check('招待リンクは本人の操作で作られる', () => assert.match(url, /#invite=[A-Za-z0-9_-]+$/));

    await B.page.goto(url);
    await B.page.waitForSelector('#w-invite:not([hidden])');
    const banner = await B.page.textContent('#w-invite');
    check('招待された側に招待者の名前が出る', () => assert.match(banner, /あおい/));
    await B.page.fill('#r-name', 'りく');
    await B.page.click('#f-register button[type=submit]');
    await B.page.click('#code-done');
    await B.page.waitForSelector('#s-chat:not([hidden])');
    await A.page.waitForSelector('.conv');
    check('招待を受けると両方の端末にトークができる', () => assert.ok(true));
    await A.page.click('.conv');
    await A.page.waitForSelector('#s-chat:not([hidden])');
    await shot(A.page, '02-empty-chat');

    // --- 手書き（タッチで書いてもページがスクロールしない）---
    const scrollBefore = await A.page.evaluate(() => [scrollY, document.querySelector('.app').scrollTop, document.querySelector('#chat').scrollTop]);
    await drawStroke(A.page, 0, [[0.2, 0.2], [0.4, 0.5], [0.6, 0.7], [0.8, 0.85]], { touch: true });
    const scrollAfter = await A.page.evaluate(() => [scrollY, document.querySelector('.app').scrollTop, document.querySelector('#chat').scrollTop]);
    check('タッチで書いている間、画面がスクロールしない', () => assert.deepEqual(scrollAfter, scrollBefore));
    await drawStroke(A.page, 0, H);           // 1文字目 2画目
    await drawStroke(A.page, 1, V);           // 2文字目（隣のマスに書き始めると次の字になる）
    await drawStroke(A.page, 1, DOT);         // 点
    let d = await draftOf(A.page);
    check('1マス1文字・画の順序どおりに記録（2文字・2画ずつ）', () => { assert.equal(d.tokens.length, 2); assert.deepEqual(d.tokens.map(t => t.strokes.length), [2, 2]); });
    check('点は0〜1の正規化座標、時刻付き', () => d.tokens.flatMap(t => t.strokes.flat()).forEach(p => { assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1); assert.ok(Number.isInteger(p.t)); }));

    // マス移動後も線が残る
    await A.page.click('#composer .pg >> nth=0'); // ‹
    await A.page.click('#composer .pg >> nth=1'); // ›
    d = await draftOf(A.page);
    check('マスを移動しても書いた線は残る', () => assert.deepEqual(d.tokens.map(t => t.strokes.length), [2, 2]));

    // お手本を選んでも本文は増えない
    const before = JSON.stringify((await draftOf(A.page)).tokens);
    await A.page.click('#composer .cand >> text=気持ち');
    const after = JSON.stringify((await draftOf(A.page)).tokens);
    const targets = await A.page.locator('#composer .cell .target').allTextContents();
    await shot(A.page, '03-guide');
    check('お手本を選んでも下書きの線・文字は増えない', () => assert.equal(after, before));
    check('お手本はマスの背景に薄く表示される', () => assert.ok(targets.join('').includes('気')));

    // 空白・改行・undo・削除
    await A.page.click('#composer .tool.space');
    await drawStroke(A.page, 0, D); // 3文字目は新しいページのマス（‹›でページが変わる）
    d = await draftOf(A.page);
    await A.page.click('#composer .tool.nl');
    await drawStroke(A.page, 2, H);
    await drawStroke(A.page, 2, V);
    d = await draftOf(A.page);
    check('空白・改行は別の token になる', () => assert.deepEqual(d.tokens.map(t => t.kind), ['ink', 'ink', 'space', 'ink', 'newline', 'ink']));
    const tg = await A.page.locator('#composer .cell .target').allTextContents();
    check('お手本は空白・改行のマスを飛ばして続く（気・改行・持）', () => assert.deepEqual(tg, ['気', '', '持']));
    await A.page.click('#composer .tool.undo');
    d = await draftOf(A.page);
    check('↶ 戻すは直前の1画だけを取り消す（他の文字は壊さない）', () => { assert.equal(d.tokens[5].strokes.length, 1); assert.deepEqual(d.tokens.slice(0, 2).map(t => t.strokes.length), [2, 2]); });
    await A.page.click('#composer .tool.del');
    d = await draftOf(A.page);
    const afterDel = d.tokens.map(t => t.kind);
    await A.page.click('#composer .tool.undo');
    d = await draftOf(A.page);
    check('⌫ で1字消え、↶ で元に戻せる', () => { assert.deepEqual(afterDel, ['ink', 'ink', 'space', 'ink', 'newline']); assert.equal(d.tokens.length, 6); });
    await drawStroke(A.page, 2, V); // 2画目を書き直す
    await shot(A.page, '04-composed');

    // --- 送信。送られる payload を記録 ---
    let sentBody = null;
    A.page.on('request', r => { if (r.method() === 'POST' && /\/messages$/.test(r.url())) sentBody = JSON.parse(r.postData()); });
    const draftTokens = (await draftOf(A.page)).tokens;
    await A.page.click('#composer .tool.send');
    await A.page.waitForSelector('#chat .msg.mine:not(.pending)');
    check('送信 payload にはお手本・認識文字・マスの情報が入らない', () => {
      assert.deepEqual(Object.keys(sentBody).sort(), ['clientMessageId', 'composeMs', 'payloadVersion', 'tokens'].sort());
      const s = JSON.stringify(sentBody.tokens);
      assert.ok(!/guide|target|気|recog|cell/.test(s));
      assert.deepEqual(sentBody.tokens, draftTokens);
    });
    const emptied = await draftOf(A.page);
    check('送信後、下書きは空になる', () => assert.equal(emptied, null));

    // --- 受信側 ---
    await B.page.waitForSelector('#chat .msg:not(.mine)');
    const conv = await B.page.evaluate(async () => (await (await fetch('/api/conversations')).json()).conversations[0].id);
    const got = await B.page.evaluate(async c => (await (await fetch(`/api/conversations/${c}/messages`)).json()).messages, conv);
    check('相手の端末に同じ順序・空白・改行・座標で届く', () => assert.deepEqual(got[0].tokens, sentBody.tokens));
    const domKinds = await B.page.$$eval('#chat .msg:not(.mine) .inkflow > span', els => els.map(e => e.className));
    check('相手の画面でも 字・空白・改行 の並びが同じ', () => assert.deepEqual(domKinds, ['glyph', 'glyph', 'sp', 'glyph', 'br', 'glyph']));
    await A.page.waitForSelector('#chat .msg.mine .st >> text=届きました', { timeout: 5000 });
    check('配信状態: 相手の端末に届くと「届きました」になる', () => assert.ok(true));
    await shot(B.page, '05-received');

    // --- オフライン送信 → 再接続 → 1回だけ届く ---
    await A.ctx.setOffline(true);
    await drawStroke(A.page, 0, D);
    await drawStroke(A.page, 0, [[0.8, 0.2], [0.2, 0.8]]);
    await A.page.click('#composer .tool.send');
    await A.page.waitForSelector('#chat .msg.pending .st >> text=/未送信/');
    const outbox = await A.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('koko:v2:outbox')).map(k => JSON.parse(localStorage.getItem(k)).length));
    await shot(A.page, '06-offline');
    check('オフラインで送ると「未送信」と表示し、送信待ちを端末に保存', () => assert.deepEqual(outbox, [1]));
    await A.ctx.setOffline(false);
    await A.page.waitForSelector('#chat .msg.pending', { state: 'detached', timeout: 15000 });
    await B.page.waitForFunction(() => document.querySelectorAll('#chat .msg:not(.mine)').length === 2, null, { timeout: 15000 });
    // 同じ clientMessageId で再送しても増えない
    const dup = await A.page.evaluate(async ([c, body]) => {
      const r = await fetch(`/api/conversations/${c}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-KOKO': '1' }, body: JSON.stringify(body) });
      return r.status;
    }, [conv, sentBody]);
    await B.page.waitForTimeout(500);
    const countB = await B.page.locator('#chat .msg:not(.mine)').count();
    const countA = await A.page.locator('#chat .msg.mine').count();
    check('再接続すると自動で送られ、二重表示にならない（再送も 200 で同じもの）', () => { assert.equal(dup, 200); assert.equal(countB, 2); assert.equal(countA, 2); });

    // --- 下書き保護（再読み込みしても残る）---
    await drawStroke(B.page, 0, H);
    await B.page.reload();
    await B.page.waitForSelector('.conv');
    await B.page.click('.conv');
    await B.page.waitForSelector('#s-chat:not([hidden])');
    const bDraft = await draftOf(B.page);
    const bGlyphs = await B.page.locator('#composer .draft .glyph').count();
    check('画面を閉じても下書きは端末に残る', () => { assert.equal(bDraft.tokens.length, 1); assert.equal(bGlyphs, 1); });

    // --- 左手向き・マスの数 ---
    await B.page.click('#back'); await B.page.click('#to-settings');
    await B.page.click('#st-hand button >> text=左手向き');
    await B.page.click('#st-cells button >> text=2');
    await B.page.click('#settings-back'); await B.page.click('.conv');
    const n = await B.page.locator('#composer .cells .cell').count();
    const lefty = await B.page.locator('#composer.lefty').count();
    await shot(B.page, '07-lefty');
    check('設定でマスの数と左手向きの配置を変えられる', () => { assert.equal(n, 2); assert.equal(lefty, 1); });

    // --- ログアウトで端末内のデータを消す ---
    await B.page.click('#back'); await B.page.click('#to-settings'); await B.page.click('#st-logout');
    await B.page.click('#sheet button[value=yes]');
    await B.page.waitForSelector('#s-welcome:not([hidden])');
    const keys = await B.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('koko:')));
    const me = await B.page.evaluate(async () => (await fetch('/api/me')).status);
    check('ログアウトすると下書き・送信待ちが端末から消え、会話は見られない', () => { assert.deepEqual(keys, []); assert.equal(me, 401); });

    await A.page.click('#chat', { position: { x: 30, y: 30 } });
    const collapsed = await A.page.locator('#composer.collapsed').count();
    await shot(A.page, '08-collapsed');
    await A.page.click('#composer .expand');
    const expanded = await A.page.locator('#composer:not(.collapsed) .cells canvas').count();
    check('会話をタップするとマスがしまえ、「マスを出して書く」で戻る', () => { assert.equal(collapsed, 1); assert.equal(expanded, 3); });

    // --- オフラインで開き直す（Service Worker 有効の別端末 C）---
    const cctx = await browser.newContext({ ...devices['Pixel 7'] });
    const C = await cctx.newPage();
    C.errors = []; C.on('pageerror', e => C.errors.push(e.message));
    const inv = await A.page.evaluate(async () => (await (await fetch('/api/invites', { method: 'POST', headers: { 'X-KOKO': '1' } })).json()).code);
    await C.goto(`${base}/#invite=${inv}`);
    await C.fill('#r-name', 'みお'); await C.click('#f-register button[type=submit]'); await C.click('#code-done');
    await C.waitForSelector('#s-chat:not([hidden])');
    await C.evaluate(() => navigator.serviceWorker.ready);
    await C.reload(); await C.waitForSelector('.conv'); // SW が画面をキャッシュする
    await cctx.setOffline(true);
    await C.reload();
    await C.waitForSelector('.conv', { timeout: 10000 });
    await C.click('.conv');
    await drawStroke(C, 0, V); await drawStroke(C, 0, H);
    await C.click('#composer .tool.send');
    await C.waitForSelector('#chat .msg.pending');
    await shot(C, '09-offline-reopen');
    check('オフラインで開き直しても、トークを開いて書き、送信待ちにできる', () => assert.ok(true));
    await cctx.setOffline(false);
    await C.waitForSelector('#chat .msg.pending', { state: 'detached', timeout: 20000 });
    await A.page.click('#back');
    await A.page.waitForFunction(() => document.querySelectorAll('.conv').length === 2);
    const aConvs = await A.page.evaluate(async () => (await (await fetch('/api/conversations')).json()).conversations);
    const mio = aConvs.find(c => c.partner?.name === 'みお');
    check('つながると送信待ちが届く', () => assert.ok(mio && mio.last));
    assert.deepEqual(C.errors, []);
    await cctx.close();

    check('ページのエラーなし', () => { assert.deepEqual(A.page.errors, []); assert.deepEqual(B.page.errors, []); });
    console.log(`\nE2E: ${results.length} 件すべて成功`);
  } catch (e) {
    console.error('✘ 失敗:', e.message);
    await shot(A.page, 'fail-A').catch(() => {}); await shot(B.page, 'fail-B').catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close(); server.close(); app.close();
  }
})();
