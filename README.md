# LG Quick Clip

Chrome MV3 Side Panelから、最後に選んだ通常入力欄の値をClipで**全置換**します。#1はPR #3でmainへ統合済みです。この変更はClip管理（Refs #2）のDraftレビュー用で、Chrome実機の最終確認はオーナーがローカルで行います。

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
- 初期Clipは例示データです。`storage.local` の既存キー（空配列・不正な値も含む）は初期値で上書きしません。不正なClip・読み書き失敗は画面で案内します。カテゴリ管理UI・同期は対象外です。
- 権限は既存の `storage` / `sidePanel` のみ。content script対象をHTTP(S)に限定しています。Chrome内部ページ、Web Store等への入力はできません。接続不可と制限ページを確実に区別できない場合、共通の復旧案内を表示します。
- タブ変更・ナビゲーション・連続操作には送信中ボタン無効化、アクティブタブ再確認、一度限りの文書・選択に結びついたトークン、受信側の可視性・対象再検査を使用します。ブラウザAPIを跨いだ操作は原子的ではないため、入力前にページと欄を確認してください。

Chrome公式API: https://developer.chrome.com/docs/extensions/reference/api/tabs （tab IDの取得とメッセージ通信だけのためにtabs権限は追加していません）。

## Clipの作成・編集・削除

- 「新規作成」で表示名と本文を入力して保存します。各行の「編集」で変更、「削除」で表示名と本文プレビューを確認して削除します。同名も許可し、IDで区別します。サンプルも編集・削除できます。
- キャンセルまたはEscapeで編集・削除確認を閉じます。保存中は重複操作とキャンセルを止めます。保存・削除操作ではWebページへ入力しません。挿入は一覧の表示名ボタンから行います。
- 新規・変更した表示名は前後空白を除いて80、本文は10,000 UTF-16コード単位まで。空／空白だけは拒否し、本文の有効な前後空白・改行は保持します。絵文字は2単位以上になることがあります。既存の上限超過項目は、変更しない限り読み込み・保存・挿入で保持します。フォームのmaxlengthによる既存値の切詰めは行いません。
- 新規作成は100件まで。既存の100件超過データを削除・切詰めません。これは容量保証ではなく、容量不足等の保存失敗は画面に表示します。
- 新規はUUID・未固定・最大order+1（空なら1）。既存カテゴリのorder順先頭（同順位は保存順）を利用し、カテゴリが空なら未分類です。不正カテゴリ・安全に追加できない並び順は作成を止めます。
- 保管先はこのChromeプロファイルの `chrome.storage.local`。同期・暗号化保管・バックアップは追加しません。パスワード・APIキー・認証コードなどを保存しないでください。
- 書込は同じ拡張originのWeb Locksで直列化し、最新データから対象IDだけを変更します。別画面で対象が変わった場合は保存・削除を拒否し、入力を残します。内容を控え、キャンセル後に最新の対象を選び直してください。Web Locksを利用できない場合は書き込みません。DevTools等のロックを使わない外部書込まで原子的に防ぐものではありません。
- 全件削除後も空配列を維持し、サンプルを復活させません。別パネルの通知では一覧だけを読み直し、未保存フォームは残します。保存結果とページ入力結果は別の領域へ表示します。

実装の入口は `src/sidepanel/sidepanel.ts`（既存入力通信）、管理画面は `clip-manager.ts`、保存の境界検証・競合拒否は `src/storage/storage.ts` です。

## 自動テスト

`npm test` はビルド後にNode標準のtest/vmでcontent script・storage・Side Panelを実行します。依存追加はありません。対象型、再検査、認証欄、古い対象、iframe・非表示・pagehide、トークンの失効・再送拒否、単一input、保存値保持、不正データ、応答欠落、通信失敗、タブ変更、連続クリック、manifestを検査します。

Clip管理の境界値・既存値保持・同時保存・競合・失敗注入・フォーム状態もNodeテストで確認します。DOM、Chrome API、Web Locksはテストダブルです。これはChrome実機検証の代わりではありません。

## Chromeローカル受入手順（今回のブランチでは未実行）

