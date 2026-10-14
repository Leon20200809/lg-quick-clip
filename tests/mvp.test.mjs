/**
 * 入力先の安全検査・二段階通信・既存データ保護を、Node標準test/assert/vmで回帰確認する。
 * distの実コードを別の実行空間へ読み込み、DOM・Chrome APIは必要な応答だけ返すテスト用の代役にする。
 * 実Chromeのフォーカス、画面表示、拡張通信・永続化を再現する試験ではなく、実機受入とは分けて扱う。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
// テスト前のbuildで生成されたJSを読み、import/exportだけを外してvmへ渡す（実装の本体は差し替えない）。
const content = await readFile(new URL('../dist/content/content.js', import.meta.url), 'utf8');
const storage = (await readFile(new URL('../dist/storage/storage.js', import.meta.url), 'utf8')).replace(/^import .*;$/m, '').replaceAll('export ', '');
const panel = (await readFile(new URL('../dist/sidepanel/sidepanel.js', import.meta.url), 'utf8')).replace(/^import .*;$/m, '');

// 入力欄・focus/pointerイベント・runtime通信を代役にしてcontent scriptを実行する。
// focusで対象選択、insertで予約→入力を再現し、返却コード・value・emittedを検査する。実DOMのイベント伝播は再現しない。
function page() {
  const events = {}, winEvents = {}, registration = {};
  let receive, seq = 0;
  const document = { activeElement: null, visibilityState: 'visible', addEventListener: (name, fn, options) => { events[name] = fn; registration[name] = options; } };
  class Element { matches(selector) { return selector === ':disabled' ? this.disabled || this.fieldsetDisabled : Boolean(this.isField); } closest() { return null; } }
  class Input extends Element {
    constructor(type = 'text') { super(); Object.assign(this, { type, isField: true, isConnected: true, ownerDocument: document, readOnly: false, disabled: false, value: 'original', autocomplete: '', emitted: [] }); }
    getRootNode() { return document; }
    getAttribute() { return this.autocomplete; }
    dispatchEvent(event) { this.emitted.push(event); }
  }
  class Textarea extends Input {}
  class Iframe extends Element {}
  const window = { addEventListener: (name, fn) => winEvents[name] = fn }; window.top = window;
  const context = { document, window, Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, HTMLIFrameElement: Iframe,
    location: { protocol: 'https:' }, crypto: { getRandomValues: bytes => bytes.fill(++seq) }, Event: class { constructor(type, options) { Object.assign(this, { type }, options); } }, setTimeout: fn => fn(),
    chrome: { runtime: { id: 'extension', onMessage: { addListener: fn => receive = fn } } } };
  vm.runInNewContext(content, context);
  const send = message => { let result; receive(message, { id: 'extension' }, value => result = value); return result; };
  return { Input, Textarea, Iframe, document, context, events, winEvents, registration, send,
    focus(target) { document.activeElement = target; events.focusin({ target }); },
    insert(text = 'replacement') { const prep = send({ type: 'PREPARE_CLIP' }); return prep.ok ? send({ type: 'INSERT_TEXT', text, token: prep.token }) : prep; } };
}

// 正常系: text/email/tel/textareaを選んで挿入し、値の全置換とbubbles付きinputが1回だけ発生することを確認。
test('supported fields replace whole value and emit exactly one bubbling input', () => {
  for (const type of ['text', 'email', 'tel', 'textarea']) {
    const p = page(), field = type === 'textarea' ? new p.Textarea() : new p.Input(type);
    p.focus(field); assert.equal(p.insert().inserted, true); assert.equal(field.value, 'replacement');
    assert.equal(field.emitted.length, 1); assert.equal(field.emitted[0].type, 'input'); assert.equal(field.emitted[0].bubbles, true);
  }
});
// 対象除外: 未選択とpassword等の対象外型を試す。拒否コードだけでなく、以前選んだ欄にも書き込まないことを確認。
test('no selection and unsupported fields never fall back', () => {
  const p = page(); assert.equal(p.insert().code, 'NO_TARGET');
  for (const type of ['password', 'number', 'search', 'url', 'checkbox', 'date']) {
    const old = new p.Input(), blocked = new p.Input(type); p.focus(old); p.focus(blocked);
    assert.equal(p.insert().ok, false); assert.equal(old.value, 'original'); assert.equal(blocked.value, 'original');
  }
});
// 選択後にreadonly/disabled/切断/型/認証属性を変え、挿入直前の再検査で拒否され値が変わらないことを確認。
test('revalidate readonly, disabled fieldset, disconnected, changed type and authentication autocomplete', () => {
  const changes = [f => f.readOnly = true, f => f.disabled = true, f => f.fieldsetDisabled = true, f => f.isConnected = false, f => f.type = 'password',
    ...['username','current-password','new-password','one-time-code','webauthn'].map(token => f => f.autocomplete = `section-login ${token.toUpperCase()}`)];
  for (const change of changes) { const p = page(), f = new p.Input(); p.focus(f); change(f); assert.equal(p.insert().ok, false); assert.equal(f.value, 'original'); }
});
// 対象外への移動、iframeへのフォーカス、非表示、pagehideを再現。古い対象へ戻って書き込む退行を防ぐ。
test('unsupported focus, iframe focus, hidden page and pagehide are safe', () => {
  for (const act of [p => p.focus({}), p => { p.document.activeElement = new p.Iframe(); p.winEvents.blur(); }, p => p.document.visibilityState = 'hidden', p => p.winEvents.pagehide()]) {
    const p = page(), f = new p.Input(); p.focus(f); act(p); assert.equal(p.insert().ok, false); assert.equal(f.value, 'original');
  }
});
// capture登録を検査し、focusinが来ないdisabled欄やShadow DOM由来の押下を再現。古い対象が失効することを確認。
test('focus is captured and disabled/retargeted pointer transitions clear old targets', () => {
  const p = page(); assert.equal(p.registration.focusin, true); assert.equal(p.registration.pointerdown, true);
  for (const shadow of [false, true]) {
    const old = new p.Input(); p.focus(old);
    const clicked = shadow ? {} : new p.Input();
    if (shadow) Object.setPrototypeOf(clicked, Object.getPrototypeOf(Object.getPrototypeOf(old)));
    else clicked.disabled = true;
    p.events.pointerdown({target: clicked, composedPath: () => shadow ? [{}] : [clicked]});
    assert.equal(p.insert().ok, false); assert.equal(old.value, 'original');
  }
});
// 予約後の対象変更・同じtokenの再送・別文書への持越しを試す。正しい予約だけ1回使え、元の欄へ誤入力しないことを確認。
test('prepared request is one-use and invalid after target changes or on a new document', () => {
  const p = page(), a = new p.Input(), b = new p.Input(); p.focus(a);
  const prep = p.send({type:'PREPARE_CLIP'}); p.focus(b);
  assert.equal(p.send({type:'INSERT_TEXT',text:'oops',token:prep.token}).code,'STALE_TARGET');
  const next = p.send({type:'PREPARE_CLIP'}); assert.equal(p.send({type:'INSERT_TEXT',text:'ok',token:next.token}).inserted,true);
  assert.equal(p.send({type:'INSERT_TEXT',text:'oops',token:next.token}).code,'STALE_TARGET'); assert.equal(a.value,'original'); assert.equal(b.value,'ok');
  const fresh = page(), f = new fresh.Input(); fresh.focus(f); assert.equal(fresh.send({type:'INSERT_TEXT',text:'oops',token:next.token}).code,'STALE_TARGET');
});
// 異常系: fileプロトコル、文字列でない本文、value代入例外を注入。成功扱いせず、それぞれの失敗コードを返すことを確認。
test('wrong protocol, malformed payload and write exceptions return failure', () => {
  const p = page(), f = new p.Input(); p.focus(f); p.context.location.protocol = 'file:'; assert.equal(p.insert().code,'UNSUPPORTED_PAGE');
  p.context.location.protocol = 'https:'; const prep = p.send({type:'PREPARE_CLIP'});
  assert.equal(p.send({type:'INSERT_TEXT',text:42,token:prep.token}).code,'INVALID_MESSAGE');
  Object.defineProperty(f,'value',{set(){throw new Error('blocked');}}); assert.equal(p.insert().code,'WRITE_FAILED');
});

// 保存済みデータとget/setの代役を渡し、実storageモジュールの初期化・読込を試す。
// writesで上書きを検出し、failで読込失敗を注入する。ここでのlocksは即時実行の簡易版で、排他競合は別ファイルが担当。
async function stored(initial, fail = false) {
  const data = structuredClone(initial), writes = [];
  const context = { navigator: {locks: {request: async (_name, callback) => callback()}}, defaultCategories:[{id:'sample'}], defaultClips:[], chrome:{storage:{local:{
    get:async () => { if(fail) throw new Error('read failed'); return data; }, set:async values => { writes.push(values); Object.assign(data, values); }
  }}}};
  vm.runInNewContext(storage + '\nthis.api = {initializeStorage,getClips};', context);
  return { ...context.api, data, writes };
}
// 空配列・既存Clipを渡してsetが0回、キー未作成なら初期値を1回まとめて保存することを確認。空を未初期化と誤認しない。
test('storage only initializes absent keys and preserves valid empty or existing clips', async () => {
  for(const clips of [[], [{id:'x',categoryId:'p',label:'Saved',text:'kept',pinned:false,order:1}]]) {
    const s=await stored({clips,categories:[]}); await s.initializeStorage(); assert.deepEqual(s.writes,[]); assert.deepEqual(await s.getClips(),clips);
  }
  const s=await stored({}); await s.initializeStorage(); assert.equal(s.writes.length,1); assert.deepEqual(Object.keys(s.writes[0]).sort(), ['categories','clips']);
});
// null・不正型・無限order・読込例外を渡す。不正値をサンプルで上書きせず、読込失敗を呼出側へ伝えることを確認。
test('malformed or unreadable storage fails without overwriting existing values', async () => {
  for(const clips of [null,false,{},[{text:1}], [{id:'x',categoryId:'p',label:'x',text:'x',pinned:true,order:Infinity}]]) {
    const s=await stored({clips,categories:[]}); await s.initializeStorage(); assert.equal(s.writes.length,0); await assert.rejects(s.getClips());
  }
  const s=await stored({},true); await assert.rejects(s.initializeStorage()); assert.equal(s.writes.length,0);
});

// Panelの通信担当だけを切り出し、タブ一覧・受信応答・管理画面を差し替える。
// reply/queryで通信欠落やタブ変更を注入し、status・送信回数・ボタン復帰を観察する。実管理UIはclip-manager-ui.test.mjsが担当。
async function sidepanel({reply, query, storageFailure=false}={}) {
  const buttons=[], listeners={}, status={dataset:{}}, managementStatus={dataset:{}}; let sends=0, queries=0;
  const context={ createClipManager: insert => ({
    async start() {
      if (storageFailure) { managementStatus.dataset.state = 'error'; return; }
      buttons.push({disabled:false, click:()=>insert('text')});
    },
    setInsertionBusy(value) { buttons.forEach(button=>button.disabled=value); }
  }), getClips:async()=>[{label:'Sample',text:'text',pinned:false,order:1}], initializeStorage:async()=>{if(storageFailure) throw new Error('storage');},
    document:{querySelector:selector=>selector==='#status'?status:{appendChild:button=>buttons.push(button)},createElement:()=>({addEventListener(name,fn){this.click=fn;}})},
    chrome:{tabs:{onActivated:{addListener:fn=>listeners.activate=fn},onUpdated:{addListener:fn=>listeners.update=fn},
      query:async()=>query ? query(++queries,listeners):[{id:7}],
      sendMessage:async(id,message,options)=>{sends++; assert.equal(options.frameId,0); return reply ? reply(message,listeners) : message.type==='PREPARE_CLIP'?{ok:true,token:'t'}:{ok:true,inserted:true};}
    }} };
  await vm.runInNewContext(`(async()=>{${panel}\nthis.send=sendClipText;})()`,context);
  return {status,managementStatus,buttons,listeners,send:context.send,count:()=>sends};
}
// 受信側の入力完了応答がある時だけ成功にする。応答欠落・拒否・通信例外ではエラー表示となり、ボタンが再び使えることを確認。
test('panel requires receiver acknowledgement and catches transport errors', async()=>{
  const p=await sidepanel(); await p.send('x'); assert.match(p.status.textContent,/置き換えました/); assert.equal(p.count(),2);
  for(const reply of [()=>undefined,()=>({ok:false,code:'NO_TARGET'}),()=>({ok:true,token:''}),()=>({ok:true,token:'t',inserted:false}),()=>{throw new Error('no receiver');}]) {
    const p=await sidepanel({reply}); await p.send('x'); assert.equal(p.status.dataset.state,'error'); assert.doesNotMatch(p.status.textContent,/置き換えました/); assert.equal(p.buttons[0].disabled,false);
  }
});
// タブ変更・ページ読込・同時クリックを注入。古い対象への本文送信を止め、連打でも予約＋入力の1組だけになることを確認。
test('panel guards tab change, navigation and duplicate clicks', async()=>{
  const changed=await sidepanel({query:n=>[{id:n}]}); await changed.send('x'); assert.equal(changed.count(),1);
  const nav=await sidepanel({reply:(message,listeners)=>{listeners.update(7,{status:'loading'}); return {ok:true,token:'t'};}}); await nav.send('x'); assert.equal(nav.count(),1); assert.doesNotMatch(nav.status.textContent,/置き換えました/);
  const p=await sidepanel(); await Promise.all([p.send('x'),p.send('x')]); assert.equal(p.count(),2);
});
// タブなし・Chrome内部URLでは通信しない。管理画面の初期化失敗は管理用エラーとなり、Clipボタンを作らないことを確認。
test('panel handles no tab, unsupported URL and storage failure', async()=>{
  for(const query of [()=>[],()=>[{id:7,url:'chrome://extensions'}]]) {const p=await sidepanel({query}); await p.send('x'); assert.equal(p.count(),0); assert.equal(p.status.dataset.state,'error');}
  const p=await sidepanel({storageFailure:true}); assert.equal(p.buttons.length,0); assert.equal(p.managementStatus.dataset.state,'error');
});
// ビルド済みmanifestとcontent scriptを読む。権限追加・対象URL拡張・トップ以外への配信・module化が紛れ込む退行を防ぐ。
test('manifest keeps only existing permissions, HTTP(S), and classic content script',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../dist/manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.permissions,['storage','sidePanel']); assert.deepEqual(manifest.content_scripts[0].matches,['http://*/*','https://*/*']);
  assert.doesNotMatch(content,/^\s*(import|export)\s/m); assert.equal(manifest.content_scripts[0].all_frames,undefined);
});
