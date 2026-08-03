import type {
  ManifestWarning,
  TeslaCamClip,
  TeslaCamEvent,
  TeslaCamManifest,
} from "@sentry-check/teslacam-parser";
import type { VideoPreflightCode, VideoPreflightResult } from "@sentry-check/video-preflight";
import { describe, expect, it } from "vitest";
import {
  buildUploadPlanV1,
  UPLOAD_PLAN_SCHEMA_VERSION,
  type UploadIneligibilityReason,
  type UploadPlanV1,
  type UploadPreflightRecordV1,
} from "../src/index";

const NON_READY_CODES = [
  "empty_file",
  "encrypted",
  "unsupported_codec",
  "missing_video_track",
  "invalid_container",
  "metadata_not_found",
] as const satisfies readonly Exclude<VideoPreflightCode, "ready">[];

const WARNING_CODE_ORDER = [
  "empty_file",
  "unknown_camera",
  "unknown_scope",
  "unrecognized_filename",
  "unsafe_path",
] as const satisfies readonly ManifestWarning["code"][];

type PreflightOverrides = Partial<Omit<VideoPreflightResult, "code">>;

function makeClip(overrides: Partial<TeslaCamClip> = {}): TeslaCamClip {
  const relativePath =
    overrides.relativePath ??
    "TeslaCam/SentryClips/2030-01-01_12-00-00/2030-01-01_11-59-59-front.mp4";
  return {
    camera: "front",
    cameraSuffix: "front",
    capturedAt: "2030-01-01T11:59:59",
    fingerprint: `${relativePath}:1000:1`,
    lastModified: 1,
    name: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    size: 1_000,
    source: "sentry",
    ...overrides,
  };
}

function makeEvent(id: string, clips: readonly TeslaCamClip[]): TeslaCamEvent {
  return {
    cameras: [...new Set(clips.map((clip) => clip.camera))],
    clipCount: clips.length,
    clips,
    id,
    selectedBytes: clips.reduce((total, clip) => total + clip.size, 0),
    source: "sentry",
  };
}

function makeManifest(
  events: readonly TeslaCamEvent[],
  warnings: readonly ManifestWarning[] = [],
): TeslaCamManifest {
  return {
    events,
    excluded: {
      eventPreviews: 0,
      nonVideoFiles: 0,
      recentClips: 0,
      savedClips: 0,
      unknownScope: 0,
      unsafePaths: 0,
    },
    totals: {
      clipCount: events.reduce((total, event) => total + event.clipCount, 0),
      eventCount: events.length,
      selectedBytes: events.reduce((total, event) => total + event.selectedBytes, 0),
    },
    warnings,
  };
}

function makeWarning(code: ManifestWarning["code"], relativePath: string): ManifestWarning {
  return { code, message: code, relativePath };
}

function makePreflight(
  code: VideoPreflightCode = "ready",
  overrides: PreflightOverrides = {},
): VideoPreflightResult {
  return {
    codec: "avc1.42c00a",
    durationSeconds: 10,
    encrypted: false,
    height: 960,
    scannedBytes: 1_024,
    width: 1_280,
    ...overrides,
    code,
  };
}

function makeRecord(
  fingerprint: string,
  result: VideoPreflightResult = makePreflight(),
): UploadPreflightRecordV1 {
  return { fingerprint, result };
}

function freezeManifest(input: TeslaCamManifest): TeslaCamManifest {
  for (const warning of input.warnings) {
    Object.freeze(warning);
  }
  for (const event of input.events) {
    for (const clip of event.clips) {
      Object.freeze(clip);
    }
    Object.freeze(event.cameras);
    Object.freeze(event.clips);
    Object.freeze(event);
  }
  Object.freeze(input.events);
  Object.freeze(input.excluded);
  Object.freeze(input.totals);
  Object.freeze(input.warnings);
  return Object.freeze(input);
}

function freezeRecords(
  input: readonly UploadPreflightRecordV1[],
): readonly UploadPreflightRecordV1[] {
  for (const record of input) {
    Object.freeze(record.result);
    Object.freeze(record);
  }
  return Object.freeze(input);
}

