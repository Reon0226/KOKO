// 送信前の検証と、受信した筆跡の検査に使う（サーバーが無いので、端末側でも必ず確認する）。
// 送信メッセージの検証。お手本・補助線・認識文字は payload に入れられない（未知のキーは拒否）。

const LIMITS = Object.freeze({
  payloadVersion: 1,
  maxTokens: 300,          // 1メッセージの文字・空白・改行の合計
  maxStrokesPerToken: 80,  // 画数の多い漢字＋書き直しの余裕
  maxPointsPerStroke: 2000,
  maxPointsTotal: 20000,  // Firestore の1ドキュメント1MB制限のため 80000 から下げた
  maxJsonBytes: 700 * 1000, // 保存する tokens の JSON 文字列の上限（1MB 未満に収める）
  maxTimeMs: 10 * 60 * 1000, // 1文字を書くのにかけられる時間（ゆっくり書く人のため長め）
  maxAltText: 500,
  maxBodyBytes: 2 * 1024 * 1024,
});

const TOKEN_KINDS = new Set(['ink', 'space', 'newline']);
const POINT_KEYS = new Set(['x', 'y', 't', 'p']);

class ValidationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function fail(code, message) { throw new ValidationError(code, message); }

function isUnit(n) { return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1; }

function validateTokens(tokens) {
  if (!Array.isArray(tokens)) fail('tokens_type', 'tokens は配列です');
  if (tokens.length === 0) fail('tokens_empty', '空のメッセージは送れません');
  if (tokens.length > LIMITS.maxTokens) fail('tokens_too_many', `一度に送れるのは${LIMITS.maxTokens}マスまでです`);
  let total = 0;
  let inkCount = 0;
  const clean = [];
  for (const [i, tok] of tokens.entries()) {
    if (!tok || typeof tok !== 'object' || Array.isArray(tok)) fail('token_type', `${i}番目の要素が不正です`);
    const keys = Object.keys(tok);
    if (!TOKEN_KINDS.has(tok.kind)) fail('token_kind', `${i}番目の種類が不正です`);
    if (tok.kind !== 'ink') {
      if (keys.length !== 1) fail('token_extra', `${i}番目に余分な項目があります`);
      clean.push({ kind: tok.kind });
      continue;
    }
    for (const k of keys) if (k !== 'kind' && k !== 'strokes') fail('token_extra', `${i}番目に送れない項目（${k}）があります`);
    const strokes = tok.strokes;
    if (!Array.isArray(strokes) || strokes.length === 0) fail('ink_empty', `${i}番目の文字に線がありません`);
    if (strokes.length > LIMITS.maxStrokesPerToken) fail('ink_strokes', `${i}番目の文字の画数が多すぎます`);
    const cs = [];
    for (const stroke of strokes) {
      if (!Array.isArray(stroke) || stroke.length === 0) fail('stroke_empty', '空の線があります');
      if (stroke.length > LIMITS.maxPointsPerStroke) fail('stroke_points', '1本の線の点が多すぎます');
      total += stroke.length;
      if (total > LIMITS.maxPointsTotal) fail('points_total', 'メッセージが大きすぎます。分けて送ってください');
      const cpts = [];
      for (const pt of stroke) {
        if (!pt || typeof pt !== 'object' || Array.isArray(pt)) fail('point_type', '点の形式が不正です');
        for (const k of Object.keys(pt)) if (!POINT_KEYS.has(k)) fail('point_extra', `点に送れない項目（${k}）があります`);
        if (!isUnit(pt.x) || !isUnit(pt.y)) fail('point_range', '座標は0〜1の範囲です');
        const c = { x: pt.x, y: pt.y };
        if (pt.t !== undefined) {
          if (!Number.isInteger(pt.t) || pt.t < 0 || pt.t > LIMITS.maxTimeMs) fail('point_time', '時刻が不正です');
          c.t = pt.t;
        }
        if (pt.p !== undefined) {
          if (!isUnit(pt.p)) fail('point_pressure', '筆圧が不正です');
          c.p = pt.p;
        }
        cpts.push(c);
      }
      cs.push(cpts);
    }
    inkCount++;
    clean.push({ kind: 'ink', strokes: cs });
  }
  if (inkCount === 0) fail('no_ink', '手書きの文字が1つ以上必要です');
  if (JSON.stringify(clean).length > LIMITS.maxJsonBytes) fail('points_total', 'メッセージが大きすぎます。分けて送ってください');
  return { tokens: clean, inkCount, pointCount: total };
}

function validateMessageBody(body) {
  if (!body || typeof body !== 'object') fail('body', '本文が不正です');
  const allowed = new Set(['clientMessageId', 'payloadVersion', 'tokens', 'altText', 'composeMs']);
  for (const k of Object.keys(body)) if (!allowed.has(k)) fail('body_extra', `送れない項目（${k}）があります`);
  if (body.payloadVersion !== LIMITS.payloadVersion) fail('payload_version', '対応していない形式です。アプリを更新してください');
  if (typeof body.clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.clientMessageId)) fail('client_id', 'clientMessageId が不正です');
  let altText = null;
  if (body.altText !== undefined && body.altText !== null) {
    if (typeof body.altText !== 'string') fail('alt_type', '代替テキストが不正です');
    altText = body.altText.trim().slice(0, LIMITS.maxAltText) || null;
    if (body.altText.length > LIMITS.maxAltText * 2) fail('alt_long', '代替テキストが長すぎます');
  }
  let composeMs = null;
  if (body.composeMs !== undefined && body.composeMs !== null) {
    if (!Number.isInteger(body.composeMs) || body.composeMs < 0 || body.composeMs > 6 * 3600 * 1000) fail('compose_ms', 'composeMs が不正です');
    composeMs = body.composeMs;
  }
  const v = validateTokens(body.tokens);
  return { clientMessageId: body.clientMessageId, payloadVersion: 1, tokens: v.tokens, altText, composeMs, inkCount: v.inkCount, pointCount: v.pointCount };
}

function validateName(name) {
  if (typeof name !== 'string') fail('name', '名前を入れてください');
  const n = name.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!n || Array.from(n).length > 20) fail('name', '名前は1〜20文字です');
  return n;
}

export { LIMITS, ValidationError, validateTokens, validateMessageBody, validateName };