1. 上記4コマンドを実行し、各結果とChromeバージョンを記録。専用Chromeプロファイルにdistを読み込みます。
2. リポジトリルートで `python3 -m http.server 8765 --bind 127.0.0.1` を実行し、`http://127.0.0.1:8765/tests/manual.html` を開きます。実データ・本番サービスで試さないでください。
3. A、B、email、tel、textareaをそれぞれ選びClipを押します。値の全置換、他の欄の不変、下部inputカウンターが1ずつ増えること、submitが0、Side Panelの成功表示を確認します。A→B→Side PanelではBだけが変わることを確認。
4. ページ再読み込み後、欄を選ばずClipを押して未選択案内を確認。対応欄を選び直し、連打で未処理例外や二重送信がないことを確認。タブA→タブBへの切替、送信直前の切替・再読み込み、前後履歴移動でも古いページ／欄へ入力しないことを確認します。
5. A選択後、password・username・OTP・readonly・disabled・disabled fieldset・number・search・url・select・contenteditable・Shadow DOM・iframeへ移動してClipを押します。対象も古いAも変わらないことを確認。`autocomplete="new-password"` / `current-password` / `webauthn` もDevToolsで設定し確認します。
6. Aを選択し、DevTools Consoleで `document.querySelector('#a').readOnly=true`、`disabled=true`、`remove()` をそれぞれ別の再読み込みで試します。Clipが拒否され、他欄に入力しないことを確認。選択済み欄をdisabled fieldset内へ移す場合も確認。
7. `chrome://extensions`、Web Store、拡張だけ再読み込みした古いHTTPタブでClipを押し、成功と表示されず復旧案内になることを確認。通常HTTPページを再読み込み・欄を選択すれば復旧することを確認します。
8. 新規専用プロファイルでは例示Clipのみ表示されることを確認。Side PanelのDevToolsで `chrome.storage.local.get(null)` を確認し、既存Clipの文字列をサンプルに変えてSide Panel・Chromeを再起動しても保持されることを確認します。空配列も空のまま保持。不正形式（例: clips:null）は読み込み失敗案内になり、値が上書きされないことを確認。専用プロファイルのサンプルデータだけで行い、確認後は記録したサンプルに戻します。
9. Side Panel DevToolsのSourcesでstorageのget/setを失敗させるテスト用スタブを使うか、自動テストの失敗ケースを参照し、読み込み失敗を成功扱いしていないことを確認します。実機で再現できないケースは未実行と記録してください。

### Clip管理の追加受入（オーナー確認待ち）

専用プロファイルの通常ウィンドウだけで行い、「シークレットモードでの実行を許可する」は有効にしないでください。シークレット側のストレージとロック範囲は今回未検証で、受入対象に含めません。

1. Side PanelのDevToolsで `isSecureContext` がtrue、`typeof navigator.locks?.request` が `"function"` であることを確認します。未対応なら書込を止める案内が正常です。対応している場合は2ウィンドウでSide Panelを開き、同時に別Clipを作成・編集し、どちらも残ることを確認します。
2. サンプルだけの専用プロファイルで `await chrome.storage.local.get(["clips", "categories"])` を操作前後に読み、対象以外のID・categoryId・pinned・order・本文が変わらないことを確認。秘密情報・実ユーザーデータをConsoleへ出力しないでください。
3. 作成→編集→キャンセル→保存→削除確認キャンセル→削除確定を確認。同名・HTML風文字列・改行・有効な前後空白も試します。保存だけではmanual.htmlの値・input/submit回数が変化しないことを確認します。
4. 表示名80/81、本文10,000/10,001、空白だけ、100件上限、既存超過項目を変更せず保存するケースを確認。大量データや不正形式は自動テストの合格と実機未実行を分けて記録します。
5. 2パネルで同じClipの編集／削除確認を開き、一方で変更／削除後に他方で確定。競合案内が出て未保存入力が残ることを確認。別Clipの通知でもフォームが消えないこと、タブを変えても編集エラーが消えないことを確認します。
6. Side Panelを閉じて再表示、Chrome終了→再起動後も操作結果を確認。全件削除後も空一覧、他キーも保持。作成したClipの挿入は上記#1の安全回帰手順で確認します。
7. 容量不足／get・set失敗の実機注入が難しい場合はNode試験結果を使い、実機は未実行と記録します。失敗後は成功表示なし、入力保持、二重保存なしを確認します。

### Issue #1実装時の確認記録（履歴）

- PASS: `npm ci --cache /tmp/lg-quick-clip-npm-cache`（デフォルトキャッシュディレクトリが使えず、一度失敗後に書込可能なキャッシュで成功）
- PASS: `npm run typecheck`
- PASS: `npm run build`
- PASS: `npm test`（13件、Nodeテストダブル）
- 未実行: Chromeでの拡張読み込み、実際のSide Panel／フォーカス／イベント／ストレージの手動受入すべて
- 未実行: lint（設定・スクリプトなし）

### Issue #2の確認記録（2026-10-14）

- `npm ci --cache /tmp/lg-quick-clip-npm-cache` 実行済み。
- PASS: `npm run format:check` / `npm run typecheck` / `npm test`（89/89、Nodeテストダブル）/ `npm run build` / `git diff --check`。独立レビューでも再実行して合格。詳細はDraft PRおよび `.codex/archive/ISSUE_002_REPORT.md`。
- Cloud Chromium 154の起動を試しましたが、環境のsocket制約（Operation not permitted）で開始できませんでした。Web Locksの仕様確認とNodeモック試験は、実際の拡張origin／Side Panelでの動作確認とは区別します。
- Chrome拡張読み込み・レイアウト・実イベント・Web Locksの複数パネル排他・再起動永続化は今回未実行。オーナーのローカルChromeで確認します。
- lintは設定・スクリプトがないため未実行。依存・権限・manifest・content script・Prettier 3.9.10の設定は変更していません。

今回の停止点はDraft PRです。mainへのマージ・Issueクローズ・配布は行いません。
