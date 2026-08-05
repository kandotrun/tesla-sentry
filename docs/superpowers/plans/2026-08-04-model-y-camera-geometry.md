# Model Y Camera Geometry Implementation Plan

> **履歴資料：** この計画のV1にある6方向直接幾何は、pillar、front、backの後続測定によって置き換えられた。
> 本文とchecklistは当時の歴史的仮説であり、現在の実行対象ではない。
> 現在の実装は[2方向直接幾何の完了計画](2026-08-04-model-y-camera-geometry-v2-two-direct.md)へ進む。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2025年以降のModel Y Long Range向けに、実測した固定カメラ幾何からフレーム状態と接触の三値判定を返す純粋なTypeScriptパッケージを実装する。

**Architecture:** `packages/camera-geometry`を新設し、プロファイル契約、録画構成の適合判定、多角形演算、フレーム評価、イベント判定を依存方向に沿って分割する。実映像はローカル校正にだけ使用し、リポジトリには正規化座標、匿名集計、合成テストだけを保存する。VLM、FFmpeg、React、Cloudflareはこのパッケージへ入れない。

**Tech Stack:** TypeScript 7、Vitest 4、Biome 2、npm workspaces、Node.js 24.18.1

## Global Constraints

- 対象プロファイルIDは`model-y-2025-plus-long-range-2896x1876-v1`とする。
- 必須カメラは`front`、`back`、`left_pillar`、`right_pillar`、`left_repeater`、`right_repeater`の6方向とする。
- `front`は2896×1876、残り5方向は1448×938、コーデックは全方向H.264とする。
- プロファイル適合時の固定アンカー誤差は画像対角長の1%以内とする。
- 判定値は`contact`、`no_contact_observed`、`indeterminate`の三値だけとする。
- `contact`は境界到達に加えて独立した補強証拠を一つ以上必要とする。
- `no_contact_observed`は完全追跡、必要カメラ、非遮蔽、非死角、十分な画質、信頼できる同期をすべて必要とする。
- 実映像、抽出画像、実ファイル名、撮影日時、撮影場所、VIN、所有者情報をコミットしない。
- TypeScriptで`any`、二重キャスト、非null assertion、`@ts-ignore`、`@ts-expect-error`を使わない。
- ソースコードへコメントを書かない。
- 各変更はRED、GREEN、REFACTORの順で実装する。
- 一つのソースファイルを純粋コード250行以内に保つ。

---

## File Map

- `packages/camera-geometry/package.json`：workspace、依存、検証script
- `packages/camera-geometry/tsconfig.json`：テストを含む型検査
- `packages/camera-geometry/tsconfig.build.json`：`src`だけを`dist`へ出力
- `packages/camera-geometry/vitest.config.ts`：Node環境のテスト設定
- `packages/camera-geometry/src/types.ts`：公開データ契約と固定code
- `packages/camera-geometry/src/validate-profile.ts`：内部プロファイルの不変条件検査
- `packages/camera-geometry/src/match-profile.ts`：録画構成とプロファイルの適合判定
- `packages/camera-geometry/src/polygon.ts`：正規化多角形と線分の純粋演算
- `packages/camera-geometry/src/evaluate-frame.ts`：1フレームの幾何状態評価
- `packages/camera-geometry/src/classify-event.ts`：イベント証拠の三値判定
- `packages/camera-geometry/src/model-y-2025-plus.ts`：匿名化した初期Model Yプロファイル
- `packages/camera-geometry/src/index.ts`：名前付き公開export
- `packages/camera-geometry/tests/fixtures.ts`：合成プロファイルと合成多角形
- `packages/camera-geometry/tests/validate-profile.test.ts`：プロファイル不変条件
- `packages/camera-geometry/tests/match-profile.test.ts`：録画構成の適合契約
- `packages/camera-geometry/tests/evaluate-frame.test.ts`：フレーム幾何状態
- `packages/camera-geometry/tests/classify-event.test.ts`：三値判定と理由code
- `packages/camera-geometry/tests/model-y-profile.test.ts`：実測プロファイルの匿名回帰
- `packages/camera-geometry/tests/consumer.test.ts`：公開APIだけを使うconsumer smoke
- `package-lock.json`：新workspaceとローカル依存を固定
- `docs/PROJECT_CONTEXT.md`：実装済み境界と次の解析境界
- `docs/CAMERA_GEOMETRY_NOTES.md`：実測条件、非保証範囲、判定契約

---

### Task 1: Package Contract and Profile Validation

