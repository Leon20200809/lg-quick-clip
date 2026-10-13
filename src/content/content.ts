/** ページで選ばれた入力欄を管理し、Side Panelからの全置換要求を安全確認後に実行する。 */
(() => {
  let target: HTMLInputElement | HTMLTextAreaElement | null = null;
  let failure: QuickClipFailure = "NO_TARGET";
  let token: string | null = null;
  const authTokens = new Set([
    "username",
    "current-password",
    "new-password",
    "one-time-code",
    "webauthn",
  ]);

  /** 通常入力欄として書込み可能かを判定し、認証用途がautocompleteで明示された欄・別文書・Shadow DOMを除外する。 */
  function supported(
    element: EventTarget | null,
  ): element is HTMLInputElement | HTMLTextAreaElement {
    if (!(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ))
      return false;
    return (
      element.isConnected &&
      element.ownerDocument === document &&
      element.getRootNode() === document &&
      !element.readOnly &&
      !element.matches(":disabled") &&
      (!(element instanceof HTMLInputElement) ||
        ["text", "email", "tel"].includes(element.type)) &&
      !(element.getAttribute("autocomplete") ?? "")
        .toLowerCase()
        .split(/\s+/)
        .some((value) => authTokens.has(value))
    );
  }

  /** 対象と予約トークンを失効させ、古い欄への誤入力を防ぐ。 */
  function clear(code: QuickClipFailure): void {
    target = null;
    token = null;
    failure = code;
  }

  // ページ側の子要素が伝播を止めても、captureでフォーカス移動を先に把握する。
  document.addEventListener(
    "focusin",
    (event) => {
      token = null;
      if (supported(event.target)) target = event.target;
      else clear("UNSUPPORTED_TARGET");
    },
    true,
  );
  // disabled欄はfocusinが発生しないため押下でも解除する。Shadow DOMからの再ターゲットも拒否する。
  document.addEventListener(
    "pointerdown",
    (event) => {
      const element = event.target;
      if (
        element instanceof Element &&
        (element.matches(
          "input, textarea, select, iframe, [contenteditable]",
        ) ||
          element.closest("[contenteditable]") ||
          event.composedPath()[0] !== element) &&
        !supported(element)
      ) {
        clear("UNSUPPORTED_TARGET");
      }
    },
    true,
  );
  // iframe内のfocusinは親へ届かないため、blur後に更新されたactiveElementを確認する。
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement instanceof HTMLIFrameElement)
        clear("UNSUPPORTED_TARGET");
    }, 0);
  });
  window.addEventListener("pagehide", () => clear("STALE_TARGET"));

  /** 要求処理時のページ状態と対象を再検査し、選択後の無効化・削除も拒否する。 */
  function validate(): QuickClipFailure | null {
    if (
      window !== window.top ||
      !["http:", "https:"].includes(location.protocol)
    )
      return "UNSUPPORTED_PAGE";
    if (document.visibilityState !== "visible") return "STALE_TARGET";
    if (document.activeElement instanceof HTMLIFrameElement) {
      clear("UNSUPPORTED_TARGET");
    }
    if (target && !supported(target)) clear("UNSUPPORTED_TARGET");
    return target ? null : failure;
  }

  // 事前確認で予約し、同じ文書・選択のトークンを持つ入力要求だけ実行する二段階通信。
  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      sender,
      respond: (response: QuickClipResponse) => void,
    ) => {
      if (
        sender.id !== chrome.runtime.id ||
        !message ||
        typeof message !== "object"
      )
        return;
      const request = message as Partial<{
        type: string;
        text: string;
        token: string;
      }>;
      if (request.type !== "PREPARE_CLIP" && request.type !== "INSERT_TEXT")
        return;
      const error = validate();
      if (error) {
        respond({ ok: false, code: error });
        return;
      }
      if (request.type === "PREPARE_CLIP") {
        // 通常のHTTPページでも使えるgetRandomValuesで、今回の予約を識別する。
        token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        respond({ ok: true, token });
        return;
      }
      if (
        typeof request.text !== "string" ||
        typeof request.token !== "string"
      ) {
        respond({ ok: false, code: "INVALID_MESSAGE" });
        return;
      }
      if (!token || token !== request.token) {
        respond({ ok: false, code: "STALE_TARGET" });
        return;
      }
      token = null; // 書込み前に消費し、同じ予約の再送では実行しない。
      try {
        // 値を全置換し、ページへinputを1回通知する。拡張自身はフォームを送信しない。
        target!.value = request.text;
        target!.dispatchEvent(new Event("input", { bubbles: true }));
        respond({ ok: true, inserted: true });
      } catch {
        // 書込み失敗後は対象も破棄し、成功応答や別の欄への代替入力を行わない。
        clear("WRITE_FAILED");
        respond({ ok: false, code: "WRITE_FAILED" });
      }
    },
  );
})();
