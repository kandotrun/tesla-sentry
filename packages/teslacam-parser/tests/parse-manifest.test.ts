import { describe, expect, it } from "vitest";
import { type LocalFileDescriptor, parseTeslaCamManifest } from "../src/index";

const MiB = 1024 * 1024;

function clip(
  relativePath: string,
  size = 2 * MiB,
  lastModified = 1_786_000_000_000,
): LocalFileDescriptor {
  return {
    name: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    size,
    lastModified,
    type: "video/mp4",
  };
}

describe("parseTeslaCamManifest", () => {
  it("groups the four camera clips in a SentryClips directory into one event", () => {
    const eventPath = "TeslaCam/SentryClips/2026-08-03_12-34-56";
    const files = [
      clip(`${eventPath}/2026-08-03_12-32-00-front.mp4`),
      clip(`${eventPath}/2026-08-03_12-32-00-back.mp4`),
      clip(`${eventPath}/2026-08-03_12-32-00-left_repeater.mp4`),
      clip(`${eventPath}/2026-08-03_12-32-00-right_repeater.mp4`),
    ];

    const manifest = parseTeslaCamManifest(files);

    expect(manifest.totals).toEqual({
      eventCount: 1,
      clipCount: 4,
      selectedBytes: 8 * MiB,
    });
    expect(manifest.events[0]).toMatchObject({
      id: "2026-08-03_12-34-56",
      source: "sentry",
      clipCount: 4,
      cameras: ["back", "front", "left_repeater", "right_repeater"],
    });
    expect(manifest.events[0]?.clips[0]?.capturedAt).toBe("2026-08-03T12:32:00");
    expect(manifest.warnings).toEqual([]);
  });

  it("selects SentryClips and excludes RecentClips and SavedClips by default", () => {
    const files = [
      clip("SentryClips/2026-08-03_12-34-56/2026-08-03_12-32-00-front.mp4"),
      clip("TeslaCam/RecentClips/2026-08-03_12-33-00-front.mp4"),
      clip("TeslaCam/SavedClips/2026-08-03_12-31-00/2026-08-03_12-31-00-front.mp4"),
      clip("TeslaCam/FutureClips/2026-08-03_12-35-00-front.mp4"),
      {
        name: "event.json",
        relativePath: "TeslaCam/SentryClips/2026-08-03_12-34-56/event.json",
        size: 128,
        lastModified: 1_786_000_000_000,
        type: "application/json",
      },
    ];

    const manifest = parseTeslaCamManifest(files);

    expect(manifest.totals.clipCount).toBe(1);
    expect(manifest.excluded).toEqual({
      eventPreviews: 0,
      recentClips: 1,
      savedClips: 1,
      nonVideoFiles: 1,
      unknownScope: 1,
      unsafePaths: 0,
    });
    expect(manifest.warnings).toContainEqual(expect.objectContaining({ code: "unknown_scope" }));
  });

  it("supports selecting SentryClips itself instead of its TeslaCam parent", () => {
    const files = [clip("SentryClips/2026-08-03_12-34-56/2026-08-03_12-32-00-front.mp4", MiB)];

    const manifest = parseTeslaCamManifest(files);

    expect(manifest.totals).toMatchObject({ eventCount: 1, clipCount: 1 });
    expect(manifest.events[0]?.id).toBe("2026-08-03_12-34-56");
  });

  it("recognizes AI4 pillar cameras and the legacy rear_view alias", () => {
    const eventPath = "TeslaCam/SentryClips/2026-08-03_12-34-56";
    const manifest = parseTeslaCamManifest([
      clip(`${eventPath}/2026-08-03_12-32-00-left_pillar.mp4`),
      clip(`${eventPath}/2026-08-03_12-32-00-right_pillar.mp4`),
      clip(`${eventPath}/2026-08-03_12-32-00-rear_view.mp4`),
    ]);

    expect(manifest.events[0]?.cameras).toEqual(["back", "left_pillar", "right_pillar"]);
    expect(manifest.events[0]?.clips.map((item) => item.camera)).toEqual([
      "back",
      "left_pillar",
      "right_pillar",
    ]);
    expect(manifest.warnings).toEqual([]);
  });

  it("keeps a timestamped unknown camera suffix and warns about it", () => {
    const manifest = parseTeslaCamManifest([
      clip("TeslaCam/SentryClips/2026-08-03_12-34-56/2026-08-03_12-32-00-front_bumper.mp4"),
    ]);

    expect(manifest.events[0]?.clips[0]).toMatchObject({
      camera: "unknown",
      cameraSuffix: "front_bumper",
    });
    expect(manifest.warnings).toContainEqual(expect.objectContaining({ code: "unknown_camera" }));
  });

  it("excludes a Tesla-generated event preview from Sentry camera clips", () => {
    const eventPath = "TeslaCam/SentryClips/2030-01-01_12-00-00";
    const manifest = parseTeslaCamManifest([
      clip(`${eventPath}/2030-01-01_11-59-59-front.mp4`),
      clip(`${eventPath}/EVENT.MP4`),
      clip("TeslaCam/SavedClips/2030-01-01_12-00-00/event.mp4"),
    ]);

    expect(manifest.totals).toMatchObject({ eventCount: 1, clipCount: 1 });
    expect(manifest.excluded.eventPreviews).toBe(1);
    expect(manifest.excluded.savedClips).toBe(1);
    expect(manifest.events[0]?.clips.map((item) => item.name)).toEqual([
      "2030-01-01_11-59-59-front.mp4",
    ]);
    expect(manifest.warnings).toEqual([]);
  });

  it("keeps similarly named Sentry MP4s visible instead of treating them as previews", () => {
    const manifest = parseTeslaCamManifest([
      clip("TeslaCam/SentryClips/synthetic-event/my-event.mp4"),
      clip("TeslaCam/SentryClips/synthetic-event/previews/event.mp4"),
    ]);

    expect(manifest.excluded.eventPreviews).toBe(0);
    expect(manifest.totals.clipCount).toBe(2);
    expect(manifest.warnings).toContainEqual(
      expect.objectContaining({ code: "unrecognized_filename" }),
    );
  });

  it("matches the anonymized seven-event TeslaCam inventory shape", () => {
    const cameras = [
      "back",
      "front",
      "left_pillar",
      "left_repeater",
      "right_pillar",
      "right_repeater",
    ] as const;
    const files = Array.from({ length: 7 }, (_, eventIndex) => {
      const day = String(eventIndex + 1).padStart(2, "0");
      const eventPath = `TeslaCam/SentryClips/2030-01-${day}_12-00-00`;
      const timestampCount = eventIndex === 6 ? 7 : 11;
      const cameraClips = Array.from({ length: timestampCount }, (_, timestampIndex) => {
        const second = String(timestampIndex).padStart(2, "0");
        return cameras.map((camera) =>
          clip(`${eventPath}/2030-01-${day}_11-59-${second}-${camera}.mp4`, MiB),
        );
      }).flat();
      return [...cameraClips, clip(`${eventPath}/event.mp4`, 512 * 1024)];
    }).flat();

    const manifest = parseTeslaCamManifest(files);
    const cameraCounts = Object.fromEntries(
      cameras.map((camera) => [
        camera,
        manifest.events.flatMap((event) => event.clips).filter((item) => item.camera === camera)
          .length,
      ]),
    );

    expect(files).toHaveLength(445);
    expect(manifest.totals).toEqual({
      eventCount: 7,
      clipCount: 438,
      selectedBytes: 438 * MiB,
    });
    expect(manifest.excluded).toEqual({
      eventPreviews: 7,
      recentClips: 0,
      savedClips: 0,
      nonVideoFiles: 0,
      unknownScope: 0,
      unsafePaths: 0,
    });
    expect(manifest.events.map((event) => event.clipCount)).toEqual([42, 66, 66, 66, 66, 66, 66]);
    expect(cameraCounts).toEqual({
      back: 73,
      front: 73,
      left_pillar: 73,
      left_repeater: 73,
      right_pillar: 73,
      right_repeater: 73,
    });
    expect(
      manifest.events.flatMap((event) => event.clips).some((item) => item.name === "event.mp4"),
    ).toBe(false);
    expect(manifest.warnings).toEqual([]);
  });

  it("keeps an unrecognized Sentry MP4 visible and warns instead of silently dropping it", () => {
    const files = [clip("TeslaCam/SentryClips/custom-event/unexpected-camera-name.mp4", 0)];

    const manifest = parseTeslaCamManifest(files);

    expect(manifest.totals.clipCount).toBe(1);
    expect(manifest.events[0]).toMatchObject({
      id: "custom-event",
      cameras: ["unknown"],
    });
    expect(manifest.warnings.map((warning) => warning.code)).toEqual([
      "unrecognized_filename",
      "empty_file",
    ]);
  });

  it("keeps multiple unrecognized MP4s directly under SentryClips as separate stable events", () => {
    const manifest = parseTeslaCamManifest([
      clip("TeslaCam/SentryClips/unexpected-front.mp4"),
      clip("TeslaCam/SentryClips/unexpected-back.mp4"),
    ]);

    expect(manifest.totals).toMatchObject({ eventCount: 2, clipCount: 2 });
    expect(manifest.events.map((event) => event.clipCount)).toEqual([1, 1]);
    expect(manifest.events.map((event) => event.id).toSorted()).toEqual([
      "unexpected-back.mp4",
      "unexpected-front.mp4",
    ]);
  });

  it("rejects paths containing traversal segments", () => {
    const manifest = parseTeslaCamManifest([
      clip("TeslaCam/SentryClips/../../private/2026-08-03_12-32-00-front.mp4"),
    ]);

    expect(manifest.totals.clipCount).toBe(0);
    expect(manifest.excluded.unsafePaths).toBe(1);
    expect(manifest.warnings[0]?.code).toBe("unsafe_path");
  });

  it("organizes more than one hundred clips without changing the event boundary", () => {
    const files = Array.from({ length: 30 }, (_, eventIndex) => {
      const second = String(eventIndex).padStart(2, "0");
      const eventPath = `TeslaCam/SentryClips/2026-08-03_12-34-${second}`;
      return ["front", "back", "left_repeater", "right_repeater"].map((camera) =>
        clip(`${eventPath}/2026-08-03_12-32-${second}-${camera}.mp4`, MiB),
      );
    }).flat();

    const manifest = parseTeslaCamManifest(files);

    expect(manifest.totals).toEqual({
      eventCount: 30,
      clipCount: 120,
      selectedBytes: 120 * MiB,
    });
  });
});
