// このファイルはClip保存処理の入力境界・既存データ保護・同時操作を回帰検証する。
// Nodeのtestと独立したVMに、storage・UUID・Web Locksのテスト用代替を注入する。
// 実Chromeの保存領域・ロック実装やSide Panelの画面操作は再現しないため、実機確認は別に必要。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// ビルド済みの実装と実サンプルを読み、VMへ注入する依存だけimport/exportから切り離す。
const storageSource = (await readFile(new URL('../dist/storage/storage.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '')
  .replaceAll('export ', '');
const templatesSource = (await readFile(new URL('../dist/data/templates.js', import.meta.url), 'utf8'))
  .replaceAll('export ', '');
const templateContext = {};
vm.runInNewContext(`${templatesSource}\nthis.samples = { defaultCategories, defaultClips };`, templateContext);
const samples = structuredClone(templateContext.samples);
// 次のイベントループまで待ち、同期処理だけでは見えない読み書きの競合を起こせるようにする。
const tick = () => new Promise(resolve => setImmediate(resolve));
// フォーム入力の標準値を作り、各テストでは検証したい表示名・本文だけを差し替える。
const input = (label = 'New clip', text = 'New text') => ({ label, text });
// 保存済みClipの標準形を作る。overridesで旧データや不正値などの条件を局所的に表す。
const clip = (id = 'existing', overrides = {}) => ({
  id, categoryId: 'personal', label: `Label ${id}`, text: `Text ${id}`, pinned: true, order: 3, ...overrides,
});
// カテゴリ選択を検証するため、IDと並び順を指定できる最小の保存済みカテゴリを作る。
const category = (id = 'personal', order = 1) => ({ id, label: id, order });

// 複数VMで共有するstorage代替。get/setは非同期に進み、読取値はコピーとして返す。
// attemptsは書込の試行、writesは成功を記録し、hooksで読取・書込の失敗を注入する。
function backend(initial = { clips: [], categories: [category()] }) {
  const data = structuredClone(initial);
  const writes = [], attempts = [], reads = [];
  const hooks = { get: null, set: null };
  const local = {
    async get(keys) {
      reads.push(structuredClone(keys));
      await tick();
      await hooks.get?.(keys);
      const selected = {};
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        if (Object.hasOwn(data, key)) selected[key] = data[key];
      }
      return structuredClone(selected);
    },
    async set(values) {
      attempts.push(structuredClone(values));
      await tick();
      await hooks.set?.(values);
      const saved = structuredClone(values);
      Object.assign(data, saved);
      writes.push(saved);
    },
  };
  return { data, writes, attempts, reads, hooks, local };
}

// 同名ロックの要求をPromiseで直列化するWeb Locks代替を、独立したVM間で共有する。
// 呼出名と同時実行数も記録し、失敗後に待機中の処理が進めることを確認できるようにする。
function lockManager() {
  const tails = new Map();
  const calls = [];
  let active = 0, maxActive = 0;
  return {
    calls,
    get maxActive() { return maxActive; },
    request(name, callback) {
      calls.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      const result = previous.then(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await tick();
          return await callback({ name, mode: 'exclusive' });
        } finally {
          active -= 1;
        }
      });
      tails.set(name, result.catch(() => {}));
      return result;
    },
  };
}

// 1パネル相当の独立VMで実装を評価し、storage・ロック・UUID生成やAPI欠落条件を注入する。
function panel(store, locks = lockManager(), options = {}) {
  let sequence = 0;
  const context = {
    chrome: { storage: { local: store.local } },
    crypto: { randomUUID: options.randomUUID ?? (() => `${options.prefix ?? 'generated'}-${++sequence}`) },
    defaultCategories: structuredClone(samples.defaultCategories),
    defaultClips: structuredClone(samples.defaultClips),
  };
  if (!options.noNavigator) context.navigator = options.noLocks ? {} : { locks };
  vm.runInNewContext(`${storageSource}\nthis.api = { initializeStorage, getClips, validateClipInput, createClip, updateClip, deleteClip, CLIP_LIMITS };`, context);
  return context.api;
}

// テストごとに独立した保存データ・ロック・APIをまとめ、テスト間の状態混入を防ぐ。
function fixture(initial, options = {}) {
  const store = backend(initial);
  const locks = lockManager();
  return { ...store, locks, api: panel(store, locks, options) };
}

