# back時系列接触可能性解析契約

更新：2026-08-05 JST

## 目的と非保証

対象profileは`model-y-2025-plus-long-range-2896x1876-v2`である。

`back`はカメラ幾何V2で`context_only`かつ`directContactGeometry: "unvalidated"`のままであり、直接接触を確定できるカメラへ昇格しない。

本契約は`back`映像の時間変化から確認対象を`possible_contact`として残す。これは接触時に起こり得るmotion signalであり、接触、損傷、接触部位、物理距離を確定しない。

`no_impact_signal_observed`は解析可能な映像で採用条件を満たすsignalを観測しなかったことだけを表す。非接触または無損傷を保証しない。

## 入力media契約

producerは次の条件をすべて満たす`back` MP4だけを解析する。

- codecはH.264
- display sizeは1448×938
- coded sizeは1456×944
- SPS由来のpixel cropはtop 0、bottom 6、left 0、right 8
- coded sizeからcropを引いた値がdisplay sizeと一致
- rotationは0度
- durationは3秒以上90秒以下
- 平均frame rateは1 fps以上120 fps以下

FFmpegの`trace_headers`からSPSの6必須fieldを読み取る。すべてのfieldで出現回数が一致し、各fieldの反復値が同一である場合に限り、同一SPSの反復を受理する。欠落、出現回数の不一致、競合値、malformed行、負のcrop、1 MiB超過、非UTF-8は`unsupported_video`へfail-closedにする。

FFprobe 5系と8系の出力差を固定Schemaで吸収する。最初のframe recordは0件または1件だけを受理し、2件以上を拒否する。frameの空の`side_data_list`は省略可能だが、存在する場合は配列かつ空でなければならない。frame cropが存在する場合は4 fieldすべてを要求し、SPS cropと一致させる。frame recordが0件でも、完全なcanonical SPS crop、streamのcoded/display size、crop equationが一致する場合に限りmetadata gateを通す。metadata gate後の実decodeは常に必須である。

## 時系列解析

FFmpegは入力を8 fps、160×104、grayscaleへ縮小し、raw frameをstdoutへstreamする。抽出frame、JPEG、候補動画を保存しない。

`back-temporal-impact-v1`は直近13 motion sampleだけを保持し、複数領域のgradientから最大3 pxの平行移動を推定する。24 frame未満、frame間隔が62 ms未満または250 ms超、半数以上のframeが低contrast、画素shape不一致は理由付き`indeterminate`になる。

`possible_contact`には次の3条件を同時に要求する。

- `globalMotionScore >= 0.45`
- `impulseScore >= 0.35`
- `recoveryScore >= 0.35`

明度の一様変化、滑らかなpan、連続motionだけではこの条件を満たさないよう、gradient、平常8 sampleとの差、候補後4 sample内の逆方向または復元を組み合わせる。

## 固定Schema

出力は`schemaVersion: 1`、`analyzerVersion: "back-temporal-impact-v1"`で、次の11 keyだけを持つ。

- `analysisDurationMs`
- `analyzedFrames`
- `analyzerVersion`
- `camera`
- `candidateTimestampMs`
- `clipId`
- `issues`
- `metrics`
- `schemaVersion`
- `source`
- `status`

`camera`は`back`、`source`は`back_temporal_motion`へ固定する。`clipId`は`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`に限定する。解析時間とframe数は安全な非負整数、3 scoreは有限の0以上1以下とする。候補時刻は有限の非負値で、解析時間を超えてはならない。

状態は次の3種類である。

- `possible_contact`：候補時刻とmetricsが必須、issuesは空
- `no_impact_signal_observed`：候補時刻はnull、metricsが必須、issuesは空
- `indeterminate`：候補時刻とmetricsはnull、issuesは空でない

issueは`analysis_failed`、`decode_failed`、`frame_timing_unreliable`、`insufficient_frames`、`low_visibility`、`unsupported_video`の6種類だけである。rootとmetricsの未知key、状態とfieldの不整合をruntime parserで拒否する。

