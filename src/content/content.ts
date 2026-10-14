/** ページで選ばれた入力欄を記憶し、Side Panelからの要求を再検査して値を全置換する。 */
// IIFE（即時実行関数）で変数を閉じ込め、登録するリスナーが同じ状態を参照する（クロージャ）。
(() => {
  // targetは記憶した入力先、failureは対象がないときの理由、tokenは今回の予約の識別子。
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

  /** 同じ文書の通常入力欄かを確認する。選択時と要求時に使い、状態変化による誤入力を抑える。 */
  // 戻り値の「element is ...」は型述語。trueの分岐でTypeScriptが入力欄の型に絞り込む。
  function supported(
    element: EventTarget | null,
  ): element is HTMLInputElement | HTMLTextAreaElement {
    if (!(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ))
      return false;
    // 切断・別文書・Shadow DOM・readonly・実効disabled（fieldset由来も含む）は対象外。
    // inputはtext/email/telだけ。autocompleteのauthTokensにあるマーカーを拒否するが、認証欄の完全判定はできない。
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

  /** 記憶した入力先と予約を破棄し、次の要求へ返す理由を残す。欄の値やdisabled属性は変えない。 */
  function clear(code: QuickClipFailure): void {
    target = null;
    token = null;
    failure = code;
  }

  // 第3引数trueはcapture（捕捉段階）。子要素へ届く前にfocusinを受け、選択を更新する。
  // 子要素での伝播停止より先に受け取れるが、すべてのイベントを検知できる保証ではない。
  document.addEventListener(
    "focusin",
    (event) => {
      // 新しいフォーカスでは前の予約を無効にし、対象外なら以前の入力先も残さない。
      token = null;
      if (supported(event.target)) target = event.target;
      else clear("UNSUPPORTED_TARGET");
    },
    true,
  );
  // disabled欄はfocusinで拾えないため、pointerdownでも対象外の欄への移動を調べる。
  // 下の要素・伝播経路の条件に合い、supportedがfalseなら、以前に記憶した入力先と予約を破棄する。
  // 無関係な場所のクリックすべてで破棄するわけではない。disabled属性は変えず、押下の検知にも限界がある。
  document.addEventListener(
    "pointerdown",
    (event) => {
      // event.targetはこのリスナーから見える対象。composedPath()[0]は公開された伝播経路の先頭。
      // 両者の違いでShadow DOM等の再ターゲットを調べるが、閉じたShadow DOM内部は見えない。
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
  // iframe内のfocusinは親文書へ届かない。windowのblur後、タイマーで確認を後へ回し、
  // activeElementがiframeなら以前の入力先を破棄する。Side Panelへの移動だけでは破棄しない。
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement instanceof HTMLIFrameElement)
        clear("UNSUPPORTED_TARGET");
    }, 0);
  });
  // ページを離れる際は、戻ったときに以前の入力先や予約を使わないよう破棄する。
  window.addEventListener("pagehide", () => clear("STALE_TARGET"));

  /** 両段階の要求でページと入力先を再検査する。nullは検査通過、それ以外は失敗理由。 */
  function validate(): QuickClipFailure | null {
    // HTTP(S)のトップフレームだけが対象。非表示ページへの遅れた要求もここで拒否する。
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

  // PREPARE_CLIPで予約し、INSERT_TEXTで照合して書く二段階通信。
  // tokenはこの文書で記憶している選択と要求を結びつける使い捨ての識別子で、認証用の秘密情報ではない。
  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      sender,
      respond: (response: QuickClipResponse) => void,
    ) => {
      // 同じ拡張からのオブジェクトだけを扱う。型アサーション（as）は実行時の検証ではない。
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
        // ここでは値を書かず予約だけ作る。通常のHTTPページでも使えるgetRandomValuesを利用する。
        token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        respond({ ok: true, token });
        return;
      }
      // INSERT_TEXTの本文と予約番号は、asによる型の指定だけに頼らず実際の型を確認する。
      if (
        typeof request.text !== "string" ||
        typeof request.token !== "string"
      ) {
        respond({ ok: false, code: "INVALID_MESSAGE" });
        return;
      }
      // 未予約・失効済み・別の予約なら書かない。ただし、ブラウザAPIを跨ぐ操作全体が
      // 「すべて成功するか、何も変わらないか」のどちらかになる保証はない。
      if (!token || token !== request.token) {
        respond({ ok: false, code: "STALE_TARGET" });
        return;
      }
      token = null; // 書込み前に消費し、同じ予約の再送では実行しない。
      try {
        // valueへの代入は全置換（カーソル位置への挿入ではない）。「!」は型検査上の非null表明。
        // inputを1回発火し、bubblesで親へ伝える。ページ側の反応やReact等の制御入力への反映は保証しない。
        // 拡張自身はsubmit等を行わないが、ページがinputに反応して送信することまでは防げない。
        target!.value = request.text;
        target!.dispatchEvent(new Event("input", { bubbles: true }));
        respond({ ok: true, inserted: true });
      } catch {
        // このtry内で例外を捕捉したら入力先も破棄し、失敗を返す。別の欄へは代替入力しない。
        // すでに値を書いた後の例外もあり得る。変更を元に戻す処理はなく、ロールバックは保証しない。
        clear("WRITE_FAILED");
        respond({ ok: false, code: "WRITE_FAILED" });
      }
    },
  );
})();
