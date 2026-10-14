/** Clip一覧・未保存フォーム・削除確認の画面状態だけを管理する。 */
import {
  createClip,
  deleteClip,
  getClips,
  initializeStorage,
  updateClip,
  validateClipInput,
} from "../storage/storage.js";
import type { Clip } from "../types/template.js";

type Editor = { mode: "create" } | { mode: "edit" | "delete"; original: Clip };

export function createClipManager(insert: (text: string) => Promise<void>) {
  const list = document.querySelector<HTMLDivElement>("#clip-list")!;
  const status =
    document.querySelector<HTMLParagraphElement>("#management-status")!;
  const newButton = document.querySelector<HTMLButtonElement>("#new-clip")!;
  const form = document.querySelector<HTMLFormElement>("#clip-form")!;
  const title = document.querySelector<HTMLHeadingElement>("#editor-title")!;
  const label = document.querySelector<HTMLInputElement>("#clip-label")!;
  const text = document.querySelector<HTMLTextAreaElement>("#clip-text")!;
  const labelError =
    document.querySelector<HTMLParagraphElement>("#label-error")!;
  const textError =
    document.querySelector<HTMLParagraphElement>("#text-error")!;
  const save = document.querySelector<HTMLButtonElement>("#save-clip")!;
  const cancel = document.querySelector<HTMLButtonElement>("#cancel-edit")!;
  const deletion = document.querySelector<HTMLElement>("#delete-confirmation")!;
  const deleteDescription = document.querySelector<HTMLParagraphElement>(
    "#delete-description",
  )!;
  const confirmDelete =
    document.querySelector<HTMLButtonElement>("#confirm-delete")!;
  const cancelDelete =
    document.querySelector<HTMLButtonElement>("#cancel-delete")!;
  let clips: Clip[] = [];
  let editor: Editor | null = null;
  let renderedValues: { label: string; text: string } | null = null;
  let writing = false;
  let inserting = false;
  let ready = false;
  let readVersion = 0;
  let insertionButtons: HTMLButtonElement[] = [];
  let managementButtons: HTMLButtonElement[] = [];

  function show(message: string, error = false) {
    status.textContent = message;
    status.dataset.state = error ? "error" : "info";
  }

  function setControls() {
    newButton.disabled = !ready || writing || editor !== null;
    managementButtons.forEach((button) => {
      button.disabled = writing || editor !== null;
    });
    insertionButtons.forEach((button) => {
      button.disabled = inserting;
    });
    [label, text, save, cancel, confirmDelete, cancelDelete].forEach(
      (control) => {
        control.disabled = writing;
      },
    );
  }

  function clearFieldErrors() {
    labelError.textContent = "";
    textError.textContent = "";
    label.removeAttribute("aria-invalid");
    text.removeAttribute("aria-invalid");
  }

  function closeEditor() {
    editor = null;
    renderedValues = null;
    form.hidden = true;
    deletion.hidden = true;
    clearFieldErrors();
    setControls();
    newButton.focus();
  }

  function openEditor(next: Editor) {
    if (!ready || writing || editor) return;
    // 一覧更新から切り離したスナップショットを保存し、編集中の値は通知で差し替えない。
    editor = next;
    clearFieldErrors();
    show("");
    if (next.mode === "delete") {
      deleteDescription.textContent = `「${next.original.label}」を削除しますか？ 本文: ${preview(next.original.text)}`;
      deletion.hidden = false;
      cancelDelete.focus();
    } else {
      title.textContent = next.mode === "create" ? "Clipを作成" : "Clipを編集";
      label.value = next.mode === "create" ? "" : next.original.label;
      text.value = next.mode === "create" ? "" : next.original.text;
      // DOMは改行を正規化するため、表示直後の値を基準にして未変更の保存文字列を守る。
      renderedValues = { label: label.value, text: text.value };
      form.hidden = false;
      label.focus();
    }
    setControls();
  }

  function preview(value: string) {
    return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  }

  /** 保存文字列はすべてtextContentで表示し、HTMLとして実行しない。 */
  function renderClips() {
    list.replaceChildren();
    insertionButtons = [];
    managementButtons = [];
    for (const clip of clips
      .slice()
      .sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order,
      )) {
      const row = document.createElement("article");
      row.className = "clip-row";
      const insertButton = document.createElement("button");
      insertButton.type = "button";
      insertButton.className = "insert-clip";
      insertButton.textContent = clip.pinned ? `★ ${clip.label}` : clip.label;
      insertButton.addEventListener("click", () => {
        void insert(clip.text);
      });
      const snippet = document.createElement("p");
      snippet.className = "clip-preview";
      snippet.textContent = preview(clip.text);
      const actions = document.createElement("div");
      actions.className = "clip-actions";
      for (const mode of ["edit", "delete"] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = mode === "edit" ? "編集" : "削除";
        button.setAttribute(
          "aria-label",
          `${clip.label}を${button.textContent}`,
        );
        button.addEventListener("click", () =>
          openEditor({ mode, original: structuredClone(clip) }),
        );
        actions.appendChild(button);
        managementButtons.push(button);
      }
      row.append(insertButton, snippet, actions);
      list.appendChild(row);
      insertionButtons.push(insertButton);
    }
    if (!clips.length) {
      const empty = document.createElement("p");
      empty.textContent =
        "保存されたClipはありません。「新規作成」から追加できます。";
      list.appendChild(empty);
    }
    setControls();
  }

  /** 遅れて完了した旧読込で一覧を巻き戻さず、未保存フォームには触らない。 */
  async function refreshClips(): Promise<"updated" | "superseded" | "failed"> {
    const version = ++readVersion;
    try {
      const latest = await getClips();
      if (version !== readVersion) return "superseded";
      clips = latest;
      ready = true;
      renderClips();
      return "updated";
    } catch {
      if (version !== readVersion) return "superseded";
      ready = false;
      show(
        "Clipを読み込めませんでした。保存データまたは接続を確認してSide Panelを開き直してください。表示中の一覧・入力内容は保持しています。",
        true,
      );
      setControls();
      return "failed";
    }
  }

  async function persist(operation: () => Promise<void>, success: string) {
    if (writing) return;
    writing = true;
    ++readVersion;
    setControls();
    show("保存しています…");
    try {
      await operation();
    } catch (error) {
      // 容量・接続など未知のエラーには保存内容を含めず、入力を消さない。
      const message = error instanceof Error ? error.message : "";
      const known =
        /^(安全な保存|新規作成は|末尾の並び順|カテゴリの保存形式|新しいID|このClipは|保存済みClip)/.test(
          message,
        );
      show(
        known
          ? message
          : "保存できませんでした。容量または接続を確認して再試行してください。入力内容は保持しています。",
        true,
      );
      writing = false;
      setControls();
      return;
    }
    writing = false;
    closeEditor();
    show(success);
    // set成功と読込失敗は区別する。ここで失敗しても保存操作を再送しない。
    if ((await refreshClips()) === "failed")
      show(
        "保存は完了しましたが一覧を再読込できません。Side Panelを開き直してください。",
        true,
      );
  }

  newButton.addEventListener("click", () => openEditor({ mode: "create" }));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (writing || !editor || editor.mode === "delete") return;
    const current = editor;
    const input = {
      label:
        current.mode === "edit" && label.value === renderedValues?.label
          ? current.original.label
          : label.value,
      text:
        current.mode === "edit" && text.value === renderedValues?.text
          ? current.original.text
          : text.value,
    };
    const errors = validateClipInput(
      input,
      current.mode === "edit" ? current.original : undefined,
    );
    clearFieldErrors();
    labelError.textContent = errors.label ?? "";
    textError.textContent = errors.text ?? "";
    if (errors.label) label.setAttribute("aria-invalid", "true");
    if (errors.text) text.setAttribute("aria-invalid", "true");
    if (errors.label || errors.text) {
      (errors.label ? label : text).focus();
      return;
    }
    void persist(
      () =>
        current.mode === "edit"
          ? updateClip(current.original, input)
          : createClip(input),
      "Clipを保存しました。",
    );
  });
  confirmDelete.addEventListener("click", () => {
    if (writing || editor?.mode !== "delete") return;
    const original = editor.original;
    void persist(() => deleteClip(original), "Clipを削除しました。");
  });
  function cancelEditor() {
    if (writing || !editor) return;
    closeEditor();
    show("キャンセルしました。保存内容は変更していません。");
  }
  cancel.addEventListener("click", cancelEditor);
  cancelDelete.addEventListener("click", cancelEditor);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && editor && !writing) {
      event.preventDefault();
      cancelEditor();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    // 自分のset通知は操作完了後の読込にまとめる。他パネル通知はフォームを残して一覧だけ更新する。
    if (area === "local" && Object.hasOwn(changes, "clips") && !writing)
      void refreshClips();
  });
  setControls();

  return {
    async start() {
      try {
        await initializeStorage();
        await refreshClips();
      } catch {
        show(
          "Clipを初期化できませんでした。ストレージ接続とWeb Locksの対応を確認し、Side Panelを開き直してください。既存データはリセットしていません。",
          true,
        );
      }
    },
    setInsertionBusy(value: boolean) {
      inserting = value;
      setControls();
    },
  };
}
