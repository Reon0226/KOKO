import test from 'node:test';
import assert from 'node:assert/strict';
import { searchGuides, suggestFromRecognized, DEFAULTS } from '../public/js/guides.js';

test('読みで検索すると漢字のお手本が出る（例: きもち→気持ち）', () => {
  assert.ok(searchGuides('きもち').includes('気持ち'));
  assert.ok(searchGuides('キモチ').includes('気持ち'), 'カタカナでも探せる');
  assert.ok(searchGuides('気').includes('気持ち'), '漢字でも探せる');
  assert.deepEqual(searchGuides(''), DEFAULTS);
});

test('読み取り結果の末尾から候補を出す（書いた分の文字数を返す）', () => {
  const r = suggestFromRecognized('あしたきもち');
  const k = r.find(x => x.word === '気持ち');
  assert.ok(k, '末尾の「きもち」から「気持ち」');
  assert.equal(k.span, 3);
  const pre = suggestFromRecognized('おつ');
  assert.ok(pre.some(x => x.word === 'お疲れさま' && x.span === 0), '書きかけの読みからも続きを出す（span=0は置き換えない）');
  assert.deepEqual(suggestFromRecognized(''), []);
});
