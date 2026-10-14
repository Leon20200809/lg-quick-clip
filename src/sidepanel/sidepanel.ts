/** 保存Clipを表示し、選択タブへの入力要求と利用者向けの結果表示を担当する。 */
import { createClipManager } from "./clip-manager.js";

const status = document.querySelector<HTMLParagraphElement>("#status")!;
const manager = createClipManager(sendClipText);
let busy = false;
let contextVersion = 0;
const errors: Record<QuickClipFailure, string> = {
  NO_TARGET: "ページ上の入力欄を選んでからClipを押してください。",
  UNSUPPORTED_TARGET:
    "この入力欄は対象外です。通常のtext・email・tel欄またはtextareaを選んでください。",
  UNSUPPORTED_PAGE: "通常のHTTP(S)ページで利用してください。",
  STALE_TARGET:
    "タブ・ページ・入力欄が変わりました。入力欄を選び直してください。",
  INVALID_MESSAGE:
    "通信内容を確認できませんでした。拡張とページを再読み込みしてください。",
  WRITE_FAILED: "入力できませんでした。入力欄を選び直してください。",
};

/** 結果を文字列として表示し、保存データや通信内容をHTMLとして解釈させない。 */
function show(message: string, error = false): void {
  status.textContent = message;
  status.dataset.state = error ? "error" : "info";
}
/** タブ・ページ変更の世代を進め、以前の通信結果が新しい案内を上書きしないようにする。 */
function contextChanged(): void {
  contextVersion++;
  show(
    "タブ・ページが変わりました。入力欄を確認してからClipを押してください。",
  );
}
chrome.tabs.onActivated.addListener(contextChanged);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.status === "loading") contextChanged();
});

/** 外部応答の基本形を検証し、既知の失敗コードを利用者向けの説明へ変換する。 */
function response(value: unknown): QuickClipResponse {
  if (!value || typeof value !== "object")
    throw new Error(
      "入力結果を確認できませんでした。拡張とページを再読み込みしてください。",
    );
  const result = value as Partial<{
    ok: boolean;
    code: QuickClipFailure;
    token: string;
    inserted: boolean;
  }>;
  if (result.ok === false && result.code && Object.hasOwn(errors, result.code))
    throw new Error(errors[result.code]);
  if (
    result.ok === true &&
    (typeof result.token === "string" || result.inserted === true)
  )
    return value as QuickClipResponse;
  throw new Error(
    "入力結果を確認できませんでした。拡張とページを再読み込みしてください。",
  );
}

/** 現在タブの入力先を予約・再確認して全置換を依頼し、受信側の実行結果を表示する。 */
async function sendClipText(text: string): Promise<void> {
  // 通信中の再クリックを抑え、同じ操作が並行して欄を置き換えないようにする。
  if (busy) return;
  busy = true;
  manager.setInsertionBusy(true);
  const version = contextVersion;
  show("入力先を確認しています…");
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (typeof tab?.id !== "number")
      throw new Error("現在のタブが見つかりません。ページを開いてください。");
    // tabs権限なしではURLが得られない場合があるため、受信側でもプロトコルを検査する。
    if (tab.url && !/^https?:\/\//i.test(tab.url))
      throw new Error(errors.UNSUPPORTED_PAGE);
    const prepared = response(
      await chrome.tabs.sendMessage(
        tab.id,
        { type: "PREPARE_CLIP" } satisfies QuickClipMessage,
        { frameId: 0 },
      ),
    );
    if (
      !("token" in prepared) ||
      typeof prepared.token !== "string" ||
      !prepared.token
    )
      throw new Error(errors.INVALID_MESSAGE);
    // 事前確認を待つ間のタブ切替・ナビゲーションを検知してから本文を送る。
    const [current] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (version !== contextVersion || current?.id !== tab.id)
      throw new Error(errors.STALE_TARGET);
    const inserted = response(
      await chrome.tabs.sendMessage(
        tab.id,
        {
          type: "INSERT_TEXT",
          text,
          token: prepared.token,
        } satisfies QuickClipMessage,
        { frameId: 0 },
      ),
    );
    // 予約成功だけでは入力成功にしない。入力段階の明示的な成功応答が必要。
    if (!("inserted" in inserted) || inserted.inserted !== true)
      throw new Error(errors.INVALID_MESSAGE);
    if (version === contextVersion) show("入力欄の値をClipで置き換えました。");
  } catch (error) {
    // 古い操作の失敗で新しい案内を上書きせず、未知の通信エラーは安全な復旧案内にまとめる。
    if (version === contextVersion) {
      const message = error instanceof Error ? error.message : "";
      const known =
        Object.values(errors).includes(message) ||
        message.startsWith("現在のタブ") ||
        message.startsWith("入力結果");
      show(
        known
          ? message
          : "このページには接続できません。HTTP(S)ページを再読み込みし、入力欄を選び直してください。Chrome内部ページ・Web Store等では利用できません。",
        true,
      );
    }
  } finally {
    busy = false;
    manager.setInsertionBusy(false);
  }
}

// 入力結果と管理結果を分け、タブ変更で未保存フォームの案内を消さない。
show("ページ上の入力欄を選び、Clipで値を全置換します。");
await manager.start();
