# Back Possible Contact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Model Yの`back`映像から接触時に起こり得る時系列motionをread-onlyで抽出し、確定接触とは分離した`possible_contact`として固定Schema、CLI、イベント判定、日本語表示、実在庫監査へ接続する。

**Architecture:** Python 3.11とFFmpegで縮小grayscale frameをstream解析し、version付き`BackImpactEvidence` JSONを生成する。純粋TypeScriptのruntime parserがJSONを検証し、既存のrepeater幾何判定を弱めずに`possible_contact`を追加する。Webは判定unionから安全な日本語noticeを表示し、実在庫監査は元映像を変更せず匿名集計だけを出力する。

**Tech Stack:** TypeScript 5、Vitest、React 19、Testing Library、Python 3.11 standard library、unittest、FFmpeg/FFprobe、Node.js test runner、Biome、Ruff、Pyright、Cloudflare Workers dry-run

## 実装結果

Task 1から7を2026-08-05に完了した。atomic implementation commitは次の順序である。

1. Task 1：`593b6a1` `feat: back時系列証拠のSchemaを追加`
2. Task 2：`c0c941a` `feat: backの接触可能性判定を追加`
3. Task 3：`38e8382` `feat: back映像の時系列motion判定を追加`
4. Task 4：`bd5b0ea` `feat: back映像判定のFFmpeg producerを追加`
5. Task 5：`7f4f8d7` `feat: 接触可能性の日本語表示を追加`
6. Task 6：`3bcc528` `feat: back映像の匿名在庫検証を追加`
7. 実映像互換性：`0cecb32` `fix: 実back映像のprobe互換性を追加`

互換性修正後のanalyzer testは73件、SPS/FFprobe互換性testは17件、既存media testは9件、CLI testは8件が成功した。最終のrepository全体gate値は[実在庫レポート](../../BACK_IMPACT_REAL_DATA_REPORT.md)へ記録する。

実在庫runはback/rear_view 2,135件、62,184,707,400 bytesを対象にし、`possible_contact` 0件、`no_impact_signal_observed` 1,914件、`indeterminate` 221件だった。正解ラベルがないため、これはprecision、recall、accuracy、接触検出率ではない。

## Global Constraints

- 対象は2026年1月納車の2025年以降Model Y Long Range、`back`はH.264、display 1448×938、coded 1456×944、canonical SPS pixel crop top 0、bottom 6、left 0、right 8、回転0度に限定する。
- `back`証拠だけで`contact`を返さず、接触部位、損傷、物理距離を推定しない。
- `possible_contact`があるイベントを`no_contact_observed`へ落とさない。
- `no_impact_signal_observed`は非接触または無損傷を保証しない。
- TypeScriptで`any`、二重cast、`@ts-ignore`、`@ts-expect-error`を使用しない。
- 新しいコメントを書かない。
- Reactで新しい`useEffect`を追加しない。
- Python runtime dependencyを追加しない。
- FFmpeg/FFprobeをshell経由で実行せず、`FFREPORT`を継承しない。
- 元動画、抽出frame、候補動画、実path、撮影日時、場所、顔、ナンバー、VINをリポジトリへ保存しない。
- `<PRIVATE_TESLACAM_SOURCE>`はread-onlyで扱い、run内の全MP4 metadata/identityとback対象件数およびbytesを照合する。
- 正解ラベルがない実在庫確認をprecision、recall、接触検出率の評価と表現しない。
- 本番deploy、R2、D1、Queue、Container作成、課金開始を行わない。
- 各taskはRED、GREEN、REFACTORを守り、GREEN後に該当差分をセルフレビューする。

---

### Task 1: BackImpactEvidenceの固定Schemaとruntime parser

**Files:**
- Create: `packages/camera-geometry/src/back-impact-evidence.ts`
- Create: `packages/camera-geometry/tests/back-impact-evidence.test.ts`
- Modify: `packages/camera-geometry/src/types.ts`
- Modify: `packages/camera-geometry/src/index.ts`

**Interfaces:**
- Consumes: 外部processから受け取る`unknown` JSON値。
- Produces: `BackImpactEvidence`、`BackImpactIssue`、`BackImpactMetrics`、`isBackImpactEvidence(value)`、`parseBackImpactEvidence(value)`。

- [x] **Step 1: TypeScript実装規約を読む**

Run:

```bash
sed -n '1,260p' <OMO_PLUGIN_ROOT>/skills/programming/references/typescript/README.md
sed -n '1,320p' <SUPERPOWERS_PLUGIN_ROOT>/skills/test-driven-development/writing-good-tests.md
```

Expected: strict型、境界validation、良いテストの必須規約を確認できる。

- [x] **Step 2: SchemaのREDテストを書く**

`packages/camera-geometry/tests/back-impact-evidence.test.ts`へ、次のfixtureと期待値を書く。

