# docshare

リンクを知っていれば誰でも編集できる、軽量な共同編集メモ。ログイン不要。Cloudflare Workers + Durable Objects + D1 の無料枠で動く。

- エディタ：ProseMirror を直接使用（太字・斜体・下線・チェックボックス・リンク）
- リンク：URL を入力して空白を打つか、URL を貼り付けるとリンクになる。文字を選んでツールバーの 🔗 からも付けられる。リンク上にカーソルを置くと「開く・編集・解除」が出る。PC では Ctrl / Cmd + K で入力、Ctrl / Cmd + クリックで開く。使えるのは http・https・mailto だけ
- 表示：ヘッダーの ☀ / ● でライト・ダークを切り替える（端末に保存）。選ぶまでは OS の設定に従う
- AI からの読み取り：`/d/{docId}` の HTML には本文がサーバー側で埋め込まれる。JavaScript を実行しない読み手（Claude・ChatGPT・Gemini などの URL 読み取り）にも中身が見える
- 紹介ページ：`/about`（静的 HTML。トップの「docshare とは」から開く。名前登録なしで読める。ここだけ `noindex` を付けず検索エンジンに載せる）
- 同期：prosemirror-collab。文書ごとに 1 つの Durable Object（DocRoom）が編集を確定・保存する
- IME：変換中の未確定の文字は送らず、確定してから送る。変換中に届いた相手の編集も、確定後に反映する（変換が途切れないように）
- 履歴：編集はすべてリビジョンとして編集者付きで保存。任意の版に戻せる
- 完了・アーカイブ：ツールバーの「完了」で文書を読み取り専用にできる（誰でも押せる。取り消せるのは押した本人だけ）。最後の更新から 30 日たった文書も自動で読み取り専用になる。読み取り専用の文書からは「続きを新しい文書で」で、本文と文書名を引き継いだ新しい文書を作れる（冒頭に元の文書へのリンクが入る。続きは 1 文書につき 1 つ）
- ユーザー名：D1 に保存。名前を変えると過去の履歴の表示名も変わる

## 必要なもの

- Node.js 22 以上
- Cloudflare アカウント（デプロイ時）

## ローカル開発

依存パッケージを入れ、ローカルの D1 にテーブルを作る。

```bash
npm install
```

```bash
npm run migrate:local
```

フロントをビルドして `wrangler dev` を起動する（http://localhost:8787）。

```bash
npm run dev
```

フロントを編集しながら確認する場合は、別のターミナルで監視ビルドを動かす。`wrangler dev` は `dist/client` の変更を拾う。

```bash
npm run watch
```

型検査：

```bash
npm run typecheck
```

## テスト

```bash
npm test
```

テスト用の `wrangler dev`（ポート 8788、保存先 `.wrangler/test-state`）を起動し、`tests/` の試験を順に実行する。普段の開発データには触れない。

- `tests/protocol.test.mjs`：WebSocket と HTTP API（step の検証、サイズ上限、認証、レート制限、スナップショット）
- `tests/e2e.test.mjs`：スマホ幅のブラウザでの操作（同時編集、チェックボックス、履歴と復元、名前変更、オフライン、再接続、D1 障害からの復帰）

ブラウザ試験には Chromium が必要。初回だけ入れておく。

```bash
npx playwright-core install chromium
```

一部のファイルだけ流す場合は引数で指定する。

```bash
node tests/run.mjs tests/protocol.test.mjs
```

## デプロイ

1. Cloudflare にログインする。

   ```bash
   npx wrangler login
   ```

2. D1 データベースを作る。

   ```bash
   npx wrangler d1 create docshare
   ```

   出力された `database_id` を `wrangler.jsonc` の `d1_databases[0].database_id` に書く。このリポジトリには本番用の ID が設定済みなので、別のアカウントにデプロイする場合だけ書き換える。

3. 本番の D1 にテーブルを作る。

   ```bash
   npm run migrate:remote
   ```

   `migrations/` にファイルが増えたときも、デプロイ前に同じコマンドで本番に反映する（`create_quota` が無い間は、文書作成の全体上限だけが効かない）。

4. ビルドしてデプロイする。Durable Object（DocRoom、SQLite バックエンド）は初回デプロイ時に `migrations` の `v1` で作られる。

   ```bash
   npm run deploy
   ```

   完了すると `https://docshare.<アカウントのサブドメイン>.workers.dev` で公開される。

### 設定項目（wrangler.jsonc）

| 項目 | 内容 |
| --- | --- |
| `assets.run_worker_first` | `/api/*` と `/d/*`（本文を埋め込むため）は常に Worker で処理する。それ以外は静的ファイル、なければ `index.html`（SPA フォールバック） |
| `ratelimits` | IP 単位のレート制限。`CREATE_LIMITER` は文書作成・ユーザー登録（60 秒あたり 10 回）、`WS_LIMITER` は WebSocket 接続（60 秒あたり 60 回）。`namespace_id` はアカウント内で一意な整数文字列。バインディングが使えない環境では Worker 内の簡易カウンターで代替する |
| `d1_databases` | ユーザー情報（`users` テーブル）と文書作成数（`create_quota` テーブル）。マイグレーションは `migrations/` |
| `GLOBAL_CREATE_PER_MINUTE`（任意の環境変数） | 全体で 1 分あたりに作れる文書の数。未設定なら 60 |
| `ARCHIVE_AFTER_MS`（任意の環境変数） | 最後の更新から読み取り専用になるまでの時間（ミリ秒）。未設定なら 30 日 |

