// 手書き認識（読み取り補助）のアダプター。
// 認識結果は「お手本候補を探すため」だけに端末内で使い、送信する筆跡データには含めない。
//
// Web: W3C/WICG Handwriting Recognition API（navigator.createHandwritingRecognizer）。
//   公式資料（developer.chrome.com/docs/web-platform/handwriting-recognition）によると、
//   Chromium 系のみで、ChromeOS では英語のみ。日本語対応は記載がないため、ここでは
//   languages:['ja'] で作成を試み、失敗したら「使えない」と正直に表示する。処理は端末内。
// ネイティブ化後は ML Kit Digital Ink Recognition（言語タグ 'ja'）を同じ interface でつなぐ想定。

export async function createRecognizer() {
  if (typeof navigator === 'undefined' || !('createHandwritingRecognizer' in navigator)) {
    return { available: false, reason: 'このブラウザには手書き認識の機能がありません' };
  }
  let rec;
  try {
    rec = await navigator.createHandwritingRecognizer({ languages: ['ja'] });
  } catch {
    return { available: false, reason: 'この端末では日本語の手書き認識が使えません' };
  }
  return {
    available: true,
    reason: '端末内の手書き認識を使っています（結果は送信しません）',
    // strokes: 1マス分の線。返り値: 候補文字列の配列（可能性の高い順）
    async recognize(strokes, context = '') {
      const drawing = rec.startDrawing({ recognitionType: 'text', alternatives: 3, textContext: context.slice(-20) });
      let offset = 0;
      for (const s of strokes) {
        const hs = new self.HandwritingStroke();
        let last = 0;
        for (const p of s) { last = p.t || 0; hs.addPoint({ x: p.x * 1000, y: p.y * 1000, t: offset + last }); }
        offset += last + 100; // 線ごとの相対時刻を、画の順序が保たれる通し時刻にする
        drawing.addStroke(hs);
      }
      try {
        const preds = await drawing.getPrediction();
        return (preds || []).map(p => p.text).filter(Boolean);
      } finally { drawing.clear(); }
    },
  };
}
