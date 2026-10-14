// Clip管理UIの表示・入力・非同期処理を、Nodeのテストとvm内の代役DOMで検証する。
// ビルド済みの管理処理と検証関数を使い、保存APIや通知は差し替えて失敗・完了順を再現する。
// 実Chromeの描画、イベント伝播、拡張APIや実際の挿入先との連携は、このテストだけでは保証しない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 拡張が使うビルド成果物を読み、import/exportだけを除いて依存先を注入できるvmで実行する。
const managerSource = await readFile(new URL('../dist/sidepanel/clip-manager.js', import.meta.url), 'utf8');
const storageSource = await readFile(new URL('../dist/storage/storage.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../dist/sidepanel/sidepanel.html', import.meta.url), 'utf8');
const script = source => source.replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const validationContext = {};
vm.runInNewContext(`${script(storageSource)}\nthis.validate = validateClipInput;`, validationContext);

// 登録したイベントを同期的に呼び出す最小の代役。既定動作の抑止は記録するが伝播は再現しない。
class FakeEventTarget {
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  fire(type, properties = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...properties,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
}

// UIが利用する子要素・属性・フォーカス・無効化状態だけを持つ要素の代役。
// clickはdisabledを尊重し、fireは直接発火できるため、処理側の二重実行ガードも検証できる。
class FakeElement extends FakeEventTarget {
  constructor(tagName, ownerDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this._textContent = '';
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map(child => child.textContent).join('');
  }

  set value(value) {
    const text = String(value);
    // 保存文字列とDOM値は異なる。inputはCR/LFを除去し、textareaはCRLF・CRをLFへ正規化する。
    this._value = this.tagName === 'INPUT' ? text.replace(/[\r\n]/g, '')
      : this.tagName === 'TEXTAREA' ? text.replace(/\r\n?/g, '\n') : text;
  }

  get value() { return this._value; }

  // 保存文字列をHTMLとして解釈するAPIへ渡した時点で失敗させ、安全な文字列表示を守る。
  set innerHTML(_) { throw new Error('Unsafe innerHTML assignment'); }
  set outerHTML(_) { throw new Error('Unsafe outerHTML assignment'); }
  insertAdjacentHTML() { throw new Error('Unsafe insertAdjacentHTML call'); }

  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this._textContent = ''; this.children = [...children]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) return this.fire('click'); }
}

// 実HTMLからid付き要素を用意する代役。必要な初期属性とid検索だけを扱い、完全なDOM解析はしない。
class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.elements = new Map();
    this.activeElement = null;
    this.created = [];
    // hidden・disabled・アクセシビリティ属性を実HTMLから読む。
    // テストの期待値を代役側へ埋め込み、HTMLの不備を見逃すことを避ける。
    for (const match of markup.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
      const [, tag, attributes, id] = match;
      const element = this.createElement(tag);
      element.id = id;
      for (const attribute of attributes.matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/gi)) {
        element.setAttribute(attribute[1], attribute[2]);
      }
      element.hidden = /\bhidden(?:\s|$)/.test(attributes);
      element.disabled = /\bdisabled(?:\s|$)/.test(attributes);
      this.elements.set(id, element);
    }
  }

  createElement(tag) {
    const element = new FakeElement(tag, this);
    this.created.push(element);
    return element;
  }

  querySelector(selector) {
    assert.ok(selector.startsWith('#'), `Unexpected document selector: ${selector}`);
    return this.elements.get(selector.slice(1)) ?? null;
  }
}

// 各ケースの基準になる保存済みClip。上書き指定で境界値や外部変更を作り、条件の差を明確にする。
const savedClip = (changes = {}) => ({
  id: 'clip-1', categoryId: 'category-1', label: 'Saved label',
  text: 'Saved body\nSecond line', pinned: false, order: 1, ...changes,
});
// resolve/rejectをテスト側へ取り出し、保存待機や複数読込の完了順を任意に制御する。
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
// イベント処理はPromiseを返さないため、setImmediateまで譲って開始済みの非同期処理を進める。
// deferredで保留したPromise自体を解決する関数ではない。
const settle = () => new Promise(resolve => setImmediate(resolve));

