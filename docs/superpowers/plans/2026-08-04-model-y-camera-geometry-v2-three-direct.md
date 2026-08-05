# Model Y Camera Geometry V2 Three-Direct Continuation Plan

> Status: superseded after the dedicated back calibration gate failed three materially different anchor-extraction approaches. Continue with `2026-08-04-model-y-camera-geometry-v2-two-direct.md`.

**Goal:** Complete the unshipped V2 profile with measured direct geometry only for `back`, `left_repeater`, and `right_repeater`; treat `front` and both pillar cameras as context-only; then verify the entire authorized TeslaCam inventory without overstating raw-video contact capability.

**Evidence basis:** Front self body was 0/12 calibration, 0/12 holdout, and 0/10 independent. Back was independently visible in 10/10. Dedicated left/right repeater calibration and distinct holdout were 12/12 per side at three time points; maximum normalized-diagonal anchor error was 0.006955 left and 0.005217 right.

**Privacy:** All real media remains local and read-only. Source paths, filenames, capture times, locations, faces, plates, VINs, frames, and source mappings never enter source, tests, reports, commits, or command output.

---

### Task 1: Three-Direct Role and Coverage Correction

**Files:**
- Modify: `packages/camera-geometry/src/types.ts`
- Modify: `packages/camera-geometry/src/validate-profile.ts`
- Modify: `packages/camera-geometry/src/match-profile.ts`
- Modify: `packages/camera-geometry/src/evaluate-frame.ts`
- Modify: `packages/camera-geometry/src/classify-event.ts`
- Modify: `packages/camera-geometry/tests/fixtures.ts`
- Modify: `packages/camera-geometry/tests/validate-profile.test.ts`
- Modify: `packages/camera-geometry/tests/match-profile.test.ts`
- Modify: `packages/camera-geometry/tests/evaluate-frame.test.ts`
- Modify: `packages/camera-geometry/tests/classify-event.test.ts`

**Acceptance criteria:**

1. Keep schema version 2 because no measured V2 profile or external consumer exists.
2. Exact roles become:
   - `ContactCapableTeslaCamera`: `back`, `left_repeater`, `right_repeater`
   - `ContextualTeslaCamera`: `front`, `left_pillar`, `right_pillar`
3. Validator requires exactly those three contact and three context roles while keeping all six recordings required.
4. Matcher checks codec, dimensions, rotation, and crop for all six. Direct cameras require finite numeric anchor error; all three context cameras require `anchorErrorNormalized: null`.
5. Frame evaluator rejects `front` and both pillars before geometry calculation. Only the three measured direct roles can produce `contact_geometry` evaluations.
6. Replace the camera-name-only complete coverage assertion with per-direct-camera observation evidence containing:
   - camera
   - observed before closest approach
   - observed at closest approach
   - observed after closest approach
   - contact boundary unobscured at closest approach
7. Complete coverage requires one unique valid evidence item for each of the three direct cameras, every observation flag true, and `unresolvedContext: false`. Missing, duplicate, wrong-role, false observation flags, or unresolved context are `insufficient_camera_coverage`.
8. Candidate evaluations remain separate from observation-completeness evidence; cameras without a candidate object do not need a fabricated object evaluation.
9. A front-only track, context-only evaluation, or context-only reinforcement can never produce `contact` or `no_contact_observed`.
10. `contact` still requires a direct boundary overlap plus non-context independent reinforcement. `no_contact_observed` requires nonempty direct evaluation plus complete structured coverage and every existing quality, timing, track, occlusion, blind-zone, conflict, and reinforcement gate.
11. Preserve V2 profile total validation, matcher provenance, fixed reason order, immutability, and all 123 existing tests.
12. TDD focused/full tests, typecheck, build, Biome, prohibited-construct/V1/LOC audits, public manual driver, and `git diff --check` must pass.

Commit: `fix: Model Yの直接カメラ役割を実測に合わせる`

