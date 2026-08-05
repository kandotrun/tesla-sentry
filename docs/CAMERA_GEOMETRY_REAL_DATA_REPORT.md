# Model Yカメラ幾何V2の匿名実データ検証

更新：2026-08-05 JST

## 検証境界

認可済みTeslaCam在庫の全MP4を、ローカルで読み取り専用として検証した。

この検証は`model-y-2025-plus-long-range-2896x1876-v2`に対するコンテナmetadataの互換性確認である。

全フレームのデコード、固定アンカー抽出、物体検出、接触判定は含まない。

実ファイル名、相対path、撮影時刻、場所、映像、元データとの対応表は保存していない。

## 在庫metadata

| 指標 | 結果 |
| --- | ---: |
| 全MP4 | 12,902本 |
| 総容量 | 433,020,823,067 bytes |
| `ffprobe`可読 | 12,902 / 12,902本 |
| `ffprobe`不可読 | 0 / 12,902本 |
| 既知camera suffix | 12,810 / 12,902本 |
| 未認識suffix | 92 / 12,902本 |
| duration範囲 | 0.951秒から60.6307秒 |
| 50秒未満 | 735 / 12,902本 |
| 内部group | 2,136組 |
| 6方向完全group | 2,134 / 2,136組 |
| 6方向不足group | 2 / 2,136組 |
| camera重複group | 0 / 2,136組 |

既知6方向は各2,135本だった。

`front`は2,135 / 2,135本がH.264、2896×1876だった。

`back`、左右repeater、左右pillarは、それぞれ2,135 / 2,135本がH.264、1448×938だった。

既知suffixの12,810 / 12,810本がcodec、解像度、回転なし、`ffprobe`が公開したcrop offsetなしの条件に適合した。

6方向完全groupの2,134 / 2,134組が、全6録画の同じmetadata条件に適合した。

未認識suffixの92本は全件を`ffprobe`したが、camera roleを割り当てず、group適合の分母へ入れていない。

### 非互換理由

理由は次の固定順で集計した。

| 理由 | 件数 |
| --- | ---: |
| `unrecognized_filename` | 92 |
| `probe_failed` | 0 |
| `missing_video_stream` | 0 |
| `codec_mismatch` | 0 |
| `resolution_mismatch` | 0 |
| `rotation_mismatch` | 0 |
| `cropped_input` | 0 |
| `incomplete_group` | 2 |
| `duplicate_camera` | 0 |

このmetadata適合には、raw-videoから算出するアンカー誤差を含めていない。

crop確認はcontainerとvideo streamのmetadataに公開されたoffsetだけを対象とし、raw frameの画角変化、letterbox、内容上の切り抜きを完全検出しない。

したがって、12,810本を`matchVehicleCameraProfileV2`の完全適合とみなしていない。

## Repeaterの校正とホールドアウト

左右repeaterは、校正12群と独立したホールドアウト12群を、それぞれ10秒、30秒、50秒で評価した。

数値ゲートは各群の3時点RGB中央値へ適用した。左右それぞれ2アンカーの校正12/12群とホールドアウト12/12群が許容値0.01以下だった。ホールドアウトの最大誤差は左が0.006955、右が0.005217だった。

個別時点matcherは、左A、右A、右Bが35/36時点だけ許容値以下で、左Bは36/36時点が許容値以下だった。ホールドアウト最大誤差は順に0.013331、0.013911、0.013331、0.005217だった。

したがって、群中央値の結果を「全個別時点が0.01以下」と解釈しない。個別観測の誤差が0.01を超える場合、runtimeのprofile matcherは`anchor_drift`としてfail-closedに拒否する。

匿名の群別誤差配列、全288件の時点別誤差観測、観測から再計算できる集計、選定・正規化・source不変性は[repeater measurement artifact](../packages/camera-geometry/evidence/model-y-2025-plus-repeater-measurement-v1.json)に固定した。物理外装面の可視性は初回ローカル目視の結果であり、このmachine-readable artifactから画像内容を再現できない。

校正12群とホールドアウト12群には、単一の認可済み実測runでraw group identityから生成したHMAC-SHA256 tokenを付けて分離を監査した。artifactには監査結果のtoken 24件、重複0件、cohort間交差0件だけを残し、raw token、HMACの一時secret、元データとの対応表は保存しない。この集計は元データへ対応付けできず、別runでは再現できない。

この結果は測定済みrepeater境界の固定幾何を支えるが、車両全体の接触判定を支えない。

## BackのBLOCKED結果

`back`では物理的な塗装面と車体境界を校正11/12群で観測できた。

ただし、校正集合で試した3種類のアンカー抽出器は、2アンカーを3/3時点で許容値以内にした群が8/12から9/12に留まった。

3種類の最大誤差は0.035357から0.053789で、許容値0.01を超えた。

このため`back`は`unvalidated`のままとし、直接幾何座標をプロファイルへ入れていない。

## 手動spot check

匿名の6方向完全groupを2組選び、12本を全件集計とは別の直接`ffprobe`で確認した。

- 動画stream可読：12 / 12本
- H.264一致：12 / 12本
- camera別の期待解像度一致：12 / 12本

このspot checkでも映像内容、固定アンカー、物体mask、接触有無は評価していない。

## Source不変性

検証前は12,902本、433,020,823,067 bytesだった。

検証後も12,902本、433,020,823,067 bytesだった。

件数差は0本、容量差は0 bytesで、sourceへの書き込みは行っていない。

## 未実装のraw-video層

次の処理は未実装である。

- raw-videoからの固定アンカー抽出
- 物体検出
- セグメンテーション
- 物体追跡
- 文脈cameraから直接cameraへの候補関連付け
- camera間の時刻整合と候補coverage生成
- 画素距離から物理距離への復元
- 実動画を入力とする本番用の接触分類

このため、今回の全件検証から接触または非接触のverdictは生成していない。

`no_contact_observed`を全在庫へ付与した結果でもなく、損傷がないことも保証しない。
