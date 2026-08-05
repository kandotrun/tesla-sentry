# Model Y Camera Geometry V2 Continuation Plan

> **履歴資料：** この計画のV2にある4方向直接幾何は、frontとbackの後続測定によって置き換えられた。
> 本文とchecklistは当時の歴史的仮説であり、現在の実行対象ではない。
> 現在の実装は[2方向直接幾何の完了計画](2026-08-04-model-y-camera-geometry-v2-two-direct.md)へ進む。

> Status: approved by the user after local measurement showed that both pillar cameras have no visible contact-capable self-body edge.

**Goal:** Ship a fail-closed Model Y Long Range camera profile that uses four cameras for direct contact geometry and two pillar cameras as context-only inputs, without manufacturing geometry for unobservable body regions.

**Architecture:** Replace the unshipped V1 operational contract with a role-discriminated V2 contract. Matching still validates all six recordings, but anchor drift is evaluated only for direct-contact cameras. Frame geometry accepts only direct-contact profiles. Event classification consumes structured direct-camera coverage and never turns pillar-only evidence into `contact` or `no_contact_observed`.

**Privacy:** Calibration remains local. Real media, derived frames, filenames, capture times, locations, plates, faces, VINs, and source paths must never enter source, reports, commits, or command output. Reports contain anonymous aggregate counts and normalized geometry only.

**Toolchain:** TypeScript, Vitest, Biome, npm workspaces, Node 24 through `mise`.

---

### Task 1: Role-Aware V2 Contract and Fail-Closed Runtime

**Files:**
- Modify: `packages/camera-geometry/src/types.ts`
- Modify: `packages/camera-geometry/src/validate-profile.ts`
- Modify: `packages/camera-geometry/src/match-profile.ts`
- Modify: `packages/camera-geometry/src/evaluate-frame.ts`
- Modify: `packages/camera-geometry/src/classify-event.ts`
- Modify: `packages/camera-geometry/src/index.ts`
- Modify: `packages/camera-geometry/tests/fixtures.ts`
- Modify: `packages/camera-geometry/tests/validate-profile.test.ts`
- Modify: `packages/camera-geometry/tests/match-profile.test.ts`
- Modify: `packages/camera-geometry/tests/evaluate-frame.test.ts`
- Modify: `packages/camera-geometry/tests/classify-event.test.ts`

**Acceptance criteria:**

1. Replace the unshipped operational V1 profile, matcher, validator, and evaluator exports with V2 names. Do not keep a second permissive V1 runtime path.
2. Export exact camera-role unions:
   - `ContactCapableTeslaCamera`: `front`, `back`, `left_repeater`, `right_repeater`
   - `ContextualTeslaCamera`: `left_pillar`, `right_pillar`
3. Export `NonEmpty<T>` and `TwoOrMore<T>` tuple types and a discriminated `CameraProfileV2` union:
   - `ContactCameraProfileV2` has `kind: "contact_geometry"`, a contact-capable camera, non-empty self masks/contact boundary/near zones/blind zones, at least two anchors, occlusion threshold, and paired cameras.
   - `ContextCameraProfileV2` has `kind: "context_only"`, a contextual camera, `directContactGeometry: "unobservable"`, and at least one paired contact camera. It has no direct geometry fields.
4. `VehicleCameraProfileV2` has `schemaVersion: 2`, all six `requiredCameras`, and exactly four `requiredContactCameras`.
5. Runtime validation rejects duplicate/missing cameras, wrong role for a camera, missing/empty direct geometry, fewer than two direct anchors, invalid contextual pairing, invalid dimensions/thresholds/polygons/coordinates, and an incorrect required-contact set in deterministic issue order.
6. `CameraRecordingDescriptor.anchorErrorNormalized` is `number | null`. Matching validates codec, dimensions, rotation, and crop for all six cameras. Direct cameras require a finite non-negative anchor error within tolerance. Context-only cameras require `null` and never contribute fabricated anchor drift.
7. `evaluateFrameGeometry` accepts `ContactCameraProfileV2`, verifies `kind` and camera at runtime, and returns a `FrameGeometryEvaluation` whose camera is contact-capable and whose source is the literal `contact_geometry`. A context-only profile or pillar observation must fail before geometry calculation.
8. Replace `requiredCameraCoverage: boolean` with a discriminated `ContactCoverage`:
   - complete coverage contains observed contact cameras and `unresolvedContext: false`
   - incomplete coverage contains missing contact cameras and an `unresolvedContext` boolean
