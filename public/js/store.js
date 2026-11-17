// 端末内の保存（下書き・送信待ち・表示設定）。ログアウトで全部消す。
// 会話の本文（届いた筆跡）は端末に保存しない。共有端末で残らないようにするため。
const PREFIX = 'koko:v2:';
let ok = true;

function get(key, fallback) {
  try { const v = localStorage.getItem(PREFIX + key); return v == null ? fallback : JSON.parse(v); }
  catch { ok = false; return fallback; }
}
function set(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); ok = true; return true; }
  catch { ok = false; return false; }
}
function del(key) { try { localStorage.removeItem(PREFIX + key); } catch {} }

export const store = {
  get available() { return ok; },
  settings: () => ({ cells: 3, hand: 'right', guideMode: 'cell', guideVisible: true, recognition: true, ...get('settings', {}) }),
  saveSettings: s => set('settings', s),
  draft: (uid, cid) => get(`draft:${uid}:${cid}`, null),
  saveDraft: (uid, cid, d) => (d && (d.tokens.length || d.alt)) ? set(`draft:${uid}:${cid}`, d) : (del(`draft:${uid}:${cid}`), true),
  outbox: uid => get(`outbox:${uid}`, []),
  saveOutbox: (uid, list) => set(`outbox:${uid}`, list),
  // オフラインで開き直したとき用の最小限（自分の名前・トーク相手の名前）。ログアウトで消える
  me: () => get('me', null),
  // 引き継ぎコードの控え（本人が「この端末に保存」を選んだときだけ）。ユーザーIDが合わないものは返さない。ログアウトで消える
  code: uid => { const v = get('code', null); return v && v.uid === uid && typeof v.code === 'string' ? v.code : null; },
  saveCode: (uid, code) => set('code', { uid, code }),
  clearCode: () => del('code'),
  saveMe: u => set('me', u),
  convs: uid => get(`convs:${uid}`, []),
  saveConvs: (uid, list) => set(`convs:${uid}`, list),
  seen: uid => get(`seen:${uid}`, {}),
  saveSeen: (uid, m) => set(`seen:${uid}`, m),
  pendingInvite: () => { try { return sessionStorage.getItem('koko:invite'); } catch { return null; } },
  setPendingInvite: c => { try { c ? sessionStorage.setItem('koko:invite', c) : sessionStorage.removeItem('koko:invite'); } catch {} },
  // ログアウト・退会時: この端末の KOKO のデータをすべて消す（表示設定も含む）
  wipe() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith(PREFIX)) localStorage.removeItem(k); }
      sessionStorage.clear();
    } catch {}
  },
};