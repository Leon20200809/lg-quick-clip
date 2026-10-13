# LG Quick Clip

Chrome MV3 Side Panelから、最後に選んだ通常入力欄の値をClipで**全置換**するMVPです。Refs #1。Draft段階で、Chrome実機の最終確認はオーナーがローカルで行います。

## ビルドと利用

Node.js 22以上・npm・Bashを使用します。

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Chromeの専用テストプロファイルで `chrome://extensions` → デベロッパーモード →「パッケージ化されていない拡張機能を読み込む」から `dist` を選びます。拡張アイコンをクリックしてSide Panelを開き、HTTP(S)ページの対応する欄を選び、Clipを押します。既存値は残さず置き換わります。成功は受信側の応答後に表示します。拡張を更新・再読み込みした場合、対象ページも再読み込みしてください。

## 整形をVS CodeとCLIで揃える

Prettier **3.9.10**をdevDependencyとlockfileで固定し、`.prettierrc.json` の空オブジェクトで標準設定を使います。独自の引用符・改行幅等は追加していません。既存の日本語コメントと処理は維持します。

1. ブランチを取得した後に `npm ci` を実行します。
2. VS Codeの `esbenp.prettier-vscode` を利用します。リポジトリの推奨拡張とTypeScript用の保存時整形設定を追加しています。信頼済みワークスペースではローカルにインストールしたPrettierを使います。
3. `npm run format` で `src/**/*.ts` を整形し、`npm run format:check` で差分なく再現できるか確認します。今回の一括整形対象はTypeScriptのみで、HTML・CSS・テストfixture等は含めません。
4. 同じ版・設定でも保存時に差分が出る場合は、VS Codeの出力「Prettier」で選択されたバージョンと設定ファイルを確認してください。CLI確認後、再度保存して差分が増えないかローカルで確認します。

未コミットの作業がある場合は、内容を確認してcommitまたはstashで保護してから更新してください。`unlink: Invalid argument` の原因はこの整形差分からは確定できず、別の環境問題として扱います。

参考: [Prettier公式導入手順](https://prettier.io/docs/install)、[VS Code拡張のローカル版解決](https://github.com/prettier/prettier-vscode#prettier-resolution)。

## 対象・安全上の限界

- HTTP(S)のトップフレームのみ。`input` の `text`（type省略含む）・`email`・`tel` と `textarea`。
- password、その他のinput型、readonly、実効disabled（disabled fieldset含む）、切断されたDOMは対象外。
- 明示されたautocompleteの `username` / `current-password` / `new-password` / `one-time-code` / `webauthn` は拒否します。
- iframe、contenteditable、Shadow DOM、React等の制御入力には対応しません。対象外へ移ると以前の欄へ戻って入力しません。ページ内で別の要素へフォーカスした場合も欄を選び直してください。
- フォームのsubmit・Enter・送信ボタンクリックは実行しません。ただし、ページ自身がinputイベントに反応して送信する場合は防げません。送信するページや実データで試さないでください。
- 通常text欄が秘密情報用かを完全に判定できません。パスワード・認証コードなどの秘密情報をClipとして保存・入力しないでください。
- 初期Clipは例示データです。`storage.local` の既存キー（空配列・不正な値も含む）は初期値で上書きしません。不正なClip・読み書き失敗は画面で案内します。編集・カテゴリUI・同期は対象外です。
- 権限は既存の `storage` / `sidePanel` のみ。content script対象をHTTP(S)に限定しています。Chrome内部ページ、Web Store等への入力はできません。接続不可と制限ページを確実に区別できない場合、共通の復旧案内を表示します。
- タブ変更・ナビゲーション・連続操作には送信中ボタン無効化、アクティブタブ再確認、一度限りの文書・選択に結びついたトークン、受信側の可視性・対象再検査を使用します。ブラウザAPIを跨いだ操作は原子的ではないため、入力前にページと欄を確認してください。

Chrome公式API: https://developer.chrome.com/docs/extensions/reference/api/tabs （tab IDの取得とメッセージ通信だけのためにtabs権限は追加していません）。

## 自動テスト

`npm test` はビルド後にNode標準のtest/vmでcontent script・storage・Side Panelを実行します。依存追加はありません。対象型、再検査、認証欄、古い対象、iframe・非表示・pagehide、トークンの失効・再送拒否、単一input、保存値保持、不正データ、応答欠落、通信失敗、タブ変更、連続クリック、manifestを検査します。

DOMとChrome APIはテストダブルです。これはChrome実機検証の代わりではありません。

## Chromeローカル受入手順（すべて未実行・オーナー確認待ち）

1. 上記4コマンドを実行し、各結果とChromeバージョンを記録。専用Chromeプロファイルにdistを読み込みます。
2. リポジトリルートで `python3 -m http.server 8765 --bind 127.0.0.1` を実行し、`http://127.0.0.1:8765/tests/manual.html` を開きます。実データ・本番サービスで試さないでください。
3. A、B、email、tel、textareaをそれぞれ選びClipを押します。値の全置換、他の欄の不変、下部inputカウンターが1ずつ増えること、submitが0、Side Panelの成功表示を確認します。A→B→Side PanelではBだけが変わることを確認。
4. ページ再読み込み後、欄を選ばずClipを押して未選択案内を確認。対応欄を選び直し、連打で未処理例外や二重送信がないことを確認。タブA→タブBへの切替、送信直前の切替・再読み込み、前後履歴移動でも古いページ／欄へ入力しないことを確認します。
5. A選択後、password・username・OTP・readonly・disabled・disabled fieldset・number・search・url・select・contenteditable・Shadow DOM・iframeへ移動してClipを押します。対象も古いAも変わらないことを確認。`autocomplete="new-password"` / `current-password` / `webauthn` もDevToolsで設定し確認します。
6. Aを選択し、DevTools Consoleで `document.querySelector('#a').readOnly=true`、`disabled=true`、`remove()` をそれぞれ別の再読み込みで試します。Clipが拒否され、他欄に入力しないことを確認。選択済み欄をdisabled fieldset内へ移す場合も確認。
7. `chrome://extensions`、Web Store、拡張だけ再読み込みした古いHTTPタブでClipを押し、成功と表示されず復旧案内になることを確認。通常HTTPページを再読み込み・欄を選択すれば復旧することを確認します。
8. 新規専用プロファイルでは例示Clipのみ表示されることを確認。Side PanelのDevToolsで `chrome.storage.local.get(null)` を確認し、既存Clipの文字列をサンプルに変えてSide Panel・Chromeを再起動しても保持されることを確認します。空配列も空のまま保持。不正形式（例: clips:null）は読み込み失敗案内になり、値が上書きされないことを確認。専用プロファイルのサンプルデータだけで行い、確認後は記録したサンプルに戻します。
9. Side Panel DevToolsのSourcesでstorageのget/setを失敗させるテスト用スタブを使うか、自動テストの失敗ケースを参照し、読み込み失敗を成功扱いしていないことを確認します。実機で再現できないケースは未実行と記録してください。

### この変更での確認記録

- PASS: `npm ci --cache /tmp/lg-quick-clip-npm-cache`（デフォルトキャッシュディレクトリが使えず、一度失敗後に書込可能なキャッシュで成功）
- PASS: `npm run typecheck`
- PASS: `npm run build`
- PASS: `npm test`（13件、Nodeテストダブル）
- 未実行: Chromeでの拡張読み込み、実際のSide Panel／フォーカス／イベント／ストレージの手動受入すべて
- 未実行: lint（設定・スクリプトなし）

この段階ではmainへのマージ・Issueクローズ・配布は行いません。