// 処理の拒否だけでなく、保存内容・成功回数・試行回数がすべて不変であることを検証する。
async function rejectsWithoutWrites(s, action, pattern) {
  const before = structuredClone(s.data);
  const count = s.writes.length;
  const attempts = s.attempts.length;
  await assert.rejects(action, pattern);
  assert.deepEqual(s.data, before);
  assert.equal(s.writes.length, count);
  assert.equal(s.attempts.length, attempts);
}

// 前後空白付きの入力を追加し、表示名だけをtrimして本文は完全保持することを確認する。
// 既存Clip・無関係なキーを残し、新ID・未固定・最大order+1で末尾追加する仕様を守る。
test('create trims the label, preserves all body whitespace, and appends with fresh metadata', async () => {
  const existing = clip('saved', { order: 7, extra: { keep: true } });
  const s = fixture({ clips: [existing], categories: [category()], unrelated: { theme: 'dark' } });
  await s.api.createClip(input(' \t New label \n ', '\n  Body text\t\n'));
  assert.deepEqual(s.data.clips, [existing, {
    id: 'generated-1', categoryId: 'personal', label: 'New label', text: '\n  Body text\t\n', pinned: false, order: 8,
  }]);
  assert.deepEqual(s.data.unrelated, { theme: 'dark' });
  assert.deepEqual(Object.keys(s.writes[0]), ['clips']);
});

// 同じ表示名で2件作成して片方ずつ編集・削除し、別IDのClipを巻き込まないことを確認する。
// 表示名ではなくIDで対象を選び、残るClipのカテゴリ・固定状態・並び順を保護する。
test('same-label clips get independent IDs; update/delete target only the original ID', async () => {
  const s = fixture();
  await s.api.createClip(input('Same', 'First'));
  await s.api.createClip(input('Same', 'Second'));
  const [first, second] = structuredClone(s.data.clips);
  assert.notEqual(first.id, second.id);
  await s.api.updateClip(first, input(' Renamed ', ' \nEdited body\n '));
  assert.deepEqual(s.data.clips[0], { ...first, label: 'Renamed', text: ' \nEdited body\n ' });
  assert.deepEqual(s.data.clips[1], second);
  await s.api.deleteClip(second);
  assert.equal(s.data.clips.length, 1);
  assert.equal(s.data.clips[0].id, first.id);
  assert.equal(s.data.clips[0].categoryId, first.categoryId);
  assert.equal(s.data.clips[0].pinned, first.pinned);
  assert.equal(s.data.clips[0].order, first.order);
});

// 旧カテゴリ・小数の並び順・追加属性を持つClipを編集し、表示名と本文だけが変わることを確認する。
// 他Clipや無関係な保存キーまで書き直してしまう退行を防ぐ。
test('update retains ID, category, pinned, order, extra fields, and unrelated storage', async () => {
  const original = clip('keep', { categoryId: 'legacy-category', pinned: true, order: -2.5, extra: { value: 9 } });
  const other = clip('other');
  const s = fixture({ clips: [original, other], categories: [], preferences: { keep: true } });
  await s.api.updateClip(original, input(' Updated ', '\tnew body\n'));
  assert.deepEqual(s.data.clips, [{ ...original, label: 'Updated', text: '\tnew body\n' }, other]);
  assert.deepEqual(s.data.categories, []);
  assert.deepEqual(s.data.preferences, { keep: true });
  assert.deepEqual(Object.keys(s.writes[0]), ['clips']);
});