describe("buildUploadPlanV1", () => {
  it("builds the exact version 1 schema and eligible totals for ready clips", () => {
    const front = makeClip({
      fingerprint: "fingerprint-front",
      size: 1_500,
    });
    const back = makeClip({
      camera: "back",
      cameraSuffix: "back",
      fingerprint: "fingerprint-back",
      name: "2030-01-01_11-59-59-back.mp4",
      relativePath: "TeslaCam/SentryClips/2030-01-01_12-00-00/2030-01-01_11-59-59-back.mp4",
      size: 2_500,
    });
    const frontPreflight = makePreflight("ready", {
      durationSeconds: 1.25,
      scannedBytes: 0,
    });
    const backPreflight = makePreflight("ready", { durationSeconds: 2.75 });
    const manifest = makeManifest([makeEvent("event-ready", [front, back])]);

    const plan = buildUploadPlanV1(manifest, [
      makeRecord(front.fingerprint, frontPreflight),
      makeRecord(back.fingerprint, backPreflight),
    ]);

    const expected: UploadPlanV1 = {
      schemaVersion: 1,
      items: [
        {
          ineligibilityReason: null,
          camera: "front",
          capturedAt: front.capturedAt,
          eventId: "event-ready",
          fingerprint: front.fingerprint,
          name: front.name,
          preflight: frontPreflight,
          relativePath: front.relativePath,
          size: front.size,
          status: "eligible",
          warningCodes: [],
        },
        {
          ineligibilityReason: null,
          camera: "back",
          capturedAt: back.capturedAt,
          eventId: "event-ready",
          fingerprint: back.fingerprint,
          name: back.name,
          preflight: backPreflight,
          relativePath: back.relativePath,
          size: back.size,
          status: "eligible",
          warningCodes: [],
        },
      ],
      totals: {
        blockedClips: 0,
        eligibleBytes: 4_000,
        eligibleClips: 2,
        eligibleDurationSeconds: 4,
        pendingClips: 0,
        sourceClips: 2,
      },
    };
    expect(UPLOAD_PLAN_SCHEMA_VERSION).toBe(1);
    expect(plan).toEqual(expected);
  });

  it("keeps a clip pending when its preflight record is missing", () => {
    const clip = makeClip({ fingerprint: "missing-preflight" });

    const plan = buildUploadPlanV1(makeManifest([makeEvent("event-missing", [clip])]), []);

    expect(plan.items[0]).toMatchObject({
      ineligibilityReason: "missing_preflight",
      preflight: null,
      status: "pending",
    });
    expect(plan.totals).toEqual({
      blockedClips: 0,
      eligibleBytes: 0,
      eligibleClips: 0,
      eligibleDurationSeconds: 0,
      pendingClips: 1,
      sourceClips: 1,
    });
  });

  it("blocks every non-ready preflight code with the same reason", () => {
    const clips = NON_READY_CODES.map((code) =>
      makeClip({
        fingerprint: `fingerprint-${code}`,
        relativePath: `TeslaCam/SentryClips/event/${code}.mp4`,
      }),
    );
    const records = clips.map((clip, index) =>
      makeRecord(clip.fingerprint, makePreflight(NON_READY_CODES[index] ?? "metadata_not_found")),
    );

    const plan = buildUploadPlanV1(makeManifest([makeEvent("event-blocked", clips)]), records);

    expect(plan.items.map((item) => item.status)).toEqual(NON_READY_CODES.map(() => "blocked"));
    expect(plan.items.map((item) => item.ineligibilityReason)).toEqual(NON_READY_CODES);
    expect(plan.totals).toEqual({
      blockedClips: NON_READY_CODES.length,
      eligibleBytes: 0,
      eligibleClips: 0,
      eligibleDurationSeconds: 0,
      pendingClips: 0,
      sourceClips: NON_READY_CODES.length,
    });
  });

  it("keeps a ready unknown-camera clip eligible while carrying its warnings", () => {
    const clip = makeClip({
      camera: "unknown",
      cameraSuffix: "future_camera",
      fingerprint: "unknown-camera-ready",
      relativePath: "TeslaCam/SentryClips/event/future-camera.mp4",
    });
    const manifest = makeManifest(
      [makeEvent("event-unknown", [clip])],
      [
        makeWarning("unrecognized_filename", clip.relativePath),
        makeWarning("unknown_camera", clip.relativePath),
      ],
    );

    const plan = buildUploadPlanV1(manifest, [makeRecord(clip.fingerprint)]);

    expect(plan.items[0]).toMatchObject({
      ineligibilityReason: null,
      camera: "unknown",
      status: "eligible",
      warningCodes: ["unknown_camera", "unrecognized_filename"],
    });
    expect(plan.totals.eligibleClips).toBe(1);
  });

  it("keeps manifest event and clip order when preflight records arrive out of order", () => {
    const second = makeClip({
      fingerprint: "second",
      relativePath: "TeslaCam/SentryClips/z-event/second.mp4",
    });
    const first = makeClip({
      fingerprint: "first",
      relativePath: "TeslaCam/SentryClips/z-event/first.mp4",
    });
    const third = makeClip({
      fingerprint: "third",
      relativePath: "TeslaCam/SentryClips/a-event/third.mp4",
    });
    const manifest = makeManifest([
      makeEvent("z-event", [second, first]),
      makeEvent("a-event", [third]),
    ]);

    const plan = buildUploadPlanV1(manifest, [
      makeRecord(third.fingerprint, makePreflight("ready", { durationSeconds: 3 })),
      makeRecord(first.fingerprint, makePreflight("ready", { durationSeconds: 1 })),
      makeRecord(second.fingerprint, makePreflight("ready", { durationSeconds: 2 })),
    ]);

    expect(plan.items.map((item) => [item.eventId, item.fingerprint])).toEqual([
      ["z-event", "second"],
      ["z-event", "first"],
      ["a-event", "third"],
    ]);
    expect(plan.items.map((item) => item.preflight?.durationSeconds)).toEqual([2, 1, 3]);
  });

  it("blocks later manifest occurrences of the same fingerprint", () => {
    const first = makeClip({
      fingerprint: "duplicate-manifest",
      size: 1_200,
    });
    const later = makeClip({
      camera: "back",
      fingerprint: first.fingerprint,
      relativePath: "TeslaCam/SentryClips/other-event/later.mp4",
      size: 9_000,
    });
    const preflight = makePreflight("ready", { durationSeconds: 5 });
    const manifest = makeManifest([
      makeEvent("first-event", [first]),
      makeEvent("later-event", [later]),
    ]);

    const plan = buildUploadPlanV1(manifest, [makeRecord(first.fingerprint, preflight)]);

    expect(
      plan.items.map(({ ineligibilityReason, preflight: itemPreflight, status }) => ({
        ineligibilityReason,
        preflight: itemPreflight,
        status,
      })),
    ).toEqual([
      { ineligibilityReason: null, preflight, status: "eligible" },
      { ineligibilityReason: "duplicate_fingerprint", preflight, status: "blocked" },
    ]);
    expect(plan.totals).toEqual({
      blockedClips: 1,
      eligibleBytes: 1_200,
      eligibleClips: 1,
      eligibleDurationSeconds: 5,
      pendingClips: 0,
      sourceClips: 2,
    });
  });

  it("keeps manifest duplicate precedence after duplicate preflight records", () => {
    const first = makeClip({ fingerprint: "combined-duplicate" });
    const later = makeClip({
      fingerprint: first.fingerprint,
      relativePath: "TeslaCam/SentryClips/later-event/later.mp4",
    });
    const manifest = makeManifest([
      makeEvent("first-event", [first]),
      makeEvent("later-event", [later]),
    ]);

    const plan = buildUploadPlanV1(manifest, [
      makeRecord(first.fingerprint, makePreflight("ready")),
      makeRecord(first.fingerprint, makePreflight("encrypted")),
    ]);

    expect(plan.items.map((item) => item.ineligibilityReason)).toEqual([
      "duplicate_preflight",
      "duplicate_fingerprint",
    ]);
    expect(plan.items.map((item) => item.preflight)).toEqual([null, null]);
  });

  it("blocks a fingerprint with duplicate preflight records instead of choosing one", () => {
    const clip = makeClip({ fingerprint: "duplicate-preflight" });

    const plan = buildUploadPlanV1(makeManifest([makeEvent("event-duplicate", [clip])]), [
      makeRecord(clip.fingerprint, makePreflight("ready", { durationSeconds: 1 })),
      makeRecord(clip.fingerprint, makePreflight("encrypted", { durationSeconds: 2 })),
    ]);

    expect(plan.items[0]).toMatchObject({
      ineligibilityReason: "duplicate_preflight",
      preflight: null,
      status: "blocked",
    });
    expect(plan.totals.blockedClips).toBe(1);
    expect(plan.totals.eligibleClips).toBe(0);
  });

  const inconsistentReadyCases = [
    {
      expectedReason: "missing_video_track",
      name: "missing codec",
      overrides: { codec: null },
    },
    {
      expectedReason: "encrypted",
      name: "encrypted metadata",
      overrides: { encrypted: true },
    },
    {
      expectedReason: "unsupported_codec",
      name: "unsupported codec",
      overrides: { codec: "vp09" },
    },
    {
      expectedReason: "metadata_not_found",
      name: "missing dimensions",
      overrides: { width: null },
    },
    {
      expectedReason: "metadata_not_found",
      name: "zero duration",
      overrides: { durationSeconds: 0 },
    },
    {
      expectedReason: "metadata_not_found",
      name: "non-finite duration",
      overrides: { durationSeconds: Number.NaN },
    },
    {
      expectedReason: "metadata_not_found",
      name: "non-positive width",
      overrides: { width: -1 },
    },
    {
      expectedReason: "metadata_not_found",
      name: "non-finite height",
      overrides: { height: Number.POSITIVE_INFINITY },
    },
    {
      expectedReason: "metadata_not_found",
      name: "negative scanned byte count",
      overrides: { scannedBytes: -1 },
    },
    {
      expectedReason: "metadata_not_found",
      name: "non-finite scanned byte count",
      overrides: { scannedBytes: Number.NaN },
    },
  ] as const satisfies readonly {
    readonly expectedReason: UploadIneligibilityReason;
    readonly name: string;
    readonly overrides: PreflightOverrides;
  }[];

  it.each(inconsistentReadyCases)(
    "reclassifies a claimed ready result with $name as $expectedReason",
    ({ expectedReason, overrides }) => {
      const clip = makeClip({ fingerprint: `fake-ready-${expectedReason}` });

      const plan = buildUploadPlanV1(makeManifest([makeEvent("event-fake-ready", [clip])]), [
        makeRecord(clip.fingerprint, makePreflight("ready", overrides)),
      ]);

      expect(plan.items[0]).toMatchObject({
        ineligibilityReason: expectedReason,
        status: "blocked",
      });
      expect(plan.totals.eligibleClips).toBe(0);
    },
  );

  it("maps warnings by exact relative path, deduplicates them, and uses fixed order", () => {
    const clip = makeClip({
      fingerprint: "warning-order",
      relativePath: "TeslaCam/SentryClips/event/warnings.mp4",
    });
    const unrelatedPath = `${clip.relativePath}.different`;
    const manifest = makeManifest(
      [makeEvent("event-warnings", [clip])],
      [
        makeWarning("unsafe_path", clip.relativePath),
        makeWarning("unrecognized_filename", clip.relativePath),
        makeWarning("unknown_scope", clip.relativePath),
        makeWarning("empty_file", clip.relativePath),
        makeWarning("unknown_camera", clip.relativePath),
        makeWarning("unrecognized_filename", clip.relativePath),
        makeWarning("empty_file", unrelatedPath),
        makeWarning("unknown_scope", unrelatedPath),
        makeWarning("unsafe_path", unrelatedPath),
      ],
    );

    const plan = buildUploadPlanV1(manifest, [makeRecord(clip.fingerprint)]);

    expect(plan.items[0]).toMatchObject({
      ineligibilityReason: null,
      status: "eligible",
      warningCodes: WARNING_CODE_ORDER,
    });
  });

  it("ignores orphan preflight records, including duplicate orphan fingerprints", () => {
    const clip = makeClip({ fingerprint: "manifest-fingerprint" });
    const manifest = makeManifest([makeEvent("event-orphans", [clip])]);

    const plan = buildUploadPlanV1(manifest, [
      makeRecord("orphan-fingerprint", makePreflight("encrypted")),
      makeRecord(clip.fingerprint, makePreflight("ready", { durationSeconds: 7 })),
      makeRecord("orphan-fingerprint", makePreflight("ready")),
    ]);

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      ineligibilityReason: null,
      fingerprint: clip.fingerprint,
      status: "eligible",
    });
    expect(plan.totals).toMatchObject({
      blockedClips: 0,
      eligibleClips: 1,
      pendingClips: 0,
      sourceClips: 1,
    });
  });

  it("returns exact zero totals for an empty manifest", () => {
    const plan = buildUploadPlanV1(makeManifest([]), [makeRecord("orphan")]);

    expect(plan).toEqual({
      schemaVersion: 1,
      items: [],
      totals: {
        blockedClips: 0,
        eligibleBytes: 0,
        eligibleClips: 0,
        eligibleDurationSeconds: 0,
        pendingClips: 0,
        sourceClips: 0,
      },
    });
  });

  it("does not mutate frozen manifest or preflight inputs", () => {
    const first = makeClip({
      fingerprint: "immutable-first",
      relativePath: "TeslaCam/SentryClips/event/immutable-first.mp4",
    });
    const second = makeClip({
      fingerprint: "immutable-second",
      relativePath: "TeslaCam/SentryClips/event/immutable-second.mp4",
    });
    const inputManifest = makeManifest(
      [makeEvent("event-immutable", [first, second])],
      [makeWarning("unknown_camera", second.relativePath)],
    );
    const inputRecords = [
      makeRecord(second.fingerprint, makePreflight("ready", { durationSeconds: 2 })),
      makeRecord(first.fingerprint, makePreflight("ready", { durationSeconds: 1 })),
    ];
    const manifestSnapshot = structuredClone(inputManifest);
    const recordsSnapshot = structuredClone(inputRecords);
    freezeManifest(inputManifest);
    freezeRecords(inputRecords);

    const plan = buildUploadPlanV1(inputManifest, inputRecords);

    expect(inputManifest).toEqual(manifestSnapshot);
    expect(inputRecords).toEqual(recordsSnapshot);
    expect(plan.items.map((item) => item.fingerprint)).toEqual([
      "immutable-first",
      "immutable-second",
    ]);
  });
});
