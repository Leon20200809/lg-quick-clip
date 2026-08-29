/** 拡張アイコンのクリックでLG Quick ClipのSide Panelを開閉できるようにする。 */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) => {
    console.error("Side Panelの動作設定に失敗しました。", error);
  });