// 表示名80/81・本文10000/10001の境界を、ASCIIと絵文字の両方で作成・更新へ適用する。
// 見た目の文字数ではなくUTF-16単位で判定し、超過時に保存を試みないことを確認する。
test('label 80/81 and body 10000/10001 limits use UTF-16 units, including emoji', async t => {
  const cases = [
    ['ASCII', 'a'.repeat(80), 'a'.repeat(81), 'x'.repeat(10_000), 'x'.repeat(10_001)],
    ['emoji', '😀'.repeat(40), `${'😀'.repeat(40)}a`, '😀'.repeat(5_000), `${'😀'.repeat(5_000)}a`],
  ];
  for (const [name, goodLabel, badLabel, goodText, badText] of cases) {
    // ASCIIは1字1単位、ここで使う絵文字は1字2単位。上限ちょうどは保存し、1単位超過は拒否する。
    // 表示名の前後空白は除外され、両欄の同時超過では両方のエラーが返ることも確認する。
    await t.test(name, async () => {
      assert.equal(goodLabel.length, 80);
      assert.equal(badLabel.length, 81);
      assert.equal(goodText.length, 10_000);
      assert.equal(badText.length, 10_001);
      const s = fixture();
      await s.api.createClip(input(` \t${goodLabel}\n`, goodText));
      assert.equal(s.data.clips[0].label, goodLabel);
      assert.equal(s.data.clips[0].text, goodText);
      await rejectsWithoutWrites(s, () => s.api.createClip(input(badLabel, 'valid')), /80/);
      await rejectsWithoutWrites(s, () => s.api.createClip(input('valid', badText)), /10000/);
      const original = structuredClone(s.data.clips[0]);
      await rejectsWithoutWrites(s, () => s.api.updateClip(original, input(badLabel, original.text)), /80/);
      await rejectsWithoutWrites(s, () => s.api.updateClip(original, input(original.label, badText)), /10000/);
      const errors = structuredClone(s.api.validateClipInput(input(badLabel, badText)));
      assert.deepEqual(Object.keys(errors).sort(), ['label', 'text']);
      const editing = fixture({ clips: [clip()], categories: [] });
      await editing.api.updateClip(clip(), input(` ${goodLabel} `, goodText));
      assert.equal(editing.data.clips[0].label, goodLabel);
      assert.equal(editing.data.clips[0].text, goodText);
    });
  }
});

// 空白と改行を含む10000単位の本文はそのまま保存し、タブ追加で10001単位になると拒否する。
// 検証時だけ本文をtrimして上限をすり抜ける退行を、作成・更新の両方で防ぐ。
test('body whitespace counts toward the limit and is never trimmed for validation or storage', async () => {
  const s = fixture();
  const atLimit = ` ${'x'.repeat(9_998)}\n`;
  await s.api.createClip(input('Whitespace boundary', atLimit));
  assert.equal(s.data.clips[0].text, atLimit);
  await rejectsWithoutWrites(s, () => s.api.createClip(input('Too long', `${atLimit}\t`)), /10000/);
  await rejectsWithoutWrites(s, () => s.api.updateClip(s.data.clips[0], input('Whitespace boundary', `${atLimit}\t`)), /10000/);
});

// 空文字・半角空白・改行類・全角空白を新規または変更欄に渡し、書込試行なしで拒否することを確認する。
// 空白だけの表示名や本文が保存される退行を防ぐ。
test('new or changed empty/blank fields are rejected without any write attempt', async () => {
  for (const blank of ['', ' ', '\t\r\n', '\u3000']) {
    const original = clip();
    const s = fixture({ clips: [original], categories: [] });
    await rejectsWithoutWrites(s, () => s.api.createClip(input(blank, 'valid')));
    await rejectsWithoutWrites(s, () => s.api.createClip(input('valid', blank)));
    await rejectsWithoutWrites(s, () => s.api.updateClip(original, input(blank, original.text)));
    await rejectsWithoutWrites(s, () => s.api.updateClip(original, input(original.label, blank)));
  }
});

// null・欠落したプロパティ・文字列以外の値を渡し、作成・更新が保存前に失敗することを確認する。
// TypeScriptの型を実行時にすり抜ける入力でも、既存データを書き換えないための検証。
test('malformed runtime input fails without attempting a write', async () => {
  for (const values of [null, undefined, {}, { label: 1, text: 'valid' }, { label: 'valid', text: false }]) {
    const original = clip();
    const s = fixture({ clips: [original], categories: [] });
    await rejectsWithoutWrites(s, () => s.api.createClip(values));
    await rejectsWithoutWrites(s, () => s.api.updateClip(original, values));
  }
});

// 上限超過や空白だけの旧データを読み、未変更欄は空白も含めてそのまま残せることを確認する。
// 変更した超過欄は拒否しつつ、別欄だけの編集や削除を新ルールで不必要に塞がない。
test('unchanged oversized and blank legacy fields remain readable and can be preserved in edits', async () => {
  const oversized = clip('oversized', { label: ` ${'L'.repeat(81)} `, text: 'T'.repeat(10_001) });
  const blank = clip('blank', { label: ' \t ', text: '\n ' });
  const s = fixture({ clips: [oversized, blank], categories: [] });
  assert.deepEqual(structuredClone(await s.api.getClips()), [oversized, blank]);
  await s.api.updateClip(oversized, input(oversized.label, oversized.text));
  assert.deepEqual(s.data.clips[0], oversized);
  await s.api.updateClip(oversized, input(' Shorter ', oversized.text));
  assert.equal(s.data.clips[0].text, oversized.text);
  const changed = structuredClone(s.data.clips[0]);
  await rejectsWithoutWrites(s, () => s.api.updateClip(changed, input(changed.label, `${changed.text}!`)), /10000/);
  await s.api.updateClip(blank, input(blank.label, 'New body'));
  assert.equal(s.data.clips[1].label, blank.label);

  const labelOnly = fixture({ clips: [oversized], categories: [] });
  await labelOnly.api.updateClip(oversized, input(oversized.label, 'Short text'));
  assert.equal(labelOnly.data.clips[0].label, oversized.label);
  assert.equal(labelOnly.data.clips[0].text, 'Short text');
  await labelOnly.api.deleteClip(labelOnly.data.clips[0]);
  assert.deepEqual(labelOnly.data.clips, []);
});