```ts
import { describe, expect, it } from "vitest";
import { isBackImpactEvidence, parseBackImpactEvidence } from "../src/index";

const POSSIBLE = {
  analysisDurationMs: 4_000,
  analyzedFrames: 32,
  analyzerVersion: "back-temporal-impact-v1",
  camera: "back",
  candidateTimestampMs: 2_000,
  clipId: "back-001",
  issues: [],
  metrics: {
    globalMotionScore: 0.72,
    impulseScore: 0.64,
    recoveryScore: 0.59,
  },
  schemaVersion: 1,
  source: "back_temporal_motion",
  status: "possible_contact",
} as const;

describe("parseBackImpactEvidence", () => {
  it("accepts a versioned possible-contact result", () => {
    expect(parseBackImpactEvidence(POSSIBLE)).toEqual(POSSIBLE);
    expect(isBackImpactEvidence(POSSIBLE)).toBe(true);
  });

  it.each([
    { ...POSSIBLE, camera: "front" },
    { ...POSSIBLE, analyzerVersion: "unknown" },
    { ...POSSIBLE, candidateTimestampMs: 4_001 },
    { ...POSSIBLE, analyzedFrames: -1 },
    { ...POSSIBLE, metrics: { ...POSSIBLE.metrics, impulseScore: Number.NaN } },
    { ...POSSIBLE, privatePath: "/private/source.mp4" },
  ])("rejects invalid or expanded payloads", (payload) => {
    expect(isBackImpactEvidence(payload)).toBe(false);
    expect(() => parseBackImpactEvidence(payload)).toThrow(
      new TypeError("invalid back impact evidence"),
    );
  });
});
```

正常系へ`no_impact_signal_observed`と`indeterminate`も追加する。`indeterminate`は`metrics: null`、`candidateTimestampMs: null`、空でない`issues`を要求する。

- [x] **Step 3: REDを確認する**

Run:

```bash
npm test --workspace=@sentry-check/camera-geometry -- tests/back-impact-evidence.test.ts
```

Expected: `parseBackImpactEvidence`がexportされていないためFAILする。

- [x] **Step 4: 型とparserを最小実装する**

`packages/camera-geometry/src/types.ts`へ次のunionを追加する。

```ts
export type BackImpactIssue =
  | "analysis_failed"
  | "decode_failed"
  | "frame_timing_unreliable"
  | "insufficient_frames"
  | "low_visibility"
  | "unsupported_video";

export interface BackImpactMetrics {
  readonly globalMotionScore: number;
  readonly impulseScore: number;
  readonly recoveryScore: number;
}

interface BackImpactEvidenceBase {
  readonly analysisDurationMs: number;
  readonly analyzedFrames: number;
  readonly analyzerVersion: "back-temporal-impact-v1";
  readonly camera: "back";
  readonly clipId: string;
  readonly schemaVersion: 1;
  readonly source: "back_temporal_motion";
}

export type BackImpactEvidence =
  | (BackImpactEvidenceBase & {
      readonly candidateTimestampMs: number;
      readonly issues: readonly [];
      readonly metrics: BackImpactMetrics;
      readonly status: "possible_contact";
    })
  | (BackImpactEvidenceBase & {
      readonly candidateTimestampMs: null;
      readonly issues: readonly [];
      readonly metrics: BackImpactMetrics;
      readonly status: "no_impact_signal_observed";
    })
  | (BackImpactEvidenceBase & {
      readonly candidateTimestampMs: null;
      readonly issues: NonEmpty<BackImpactIssue>;
      readonly metrics: null;
      readonly status: "indeterminate";
    });
```

`packages/camera-geometry/src/back-impact-evidence.ts`では、rootとnested metricsのkey集合を完全一致で検証する。すべてのscoreは有限な0以上1以下、durationとframe数は安全な非負整数、可能性候補時刻は0以上duration以下、`clipId`は`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`に限定する。

```ts
export function parseBackImpactEvidence(value: unknown): BackImpactEvidence {
  if (!isBackImpactEvidence(value)) {
    throw new TypeError("invalid back impact evidence");
  }
  return value;
}
```

`packages/camera-geometry/src/index.ts`から型と2関数をexportする。

- [x] **Step 5: GREENと型検査を確認する**

Run:

```bash
npm test --workspace=@sentry-check/camera-geometry -- tests/back-impact-evidence.test.ts
npm run typecheck --workspace=@sentry-check/camera-geometry
```

Expected: parser testと型検査がPASSする。

- [x] **Step 6: parserのセルフレビューとcommit**

Run:

```bash
git diff --check
git diff -- packages/camera-geometry/src packages/camera-geometry/tests/back-impact-evidence.test.ts
```

Expected: `any`、castによる隠蔽、未知key許容、非有限数許容がなく、差分checkがPASSする。

```bash
git add packages/camera-geometry/src/types.ts packages/camera-geometry/src/back-impact-evidence.ts packages/camera-geometry/src/index.ts packages/camera-geometry/tests/back-impact-evidence.test.ts
git commit --no-gpg-sign -m "feat: back時系列証拠のSchemaを追加"
```

### Task 2: `possible_contact`イベント判定

**Files:**
- Modify: `packages/camera-geometry/src/types.ts`
- Modify: `packages/camera-geometry/src/classify-event.ts`
- Modify: `packages/camera-geometry/tests/fixtures.ts`
- Modify: `packages/camera-geometry/tests/classify-event.test.ts`
- Modify: `packages/camera-geometry/tests/consumer.test.ts`

**Interfaces:**
- Consumes: Task 1の`BackImpactEvidence`と`isBackImpactEvidence`。
- Produces: `ContactEventEvidence.backImpactEvidence`、`ContactVerdict.verdict === "possible_contact"`、理由`back_temporal_impact_signal`。

