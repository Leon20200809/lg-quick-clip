import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the built module, as the extension does, without a browser dependency.
const managerSource = await readFile(new URL('../dist/sidepanel/clip-manager.js', import.meta.url), 'utf8');
const storageSource = await readFile(new URL('../dist/storage/storage.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../dist/sidepanel/sidepanel.html', import.meta.url), 'utf8');
const script = source => source.replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const validationContext = {};
vm.runInNewContext(`${script(storageSource)}\nthis.validate = validateClipInput;`, validationContext);

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
    // Match the browser's value API, not the original storage representation.
    this._value = this.tagName === 'INPUT' ? text.replace(/[\r\n]/g, '')
      : this.tagName === 'TEXTAREA' ? text.replace(/\r\n?/g, '\n') : text;
  }

  get value() { return this._value; }

  // Any attempt to interpret a persisted string as HTML is a test failure.
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

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.elements = new Map();
    this.activeElement = null;
    this.created = [];
    // Read the real HTML's initial state and accessibility attributes instead of
    // accidentally making those assertions pass by hard-coding them in the fake.
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

const savedClip = (changes = {}) => ({
  id: 'clip-1', categoryId: 'category-1', label: 'Saved label',
  text: 'Saved body\nSecond line', pinned: false, order: 1, ...changes,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
// Event handlers intentionally return void; yield to settle their promise chain.
const settle = () => new Promise(resolve => setImmediate(resolve));

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
    change: (values = { clips: { newValue: state.clips } }, area = 'local') => {
      for (const listener of changes) listener(values, area);
    },
    fill(label, text) { id('clip-label').value = label; id('clip-text').value = text; },
    open(mode) { (mode === 'create' ? id('new-clip') : action(mode)).click(); },
  };
}

function assertNoWrites(h) {
  assert.equal(h.calls.create.length + h.calls.update.length + h.calls.delete.length, 0);
}

function assertNoSaveSuccess(h) {
  assert.doesNotMatch(h.id('management-status').textContent, /Clipを(?:保存|削除)しました/);
}

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

test('empty list explains how to create a clip', async () => {
  const h = harness({ clips: [] });
  await h.start();
  assert.equal(h.rows().length, 0);
  assert.match(h.id('clip-list').textContent, /新規作成/);
  assert.equal(h.id('new-clip').disabled, false);
});

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

test('label-only edits preserve exact CRLF and CR body strings despite textarea normalization', async t => {
  for (const [name, body] of [
    ['CRLF', ' First\r\nSecond\r\n '],
    ['CR', ' First\rSecond\r '],
    ['mixed', ' First\r\nSecond\rThird\n '],
  ]) {
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

test('cancel buttons and Escape close every editor without storage writes', async t => {
  for (const mode of ['create', 'edit', 'delete']) {
    for (const method of ['button', 'escape']) {
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

test('failed create, update, and delete retain the editor and list without success or private error details', async t => {
  for (const mode of ['create', 'edit', 'delete']) {
    await t.test(mode, async () => {
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

test('pending writes guard repeated submit/confirm, cancellation, and self change notifications', async t => {
  for (const mode of ['create', 'edit', 'delete']) {
    await t.test(mode, async () => {
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
  // Editing controls do not accidentally clear an independent insertion lock.
  h.open('edit');
  h.id('cancel-edit').click();
  assert.equal(h.insertButton().disabled, true);
  h.manager.setInsertionBusy(false);
  for (let i = 0; i < h.rows().length; i++) assert.equal(h.insertButton(i).disabled, false);
  h.insertButton(1).click();
  await settle();
  assert.deepEqual(h.calls.insert, [h.state.clips[1].text]);
});

test('initial read failure is visible and creation stays disabled without writes', async () => {
  const h = harness({ read: () => { throw new Error('Read unavailable'); } });
  await h.start();
  assert.equal(h.id('management-status').dataset.state, 'error');
  assert.match(h.id('management-status').textContent, /読み込めませんでした/);
  assert.equal(h.id('new-clip').disabled, true);
  assert.equal(h.rows().length, 0);
  assertNoWrites(h);
});

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

test('missing Web Locks during first-use initialization fails visibly without resetting storage', async () => {
  const writes = [];
  const storageContext = {
    defaultCategories: [], defaultClips: [],
    chrome: { storage: { local: {
      get: async () => ({}),
      set: async values => writes.push(values),
    } } },
  };
  // No navigator.locks in this realm: use the real initializer for this boundary.
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
