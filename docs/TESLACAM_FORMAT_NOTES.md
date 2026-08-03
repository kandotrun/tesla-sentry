# TeslaCamフォーマット実装メモ

更新: 2026-08-03

## 位置づけ

TeslaCamのファイル構造は、Teslaが互換性を保証する公開APIではない。
この文書はパーサー実装前提と、個人情報を残さない実車互換性確認の結果を固定する。

## 参照した情報

- [Tesla Owner's Manual: Dashcam](https://www.tesla.com/ownersmanual/modely/en_us/GUID-F311BBCA-2532-4D04-B88C-DBA784ADEE21.html)
  - USB上のTeslaCam映像を扱う機能と運用の一次資料。
  - 低レベルのファイル名接尾辞を安定した公開契約として定義する資料ではない。
- [SentryDeck `CameraNames.cs` at `ae13f86`](https://github.com/danielchalmers/SentryDeck/blob/ae13f86b29b175b8b5455f936c6a53a6515fcb77/SentryDeck.Data/CameraNames.cs)
  - `front`、`back`、左右repeater、左右pillar、旧`rear_view`の公開実装例。
- [tesla_dashcam at `7038459`](https://github.com/ehendrix23/tesla_dashcam/tree/7038459db90314f45675bd065b5e5315b81caca0)
  - イベントディレクトリとカメラ別MP4を扱う公開実装例。

GitHub上の実装はTesla公式仕様ではないため、互換性の参考資料としてのみ使用する。

## 第1PRのパーサー契約

- 既定対象は`TeslaCam/SentryClips`、または直接選択された`SentryClips`。
- イベントディレクトリをイベント境界として扱う。
- `front`、`back`、`left_repeater`、`right_repeater`、`left_pillar`、`right_pillar`を既知カメラとして扱う。
- `rear_view`は`back`へ正規化し、元の接尾辞もmanifestに保持する。
- 未知のカメラ接尾辞・命名・フォルダは黙って破棄せず、manifestの警告へ残す。
- `SentryClips/<event>/event.mp4`（大文字小文字は不問）はTesla生成の補助プレビューとして明示除外する。類似名や別階層の`event.mp4`は除外しない。
- 相対パスに`..`セグメントが含まれる入力は拒否する。
- この段階では動画本体もmanifestも外部送信しない。

## 2026-08-03の実車互換性確認

KanのTeslaCamフォルダをローカルで確認し、集計形状だけを匿名fixtureへ固定した。
実映像、実ファイル名、場所、日時はコミットも外部送信もしていない。

- 入力：7 event directories / 445 MP4
- カメラ映像：438本。6カメラそれぞれ73本
- Tesla生成補助プレビュー：各イベントの`event.mp4` 7本
- `event.mp4`の実測形状：`mp4v`、640×415、6 fps、10秒
- 代表カメラ映像25本：全件`avc1`、1448×938または2896×1876
- 代表25本のduration・codec・dimensions：`ffprobe`との不一致0
- MP4事前検査の実読込：1本あたり約1.06–1.08 MiB

残る互換性確認は、空・破損・途中書き込み、暗号化動画、Windows/macOS間の`webkitRelativePath`差異、別Tesla世代・H.265である。
ファイル名だけから接触有無や撮影時刻のタイムゾーンは断定しない。
