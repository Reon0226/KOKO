'use strict';
// 普及の検証用の集計（運営者がサーバー上で実行）。筆跡・名前・本文は読まない。
// 使い方: KOKO_DB=data/koko.db npm run metrics
const path = require('node:path');
const { openDb } = require('../server/db');
const db = openDb(process.env.KOKO_DB || path.join(__dirname, '..', 'data', 'koko.db'));
const DAY = 86400000;
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);

const users = one('SELECT COUNT(*) n FROM users').n;
const sentUsers = one("SELECT COUNT(DISTINCT user_id) n FROM metrics WHERE type='message_sent' AND user_id IS NOT NULL").n;
const invCreated = one("SELECT COUNT(*) n FROM metrics WHERE type='invite_created'").n;
const invAccepted = one("SELECT COUNT(*) n FROM metrics WHERE type='invite_accepted'").n;

// 誘われた人が返事をしたか: 招待を受けた人（accept した人）がその会話で1通以上送ったか
const accepted = all("SELECT user_id, conversation_id FROM metrics WHERE type='invite_accepted' AND user_id IS NOT NULL");
const replied = accepted.filter(a => one('SELECT 1 x FROM messages WHERE conversation_id = ? AND sender_id = ? LIMIT 1', a.conversation_id, a.user_id)).length;

// 入力にかかった時間（最初の1画〜送信）と1通あたりの文字数
const times = all("SELECT value FROM metrics WHERE type='message_sent' AND value IS NOT NULL ORDER BY value").map(r => Number(r.value));
const median = a => a.length ? a[Math.floor(a.length / 2)] : null;
const p90 = a => a.length ? a[Math.floor(a.length * 0.9)] : null;
const sizes = all('SELECT tokens FROM messages').map(r => JSON.parse(r.tokens).filter(t => t.kind === 'ink').length).sort((a, b) => a - b);

// 数日後も二人が話しているか: 会話開始から3日目以降に、二人ともが送っている会話の割合
const convs = all('SELECT id, created_at FROM conversations');
const now = Date.now();
const old = convs.filter(c => now - Number(c.created_at) >= 3 * DAY);
const alive = old.filter(c => one('SELECT COUNT(DISTINCT sender_id) n FROM messages WHERE conversation_id = ? AND server_ts >= ?', c.id, Number(c.created_at) + 3 * DAY).n >= 2).length;

const pct = (a, b) => b ? `${Math.round(a / b * 100)}% (${a}/${b})` : '-';
const sec = ms => ms == null ? '-' : `${(ms / 1000).toFixed(1)}秒`;
console.log(`KOKO 普及検証の集計（${new Date().toLocaleString('ja-JP')}）
- 登録した人: ${users}
- 初回送信完了率（1通以上送った人 / 登録した人）: ${pct(sentUsers, users)}
- 招待の受け入れ率: ${pct(invAccepted, invCreated)}
- 誘われた人が返事をした割合: ${pct(replied, accepted.length)}
- 入力時間（最初の1画〜送信）中央値: ${sec(median(times))} / 90%点: ${sec(p90(times))}
- 1通の文字数 中央値: ${median(sizes) ?? '-'}
- 3日以上前に始まった会話のうち、3日目以降も二人とも送っている割合: ${pct(alive, old.length)}
※ 件数が少ないうちは割合より個々の声（インタビュー）を重視してください。`);
db.close();