// テストごとにDOM・呼出記録・保存状態の代役を作り、実際の管理モジュールへ注入する。
// 検証は既定で実関数を使うが、CRUDは呼出記録と指定した処理のみ。実ストレージの整合性とは検証範囲を分ける。
function harness(options = {}) {
  const document = new FakeDocument();
  const calls = { initialize: 0, reads: 0, create: [], update: [], delete: [], insert: [], validate: [] };
  const state = { clips: structuredClone(options.clips ?? [savedClip()]) };
  const changes = [];
  const context = {
    document, structuredClone, Error,
    CLIP_LIMITS: { label: 80, text: 10_000, count: 100 },
    initializeStorage: async () => {
      calls.initialize++;
      return options.initialize?.();
    },
    getClips: async () => {
      calls.reads++;
      return options.read ? options.read(calls.reads, state) : structuredClone(state.clips);
    },
    validateClipInput: (input, original) => {
      calls.validate.push(structuredClone({ input, original }));
      return options.validate ? options.validate(input, original) : validationContext.validate(input, original);
    },
    createClip: async input => {
      calls.create.push(structuredClone(input));
      return options.create?.(input, state);
    },
    updateClip: async (original, input) => {
      calls.update.push(structuredClone({ original, input }));
      return options.update?.(original, input, state);
    },
    deleteClip: async original => {
      calls.delete.push(structuredClone(original));
      return options.delete?.(original, state);
    },
    chrome: { storage: { onChanged: { addListener: listener => changes.push(listener) } } },
    recordInsert: text => { calls.insert.push(text); return options.insert?.(text); },
  };
  vm.runInNewContext(`${script(managerSource)}\nthis.manager = createClipManager(async text => recordInsert(text));`, context);
  const id = value => document.querySelector(`#${value}`);
  const rows = () => id('clip-list').children.filter(element => element.tagName === 'ARTICLE');
  const insertButton = (index = 0) => rows()[index].children[0];
  const action = (mode, index = 0) => rows()[index].children[2].children[mode === 'edit' ? 0 : 1];
  return {
    document, calls, state, manager: context.manager, id, rows, insertButton, action,
    start: () => context.manager.start(),
    submit: () => id('clip-form').fire('submit'),
    escape: () => document.fire('keydown', { key: 'Escape' }),
    // storage.onChangedを手動通知する。通知自体はstateを書き換えず、再読込が最新状態を取得する。
    change: (values = { clips: { newValue: state.clips } }, area = 'local') => {
      for (const listener of changes) listener(values, area);
    },
    fill(label, text) { id('clip-label').value = label; id('clip-text').value = text; },
    open(mode) { (mode === 'create' ? id('new-clip') : action(mode)).click(); },
  };
}

// UIからCRUDへの呼出が一度もないことをまとめて確認する。
function assertNoWrites(h) {
  assert.equal(h.calls.create.length + h.calls.update.length + h.calls.delete.length, 0);
}

// 失敗や入力エラーの後に、保存・削除の成功を誤表示していないことを確認する。
function assertNoSaveSuccess(h) {
  assert.doesNotMatch(h.id('management-status').textContent, /Clipを(?:保存|削除)しました/);
}

// 初期化前は操作を止め、読込後はピン優先・order順で並ぶことを確認する。
// HTML風の保存値も文字列と属性値のまま扱い、表示だけで書込みが起きる回帰を防ぐ。
test('initial loading disables creation; ready list is pinned-first, ordered, and text-only', async () => {
  const h = harness({ clips: [
    savedClip({ id: 'later', label: 'Later', order: 3 }),
    savedClip({ id: 'pinned', label: '<img src=x onerror=alert(1)>', pinned: true, order: 9, text: '<script>alert(1)</script>' }),
    savedClip({ id: 'earlier', label: 'Earlier', order: 1 }),
  ] });
  assert.equal(h.id('new-clip').disabled, true);
  assert.equal(h.id('clip-form').hidden, true);
  assert.equal(h.id('delete-confirmation').hidden, true);
  await h.start();
  assert.equal(h.calls.initialize, 1);
  assert.equal(h.id('new-clip').disabled, false);
  assert.deepEqual(h.rows().map(row => row.children[0].textContent), [
    '★ <img src=x onerror=alert(1)>', 'Earlier', 'Later',
  ]);
  assert.equal(h.rows()[0].children[1].textContent, '<script>alert(1)</script>');
  assert.equal(h.rows()[0].children[1].children.length, 0);
  assert.equal(h.action('edit').getAttribute('aria-label'), '<img src=x onerror=alert(1)>を編集');
  assertNoWrites(h);
});

// Clipが0件でも新規作成は利用でき、空表示に次の操作の案内があることを確認する。
test('empty list explains how to create a clip', async () => {
  const h = harness({ clips: [] });
  await h.start();
  assert.equal(h.rows().length, 0);
  assert.match(h.id('clip-list').textContent, /新規作成/);
  assert.equal(h.id('new-clip').disabled, false);
});

