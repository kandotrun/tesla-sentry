# MP4事前検査の実装前提

更新：2026-08-03 JST

## 対象

**MP4事前検査**は、TeslaCam manifestが対象にした動画のコンテナ情報をブラウザ内で確認する処理である。

次の情報を取得する。

- 動画時間
- コーデック
- 解像度
- 暗号化されたsample entryの有無

次の状態も選択結果から黙って削除せず、要確認として残す。
ただし、`ready`以外は次段階のアップロード候補には含めない。

- 空ファイル
- 暗号化された動画
- H.264またはH.265以外の動画
- 動画トラックがないMP4
- MP4 parserがエラーにしたファイル
- 読込上限までにmetadataを取得できなかったファイル

## アップロード可否契約との関係

`ready`はアップロード可否契約v1で`eligible`になるための必要条件だが、十分条件ではない。
最終的なローカル分類は[アップロード可否契約 v1](UPLOAD_ELIGIBILITY_CONTRACT.md)が決める。

manifest内の同一fingerprintの後続clipと、事前検査recordが重複したclipは`status: blocked`にする。
事前検査recordがないclipは`status: pending`、`ineligibilityReason: missing_preflight`にし、非`ready`は同じcodeを`ineligibilityReason`として`status: blocked`にする。
`ready`を申告していてもcodec、暗号化状態、動画時間、解像度、走査byte数が矛盾する場合はfail-closedで`status: blocked`にする。

## 読込方式

ブラウザは最大1 MiB単位のrangeを読み、ISO BMFFのbox headerだけを境界検証しながら辿る。
`mdat`のpayloadは読まず、宣言sizeを検証して後方の`moov`へseekする。

`moov`配下では`mvhd`、`trak`、`tkhd`、`mdia`、`mdhd`、`hdlr`、`minf`、`stbl`、`stsd`の必要な固定長fieldだけを読む。
`stts`や`stsz`のsample tableは展開せず、未信頼の`sample_count`を反復処理へ使わない。

実際に読み込むbyte数は1ファイルあたり8 MiBをhard capとし、呼び出し側のoptionでも緩和できない。
1回のrange読込も1 MiBを超えない。

byte capだけでは小さなboxを大量に並べるobject増幅を防げないため、次の構造上限も固定する。

- 解析box数：最大4,096
- boxの入れ子：最大16階層
- `stsd` sample entry：最大32
- Visual Sample Entry：固定fieldを含む最小78 byte payload
- `stsd`内の全sample entryを確認し、1件でも暗号化・未対応なら要確認
- `avc1`–`avc4`は`avcC`、`hvc1`/`hvc2`/`hev1`/`hev2`は`hvcC`を必須化
- file終端まで延長するsize `0`はtop-level boxだけで許可
- 32/64-bit box size：JavaScriptのsafe integerと親box/file境界内だけを許可

同時検査数は2ファイルに制限する。

フォルダを選び直した場合は`AbortController`で旧検査を中断し、完了が遅れた旧結果も現在の画面へ混入させない。

## 判定コード

- `ready`：H.264またはH.265で、時間と解像度を取得できた
- `empty_file`：0 byte
- `encrypted`：動画sample entryが暗号化形式
- `unsupported_codec`：許可対象外のコーデック
- `missing_video_track`：動画トラックなし
- `invalid_container`：box境界・構造上限・必須構造の違反、またはparser例外
- `metadata_not_found`：読込上限またはEOFまでに必要情報を取得できない

`metadata_not_found`は「破損」を断定しない。
`moov`の配置や未対応構造でも同じ結果になり得るためである。

## この検査が保証しないこと

この処理はコンテナmetadataの走査であり、全フレームをデコードしない。

したがって、`ready`でも途中フレームの破損、映像内容、ファイル全体の完全性、TeslaCamとしての再生完全性は保証しない。

2026-08-03にKanの実TeslaCamデータで初回互換性を確認した。

- カメラ映像25本：全件`ready`、`avc1`、duration・codec・dimensionsの`ffprobe`不一致0
- 実読込量：1本あたり約1.06–1.08 MiB
- `SentryClips`の名前・容量inventory 445本：7イベント、未保持0
- 各イベントの小さな`event.mp4` 7本は通常カメラ映像とは異なる`mp4v`補助プレビューであり、manifestで明示除外する

実映像、実ファイル名、位置、日時はコミットも外部送信もしていない。
H.265や別Tesla世代を含む互換性確認は継続する。

## テストデータ

リポジトリにはFFmpegで生成した1秒の黒画面H.264 MP4だけを含める。
Teslaまたはユーザーの実映像は含めない。

大きな`mdat`のseek、巨大なsample count、最小boxの大量配置、入れ子box flood、過小・size 0・codec設定欠落Visual Sample Entry、複数sample entryは、テスト内で生成したbyte列で確認する。

## 依存関係

MP4 metadata readerに実行時の第三者依存は使わない。