- [x] **Step 1: 判定優先順位のREDテストを書く**

`packages/camera-geometry/tests/fixtures.ts`へ`backImpactEvidence(status)`を追加し、`makeEventEvidence`の既定値を`no_impact_signal_observed`にする。

```ts
export function backImpactEvidence(
  status: "possible_contact" | "no_impact_signal_observed" = "no_impact_signal_observed",
): BackImpactEvidence {
  const base = {
    analysisDurationMs: 4_000,
    analyzedFrames: 32,
    analyzerVersion: "back-temporal-impact-v1" as const,
    camera: "back" as const,
    clipId: "back-001",
    issues: [] as const,
    schemaVersion: 1 as const,
    source: "back_temporal_motion" as const,
  };
  if (status === "possible_contact") {
    return {
      ...base,
      candidateTimestampMs: 2_000,
      metrics: {
        globalMotionScore: 0.72,
        impulseScore: 0.64,
        recoveryScore: 0.59,
      },
      status,
    };
  }
  return {
    ...base,
    candidateTimestampMs: null,
    metrics: {
      globalMotionScore: 0.08,
      impulseScore: 0.05,
      recoveryScore: 0.04,
    },
    status,
  };
}
```

`packages/camera-geometry/tests/classify-event.test.ts`へ次を追加する。

```ts
it("keeps a rear-only impact signal as possible contact", () => {
  expect(
    classifyContactEvent(
      makeEventEvidence({
        backImpactEvidence: backImpactEvidence("possible_contact"),
        contactCoverage: {
          contextCameraEvidence: [{ camera: "back", state: "unresolved" }],
          directCameraObservations: [],
          kind: "incomplete",
          missingContactCameras: CONTACT_CAMERAS,
        },
        evaluations: [],
      }),
    ),
  ).toEqual({ reasons: ["back_temporal_impact_signal"], verdict: "possible_contact" });
});

it("never promotes a back signal to confirmed contact", () => {
  expect(
    classifyContactEvent(
      makeEventEvidence({
        backImpactEvidence: backImpactEvidence("possible_contact"),
        evaluations: [],
      }),
    ).verdict,
  ).toBe("possible_contact");
});

it("prefers valid repeater contact over a back possibility", () => {
  expect(
    classifyContactEvent(
      makeEventEvidence({
        backImpactEvidence: backImpactEvidence("possible_contact"),
        evaluations: [evaluation("boundary_overlap")],
        trajectoryDiscontinuity: true,
      }),
    ).verdict,
  ).toBe("contact");
});
```

不正なback payloadと`indeterminate` back evidenceが`back_impact_analysis_unavailable`になるtest、`possible_contact`が`no_contact_observed`にならないtest、従来3判定が維持されるtestも追加する。

- [x] **Step 2: REDを確認する**

Run:

```bash
npm test --workspace=@sentry-check/camera-geometry -- tests/classify-event.test.ts tests/consumer.test.ts
```

Expected: `ContactEventEvidence`と`ContactVerdict`が新しい状態を持たないためFAILする。

- [x] **Step 3: 判定unionと分類順序を実装する**

`packages/camera-geometry/src/types.ts`へ必須証拠と理由を追加する。

```ts
export type IndeterminateReason =
  | "back_impact_analysis_unavailable"
  | "boundary_occluded"
  | "conflicting_evidence"
  | "entered_blind_zone"
  | "insufficient_camera_coverage"
  | "insufficient_contact_evidence"
  | "low_visibility"
  | "profile_mismatch"
  | "timing_unreliable"
  | "track_lost";

export interface ContactEventEvidence {
  readonly backImpactEvidence: BackImpactEvidence;
}

export type ContactVerdict =
  | { readonly reasons: readonly []; readonly verdict: "contact" }
  | {
      readonly reasons: readonly ["back_temporal_impact_signal"];
      readonly verdict: "possible_contact";
    }
  | { readonly reasons: readonly []; readonly verdict: "no_contact_observed" }
  | {
      readonly reasons: readonly IndeterminateReason[];
      readonly verdict: "indeterminate";
    };
```

実際の`ContactEventEvidence`へは既存fieldを残し、`backImpactEvidence`だけを追加する。

`classifyContactEvent`は次の順でreturnする。

```ts
if (reasons.length === 0 && hasBoundaryOverlap && hasIndependentReinforcement) {
  return { reasons: [], verdict: "contact" };
}
if (backImpactEvidenceIsValid && evidence.backImpactEvidence.status === "possible_contact") {
  return { reasons: ["back_temporal_impact_signal"], verdict: "possible_contact" };
}
if (reasons.length > 0) {
  return { reasons, verdict: "indeterminate" };
}
return { reasons: [], verdict: "no_contact_observed" };
```

back evidenceが不正または`indeterminate`なら`back_impact_analysis_unavailable`を固定順で追加する。`possible_contact` branchは既存coverage不足より先に置くが、測定済みrepeaterによる有効な`contact`より後に置く。

- [x] **Step 4: GREEN、公開consumer、全camera-geometry testを確認する**

Run:

```bash
npm test --workspace=@sentry-check/camera-geometry
npm run typecheck --workspace=@sentry-check/camera-geometry
npm run build --workspace=@sentry-check/camera-geometry
```