// 新規作成で前の下書きを消し、空欄エラーを各フィールドへ関連付けてフォーカスを移す。
// 一方を直すとそのエラーだけ解消し、不正な入力ではCRUDを呼ばないことを確認する。
test('create form resets values and associates validation messages with each field', async () => {
  const h = harness();
  await h.start();
  h.fill('stale draft label', 'stale draft body');
  h.open('create');
  assert.equal(h.id('clip-form').hidden, false);
  assert.equal(h.id('editor-title').textContent, 'Clipを作成');
  assert.equal(h.id('clip-label').value, '');
  assert.equal(h.id('clip-text').value, '');
  assert.equal(h.document.activeElement, h.id('clip-label'));
  assert.equal(h.id('new-clip').disabled, true);
  assert.equal(h.action('edit').disabled, true);
  const event = h.submit();
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.id('clip-label').getAttribute('aria-invalid'), 'true');
  assert.equal(h.id('clip-text').getAttribute('aria-invalid'), 'true');
  for (const [field, error] of [['clip-label', 'label-error'], ['clip-text', 'text-error']]) {
    assert.ok(h.id(field).getAttribute('aria-describedby').split(/\s+/).includes(error));
    assert.ok(h.id(error).textContent.length > 0);
    assert.match(markup, new RegExp(`<label\\s+for="${field}"`));
  }
  assert.equal(h.document.activeElement, h.id('clip-label'));
  assertNoWrites(h);
  h.fill('Valid label', '  \n');
  h.submit();
  assert.equal(h.id('clip-label').getAttribute('aria-invalid'), null);
  assert.equal(h.id('label-error').textContent, '');
  assert.equal(h.document.activeElement, h.id('clip-text'));
  assertNoWrites(h);
});

// 上限を1文字超える新規値を渡し、入力を勝手に切り詰めずエラー表示だけ行うことを確認する。
test('oversized new values fail validation without truncating the draft', async () => {
  const h = harness();
  await h.start();
  h.open('create');
  h.fill('x'.repeat(81), 'y'.repeat(10_001));
  h.submit();
  assert.match(h.id('label-error').textContent, /80/);
  assert.match(h.id('text-error').textContent, /10000/);
  assert.equal(h.id('clip-label').value.length, 81);
  assert.equal(h.id('clip-text').value.length, 10_001);
  assertNoWrites(h);
});

// 空白・改行・HTML風文字列を含む新規入力が、そのままcreateへ渡ることを確認する。
// 成功後の再読込・フォーム終了・フォーカス復帰を検証し、作成と本文挿入を混同させない。
test('successful create sends exact form values to storage, refreshes, and never inserts', async () => {
  const h = harness({ create: (input, state) => {
    state.clips.push(savedClip({ id: 'created', ...input, order: 2 }));
  } });
  await h.start();
  h.open('create');
  const input = { label: '  <b>New label</b>  ', text: ' \n<p>body</p>\n ' };
  h.fill(input.label, input.text);
  h.submit();
  await settle();
  assert.deepEqual(h.calls.create, [input]);
  assert.equal(h.calls.validate[0].original, undefined);
  assert.equal(h.calls.insert.length, 0);
  assert.equal(h.calls.reads, 2);
  assert.equal(h.rows().length, 2);
  assert.equal(h.id('clip-form').hidden, true);
  assert.equal(h.document.activeElement, h.id('new-clip'));
  assert.equal(h.id('new-clip').disabled, false);
  assert.equal(h.id('management-status').textContent, 'Clipを保存しました。');
  assert.equal(h.id('management-status').dataset.state, 'info');
});

// 編集開始時の値を表示し、変更後も元Clipの追加属性を含む全スナップショットを渡す。
// 検証とupdateが同じ元データを受け取り、新規作成や挿入へ流れないことを確認する。
test('edit preloads exact values and passes the full opening snapshot to validation and update', async () => {
  const original = savedClip({ label: '  Existing  ', text: '\nOriginal\n ', pinned: true, order: 12, extra: 'preserve' });
  const h = harness({ clips: [original] });
  await h.start();
  h.open('edit');
  assert.equal(h.id('editor-title').textContent, 'Clipを編集');
  assert.equal(h.id('clip-label').value, original.label);
  assert.equal(h.id('clip-text').value, original.text);
  const input = { label: 'Changed', text: ' \nChanged body\n ' };
  h.fill(input.label, input.text);
  h.submit();
  await settle();
  assert.deepEqual(h.calls.validate, [{ original, input }]);
  assert.deepEqual(h.calls.update, [{ original, input }]);
  assert.equal(h.calls.create.length, 0);
  assert.equal(h.calls.insert.length, 0);
  assert.equal(h.id('clip-form').hidden, true);
});

// 既存の上限超過データは未変更なら保持できる。表示・保存時の切り詰めや誤った再検証拒否を防ぐ。
test('unchanged oversized legacy fields can be saved without silent UI truncation', async () => {
  const original = savedClip({ label: 'l'.repeat(81), text: 't'.repeat(10_001) });
  const h = harness({ clips: [original] });
  await h.start();
  h.open('edit');
  assert.equal(h.id('clip-label').value, original.label);
  assert.equal(h.id('clip-text').value, original.text);
  h.submit();
  await settle();
  assert.deepEqual(h.calls.update[0], { original, input: { label: original.label, text: original.text } });
  assert.equal(h.id('label-error').textContent, '');
  assert.equal(h.id('text-error').textContent, '');
});

