import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const storageSource = (await readFile(new URL('../dist/storage/storage.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '')
  .replaceAll('export ', '');
const templatesSource = (await readFile(new URL('../dist/data/templates.js', import.meta.url), 'utf8'))
  .replaceAll('export ', '');
const templateContext = {};
vm.runInNewContext(`${templatesSource}\nthis.samples = { defaultCategories, defaultClips };`, templateContext);
const samples = structuredClone(templateContext.samples);
const tick = () => new Promise(resolve => setImmediate(resolve));
const input = (label = 'New clip', text = 'New text') => ({ label, text });
const clip = (id = 'existing', overrides = {}) => ({
  id, categoryId: 'personal', label: `Label ${id}`, text: `Text ${id}`, pinned: true, order: 3, ...overrides,
});
const category = (id = 'personal', order = 1) => ({ id, label: id, order });

// A browser-style shared backend: every get/set crosses an asynchronous boundary
// and reads return independent snapshots, as chrome.storage.local does.
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

// Separate VM contexts represent independently opened side panels. They share
// the same named Web Lock manager, rather than an in-process module mutex.
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

function fixture(initial, options = {}) {
  const store = backend(initial);
  const locks = lockManager();
  return { ...store, locks, api: panel(store, locks, options) };
}

async function rejectsWithoutWrites(s, action, pattern) {
  const before = structuredClone(s.data);
  const count = s.writes.length;
  const attempts = s.attempts.length;
  await assert.rejects(action, pattern);
  assert.deepEqual(s.data, before);
  assert.equal(s.writes.length, count);
  assert.equal(s.attempts.length, attempts);
}

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

test('label 80/81 and body 10000/10001 limits use UTF-16 units, including emoji', async t => {
  const cases = [
    ['ASCII', 'a'.repeat(80), 'a'.repeat(81), 'x'.repeat(10_000), 'x'.repeat(10_001)],
    ['emoji', '😀'.repeat(40), `${'😀'.repeat(40)}a`, '😀'.repeat(5_000), `${'😀'.repeat(5_000)}a`],
  ];
  for (const [name, goodLabel, badLabel, goodText, badText] of cases) {
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

test('body whitespace counts toward the limit and is never trimmed for validation or storage', async () => {
  const s = fixture();
  const atLimit = ` ${'x'.repeat(9_998)}\n`;
  await s.api.createClip(input('Whitespace boundary', atLimit));
  assert.equal(s.data.clips[0].text, atLimit);
  await rejectsWithoutWrites(s, () => s.api.createClip(input('Too long', `${atLimit}\t`)), /10000/);
  await rejectsWithoutWrites(s, () => s.api.updateClip(s.data.clips[0], input('Whitespace boundary', `${atLimit}\t`)), /10000/);
});

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

test('malformed runtime input fails without attempting a write', async () => {
  for (const values of [null, undefined, {}, { label: 1, text: 'valid' }, { label: 'valid', text: false }]) {
    const original = clip();
    const s = fixture({ clips: [original], categories: [] });
    await rejectsWithoutWrites(s, () => s.api.createClip(values));
    await rejectsWithoutWrites(s, () => s.api.updateClip(original, values));
  }
});

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

test('UUID collisions and unavailable UUID generation never overwrite existing clips', async () => {
  const original = clip('collision');
  const s = fixture({ clips: [original], categories: [] }, { randomUUID: () => 'collision' });
  await rejectsWithoutWrites(s, () => s.api.createClip(input()), /ID/);
  const unavailable = fixture({ clips: [], categories: [] }, { randomUUID: () => { throw new Error('UUID unavailable'); } });
  await rejectsWithoutWrites(unavailable, () => unavailable.api.createClip(input()), /UUID unavailable/);
});

test('unsafe or non-advancing maximum order is rejected without mutating legacy data', async () => {
  for (const order of [Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, 2 ** 53]) {
    const s = fixture({ clips: [clip('huge-order', { order })], categories: [] });
    await rejectsWithoutWrites(s, () => s.api.createClip(input()), /並び順/);
  }
});

test('finite fractional legacy order is preserved and new order advances without renumbering', async () => {
  const existing = clip('fractional', { order: 2.5 });
  const s = fixture({ clips: [existing], categories: [] });
  await s.api.createClip(input());
  assert.deepEqual(s.data.clips[0], existing);
  assert.equal(s.data.clips[1].order, 3.5);
});

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

test('concurrent deletion of unrelated originals preserves both operations', async () => {
  const first = clip('first'), second = clip('second'), survivor = clip('survivor');
  const s = fixture({ clips: [first, second, survivor], categories: [] });
  const a = panel(s, s.locks), b = panel(s, s.locks);
  await Promise.all([a.deleteClip(first), b.deleteClip(second)]);
  assert.deepEqual(s.data.clips, [survivor]);
  assert.equal(s.writes.length, 2);
});

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
