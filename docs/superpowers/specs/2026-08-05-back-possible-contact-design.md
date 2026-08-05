# back接触可能性判定の設計

更新：2026-08-05 JST

状態：実装済み、実在庫検証済み

## 目的

2026年1月納車の2025年以降Model Y Long Rangeが記録した`back`映像について、自車の固定接触境界を特定できない場合でも、接触時に起こり得る時間変化を検出し、イベントを`possible_contact`として確認対象へ残す。

`possible_contact`は「接触可能性あり」を意味する。

接触の確定、接触した車体部位、損傷の有無は意味しない。

## 現在の境界

カメラ幾何V2では、直接接触幾何を持つのは`left_repeater`と`right_repeater`だけである。

`back`は物理的な自車外面を観測できる一方、固定アンカーの再現精度が校正条件を満たさないため、`directContactGeometry: "unvalidated"`の文脈カメラとして扱う。

イベント判定は`contact`、`possible_contact`、`no_contact_observed`、`indeterminate`の四値として実装した。

直接カメラへ関連付けられないrear-only候補は、有効なback signalがなければ`indeterminate / insufficient_camera_coverage`になる。有効なback signalがある場合は`possible_contact`として保持する。

FFmpeg前処理v1は各clipの代表frameを1枚生成するだけである。これとは独立した`back-temporal-impact-v1` producerが`back`の時系列変化を解析する。

## 検討した方式

### 採用：独立した`possible_contact`

`back`の時系列解析が接触時に起こり得る複合的な動きを検出した場合、既存の確定判定と分離した`possible_contact`を返す。

この方式は、ユーザーがrear-only候補を単なる判定不能と区別でき、`contact`の根拠である測定済みrepeater境界を弱めない。

### 不採用：`indeterminate`の理由codeだけを追加する

`indeterminate / back_contact_suspected`として表す案である。

既存Schemaへの変更は小さいが、映像確認の優先度が一般的な画質不足やカメラ欠落と同じになり、接触の可能性をユーザーへ明確に伝えにくい。

### 不採用：`back`へ固定接触幾何を追加する

車体mask、固定アンカー、接触境界を`back`へ追加し、直接接触を評価する案である。

既存の3種類のアンカー抽出器は校正12群のうち8群から9群でしか条件を満たさず、最大誤差も許容値0.01を超えたため採用しない。

### 今回は不採用：VLMによる単独判定

`back`候補区間をVLMへ渡し、接触可能性を直接分類させる案である。

評価用の接触正例と近接負例、通常利用映像とは別の学習同意、推論費用と再現性の検証が必要であり、最初の決定論的producerには含めない。

## 判定Schema

イベント単位の判定へ次を追加する。

```text
possible_contact
  reason: back_temporal_impact_signal
```

`possible_contact`は空でない固定理由を持つ。

初期理由は`back_temporal_impact_signal`だけに限定する。

カメラ位置、clip、候補時刻、解析version、集計scoreは構造化証拠へ保持するが、イベント判定理由の列挙値を計測手法ごとに増やさない。

ユーザー向けには次の文言を表示する。

> 後方映像で接触の可能性を示す動きを検出しました。映像を確認してください。

「接触しました」「車体に当たりました」「損傷があります」とは表示しない。

## back時系列証拠

raw-video producerは`back` clipだけを対象に、次の固定Schemaを生成する。

- Schema version
- analyzer version
- camera role
- clip識別子
- 解析状態
- 解析frame数
- 解析対象時間
- 候補時刻
- 全画面変位score
- 瞬間変化score
- 反転または復元score
- 画質可否
- 時刻信頼性
- 固定issue code

解析状態は次の3種類とする。

- `possible_contact`：複合的な時間変化が検出された。
- `no_impact_signal_observed`：解析可能だったが、採用条件を満たす変化を検出しなかった。
- `indeterminate`：frame不足、低視認、時刻不良、非対応入力、解析失敗などで評価できなかった。

`no_impact_signal_observed`は、この時系列heuristicが採用条件を満たす信号を検出しなかったことだけを表し、後方で接触がなかったことや損傷がないことを保証しない。

任意JSONを型付き証拠として扱わない。

producer出力はruntime parserでSchema、有限数、範囲、camera role、version、状態ごとの必須fieldを検証してからイベント判定へ渡す。

## raw-video producer

producerは既存の安全なFFmpeg実行境界を再利用し、元動画を書き換えない。

`ffprobe`とSPS traceでH.264、1448×938 display、1456×944 coded、top 0、bottom 6、left 0、right 8のcanonical pixel crop、回転0、3秒から90秒、1 fpsから120 fpsを再検証する。

実映像互換性の修正では、6必須fieldすべてで出現回数と値が一致する同一SPS反復だけを受理した。競合、欠落、malformed反復は引き続き拒否する。FFprobeの最初のframe recordは0件または1件を受理し、省略された空`side_data_list`に対応する。0件の場合もcanonical SPS、coded/display size、crop equationの一致を必須とし、実decodeを省略しない。

FFmpegで一定frame rateへ標本化し、縮小したgrayscale frameをstdoutへstreamする。

全frame、JPEG、候補動画を保存しない。

Python側は固定数の直近frameだけを保持し、次の時系列量を計算する。

1. 明度の一様変化を補正した複数領域の画面変位
2. 平常区間に対する変位の瞬間的な増加
3. 短い時間窓内の逆方向変位または基準位置への復元
4. 暗所、低contrast、decode欠落、frame間隔の乱れ

`possible_contact`には、画質と時刻が利用可能であることに加え、瞬間的な全画面変位と、反転または復元の両方を要求する。

単一frameの明度変化、滑らかなpan、連続した走行motionだけでは`possible_contact`にしない。

