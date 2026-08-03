# Sentry Check（仮）

**セントリー映像、全部見なくていい。**

TeslaCamフォルダを選ぶだけで、数百本のセントリー映像から確認すべき場面を絞り込むWebサービスです。

## 現在地

アップロード前のブラウザ内縦切りが動作します。

1. デスクトップChromeでTeslaCamフォルダを選択する
2. `SentryClips`をイベントとカメラ単位にローカル整理する
3. 対象MP4の時間、コーデック、解像度、暗号化と破損候補をブラウザ内で確認する
4. 件数、容量、除外対象、未識別ファイル、要確認クリップを表示する

ローカルのアップロード可否契約v1は、manifestと事前検査recordを次の三状態へ分類します。

- `eligible`：一意で整合した`ready`の送信候補
- `pending`：事前検査結果がない保留clip
- `blocked`：重複、非`ready`、または矛盾した`ready`により自動送信しないclip

4方向の基本カメラに加え、AI4/HW4の左右ピラーカメラと旧`rear_view`接尾辞を認識します。
未知のカメラ接尾辞も動画を捨てず、要確認として残します。
実車で確認した`SentryClips/<event>/event.mp4`はTesla生成の補助プレビューとして明示除外し、件数を表示します。

MP4事前検査はファイル全体を一括読込せず、1 MiB単位で必要なboxへseekします。
実際に読み込む上限は1ファイルあたり8 MiBです。
この検査はコンテナのメタデータを確認するものであり、全フレームの復号や完全性を保証しません。

この段階では動画もメタデータも外部へ送信しません。
`eligible`はローカルの候補であり、アップロード処理はまだありません。
実TeslaCamの初回互換性確認とアップロード可否契約v1は完了しており、次は開発用R2への再開可能な直接アップロードとサーバー側再検証、その後にFFmpeg前処理を段階追加します。

## プロダクト原則

- Teslaアカウント連携なし
- 専用デバイスなし
- 見逃しを避けるため、高再現率で候補を残す
- 「接触していない」と断定しない
- 元動画は解析後に早期削除し、学習利用は別途明示同意
- 1TB無制限を約束しない

## ドキュメント

- [プロジェクトコンテキスト](docs/PROJECT_CONTEXT.md)
- [アップロード可否契約 v1](docs/UPLOAD_ELIGIBILITY_CONTRACT.md)
- [事業・MVP計画書（2026-08-03）](docs/product/tesla-sentry-ai-service-plan-2026-08-03.md)
- [エージェント向け開発ルール](AGENTS.md)

## 開発

前提：Node.js 24 Active LTS（`.nvmrc`）とnpm。

```bash
npm install
npm run dev
```

品質ゲート：

```bash
npm run check
npm run cf:dry-run
```

`npm run check`はmanifestパーサー、MP4事前検査、アップロード可否契約、UIのテスト、TypeScript型検査、Biome、プロダクションビルドを実行します。
`cf:dry-run`はCloudflare Workers Static Assetsのバンドルだけを検証し、デプロイはしません。

## 構成

```text
apps/web/                    React UI + Cloudflare Static Assets
packages/teslacam-parser/   TeslaCamパス、イベント、カメラ整理
packages/video-preflight/   MP4ヘッダーの分割読込と事前判定
packages/upload-contract/   ローカルのアップロード可否契約v1
docs/                        プロダクト判断と原計画
```
