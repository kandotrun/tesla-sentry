# 開発環境R2アップロード縦切り設計（PR5）

更新：2026-08-04 JST
状態：実装・実データ検証済み（開発環境限定）

## 目的

アップロード可否契約v1で`eligible`になったクリップを、開発環境ではWorker経由でローカルR2へ保存し、サーバー側で認可・サイズ・暗号学的ハッシュ・コンテナ内容を再検証する縦切りを実装する。

計画書（`docs/product/tesla-sentry-ai-service-plan-2026-08-03.md`）の本番向け「R2への直接アップロード」へ移行できるよう、開発環境ではジョブ→許可→Worker経由送信→再検証の契約を先に固定する。

## このPRでやらないこと

- 本番R2バケット・D1・Queue・Containerの作成とデプロイ
- 認証（メール・OAuth）、課金
- multipart upload（開発環境の単一PUTに限定）
- セッションを跨ぐ中断再開・重複スキップ
- 解析パイプライン（FFmpeg・CV・VLM）への投入

## スモークテストの結論

`wrangler dev --local`（miniflare）には、ブラウザから叩けるS3互換エンドポイントが存在しない。`/r2/<bucket>/<key>`はWorkerのフォールバック応答であり、ローカルR2へは書き込まれない（PUT 200でも`env.BUCKET.list()`に現れないことを確認済み）。

したがって開発環境のアップロード経路は次の形にする。

1. ブラウザがWorkerにジョブ作成とアップロード許可を要求する
2. WorkerがHMAC署名付きの短期トークン（キー、上限バイト、有効期限、期待SHA-256を含む）を発行する
3. ブラウザが`Authorization: Bearer <uploadToken>`を付けて固定URLへPUTする
4. Workerは本文をバッファせずR2バインディングへストリーミング保存する
5. ブラウザが検証を要求し、WorkerがR2上のオブジェクトを再検証する

本番でR2署名URL（または短期資格情報）へ差し替える場合、トランスポートだけが変わり、ジョブ→許可→送信→検証の契約と再検証ロジックは維持される。

## セッションと認可（開発用・ステートレス）

開発環境では永続ストア（D1/KV）を作らず、HMAC-SHA256署名トークンだけで状態を持たせる。

- `DEV_UPLOAD_SECRET`：`.dev.vars`でだけ定義する。リポジトリにコミットしない。テストは固定のダミー値を使う。
- ジョブトークン：`base64url(JSON payload) + "." + base64url(HMAC-SHA256)`。payloadは`jobId`、`iat`、`exp`、許可ファイルの一覧（fileId、key、size、sha256）。
- アップロードトークン：ジョブトークンから単一ファイル分を切り出した短期トークン（有効5分、対象キーと上限バイトを固定）。
- 検証はWebCryptoのtiming-safeな比較で行う。期限切れ・改ざんは401、job不一致は403、未知のfileIdは404で拒否する。
- `relativePath`は256文字、R2 object keyは512文字、署名job tokenは12 KiBを上限にし、Vite（Node HTTP）のheader budgetへ余裕を残す。

ブラウザの`eligible`判定はサーバーの信頼根拠にしない。サーバーはジョブ作成時も検証時も、パスの安全性・上限・形式を契約パッケージで再チェックする。

## R2キー規則

```text
dev/jobs/{jobId}/{eventId}/{安全化した相対パス}
```

- `jobId`はサーバー生成の乱数（32バイトhex）
- パスセグメントは128文字以内の`[A-Za-z0-9._-]`のみ許可し、それ以外は拒否（`..`、空セグメント、制御文字は全て拒否）
- `jobId`はジョブごとに変わるため、別ジョブ・再選択を跨ぐ重複スキップはこのPRでは行わない

## サイズ上限（開発環境）

| 項目 | 上限 |
|---|---:|
| 1ファイル | 2 GiB |
| 1ジョブ合計 | 20 GiB |
| 1ジョブのファイル数 | 12 |

上限は契約パッケージの定数として持ち、Workerとブラウザの両方で同じ値を使う。UIはファイル数または合計容量の上限前に複数ジョブへ自動分割する。 Workerは一意なR2 staging keyへ固定長bodyを完走した後だけfinal keyへpromotionし、短い/長い失敗再送で既存の検証済みobjectを壊さない。

## 検証（verify）の判定順序

fail-closedで、1つでも失敗したら`failed`。

1. 認可：ジョブトークン有効・期限内・対象fileIdが許可一覧に存在
2. 存在：R2にオブジェクトが存在する
3. サイズ：宣言サイズと完全一致（大きい・小さい両方拒否）
4. ハッシュ：incremental SHA-256でストリーミング計算し、宣言値と一致
5. コンテナ内容：保存済みバイトをRange読込し、既存の`preflightMp4`と同じ規則で`ready`であることを確認

サイズ・ハッシュ・コンテナ失敗時はオブジェクトを削除して理由コードを返す。検証中にETagが変わった場合は新しいオブジェクトを削除せず`object_changed`でfail-closedし、成功時だけ条件付きPUTでR2カスタムメタデータ（`verified=1`、preflight code、検証時刻）を書き戻す。

## video-preflightのリファクタ

`preflightMp4`はBlob専用だったため、同じ解析規則をWorker側で使えるようにする。

- `PreflightRangeReader`（`size`と`read(offset, length)`）を公開インターフェースとして追加
- `preflightRangeReader(reader, options)`をコア実装にする
- `preflightMp4(blob)`は`BlobRangeReader`アダプタ経由の薄いラッパーに維持（既存の呼び出し側とテストは互換）

## パッケージ・アプリ構成

- `packages/upload-session`（新）：ジョブ要求の検証、キー導出、トークンpayloadのエンコード/デコード、上限定数。純粋・ネットワーク非依存。
- `apps/api`（新）：Cloudflare Worker。ローカルR2バインディングのみ。`unstable_dev`による統合テスト。
- `apps/web`：SHA-256ストリーミング計算、アップロード進行、検証結果表示のUI追加。

## API（全て`/api/dev`配下、開発専用）

```text
POST /api/dev/jobs                     ジョブ作成（eligible項目一覧を受け取る）
POST /api/dev/jobs/:jobId/grant        単一ファイルのアップロード許可発行
PUT  /api/dev/upload                   ストリーミング保存（Authorization: Bearer <uploadToken>）
POST /api/dev/jobs/:jobId/verify/:fileId  サーバー側再検証
GET  /api/dev/jobs/:jobId/status       ファイル一覧と検証状態
```

開発用viteサーバーは`/api`を`127.0.0.1:8788`のローカルWorkerへプロキシし、CORSを回避する。

ローカル起動は別ターミナルで次を実行する。

```bash
# apps/api/.dev.vars に DEV_UPLOAD_SECRET を設定してから起動
npm run dev --workspace @sentry-check/api
npm run dev --workspace @sentry-check/web
```

`@sentry-check/api`の`dev`スクリプトがWorkerを8788番で起動し、web側のVite設定と一致させる。

## CI

- `npm run check`（全ワークスペースのtest・typecheck・lint・build）
- `cf:dry-run`はwebとapiの両方で実行
- Worker統合テストは`unstable_dev`（ローカルworkerd）で実行し、ネットワークとクラウドリソースを一切使わない

## 画面表示

- 開発環境向け機能であること、動画がローカル開発環境にだけ保存されることを明示する
- ファイルごとに`待機 / 送信中 / 検証中 / 検証済み / 失敗（理由）`を表示
- 別ジョブ・画面再読み込みを跨ぐ再開や重複スキップは表示しない
- アップロードしていないのに「検証済み」と誤解させる表示をしない
