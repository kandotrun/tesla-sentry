# アップロード可否契約 v1

更新：2026-08-03 JST

## 位置づけ

**アップロード可否契約 v1**は、`TeslaCamManifest`とMP4事前検査recordから、次段階へ渡せるclipをローカルで決定論的に分類する契約である。
出力は`schemaVersion: 1`で固定し、各clipを`eligible`、`pending`、`blocked`のいずれかにする。

`eligible`は将来のアップロード候補を表すだけであり、現在の実装は動画、manifest、事前検査結果を外部送信しない。
この契約の評価中にネットワーク通信は発生しない。

## 入力

入力は次の二つである。

- `TeslaCamManifest`
- fingerprintと`VideoPreflightResult`を持つ事前検査record列

契約へ入るのはmanifestの`events[].clips[]`だけである。
manifest parserが除外した`RecentClips`、`SavedClips`、unsafe path、Tesla生成の補助プレビュー`event.mp4`は契約へ入らない。
manifestに存在しないfingerprintの事前検査recordも無視する。

fingerprintはmanifestと事前検査recordをローカルで結合するキーである。
現在の`path:size:mtime`形式は暗号学的ハッシュではなく、ファイルの同一性、内容の完全性、改ざん耐性を保証しない。

## 出力

出力の論理Schemaは次のとおりである。

```ts
type UploadIneligibilityReason =
  | Exclude<VideoPreflightCode, "ready">
  | "missing_preflight"
  | "duplicate_fingerprint"
  | "duplicate_preflight";

interface UploadPreflightRecordV1 {
  readonly fingerprint: string;
  readonly result: VideoPreflightResult;
}

interface UploadPlanV1 {
  readonly schemaVersion: 1;
  readonly items: readonly UploadPlanItemV1[];
  readonly totals: {
    readonly sourceClips: number;
    readonly eligibleClips: number;
    readonly eligibleBytes: number;
    readonly eligibleDurationSeconds: number;
    readonly pendingClips: number;
    readonly blockedClips: number;
  };
}

interface UploadPlanItemV1 {
  readonly eventId: string;
  readonly fingerprint: string;
  readonly name: string;
  readonly relativePath: string;
  readonly size: number;
  readonly camera: TeslaCamera;
  readonly capturedAt: string | null;
  readonly status: "eligible" | "pending" | "blocked";
  readonly ineligibilityReason: UploadIneligibilityReason | null;
  readonly preflight: VideoPreflightResult | null;
  readonly warningCodes: readonly ManifestWarning["code"][];
}
```

生成関数は`buildUploadPlanV1(manifest, records)`であり、入力に応じた`UploadPlanV1`を返す。

各statusの意味は次のとおりである。

- **`eligible`**：一意で整合した`ready` recordがあり、次段階の候補にできる。
- **`pending`**：事前検査recordがまだなく、`missing_preflight`として保留する。
- **`blocked`**：重複、非`ready`、または`ready`宣言とmetadataの不整合があり、自動処理へ渡さない。

## 判定順

manifestのevent順、その中のclip順に一度だけ走査し、各clipへ次の優先順位を適用する。

1. 同じfingerprintがmanifestですでに現れていれば、後の出現を`status: blocked`、`ineligibilityReason: duplicate_fingerprint`にする。
2. 最初のmanifest出現に対して同じfingerprintの事前検査recordが複数あれば、`status: blocked`、`ineligibilityReason: duplicate_preflight`にする。
3. 対応する事前検査recordがなければ、`status: pending`、`ineligibilityReason: missing_preflight`にする。
4. 事前検査codeが`ready`以外なら、`status: blocked`にし、そのcodeを`ineligibilityReason`として保持する。
5. codeが`ready`でもmetadataが`ready`の条件と矛盾すれば、既存の事前検査codeへ再分類して`status: blocked`にする。
6. 一意で整合した`ready`だけを`eligible`にする。

`ready`宣言の再検証では、codec欠落を`missing_video_track`、暗号化を`encrypted`、非対応codecを`unsupported_codec`として扱う。
動画時間または解像度が有限の正数でない場合と、走査byte数が有限の非負数でない場合は`metadata_not_found`として扱う。
この再検証は、矛盾した入力を`eligible`へ通さないためのfail-closed処理である。

## 順序とwarning

`items`の順序はmanifestのevent順、その中のclip順をそのまま保持する。
事前検査の完了順やrecord列の順序は出力順へ影響しない。
入力配列と入力objectは変更しない。

manifest warningは`relativePath`が完全一致するitemへcodeだけを引き継ぎ、重複を除いて次の固定順に並べる。

1. `empty_file`
2. `unknown_camera`
3. `unknown_scope`
4. `unrecognized_filename`
5. `unsafe_path`

warningは注記であり、単独ではstatusを変更しない。
通常、`unsafe_path`と`unknown_scope`はmanifest生成時に除外されるため、itemのwarningには現れない。
未知cameraや未認識filenameのwarningがあっても、一意で整合した`ready`なら`eligible`にする。

## 集計

`sourceClips`はmanifestから契約へ入ったitem数である。
`eligibleClips`、`eligibleBytes`、`eligibleDurationSeconds`には`eligible`だけを加算する。
`pending`と`blocked`の容量や動画時間をアップロード候補の集計へ混ぜない。
`pendingClips`と`blockedClips`は状態表示用の件数である。

## 信頼境界

このブラウザ契約はサーバーのtrust boundaryではない。
将来のサーバーは、クライアントが`eligible`と申告しても、認可、受信サイズ、暗号学的ハッシュ、コンテナ内容を再検証する必要がある。
`name`、`relativePath`、`capturedAt`、fingerprintを含むクライアント由来のmetadataも、未信頼入力として検証する。
暗号学的ハッシュは、サーバーが受信した内容から計算して照合する。
ブラウザの判定や`path:size:mtime` fingerprintを、サーバー側の認可や完全性検証の代わりにしてはならない。

## v1に含めないもの

次の機能はv1の対象外である。

- R2保存とR2 resource作成
- 署名URL
- multipart uploadと中断再開
- 認証と認可
- FFmpeg前処理
- 候補抽出とAI判定
- 課金

次段階の開発用単一PUTとサーバー側再検証はPR5で実装した。R2への直接multipart、中断再開、重複スキップは本番化前の別境界とする。