// ラベルだけの編集で、textareaの改行正規化を本文変更と誤認しないことを確認する。
// 表示値はLFでも、検証・updateには未変更の保存文字列を渡して元の改行を保つ。
test('label-only edits preserve exact CRLF and CR body strings despite textarea normalization', async t => {
  for (const [name, body] of [
    ['CRLF', ' First\r\nSecond\r\n '],
    ['CR', ' First\rSecond\r '],
    ['mixed', ' First\r\nSecond\rThird\n '],
  ]) {
    // CRLF・CR・混在の3条件を別々に実行し、表示値と保存値が異なる場合の保護を確認する。
    await t.test(name, async () => {
      const original = savedClip({ text: body });
      const h = harness({ clips: [original] });
      await h.start();
      h.open('edit');
      assert.equal(h.id('clip-text').value, body.replace(/\r\n?/g, '\n'));
      assert.notEqual(h.id('clip-text').value, body);
      h.id('clip-label').value = 'Updated label';
      h.submit();
      await settle();
      const expected = { original, input: { label: 'Updated label', text: body } };
      assert.deepEqual(h.calls.validate, [expected]);
      assert.deepEqual(h.calls.update, [expected]);
      assert.equal(h.id('management-status').textContent, 'Clipを保存しました。');
    });
  }
});

// input表示では消える既存ラベルのCR/LFを、本文だけの編集で失わないことを確認する。
// DOM上の未変更判定から元ラベルを復元し、検証とupdateへ渡す境界を守る。
test('text-only edits preserve a legacy multiline label stripped by the text input', async () => {
  const original = savedClip({ label: ' Legacy\r\nmultiline\rlabel\n ' });
  const h = harness({ clips: [original] });
  await h.start();
  h.open('edit');
  assert.equal(h.id('clip-label').value, ' Legacymultilinelabel ');
  h.id('clip-text').value = 'Changed body';
  h.submit();
  await settle();
  const expected = { original, input: { label: original.label, text: 'Changed body' } };
  assert.deepEqual(h.calls.validate, [expected]);
  assert.deepEqual(h.calls.update, [expected]);
});

// 保存値15000文字がDOMでは10000文字になる条件でも、未変更の本文は元の長さ・改行で保存する。
// ラベル変更だけで既存の上限超過本文を拒否したり、LFへ書き換えたりする回帰を防ぐ。
test('oversized CRLF body remains valid when untouched after normalization', async () => {
  const original = savedClip({ text: 'x\r\n'.repeat(5_000) });
  const h = harness({ clips: [original] });
  await h.start();
  h.open('edit');
  assert.equal(original.text.length, 15_000);
  assert.equal(h.id('clip-text').value.length, 10_000);
  h.id('clip-label').value = 'Changed label';
  h.submit();
  await settle();
  assert.deepEqual(h.calls.update, [{ original, input: { label: 'Changed label', text: original.text } }]);
  assert.equal(h.id('text-error').textContent, '');
  assert.equal(h.id('clip-form').hidden, true);
});

// 正規化後の本文へ1文字加えた場合は、未変更例外を適用せず現在のDOM値10001文字を検証する。
// エラーと下書きを残して保存しないことを確認し、元の本文による変更の見落としを防ぐ。
test('actually changed oversized CRLF body is rejected using its current DOM value', async () => {
  const original = savedClip({ text: 'x\r\n'.repeat(5_000) });
  const h = harness({ clips: [original] });
  await h.start();
  h.open('edit');
  h.id('clip-text').value += 'y';
  h.submit();
  await settle();
  assert.equal(h.id('clip-text').value.length, 10_001);
  assert.equal(h.calls.validate[0].input.text, 'x\n'.repeat(5_000) + 'y');
  assert.equal(h.id('clip-text').getAttribute('aria-invalid'), 'true');
  assert.match(h.id('text-error').textContent, /10000/);
  assert.equal(h.id('clip-form').hidden, false);
  assertNoWrites(h);
  assertNoSaveSuccess(h);
});

