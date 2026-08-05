import { describe, expect, it } from "vitest";
import {
  evaluateFrameGeometry,
  matchVehicleCameraProfileV2,
  minimumDistanceToSegments,
  pointInPolygon,
  polygonIntersectsSegment,
  polygonsIntersect,
} from "../src/index";
import {
  CONTEXT_CAMERAS,
  makeContextCamera,
  makeGeometryCamera,
  makeProfile,
  observation,
  point,
  polygon,
  recordingDescriptors,
  square,
} from "./fixtures";

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  return null;
}

describe("evaluateFrameGeometry", () => {
  it("returns direct-contact provenance for a contact-capable camera", () => {
    const profile = makeProfile();
    const profileMatch = matchVehicleCameraProfileV2(profile, recordingDescriptors());
    if (profileMatch.kind !== "matched") {
      throw new TypeError("profile must match the recording descriptors");
    }
    const result = evaluateFrameGeometry(profile, observation(square(0.05, 0.05, 0.1)));

    expect(result).toMatchObject({
      camera: "left_repeater",
      intersectsBlindZone: false,
      profileGeometryFingerprint: profileMatch.profileGeometryFingerprint,
      profileId: profileMatch.profileId,
      profileSchemaVersion: profileMatch.schemaVersion,
      source: "contact_geometry",
      state: "outside",
    });
    expect(Number.isFinite(result.minimumBoundaryDistanceNormalized)).toBe(true);
  });

  it("returns near when the object enters only the near-body zone", () => {
    expect(
      evaluateFrameGeometry(makeProfile(), observation(square(0.31, 0.31, 0.05))),
    ).toMatchObject({ state: "near" });
  });

  it("returns boundary_overlap when the object crosses the contact boundary", () => {
    expect(
      evaluateFrameGeometry(makeProfile(), observation(square(0.38, 0.45, 0.05))),
    ).toMatchObject({ state: "boundary_overlap" });
  });

  it("returns boundary_overlap when the object enters the self-vehicle mask", () => {
    expect(
      evaluateFrameGeometry(makeProfile(), observation(square(0.45, 0.45, 0.05))),
    ).toMatchObject({ state: "boundary_overlap" });
  });

  it("gives occlusion precedence over an apparent overlap", () => {
    const input = observation(square(0.38, 0.45, 0.05), { boundaryOcclusionRatio: 0.051 });

    expect(evaluateFrameGeometry(makeProfile(), input)).toMatchObject({
      state: "occluded",
    });
  });

  it("reports a blind-zone intersection independently of proximity", () => {
    expect(
      evaluateFrameGeometry(makeProfile(), observation(square(0.82, 0.82, 0.05))),
    ).toMatchObject({ intersectsBlindZone: true, state: "outside" });
  });

  it.each(CONTEXT_CAMERAS)(
    "rejects the %s context-only profile before geometry calculation",
    (camera) => {
      const invalidObservation = observation(polygon(point(0.1, 0.1), point(0.2, 0.2)));

      const error = captureError(() =>
        Reflect.apply(evaluateFrameGeometry, undefined, [
          makeContextCamera(camera),
          invalidObservation,
        ]),
      );

      expect(error).toEqual(new TypeError("profile must be a valid V2 vehicle camera profile"));
    },
  );

  it.each(CONTEXT_CAMERAS)("rejects the %s observation before geometry calculation", (camera) => {
    const invalidObservation = {
      ...observation(polygon(point(0.1, 0.1), point(0.2, 0.2))),
      camera,
    };

    const error = captureError(() =>
      Reflect.apply(evaluateFrameGeometry, undefined, [makeProfile(), invalidObservation]),
    );

    expect(error).toEqual(new TypeError("observation camera must be contact capable"));
  });

  it.each(CONTEXT_CAMERAS)(
    "rejects a forged contact profile assigned to the %s camera",
    (camera) => {
      const forgedProfile = { ...makeGeometryCamera(), camera };

      const error = captureError(() =>
        Reflect.apply(evaluateFrameGeometry, undefined, [
          forgedProfile,
          observation(square(0.05, 0.05, 0.1)),
        ]),
      );

      expect(error).toEqual(new TypeError("profile must be a valid V2 vehicle camera profile"));
    },
  );

  it("does not mutate profile or observation inputs", () => {
    const profile = makeProfile();
    const input = observation(square(0.31, 0.31, 0.05));
    const profileBefore = structuredClone(profile);
    const inputBefore = structuredClone(input);

    evaluateFrameGeometry(profile, input);

    expect(profile).toEqual(profileBefore);
    expect(input).toEqual(inputBefore);
  });

  it("rejects an empty contact boundary", () => {
    const profile = structuredClone(makeProfile());
    const leftRepeater = profile.cameras.find((camera) => camera.camera === "left_repeater");
    if (leftRepeater?.kind !== "contact_geometry") {
      throw new TypeError("left repeater must provide contact geometry");
    }
    Reflect.set(leftRepeater, "contactBoundary", []);

    const error = captureError(() =>
      evaluateFrameGeometry(profile, observation(square(0.05, 0.05, 0.1))),
    );

    expect(error).toEqual(new TypeError("profile must be a valid V2 vehicle camera profile"));
  });

  it("selects the contact geometry matching the observation camera", () => {
    const profile = makeProfile();
    const input = observation(square(0.05, 0.05, 0.1), { camera: "right_repeater" });

    expect(evaluateFrameGeometry(profile, input)).toMatchObject({
      camera: "right_repeater",
      profileId: profile.profileId,
      profileSchemaVersion: profile.schemaVersion,
    });
  });

  it.each([
    { label: "NaN", value: Number.NaN },
    { label: "negative", value: -0.01 },
    { label: "above one", value: 1.01 },
  ])("rejects a $label boundary occlusion ratio", ({ value }) => {
    const input = { ...observation(square(0.05, 0.05, 0.1)), boundaryOcclusionRatio: value };

    const error = captureError(() => evaluateFrameGeometry(makeProfile(), input));

    expect(error).toEqual(
      new RangeError("boundaryOcclusionRatio must be finite and between 0 and 1"),
    );
  });

  it.each([
    { label: "NaN", value: Number.NaN },
    { label: "negative", value: -1 },
  ])("rejects a $label frame timestamp", ({ value }) => {
    const input = { ...observation(square(0.05, 0.05, 0.1)), frameTimestampMs: value };

    const error = captureError(() => evaluateFrameGeometry(makeProfile(), input));

    expect(error).toEqual(new RangeError("frameTimestampMs must be finite and non-negative"));
  });

  it.each([
    {
      label: "too few points",
      mask: polygon(point(0.1, 0.1), point(0.2, 0.2)),
      message: "polygon must contain at least three points",
    },
    {
      label: "non-finite coordinate",
      mask: polygon(point(0.1, 0.1), point(Number.NaN, 0.2), point(0.1, 0.3)),
      message: "polygon coordinates must be finite and normalized",
    },
    {
      label: "coordinate outside the normalized range",
      mask: polygon(point(0.1, 0.1), point(1.01, 0.2), point(0.1, 0.3)),
      message: "polygon coordinates must be finite and normalized",
    },
    {
      label: "zero area",
      mask: polygon(point(0.1, 0.1), point(0.2, 0.2), point(0.3, 0.3)),
      message: "polygon must have non-zero area",
    },
  ])("rejects an object mask with $label", ({ mask, message }) => {
    const error = captureError(() => evaluateFrameGeometry(makeProfile(), observation(mask)));

    expect(error).toEqual(new RangeError(message));
  });
});