---

### Task 2A: Direct Anchor Availability Contract

**Files:**
- Modify: `packages/camera-geometry/src/types.ts`
- Modify: `packages/camera-geometry/src/match-profile.ts`
- Modify: `packages/camera-geometry/tests/match-profile.test.ts`
- Modify: `packages/camera-geometry/tests/classify-event.test.ts`

**Acceptance criteria:**

1. Add `anchor_unavailable` to the fixed `ProfileMismatchReason` order.
2. A direct-camera descriptor with `anchorErrorNormalized: null` returns `anchor_unavailable`. A finite non-negative value above tolerance, a negative value, `NaN`, or infinity returns `anchor_drift`.
3. Context-camera descriptors continue to require `anchorErrorNormalized: null`; a numeric context value remains `anchor_drift`.
4. `anchor_unavailable` is a profile mismatch and therefore cannot reach `contact` or `no_contact_observed`. Producers must also mark the corresponding evidence as low visibility when the physical anchor cannot be observed.
5. Matcher tests pin mixed unavailable/drift reason ordering, the direct/context distinction, tolerance boundaries, immutability, and the existing six-camera match.
6. Classifier tests prove that `anchor_unavailable` mismatch is always `indeterminate / profile_mismatch`; when the producer also supplies `qualityAcceptable: false`, `low_visibility` is retained and no conclusive verdict is possible.
7. Focused/full tests, typecheck, build, Biome, public driver, prohibited-construct scan, and `git diff --check` pass.

Commit: `fix: 観測不能な固定アンカーを安全側に分離`

---

### Task 2B: Measured Three-Direct Model Y Profile

**Files:**
- Create: `packages/camera-geometry/src/model-y-2025-plus.ts`
- Modify: `packages/camera-geometry/src/index.ts`
- Create: `packages/camera-geometry/tests/model-y-profile.test.ts`

**Acceptance criteria:**

1. Export `MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V2` with ID `model-y-2025-plus-long-range-2896x1876-v2`, schema 2, tolerance 0.01, all six recordings, and exact three-direct roles.
2. Encode no direct geometry for front or pillars. Their context pairings must reference measured direct cameras.
3. Use the completed dedicated repeater measurement report for left/right normalized geometry and holdout evidence. Recheck its normalized coordinates against source frames only in temporary storage if transcription is uncertain.
4. Treat the already-viewed 12 calibration and 12 holdout groups as development evidence. Preserve the extremely dark group as a known low-visibility regression case; do not call it blind, exclude it from its original denominator, or replace it.
5. Use only the development calibration set to freeze the back anchor extractor and numeric visibility gate before opening a new holdout. Freeze the 10/30/50-second sample times, at least two physical anchors, each search ROI, extraction algorithm, minimum local contrast, minimum best-versus-second-candidate separation, physical body-boundary visibility, and occlusion rule. Conservatively require both anchors to be visible at all three time points. Eligibility must be decided before anchor error is calculated and may not depend on expected-coordinate distance or final pass/fail.
6. Calibration must retain observable physical self body in at least 11/12 groups and produce stable anchors for every visibility-eligible calibration group. If the extractor cannot satisfy this without using the viewed holdout, remain blocked.
7. After freezing the extractor and gate, enumerate a new deterministic capture-aware candidate sequence that excludes every known development group and adjacent capture. Freeze the seed, strata, traversal order, and stopping rule before opening frames. Record every candidate as eligible or unavailable before measuring error, retain both denominators, and use the first 12 eligible groups as the distinct conditional-geometry holdout. No candidate may be rejected because of its measured error.
8. Every one of the 12 eligible holdout groups must have anchor error <=0.01 normalized diagonal. Every unavailable group must return `anchor_unavailable`; the known dark regression case must also return `anchor_unavailable` and never a synthetic numeric error.
9. Measure stable body mask, contact boundary, near zone, blind zones, at least two anchors, and a conservative occlusion threshold. Self masks must not include obvious background.
10. Validator returns no issues. A valid six-descriptor set matches with numeric errors for the three direct cameras and null errors for all three context cameras.
11. Tests cover exact identity/dimensions/roles, nonempty direct geometry, context absence of geometry, pairings, validator, matcher, direct evaluation for all three, context rejection for all three, and the known low-visibility regression contract.
12. Report exact `screened / eligible / unavailable / drift / pass` numerators and denominators. State that 12/12 is a conditional engineering gate and does not prove certainty in every operating condition.
13. Delete all temporary media/derivatives and prove source count/bytes unchanged. Privacy scan, focused/full tests, typecheck, build, Biome, public driver, and `git diff --check` pass.

