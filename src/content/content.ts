type QuickClipMessage = {
  type: "INSERT_TEXT";
  text: string;
};

/** 最後にフォーカスされた入力欄を保持する。 */
let lastFocusedElement: HTMLInputElement | HTMLTextAreaElement | null = null;

/** Webページ内でフォーカスが移動した入力欄を記憶する。 */
document.addEventListener("focusin", (event) => {
  const target = event.target;

  /** input または textarea の場合だけ挿入対象として記憶する。 */
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    lastFocusedElement = target;
  }
});

/** popup から送信された文字列を、最後にフォーカスされた入力欄へ挿入する。 */
chrome.runtime.onMessage.addListener((message: QuickClipMessage) => {
  if (message.type !== "INSERT_TEXT") {
    return;
  }

  /** 挿入対象の入力欄が記憶されていなければ処理を終了する。 */
  if (!lastFocusedElement) {
    console.warn("LG Quick Clip: 挿入対象の入力欄がありません。");
    return;
  }

  /** 入力欄の値をpopupから受け取った文字列で更新する。 */
  lastFocusedElement.value = message.text;

  /** Webページ側に値が変更されたことを通知するためinputイベントを発火する。 */
  lastFocusedElement.dispatchEvent(new Event("input", { bubbles: true }));
});