Expected: camera-geometryの全test、型検査、buildがPASSする。

- [x] **Step 5: 判定差分をセルフレビューしてcommit**

Run:

```bash
git diff --check
git diff -- packages/camera-geometry
```

Expected: `back`から`contact`へ直接到達する経路がなく、既存`contact`のquality/profile/coverage gateが維持される。

```bash
git add packages/camera-geometry/src/types.ts packages/camera-geometry/src/classify-event.ts packages/camera-geometry/tests/fixtures.ts packages/camera-geometry/tests/classify-event.test.ts packages/camera-geometry/tests/consumer.test.ts
git commit --no-gpg-sign -m "feat: backの接触可能性判定を追加"
```

### Task 3: Python標準ライブラリの時系列motion core

**Files:**
- Create: `containers/analyzer/src/sentry_analyzer/back_impact.py`
- Create: `containers/analyzer/tests/test_back_impact.py`

**Interfaces:**
- Consumes: `Iterable[GrayFrame]`。各frameは8 fps、160×104、grayscale bytes、単調増加timestampを持つ。
- Produces: `BackImpactResult`と`analyze_back_frames(clip_id, frames)`。`to_dict()`はTask 1と同じcamelCase Schemaを返す。

- [x] **Step 1: 純粋signal判定のREDテストを書く**

`containers/analyzer/tests/test_back_impact.py`に、固定patternを平行移動して作るframe helperを置く。

```py
def pattern_frame(index: int, shift_x: int = 0, shift_y: int = 0, brightness: int = 0) -> GrayFrame:
    pixels = bytearray(FRAME_WIDTH * FRAME_HEIGHT)
    for y in range(FRAME_HEIGHT):
        for x in range(FRAME_WIDTH):
            source_x = x - shift_x
            source_y = y - shift_y
            value = ((source_x // 8 + source_y // 8) % 2) * 120 + 60 + brightness
            pixels[y * FRAME_WIDTH + x] = max(0, min(255, value))
    return GrayFrame(timestamp_ms=index * 125, pixels=bytes(pixels))
```

次の5ケースを独立testにする。

```py
def test_marks_abrupt_translation_and_recovery_as_possible_contact(self) -> None:
    shifts = [0] * 12 + [3, 3, 0] + [0] * 17
    result = analyze_back_frames(
        "back-001",
        tuple(pattern_frame(index, shift_x=shift) for index, shift in enumerate(shifts)),
    )

    self.assertEqual(result.status, "possible_contact")
    self.assertIsNotNone(result.candidate_timestamp_ms)

def test_keeps_static_frames_as_no_impact_signal(self) -> None:
    frames = tuple(pattern_frame(index) for index in range(32))
    self.assertEqual(
        analyze_back_frames("back-001", frames).status,
        "no_impact_signal_observed",
    )
```

残りは滑らかな1方向移動、全画面brightness flash、低contrast、timestamp逆行である。前3つは`possible_contact`にせず、低contrastとtimestamp逆行は理由付き`indeterminate`にする。

- [x] **Step 2: REDを確認する**

Run:

```bash
PYTHONPATH=containers/analyzer/src python3 -m unittest discover -s containers/analyzer/tests -p 'test_back_impact.py' -v
```

Expected: `sentry_analyzer.back_impact`が存在しないためFAILする。

- [x] **Step 3: version付き結果型とsignal計算を実装する**

`back_impact.py`の固定値は次にする。

```py
SCHEMA_VERSION = 1
ANALYZER_VERSION = "back-temporal-impact-v1"
FRAME_WIDTH = 160
FRAME_HEIGHT = 104
SAMPLE_RATE = 8
MAX_SHIFT = 3
MIN_FRAMES = 24
GLOBAL_MOTION_THRESHOLD = 0.45
IMPULSE_THRESHOLD = 0.35
RECOVERY_THRESHOLD = 0.35
MIN_CONTRAST = 12.0
```

型の中心は次にする。

```py
@dataclass(frozen=True, slots=True)
class GrayFrame:
    timestamp_ms: int
    pixels: bytes


@dataclass(frozen=True, slots=True)
class BackImpactMetrics:
    global_motion_score: float
    impulse_score: float
    recovery_score: float


@dataclass(frozen=True, slots=True)
class BackImpactResult:
    analysis_duration_ms: int
    analyzed_frames: int
    candidate_timestamp_ms: int | None
    clip_id: str
    issues: tuple[str, ...]
    metrics: BackImpactMetrics | None
    status: Literal["possible_contact", "no_impact_signal_observed", "indeterminate"]
```

`_estimate_translation(previous, current)`は画像端を除く8 px格子点のhorizontal/vertical gradient差を`dx`、`dy`の-3から3で比較し、最小誤差の変位とzero-shiftからの改善率を返す。frameごとのmotion scoreは変位量、改善率、複数領域の一致率を0から1へ正規化する。

`_motion_metrics(samples)`は直近8 sampleのmedianをbaselineとし、急増量をimpulse scoreにする。候補後1から4 sampleで逆方向変位または累積変位の基準復帰をrecovery scoreにする。最大candidateが3閾値をすべて満たす場合だけ`possible_contact`にする。

