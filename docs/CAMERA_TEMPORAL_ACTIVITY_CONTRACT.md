# カメラ時間変化解析契約 v2

## 目的

Model Y 2025+ Long RangeのTeslaCam 6方向について、カメラ近傍で接触の可能性につながる短時間の画像変化を保守的に抽出する。これは物体接触や損傷を確定する判定ではない。

左右リピーターの直接幾何判定だけが、独立した補強証拠と十分なカバレッジを伴う場合に`contact`を返せる。フロント、バック、左右ピラーを含む時間変化解析は`possible_contact`までに制限する。

## 入力

1イベントは次の固定順で6本すべてを持つ。

1. `front`
2. `back`
3. `left_repeater`
4. `right_repeater`
5. `left_pillar`
6. `right_pillar`

重複clip ID、重複path、同一実ファイルへのalias、欠落、順序違い、未知方向、絶対path、`..`、symlink、解析中のleaf差し替えまたは同一inodeへの変更は拒否する。入力はread-onlyのfile descriptorで保持し、解析後と結果公開の直前・直後にdevice、inode、size、mtime、ctimeを再検証する。

フロントはH.264、display 2896x1876、coded 2896x1888、crop `(0,12,0,0)`を要求する。他5方向はH.264、display 1448x938、coded 1456x944、crop `(0,6,0,8)`を要求する。rotationは0度、durationは3秒以上90秒以下、frame rateは1以上120以下とする。SPSと先頭frameのcropが両方ある場合は一致を要求する。

## 時間変化アルゴリズム

映像は8 fps、160x104 grayscaleへ縮小し、連続frameごとに次を測る。

- `changedPixelRatio`: 絶対画素差が72以上の画素率
- `gradientChangeRatio`: 内側画素で水平・垂直中心差分のL1 gradient magnitude差が64以上の率
- `nearCameraScore`: `min(1, changedPixelRatio / 0.08, gradientChangeRatio / 0.10)`
- `occlusionFlatRatio`: 変化画素のうち、前後両方のL1 gradient magnitudeが40未満の率
- `occlusionScore`: occlusion条件を満たすtransitionについて`min(1, changedPixelRatio / 0.08, occlusionFlatRatio / 0.50)`、条件を満たさない場合は0

activity判定は2つの独立channelを持つ。

1. motion channel: `nearCameraScore >= 0.70`が4 transition以内に2回以上。
2. occlusion channel: `changedPixelRatio`が0.04以上0.80以下、`occlusionFlatRatio >= 0.40`、変化画素のbounding box面積率が0.85以下、かつ`occlusionScore >= 0.50`を満たすtransitionが4 transition以内に2回以上。

どちらか一方のchannelが成立すれば`activity_detected`とする。候補は成立channelの条件を満たしたwindow内の最大scoreのtransitionで、同点時は最初のtimestampを使う。全体輝度変化だけではgradient条件もocclusion条件も満たさない。

occlusion channelは、手や平らな物体がレンズ近傍へ来て画面を覆う接触に近い事象を、motion channelより低い閾値で捕まえる。flat領域は前後両方のgradientが小さいことを要求するため、背景の滑らかなpanや均一な明るさ変化では成立しない。

解析は1 passで、時間変化windowは最大4 sample、既存リアV1の平行移動windowは最大13 sampleに制限する。

## 方向別出力

`schemaVersion: 1`、`analyzerVersion: "camera-temporal-activity-v2"`、`source: "camera_temporal_activity"`の固定11 keyを返す。

- `activity_detected`: candidateと7 metricsがあり、issueは空
- `no_activity_signal_observed`: candidateは`null`、7 metricsがあり、issueは空
- `indeterminate`: candidateとmetricsは`null`、issueが1件以上

metricsは`changedPixelRatio`、`gradientChangeRatio`、`nearCameraScore`、`occlusionFlatRatio`、`occlusionQualifyingSamples`、`occlusionScore`、`qualifyingSamples`の固定7 keyである。scoreは有限の0以上1以下、整数はJavaScript safe integer範囲、clip IDは安全な固定文字集合に限定する。activity candidateのmetricsは成立channelの候補transition値で、no-signalの`occlusionFlatRatio`と`occlusionScore`は全体最大値を記録する。

issueは`analysis_failed`、`decode_failed`、`frame_timing_unreliable`、`insufficient_frames`、`low_visibility`、`unsupported_video`だけを許可する。不確実な入力をno-signalへ変換しない。

## 6方向aggregate

aggregateは固定6 keyを持ち、camera配列は入力と同じ固定順である。

- 1方向でもactivityなら`activity_detected`
- activityがなく1方向でもindeterminateなら`indeterminate`
- 6方向すべてno-signalの場合だけ`no_activity_signal_observed`

直接幾何の`contact`はaggregateより優先する。有効なactivity aggregateは`possible_contact`理由`camera_temporal_activity_signal`を作る。no-signal aggregateだけで新しい`no_contact_observed`を作らず、基礎判定を維持する。invalidまたはindeterminate aggregateは、既存の`contact`または`possible_contact`がない場合に`camera_activity_analysis_unavailable`で判定不能とする。

## 校正結果と限界

v1のmotion channelはユーザー確認済み接触窓1件を1件検出し、比較窓7件は0件検出した。同時刻の6方向窓ではバックだけが2 sample以上の持続条件を満たした。

v2では同じ8窓へocclusion channelを追加して再校正した。確認済み接触窓はmotion channel 5 qualifyingとocclusion channel 6 qualifyingで検出し、比較窓7件は両channelとも0件だった。v1の閾値0.70に近い比較窓(max 0.675331)はocclusion channelでscore 0となり、channel追加で分離幅が広がった。詳細は[camera-temporal-activity-calibration-v2.json](../containers/analyzer/tests/fixtures/camera-temporal-activity-calibration-v2.json)。元イベントの6方向同期窓はsource clipが循環録画で残っていないためv2では再現できず、fixtureへ`synchronizedSixCameraWindowAvailable: false`として記録した。

これは閾値校正であり、独立blind holdoutを持たないためaccuracy、precision、recallの主張には使わない。

全clipには未ラベルの人物・車両移動やカメラ振動が含まれ得る。時間変化は接触そのものではなく、完全な静止、映像外、遮蔽、低照度、欠損frameについて無損傷を保証しない。通常契約の映像を学習へ利用せず、実映像、実path、filename、撮影時刻をrepositoryへ保存しない。

## CLI

`python -m sentry_analyzer.camera_activity_cli --request request.json --input-root INPUT --output-root OUTPUT`で実行する。成功したactivity/no-signalはexit 0、aggregate indeterminateはexit 3、request違反はexit 2、処理境界の失敗はexit 5である。`result.json`は空のoutput directoryへmode `0600`で原子的に公開し、同一inodeの`result.tmp.json`をpublication anchorとして保持する。公開の直前・直後に6入力、output directory、結果entryのdevice、inode、size、mtime、ctimeとserialized bytesを照合する。競合または結果内容変更を検出した場合はpathを削除せず、保持descriptorが指す自身の結果を0 byteへ無効化して失敗する。output rootはone-shotの隔離directoryとし、失敗後は信頼済みorchestratorがdirectory単位で破棄する。

metadata・content checkpointは非協調writerに対するcheckpoint間を含む連続的なcontent不変性を証明しない。productionで強い完全性が必要な場合は、immutable snapshotまたはstorage versionへ入力を固定し、leaseまたは信頼境界でのcontent hash検証を併用する。
