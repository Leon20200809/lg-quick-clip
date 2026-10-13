/** Side Panelとcontent script間の要求・応答を共有型で表す。 */
// import/exportを置かない宣言により、content scriptの出力を非moduleのまま保つ。
type QuickClipFailure =
  | "NO_TARGET"
  | "UNSUPPORTED_TARGET"
  | "UNSUPPORTED_PAGE"
  | "STALE_TARGET"
  | "INVALID_MESSAGE"
  | "WRITE_FAILED";
// 予約と入力を分け、文字列の投入には受信側が発行した一度限りのトークンを要求する。
type QuickClipMessage =
  | { type: "PREPARE_CLIP" }
  | { type: "INSERT_TEXT"; text: string; token: string };
// 予約成立・入力完了・失敗を区別し、予約だけで成功表示しないための契約。
type QuickClipResponse =
  | { ok: true; token: string }
  | { ok: true; inserted: true }
  | { ok: false; code: QuickClipFailure };