// 99件から100件への追加は成功し、101件目は拒否する。削除して枠が空けば再作成できることも確認する。
// 既に101件ある旧データでは新規作成だけを止め、編集・削除による整理を妨げない。
test('100 clips is the creation limit; edits and deletes still work for oversized legacy lists', async () => {
  const clips = Array.from({ length: 99 }, (_, i) => clip(`item-${i}`, { order: i + 1 }));
  const s = fixture({ clips, categories: [] });
  await s.api.createClip(input());
  assert.equal(s.data.clips.length, 100);
  await rejectsWithoutWrites(s, () => s.api.createClip(input('Over limit')), /100/);
  await s.api.deleteClip(s.data.clips[0]);
  await s.api.createClip(input('Room again'));
  assert.equal(s.data.clips.length, 100);

  const legacyClips = Array.from({ length: 101 }, (_, i) => clip(`legacy-${i}`, { order: i }));
  const legacy = fixture({ clips: legacyClips, categories: [] });
  await rejectsWithoutWrites(legacy, () => legacy.api.createClip(input()), /100/);
  await legacy.api.updateClip(legacyClips[0], input('Edited at 101', 'Updated'));
  assert.equal(legacy.data.clips.length, 101);
  assert.deepEqual(legacy.data.clips.slice(1), legacyClips.slice(1));
  await legacy.api.deleteClip(legacyClips[1]);
  assert.equal(legacy.data.clips.length, 100);
});

// 最小orderが同じカテゴリを含む一覧で、元の並びの先頭を選び、カテゴリ自体は書き換えないことを確認する。
// カテゴリが空なら未分類の空IDを使い、最初のClipのorderを1にする仕様も守る。
test('category selection is stable by ascending order and never rewrites categories', async () => {
  const categories = [category('later', 5), category('first-tie', -1), category('second-tie', -1)];
  const s = fixture({ clips: [], categories });
  await s.api.createClip(input());
  assert.equal(s.data.clips[0].categoryId, 'first-tie');
  assert.deepEqual(s.data.categories, categories);
  assert.deepEqual(Object.keys(s.writes[0]), ['clips']);
  const empty = fixture({ clips: [], categories: [] });
  await empty.api.createClip(input());
  assert.equal(empty.data.clips[0].categoryId, '');
  assert.equal(empty.data.clips[0].order, 1);
});

// 不正な型・非有限order・重複IDなどのカテゴリでは作成だけを拒否し、既存Clipの編集・削除は通す。
// 不正カテゴリを既定値や未分類へ黙って置き換えず、そのまま保護することを確認する。
test('invalid categories block only creation and are never silently replaced', async () => {
  const invalid = [undefined, null, false, {}, [null], [{ id: '', label: 'x', order: 1 }],
    [{ id: 'x', label: 1, order: 1 }], [{ id: 'x', label: 'x', order: '1' }],
    [category('x', NaN)], [category('x', Infinity)], [category('x'), category('x', 2)]];
  for (const categories of invalid) {
    const original = clip();
    const s = fixture({ clips: [original], categories });
    await rejectsWithoutWrites(s, () => s.api.createClip(input()), /カテゴリ/);
    await s.api.updateClip(original, input('Edited', 'Body'));
    await s.api.deleteClip(s.data.clips[0]);
    assert.deepEqual(s.data.categories, categories);
  }
});

