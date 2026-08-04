# Project Context

更新：2026-08-04 JST

## 目的

録画しただけで終わっているTeslaセントリー映像を、ユーザーが短時間で「確認済み」にできる状態へ変える。

> 100本のセントリー映像を、見るべき3本にする。

## 現在のプロダクト判断

- PC向けWeb版のみ
- デスクトップChrome優先
- 専用デバイスなし
- Teslaアカウント連携なし
- `TeslaCam/SentryClips`を既定対象にし、`RecentClips`は既定除外
- 初期は元動画アップロード方式。ブラウザ側プロキシ生成は利用実態を見て判断
- 大容量ファイルは将来R2へ直接multipart uploadし、Worker本文を経由させない
- 元動画は解析後に明示削除し、7日ライフサイクルを安全網にする
- AIは候補区間のみ。全動画をVLMへ丸投げしない
- 年額2,000円はβ・創業者価格の仮説であり、無制限プランではない

## 実装済みの境界

アップロード前のローカル処理を小さなPRに分けて実装する。

第1PRはTeslaCam manifestを作成する。

- フォルダ選択
- TeslaCamの相対パス解析
- `SentryClips`のイベントとカメラ整理（基本4方向、AI4/HW4左右ピラー、旧`rear_view`）
- 件数、容量、除外、未対応ファイルの表示
- 120ファイル、30イベントを扱うテスト
- Cloudflare Workers Static Assetsのdry-run

第2PRは対象MP4をブラウザ内で事前検査する。

- 動画時間、コーデック、解像度の取得
- 暗号化、空ファイル、非対応コーデック、動画トラック欠落、破損候補の分類
- 1 MiB単位の分割読込とbox位置へのseek
- 1ファイルあたり8 MiBの読込上限
- 2ファイル並列の検査と、フォルダ再選択時の中断
- 合成H.264 fixtureによる回帰テスト

第3PRは実TeslaCamとの互換性を匿名集計で固定する。

- 7イベント・445 MP4の実測形状を、実日時・場所・映像を含まない合成descriptorで再現
- 438本のカメラ映像と、各イベントのTesla生成`event.mp4`補助プレビュー7本を分離
- 補助プレビューをpreflight対象から外し、除外件数を画面に表示

第4PRはmanifestと事前検査結果からローカルのアップロード可否契約v1を作成する。

- `schemaVersion: 1`で全clipを`eligible`、`pending`、`blocked`へ決定論的に分類
- manifestのevent順とclip順を保持し、事前検査の完了順に依存しない結合
- manifestと事前検査recordの重複、結果欠落、非`ready`、矛盾した`ready`をfail-closedで処理
- 未知cameraと未認識filenameのwarningを保持し、整合した`ready`は候補に残す
- 候補本数、容量、動画時間を`eligible`だけから集計
- UIに次段階候補、検査待ち、候補外を表示し、アップロード未開始を明示
- 動画、manifest、事前検査結果を外部送信しない純粋なローカル処理

MP4事前検査はコンテナのメタデータだけを確認する。
全フレームのデコード、映像内容の解析、ファイル完全性の保証は含まない。

第5PRは開発環境だけの単一PUTアップロードとサーバー側再検証を実装する。

- ブラウザでincremental SHA-256を計算し、短期HMACジョブ・ファイルトークンを取得
- 1ジョブ12本・20 GiB・署名token 12 KiBを上限とし、UIがeligible全件を複数ジョブへ自動分割
- Worker本文をバッファせず、固定長ストリームとしてローカルR2へ保存
- 保存後にサイズ、SHA-256、MP4コンテナをサーバー側で再検証し、失敗オブジェクトを削除
- 明示的なボタン操作後だけ送信し、フォルダ選択・事前検査だけでは送信しない
- multipart、中断再開、重複スキップ、本番R2、認証、課金は含めない

第6PRは1イベントのFFmpeg前処理境界を固定する。

- Python 3.11の固定Schema CLIで、最大256 clipをevent-local時刻へ整列
- 各clipをFFprobeで再検証し、H.264/HEVC、最大4時間、解像度、平均frame rateをfail-closedで確認
- 各clipの中点から、upscaleしない最大幅640 pxの代表JPEGを1枚生成
- 1fpsの短尺clipでも最終frame後をseekしないよう、`duration - 1 frame`を代表時刻の上限に設定
- 全成功を`ready`、一部失敗を理由付き`partial`、全失敗を`failed`として固定Schemaへ保存
- 未知cameraは`unknown`として代表frameまで保持し、後段profileで`判定不能`または要確認へ回す
- 絶対path、traversal、入力root外symlink、重複IDを処理開始前に拒否
- non-root UID/GID 10001、networkなし、read-only root filesystem、capabilityなしでDocker smokeを実行
- Python standard libraryだけをruntime依存とし、Ruffとstrict PyrightをCIへ追加

2026-08-04のNAS実データ匿名スモークでは、書き込み継続中のスナップショットを使って次を確認した。

- production manifest parserで`SentryClips` 33イベント、カメラ映像1,626本、補助`event.mp4` 33本を分類し、warning 0
- `SentryClips`全1,659 MP4のpreflightはカメラ映像1,625本ready、補助`event.mp4` 33本を`mp4v`として除外、duration 0・1フレームのカメラ映像1本をfail-closed
- 6方向が揃う1イベント（約181 MB）をproduction preflightへ通し、6/6 `ready`、6/6 H.264、5本が1448×938、front 1本が2896×1876
- 同じ6本をFFmpegで全フレームdecodeし、6/6成功
- 実ChromeからVite proxy、Worker、ローカルR2へBearer headerで送信し、サイズ、SHA-256、MP4再検証とstatus確認が6/6成功
- 同じ約181 MB・6方向を前処理Containerへ匿名化して渡し、4,182 msで6/6 `ready`、issue 0、代表JPEG 6枚を生成
- 実パス、撮影日時、映像、署名トークンはレポートへ保存しない

## 次の実装境界

1. 車種・年式・カメラ世代・解像度で選ぶ固定カメラプロファイルを定義し、方向別の車体マスクと近接ROIを正規化座標で持つ
2. 複数カメラの時刻差、車体揺れ、遮蔽を考慮して候補区間を抽出する
3. `接触可能性あり`、`近接のみ`、`判定不能`を含む固定Schemaの判定結果を表示する

本番R2、認証、課金は、multipart・中断再開・重複スキップと削除ライフサイクルを設計・検証してから進める。

## 評価原則

- 誤検知より見逃しを重く扱う
- 不確実性を表示する
- 接触や損傷を法的・保険的に断定しない
- 正例・近接負例・夜間・雨・死角を分けて評価する
- 目標値はデータセットの定義・件数と一緒に記録する

## ソース優先順位

1. 最新の受入条件と実装・テスト
2. `docs/UPLOAD_ELIGIBILITY_CONTRACT.md`と`docs/EVENT_PREPROCESSING_CONTRACT.md`
3. 本ファイル
4. `docs/product/tesla-sentry-ai-service-plan-2026-08-03.md`
5. PR・Issue・チャット上の古い議論

料金、Cloudflare制限、モデル仕様は変更されるため、実装時点の公式資料を再確認する。
