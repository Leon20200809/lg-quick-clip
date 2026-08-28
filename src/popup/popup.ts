const insertButton =
  document.querySelector<HTMLButtonElement>("#insert-button");

if (!insertButton) {
  throw new Error("挿入ボタンが見つかりません。");
}

insertButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!tab.id) {
    throw new Error("現在のタブIDを取得できませんでした。");
  }

  await chrome.tabs.sendMessage(tab.id, {
    type: "INSERT_TEXT",
    text: "LG Quick Clipから送信",
  });
});
