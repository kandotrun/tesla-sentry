# Event preprocessing contract v1

## 目的

検証済みのTeslaCam動画を1イベント単位でFFmpegへ渡し、後段の固定カメラプロファイル・候補抽出が使う決定論的なメタデータと代表フレームを作る。

この境界は接触判定を行わない。
元動画、入力パス、FFmpegのstderrを結果へ含めない。

## 実行単位

- 1 request = 1イベント
- 1イベントは最大256 clip
- 対応cameraは`front`、`back`、`left_pillar`、`left_repeater`、`right_pillar`、`right_repeater`、`unknown`
- 対応codecはH.264とHEVC
- 1 clipの最大時間は4時間
- 入力videoの幅・高さは各8192 px以下
- request JSONは1 MiB以下
- 生成する代表フレームは各clipにつき1枚

## 入力Schema

```json
{
  "schemaVersion": 1,
  "eventId": "event-001",
  "clips": [
    {
      "clipId": "front-001",
      "camera": "front",
      "capturedAt": "2030-01-01T12:00:00",
      "relativePath": "clips/front.mp4"
    }
  ]
}
```

### 制約

- `eventId`と`clipId`は英数字で始まる128文字以下の安全な識別子に限定する。
- `clipId`と`relativePath`はrequest内で一意にする。
- `capturedAt`はTeslaCam filename由来のevent-local wall timeとして`YYYY-MM-DDTHH:MM:SS`で渡す。
- `relativePath`は入力rootからのPOSIX相対pathに限定する。
- upload境界と同じく、path全体256文字、各segment 128文字、`A-Z a-z 0-9 . _ -`だけを許可する。
- `.mp4`だけを許可し、FFmpeg/FFprobeへMOV demuxerと`file` protocol whitelistを強制する。
- 絶対path、`..`、backslash、入力root外へ解決されるsymlinkを拒否する。
- 入力root外へのescapeは処理開始前にrequest全体を拒否する。
- root内で欠落したclipはrequest全体を捨てず、`input_missing`として結果へ残す。
- manifestが保持した`unknown` cameraも前処理し、後段のprofile選択で`判定不能`または要確認へ残す。
- 代表JPEGと`result.json`は`0600`で保存する。
- output rootは存在しないか空で、symlinkではないjob専用directoryに限定する。既存fileは削除しない。

## 処理

各clipについて次を行う。

1. `ffprobe`でvideo stream、codec、duration、解像度、pixel format、平均frame rate、audio有無を再検証する。
   - codecはH.264/HEVC、各辺は最大8192 px、durationは4時間以下に限定する。
2. 最古の`capturedAt`をイベント時刻0として、clipの`startMs`と`endMs`を計算する。
3. clip中点を代表時刻にする。ただし最終frameより後をseekしないよう、`duration - 1 frame`を上限にする。
4. 縦横比を維持し、upscaleせず、最大幅640 pxのJPEGを生成する。
5. JPEG用に`yuvj420p`へ明示変換し、FFmpeg 5とFFmpeg 8のMJPEG差異を吸収する。
6. 一時frameを検証後に最終pathへrenameする。

FFmpeg/FFprobeはshellを介さずargvで起動し、各commandを60秒でtimeoutする。
subprocessはhostの`FFREPORT`等を継承せず、最小environmentで実行する。

## 出力Schema

`output-root/result.json`へatomic writeする。

```json
{
  "schemaVersion": 1,
  "pipelineVersion": "ffmpeg-event-preprocess-v1",
  "eventId": "event-001",
  "status": "ready",
  "timeline": {
    "durationMs": 59919
  },
  "clips": [
    {
      "clipId": "front-001",
      "camera": "front",
      "capturedAt": "2030-01-01T12:00:00",
      "timeline": {
        "startMs": 0,
        "endMs": 59919
      },
      "probe": {
        "audioPresent": false,
        "averageFrameRate": "36/1",
        "codecName": "h264",
        "durationMs": 59919,
        "height": 1876,
        "pixelFormat": "yuv420p",
        "width": 2896
      },
      "frame": {
        "offsetMs": 29959,
        "relativePath": "frames/000-front-front-001.jpg",
        "width": 640,
        "height": 414
      }
    }
  ],
  "issues": []
}
```

入力の`relativePath`は結果へ返さない。
生成物は固定の`frames/<index>-<camera>-<clipId>.jpg`だけを返す。

## statusとexit code

| status / error | exit code | 意味 |
| --- | ---: | --- |
| `ready` | 0 | 全clipのprobeとframe生成に成功 |
| invalid request | 2 | Schema、path、識別子、入力rootが契約違反 |
| `partial` | 3 | 1本以上成功し、1本以上を理由付きで処理できなかった |
| `failed` | 4 | 処理できたclipが0本 |
| internal / I/O error | 5 | 結果保存または予期しないprocess境界エラー |

`partial`と`failed`でも可能な範囲で`result.json`を保存する。
後段は非zero exitだけで破棄せず、固定Schemaの`status`と`issues`を読む。

## CLI

```bash
PYTHONPATH=containers/analyzer/src python3 -m sentry_analyzer \
  --request /safe/request.json \
  --input-root /safe/input \
  --output-root /safe/output
```

Docker imageはUID/GID `10001:10001`で実行する。
書込volumeはこのUIDから書ける状態にし、入力とrequestはread-only mountにする。
実行時はnetworkなし、read-only root filesystem、capabilityなしを標準とする。

```bash
docker build -t tesla-sentry-analyzer containers/analyzer
npm run analyzer:container-smoke
```

## fail-closedの理由code

現在の主要codeは次のとおり。

- `input_missing`
- `tool_unavailable`
- `media_timeout`
- `probe_failed`
- `invalid_probe`
- `frame_extraction_failed`
- `invalid_frame`

messageは入力pathやFFmpeg stderrを含まない固定の公開文だけを使う。
stdout summaryもstatus、処理clip数、issue数だけとし、`eventId`をlogへ重複出力しない。

## v1に含めないもの

- 車種、年式、カメラ世代の推定
- 車体maskと近接ROI
- 物体検出、tracking、接触候補判定
- 複数clipを連結したpreview動画
- R2からのdownloadと結果upload orchestration
- GPU推論

左右repeaterの2方向直接幾何と4方向の文脈役割を持つ型付きカメラ幾何V2は、前処理v1とは独立した純粋処理として実装済みである。

前処理v1はraw-videoから固定アンカー、物体mask、track、文脈関連付け、構造化カバレッジを生成せず、カメラ幾何V2を呼び出さない。

したがって、前処理v1の出力だけでは接触判定を実行できない。

raw-video producerとpipelineの接続は、前処理v1の外側に残る未実装境界である。
