(() => {
  let target: HTMLInputElement | HTMLTextAreaElement | null = null;
  let failure: QuickClipFailure = "NO_TARGET";
  let token: string | null = null;
  const authTokens = new Set(["username", "current-password", "new-password", "one-time-code", "webauthn"]);

  function supported(element: EventTarget | null): element is HTMLInputElement | HTMLTextAreaElement {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    return element.isConnected && element.ownerDocument === document && element.getRootNode() === document &&
      !element.readOnly && !element.matches(":disabled") &&
      (!(element instanceof HTMLInputElement) || ["text", "email", "tel"].includes(element.type)) &&
      !(element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).some(value => authTokens.has(value));
  }

  function clear(code: QuickClipFailure): void {
    target = null;
    token = null;
    failure = code;
  }

  document.addEventListener("focusin", event => {
    token = null;
    if (supported(event.target)) target = event.target;
    else clear("UNSUPPORTED_TARGET");
  }, true);
  // Disabled fields do not emit focusin. Retargeted Shadow DOM events are also rejected.
  document.addEventListener("pointerdown", event => {
    const element = event.target;
    if (element instanceof Element && (element.matches("input, textarea, select, iframe, [contenteditable]") ||
        element.closest("[contenteditable]") || event.composedPath()[0] !== element) && !supported(element)) {
      clear("UNSUPPORTED_TARGET");
    }
  }, true);
  // Focus inside an iframe is not delivered as focusin to its parent document.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement instanceof HTMLIFrameElement) clear("UNSUPPORTED_TARGET");
    }, 0);
  });
  window.addEventListener("pagehide", () => clear("STALE_TARGET"));

  function validate(): QuickClipFailure | null {
    if (window !== window.top || !["http:", "https:"].includes(location.protocol)) return "UNSUPPORTED_PAGE";
    if (document.visibilityState !== "visible") return "STALE_TARGET";
    if (document.activeElement instanceof HTMLIFrameElement) {
      clear("UNSUPPORTED_TARGET");
    }
    if (target && !supported(target)) clear("UNSUPPORTED_TARGET");
    return target ? null : failure;
  }

  chrome.runtime.onMessage.addListener((message: unknown, sender, respond: (response: QuickClipResponse) => void) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== "object") return;
    const request = message as Partial<{ type: string; text: string; token: string }>;
    if (request.type !== "PREPARE_CLIP" && request.type !== "INSERT_TEXT") return;
    const error = validate();
    if (error) { respond({ ok: false, code: error }); return; }
    if (request.type === "PREPARE_CLIP") {
      // getRandomValues also works on ordinary (non-secure) HTTP pages.
      token = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
      respond({ ok: true, token });
      return;
    }
    if (typeof request.text !== "string" || typeof request.token !== "string") {
      respond({ ok: false, code: "INVALID_MESSAGE" }); return;
    }
    if (!token || token !== request.token) {
      respond({ ok: false, code: "STALE_TARGET" }); return;
    }
    token = null; // One-use, document/selection-bound request; never replay after navigation.
    try {
      target!.value = request.text;
      target!.dispatchEvent(new Event("input", { bubbles: true }));
      respond({ ok: true, inserted: true });
    } catch {
      clear("WRITE_FAILED");
      respond({ ok: false, code: "WRITE_FAILED" });
    }
  });
})();
