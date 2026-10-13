// Shared ambient types keep the manifest content script a classic, non-module script.
type QuickClipFailure = "NO_TARGET" | "UNSUPPORTED_TARGET" | "UNSUPPORTED_PAGE" | "STALE_TARGET" | "INVALID_MESSAGE" | "WRITE_FAILED";
type QuickClipMessage =
  | { type: "PREPARE_CLIP" }
  | { type: "INSERT_TEXT"; text: string; token: string };
type QuickClipResponse =
  | { ok: true; token: string }
  | { ok: true; inserted: true }
  | { ok: false; code: QuickClipFailure };