// 作成・編集・削除の各画面で取消操作を試し、一覧を変えずに閉じてエラーとフォーカスを戻す。
test('cancel buttons and Escape close every editor without storage writes', async t => {
  for (const mode of ['create', 'edit', 'delete']) {
    for (const method of ['button', 'escape']) {
      // 3画面×ボタン/Escapeの6条件。下書きや確認画面があっても書込み・挿入が起きないことを確認する。
      await t.test(`${mode}: ${method}`, async () => {
        const h = harness();
        await h.start();
        const listBefore = h.id('clip-list').textContent;
        h.open(mode);
        if (mode !== 'delete') {
          h.fill('', '');
          h.submit();
          h.fill('Unsaved changes', 'Unsaved body');
        }
        if (method === 'escape') assert.equal(h.escape().defaultPrevented, true);
        else h.id(mode === 'delete' ? 'cancel-delete' : 'cancel-edit').click();
        assert.equal(h.id('clip-form').hidden, true);
        assert.equal(h.id('delete-confirmation').hidden, true);
        assert.equal(h.id('clip-list').textContent, listBefore);
        assert.equal(h.id('label-error').textContent, '');
        assert.equal(h.id('text-error').textContent, '');
        assert.equal(h.id('clip-label').getAttribute('aria-invalid'), null);
        assert.equal(h.id('clip-text').getAttribute('aria-invalid'), null);
        assert.equal(h.id('new-clip').disabled, false);
        assert.equal(h.document.activeElement, h.id('new-clip'));
        assertNoWrites(h);
        assert.equal(h.calls.insert.length, 0);
        assert.match(h.id('management-status').textContent, /キャンセル/);
      });
    }
  }
});

// 削除画面を開くだけでは書き込まず、取消側へフォーカスし、本文を120文字までの文字列で示す。
// 明示確認後だけ元Clipをdeleteへ渡し、再読込した空一覧と削除成功を表示する。
test('delete requires explicit confirmation and shows a bounded literal preview', async () => {
  const original = savedClip({ label: '<img src=x>', text: '<script>not HTML</script>' + 'x'.repeat(150) });
  const h = harness({ clips: [original], delete: (_, state) => { state.clips = []; } });
  await h.start();
  h.open('delete');
  assert.equal(h.id('delete-confirmation').hidden, false);
  assert.equal(h.id('clip-form').hidden, true);
  assert.equal(h.document.activeElement, h.id('cancel-delete'));
  assert.equal(h.id('delete-description').textContent, `「${original.label}」を削除しますか？ 本文: ${original.text.slice(0, 120)}…`);
  assert.equal(h.id('delete-description').children.length, 0);
  assertNoWrites(h);
  h.id('confirm-delete').click();
  await settle();
  assert.deepEqual(h.calls.delete, [original]);
  assert.equal(h.id('delete-confirmation').hidden, true);
  assert.equal(h.rows().length, 0);
  assert.equal(h.calls.insert.length, 0);
  assert.equal(h.id('management-status').textContent, 'Clipを削除しました。');
});

// 書込APIを失敗させ、一覧・入力・削除プレビューを保持し、再試行可能な状態へ戻すことを確認する。
// 未知のエラーの私的な内容や偽の成功表示が、利用者向けメッセージへ漏れる回帰を防ぐ。
test('failed create, update, and delete retain the editor and list without success or private error details', async t => {
  for (const mode of ['create', 'edit', 'delete']) {
    await t.test(mode, async () => {
      // 作成・編集・削除それぞれに同じ未知エラーを注入し、共通の失敗処理を検証する。
      const fail = async () => { throw new Error('quota failure: private stored content'); };
      const h = harness({ create: fail, update: fail, delete: fail });
      await h.start();
      const rowsBefore = [...h.rows()];
      h.open(mode);
      h.fill('My unsaved label', 'My unsaved\nbody');
      const previewBefore = h.id('delete-description').textContent;
      if (mode === 'delete') h.id('confirm-delete').click();
      else h.submit();
      await settle();
      assert.equal(h.id(mode === 'delete' ? 'delete-confirmation' : 'clip-form').hidden, false);
      assert.equal(h.id('clip-label').value, 'My unsaved label');
      assert.equal(h.id('clip-text').value, 'My unsaved\nbody');
      assert.equal(h.id('delete-description').textContent, previewBefore);
      assert.deepEqual(h.rows(), rowsBefore);
      assert.equal(h.calls.reads, 1);
      assert.equal(h.id('management-status').dataset.state, 'error');
      assert.match(h.id('management-status').textContent, /保存できませんでした/);
      assert.doesNotMatch(h.id('management-status').textContent, /private stored content/);
      assertNoSaveSuccess(h);
      assert.equal(h.id('save-clip').disabled, false);
      assert.equal(h.id('cancel-edit').disabled, false);
      assert.equal(h.id('confirm-delete').disabled, false);
      assert.equal(h.id('new-clip').disabled, true);
      assert.equal(h.calls.insert.length, 0);
    });
  }
});

