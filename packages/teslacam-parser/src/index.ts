export type TeslaCamSource = "sentry" | "saved" | "recent" | "unknown";

export type KnownTeslaCamera =
  | "back"
  | "front"
  | "left_pillar"
  | "left_repeater"
  | "right_pillar"
  | "right_repeater";

export type TeslaCamera = KnownTeslaCamera | "unknown";

export interface LocalFileDescriptor {
  readonly name: string;
  readonly relativePath: string;
  readonly size: number;
  readonly lastModified: number;
  readonly type?: string;
}

export interface ManifestWarning {
  readonly code:
    | "empty_file"
    | "unknown_camera"
    | "unknown_scope"
    | "unrecognized_filename"
    | "unsafe_path";
  readonly relativePath: string;
  readonly message: string;
}

export interface TeslaCamClip {
  readonly camera: TeslaCamera;
  readonly cameraSuffix: string | null;
  readonly capturedAt: string | null;
  readonly fingerprint: string;
  readonly lastModified: number;
  readonly name: string;
  readonly relativePath: string;
  readonly size: number;
  readonly source: "sentry";
}

export interface TeslaCamEvent {
  readonly cameras: readonly TeslaCamera[];
  readonly clipCount: number;
  readonly clips: readonly TeslaCamClip[];
  readonly id: string;
  readonly selectedBytes: number;
  readonly source: "sentry";
}

export interface TeslaCamManifest {
  readonly events: readonly TeslaCamEvent[];
  readonly excluded: {
    readonly eventPreviews: number;
    readonly nonVideoFiles: number;
    readonly recentClips: number;
    readonly savedClips: number;
    readonly unknownScope: number;
    readonly unsafePaths: number;
  };
  readonly totals: {
    readonly clipCount: number;
    readonly eventCount: number;
    readonly selectedBytes: number;
  };
  readonly warnings: readonly ManifestWarning[];
}

const CAMERA_ORDER: readonly TeslaCamera[] = [
  "back",
  "front",
  "left_pillar",
  "left_repeater",
  "right_pillar",
  "right_repeater",
  "unknown",
];

const CAMERA_NAMES = new Set<KnownTeslaCamera>([
  "back",
  "front",
  "left_pillar",
  "left_repeater",
  "right_pillar",
  "right_repeater",
]);

const SOURCE_SEGMENTS = new Map<string, TeslaCamSource>([
  ["sentryclips", "sentry"],
  ["savedclips", "saved"],
  ["recentclips", "recent"],
]);

const CLIP_FILENAME = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(.+)\.mp4$/i;

interface ParsedPath {
  readonly eventId: string;
  readonly hasDirectEventFile: boolean;
  readonly source: TeslaCamSource;
}

interface ParsedFilename {
  readonly camera: TeslaCamera;
  readonly cameraSuffix: string;
  readonly capturedAt: string;
}

function normalizePath(relativePath: string): readonly string[] {
  return relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
}

function parsePath(segments: readonly string[], parsedFilename: ParsedFilename | null): ParsedPath {
  const sourceIndex = segments.findIndex((segment) => SOURCE_SEGMENTS.has(segment.toLowerCase()));
  if (sourceIndex < 0) {
    return {
      eventId: parsedFilename?.capturedAt.replace("T", "_").replaceAll(":", "-") ?? "unknown",
      hasDirectEventFile: false,
      source: "unknown",
    };
  }

  const source = SOURCE_SEGMENTS.get(segments[sourceIndex]?.toLowerCase() ?? "") ?? "unknown";
  const eventDirectory = segments[sourceIndex + 1];
  const hasEventDirectory = sourceIndex + 2 < segments.length;
  const hasDirectEventFile = sourceIndex + 2 === segments.length - 1;
  const eventId = hasEventDirectory
    ? (eventDirectory ?? "unknown")
    : (parsedFilename?.capturedAt.replace("T", "_").replaceAll(":", "-") ??
      segments.at(-1) ??
      "unknown");

  return { eventId, hasDirectEventFile, source };
}

function parseFilename(filename: string): ParsedFilename | null {
  const match = CLIP_FILENAME.exec(filename);
  if (!match) {
    return null;
  }

  const [, date, hour, minute, second, cameraName] = match;
  const cameraSuffix = cameraName?.toLowerCase() ?? "unknown";
  const canonicalCamera = cameraSuffix === "rear_view" ? "back" : cameraSuffix;
  const camera = CAMERA_NAMES.has(canonicalCamera as KnownTeslaCamera)
    ? (canonicalCamera as KnownTeslaCamera)
    : "unknown";

  return {
    camera,
    cameraSuffix,
    capturedAt: `${date}T${hour}:${minute}:${second}`,
  };
}

