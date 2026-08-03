# TeslaCamフォーマット実装メモ

更新: 2026-08-03

## 位置づけ

TeslaCamのファイル構造は、Teslaが互換性を保証する公開APIではない。
この文書は第1PRのパーサー実装前提を固定し、実車データで再検証すべき点を明確にする。

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
- 相対パスに`..`セグメントが含まれる入力は拒否する。
- この段階では動画本体もmanifestも外部送信しない。

## 実車データで確認すること

Kanの2026年Model YのTeslaCamフォルダから、個人情報を除いた匿名fixtureを作り、次を確認する。

1. 実際のカメラ接尾辞とカメラ本数
2. イベントディレクトリ名とクリップ時刻の関係
3. `event.json`等の補助ファイル構成
4. 空・破損・途中書き込みファイルの発生形態
5. Windows/macOSで選択した場合の`webkitRelativePath`

確認前に、ファイル名だけから接触有無や撮影時刻のタイムゾーンを断定しない。
