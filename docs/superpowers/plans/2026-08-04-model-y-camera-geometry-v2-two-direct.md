# Model Y Camera Geometry V2 Two-Direct Completion Plan

> Status: approved after independent review of the back-camera calibration blocker.

**Goal:** Ship the unexposed V2 contract and measured profile only for the two camera directions that passed independent calibration and holdout: `left_repeater` and `right_repeater`. Keep `front`, `back`, and both pillar cameras as context-only, and fail closed whenever a context track is unresolved.

**Evidence basis:** Both repeaters passed 12/12 calibration and 12/12 distinct holdout groups at three time points. Maximum normalized-diagonal anchor error was 0.006955 left and 0.005217 right. Front and pillars have no validated visible direct body geometry. Back body pixels were visible in 11/12 calibration groups, but three materially different calibration-only extractors reached at most 8/12 to 9/12 stable groups and maximum error 0.035357 to 0.053789. Back geometry remains unvalidated and is not exported.

**Privacy:** Real media remains local and read-only. Source paths, filenames, capture times, locations, faces, plates, VINs, frames, and source mappings never enter source, tests, tracked reports, commits, or command output.

---

### Task 1: Two-Direct Roles and Context Coverage

**Files:**
- Modify: `packages/camera-geometry/src/types.ts`
- Modify: `packages/camera-geometry/src/profile-shape.ts`
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

1. Keep schema version 2 because no measured V2 profile or external consumer has shipped.
2. Exact roles become:
   - `ContactCapableTeslaCamera`: `left_repeater`, `right_repeater`
   - `ContextualTeslaCamera`: `front`, `back`, `left_pillar`, `right_pillar`
3. Context direct-geometry status is exact by camera:
   - `front`, `left_pillar`, `right_pillar`: `unobservable`
   - `back`: `unvalidated`
4. Context profiles have no anchors, self mask, contact boundary, near zone, blind zone, or occlusion threshold. Back is never accepted by frame evaluation or as corroborating direct-camera evidence.
5. Validator requires all six recordings, exactly two direct profiles, exactly four context profiles, exact status semantics, and the existing total runtime validation guarantees.
6. Matcher validates codec, dimensions, rotation, and crop for all six. Only the repeaters accept finite numeric anchor error; every context camera requires `anchorErrorNormalized: null`. Preserve `anchor_unavailable`, `anchor_drift`, fixed reason order, and provenance.
7. Add context-camera coverage evidence with exact states `no_relevant_track`, `resolved_to_direct`, and `unresolved`. `resolved_to_direct` is upstream track-association evidence, not a consequence of profile pairing, file presence, or timestamp proximity.
8. Complete coverage requires exactly one valid observation for each repeater, all four direct observation flags true, exactly one state for each context camera, and no `unresolved` context. Missing, duplicate, unknown, false, or unresolved evidence is incomplete.
9. Incomplete coverage can represent context-only failure even when no direct camera is missing; `missingContactCameras` may therefore be empty.
10. Rear-only, front-only, pillar-only, unresolved context, forged back evaluation, forged back reinforcement, missing context accounting, or mixed context evaluation always returns `indeterminate / insufficient_camera_coverage`.
11. `no_contact_observed` requires a matched profile, at least one valid repeater evaluation, complete direct/context coverage, and every existing quality, timing, track, occlusion, blind-zone, conflict, and reinforcement gate. It describes only a resolved candidate at measured repeater boundaries, not whole-vehicle non-contact.
12. `contact` continues to require repeater boundary overlap plus independent non-context reinforcement. Context evidence cannot directly create contact or clearance.
13. Preserve immutability and all prior fail-closed tests whose safety meaning has not changed. Update only tests that intentionally pin the obsolete three-direct role set.
14. RED/GREEN focused and full tests, typecheck, build, Biome, public manual driver, prohibited-construct/V1/LOC/privacy audits, Cloudflare dry-run, and `git diff --check` pass.

Commit: `fix: 実測済み2方向へ幾何契約を限定`

---

### Task 2: Measured Two-Direct Model Y Profile

**Files:**
- Create: `packages/camera-geometry/src/model-y-2025-plus.ts`
- Modify: `packages/camera-geometry/src/index.ts`
- Create: `packages/camera-geometry/tests/model-y-profile.test.ts`

**Acceptance criteria:**

