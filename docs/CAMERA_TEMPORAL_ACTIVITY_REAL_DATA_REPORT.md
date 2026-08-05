# 6方向カメラ時間変化解析の実データ校正レポート

更新：2026-08-06 JST

## 対象と方法

2026年1月納車のModel Y Long Rangeで記録された認可済みローカル映像をread-onlyで使用した。実path、filename、撮影日時、候補timestamp、映像、静止画、顔、ナンバーはrepositoryへ保存していない。

ユーザーが「手がリアカメラ付近まで来る」窓だけを実接触と確認したため、この1窓を正例とした。既に抽出済みの他7窓を比較例として使った。同じsource clipから異なる2窓を含むため、8窓は完全に独立ではない。

各窓を8 fps、160×104 grayscaleへdecodeし、`camera-temporal-activity-v1`の実装を直接実行した。score 0.70以上が4 transition以内に2回以上ある場合をactivityとした。

## 校正窓の結果

| 区分 | 検出 | 分母 |
| --- | ---: | ---: |
| ユーザー確認済み接触窓 | 1 | 1 |
| 比較窓 | 0 | 7 |

接触窓の最大scoreは0.748948、0.70以上のsampleは5件だった。比較窓の最大score上限は0.675331で、7窓すべて0.70以上のsampleは0件だった。

この結果をaccuracy、precision、recall、感度、特異度として扱わない。閾値の選択に同じ1正例と7比較例を使っており、独立blind holdoutがないためである。

## 同時刻6方向の結果

確認済み接触窓と同じ5秒を6方向で同期して測った。

| Camera | 最大score | 0.70以上のsample | Status |
| --- | ---: | ---: | --- |
| front | 0.031550 | 0 | no signal |
| back | 0.765475 | 4 | activity |
| left repeater | 0.007512 | 0 | no signal |
| right repeater | 0.166767 | 0 | no signal |
| left pillar | 0.000000 | 0 | no signal |
| right pillar | 0.624845 | 0 | no signal |

持続条件を満たしたのはback 1/6方向だけだった。これはカメラ近傍の時間変化が接触窓と整合したことを示すが、接触、接触部位、損傷を確定しない。

## 実media profile確認

匿名化した分散sampleでcontainer metadataを再検証した。

- front 24/24本：H.264、display 2896×1876、coded 2896×1888、crop top 0 / bottom 12 / left 0 / right 0
- 他5方向 40/40本：H.264、display 1448×938、coded 1456×944、crop top 0 / bottom 6 / left 0 / right 8
- frontは先頭crop frame 1件ありが23/24、0件が1/24で、全24本に同じ完全SPSがあった
- 他5方向は先頭crop frame 1件ありが37/40、0件が3/40で、全40本に同じ完全SPSがあった

この結果に基づき、0-frame probe shapeは完全SPSがある場合だけ許可する。2-frame、SPS欠落、crop競合、coded/display不一致は拒否する。

## 全長イベントのCLI確認

確認済み接触を含む同一イベントの全長6方向を、固定profile検証とFD identity再検証を含む新CLIへ直接渡した。

- 入力解析：6/6
- aggregate：`activity_detected`
- 方向別activity：2/6
- 方向別indeterminate：0/6
- source size、mtime、mode不変：6/6
- stderr：0 bytes
- exit code：0

全長clipでは確認済み5秒以外の時間に人物、車両、カメラ振動など未ラベルの変化があり得る。したがって、2方向目のactivityを誤検知とは数えない。接触分類の評価には時刻範囲付きの独立ラベルが必要である。

## 解釈の限界

時間変化producerは「当たっているかもしれない」候補を残すための補助証拠である。映像外、遮蔽、暗所、汚れ、圧縮破損、低contrast、短すぎるclipでは判定不能になり得る。no-signalは非接触または無損傷を保証しない。

frontとpillarには直接の自車接触境界を置いていない。backも固定アンカーが未検証である。直接接触の確定は、測定済み左右repeater幾何と独立した補強証拠が揃う場合だけに限定する。