9. Rename the reinforcement flag to `corroboratingContactCamera`. Classifier inputs whose evaluations are not direct-contact sourced, coverage is incomplete, or context remains unresolved return `indeterminate / insufficient_camera_coverage` before either conclusive verdict.
10. `contact` still requires direct boundary overlap and independent reinforcement. `no_contact_observed` requires non-empty direct evaluations, matched V2 profile, complete direct coverage, no unresolved context, complete closest-approach tracking, acceptable quality/timing, no occlusion/blind zone/conflict/overlap, and no reinforcement.
11. Tests cover the two role sets, validator failures, contextual null anchors, direct anchor drift, context evaluation rejection, forged pillar/context evaluation fail-closed behavior, incomplete direct coverage, unresolved context, contact, no-contact-observed, and input immutability.
12. No source comments, `any`, double casts, non-null assertions, TypeScript suppressions, or request-specific module globals.

**TDD and verification:**

1. Update tests first and run the focused files to record RED.
2. Implement the smallest role-aware migration, then run:

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- validate-profile.test.ts match-profile.test.ts evaluate-frame.test.ts classify-event.test.ts
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry
mise x node@24.18.1 -- npm run typecheck --workspace=@sentry-check/camera-geometry
mise x node@24.18.1 -- npm run build --workspace=@sentry-check/camera-geometry
mise x node@24.18.1 -- npx biome check packages/camera-geometry/src packages/camera-geometry/tests
git diff --check
```

3. Manually import the public V2 API and exercise direct contact, complete clearance, incomplete coverage, unresolved pillar context, and context-profile evaluation rejection.
4. Commit: `feat: カメラ役割別の幾何契約V2を追加`

---

### Task 2: Measured Four-Camera Model Y Profile

**Files:**
- Create: `packages/camera-geometry/src/model-y-2025-plus.ts`
- Modify: `packages/camera-geometry/src/index.ts`
- Create: `packages/camera-geometry/tests/model-y-profile.test.ts`

**Acceptance criteria:**

1. Export `MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V2` with profile ID `model-y-2025-plus-long-range-2896x1876-v2` and schema version 2.
2. Keep all six required recordings and dimensions: front 2896x1876, the other five 1448x938, H.264.
3. Encode `front`, `back`, `left_repeater`, and `right_repeater` as `contact_geometry`; encode both pillars as `context_only` with `directContactGeometry: "unobservable"` and valid paired contact cameras.
4. Select 24 complete six-camera groups distributed across the current inventory: 12 calibration and 12 distinct holdout groups. Reuse no private identifiers in reports.
5. For each direct camera, measure only self-body pixels stable in at least 11/12 calibration groups; create conservative non-empty self masks, contact boundary, near zones, blind zones, and at least two fixed self-body anchors.
6. All 12 holdout groups must keep direct-camera anchors within 1% of image diagonal. Conservative self masks must not classify obvious background-only pixels as self body.
7. Do not create direct geometry or anchors for either pillar. Record only the aggregate fact that both roles are context-only.
8. `validateVehicleCameraProfileV2(profile)` returns no issues. Matching six valid descriptors with null pillar anchor errors succeeds.
9. Delete all temporary frames, contact sheets, median images, and manifests. No media or private identifiers may appear in the repository.

**TDD and verification:**

1. Add an anonymous failing profile test and record RED before the export exists.
2. Perform local measurement in `mktemp -d`, encode normalized geometry, and run:

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry -- model-y-profile.test.ts
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry
mise x node@24.18.1 -- npm run typecheck --workspace=@sentry-check/camera-geometry
mise x node@24.18.1 -- npm run build --workspace=@sentry-check/camera-geometry
mise x node@24.18.1 -- npx biome check packages/camera-geometry/src packages/camera-geometry/tests
git diff --check
if rg -n '/Users/|UGREEN-NAS|[A-HJ-NPR-Z0-9]{17}|\.(mp4|jpg|jpeg|png)' packages/camera-geometry; then exit 1; fi
```

3. Manually import and validate/match the exported profile through the package public surface.
4. Commit: `feat: Model Y実測カメラプロファイルV2を追加`

---

### Task 3: Consumer Surface, Documentation, and Full Verification

**Files:**
- Create: `packages/camera-geometry/tests/consumer.test.ts`
- Modify: `docs/PROJECT_CONTEXT.md`
- Create: `docs/CAMERA_GEOMETRY_NOTES.md`
- Modify: `docs/superpowers/specs/2026-08-04-model-y-camera-geometry-design.md`

**Acceptance criteria:**

1. Public-consumer tests import only from `src/index` and exercise:
   - direct overlap plus reinforcement -> `contact`
   - complete direct coverage and clean clearance -> `no_contact_observed`
   - pillar-only/unresolved context or missing direct camera -> `indeterminate`