describe("polygon boundary stability", () => {
  const slopedPolygon = polygon(point(0.1, 0.1), point(0.7, 0.4), point(0.8, 0.5), point(0, 0.2));

  it("treats a roundoff-limited point on a sloped edge as contact", () => {
    const edgePoint = point(0.4, 0.25);
    const touchingSegment = { from: edgePoint, to: point(0.4, 0.2) };

    expect(pointInPolygon(edgePoint, slopedPolygon)).toBe(true);
    expect(polygonIntersectsSegment(slopedPolygon, touchingSegment)).toBe(true);
    expect(minimumDistanceToSegments(slopedPolygon, [touchingSegment])).toBe(0);
  });

  it("does not promote a nearby point outside the sloped edge to contact", () => {
    const outsidePoint = point(0.4, 0.25 - 1e-12);
    const outsideSegment = { from: outsidePoint, to: point(0.4, 0.2) };

    expect(pointInPolygon(outsidePoint, slopedPolygon)).toBe(false);
    expect(polygonIntersectsSegment(slopedPolygon, outsideSegment)).toBe(false);
    expect(minimumDistanceToSegments(slopedPolygon, [outsideSegment])).toBeGreaterThan(0);
  });
});

describe("polygon intersection contracts", () => {
  it("detects edge-only crossing without vertex containment", () => {
    const horizontal = polygon(
      point(0.1, 0.45),
      point(0.9, 0.45),
      point(0.9, 0.55),
      point(0.1, 0.55),
    );
    const vertical = polygon(
      point(0.45, 0.1),
      point(0.55, 0.1),
      point(0.55, 0.9),
      point(0.45, 0.9),
    );

    expect(polygonsIntersect(horizontal, vertical)).toBe(true);
  });

  it("detects containment when only right-side vertices are inside", () => {
    const outer = square(0.1, 0.1, 0.8);
    const inner = square(0.4, 0.4, 0.1);

    expect(polygonsIntersect(outer, inner)).toBe(true);
  });

  it("uses polygon endpoints projected onto a contact segment", () => {
    const object = square(0.1, 0.1, 0.4);
    const contact = { from: point(0.7, 0), to: point(0.7, 1) };

    expect(minimumDistanceToSegments(object, [contact])).toBeCloseTo(0.2);
  });

  it("uses contact endpoints projected onto a polygon edge", () => {
    const object = square(0.1, 0.1, 0.4);
    const contact = { from: point(0.7, 0.3), to: point(0.8, 0.3) };

    expect(minimumDistanceToSegments(object, [contact])).toBeCloseTo(0.2);
  });

  it("rejects an empty contact segment collection", () => {
    const object = square(0.1, 0.1, 0.4);

    expect(captureError(() => minimumDistanceToSegments(object, []))).toEqual(
      new RangeError("segments must not be empty"),
    );
  });

  it.each([
    { label: "non-finite", value: Number.POSITIVE_INFINITY },
    { label: "outside the normalized range", value: 1.01 },
  ])("rejects $label contact segment coordinates", ({ value }) => {
    const object = square(0.1, 0.1, 0.4);
    const invalidSegment = { from: point(0.7, 0.3), to: point(value, 0.3) };

    expect(captureError(() => minimumDistanceToSegments(object, [invalidSegment]))).toEqual(
      new RangeError("segment coordinates must be finite and normalized"),
    );
  });
});