`analyze_back_frames`はframe byte長、24 frame以上、timestamp単調増加、frame間隔62から250 ms、sample luminance contrastを検証する。低contrast frameが全体の50%以上なら`low_visibility`、不正intervalなら`frame_timing_unreliable`、frame不足なら`insufficient_frames`を返す。

`to_dict()`はscoreを小数6桁へ丸め、Task 1と同じkeyだけを返す。

- [x] **Step 4: GREEN、Ruff、Pyrightを確認する**

Run:

```bash
PYTHONPATH=containers/analyzer/src python3 -m unittest discover -s containers/analyzer/tests -p 'test_back_impact.py' -v
ruff check containers/analyzer/src/sentry_analyzer/back_impact.py containers/analyzer/tests/test_back_impact.py
ruff format --check containers/analyzer/src/sentry_analyzer/back_impact.py containers/analyzer/tests/test_back_impact.py
pyright --project containers/analyzer/pyproject.toml
```

Expected: signal test、Lint、format、strict型検査がPASSする。

- [x] **Step 5: signal coreをセルフレビューしてcommit**

Run:

```bash
git diff --check
git diff -- containers/analyzer/src/sentry_analyzer/back_impact.py containers/analyzer/tests/test_back_impact.py
```

Expected: frame全体を保持せず、scoreが0から1、smooth motionとbrightness変化が接触疑いにならない。

```bash
git add containers/analyzer/src/sentry_analyzer/back_impact.py containers/analyzer/tests/test_back_impact.py
git commit --no-gpg-sign -m "feat: back映像の時系列motion判定を追加"
```

### Task 4: FFmpeg producerとread-only CLI

**Files:**
- Create: `containers/analyzer/src/sentry_analyzer/back_impact_media.py`
- Create: `containers/analyzer/src/sentry_analyzer/back_impact_cli.py`
- Create: `containers/analyzer/scripts/back_impact_smoke.py`
- Create: `containers/analyzer/tests/test_back_impact_cli.py`
- Modify: `containers/analyzer/pyproject.toml`
- Modify: `containers/analyzer/scripts/container_smoke.py`

**Interfaces:**
- Consumes: 1 MiB以下のrequest JSON、input root、1本の`back`相対MP4 path。
- Produces: `output-root/result.json`、stdoutの匿名summary、exit code 0、2、3、5。

- [x] **Step 1: CLI契約と実FFmpegのREDテストを書く**

requestを次で固定する。

```json
{
  "schemaVersion": 1,
  "clipId": "back-001",
  "camera": "back",
  "relativePath": "clips/back.mp4"
}
```

`test_back_impact_cli.py`に次を実装する。

- `camera: front`、絶対path、`..`、1 MiB超、未知fieldをexit 2で拒否する。
- 入力root外symlinkをmedia実行前に拒否する。
- fake mediaが返すimpact frame列を`possible_contact` JSONへ保存する。
- resultにinput root、relative path、FFmpeg stderrを含めない。
- 実FFmpegで1448×938、8 fps、4秒の静止grid動画を生成し、`no_impact_signal_observed`になる。
- 実FFmpegで2秒時点だけ3 px移動し直後に復元するgrid動画を生成し、`possible_contact`になる。
- 160×90 fixture、HEVC、rotation、crop、90秒超を`unsupported_video`として`indeterminate`にする。
- outputを`0600`でatomic writeし、既存symlinkを追わない。

実動画fixtureはtestのtemporary directoryへFFmpegで生成し、リポジトリへ保存しない。

- [x] **Step 2: REDを確認する**

Run:

```bash
PYTHONPATH=containers/analyzer/src python3 -m unittest discover -s containers/analyzer/tests -p 'test_back_impact_cli.py' -v
```

Expected: CLI moduleとmedia adapterが存在しないためFAILする。

- [x] **Step 3: FFmpeg frame streamを実装する**

`FFmpegBackImpactMedia`は`ffprobe`でcodec、width、height、duration、frame rate、rotation、cropを取得する。対応入力はH.264、1448×938、0度、cropなし、3秒以上90秒以下、frame rate 1以上120以下に限定する。

FFmpeg argvは次のfilterと出力を使う。

```py
[
    ffmpeg_binary,
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-protocol_whitelist",
    "file",
    "-f",
    "mov",
    "-i",
    str(input_path),
    "-map",
    "0:v:0",
    "-vf",
    "fps=8,scale=160:104:flags=area,format=gray",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "pipe:1",
]
```

`subprocess.Popen`、`selectors.DefaultSelector`、`time.monotonic()`を使い、160×104 bytesずつ読み取って`GrayFrame`をyieldする。120秒deadline超過時はprocessをterminateし、続いてkillする。environmentは`LANG`、`LC_ALL`、`PATH`だけにする。

- [x] **Step 4: CLI境界とatomic resultを実装する**

Run surfaceは次に固定する。

```bash
PYTHONPATH=containers/analyzer/src python3 -m sentry_analyzer.back_impact_cli \
  --request /safe/request.json \
  --input-root /safe/input \
  --output-root /safe/output
```

`back_impact_cli.py`は`preprocess.py`と同じidentifier、relative path、input-root escape、empty output root、`O_NOFOLLOW`、`0600`、temporary rename規約を適用する。成功summaryは次だけをstdoutへ出す。