## read-only CLI

CLI requestは1 MiB以下のUTF-8 JSONで、`schemaVersion`、`clipId`、`camera`、`relativePath`の4 keyだけを持つ。`camera`は`back`、相対pathは256文字以下、各segmentは128文字以下の安全な文字集合に限定し、絶対path、空segment、`.`、`..`、backslash、非MP4を拒否する。

入力は`O_NOFOLLOW`で開き、解析前後と結果公開の直前・直後にdescriptorとpathのdevice、inode、size、mtime、ctimeを照合する。出力directoryも結果公開の直前・直後に、保持中のdescriptorと要求pathが同じdevice・inodeを指すことを照合する。出力directoryは空でなければならない。`result.tmp.json`をmode 0600で排他的に作成、fsync後に`result.json`へhard linkして一時名を削除し、既存結果を置換しない。公開したentryはdevice、inode、size、mtime、ctimeとserialized bytesを保持中のdescriptorから再検証する。公開処理中の入力変更、出力directory差し替え、または結果内容変更を検出した場合は、自身が作成した一時結果と最終結果を保持中のdirectory descriptorから削除して失敗する。

これらは結果公開境界のmetadata・content checkpointであり、非協調writerに対するcheckpoint間を含む連続的な不変性を証明しない。productionで強い完全性が必要な場合は、解析入力をimmutable snapshotまたはstorage versionへ固定し、leaseまたは信頼境界でのcontent hash検証を併用する。

stdoutは`status`、`analyzedFrames`、`issues`件数だけのsummaryである。stderrは固定された一般errorだけを返し、入力pathやprocess詳細を含めない。exit codeは成功判定が0、request不正が2、理由付き`indeterminate`が3、処理境界の失敗が5である。

## イベント判定とUI

有効なrepeater直接証拠による`contact`を最優先し、その次に有効なback signalを`possible_contact / back_temporal_impact_signal`へする。back signalだけで`contact`を返さず、`possible_contact`を`no_contact_observed`へ落とさない。不正または利用不能なback証拠は`indeterminate / back_impact_analysis_unavailable`へfail-closedにする。

UIは`possible_contact`を「後方映像で接触の可能性を示す動きを検出しました。映像を確認してください。」と表示する。`App`は任意の`analysisVerdict`を表示できるが、通常のproduction経路がproducer結果を自動投入するbackend orchestrationはまだない。

## 匿名在庫verifier

verifierは`back`と旧`rear_view` filenameだけを対象にし、concurrencyを1から4へ制限する。rootと全directoryのdevice/inode、全MP4のrelative identity、device、inode、size、mtime、modeを解析前後に照合する。実行中に全MP4 inventoryが変化した場合は成功結果を返さない。

各clipは隔離した一時directoryで`python3 -P` CLIへ渡す。PATHはsource外の実体だけへ限定し、環境変数をsanitizedする。1 clipあたり135秒でprocess groupをTERMし、1秒後にKILLする。request/resultは一時directoryだけへ作り、必ず削除する。stdoutは匿名aggregate 1行だけ、成功時stderrは空である。

本番運用で全MP4のcontent hashを解析前後に二重計算することは、62 GB超の入力をさらに2回読むことになり、実測処理時間とI/Oを不必要に増やす。このverifierはmetadataとidentityの不変条件を使う。NASや外部writerが同じinodeの内容を書き換えながらsize/mtimeを復元する脅威までは検出しないため、productionの強い改ざん耐性が必要ならsnapshotまたはstorage側versioningを別途使う。

## プライバシー

実path、filename、撮影時刻、候補時刻、VIN、顔、ナンバー、映像、抽出frameをreport、stdout、stderr、repositoryへ保存しない。通常利用映像を学習へ流用しない。

実在庫結果と制約は[back時系列解析の実在庫レポート](BACK_IMPACT_REAL_DATA_REPORT.md)へ記録する。
