# Model Yカメラ幾何V2の実装メモ

更新：2026-08-06 JST

## 対象

この契約は、2026年1月納車の2025年以降Model Y Long Rangeで記録された6方向のTeslaCam映像を対象にする。

公開プロファイルの識別子は`model-y-2025-plus-long-range-2896x1876-v2`である。

初期プロファイルは全方向でH.264を要求する。

`front`は2896×1876を要求し、残りの5方向は1448×938を要求する。

## カメラの役割

固定幾何を公開する直接カメラは、次の2方向だけである。

- `left_repeater`
- `right_repeater`

文脈カメラは、次の4方向である。

- `front`：接触可能な自車境界を画面内で観測できないため`unobservable`とする。
- `back`：物理的な自車外面は映るが、固定アンカーの再現精度を検証できないため`unvalidated`とする。
- `left_pillar`：接触可能な自車境界を画面内で観測できないため`unobservable`とする。
- `right_pillar`：接触可能な自車境界を画面内で観測できないため`unobservable`とする。

文脈カメラは自車マスク、接触境界、近接帯、死角、固定アンカーを持たない。

文脈カメラの録画が存在しても、その事実だけでは接触候補が直接カメラへ関連付いたことを意味しない。

## 実測根拠

現在の匿名在庫スナップショットは12,902本、433,020,823,067 bytesである。

6方向が揃う完全な時刻群は2,134組である。

この在庫数は実測時点のスナップショットであり、将来の在庫数を固定する契約ではない。

左右repeaterは、校正12群と別のホールドアウト12群で評価した。

各群では10秒、30秒、50秒の3時点を確認し、数値ゲートには3時点のRGB中央値を使った。

群中央値では、左右それぞれ2アンカーの校正12/12群とホールドアウト12/12群が画像対角長の0.01以下だった。ホールドアウトの最大誤差は左が0.006955、右が0.005217だった。

個別時点matcherは、左A、右A、右Bがそれぞれ35/36時点だけ0.01以下で、最大誤差は0.013331、0.013911、0.013331だった。左Bは36/36時点が0.01以下で、最大誤差は0.005217だった。

物理外装面と固定外縁の可視性は初回のローカル目視結果であり、machine-readable artifactから画像内容を再現できない。匿名の群別誤差配列、全288件の時点別誤差観測、再計算可能な集計、選定・正規化・privacy境界は[repeater measurement artifact](../packages/camera-geometry/evidence/model-y-2025-plus-repeater-measurement-v1.json)へ保存する。

校正群とホールドアウト群の分離監査には、単一の認可済み実測runでraw group identityへ適用したHMAC-SHA256 tokenを使った。同じrun内の同じ群は同じtokenになるため交差を検出できる。artifactには監査結果のtoken 24件、重複0件、cohort間交差0件だけを残し、raw token、HMACの一時secret、元データとの対応表は保存しない。この集計は元データへ対応付けできず、別runでは再現できない。

この実測は固定アンカーと自車境界の再現性だけを支え、物体検出や接触分類の精度を示さない。

初期プロファイルはアンカー誤差の許容値を画像対角長の0.01に固定する。

許容値以下のアンカー誤差は、コーデック、解像度、回転、クロップ、6方向の録画構成も一致するときに限りプロファイル適合を支える。

`back`では、物理的な塗装面と車体境界を校正11/12群で観測できた。

ただし、既知の校正集合だけで試した3種類のアンカー抽出器は、2アンカーを3/3時点で許容値以内に安定させた群が8/12から9/12に留まった。

3種類の最大誤差は0.035357から0.053789であり、いずれも許容値0.01を超えた。

この結果は`back`の校正をBLOCKEDとし、未検証の座標をプロファイルへ入れない根拠である。

`front`では校正12/12群と別のホールドアウト12/12群で接触可能な自車体画素を確認できず、別の10群でも同じ結果だった。

左右pillarでも校正集合とホールドアウト集合の双方で接触可能な自車外面を確認できなかった。

## プロファイル適合

型付きのproducerは、6方向の録画descriptorを`matchVehicleCameraProfileV2`へ渡す。

左右repeaterの固定アンカーを観測できない場合は`anchorErrorNormalized: null`を渡し、matcherは`anchor_unavailable`として適合を拒否する。

左右repeaterのアンカー誤差が有限の非負値でない場合、または0.01を超える場合は`anchor_drift`として適合を拒否する。

群中央値の校正結果は、個別観測のアンカー誤差を自動的に合格へしない。上流が個別観測について0.01を超える誤差を生成した場合、runtime matcherは`anchor_drift`としてfail-closedに拒否する。

文脈カメラは固定アンカーを持たないため、`anchorErrorNormalized: null`だけを受理する。

任意のJSONをこの型付き境界へ直接入れる経路は実装していない。

将来の外部JSON ingressにはruntime parserが必要である。

将来のサーバーは、クライアントの判定を信頼せず、録画descriptor、track関連付け、直接カメラの観測範囲、文脈カメラの状態を再検証する必要がある。

## 候補カバレッジ

確定判定には、左右repeaterごとに次の4条件を示す構造化証拠が必要である。

- 最接近前を観測できた。
- 最接近時を観測できた。
- 最接近後を観測できた。
- 最接近時の境界が遮蔽されていない。