## 構成

```
src/client      フロント（エディタ、ツールバー、履歴シート、名前モーダル）
src/shared      schema、WebSocket メッセージ型、定数（フロントと DocRoom で共用）
src/worker      Worker エントリ、API ルーティング、レート制限、本文のサーバー側描画
src/worker/do   DocRoom（Durable Object）
migrations      D1 マイグレーション
public/_headers 静的ファイルのセキュリティヘッダー（CSP など。/about だけ X-Robots-Tag を外す）
public/about.*  紹介ページ（HTML・CSS・JS）
public/theme-init.js 選んだテーマを描画前に適用する（トップと紹介ページで共用）
public/favicon.* アイコン（apple-touch-icon.png も）
public/about-img 紹介ページの写真（ぱくたそのフリー素材。S サイズ相当に縮小し、ロゴをぼかしている）
tests           試験（npm test）
```

## API

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | /api/docs | 文書作成 → `{ docId }` |
| GET | /api/docs/{docId}/revisions?before=&limit=50 | 履歴一覧（新しい順、名前付き） |
| GET | /api/docs/{docId}/revisions/{revId} | その時点の文書 JSON |
| POST | /api/users | 初回登録 `{ userId, secret, name }` |
| PATCH | /api/users/me | 名前変更 `{ name }`（`X-User-Id` / `X-User-Secret` ヘッダーで認証） |
| POST | /api/docs/{docId}/continue | 読み取り専用の文書から続きの文書を作る → `{ docId }`（作成済みならその docId。文書作成と同じレート制限） |
| GET | /api/docs/{docId}/ws | WebSocket（DocRoom へ転送） |
| GET | /about | 紹介ページ（静的 HTML） |
| GET | /d/{docId} | 文書画面。本文を埋め込んだ HTML を返す（存在しない文書は 404） |

WebSocket のメッセージ型は `src/shared/messages.ts` を参照。

## 制限

| 項目 | 値 |
| --- | --- |
| WebSocket 1 メッセージ | 64KB |
| 文書全体 | 1MB（JSON 換算） |
| 文書名 | 100 文字 |
| 名前 | 1〜20 文字 |
| WebSocket メッセージ数 | 1 接続あたり毎秒 20 件 |
| 文書作成・ユーザー登録 | IP ごとに 60 秒あたり 10 回 |
| 文書作成（全体） | 1 分あたり 60 件（`GLOBAL_CREATE_PER_MINUTE` で変更） |
| WebSocket 接続 | IP ごとに 60 秒あたり 60 回 |
| WebSocket 同時接続 | 1 文書あたり 100 本、うち同じ IP から 20 本 |
| hello までの猶予 | 接続から 10 秒。過ぎると閉じる |
| 自動アーカイブ | 最後の更新（本文・文書名・完了の取り消し）から 30 日 |

## 無料枠の目安

DocRoom の SQLite への行書き込み数（`wrangler dev` 上で `rowsWritten` を計測）：

| 操作 | 行書き込み |
| --- | --- |
| 編集の送信 1 回（1 リビジョン） | 2 行（revisions への追加、meta.version の更新） |
| 200 step ごとのスナップショット | ＋1 行 |
| 文書名の変更 | 2 行 |
| 文書作成 | 4 行（meta 3 行、初期スナップショット 1 行。計測ではなく実装からの見積もり） |

クライアントは入力停止 500ms 後（連続入力中は 2 秒ごと）にまとめて送るため、入力し続けても 1 人あたり約 2 秒に 1 リビジョンになる。無料枠の行書き込み 10 万行/日は、およそ 5 万リビジョン/日に相当する。

## 写真素材

紹介ページ（`public/about-img/`）の写真は、ぱくたそ［ https://www.pakutaso.com ］のフリー素材を利用しています。二次配布物の受領者がこの素材を継続して利用する場合は、ぱくたそ公式サイトからご自身でダウンロードしていただくか、ぱくたそのご利用規約［ https://www.pakutaso.com/userpolicy.html ］に同意していただく必要があります。

## 動作確認済みの環境

| 環境 | 状態 |
| --- | --- |
| iPhone Safari | 実機で確認済み（複数端末での同時編集、キーボード表示中のツールバー） |
| Chromium（スマホ幅のエミュレーション） | `npm test` で確認 |
| Android Chrome | 未確認。Chrome 108 以降はキーボード表示時に visualViewport だけが縮むため、iOS と同じ仕組みで追従する想定 |