// 既知の競合エラーは対処案内をそのまま表示し、下書きを残して安全に取消できることを確認する。
test('known conflict failures are shown and permit a safe cancel without a false success', async () => {
  const message = 'このClipは別の画面で変更または削除されました。入力内容を控え、キャンセルして最新のClipを選び直してください。';
  const h = harness({ update: () => { throw new Error(message); } });
  await h.start();
  h.open('edit');
  h.fill('Draft', 'Draft body');
  h.submit();
  await settle();
  assert.equal(h.id('management-status').textContent, message);
  assert.equal(h.id('clip-form').hidden, false);
  assertNoSaveSuccess(h);
  h.id('cancel-edit').click();
  assert.equal(h.id('clip-form').hidden, true);
  assert.equal(h.calls.update.length, 1);
});

// 保存Promiseを保留し、連打・取消・Escape・自分の変更通知が書込中の状態を崩さないことを確認する。
// 完了時だけ一覧を再読込し、書込みは一度、操作ロックは確実に解除されることを検証する。
test('pending writes guard repeated submit/confirm, cancellation, and self change notifications', async t => {
  for (const mode of ['create', 'edit', 'delete']) {
    await t.test(mode, async () => {
      // 作成・編集・削除の3経路で、disabledを迂回した直接発火にも処理側のガードが効くことを確かめる。
      const write = deferred();
      const h = harness({ create: () => write.promise, update: () => write.promise, delete: () => write.promise });
      await h.start();
      h.open(mode);
      h.fill('Pending label', 'Pending text');
      const attempt = () => mode === 'delete' ? h.id('confirm-delete').fire('click') : h.submit();
      attempt();
      attempt();
      attempt();
      for (const id of ['new-clip', 'clip-label', 'clip-text', 'save-clip', 'cancel-edit', 'confirm-delete', 'cancel-delete']) {
        assert.equal(h.id(id).disabled, true, `${id} is disabled during a write`);
      }
      h.id('cancel-edit').fire('click');
      h.id('cancel-delete').fire('click');
      assert.equal(h.escape().defaultPrevented, false);
      h.change();
      assert.equal(h.calls.reads, 1);
      assert.equal(h.id(mode === 'delete' ? 'delete-confirmation' : 'clip-form').hidden, false);
      const calls = h.calls[mode === 'edit' ? 'update' : mode];
      assert.equal(calls.length, 1);
      write.resolve();
      await settle();
      assert.equal(calls.length, 1);
      assert.equal(h.calls.reads, 2);
      assert.equal(h.id('clip-form').hidden, true);
      assert.equal(h.id('delete-confirmation').hidden, true);
      assert.equal(h.id('new-clip').disabled, false);
    });
  }
});

// localのclips変更だけで一覧を更新し、編集中の下書きと開始時スナップショットは保持する。
// 外部変更後も古い元Clipをupdateへ渡すことで、保存層の競合検出に必要な比較元を失わない。
test('storage refresh updates the list without changing an unsaved edit or its conflict snapshot', async () => {
  const original = savedClip();
  const h = harness({ clips: [original] });
  await h.start();
  h.open('edit');
  h.fill('Draft label', 'Draft\nbody');
  h.state.clips = [savedClip({ label: 'Changed elsewhere', text: 'Remote body', pinned: true })];
  h.change({}, 'local');
  h.change({ categories: {} }, 'local');
  h.change({ clips: {} }, 'sync');
  assert.equal(h.calls.reads, 1);
  h.change();
  await settle();
  assert.equal(h.calls.reads, 2);
  assert.equal(h.insertButton().textContent, '★ Changed elsewhere');
  assert.equal(h.id('clip-label').value, 'Draft label');
  assert.equal(h.id('clip-text').value, 'Draft\nbody');
  assert.equal(h.id('clip-form').hidden, false);
  assert.equal(h.action('edit').disabled, true);
  h.submit();
  await settle();
  assert.deepEqual(h.calls.update, [{ original, input: { label: 'Draft label', text: 'Draft\nbody' } }]);
});

// 新規作成中に外部追加を通知し、一覧だけを更新することを確認する。
// 下書き・既存のエラー・フォーカスを再描画で消し、入力作業を中断する回帰を防ぐ。
test('storage refresh preserves a new draft, its field errors, and keyboard focus', async () => {
  const h = harness();
  await h.start();
  h.open('create');
  h.fill('Draft label', '');
  h.submit();
  const textError = h.id('text-error').textContent;
  h.id('clip-text').value = 'Still composing\n';
  h.state.clips.push(savedClip({ id: 'remote-created', label: 'Created elsewhere', order: 2 }));
  h.change();
  await settle();
  assert.equal(h.rows().length, 2);
  assert.equal(h.id('clip-form').hidden, false);
  assert.equal(h.id('clip-label').value, 'Draft label');
  assert.equal(h.id('clip-text').value, 'Still composing\n');
  assert.equal(h.id('text-error').textContent, textError);
  assert.equal(h.id('clip-text').getAttribute('aria-invalid'), 'true');
  assert.equal(h.document.activeElement, h.id('clip-text'));
  assertNoWrites(h);
});

