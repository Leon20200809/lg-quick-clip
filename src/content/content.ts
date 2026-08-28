type QuickClipMessage = {
  type: "INSERT_TEXT";
  text: string;
};

chrome.runtime.onMessage.addListener((message: QuickClipMessage) => {
  if (message.type !== "INSERT_TEXT") {
    return;
  }

  console.log("受信した文字列:", message.text);
});