2. Document the four direct-contact and two context-only roles, 1% direct-anchor tolerance, full-six recording matching, structured coverage, and three-verdict semantics.
3. State that fixed placement improves repeatability but does not remove occlusion or blind spots. `no_contact_observed` means only that no contact finding was detected in sufficiently observed video; it is not a no-damage guarantee.
4. Record calibration and independent review as anonymous aggregate evidence only. Inventory totals must be labeled as measurement snapshots because the source inventory can grow during work.
5. State that the package does not yet perform object detection, segmentation, physical distance reconstruction, production contact decisions from raw video, or training-data reuse.
6. Run full verification:

```bash
mise x node@24.18.1 -- npm test --workspace=@sentry-check/camera-geometry
mise x node@24.18.1 -- npm run typecheck --workspace=@sentry-check/camera-geometry
mise x node@24.18.1 -- npm run build --workspace=@sentry-check/camera-geometry
mise x node@24.18.1 -- npm run check
mise x node@24.18.1 -- npm run cf:dry-run
mise x node@24.18.1 -- npx biome check packages/camera-geometry docs/PROJECT_CONTEXT.md docs/CAMERA_GEOMETRY_NOTES.md
git diff --check
```

7. Run a public-surface driver that validates/matches the measured profile and observes all three verdicts, including an unresolved-context fail-closed case.
8. Verify no media/private path/VIN is present and no generated artifact is tracked.
9. Commit: `docs: カメラ幾何V2の利用境界を追加`

---

### Task 4: Full Local TeslaCam Inventory Verification

**Files:**
- Create: `scripts/verify-camera-geometry-inventory.mjs`
- Create: `docs/CAMERA_GEOMETRY_REAL_DATA_REPORT.md`
- Modify: `package.json`

**Acceptance criteria:**

1. Add a reproducible local command that reads the source root only from `SENTRY_SOURCE_DIR`; no absolute source path is embedded in code, documentation, package scripts, logs, or commits.
2. Recursively enumerate every `.mp4` below the supplied source root and process every discovered file. Use bounded concurrency for `ffprobe`; do not copy or modify source media.
3. Aggregate without printing filenames, directory names, capture times, locations, faces, plates, VINs, or per-file paths:
   - total discovered MP4 files and total bytes
   - recognized and unrecognized Tesla camera suffix counts
   - complete and incomplete six-camera group counts
   - per-camera codec and resolution counts
   - readable/unreadable container counts
   - duration range and files shorter than the calibration frame position
   - format-compatible and format-incompatible counts with fixed aggregate reasons
4. Compare every readable recording's codec, dimensions, rotation/crop metadata when available, and camera role against the measured V2 profile. Do not manufacture direct-camera anchor errors. Report anchor verification and raw-video contact classification as not executed when no implemented detector/anchor extractor exists.
5. For each complete six-camera group, aggregate whether all six files pass the checks that can be derived from container metadata. Do not call the group fully profile-matched unless direct anchor drift was actually measured.
6. The command must finish with a machine-readable aggregate summary and a nonzero exit only for execution failure or unreadable source root. Data incompatibilities are reported as counts, not process crashes.
7. Add synthetic tests or a dry-run fixture path that proves filename grouping, aggregation, redaction, fixed reason ordering, and no per-file identifiers in output without using real media.
8. Run the command against the user-authorized local TeslaCam directory after all implementation is complete. Save only anonymous aggregate results to `docs/CAMERA_GEOMETRY_REAL_DATA_REPORT.md`.
9. State exact numerators and denominators, measurement snapshot timing, independence from the 12 calibration + 12 holdout selection, and every unverified layer.
10. Confirm the source directory is unchanged by comparing pre/post file count and total bytes, and confirm no media/derived images or source identifiers entered the repository.
11. Run root tests, typecheck, build, lint, Cloudflare dry-run, script synthetic verification, and `git diff --check` after adding the command/report.
12. Commit: `test: TeslaCam全在庫の匿名検証を追加`

The final report must separate these claims:

- verified for every file from container metadata;
- verified on the independent 12-group holdout for direct-camera geometry;
- manually spot-checked;
- not verified because upstream object detection, segmentation, tracking, anchor extraction, or raw-video contact classification is not implemented.

---

### Final Review

Review the entire branch from its merge-base through the final Task 4 commit. Treat false `contact`, false `no_contact_observed`, context-only geometry leakage, unvalidated role/provenance, media/PII leakage, unsafe types, incomplete inventory enumeration, misleading profile-match claims, source-media mutation, and missing full verification as merge blockers. Apply at most one consolidated fix wave, rerun affected verification, then perform one scoped re-review.