```json
{"status":"possible_contact","analyzedFrames":32,"issues":0}
```

exit codeは`possible_contact`と`no_impact_signal_observed`が0、`indeterminate`が3、invalid requestが2、I/Oまたは予期しないprocess failureが5とする。

`scripts/back_impact_smoke.py`はtemporary directoryへ静止grid動画と急変復元grid動画をFFmpegで生成し、CLIをそれぞれ実行する。両方のresultにpathがないこと、静止が`no_impact_signal_observed`、急変復元が`possible_contact`であることをassertし、次の匿名summaryだけを出す。

```json
{"noImpact":"no_impact_signal_observed","impact":"possible_contact"}
```

`container_smoke.py`は既存preprocess smokeを維持したうえで、同じimageを`--entrypoint python`と`-m sentry_analyzer.back_impact_cli`で実行する2本目のsmokeを追加する。inputをreadonly mount、outputだけを書込mountにし、networkなし、read-only root filesystem、capabilityなしで`possible_contact` resultのmodeと匿名性を検証する。

- [x] **Step 5: GREEN、Container smoke、静的検査を確認する**

Run:

```bash
npm run analyzer:test
npm run analyzer:typecheck
npm run analyzer:lint
npm run analyzer:build
PYTHONPATH=containers/analyzer/src python3 containers/analyzer/scripts/back_impact_smoke.py
npm run analyzer:container-smoke
```

Expected: Python全test、Pyright、Ruff、compileall、networkなし/read-only container smokeがPASSする。

- [x] **Step 6: producerをセルフレビューしてcommit**

Run:

```bash
git diff --check
git diff -- containers/analyzer
```

Expected: shell実行、source書込、path漏えい、未処理process、全frame蓄積がない。

```bash
git add containers/analyzer/src/sentry_analyzer/back_impact_media.py containers/analyzer/src/sentry_analyzer/back_impact_cli.py containers/analyzer/scripts/back_impact_smoke.py containers/analyzer/tests/test_back_impact_cli.py containers/analyzer/pyproject.toml containers/analyzer/scripts/container_smoke.py
git commit --no-gpg-sign -m "feat: back映像判定のFFmpeg producerを追加"
```

### Task 5: 安全な日本語結果表示

**Files:**
- Create: `apps/web/src/ContactVerdictPanel.tsx`
- Create: `apps/web/src/ContactVerdictPanel.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `@sentry-check/camera-geometry`の`ContactVerdict`。
- Produces: `<ContactVerdictPanel verdict={verdict} />`と4判定の固定日本語copy。

- [x] **Step 1: UI copyのREDテストを書く**

`ContactVerdictPanel.test.tsx`へ次を追加する。

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContactVerdictPanel } from "./ContactVerdictPanel";

describe("ContactVerdictPanel", () => {
  it("asks for video review without claiming confirmed contact", () => {
    render(
      <ContactVerdictPanel
        verdict={{
          reasons: ["back_temporal_impact_signal"],
          verdict: "possible_contact",
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "接触の可能性があります" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("後方映像で接触の可能性を示す動きを検出しました。映像を確認してください。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("接触しました")).not.toBeInTheDocument();
    expect(screen.queryByText("損傷があります")).not.toBeInTheDocument();
  });
});
```

`contact`、`no_contact_observed`、`indeterminate`も固定copyでtestする。`no_contact_observed`は「映像上、接触を示す所見は検出されませんでした」とし、「接触していません」を使わない。

`App.test.tsx`ではTeslaCam folderを選択した状態へ`analysisVerdict`を渡し、manifestの上に同じ`possible_contact` noticeが表示されることを確認する。通常の`renderApp()`では判定panelが存在しないことも固定する。

- [x] **Step 2: REDを確認する**

Run:

```bash
npm test --workspace=@sentry-check/web -- ContactVerdictPanel.test.tsx
```

Expected: componentが存在しないためFAILする。

- [x] **Step 3: 純粋componentとApp接続口を実装する**

`ContactVerdictPanel`はswitchの各branchで見出し、本文、modifier classを決定し、`aria-live="polite"`を持つsectionを返す。`possible_contact`はwarning色、`contact`はalert色、`no_contact_observed`はneutral色、`indeterminate`はreview色にする。

`AppProps`へ次のoptional inputを追加し、値がある場合だけ`ManifestPanel`の上部に表示する。

```ts
interface AppProps {
  readonly analysisVerdict?: ContactVerdict | null;
  readonly probeVideoFile?: ClipPreflightProbe;
}
```

実際のanalysis resultがない通常画面ではpanelを表示せず、固定demo verdictを埋め込まない。新しいstateと`useEffect`は追加しない。

`apps/web/package.json`へ`@sentry-check/camera-geometry: "*"`を追加し、lockfileを通常の`npm install --package-lock-only`で更新する。

- [x] **Step 4: GREEN、型検査、buildを確認する**

Run:

```bash
npm test --workspace=@sentry-check/web -- ContactVerdictPanel.test.tsx App.test.tsx
npm run typecheck --workspace=@sentry-check/web
npm run build --workspace=@sentry-check/web
```

Expected: UI test、既存App test、型検査、Vite buildがPASSする。

- [x] **Step 5: UI差分をセルフレビューしてcommit**

Run:

```bash
git diff --check
git diff -- apps/web package-lock.json
```

Expected: `possible_contact`を断定表現へ変換せず、通常画面へfake resultを表示しない。

```bash
git add apps/web/src/ContactVerdictPanel.tsx apps/web/src/ContactVerdictPanel.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/styles.css apps/web/package.json package-lock.json
git commit --no-gpg-sign -m "feat: 接触可能性の日本語表示を追加"
```

### Task 6: back実在庫の匿名read-only verifier

**Files:**
- Create: `scripts/lib/back-impact-inventory.mjs`
- Create: `scripts/verify-back-impact-inventory.mjs`
- Create: `scripts/verify-back-impact-inventory.test.mjs`
- Modify: `scripts/lib/camera-geometry-inventory-input.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `SENTRY_SOURCE_DIR`、認識済み`-back.mp4`と`-rear_view.mp4`、Task 4のCLI。
- Produces: pathと撮影識別子を含まない1個のJSON集計、`sourceUnchanged: true`。

- [x] **Step 1: 匿名集計とsource不変条件のREDテストを書く**

`parseRecognizedFilename`をnamed exportにする前提で、temporary sourceにfront、back、rear_view、unknownを作る。

```js
test("analyzes only recognized back roles and returns anonymous counts", async () => {
  const result = await verifyBackImpactInventory({
    analyze: async (file) =>
      file.filePath.endsWith("rear_view.mp4")
        ? possibleResult
        : noImpactResult,
    concurrency: 2,
    sourceDir,
  });

  assert.equal(result.inventory.targetBackFiles, 2);
  assert.equal(result.verdicts.possibleContact, 1);
  assert.equal(result.verdicts.noImpactSignalObserved, 1);
  assert.equal(result.sourceUnchanged, true);
  assert.doesNotMatch(JSON.stringify(result), /private-event|back\.mp4|rear_view\.mp4/);
});
```

追加testでconcurrency 1から4以外を拒否し、analyzer失敗で`verdicts.indeterminate`と`issueCounts.analysis_failed`を増やし、進捗callbackへ件数だけを渡し、実行前後のcontents、size、mtime、modeが同一であることを確認する。

- [x] **Step 2: REDを確認する**

Run:

```bash
node --test scripts/verify-back-impact-inventory.test.mjs
```

Expected: verifier moduleが存在しないためFAILする。

- [x] **Step 3: back選別、bounded concurrency、匿名集計を実装する**

`discoverMp4Files`の戻り値へ`mtimeMs`と`mode`を追加し、`parseRecognizedFilename`をexportする。

`verifyBackImpactInventory`は全MP4のsnapshotをmemory上だけに保持し、`parsed?.camera === "back"`のfileだけを最大4並列で解析する。解析後に同じ全MP4を再発見し、path、size、mtimeMs、modeの完全一致を確認する。不一致なら結果を返さず`source_inventory_changed`をthrowする。

匿名結果を次の形に固定する。

```js
{
  analyzerVersion: "back-temporal-impact-v1",
  inventory: {
    analyzedBackFiles: 2,
    readableBackFiles: 2,
    targetBackFiles: 2,
    totalBytes: 1234,
  },
  issueCounts: {
    analysis_failed: 0,
    decode_failed: 0,
    frame_timing_unreliable: 0,
    insufficient_frames: 0,
    low_visibility: 0,
    unsupported_video: 0,
  },
  scoreDistribution: {
    globalMotion: { maximum: 0.72, median: 0.4, p95: 0.72 },
    impulse: { maximum: 0.64, median: 0.35, p95: 0.64 },
    recovery: { maximum: 0.59, median: 0.31, p95: 0.59 },
  },
  sourceUnchanged: true,
  verdicts: {
    indeterminate: 0,
    noImpactSignalObserved: 1,
    possibleContact: 1,
  },
}
```

score分布は有限scoreだけから決定論的に計算し、対象0件では各集計を`null`にする。処理時間は実行時reportへ別記し、決定論的JSON testのfieldに含めない。

`targetBackFiles`は認識済みback roleの全件、`analyzedBackFiles`は`possible_contact`と`no_impact_signal_observed`の合計、`readableBackFiles`は`analysis_failed`と`decode_failed`を除いた件数とする。3 verdictの合計が`targetBackFiles`と一致しない結果を返さない。

- [x] **Step 4: Task 4 CLI adapterを実装する**

default analyzerはfileごとにtemporary request/output directoryを作り、`python3 -m sentry_analyzer.back_impact_cli`を`execFile`で呼ぶ。`PYTHONPATH`はrepository内`containers/analyzer/src`へ固定し、`FFREPORT`を削除する。requestの`clipId`は常に`inventory-back`とし、stdout/stderrへrelative pathを出さない。temporary directoryは成功と失敗の両方で削除する。

root `package.json`へ次を追加する。

```json
{
  "test:back-impact-inventory": "node --test scripts/verify-back-impact-inventory.test.mjs",
  "verify:back-impact-inventory": "node scripts/verify-back-impact-inventory.mjs"
}
```

root `test`は`test:back-impact-inventory`も実行する。

- [x] **Step 5: GREENと既存在庫testを確認する**

Run:

```bash
npm run test:back-impact-inventory
npm run test:camera-inventory
npm run lint
```

Expected: 新旧inventory testとBiome/RuffがPASSする。

- [x] **Step 6: verifierをセルフレビューしてcommit**

Run:

```bash
git diff --check
git diff -- scripts package.json
```

Expected: JSONとerrorへpath、filename、撮影時刻が出ず、source変更時に成功結果を返さない。

```bash
git add scripts/lib/back-impact-inventory.mjs scripts/verify-back-impact-inventory.mjs scripts/verify-back-impact-inventory.test.mjs scripts/lib/camera-geometry-inventory-input.mjs package.json
git commit --no-gpg-sign -m "feat: back映像の匿名在庫検証を追加"
```

### Task 7: 契約文書、全検証、実在庫Manual QA

**Files:**
- Create: `docs/BACK_IMPACT_ANALYSIS_CONTRACT.md`
- Create: `docs/BACK_IMPACT_REAL_DATA_REPORT.md`
- Modify: `docs/CAMERA_GEOMETRY_NOTES.md`
- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `docs/superpowers/specs/2026-08-05-back-possible-contact-design.md`
- Modify: `docs/superpowers/plans/2026-08-05-back-possible-contact.md`

**Interfaces:**
- Consumes: Task 1から6の公開Schema、CLI、UI copy、inventory verifier。
- Produces: 実装済み境界と匿名全件結果を再現可能に記録した文書、全gateの成功証拠。

- [x] **Step 1: 契約文書を実装に合わせて書く**

`BACK_IMPACT_ANALYSIS_CONTRACT.md`へ入力条件、Schema 1、analyzer version、3状態、issue code、score範囲、CLI、exit code、privacy、非保証範囲を書く。

`CAMERA_GEOMETRY_NOTES.md`の三値表現を四値へ更新し、`back`は直接幾何を持たないまま時系列possible evidenceだけを生成すると明記する。

`PROJECT_CONTEXT.md`の実装済み境界へproducer、parser、`possible_contact`、日本語mappingを追加する。

specの状態を`実装済み、実在庫検証済み`へ、planのcheckboxを完了済みへ更新する。

- [x] **Step 2: 合成動画でCLIのmatching surfaceを確認する**

Task 4のsmoke scriptでtemporary directoryに静止動画と急変復元動画を作り、CLIを直接実行する。

Run:

```bash
PYTHONPATH=containers/analyzer/src python3 containers/analyzer/scripts/back_impact_smoke.py
```

Expected: 静止動画は`no_impact_signal_observed`、急変復元動画は`possible_contact`、どちらのJSONにもinput pathがない。

- [x] **Step 3: NAS全back映像をread-onlyで実行する**

Run:

```bash
SENTRY_SOURCE_DIR=<PRIVATE_TESLACAM_SOURCE> \
SENTRY_BACK_IMPACT_CONCURRENCY=2 \
npm run verify:back-impact-inventory
```

Expected: 認識済み`back`と`rear_view`全件が`possible_contact`、`no_impact_signal_observed`、`indeterminate`のどれかへ数えられ、`sourceUnchanged`が`true`になる。

stdoutの匿名JSONとwall-clock処理時間から`BACK_IMPACT_REAL_DATA_REPORT.md`へ対象数、読取数、解析数、各状態数、issue別件数、score分布、version、処理時間を書く。実path、filename、撮影時刻、候補時刻、映像を記録しない。

- [x] **Step 4: 全test、型検査、Lint、build、Cloudflare dry-runを実行する**

Run:

```bash
npm run check
npm run cf:dry-run
npm run analyzer:container-smoke
```

Expected: 全workspace test、camera inventory、back inventory、Python unittest、TypeScript/Pyright、Biome/Ruff、全build、API/Web Cloudflare dry-run、container smokeがexit 0になる。

- [x] **Step 5: 最終セルフレビューとprivacy監査を行う**

Run:

```bash
git diff --check
git status --short
rg -n '<PRIVATE_TESLACAM_SOURCE>|SentryClips/[0-9]|-[0-9]{2}-[0-9]{2}-[0-9]{2}-(back|rear_view)\.mp4' docs packages containers scripts apps
rg -n '\bany\b|@ts-ignore|@ts-expect-error' packages/camera-geometry/src apps/web/src
```

Expected: 許可した契約上のsource root表記以外に実path、実filename、撮影時刻がなく、新しい`any`や型抑制がない。全差分を読み、未使用field、重複validation、未処理Promise/process、断定表現を修正する。

- [x] **Step 6: 文書と実在庫証拠をcommitする**

```bash
git add docs/BACK_IMPACT_ANALYSIS_CONTRACT.md docs/BACK_IMPACT_REAL_DATA_REPORT.md docs/CAMERA_GEOMETRY_NOTES.md docs/PROJECT_CONTEXT.md docs/superpowers/specs/2026-08-05-back-possible-contact-design.md docs/superpowers/plans/2026-08-05-back-possible-contact.md
git commit --no-gpg-sign -m "docs: back接触可能性の実測結果を追加"
```

- [x] **Step 7: exact SHAとclean stateを記録する**

Run:

```bash
git rev-parse HEAD
git status --short --branch
git log -7 --oneline
```

Expected: exact full SHAを取得し、worktreeがcleanで、7 taskのatomic commitが順序どおり並ぶ。