**Files:**
- Create: `packages/camera-geometry/package.json`
- Create: `packages/camera-geometry/tsconfig.json`
- Create: `packages/camera-geometry/tsconfig.build.json`
- Create: `packages/camera-geometry/vitest.config.ts`
- Create: `packages/camera-geometry/src/types.ts`
- Create: `packages/camera-geometry/src/validate-profile.ts`
- Create: `packages/camera-geometry/src/index.ts`
- Create: `packages/camera-geometry/tests/fixtures.ts`
- Create: `packages/camera-geometry/tests/validate-profile.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `KnownTeslaCamera` from `@sentry-check/teslacam-parser`
- Produces: `VehicleCameraProfileV1`, `CameraGeometryProfileV1`, `NormalizedPoint`, `NormalizedPolygon`, `validateVehicleCameraProfileV1(profile)`

- [ ] **Step 1: Select the required Node.js runtime**

Run:

```bash
mise install node@24.18.1
mise x node@24.18.1 -- node --version
```

Expected: the second command prints `v24.18.1`.

- [ ] **Step 2: Scaffold the workspace without production behavior**

Create package configuration matching `packages/teslacam-parser` and add this dependency:

```json
{
  "dependencies": {
    "@sentry-check/teslacam-parser": "*"
  }
}
```

Create an empty `src/index.ts`, then update the lockfile and install deterministically:

```bash
mise x node@24.18.1 -- npm install --package-lock-only --ignore-scripts
mise x node@24.18.1 -- npm ci
```

Expected: `package-lock.json` contains `node_modules/@sentry-check/camera-geometry` and `packages/camera-geometry`.

- [ ] **Step 3: Write the failing profile-validation tests**

Define a six-camera synthetic fixture in `tests/fixtures.ts` and add these tests:

```ts
import type { KnownTeslaCamera } from "@sentry-check/teslacam-parser";
import type {
  CameraGeometryProfileV1,
  NormalizedPoint,
  NormalizedPolygon,
  VehicleCameraProfileV1,
} from "../src/types";

export const KNOWN_CAMERAS = [
  "front",
  "back",
  "left_pillar",
  "right_pillar",
  "left_repeater",
  "right_repeater",
] as const satisfies readonly KnownTeslaCamera[];

export function point(x: number, y: number): NormalizedPoint {
  return { x, y };
}

export function polygon(...points: readonly NormalizedPoint[]): NormalizedPolygon {
  return points;
}

type CameraOverrides = Partial<Omit<CameraGeometryProfileV1, "camera">>;

export function makeCamera(
  camera: KnownTeslaCamera,
  overrides: CameraOverrides = {},
): CameraGeometryProfileV1 {
  const body = polygon(point(0.4, 0.4), point(0.6, 0.4), point(0.6, 0.6), point(0.4, 0.6));
  return {
    anchors: [point(0.4, 0.4), point(0.6, 0.6)],
    blindZones: [polygon(point(0.8, 0.8), point(0.95, 0.8), point(0.95, 0.95))],
    camera,
    codec: "h264",
    contactBoundary: [
      { from: point(0.4, 0.4), to: point(0.6, 0.4) },
      { from: point(0.6, 0.4), to: point(0.6, 0.6) },
    ],
    height: camera === "front" ? 1876 : 938,
    nearBodyZones: [polygon(point(0.3, 0.3), point(0.7, 0.3), point(0.7, 0.7), point(0.3, 0.7))],
    occlusionThreshold: 0.05,
    pairedCameras: [],
    selfVehicleMasks: [body],
    width: camera === "front" ? 2896 : 1448,
    ...overrides,
  };
}

interface ProfileOverrides {
  readonly cameras?: readonly CameraGeometryProfileV1[];
}

export function makeProfile(overrides: ProfileOverrides = {}): VehicleCameraProfileV1 {
  return {
    anchorToleranceNormalized: 0.01,
    cameras: overrides.cameras ?? KNOWN_CAMERAS.map((camera) => makeCamera(camera)),
    profileId: "synthetic-profile-v1",
    requiredCameras: KNOWN_CAMERAS,
    schemaVersion: 1,
    vehicleFamily: "model_y_2025_plus_long_range",
  };
}
```

```ts
import { describe, expect, it } from "vitest";
import { validateVehicleCameraProfileV1 } from "../src/index";
import { makeCamera, makeProfile, point, polygon } from "./fixtures";

describe("validateVehicleCameraProfileV1", () => {
  it("accepts a complete six-camera profile with normalized geometry", () => {
    expect(validateVehicleCameraProfileV1(makeProfile())).toEqual([]);
  });

  it("rejects a point outside the normalized coordinate range", () => {
    const front = makeCamera("front", {
      selfVehicleMasks: [polygon(point(-0.01, 0), point(1, 0), point(1, 1))],
    });
    const profile = makeProfile({
      cameras: [front, ...makeProfile().cameras.filter((camera) => camera.camera !== "front")],
    });

    expect(validateVehicleCameraProfileV1(profile).map((issue) => issue.code)).toContain(
      "invalid_coordinate",
    );
  });

  it("rejects a polygon with fewer than three vertices", () => {
    const front = makeCamera("front", { nearBodyZones: [[point(0, 0), point(1, 1)]] });
    const profile = makeProfile({
      cameras: [front, ...makeProfile().cameras.filter((camera) => camera.camera !== "front")],
    });

    expect(validateVehicleCameraProfileV1(profile).map((issue) => issue.code)).toContain(
      "invalid_polygon",
    );
  });

  it("rejects duplicate and missing required cameras", () => {
    const cameras = makeProfile().cameras.filter((camera) => camera.camera !== "back");
    const profile = makeProfile({ cameras: [...cameras, makeCamera("front")] });

    expect(validateVehicleCameraProfileV1(profile).map((issue) => issue.code)).toEqual([
      "duplicate_camera",
      "missing_required_camera",
    ]);
  });
});
```

- [ ] **Step 4: Run the focused test and verify RED**

Run:

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- validate-profile.test.ts
```

Expected: FAIL because `validateVehicleCameraProfileV1` is not exported.

- [ ] **Step 5: Implement the minimum public types**