// 不正なClip形式や重複IDの一覧では、読取と全変更を拒否して保存内容を保持することを確認する。
// 初期化も既存キーを補修しないため、曖昧な対象を更新したり不正データを上書きしたりしない。
test('malformed clips and duplicate IDs fail closed for reads and every mutation', async () => {
  const invalid = [undefined, null, false, {}, [null], [1], [{}], [clip('', {})],
    [clip('x', { categoryId: null })], [clip('x', { label: null })], [clip('x', { text: 4 })],
    [clip('x', { pinned: 1 })], [clip('x', { order: '3' })], [clip('x', { order: NaN })],
    [clip('x', { order: Infinity })], [clip('duplicate'), clip('duplicate')]];
  for (const clips of invalid) {
    const s = fixture({ clips, categories: [] });
    await rejectsWithoutWrites(s, () => s.api.getClips(), /Clip/);
    await rejectsWithoutWrites(s, () => s.api.createClip(input()), /Clip/);
    await rejectsWithoutWrites(s, () => s.api.updateClip(clip(), input()), /Clip/);
    await rejectsWithoutWrites(s, () => s.api.deleteClip(clip()), /Clip/);
    await s.api.initializeStorage();
    assert.equal(s.writes.length, 0);
    assert.deepEqual(s.data.clips, clips);
  }
});

// UUID生成が既存IDを返す場合と例外になる場合を再現し、どちらも書込前に失敗することを確認する。
// ID衝突による既存Clipの上書きや、ID生成失敗後の不完全な保存を防ぐ。
test('UUID collisions and unavailable UUID generation never overwrite existing clips', async () => {
  const original = clip('collision');
  const s = fixture({ clips: [original], categories: [] }, { randomUUID: () => 'collision' });
  await rejectsWithoutWrites(s, () => s.api.createClip(input()), /ID/);
  const unavailable = fixture({ clips: [], categories: [] }, { randomUUID: () => { throw new Error('UUID unavailable'); } });
  await rejectsWithoutWrites(unavailable, () => unavailable.api.createClip(input()), /UUID unavailable/);
});

// 巨大なorderを持つ旧データに追加を試み、安全範囲を超える値や加算しても進まない値を拒否する。
// 新しい並び順を安全に作れないときに、既存データを勝手に振り直さないことを確認する。
test('unsafe or non-advancing maximum order is rejected without mutating legacy data', async () => {
  for (const order of [Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, 2 ** 53]) {
    const s = fixture({ clips: [clip('huge-order', { order })], categories: [] });
    await rejectsWithoutWrites(s, () => s.api.createClip(input()), /並び順/);
  }
});

// orderが2.5の旧データへ追加し、元の値を残したまま新しいorderが3.5になることを確認する。
// 有限の小数を不正扱いしたり、既存の並び順を整数へ振り直したりする退行を防ぐ。
test('finite fractional legacy order is preserved and new order advances without renumbering', async () => {
  const existing = clip('fractional', { order: 2.5 });
  const s = fixture({ clips: [existing], categories: [] });
  await s.api.createClip(input());
  assert.deepEqual(s.data.clips[0], existing);
  assert.equal(s.data.clips[1].order, 3.5);
});

// Clip・カテゴリのキーがない保存領域を初期化し、実サンプルだけを1回保存することを確認する。
// 無関係なキーを保持し、再初期化による二重書込を防ぐ。
test('initialization uses the actual samples once and preserves unrelated keys', async () => {
  const s = fixture({ preferences: { keep: true } });
  await s.api.initializeStorage();
  assert.deepEqual(s.data.clips, samples.defaultClips);
  assert.deepEqual(s.data.categories, samples.defaultCategories);
  assert.deepEqual(s.data.preferences, { keep: true });
  assert.equal(s.writes.length, 1);
  await s.api.initializeStorage();
  assert.equal(s.writes.length, 1);
});

// 片方だけ存在する空配列・不正値を残して欠落キーだけ補い、存在するundefinedも上書きしない。
// 値の正しさや真偽ではなくキーの有無で初期化を判断する仕様を確認する。
test('initialization writes only absent keys, preserving empty and malformed stored values', async () => {
  for (const clips of [[], null, false, { legacy: true }]) {
    const s = fixture({ clips });
    await s.api.initializeStorage();
    assert.deepEqual(s.data.clips, clips);
    assert.deepEqual(s.writes, [{ categories: samples.defaultCategories }]);
  }
  for (const categories of [[], null, false, { legacy: true }]) {
    const s = fixture({ categories });
    await s.api.initializeStorage();
    assert.deepEqual(s.data.categories, categories);
    assert.deepEqual(s.writes, [{ clips: samples.defaultClips }]);
  }
  const presentUndefined = fixture({ clips: undefined, categories: undefined });
  await presentUndefined.api.initializeStorage();
  assert.equal(presentUndefined.writes.length, 0);
});

