import { getClips, initializeStorage } from "../storage/storage.js";

const clipList = document.querySelector<HTMLDivElement>("#clip-list")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const buttons: HTMLButtonElement[] = [];
let busy = false;
let contextVersion = 0;
const errors: Record<QuickClipFailure, string> = {
  NO_TARGET: "ページ上の入力欄を選んでからClipを押してください。",
  UNSUPPORTED_TARGET: "この入力欄は対象外です。通常のtext・email・tel欄またはtextareaを選んでください。",
  UNSUPPORTED_PAGE: "通常のHTTP(S)ページで利用してください。",
  STALE_TARGET: "タブ・ページ・入力欄が変わりました。入力欄を選び直してください。",
  INVALID_MESSAGE: "通信内容を確認できませんでした。拡張とページを再読み込みしてください。",
  WRITE_FAILED: "入力できませんでした。入力欄を選び直してください。",
};

function show(message: string, error = false): void {
  status.textContent = message;
  status.dataset.state = error ? "error" : "info";
}
function contextChanged(): void {
  contextVersion++;
  show("タブ・ページが変わりました。入力欄を確認してからClipを押してください。");
}
chrome.tabs.onActivated.addListener(contextChanged);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.status === "loading") contextChanged();
});

function response(value: unknown): QuickClipResponse {
  if (!value || typeof value !== "object") throw new Error("入力結果を確認できませんでした。拡張とページを再読み込みしてください。");
  const result = value as Partial<{ ok: boolean; code: QuickClipFailure; token: string; inserted: boolean }>;
  if (result.ok === false && result.code && Object.hasOwn(errors, result.code)) throw new Error(errors[result.code]);
  if (result.ok === true && (typeof result.token === "string" || result.inserted === true)) return value as QuickClipResponse;
  throw new Error("入力結果を確認できませんでした。拡張とページを再読み込みしてください。");
}

async function sendClipText(text: string): Promise<void> {
  if (busy) return;
  busy = true;
  buttons.forEach(button => { button.disabled = true; });
  const version = contextVersion;
  show("入力先を確認しています…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id !== "number") throw new Error("現在のタブが見つかりません。ページを開いてください。");
    // URL may be absent without the tabs permission. The receiver also checks its protocol.
    if (tab.url && !/^https?:\/\//i.test(tab.url)) throw new Error(errors.UNSUPPORTED_PAGE);
    const prepared = response(await chrome.tabs.sendMessage(tab.id, { type: "PREPARE_CLIP" } satisfies QuickClipMessage, { frameId: 0 }));
    if (!("token" in prepared) || typeof prepared.token !== "string" || !prepared.token) throw new Error(errors.INVALID_MESSAGE);
    const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (version !== contextVersion || current?.id !== tab.id) throw new Error(errors.STALE_TARGET);
    const inserted = response(await chrome.tabs.sendMessage(tab.id, {
      type: "INSERT_TEXT", text, token: prepared.token,
    } satisfies QuickClipMessage, { frameId: 0 }));
    if (!("inserted" in inserted) || inserted.inserted !== true) throw new Error(errors.INVALID_MESSAGE);
    if (version === contextVersion) show("入力欄の値をClipで置き換えました。");
  } catch (error) {
    if (version === contextVersion) {
      const message = error instanceof Error ? error.message : "";
      const known = Object.values(errors).includes(message) || message.startsWith("現在のタブ") || message.startsWith("入力結果");
      show(known ? message : "このページには接続できません。HTTP(S)ページを再読み込みし、入力欄を選び直してください。Chrome内部ページ・Web Store等では利用できません。", true);
    }
  } finally {
    busy = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}

try {
  await initializeStorage();
  const clips = (await getClips()).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order);
  for (const clip of clips) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = clip.pinned ? `★ ${clip.label}` : clip.label;
    button.addEventListener("click", () => { void sendClipText(clip.text); });
    buttons.push(button);
    clipList.appendChild(button);
  }
  show(clips.length ? "ページ上の入力欄を選び、Clipで値を全置換します。" : "保存されたClipはありません。");
} catch {
  show("Clipを読み込めませんでした。保存データまたはストレージ接続を確認し、Side Panelを開き直してください。既存のClipは変更していません。", true);
}