Add the following exact public shapes to `src/types.ts`:

```ts
import type { KnownTeslaCamera } from "@sentry-check/teslacam-parser";

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export type NormalizedPolygon = readonly NormalizedPoint[];

export interface NormalizedSegment {
  readonly from: NormalizedPoint;
  readonly to: NormalizedPoint;
}

export interface CameraGeometryProfileV1 {
  readonly anchors: readonly NormalizedPoint[];
  readonly blindZones: readonly NormalizedPolygon[];
  readonly camera: KnownTeslaCamera;
  readonly codec: "h264";
  readonly contactBoundary: readonly NormalizedSegment[];
  readonly height: number;
  readonly nearBodyZones: readonly NormalizedPolygon[];
  readonly occlusionThreshold: number;
  readonly pairedCameras: readonly KnownTeslaCamera[];
  readonly selfVehicleMasks: readonly NormalizedPolygon[];
  readonly width: number;
}

export interface VehicleCameraProfileV1 {
  readonly anchorToleranceNormalized: number;
  readonly cameras: readonly CameraGeometryProfileV1[];
  readonly profileId: string;
  readonly requiredCameras: readonly KnownTeslaCamera[];
  readonly schemaVersion: 1;
  readonly vehicleFamily: "model_y_2025_plus_long_range";
}

export type ProfileValidationIssueCode =
  | "duplicate_camera"
  | "invalid_anchor_tolerance"
  | "invalid_coordinate"
  | "invalid_occlusion_threshold"
  | "invalid_polygon"
  | "invalid_resolution"
  | "missing_required_camera";

export interface ProfileValidationIssue {
  readonly camera: KnownTeslaCamera | null;
  readonly code: ProfileValidationIssueCode;
}
```

- [ ] **Step 6: Implement deterministic validation**

Implement:

```ts
export function validateVehicleCameraProfileV1(
  profile: VehicleCameraProfileV1,
): readonly ProfileValidationIssue[];
```

Use fixed issue order: `duplicate_camera`, `missing_required_camera`, `invalid_resolution`, `invalid_anchor_tolerance`, `invalid_occlusion_threshold`, `invalid_polygon`, `invalid_coordinate`.

Validate every mask, zone, anchor, and segment endpoint. Accept only finite coordinates from 0 through 1, positive integer dimensions, polygon sizes of at least three, and thresholds from 0 through 1.

- [ ] **Step 7: Verify GREEN and refactor**

Run:

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- validate-profile.test.ts
mise x node@24.18.1 -- npm run typecheck --workspace=@sentry-check/camera-geometry
```

Expected: all profile-validation tests pass and TypeScript exits 0.

- [ ] **Step 8: Commit the package contract**

```bash
git add packages/camera-geometry package-lock.json
git commit -m "feat: カメラ幾何プロファイル契約を追加"
```

---

### Task 2: Recording Profile Matching

**Files:**
- Modify: `packages/camera-geometry/src/types.ts`
- Create: `packages/camera-geometry/src/match-profile.ts`
- Modify: `packages/camera-geometry/src/index.ts`
- Modify: `packages/camera-geometry/tests/fixtures.ts`
- Create: `packages/camera-geometry/tests/match-profile.test.ts`

**Interfaces:**
- Consumes: `VehicleCameraProfileV1`
- Produces: `CameraRecordingDescriptor`, `ProfileMatchResult`, `matchVehicleCameraProfileV1(profile, descriptors)`

- [ ] **Step 1: Write failing matching tests**

Extend the fixture type imports with `CameraRecordingDescriptor`, then add:

```ts
export function recordingDescriptors(): readonly CameraRecordingDescriptor[] {
  return makeProfile().cameras.map((camera) => ({
    anchorErrorNormalized: 0.005,
    camera: camera.camera,
    codec: camera.codec,
    cropped: false,
    height: camera.height,
    rotationDegrees: 0,
    width: camera.width,
  }));
}
```

```ts
import { describe, expect, it } from "vitest";
import { matchVehicleCameraProfileV1 } from "../src/index";
import { makeProfile, recordingDescriptors } from "./fixtures";