// サンプルを全件削除した後、別VMでパネルを開き直しても空の一覧と書込回数が変わらないことを確認する。
// 空配列を未初期化と誤認し、利用者が消したサンプルを復活させる退行を防ぐ。
test('deleting the final sample leaves empty storage and never restores samples on reopen', async () => {
  const s = fixture({});
  await s.api.initializeStorage();
  for (const original of structuredClone(s.data.clips)) await s.api.deleteClip(original);
  assert.deepEqual(s.data.clips, []);
  const count = s.writes.length;
  const reopened = panel(s, s.locks);
  await reopened.initializeStorage();
  assert.deepEqual(structuredClone(await reopened.getClips()), []);
  assert.equal(s.writes.length, count);
});

// 初期化・読取・作成・更新・削除の読取失敗を注入し、例外を伝えて書込を一度も試みないことを確認する。
// カテゴリ読取と初期化のロック取得後の再読取も、失敗を空データとして扱わない。
test('storage read failures propagate without writes at initialization and each mutation boundary', async () => {
  const original = clip();
  for (const operation of [api => api.initializeStorage(), api => api.getClips(), api => api.createClip(input()),
    api => api.updateClip(original, input()), api => api.deleteClip(original)]) {
    const s = fixture({ clips: [original], categories: [] });
    s.hooks.get = () => { throw new Error('read failed'); };
    await rejectsWithoutWrites(s, () => operation(s.api), /read failed/);
  }
  const categoryFailure = fixture({ clips: [], categories: [] });
  categoryFailure.hooks.get = keys => { if (keys === 'categories') throw new Error('categories read failed'); };
  await rejectsWithoutWrites(categoryFailure, () => categoryFailure.api.createClip(input()), /categories read failed/);
  const lockedInitialization = fixture({});
  let readCount = 0;
  lockedInitialization.hooks.get = () => { if (++readCount === 2) throw new Error('locked read failed'); };
  await rejectsWithoutWrites(lockedInitialization, () => lockedInitialization.api.initializeStorage(), /locked read failed/);
});

// 各書込で保存失敗を注入し、試行1回・成功0回・データ不変を確認してから障害を解除し、再試行する。
// 失敗後もロック待ちを進められ、再試行が安全に1回だけ保存されることを検証する。
test('failed storage writes preserve data and release the shared lock for a later retry', async () => {
  for (const [initial, operation] of [[{}, api => api.initializeStorage()],
    [{ clips: [clip()], categories: [] }, api => api.createClip(input())],
    [{ clips: [clip()], categories: [] }, api => api.updateClip(clip(), input())],
    [{ clips: [clip()], categories: [] }, api => api.deleteClip(clip())]]) {
    const s = fixture(initial);
    const before = structuredClone(s.data);
    s.hooks.set = () => { throw new Error('quota or storage write failed'); };
    await assert.rejects(() => operation(s.api), /quota or storage write failed/);
    assert.deepEqual(s.data, before);
    assert.equal(s.attempts.length, 1);
    assert.equal(s.writes.length, 0);
    s.hooks.set = null;
    await operation(s.api);
    assert.equal(s.writes.length, 1);
    assert.equal(s.locks.maxActive, 1);
  }
});

// 独立した2つのVMから同時に10件追加し、全件のID・ラベル・連続したorderが残ることを確認する。
// 同名の共有ロック内の最大同時実行数が1となり、古い一覧による上書き消失を防ぐ。
test('separate panels share Web Locks: concurrent creates retain every new clip and monotonic order', async () => {
  const s = fixture({ clips: [clip('original', { order: 9 })], categories: [] });
  const a = panel(s, s.locks, { prefix: 'a' });
  const b = panel(s, s.locks, { prefix: 'b' });
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).createClip(input(`New ${i}`))));
  assert.equal(s.data.clips.length, 11);
  assert.equal(new Set(s.data.clips.map(item => item.id)).size, 11);
  assert.deepEqual(s.data.clips.map(item => item.order), Array.from({ length: 11 }, (_, i) => i + 9));
  assert.deepEqual(s.data.clips.map(item => item.label).slice(1).sort(), Array.from({ length: 10 }, (_, i) => `New ${i}`).sort());
  assert.equal(s.writes.length, 10);
  assert.equal(s.locks.maxActive, 1);
  assert.equal(new Set(s.locks.calls).size, 1);
});

