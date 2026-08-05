# back時系列解析の実在庫レポート

更新：2026-08-05 JST

## 実行条件

- 対象profile：`model-y-2025-plus-long-range-2896x1876-v2`
- Schema version：1
- Analyzer：`back-temporal-impact-v1`
- concurrency：2
- 実行時間：real 3,528.95秒、user 11,515.70秒、system 729.33秒
- stdout：匿名JSON 1行
- stderr：0 bytes

## 在庫境界

preflight artifactの`recognizedMp4Files`という変数名は、filename parserで認識した件数ではなく、探索した全MP4件数を保存していた。preflightでは全MP4が12,810件、back/rear_view対象が2,135件、対象総量が62,184,707,400 bytesだった。

フル実測開始時には全MP4が12,902件になっていた。追加の92件は既知のTesla camera suffixに一致しないMP4であり、back対象ではない。フル実測後の厳密な3回の匿名観測は、いずれも次の値で安定した。

- 全MP4：12,902件、433,020,823,067 bytes
- filename parserで認識したTesla camera MP4：12,810件、432,983,679,914 bytes
- 未認識suffix MP4：92件、37,143,153 bytes
- 6方向：各2,135件
- back/rear_view：2,135件、62,184,707,400 bytes

preflightからフル実測開始までに外部の未認識MP4が92件増えたため、preflightと最終snapshotの全MP4件数は一致しない。この差分を隠さず、back対象件数とbytesが不変であること、フル実測器自身が開始時と終了時の全12,902 MP4およびdirectory/root identityを一致と判定したこと、事後3観測が安定したことを根拠に、back実測結果だけを有効とした。

source配下の一時request/resultは0件、終了後のsource-bound analyzer、FFmpeg、FFprobe processは0件だった。実path、filename、撮影時刻、候補時刻、映像は記録していない。

## 匿名集計

対象2,135件を分母とする。

| 集計 | 件数 | 分母 |
| --- | ---: | ---: |
| readable | 2,135 | 2,135 |
| analyzed | 1,914 | 2,135 |
| `possible_contact` | 0 | 2,135 |
| `no_impact_signal_observed` | 1,914 | 2,135 |
| `indeterminate` | 221 | 2,135 |
| `analysis_failed` | 0 | 2,135 |
| `decode_failed` | 0 | 2,135 |
| `frame_timing_unreliable` | 0 | 2,135 |
| `insufficient_frames` | 0 | 2,135 |
| `low_visibility` | 215 | 2,135 |
| `unsupported_video` | 6 | 2,135 |

verdictの保存則は2,135 / 2,135、`analyzed = possible_contact + no_impact_signal_observed`は1,914 / 1,914で一致した。readableはaggregate契約上、`analysis_failed`と`decode_failed`を含まない件数であり、全件が解析判定まで到達したことを意味しない。

metricは解析判定へ到達した1,914件だけを分母とする。

| Metric | Maximum | Median | p95 | 分母 |
| --- | ---: | ---: | ---: | ---: |
| global motion | 0.30652 | 0 | 0.114948 | 1,914 |
| impulse | 0.30652 | 0 | 0.092026 | 1,914 |
| recovery | 1 | 0 | 0 | 1,914 |

## 解釈の限界

この在庫には独立した接触正解ラベルがない。したがって、0 / 2,135の`possible_contact`は真の接触が0件だったことも、見逃しが0件だったことも示さない。1,914 / 2,135の`no_impact_signal_observed`も非接触または無損傷を保証しない。

この結果は入力互換性、fail-closed件数、処理時間、匿名score分布の実測であり、precision、recall、accuracy、接触検出率ではない。既知の接触正例と近接負例を分離したblind holdoutが用意されるまで、判定精度を主張しない。

## 過去のpre-fix run

修正前の1回は2,135 / 2,135を`unsupported_video`として判定不能にし、解析件数は0だった。原因はすべての対象に存在した構造的に一貫した同一SPS反復を旧parserが拒否したことだった。

修正後は、全6必須fieldで出現回数と値が一致する反復だけを受理し、競合、欠落、malformed入力は引き続き拒否する。FFprobeの省略された空side dataと、canonical SPSおよびstream geometryが一致する0-frame metadata shapeにも対応した。修正前runはdefect診断証拠であり、上の最終分布には混ぜていない。

## Gate

2026-08-05にfresh実行した最終gateは次のとおりである。

- `npm run check`：exit 0
- Vitest：7 workspace合計451 test成功
- Python unittest：73 test成功
- TypeScript typecheck：全workspace成功
- Pyright：0 errors、0 warnings、0 informations
- Biome：105 files検査、fixなし、外部codegraph socketに対するunknown file type warning 1件、exit 0
- Ruff：check成功、17 files format済み
- build：Web、camera geometry、TeslaCam parser、upload contract、upload session、video preflight、Python compileall成功
- `npm run cf:dry-run`：APIとWebの両方がexit 0、deployなし
- `npm run analyzer:container-smoke`：exit 0、`processedClips: 1`、`issues: 0`、`backImpact: "possible_contact"`
- container image：`sha256:c31c3e91015112db2c0151558c5cba078c7ae0304bb3208f4411e49b06ae9791`
- OrbStack：開始前`Stopped`、smokeのため一時起動、終了後`Stopped`へ復元
- `git diff --check`：成功

Cloudflareはdry-runだけであり、本番deploy、R2、D1、Queue、Container resource作成、課金開始は行っていない。