4つの文脈カメラは、候補ごとに次のいずれか一つの状態を持つ。

- `no_relevant_track`：そのカメラに関連する候補trackがない。
- `resolved_to_direct`：同一候補として左右repeaterのどちらかへ関連付けられた。
- `unresolved`：直接カメラへ関連付けられない候補trackが残る。

文脈証拠が欠ける場合、重複する場合、または一つでも`unresolved`を含む場合は`indeterminate / insufficient_camera_coverage`になる。

rear-only、front-only、pillar-onlyの候補も、直接カメラへ解決できないため同じ判定になる。

## 四値判定

`contact`は、測定済みrepeater境界への到達と独立した補強証拠が揃う場合だけ返す。

`no_contact_observed`は、プロファイルが適合し、候補trackと6方向のカバレッジが解決済みであり、品質、時刻、遮蔽、死角、競合の各ゲートを通過した場合だけ返す。

`no_contact_observed`が表すのは、解決済み候補について測定済みrepeater境界上で接触所見を検出しなかったという結果である。

この値は「車両全体で接触がなかった」または「損傷がない」という保証ではない。

`possible_contact`は、有効な`back`時系列証拠が接触時に起こり得る急な全画面変位と短時間の反転または復元を示した場合に返す。

これは未検証の後方車体境界への到達を測った結果ではなく、接触、損傷、接触部位、物理距離を確定しない。左右repeaterの直接接触幾何を弱めず、`back`は`context_only / unvalidated`のままである。

有効なrepeater直接証拠による`contact`を`possible_contact`より優先する。back signalだけで`contact`を返さず、`possible_contact`を`no_contact_observed`へ落とさない。

6方向の`camera-temporal-activity-v1`は、固定camera roleごとに短時間の画素差とgradient変化が持続した場合を別の`possible_contact`証拠にする。front、back、左右pillar、左右repeaterのどの方向でもactivity候補を残せるが、この時間変化だけでは`contact`へ昇格しない。

有効な6方向aggregateで1方向でもactivityなら`camera_temporal_activity_signal`を返す。全6方向がno-signalの場合は既存の幾何判定を維持し、no-signalだけから車両全体の非接触を作らない。aggregateがinvalidまたはindeterminateで、既存のcontact/possible-contactがない場合は`camera_activity_analysis_unavailable`へ閉じる。

`indeterminate`は、接触または離隔を決める証拠が不足した場合に理由codeとともに返す。

固定されたカメラ配置は同じ条件での幾何比較を再現しやすくする。

しかし、固定配置は死角、暗所、遮蔽、未対応の車体境界を解消しない。

## 実装済みの範囲

純粋なTypeScriptパッケージとして、次を実装している。

- 2方向の実測済み固定幾何を持つModel YプロファイルV2
- 6方向の録画descriptorと固定アンカーによるプロファイル適合判定
- 左右repeaterのフレーム単位幾何評価
- 構造化された直接カメラ観測と文脈カメラ状態によるカバレッジ検証
- `contact`、`no_contact_observed`、`indeterminate`のイベント単位判定
- `possible_contact`を含む四値のイベント単位判定とruntime parser
- H.264、display/coded size、canonical SPS crop、rotation、duration、fpsを再検証するread-only `back` producer
- 8 fps、160×104 grayscaleのstream解析と固定Schema CLI
- 匿名の全back/rear_view在庫verifierと日本語表示mapping
- 6方向の固定media profile、時間変化producer、read-only aggregate CLI
- PythonとTypeScriptで一致する方向別/aggregate固定Schemaとruntime parser
- 時間変化を接触確定へ使わないadditive event policyと日本語表示mapping
- 文脈カメラを直接幾何評価へ渡した場合のruntime拒否

2026-08-05の実在庫検証ではback/rear_view 2,135件、62,184,707,400 bytesをread-onlyで解析し、1,914件を`no_impact_signal_observed`、221件を理由付き`indeterminate`、0件を`possible_contact`と集計した。正解ラベルがないため、これはprecision、recall、接触検出率ではない。詳細は[back時系列解析の実在庫レポート](BACK_IMPACT_REAL_DATA_REPORT.md)と[解析契約](BACK_IMPACT_ANALYSIS_CONTRACT.md)へ記録する。

## 未実装の範囲

次の処理は実装していない。

- 物体検出
- セグメンテーション
- 物体追跡
- 文脈カメラから直接カメラへの候補関連付け
- raw-videoからの固定アンカー抽出
- 画素距離から物理距離への復元
- producer結果を通常のproduction backendからイベント判定とUIへ自動投入するorchestration
- 正解ラベル付き実動画による接触分類精度の検証

現在の公開関数は、上流が型付きの幾何証拠を正しく生成した後の判定契約である。

`back` V1と6方向raw-video producerは時間変化の可能性証拠を生成できるが、実動画だけを渡して接触有無を確定する機能ではない。

## プライバシー

実測では実映像をローカルで読み取り専用として扱った。

実ファイル名、撮影日時、撮影場所、映像、抽出フレーム、顔、ナンバー、VIN、元データとの対応表、HMACのsaltまたはsecretはリポジトリへ保存しない。