function compareCameras(left: TeslaCamera, right: TeslaCamera): number {
  return CAMERA_ORDER.indexOf(left) - CAMERA_ORDER.indexOf(right);
}

function compareClips(left: TeslaCamClip, right: TeslaCamClip): number {
  return (
    (left.capturedAt ?? "").localeCompare(right.capturedAt ?? "") ||
    compareCameras(left.camera, right.camera) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}

export function parseTeslaCamManifest(files: readonly LocalFileDescriptor[]): TeslaCamManifest {
  const clipsByEvent = new Map<string, TeslaCamClip[]>();
  const warnings: ManifestWarning[] = [];
  const excluded = {
    eventPreviews: 0,
    recentClips: 0,
    savedClips: 0,
    nonVideoFiles: 0,
    unknownScope: 0,
    unsafePaths: 0,
  };

  for (const file of files) {
    const segments = normalizePath(file.relativePath);
    if (segments.includes("..")) {
      excluded.unsafePaths += 1;
      warnings.push({
        code: "unsafe_path",
        relativePath: file.relativePath,
        message: "Path traversal segment is not accepted.",
      });
      continue;
    }

    const filename = segments.at(-1) ?? file.name;
    const isMp4 = filename.toLowerCase().endsWith(".mp4");
    const parsedFilename = isMp4 ? parseFilename(filename) : null;
    const parsedPath = parsePath(segments, parsedFilename);

    if (!isMp4) {
      excluded.nonVideoFiles += 1;
      continue;
    }
    if (parsedPath.source === "recent") {
      excluded.recentClips += 1;
      continue;
    }
    if (parsedPath.source === "saved") {
      excluded.savedClips += 1;
      continue;
    }
    if (parsedPath.source !== "sentry") {
      excluded.unknownScope += 1;
      warnings.push({
        code: "unknown_scope",
        relativePath: file.relativePath,
        message: "The MP4 is outside a recognized TeslaCam clip folder.",
      });
      continue;
    }
    if (parsedPath.hasDirectEventFile && filename.toLowerCase() === "event.mp4") {
      excluded.eventPreviews += 1;
      continue;
    }

    if (!parsedFilename) {
      warnings.push({
        code: "unrecognized_filename",
        relativePath: file.relativePath,
        message: "The clip filename does not match a known TeslaCam pattern.",
      });
    }
    if (parsedFilename?.camera === "unknown") {
      warnings.push({
        code: "unknown_camera",
        relativePath: file.relativePath,
        message: `The camera suffix '${parsedFilename.cameraSuffix}' is not recognized yet.`,
      });
    }
    if (file.size === 0) {
      warnings.push({
        code: "empty_file",
        relativePath: file.relativePath,
        message: "The clip is empty and cannot be analyzed.",
      });
    }

    const clip: TeslaCamClip = {
      camera: parsedFilename?.camera ?? "unknown",
      cameraSuffix: parsedFilename?.cameraSuffix ?? null,
      capturedAt: parsedFilename?.capturedAt ?? null,
      fingerprint: `${file.relativePath}:${file.size}:${file.lastModified}`,
      lastModified: file.lastModified,
      name: file.name,
      relativePath: file.relativePath,
      size: file.size,
      source: "sentry",
    };
    const eventClips = clipsByEvent.get(parsedPath.eventId) ?? [];
    eventClips.push(clip);
    clipsByEvent.set(parsedPath.eventId, eventClips);
  }

  const events = [...clipsByEvent.entries()]
    .map(([id, clips]): TeslaCamEvent => {
      const sortedClips = clips.toSorted(compareClips);
      const cameras = [...new Set(sortedClips.map((clip) => clip.camera))].toSorted(compareCameras);
      return {
        cameras,
        clipCount: sortedClips.length,
        clips: sortedClips,
        id,
        selectedBytes: sortedClips.reduce((total, clip) => total + clip.size, 0),
        source: "sentry",
      };
    })
    .toSorted((left, right) => right.id.localeCompare(left.id));

  return {
    events,
    excluded,
    totals: {
      eventCount: events.length,
      clipCount: events.reduce((total, event) => total + event.clipCount, 0),
      selectedBytes: events.reduce((total, event) => total + event.selectedBytes, 0),
    },
    warnings,
  };
}