describe("matchVehicleCameraProfileV1", () => {
  it("matches the exact six-camera recording shape", () => {
    expect(matchVehicleCameraProfileV1(makeProfile(), recordingDescriptors())).toEqual({
      kind: "matched",
      profileId: "synthetic-profile-v1",
    });
  });

  it("fails closed when a required camera is missing", () => {
    const descriptors = recordingDescriptors().filter((item) => item.camera !== "back");

    expect(matchVehicleCameraProfileV1(makeProfile(), descriptors)).toEqual({
      kind: "mismatched",
      reasons: ["missing_required_camera"],
    });
  });

  it("reports every independent recording mismatch in fixed order", () => {
    const descriptors = recordingDescriptors().map((item) =>
      item.camera === "front"
        ? { ...item, anchorErrorNormalized: 0.011, codec: "h265", cropped: true, width: 100 }
        : item,
    );

    expect(matchVehicleCameraProfileV1(makeProfile(), descriptors)).toEqual({
      kind: "mismatched",
      reasons: ["codec_mismatch", "resolution_mismatch", "anchor_drift", "cropped_input"],
    });
  });

  it("accepts anchor drift at 1% and rejects any larger drift", () => {
    const atTolerance = recordingDescriptors().map((item) =>
      item.camera === "front" ? { ...item, anchorErrorNormalized: 0.01 } : item,
    );
    const beyondTolerance = recordingDescriptors().map((item) =>
      item.camera === "front" ? { ...item, anchorErrorNormalized: 0.010_001 } : item,
    );

    expect(matchVehicleCameraProfileV1(makeProfile(), atTolerance)).toEqual({
      kind: "matched",
      profileId: "synthetic-profile-v1",
    });
    expect(matchVehicleCameraProfileV1(makeProfile(), beyondTolerance)).toEqual({
      kind: "mismatched",
      reasons: ["anchor_drift"],
    });
  });
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- match-profile.test.ts
```

Expected: FAIL because `matchVehicleCameraProfileV1` is not exported.

- [ ] **Step 3: Add matching types**

```ts
import type { TeslaCamera } from "@sentry-check/teslacam-parser";

export interface CameraRecordingDescriptor {
  readonly anchorErrorNormalized: number;
  readonly camera: TeslaCamera;
  readonly codec: string;
  readonly cropped: boolean;
  readonly height: number;
  readonly rotationDegrees: number;
  readonly width: number;
}

export type ProfileMismatchReason =
  | "anchor_drift"
  | "codec_mismatch"
  | "cropped_input"
  | "duplicate_camera"
  | "missing_required_camera"
  | "resolution_mismatch"
  | "rotation_mismatch"
  | "unexpected_camera";

export type ProfileMatchResult =
  | { readonly kind: "matched"; readonly profileId: string }
  | { readonly kind: "mismatched"; readonly reasons: readonly ProfileMismatchReason[] };
```

- [ ] **Step 4: Implement fail-closed matching**

Implement:

```ts
export function matchVehicleCameraProfileV1(
  profile: VehicleCameraProfileV1,
  descriptors: readonly CameraRecordingDescriptor[],
): ProfileMatchResult;
```

Return unique reasons in this order: `duplicate_camera`, `missing_required_camera`, `unexpected_camera`, `codec_mismatch`, `resolution_mismatch`, `anchor_drift`, `rotation_mismatch`, `cropped_input`.

Require `rotationDegrees === 0`, `cropped === false`, exact codec and dimensions, and a finite non-negative `anchorErrorNormalized <= profile.anchorToleranceNormalized`.

- [ ] **Step 5: Verify and commit**

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- match-profile.test.ts
mise x node@24.18.1 -- npm run typecheck --workspace=@sentry-check/camera-geometry
git add packages/camera-geometry
git commit -m "feat: 録画構成のプロファイル適合判定を追加"
```

Expected: focused tests and typecheck pass before commit.

---

### Task 3: Polygon Geometry and Frame Evaluation

**Files:**
- Modify: `packages/camera-geometry/src/types.ts`
- Create: `packages/camera-geometry/src/polygon.ts`
- Create: `packages/camera-geometry/src/evaluate-frame.ts`
- Modify: `packages/camera-geometry/src/index.ts`
- Modify: `packages/camera-geometry/tests/fixtures.ts`
- Create: `packages/camera-geometry/tests/evaluate-frame.test.ts`

**Interfaces:**
- Consumes: `CameraGeometryProfileV1`, `NormalizedPolygon`
- Produces: `FrameGeometryObservation`, `FrameGeometryEvaluation`, `evaluateFrameGeometry(profile, observation)`

- [ ] **Step 1: Write failing frame-state tests**

Use a self mask from `(0.4, 0.4)` through `(0.6, 0.6)`, a near zone from `(0.3, 0.3)` through `(0.7, 0.7)`, and a blind zone from `(0.8, 0.8)` through `(0.95, 0.95)`.

Extend the fixture type imports with `FrameGeometryObservation`, then add:

```ts
export function square(x: number, y: number, size: number): NormalizedPolygon {
  return polygon(
    point(x, y),
    point(x + size, y),
    point(x + size, y + size),
    point(x, y + size),
  );
}

export function makeGeometryCamera(): CameraGeometryProfileV1 {
  return makeCamera("left_repeater");
}

interface ObservationOverrides {
  readonly boundaryOcclusionRatio?: number;
}

export function observation(
  objectMask: NormalizedPolygon,
  overrides: ObservationOverrides = {},
): FrameGeometryObservation {
  return {
    boundaryOcclusionRatio: overrides.boundaryOcclusionRatio ?? 0,
    camera: "left_repeater",
    frameTimestampMs: 1_000,
    objectMask,
  };
}
```

```ts
import { describe, expect, it } from "vitest";
import { evaluateFrameGeometry } from "../src/index";
import { makeGeometryCamera, observation, square } from "./fixtures";

describe("evaluateFrameGeometry", () => {
  it("returns outside when the object stays beyond every zone", () => {
    expect(evaluateFrameGeometry(makeGeometryCamera(), observation(square(0.05, 0.05, 0.1)))).toMatchObject({
      intersectsBlindZone: false,
      state: "outside",
    });
  });

  it("returns near when the object enters only the near-body zone", () => {
    expect(evaluateFrameGeometry(makeGeometryCamera(), observation(square(0.31, 0.31, 0.05)))).toMatchObject({
      state: "near",
    });
  });

  it("returns boundary_overlap when the object crosses the contact boundary", () => {
    expect(evaluateFrameGeometry(makeGeometryCamera(), observation(square(0.38, 0.45, 0.05)))).toMatchObject({
      state: "boundary_overlap",
    });
  });

  it("returns boundary_overlap when the object enters the self-vehicle mask", () => {
    expect(evaluateFrameGeometry(makeGeometryCamera(), observation(square(0.45, 0.45, 0.05)))).toMatchObject({
      state: "boundary_overlap",
    });
  });

  it("gives occlusion precedence over an apparent overlap", () => {
    const input = observation(square(0.38, 0.45, 0.05), { boundaryOcclusionRatio: 0.051 });

    expect(evaluateFrameGeometry(makeGeometryCamera(), input)).toMatchObject({ state: "occluded" });
  });

  it("reports a blind-zone intersection independently of proximity", () => {
    expect(evaluateFrameGeometry(makeGeometryCamera(), observation(square(0.82, 0.82, 0.05)))).toMatchObject({
      intersectsBlindZone: true,
      state: "outside",
    });
  });

  it("does not mutate profile or observation inputs", () => {
    const profile = makeGeometryCamera();
    const input = observation(square(0.31, 0.31, 0.05));
    const profileBefore = structuredClone(profile);
    const inputBefore = structuredClone(input);

    evaluateFrameGeometry(profile, input);

    expect(profile).toEqual(profileBefore);
    expect(input).toEqual(inputBefore);
  });
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- evaluate-frame.test.ts
```

Expected: FAIL because `evaluateFrameGeometry` is not exported.

- [ ] **Step 3: Add frame-evaluation types**

```ts
export interface FrameGeometryObservation {
  readonly boundaryOcclusionRatio: number;
  readonly camera: KnownTeslaCamera;
  readonly frameTimestampMs: number;
  readonly objectMask: NormalizedPolygon;
}

export type FrameGeometryState = "boundary_overlap" | "near" | "occluded" | "outside";

export interface FrameGeometryEvaluation {
  readonly camera: KnownTeslaCamera;
  readonly frameTimestampMs: number;
  readonly intersectsBlindZone: boolean;
  readonly minimumBoundaryDistanceNormalized: number;
  readonly state: FrameGeometryState;
}
```

- [ ] **Step 4: Implement pure polygon operations**

Keep `polygon.ts` below 250 pure lines and implement these named exports:

```ts
export function pointInPolygon(point: NormalizedPoint, polygon: NormalizedPolygon): boolean;

export function polygonsIntersect(
  left: NormalizedPolygon,
  right: NormalizedPolygon,
): boolean;

export function polygonIntersectsSegment(
  polygon: NormalizedPolygon,
  segment: NormalizedSegment,
): boolean;

export function minimumDistanceToSegments(
  polygon: NormalizedPolygon,
  segments: readonly NormalizedSegment[],
): number;
```

Treat points on polygon edges as inside. Detect both vertex containment and edge intersection. For every object edge and contact segment, return zero when they intersect; otherwise calculate both object-endpoint-to-contact-segment and contact-endpoint-to-object-segment distances and return the finite minimum.

- [ ] **Step 5: Implement state precedence**

Implement:

```ts
export function evaluateFrameGeometry(
  profile: CameraGeometryProfileV1,
  observation: FrameGeometryObservation,
): FrameGeometryEvaluation;
```

Apply this exact order: `occluded`, `boundary_overlap`, `near`, `outside`. Return `boundary_overlap` when the object intersects either a contact segment or a self-vehicle mask. Set `intersectsBlindZone` independently. Never mutate profile or observation arrays.

- [ ] **Step 6: Verify, refactor, and commit**

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- evaluate-frame.test.ts
mise x node@24.18.1 -- npm run typecheck --workspace=@sentry-check/camera-geometry
mise x node@24.18.1 -- npm exec -- biome check packages/camera-geometry
git add packages/camera-geometry
git commit -m "feat: フレームのカメラ幾何評価を追加"
```

Expected: focused tests, typecheck, and Biome pass before commit.

---

### Task 4: Event-Level Three-Way Verdict

**Files:**
- Modify: `packages/camera-geometry/src/types.ts`
- Create: `packages/camera-geometry/src/classify-event.ts`
- Modify: `packages/camera-geometry/src/index.ts`
- Modify: `packages/camera-geometry/tests/fixtures.ts`
- Create: `packages/camera-geometry/tests/classify-event.test.ts`

**Interfaces:**
- Consumes: `ProfileMatchResult`, `readonly FrameGeometryEvaluation[]`
- Produces: `ContactEventEvidence`, `ContactVerdict`, `classifyContactEvent(evidence)`

- [ ] **Step 1: Write failing verdict tests**

Extend the fixture type imports with `ContactEventEvidence`, `FrameGeometryEvaluation`, and `FrameGeometryState`, then add:

```ts
export function evaluation(state: FrameGeometryState): FrameGeometryEvaluation {
  return {
    camera: "left_repeater",
    frameTimestampMs: 1_000,
    intersectsBlindZone: false,
    minimumBoundaryDistanceNormalized: state === "boundary_overlap" ? 0 : 0.1,
    state,
  };
}

type EvidenceOverrides = Partial<ContactEventEvidence>;

export function makeEventEvidence(
  overrides: EvidenceOverrides = {},
): ContactEventEvidence {
  return {
    cameraEvidenceConflict: false,
    completeTrack: true,
    corroboratingCamera: false,
    deformationOrRebound: false,
    enteredBlindZone: false,
    evaluations: [evaluation("outside")],
    globalShake: false,
    profileMatch: { kind: "matched", profileId: "synthetic-profile-v1" },
    qualityAcceptable: true,
    requiredCameraCoverage: true,
    timingReliable: true,
    trackedBeforeAndAfterClosestApproach: true,
    trajectoryDiscontinuity: false,
    ...overrides,
  };
}
```

```ts
import { describe, expect, it } from "vitest";
import { classifyContactEvent } from "../src/index";
import { evaluation, makeEventEvidence } from "./fixtures";

describe("classifyContactEvent", () => {
  it("returns contact when boundary overlap has independent reinforcement", () => {
    expect(classifyContactEvent(makeEventEvidence({
      evaluations: [evaluation("boundary_overlap")],
      trajectoryDiscontinuity: true,
    }))).toEqual({ reasons: [], verdict: "contact" });
  });

  it("fails closed instead of returning contact when visibility is insufficient", () => {
    expect(classifyContactEvent(makeEventEvidence({
      evaluations: [evaluation("boundary_overlap")],
      qualityAcceptable: false,
      trajectoryDiscontinuity: true,
    }))).toEqual({
      reasons: ["low_visibility"],
      verdict: "indeterminate",
    });
  });

  it("does not call boundary overlap contact without reinforcement", () => {
    expect(classifyContactEvent(makeEventEvidence({
      evaluations: [evaluation("boundary_overlap")],
    }))).toEqual({
      reasons: ["insufficient_contact_evidence"],
      verdict: "indeterminate",
    });
  });

  it("returns no_contact_observed only for complete visible clearance", () => {
    expect(classifyContactEvent(makeEventEvidence({
      evaluations: [evaluation("near"), evaluation("outside")],
    }))).toEqual({ reasons: [], verdict: "no_contact_observed" });
  });

  it("does not infer clearance from empty camera evidence", () => {
    expect(classifyContactEvent(makeEventEvidence({ evaluations: [] }))).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it("keeps occluded and blind-zone evidence indeterminate", () => {
    expect(classifyContactEvent(makeEventEvidence({
      enteredBlindZone: true,
      evaluations: [evaluation("occluded")],
    }))).toEqual({
      reasons: ["boundary_occluded", "entered_blind_zone"],
      verdict: "indeterminate",
    });
  });

  it("uses frame-level blind-zone evidence even without the event flag", () => {
    expect(classifyContactEvent(makeEventEvidence({
      evaluations: [{ ...evaluation("outside"), intersectsBlindZone: true }],
    }))).toEqual({
      reasons: ["entered_blind_zone"],
      verdict: "indeterminate",
    });
  });

  it("returns every applicable indeterminate reason in fixed order", () => {
    expect(classifyContactEvent(makeEventEvidence({
      cameraEvidenceConflict: true,
      completeTrack: false,
      profileMatch: { kind: "mismatched", reasons: ["anchor_drift"] },
      qualityAcceptable: false,
      requiredCameraCoverage: false,
      timingReliable: false,
    }))).toEqual({
      reasons: [
        "profile_mismatch",
        "insufficient_camera_coverage",
        "track_lost",
        "low_visibility",
        "timing_unreliable",
        "conflicting_evidence",
      ],
      verdict: "indeterminate",
    });
  });

  it("does not mutate event evidence or its evaluation array", () => {
    const evidence = makeEventEvidence({ evaluations: [evaluation("outside")] });
    const before = structuredClone(evidence);

    classifyContactEvent(evidence);

    expect(evidence).toEqual(before);
  });
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- classify-event.test.ts
```

Expected: FAIL because `classifyContactEvent` is not exported.

- [ ] **Step 3: Add the verdict contract**

```ts
export type IndeterminateReason =
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
  readonly cameraEvidenceConflict: boolean;
  readonly completeTrack: boolean;
  readonly corroboratingCamera: boolean;
  readonly deformationOrRebound: boolean;
  readonly enteredBlindZone: boolean;
  readonly evaluations: readonly FrameGeometryEvaluation[];
  readonly globalShake: boolean;
  readonly profileMatch: ProfileMatchResult;
  readonly qualityAcceptable: boolean;
  readonly requiredCameraCoverage: boolean;
  readonly timingReliable: boolean;
  readonly trackedBeforeAndAfterClosestApproach: boolean;
  readonly trajectoryDiscontinuity: boolean;
}

export type ContactVerdict =
  | { readonly reasons: readonly []; readonly verdict: "contact" }
  | { readonly reasons: readonly []; readonly verdict: "no_contact_observed" }
  | { readonly reasons: readonly IndeterminateReason[]; readonly verdict: "indeterminate" };
```

- [ ] **Step 4: Implement the decision order**

Implement:

```ts
export function classifyContactEvent(evidence: ContactEventEvidence): ContactVerdict;
```

Apply this order:

1. Derive structural fail-closed reasons in this fixed order: `profile_mismatch`, `insufficient_camera_coverage`, `boundary_occluded`, `entered_blind_zone`, `track_lost`, `low_visibility`, `timing_unreliable`, `conflicting_evidence`. Treat an empty `evaluations` array as `insufficient_camera_coverage`; treat either `enteredBlindZone` or an evaluation with `intersectsBlindZone` as blind-zone evidence; treat either an incomplete track or a missing closest-approach interval as `track_lost`.
2. If any structural reason exists, return `indeterminate` before considering either conclusive verdict. A reinforcement flag without a `boundary_overlap` frame contributes `conflicting_evidence`.
3. Return `contact` only when a frame has `boundary_overlap` and at least one of `globalShake`, `trajectoryDiscontinuity`, `deformationOrRebound`, or `corroboratingCamera` is true.
4. If overlap exists without reinforcement, return `indeterminate` with `insufficient_contact_evidence`.
5. Return `no_contact_observed` only when `evaluations` is non-empty, the profile matches, the complete track and closest-approach interval are present, required camera coverage, timing, and quality are acceptable, no evaluation is `boundary_overlap` or `occluded`, there is no blind-zone entry or camera conflict, and every reinforcement flag is false.
6. Return `indeterminate` with all unique reasons in the fixed order; append `insufficient_contact_evidence` after the structural reason codes when applicable.

- [ ] **Step 5: Verify and commit**

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- classify-event.test.ts
mise x node@24.18.1 -- npm run typecheck --workspace=@sentry-check/camera-geometry
git add packages/camera-geometry
git commit -m "feat: 接触の三値判定を追加"
```

Expected: focused tests and typecheck pass before commit.

---

### Task 5: Measured Model Y Profile

**Files:**
- Create: `packages/camera-geometry/src/model-y-2025-plus.ts`
- Modify: `packages/camera-geometry/src/index.ts`
- Create: `packages/camera-geometry/tests/model-y-profile.test.ts`

**Interfaces:**
- Consumes: `VehicleCameraProfileV1`, `validateVehicleCameraProfileV1`
- Produces: `MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V1`

- [ ] **Step 1: Write the failing anonymous regression test**

```ts
import { describe, expect, it } from "vitest";
import {
  MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V1,
  validateVehicleCameraProfileV1,
} from "../src/index";

describe("MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V1", () => {
  it("fixes the measured six-camera recording shape", () => {
    const profile = MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V1;
    const dimensions = Object.fromEntries(
      profile.cameras.map((camera) => [camera.camera, [camera.width, camera.height]]),
    );

    expect(profile.profileId).toBe("model-y-2025-plus-long-range-2896x1876-v1");
    expect(dimensions).toEqual({
      back: [1448, 938],
      front: [2896, 1876],
      left_pillar: [1448, 938],
      left_repeater: [1448, 938],
      right_pillar: [1448, 938],
      right_repeater: [1448, 938],
    });
    expect(validateVehicleCameraProfileV1(profile)).toEqual([]);
  });

  it("contains non-empty body, boundary, near, blind, and anchor geometry for every camera", () => {
    for (const camera of MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V1.cameras) {
      expect(camera.selfVehicleMasks.length).toBeGreaterThan(0);
      expect(camera.contactBoundary.length).toBeGreaterThan(0);
      expect(camera.nearBodyZones.length).toBeGreaterThan(0);
      expect(camera.blindZones.length).toBeGreaterThan(0);
      expect(camera.anchors.length).toBeGreaterThanOrEqual(2);
    }
  });
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- model-y-profile.test.ts
```

Expected: FAIL because `MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V1` is not exported.

- [ ] **Step 3: Measure conservative geometry locally**

Set `SENTRY_SOURCE_DIR` only in the local shell and do not write its value to repository files or logs.

Select 24 complete six-camera groups distributed across the full local inventory. Use 12 groups for calibration and 12 different groups for holdout validation. Extract the 30-second frame for each camera into a `mktemp -d` directory. Do not place derivatives under the repository.

For each camera:

1. Trace only self-body pixels visible at the same normalized position in at least 11 of 12 calibration groups.
2. Put inconsistent reflections and environment-dependent edges outside the self mask.
3. Trace the visible exterior edge as contact segments.
4. Create a near-body polygon outside the contact segments.
5. Mark every region where the self boundary is not directly observable as a blind zone.
6. Select at least two fixed self-body anchor points.
7. Normalize each point with `x / width` and `y / height`.

Validate against the 12 holdout groups. Accept a camera geometry only when all 12 holdouts keep the fixed anchors within 1% of image diagonal and the conservative self mask does not classify background-only pixels as self body.

Delete every extracted frame and temporary contact sheet after recording normalized coordinates. Verify that no `.mp4`, `.jpg`, `.jpeg`, or `.png` was added below the repository.

- [ ] **Step 4: Encode the measured profile**

Create the exported constant using this exact outer contract:

```ts
export const MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V1 = {
  anchorToleranceNormalized: 0.01,
  cameras: measuredCameraProfiles,
  profileId: "model-y-2025-plus-long-range-2896x1876-v1",
  requiredCameras: [
    "front",
    "back",
    "left_pillar",
    "right_pillar",
    "left_repeater",
    "right_repeater",
  ],
  schemaVersion: 1,
  vehicleFamily: "model_y_2025_plus_long_range",
} satisfies VehicleCameraProfileV1;
```

Keep measured geometry in `model-y-2025-plus.ts`; do not add a generic annotation editor or runtime file loader.

- [ ] **Step 5: Verify profile privacy and GREEN**

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- model-y-profile.test.ts
mise x node@24.18.1 -- npm run typecheck --workspace=@sentry-check/camera-geometry
git status --short
if rg -n '/Users/|UGREEN-NAS|[A-HJ-NPR-Z0-9]{17}|\.(mp4|jpg|jpeg|png)' packages/camera-geometry; then exit 1; fi
```

Expected: tests and typecheck pass; status contains only source and synthetic test changes; the privacy scan finds no private path, media filename, or VIN.

- [ ] **Step 6: Commit the measured profile**

```bash
git add packages/camera-geometry
git commit -m "feat: Model Y実測カメラプロファイルを追加"
```

---

### Task 6: Consumer Surface, Documentation, and Full Verification

**Files:**
- Create: `packages/camera-geometry/tests/consumer.test.ts`
- Modify: `docs/PROJECT_CONTEXT.md`
- Create: `docs/CAMERA_GEOMETRY_NOTES.md`

**Interfaces:**
- Consumes: public exports from `@sentry-check/camera-geometry`
- Produces: a consumer-observable three-verdict smoke and updated project boundary

- [ ] **Step 1: Write the public consumer smoke**

Import only from `../src/index` and exercise these three scenarios:

```ts
import { describe, expect, it } from "vitest";
import { classifyContactEvent } from "../src/index";
import { evaluation, makeEventEvidence } from "./fixtures";

describe("camera geometry public surface", () => {
  it.each([
    {
      evidence: makeEventEvidence({
        evaluations: [evaluation("boundary_overlap")],
        globalShake: true,
      }),
      verdict: "contact",
    },
    {
      evidence: makeEventEvidence({ evaluations: [evaluation("outside")] }),
      verdict: "no_contact_observed",
    },
    {
      evidence: makeEventEvidence({ evaluations: [evaluation("occluded")] }),
      verdict: "indeterminate",
    },
  ] as const)("returns $verdict through public exports", ({ evidence, verdict }) => {
    expect(classifyContactEvent(evidence).verdict).toBe(verdict);
  });
});
```

- [ ] **Step 2: Run the consumer smoke**

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- consumer.test.ts
```

Expected: three consumer scenarios pass.

- [ ] **Step 3: Update product documentation**

Add the camera geometry package to `docs/PROJECT_CONTEXT.md` under the implemented boundary. State that the package does not perform object detection or make production contact decisions from raw video yet.

Create `docs/CAMERA_GEOMETRY_NOTES.md` with:

- anonymous inventory counts: 5,038 MP4, approximately 165.4GB, 652 complete six-camera groups, 108 metadata samples
- six camera dimensions and H.264 codec
- three-verdict semantics and fixed indeterminate reasons
- profile mismatch behavior and 1% anchor tolerance
- local-only calibration and deletion of temporary derivatives
- non-guarantees for blind spots, occlusion, missing cameras, image quality, and unlabeled accuracy

- [ ] **Step 4: Run package verification**

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry
mise x node@24.18.1 -- npm run typecheck --workspace=@sentry-check/camera-geometry
mise x node@24.18.1 -- npm run build --workspace=@sentry-check/camera-geometry
mise x node@24.18.1 -- npm exec -- biome check packages/camera-geometry docs/PROJECT_CONTEXT.md docs/CAMERA_GEOMETRY_NOTES.md
```

Expected: all commands exit 0 with no warnings.

- [ ] **Step 5: Run repository verification**

```bash
mise x node@24.18.1 -- npm run check
mise x node@24.18.1 -- npm run cf:dry-run
```

Expected: all workspace tests, typechecks, lint, builds, and Cloudflare dry-run exit 0.

- [ ] **Step 6: Run privacy and source-size gates**

```bash
git diff --check
find packages/camera-geometry/src -name '*.ts' -print0 | while IFS= read -r -d '' file; do
  lines=$(awk '!/^[[:space:]]*$/ && !/^[[:space:]]*\/\//' "$file" | wc -l | tr -d ' ')
  test "$lines" -le 250 || { printf '%s %s\n' "$lines" "$file"; exit 1; }
done
if git diff --name-only origin/main...HEAD | rg '\.(mp4|mov|m4v|avi|mkv|webm|jpg|jpeg|png)$'; then exit 1; fi
if rg -n '/Users/|UGREEN-NAS|[A-HJ-NPR-Z0-9]{17}' packages/camera-geometry docs/CAMERA_GEOMETRY_NOTES.md; then exit 1; fi
```

Expected: source-size loop exits 0; media scan returns no paths; privacy scan returns no private path or identifier.

- [ ] **Step 7: Perform the manual QA gate**

Run the public consumer test with verbose output and inspect all three observable verdicts:

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- consumer.test.ts --reporter=verbose
```

Expected: one `contact`, one `no_contact_observed`, and one `indeterminate` consumer scenario pass through public exports.

- [ ] **Step 8: Commit documentation and consumer evidence**

```bash
git add packages/camera-geometry/tests/consumer.test.ts docs/PROJECT_CONTEXT.md docs/CAMERA_GEOMETRY_NOTES.md
git commit -m "docs: カメラ幾何判定の実装境界を更新"
```

- [ ] **Step 9: Review final branch state**

```bash
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: clean working tree and the design, implementation plan, and six implementation commits on `kandotrun/model-y-camera-geometry`.