先頭と末尾のdecode境界は候補から除外する。

数値閾値は実装時にversion付き定数として固定し、Schemaへanalyzer versionを保存する。

閾値変更は同じversionの挙動変更として扱わない。

## 判定優先順位

イベント判定は次の順序にする。

1. 測定済みrepeater境界と独立補強証拠がすべて揃う場合は`contact`。
2. `contact`ではなく、有効な`back`証拠が`possible_contact`の場合は`possible_contact`。
3. profile、coverage、画質、時刻、遮蔽、死角、追跡のいずれかが不十分な場合は理由付き`indeterminate`。
4. それ以外は`no_contact_observed`。

有効な`back`の接触可能性は、左右repeaterへ関連付けられないrear-only候補でも保持する。

左右repeaterが`outside`でも、その評価を未検証の後方車体境界へ外挿して`back`の接触可能性を打ち消さない。

`back`証拠が`possible_contact`の場合は`no_contact_observed`を返さない。

不正なSchema、非有限score、範囲外時刻、異なるcamera role、未知versionを`possible_contact`へ昇格させない。

## 実装境界

今回の縦切りには次を含める。

1. `back`時系列証拠の固定Schemaとruntime parser
2. FFmpegとPython標準ライブラリによるread-only producer
3. `ContactEventEvidence`への`back`証拠接続
4. `possible_contact`を含むイベント判定
5. 日本語の結果表示mapping
6. 合成動画fixtureによるproducer回帰テスト
7. `<PRIVATE_TESLACAM_SOURCE>`にある認識済み`back`映像のread-only全件検証

今回の縦切りには次を含めない。

- `back`の車体mask、固定アンカー、接触境界
- 接触部位または損傷の推定
- 物体検出、物体segmentation、個体track
- 顔またはナンバーの認識
- VLM推論
- 通常利用映像の学習利用
- 本番R2、Queue、Containerの作成またはdeploy

## テスト

新しい振る舞いはRED、GREEN、REFACTORで実装する。

runtime parserでは正常な3状態に加え、field欠落、未知field、異なるcamera、未知version、NaN相当、負数、範囲外時刻、状態とfieldの不整合を拒否する。

イベント判定では次を固定する。

- 有効なrepeater接触証拠は`contact`になる。
- repeater接触がなく有効な`back`疑いがある場合は`possible_contact`になる。
- rear-onlyでも`possible_contact`を保持する。
- `possible_contact`を`no_contact_observed`へ落とさない。
- `back`の疑いだけで`contact`にしない。
- 不正または利用不能な`back`証拠は`indeterminate`になる。
- 有効な疑いがない場合は既存の三値判定を維持する。

producerではFFmpegで作る匿名合成fixtureを使い、静止、滑らかなpan、瞬間的な明度変化、急変と復元、短すぎる動画、暗所、破損入力を分けて検証する。

## 実データ確認

実データは`<PRIVATE_TESLACAM_SOURCE>`をread-onlyで扱う。

認識済み`back`映像を全件対象にし、実行中の全MP4 metadata/identityと、対象件数および総bytesを比較する。

結果には次の匿名集計だけを残す。

- 対象本数
- 読み取り成功本数
- 解析成功本数
- `possible_contact`本数
- `no_impact_signal_observed`本数
- `indeterminate`本数とissue code別件数
- analyzer version
- score分布の匿名集計
- 処理時間

実ファイル名、撮影日時、撮影場所、映像、frame、顔、ナンバー、VIN、候補時刻と元データの対応表はリポジトリへ保存しない。

この在庫には接触正解ラベルがないため、全件実行は互換性、安定性、処理時間、候補率の確認である。

precision、recall、接触検出率の検証とは表現しない。

既知の接触正例と近接負例が別同意で用意されるまでは、`possible_contact`を確定判定へ昇格させない。

2026-08-05の最終runはback/rear_view 2,135件、62,184,707,400 bytesを対象にし、1,914件を`no_impact_signal_observed`、221件を`indeterminate`、0件を`possible_contact`とした。解析可能な1,914件のglobal motion最大値は0.30652、impulse最大値は0.30652で、採用閾値には到達しなかった。

preflight後、run開始前に既知camera suffixへ一致しないMP4が92件増えた。back件数とbytesは不変で、run開始時から終了時までの全12,902 MP4 metadata/identityは一致し、事後3観測も安定した。この外部差分をreportへ明記し、back結果だけを有効とした。preflight artifactの`recognizedMp4Files`は実際には全MP4件数を保存した誤命名だった。

## 失敗時の扱い

FFmpeg timeout、decode失敗、frame不足、低視認、時刻不良は除外せず`indeterminate`へ残す。

一部clipの失敗でイベント全体の他の証拠を消さない。

producerのstderr、入力path、raw score列をユーザー向けmessageへ含めない。

出力保存に失敗した場合は成功扱いにせず、atomic write前の一時結果を最終結果として扱わない。

## 完了条件

- `possible_contact`が公開Schemaと日本語表示に追加されている。
- `back`だけの有効な疑いが`possible_contact`になり、`contact`にはならない。
- 静止、滑らかなpan、明度変化だけのfixtureが`possible_contact`にならない。
- 急な全画面変位と短時間の復元を持つfixtureが`possible_contact`になる。
- 不正、低品質、不完全な入力が理由付き`indeterminate`になる。
- TypeScriptとPythonのtest、型検査、Lint、build、該当Cloudflare dry-runが成功する。
- 実データ全件確認でback対象件数とbytesが一致し、run内の全MP4 metadata/identityが変化しない。
- 実データ結果を件数と限界付きで報告し、精度を過大評価しない。