// 削除確認中の外部変更は一覧にだけ反映し、利用者が確認したプレビューと元Clipを保つ。
// 確認後のdeleteにも開始時のスナップショットを渡し、無断で最新データへ対象を差し替えない。
test('storage refresh preserves the deletion preview and opening snapshot', async () => {
  const original = savedClip();
  const h = harness({ clips: [original] });
  await h.start();
  h.open('delete');
  const description = h.id('delete-description').textContent;
  h.state.clips = [savedClip({ label: 'Remote label', text: 'Remote body' })];
  h.change();
  await settle();
  assert.equal(h.insertButton().textContent, 'Remote label');
  assert.equal(h.id('delete-description').textContent, description);
  assert.equal(h.id('delete-confirmation').hidden, false);
  h.id('confirm-delete').click();
  await settle();
  assert.deepEqual(h.calls.delete, [original]);
});

// 2回の再読込を新→旧の順に解決し、遅れた古い結果で最新一覧や操作可能状態を巻き戻さない。
test('late older refresh cannot roll back a newer list or its ready controls', async () => {
  const older = deferred(), newer = deferred();
  const h = harness({ read: call => call === 1 ? [savedClip()] : call === 2 ? older.promise : newer.promise });
  await h.start();
  h.change();
  h.change();
  newer.resolve([savedClip({ label: 'Latest value' })]);
  await settle();
  assert.equal(h.insertButton().textContent, 'Latest value');
  older.resolve([savedClip({ label: 'Outdated value' })]);
  await settle();
  assert.equal(h.insertButton().textContent, 'Latest value');
  assert.equal(h.id('new-clip').disabled, false);
});

// 新しい読込の成功後に古い読込を失敗させ、無効な失敗が状態表示や作成ボタンを上書きしない。
test('late older read failure cannot overwrite a newer successful refresh status', async () => {
  const older = deferred(), newer = deferred();
  const h = harness({ read: call => call === 1 ? [savedClip()] : call === 2 ? older.promise : newer.promise });
  await h.start();
  h.change();
  h.change();
  newer.resolve([savedClip({ label: 'Latest value' })]);
  await settle();
  const statusBefore = h.id('management-status').textContent;
  older.reject(new Error('Stale request failed'));
  await settle();
  assert.equal(h.insertButton().textContent, 'Latest value');
  assert.equal(h.id('management-status').textContent, statusBefore);
  assert.equal(h.id('new-clip').disabled, false);
});

// 挿入ボタンは元本文をそのまま渡し、その後の編集・作成・削除では挿入回数が増えないことを確認する。
test('only insertion buttons invoke the insertion callback, independently of management status', async () => {
  const original = savedClip({ text: ' Exact\ninserted body ' });
  const h = harness({ clips: [original] });
  await h.start();
  h.insertButton().click();
  await settle();
  assert.deepEqual(h.calls.insert, [original.text]);
  assertNoWrites(h);
  h.open('edit');
  h.fill('Edited label', 'Edited body');
  h.submit();
  await settle();
  h.open('create');
  h.fill('New label', 'New body');
  h.submit();
  await settle();
  h.open('delete');
  h.id('confirm-delete').click();
  await settle();
  assert.deepEqual(h.calls.insert, [original.text]);
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.calls.delete.length, 1);
});

// 挿入中に一覧を再描画しても、新しい行を含め全挿入ボタンのロックが続くことを確認する。
// 解除時には現在の全ボタンへ反映し、独立した管理操作で挿入状態を変えない。
test('insertion busy state survives storage rerenders and is released on every current button', async () => {
  const h = harness();
  await h.start();
  h.manager.setInsertionBusy(true);
  assert.equal(h.insertButton().disabled, true);
  h.state.clips.push(savedClip({ id: 'second', label: 'Second', order: 2 }));
  h.change();
  await settle();
  assert.equal(h.rows().length, 2);
  for (let i = 0; i < h.rows().length; i++) {
    assert.equal(h.insertButton(i).disabled, true);
    h.insertButton(i).click();
  }
  assert.equal(h.calls.insert.length, 0);
  // 編集を開いて取り消しても、独立して管理する挿入ロックを解除してはいけない。
  h.open('edit');
  h.id('cancel-edit').click();
  assert.equal(h.insertButton().disabled, true);
  h.manager.setInsertionBusy(false);
  for (let i = 0; i < h.rows().length; i++) assert.equal(h.insertButton(i).disabled, false);
  h.insertButton(1).click();
  await settle();
  assert.deepEqual(h.calls.insert, [h.state.clips[1].text]);
});