1. Export `MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V2` with ID `model-y-2025-plus-long-range-2896x1876-v2`, schema 2, tolerance 0.01, all six recordings, exact two-direct roles, and four context roles.
2. Transcribe the completed repeater report exactly:
   - left anchors `(0.042818, 0.660981)` and `(0.051796, 0.799574)`
   - right anchors `(0.953729, 0.623667)` and `(0.938536, 0.815565)`
   - report-defined conservative masks, contact segments, near zones, and blind zones
3. Use `occlusionThreshold: 0` for both repeaters. No positive occlusion tolerance was measured; any reported boundary occlusion must therefore fail closed.
4. Encode no direct geometry for front, back, or pillars. Back is `unvalidated`; front and pillars are `unobservable`.
5. Pair context to measured direct cameras without treating pairing as resolved coverage:
   - front and back: both repeaters
   - left pillar: left repeater
   - right pillar: right repeater
6. Pair each repeater only to its adjacent context cameras: left to front/back/left pillar; right to front/back/right pillar.
7. Validator returns no issues. Six valid descriptors match with numeric errors for both repeaters and null errors for all four context cameras.
8. Tests cover exact identity, dimensions, roles, statuses, coordinates, nonempty direct geometry, absent context geometry, pairings, validator, matcher, direct evaluation for both repeaters, all four context rejections, and 1% boundaries.
9. Public manual drivers demonstrate one direct overlap, one complete clean clearance, one rear-only indeterminate, one unresolved-back indeterminate, one unavailable repeater anchor, and one forged back evaluation.
10. Privacy scan, focused/full tests, typecheck, build, Biome, Cloudflare dry-run, and `git diff --check` pass.

Commit: `feat: Model Y実測2方向プロファイルV2を追加`

---

### Task 3: Consumer Surface and Documentation

**Files:**
- Create: `packages/camera-geometry/tests/consumer.test.ts`
- Modify: `docs/PROJECT_CONTEXT.md`
- Create: `docs/CAMERA_GEOMETRY_NOTES.md`
- Modify: `docs/superpowers/specs/2026-08-04-model-y-camera-geometry-design.md`

**Acceptance criteria:**

1. Public tests demonstrate direct contact, resolved clean clearance, rear/front/pillar-only indeterminate, missing repeater coverage indeterminate, unresolved context indeterminate, and context evaluation rejection.
2. Document exact two-direct/four-context roles, `unobservable` versus `unvalidated`, structured context accounting, 1% tolerance, conditional repeater evidence, back blocker, and three-verdict semantics.
3. State that fixed placement improves repeatability but cannot remove blind spots, darkness, occlusion, or unsupported vehicle boundaries.
4. State the typed producer boundary: conclusive classification uses `matchVehicleCameraProfileV2`; arbitrary JSON evidence requires a future ingress parser and server-side track/coverage consistency checks.
5. State that object detection, segmentation, tracking, context-to-direct association, raw-video anchor extraction, physical distance reconstruction, and production raw-video contact classification are not yet implemented.
6. State that `no_contact_observed` means no contact finding at measured repeater boundaries for a resolved candidate, not no damage or no contact over the entire vehicle.
7. Run package and root tests/typecheck/build/lint, Cloudflare dry-run, public manual driver, privacy scan, and `git diff --check`.

Commit: `docs: 2方向カメラ幾何V2の利用境界を追加`

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
3. Compare all six recording roles against the measured profile for metadata available from containers. Never manufacture anchor errors or claim full profile match without an implemented raw-video anchor extractor.
4. Synthetic tests prove grouping, aggregation, redaction, fixed reason order, no per-file identifiers, invalid inputs, and source read-only behavior.
5. Run against the full authorized directory. Record exact numerators/denominators and separate inventory metadata, repeater calibration/holdout geometry, back calibration blocker, manual spot checks, and unimplemented raw-video layers.
6. Source MP4 count and total bytes match before and after. No media, private identifier, or source mapping enters the repository.
7. Run root verification and Cloudflare dry-run after adding the script/report.

Commit: `test: TeslaCam全在庫の匿名検証を追加`

---

### Final Review

Review the complete branch from merge-base through Task 4. False conclusive verdicts, back/context geometry leakage, incomplete direct or context accounting, invalid profile provenance, inaccurate measurement claims, incomplete inventory enumeration, source mutation, privacy leakage, unsafe types, or missing verification are merge blockers. Apply at most one consolidated fix wave and one scoped re-review.