// 99件ある状態で別VMから2件を同時作成し、片方だけ成功して100件・書込1回になることを確認する。
// 件数確認をロック外で済ませてしまい、競合で101件へ増える退行を防ぐ。
test('concurrent creates at 99 clips allow exactly one save', async () => {
  const s = fixture({ clips: Array.from({ length: 99 }, (_, i) => clip(`existing-${i}`, { order: i })), categories: [] });
  const a = panel(s, s.locks, { prefix: 'a' });
  const b = panel(s, s.locks, { prefix: 'b' });
  const results = await Promise.allSettled([a.createClip(input('A')), b.createClip(input('B'))]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /100/);
  assert.equal(s.data.clips.length, 100);
  assert.equal(s.writes.length, 1);
});

// 別々のClipの編集2件と新規作成を同時実行し、3つの変更と無関係なキーがすべて残ることを確認する。
// 共有ロックで毎回最新一覧を読むことにより、別対象の変更を上書きしない仕様を守る。
test('concurrent updates of unrelated clips and a create do not lose one another', async () => {
  const first = clip('first'), second = clip('second', { order: 8 });
  const s = fixture({ clips: [first, second], categories: [], untouched: 'kept' });
  const a = panel(s, s.locks, { prefix: 'a' });
  const b = panel(s, s.locks, { prefix: 'b' });
  await Promise.all([a.updateClip(first, input('First updated', 'A')), b.updateClip(second, input('Second updated', 'B')), a.createClip(input('Third', 'C'))]);
  assert.deepEqual(s.data.clips.slice(0, 2), [{ ...first, label: 'First updated', text: 'A' }, { ...second, label: 'Second updated', text: 'B' }]);
  assert.equal(s.data.clips[2].label, 'Third');
  assert.equal(s.data.untouched, 'kept');
  assert.equal(s.writes.length, 3);
  assert.equal(s.locks.maxActive, 1);
});