Commit: `feat: Model Y実測カメラプロファイルV2を追加`

---

### Task 3: Consumer Surface and Documentation

**Files:**
- Create: `packages/camera-geometry/tests/consumer.test.ts`
- Modify: `docs/PROJECT_CONTEXT.md`
- Create: `docs/CAMERA_GEOMETRY_NOTES.md`
- Modify: `docs/superpowers/specs/2026-08-04-model-y-camera-geometry-design.md`

**Acceptance criteria:**

1. Public tests demonstrate direct contact, fully observed clean clearance, front-only indeterminate, missing direct coverage indeterminate, and context evaluation rejection.
2. Document exact three-direct/three-context roles, structured coverage, profile mismatch, 1% tolerance, calibration/holdout evidence, and three-verdict semantics.
3. State that fixed placement improves repeatability but cannot remove blind spots or observe a vehicle boundary outside the image.
4. State the typed producer boundary: conclusive classification uses `matchVehicleCameraProfileV2`; arbitrary JSON evidence requires a future ingress parser.
5. State that object detection, segmentation, tracking, anchor extraction, physical distance reconstruction, and production raw-video contact classification are not yet implemented.
6. Run package and root tests/typecheck/build/lint, Cloudflare dry-run, public manual driver, privacy scan, and `git diff --check`.

Commit: `docs: カメラ幾何V2の利用境界を追加`

---

### Task 4: Full Authorized TeslaCam Inventory Verification

**Files:**
- Create: `scripts/verify-camera-geometry-inventory.mjs`
- Create: `scripts/verify-camera-geometry-inventory.test.mjs`
- Create: `docs/CAMERA_GEOMETRY_REAL_DATA_REPORT.md`
- Modify: `package.json`

**Acceptance criteria:**

1. Read the source root only from `SENTRY_SOURCE_DIR`; recursively process every discovered MP4 with bounded `ffprobe` concurrency and no source mutation.
2. Output only machine-readable anonymous aggregates: total count/bytes, recognized suffixes, complete/incomplete groups, per-camera codec/resolution, readable/unreadable containers, duration range, short clips, metadata-compatible files/groups, and fixed incompatibility reasons.
3. Compare all six recording roles against the measured profile for metadata available from containers. Never manufacture anchor errors or claim full profile match without anchor extraction.
4. Synthetic tests prove grouping, aggregation, redaction, fixed reason order, and no per-file identifiers.
5. Run against the full authorized directory after implementation. Record exact numerators/denominators and separate full metadata verification, calibration/holdout geometry evidence, manual spot checks, and unimplemented raw-video layers.
6. Source MP4 count and total bytes must match before/after. No media, private identifier, or source mapping enters the repository.
7. Run root verification and Cloudflare dry-run after adding the script/report.

Commit: `test: TeslaCam全在庫の匿名検証を追加`

---

### Final Review

Review the complete branch from merge-base through Task 4. False conclusive verdicts, context geometry leakage, incomplete structured coverage, invalid profile provenance, inaccurate measurement claims, incomplete inventory enumeration, source mutation, privacy leakage, unsafe types, or missing verification are merge blockers. Apply at most one consolidated fix wave and one scoped re-review.
