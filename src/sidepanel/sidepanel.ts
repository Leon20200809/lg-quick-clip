import { getClips, initializeStorage } from "../storage/storage.js";

/** 初回起動時にデフォルトデータをStorageへ登録する。 */
await initializeStorage();

/** Clip一覧の描画先を取得する。 */
const clipList = document.querySelector<HTMLDivElement>("#clip-list");

if (!clipList) {
  throw new Error("Clip一覧の表示領域が見つかりません。");
}

/** popupから現在のタブへ挿入文字列を送信する。 */
async function sendClipText(text: string): Promise<void> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!tab?.id) {
    throw new Error("現在のタブIDを取得できませんでした。");
  }

  await chrome.tabs.sendMessage(tab.id, {
    type: "INSERT_TEXT",
    text,
  });
}

/** StorageからClipを取得して、お気に入り優先で表示する。 */
const clips = (await getClips()).sort((a, b) => {
  if (a.pinned !== b.pinned) {
    return Number(b.pinned) - Number(a.pinned);
  }

  return a.order - b.order;
});

/** 各Clipを1クリックで挿入できるボタンとして生成する。 */
for (const clip of clips) {
  const button = document.createElement("button");

  button.type = "button";
  button.textContent = clip.pinned ? `★ ${clip.label}` : clip.label;

  /** 選択されたClipの文字列を現在のWebページへ送信する。 */
  button.addEventListener("click", async () => {
    await sendClipText(clip.text);
  });

  clipList.appendChild(button);
}