// 同じ編集開始時データから別VMで2回更新し、先行する更新だけが保存されることを確認する。
// 後続は競合エラーとなり、古い内容による上書きと余分な書込を防ぐ。
test('concurrent edits from the same original permit one winner and reject stale overwrite', async () => {
  const original = clip();
  const s = fixture({ clips: [original], categories: [] });
  const a = panel(s, s.locks), b = panel(s, s.locks);
  const results = await Promise.allSettled([a.updateClip(original, input('Winner', 'First')), b.updateClip(original, input('Stale', 'Second'))]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.match(results[1].reason.message, /別の画面/);
  assert.equal(s.data.clips[0].label, 'Winner');
  assert.equal(s.writes.length, 1);
});

// 表示名・本文・カテゴリ・固定状態・並び順のいずれかが変更済み、または対象が削除済みの条件を試す。
// 古いデータを渡した編集・削除が、競合エラーとなり保存を試みないことを確認する。
test('stale edits and deletes conflict on any changed original field and on missing originals', async () => {
  const original = clip();
  const changes = [{ label: 'Changed' }, { text: 'Changed' }, { categoryId: 'changed' }, { pinned: false }, { order: 8 }];
  for (const change of changes) {
    const s = fixture({ clips: [{ ...original, ...change }], categories: [] });
    await rejectsWithoutWrites(s, () => s.api.updateClip(original, input()), /別の画面/);
    await rejectsWithoutWrites(s, () => s.api.deleteClip(original), /別の画面/);
  }
  const missing = fixture({ clips: [], categories: [] });
  await rejectsWithoutWrites(missing, () => missing.api.updateClip(original, input()), /別の画面/);
  await rejectsWithoutWrites(missing, () => missing.api.deleteClip(original), /別の画面/);
});

// 同じClipの削除と編集を順序を入れ替えて同時実行し、先行操作だけが成功することを確認する。
// 削除済みClipの復活と、編集済みClipを古い確認内容で削除する事故の両方を防ぐ。
test('concurrent delete/edit of the same original cannot resurrect or remove a changed clip', async () => {
  const original = clip();
  for (const deleteFirst of [true, false]) {
    const s = fixture({ clips: [original], categories: [] });
    const a = panel(s, s.locks), b = panel(s, s.locks);
    const operations = deleteFirst
      ? [a.deleteClip(original), b.updateClip(original, input('Changed', 'Body'))]
      : [a.updateClip(original, input('Changed', 'Body')), b.deleteClip(original)];
    const results = await Promise.allSettled(operations);
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
    assert.match(results[1].reason.message, /別の画面/);
    assert.equal(s.writes.length, 1);
    assert.equal(s.data.clips.length, deleteFirst ? 0 : 1);
    if (!deleteFirst) assert.equal(s.data.clips[0].label, 'Changed');
  }
});

// 別VMから異なる2件を同時削除し、未対象の1件だけが残って保存も2回行われることを確認する。
// 一方の削除が古い一覧を書き戻し、もう一方のClipを復活させる退行を防ぐ。
test('concurrent deletion of unrelated originals preserves both operations', async () => {
  const first = clip('first'), second = clip('second'), survivor = clip('survivor');
  const s = fixture({ clips: [first, second, survivor], categories: [] });
  const a = panel(s, s.locks), b = panel(s, s.locks);
  await Promise.all([a.deleteClip(first), b.deleteClip(second)]);
  assert.deepEqual(s.data.clips, [survivor]);
  assert.equal(s.writes.length, 2);
});

// 未初期化の共有領域を6つの独立VMで同時に開き、サンプル保存が合計1回だけになることを確認する。
// 全パネルが同名ロックを使い、待機後の再読取で重複初期化を防ぐ仕様を守る。
test('concurrent initialization rechecks under the shared lock and writes exactly once', async () => {
  const s = fixture({ unrelated: 'keep' });
  const panels = Array.from({ length: 6 }, () => panel(s, s.locks));
  await Promise.all(panels.map(api => api.initializeStorage()));
  assert.equal(s.writes.length, 1);
  assert.deepEqual(s.data, { unrelated: 'keep', clips: samples.defaultClips, categories: samples.defaultCategories });
  assert.equal(s.locks.calls.length, 6);
  assert.equal(new Set(s.locks.calls).size, 1);
  assert.equal(s.locks.maxActive, 1);
});

// カテゴリだけ未初期化の状態で、初期化のロック要求後に別VMから作成して両方の結果を確認する。
// 初期化とCRUDが別ロックに分かれず、共有領域への書込を同じ順番待ちで処理することを守る。
test('initialization and creation use the same shared write lock', async () => {
  const s = fixture({ clips: [] });
  const a = panel(s, s.locks), b = panel(s, s.locks, { prefix: 'b' });
  const initializing = a.initializeStorage();
  while (!s.locks.calls.length) await tick();
  await Promise.all([initializing, b.createClip(input('Created while opening'))]);
  assert.equal(s.data.clips.length, 1);
  assert.equal(s.data.clips[0].label, 'Created while opening');
  assert.deepEqual(s.data.categories, samples.defaultCategories);
  assert.equal(new Set(s.locks.calls).size, 1);
  assert.equal(s.locks.maxActive, 1);
});

// navigatorや有効なlocks.requestがない環境で、既存データの読取と書込不要の初期化は通ることを確認する。
// CRUDと欠落キーの初期化は書込前に拒否し、排他なしの保存へ切り替えない。
test('missing Web Locks fail closed for every write, while existing reads remain usable', async () => {
  for (const options of [{ noNavigator: true }, { noLocks: true }, { locks: null }, { locks: {} }]) {
    const store = backend({ clips: [clip()], categories: [] });
    const api = panel(store, options.locks, options);
    assert.deepEqual(structuredClone(await api.getClips()), [clip()]);
    await api.initializeStorage();
    for (const operation of [() => api.createClip(input()), () => api.updateClip(clip(), input()), () => api.deleteClip(clip())]) {
      await rejectsWithoutWrites(store, operation, /Web Locks/);
    }
    const missing = backend({});
    const opening = panel(missing, options.locks, options);
    await rejectsWithoutWrites(missing, () => opening.initializeStorage(), /Web Locks/);
  }
});

// ロックAPIは存在するが取得に失敗する条件を注入し、CRUDと初期化が同じ例外を返すことを確認する。
// 失敗を握りつぶして排他なしの書込を行わず、保存内容・書込試行数とも不変に保つ。
test('Web Locks acquisition failure never falls back to an unprotected write', async () => {
  const store = backend({ clips: [clip()], categories: [] });
  const locks = { request: async () => { throw new Error('Lock acquisition failed'); } };
  const api = panel(store, locks);
  for (const operation of [() => api.createClip(input()), () => api.updateClip(clip(), input()), () => api.deleteClip(clip())]) {
    await rejectsWithoutWrites(store, operation, /Lock acquisition failed/);
  }
  const missing = backend({});
  const opening = panel(missing, locks);
  await rejectsWithoutWrites(missing, () => opening.initializeStorage(), /Lock acquisition failed/);
});
