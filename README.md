# Sentry Check（仮）

**セントリー映像、全部見なくていい。**

TeslaCamフォルダを選ぶだけで、数百本のセントリー映像から確認すべき場面を絞り込むWebサービスです。

## 現在地

最初のローカル縦切りが動作します。

1. デスクトップChromeでTeslaCamフォルダを選択する
2. `SentryClips`をイベント・カメラ単位にローカル整理する
3. アップロード前に件数・容量・除外対象・未識別ファイルを確認する

4方向の基本カメラに加え、AI4/HW4の左右ピラーカメラと旧`rear_view`接尾辞を認識します。未知のカメラ接尾辞も動画を捨てず、要確認として残します。

この段階では動画もメタデータも外部へ送信しません。R2アップロード、動画解析、AI判定は、実際のTeslaCamフォルダでパーサーを確認してから段階的に追加します。

## プロダクト原則

- Teslaアカウント連携なし
- 専用デバイスなし
- 見逃しを避けるため、高再現率で候補を残す
- 「接触していない」と断定しない
- 元動画は解析後に早期削除し、学習利用は別途明示同意
- 1TB無制限を約束しない

## ドキュメント

- [プロジェクトコンテキスト](docs/PROJECT_CONTEXT.md)
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

`npm run check`はパーサー／UIのテスト、TypeScript型検査、Biome、プロダクションビルドを実行します。`cf:dry-run`はCloudflare Workers Static Assetsのバンドルだけを検証し、デプロイはしません。

## 構成

```text
apps/web/                   React UI + Cloudflare Static Assets
packages/teslacam-parser/  TeslaCamパス・イベント・カメラ整理
docs/                       プロダクト判断と原計画
```