// 初回読込を失敗させ、エラーを表示して新規作成を止め、データ未取得のまま書き込まないことを確認する。
test('initial read failure is visible and creation stays disabled without writes', async () => {
  const h = harness({ read: () => { throw new Error('Read unavailable'); } });
  await h.start();
  assert.equal(h.id('management-status').dataset.state, 'error');
  assert.match(h.id('management-status').textContent, /読み込めませんでした/);
  assert.equal(h.id('new-clip').disabled, true);
  assert.equal(h.rows().length, 0);
  assertNoWrites(h);
});

// 初回は成功し次の読込だけを失敗させ、既存の一覧と未保存入力を保持してエラーを表示する。
test('refresh read failure retains the displayed list and an unsaved editor', async () => {
  const h = harness({ read: call => {
    if (call > 1) throw new Error('Read unavailable');
    return [savedClip()];
  } });
  await h.start();
  h.open('edit');
  h.fill('Unsaved label', 'Unsaved body');
  const rowsBefore = [...h.rows()];
  h.change();
  await settle();
  assert.deepEqual(h.rows(), rowsBefore);
  assert.equal(h.id('clip-form').hidden, false);
  assert.equal(h.id('clip-label').value, 'Unsaved label');
  assert.equal(h.id('clip-text').value, 'Unsaved body');
  assert.equal(h.id('management-status').dataset.state, 'error');
  assert.match(h.id('management-status').textContent, /読み込めませんでした/);
  assertNoSaveSuccess(h);
  assertNoWrites(h);
});

// 保存成功後の一覧読込だけを失敗させ、書込失敗とは異なる案内と閉じたフォームを確認する。
// 再submitしても作成を再送せず、二重作成につながる回帰を防ぐ。
test('successful write followed by failed refresh is reported distinctly and never resent', async () => {
  const h = harness({ read: call => {
    if (call > 1) throw new Error('Refresh failed');
    return [savedClip()];
  } });
  await h.start();
  h.open('create');
  h.fill('New label', 'New body');
  h.submit();
  await settle();
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.id('clip-form').hidden, true);
  assert.equal(h.id('management-status').dataset.state, 'error');
  assert.match(h.id('management-status').textContent, /保存は完了しましたが一覧を再読込できません/);
  h.submit();
  await settle();
  assert.equal(h.calls.create.length, 1);
});

// 保存後の再読込より新しい通知読込を先に完了し、古い結果が無効化される条件を再現する。
// 「更新不要」を「読込失敗」と誤認せず、最新一覧と保存成功表示を維持することを確認する。
test('post-save refresh superseded by a newer storage refresh does not show a false reload failure', async () => {
  const afterSave = deferred(), afterChange = deferred();
  const h = harness({ read: call => call === 1 ? [savedClip()] : call === 2 ? afterSave.promise : afterChange.promise });
  await h.start();
  h.open('create');
  h.fill('Created label', 'Created body');
  h.submit();
  await settle();
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.calls.reads, 2);
  assert.equal(h.id('clip-form').hidden, true);
  h.change();
  assert.equal(h.calls.reads, 3);
  afterChange.resolve([savedClip({ label: 'Newest after save' })]);
  await settle();
  assert.equal(h.insertButton().textContent, 'Newest after save');
  afterSave.resolve([savedClip({ label: 'Older after save' })]);
  await settle();
  assert.equal(h.insertButton().textContent, 'Newest after save');
  assert.equal(h.id('management-status').textContent, 'Clipを保存しました。');
  assert.equal(h.id('management-status').dataset.state, 'info');
  assert.equal(h.id('new-clip').disabled, false);
  assert.equal(h.calls.create.length, 1);
});

// Web Locksのない環境で実初期化関数を動かし、安全な保存ができない場合のUI案内を確認する。
// 初期化エラー後に一覧読込や保存をせず、既存データをリセットしない境界を守る。
test('missing Web Locks during first-use initialization fails visibly without resetting storage', async () => {
  const writes = [];
  const storageContext = {
    defaultCategories: [], defaultClips: [],
    chrome: { storage: { local: {
      get: async () => ({}),
      set: async values => writes.push(values),
    } } },
  };
  // このvmにはnavigator.locksを用意せず、初期化だけは代役でなく実関数を使う。
  vm.runInNewContext(`${script(storageSource)}\nthis.initialize = initializeStorage;`, storageContext);
  const h = harness({ initialize: storageContext.initialize });
  await h.start();
  assert.equal(h.id('management-status').dataset.state, 'error');
  assert.match(h.id('management-status').textContent, /初期化できませんでした/);
  assert.match(h.id('management-status').textContent, /Web Locks/);
  assert.match(h.id('management-status').textContent, /既存データはリセットしていません/);
  assert.equal(h.id('new-clip').disabled, true);
  assert.equal(h.calls.reads, 0);
  assert.deepEqual(writes, []);
  assertNoWrites(h);
});
