import CAMERA_GEOMETRY_VIDEO_CONTRACT from "../../packages/camera-geometry/src/model-y-2025-plus-video-contract.json" with {
  type: "json",
};

const PROFILE_ID = CAMERA_GEOMETRY_VIDEO_CONTRACT.profileId;
const CAMERA_METADATA = CAMERA_GEOMETRY_VIDEO_CONTRACT.cameras;
const CAMERAS = Object.keys(CAMERA_METADATA);
const INCOMPATIBILITY_REASON_ORDER = [
  "unrecognized_filename",
  "probe_failed",
  "missing_video_stream",
  "codec_mismatch",
  "resolution_mismatch",
  "rotation_mismatch",
  "cropped_input",
  "incomplete_group",
  "duplicate_camera",
];

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}

function orderedCounts(record) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function metadataReasons(camera, probeResult) {
  if (probeResult.kind === "probe_failed") {
    return ["probe_failed"];
  }
  if (probeResult.video === null) {
    return ["missing_video_stream"];
  }
  const expected = CAMERA_METADATA[camera];
  const reasons = [];
  if (probeResult.video.codec !== expected.codec) {
    reasons.push("codec_mismatch");
  }
  if (probeResult.video.width !== expected.width || probeResult.video.height !== expected.height) {
    reasons.push("resolution_mismatch");
  }
  if (probeResult.video.rotationDegrees !== 0) {
    reasons.push("rotation_mismatch");
  }
  if (probeResult.video.cropped !== false) {
    reasons.push("cropped_input");
  }
  return reasons;
}

function createCameraCounts() {
  return Object.fromEntries(
    CAMERAS.map((camera) => [camera, { codecs: {}, files: 0, resolutions: {} }]),
  );
}

function countGroups(groups, reasonCounts) {
  let complete = 0;
  let duplicate = 0;
  let incomplete = 0;
  let metadataCompatible = 0;
  for (const group of groups.values()) {
    const cameraSet = new Set(group.map(({ camera }) => camera));
    const hasDuplicate = cameraSet.size !== group.length;
    const hasAllCameras = CAMERAS.every((camera) => cameraSet.has(camera));
    if (hasDuplicate) {
      duplicate += 1;
      reasonCounts.duplicate_camera += 1;
    } else if (!hasAllCameras) {
      incomplete += 1;
      reasonCounts.incomplete_group += 1;
    } else {
      complete += 1;
      if (group.every(({ compatible }) => compatible)) {
        metadataCompatible += 1;
      }
    }
  }
  return { complete, duplicate, incomplete, metadataCompatible, total: groups.size };
}

export function aggregateCameraGeometryInventory(files) {
  const reasonCounts = Object.fromEntries(
    INCOMPATIBILITY_REASON_ORDER.map((reason) => [reason, 0]),
  );
  const cameraCounts = createCameraCounts();
  const groups = new Map();
  const durations = [];
  let readableFiles = 0;
  let shortClips = 0;
  let metadataCompatibleFiles = 0;

  for (const file of files) {
    if (file.probeResult.kind === "probe_failed") {
      reasonCounts.probe_failed += 1;
    } else {
      readableFiles += 1;
      const video = file.probeResult.video;
      if (video !== null && Number.isFinite(video.durationSeconds)) {
        durations.push(video.durationSeconds);
        if (video.durationSeconds < 50) {
          shortClips += 1;
        }
      }
    }

    if (file.parsed === null) {
      reasonCounts.unrecognized_filename += 1;
      continue;
    }

    const { camera, groupKey } = file.parsed;
    const perCamera = cameraCounts[camera];
    perCamera.files += 1;
    if (file.probeResult.kind === "readable" && file.probeResult.video !== null) {
      increment(perCamera.codecs, file.probeResult.video.codec);
      increment(
        perCamera.resolutions,
        `${file.probeResult.video.width}x${file.probeResult.video.height}`,
      );
    }
    const reasons = metadataReasons(camera, file.probeResult);
    for (const reason of reasons) {
      if (reason !== "probe_failed") {
        reasonCounts[reason] += 1;
      }
    }
    const compatible = reasons.length === 0;
    if (compatible) {
      metadataCompatibleFiles += 1;
    }
    const group = groups.get(groupKey) ?? [];
    group.push({ camera, compatible });
    groups.set(groupKey, group);
  }

  for (const camera of CAMERAS) {
    cameraCounts[camera].codecs = orderedCounts(cameraCounts[camera].codecs);
    cameraCounts[camera].resolutions = orderedCounts(cameraCounts[camera].resolutions);
  }

  return {
    cameras: cameraCounts,
    groups: countGroups(groups, reasonCounts),
    incompatibilityReasons: INCOMPATIBILITY_REASON_ORDER.map((reason) => ({
      count: reasonCounts[reason],
      reason,
    })),
    inventory: {
      durationSeconds: {
        max: durations.length === 0 ? null : Math.max(...durations),
        min: durations.length === 0 ? null : Math.min(...durations),
      },
      readableFiles,
      recognizedSuffixFiles: files.length - reasonCounts.unrecognized_filename,
      shortClipsUnder50Seconds: shortClips,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      totalFiles: files.length,
      unknownSuffixFiles: reasonCounts.unrecognized_filename,
      unreadableFiles: files.length - readableFiles,
    },
    metadataCompatibleFiles,
    profileId: PROFILE_ID,
  };
}
