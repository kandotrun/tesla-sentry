import { describe, expect, it } from "vitest";
import {
  classifyContactEvent,
  evaluateFrameGeometry,
  matchVehicleCameraProfileV2,
} from "../src/index";
import {
  backImpactEvidence,
  CONTACT_CAMERAS,
  CONTEXT_CAMERAS,
  contextCameraCoverageEvidence,
  directCameraCoverageEvidence,
  evaluation,
  makeEventEvidence,
  makeProfile,
  makeProfileWithLeftRepeaterPairing,
  makeProfileWithoutLeftRepeaterPairing,
  observation,
  recordingDescriptors,
  square,
} from "./fixtures";

describe("classifyContactEvent", () => {
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

  it("keeps valid repeater contact when back analysis is indeterminate", () => {
    const unavailableBackEvidence: unknown = JSON.parse(
      '{"analysisDurationMs":4000,"analyzedFrames":32,"analyzerVersion":"back-temporal-impact-v1","camera":"back","candidateTimestampMs":null,"clipId":"back-001","issues":["analysis_failed"],"metrics":null,"schemaVersion":1,"source":"back_temporal_motion","status":"indeterminate"}',
    );
    const evidence = {
      ...makeEventEvidence({
        evaluations: [evaluation("boundary_overlap")],
        trajectoryDiscontinuity: true,
      }),
      backImpactEvidence: unavailableBackEvidence,
    };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: [],
      verdict: "contact",
    });
  });

  it("keeps valid repeater contact when back analysis is invalid", () => {
    const invalidBackEvidence: unknown = JSON.parse(
      '{"analysisDurationMs":4000,"analyzedFrames":32,"analyzerVersion":"back-temporal-impact-v1","camera":"front","candidateTimestampMs":2000,"clipId":"back-001","issues":[],"metrics":{"globalMotionScore":0.72,"impulseScore":0.64,"recoveryScore":0.59},"schemaVersion":1,"source":"back_temporal_motion","status":"possible_contact"}',
    );
    const evidence = {
      ...makeEventEvidence({
        evaluations: [evaluation("boundary_overlap")],
        trajectoryDiscontinuity: true,
      }),
      backImpactEvidence: invalidBackEvidence,
    };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: [],
      verdict: "contact",
    });
  });

  it("keeps unavailable back analysis indeterminate in fixed reason order", () => {
    const unavailableBackEvidence: unknown = JSON.parse(
      '{"analysisDurationMs":4000,"analyzedFrames":32,"analyzerVersion":"back-temporal-impact-v1","camera":"back","candidateTimestampMs":null,"clipId":"back-001","issues":["analysis_failed"],"metrics":null,"schemaVersion":1,"source":"back_temporal_motion","status":"indeterminate"}',
    );
    const evidence = {
      ...makeEventEvidence({ qualityAcceptable: false }),
      backImpactEvidence: unavailableBackEvidence,
    };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["back_impact_analysis_unavailable", "low_visibility"],
      verdict: "indeterminate",
    });
  });

  it("rejects invalid back evidence as unavailable", () => {
    const invalidBackEvidence: unknown = JSON.parse(
      '{"analysisDurationMs":4000,"analyzedFrames":32,"analyzerVersion":"back-temporal-impact-v1","camera":"front","candidateTimestampMs":2000,"clipId":"back-001","issues":[],"metrics":{"globalMotionScore":0.72,"impulseScore":0.64,"recoveryScore":0.59},"schemaVersion":1,"source":"back_temporal_motion","status":"possible_contact"}',
    );
    const evidence = {
      ...makeEventEvidence(),
      backImpactEvidence: invalidBackEvidence,
    };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["back_impact_analysis_unavailable"],
      verdict: "indeterminate",
    });
  });

  it.each([
    [
      "contact",
      makeEventEvidence({
        evaluations: [evaluation("boundary_overlap")],
        trajectoryDiscontinuity: true,
      }),
      { reasons: [], verdict: "contact" },
    ],
    ["no contact observed", makeEventEvidence(), { reasons: [], verdict: "no_contact_observed" }],
    [
      "indeterminate",
      makeEventEvidence({ qualityAcceptable: false }),
      { reasons: ["low_visibility"], verdict: "indeterminate" },
    ],
  ])(
    "preserves %s semantics when no back impact signal is observed",
    (_label, evidence, expected) => {
      expect(classifyContactEvent(evidence)).toEqual(expected);
    },
  );

  it.each([
    {
      label: "contact",
      mask: square(0.38, 0.45, 0.05),
      trajectoryDiscontinuity: true,
    },
    {
      label: "no_contact_observed",
      mask: square(0.05, 0.05, 0.1),
      trajectoryDiscontinuity: false,
    },
  ])("rejects a $label verdict from another valid V2 geometry", (overrides) => {
    const matchedProfile = makeProfile();
    const evaluationProfile = structuredClone(matchedProfile);
    const leftRepeater = evaluationProfile.cameras.find(
      (camera) => camera.camera === "left_repeater",
    );
    if (leftRepeater?.kind !== "contact_geometry") {
      throw new TypeError("left repeater must provide contact geometry");
    }
    Reflect.set(leftRepeater, "occlusionThreshold", 0.06);
    const profileMatch = matchVehicleCameraProfileV2(matchedProfile, recordingDescriptors());
    const evaluationProfileMatch = matchVehicleCameraProfileV2(
      evaluationProfile,
      recordingDescriptors(),
    );
    if (profileMatch.kind !== "matched" || evaluationProfileMatch.kind !== "matched") {
      throw new TypeError("both V2 profiles must match the recording descriptors");
    }
    expect(evaluationProfileMatch.profileGeometryFingerprint).not.toBe(
      profileMatch.profileGeometryFingerprint,
    );

    expect(
      classifyContactEvent(
        makeEventEvidence({
          evaluations: [evaluateFrameGeometry(evaluationProfile, observation(overrides.mask))],
          profileMatch,
          trajectoryDiscontinuity: overrides.trajectoryDiscontinuity,
        }),
      ),
    ).toEqual({ reasons: ["profile_mismatch"], verdict: "indeterminate" });
  });

  it("returns contact when direct boundary overlap has independent reinforcement", () => {
    expect(
      classifyContactEvent(
        makeEventEvidence({
          evaluations: [evaluation("boundary_overlap")],
          trajectoryDiscontinuity: true,
        }),
      ),
    ).toEqual({ reasons: [], verdict: "contact" });
  });

  it("accepts a corroborating direct contact camera as reinforcement", () => {
    expect(
      classifyContactEvent(
        makeEventEvidence({
          corroboratingContactCamera: "right_repeater",
          evaluations: [evaluation("boundary_overlap")],
        }),
      ),
    ).toEqual({ reasons: [], verdict: "contact" });
  });

  it("does not accept the boundary-overlap camera as its own corroboration", () => {
    expect(
      classifyContactEvent(
        makeEventEvidence({
          corroboratingContactCamera: "left_repeater",
          evaluations: [evaluation("boundary_overlap")],
        }),
      ),
    ).toEqual({
      reasons: ["insufficient_contact_evidence"],
      verdict: "indeterminate",
    });
  });

  it("fails closed when a forged non-boolean signal accompanies valid reinforcement", () => {
    const evidence = {
      ...makeEventEvidence({
        evaluations: [evaluation("boundary_overlap")],
        trajectoryDiscontinuity: true,
      }),
      globalShake: "forged",
    };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it("fails closed instead of returning contact when visibility is insufficient", () => {
    expect(
      classifyContactEvent(
        makeEventEvidence({
          evaluations: [evaluation("boundary_overlap")],
          qualityAcceptable: false,
          trajectoryDiscontinuity: true,
        }),
      ),
    ).toEqual({
      reasons: ["low_visibility"],
      verdict: "indeterminate",
    });
  });

  it("does not call boundary overlap contact without reinforcement", () => {
    expect(
      classifyContactEvent(makeEventEvidence({ evaluations: [evaluation("boundary_overlap")] })),
    ).toEqual({
      reasons: ["insufficient_contact_evidence"],
      verdict: "indeterminate",
    });
  });

  it("uses upstream complete coverage even when candidate evaluations come from one camera", () => {
    expect(
      classifyContactEvent(
        makeEventEvidence({ evaluations: [evaluation("near"), evaluation("outside")] }),
      ),
    ).toEqual({ reasons: [], verdict: "no_contact_observed" });
  });

  it.each([
    {
      evaluations: [evaluation("boundary_overlap")],
      label: "contact",
      trajectoryDiscontinuity: true,
    },
    {
      evaluations: [evaluation("outside")],
      label: "no_contact_observed",
      trajectoryDiscontinuity: false,
    },
  ])("rejects a $label verdict after invalid profile matching", (overrides) => {
    const invalidProfile = makeProfile({
      requiredContactCameras: ["left_repeater", "right_repeater", "right_repeater"],
    });
    const profileMatch = matchVehicleCameraProfileV2(invalidProfile, recordingDescriptors());

    expect(
      classifyContactEvent(
        makeEventEvidence({
          evaluations: overrides.evaluations,
          profileMatch,
          trajectoryDiscontinuity: overrides.trajectoryDiscontinuity,
        }),
      ),
    ).toEqual({
      reasons: ["profile_mismatch"],
      verdict: "indeterminate",
    });
  });

  it.each([
    {
      evaluations: [evaluation("boundary_overlap")],
      label: "contact",
      trajectoryDiscontinuity: true,
    },
    {
      evaluations: [evaluation("outside")],
      label: "no_contact_observed",
      trajectoryDiscontinuity: false,
    },
  ])("rejects a $label verdict when a direct anchor is unavailable", (overrides) => {
    const descriptors = recordingDescriptors().map((descriptor) =>
      descriptor.camera === "left_repeater"
        ? { ...descriptor, anchorErrorNormalized: null }
        : descriptor,
    );
    const profileMatch = matchVehicleCameraProfileV2(makeProfile(), descriptors);

    expect(profileMatch).toEqual({ kind: "mismatched", reasons: ["anchor_unavailable"] });
    expect(
      classifyContactEvent(
        makeEventEvidence({
          evaluations: overrides.evaluations,
          profileMatch,
          trajectoryDiscontinuity: overrides.trajectoryDiscontinuity,
        }),
      ),
    ).toEqual({ reasons: ["profile_mismatch"], verdict: "indeterminate" });
  });

  it("retains low visibility after an unavailable direct anchor mismatch", () => {
    const descriptors = recordingDescriptors().map((descriptor) =>
      descriptor.camera === "left_repeater"
        ? { ...descriptor, anchorErrorNormalized: null }
        : descriptor,
    );
    const profileMatch = matchVehicleCameraProfileV2(makeProfile(), descriptors);

    expect(
      classifyContactEvent(
        makeEventEvidence({
          evaluations: [evaluation("boundary_overlap")],
          profileMatch,
          qualityAcceptable: false,
          trajectoryDiscontinuity: true,
        }),
      ),
    ).toEqual({
      reasons: ["profile_mismatch", "low_visibility"],
      verdict: "indeterminate",
    });
  });

  it.each([
    {
      label: "schema mismatch",
      profile: () => ({ ...makeProfile(), schemaVersion: 1 }),
    },
    {
      label: "invalid vehicle family",
      profile: () => {
        const profile = structuredClone(makeProfile());
        Reflect.set(profile, "vehicleFamily", "model_3");
        return profile;
      },
    },
    {
      label: "missing profile ID",
      profile: () => {
        const profile = structuredClone(makeProfile());
        Reflect.deleteProperty(profile, "profileId");
        return profile;
      },
    },
    {
      label: "forged h265 camera codecs",
      profile: () => {
        const profile = structuredClone(makeProfile());
        for (const camera of profile.cameras) {
          Reflect.set(camera, "codec", "h265");
        }
        return profile;
      },
    },
  ])("blocks contact and no-contact verdicts after $label", ({ profile }) => {
    const profileMatch = Reflect.apply(matchVehicleCameraProfileV2, undefined, [
      profile(),
      recordingDescriptors(),
    ]);

    expect(profileMatch).toEqual({ kind: "mismatched", reasons: ["invalid_profile"] });
    expect(
      classifyContactEvent(
        makeEventEvidence({
          evaluations: [evaluation("boundary_overlap")],
          profileMatch,
          trajectoryDiscontinuity: true,
        }),
      ),
    ).toEqual({ reasons: ["profile_mismatch"], verdict: "indeterminate" });
    expect(
      classifyContactEvent(
        makeEventEvidence({ evaluations: [evaluation("outside")], profileMatch }),
      ),
    ).toEqual({ reasons: ["profile_mismatch"], verdict: "indeterminate" });
  });

  it.each([
    {
      label: "missing contact pairing shape",
      profile: makeProfileWithoutLeftRepeaterPairing,
    },
    {
      label: "duplicate contact pairing semantics",
      profile: () => makeProfileWithLeftRepeaterPairing(["front", "front"]),
    },
  ])("blocks contact and no-contact verdicts after $label", ({ profile }) => {
    const profileMatch = matchVehicleCameraProfileV2(profile(), recordingDescriptors());

    expect(profileMatch).toEqual({ kind: "mismatched", reasons: ["invalid_profile"] });
    expect(
      classifyContactEvent(
        makeEventEvidence({
          evaluations: [evaluation("boundary_overlap")],
          profileMatch,
          trajectoryDiscontinuity: true,
        }),
      ),
    ).toEqual({ reasons: ["profile_mismatch"], verdict: "indeterminate" });
    expect(
      classifyContactEvent(
        makeEventEvidence({ evaluations: [evaluation("outside")], profileMatch }),
      ),
    ).toEqual({ reasons: ["profile_mismatch"], verdict: "indeterminate" });
  });

  it("keeps incomplete direct coverage indeterminate", () => {
    expect(
      classifyContactEvent(
        makeEventEvidence({
          contactCoverage: {
            contextCameraEvidence: CONTEXT_CAMERAS.map((camera) =>
              contextCameraCoverageEvidence(camera),
            ),
            directCameraObservations: [directCameraCoverageEvidence("left_repeater")],
            kind: "incomplete",
            missingContactCameras: ["right_repeater"],
          },
        }),
      ),
    ).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it("keeps unresolved context indeterminate", () => {
    expect(
      classifyContactEvent(
        makeEventEvidence({
          contactCoverage: {
            contextCameraEvidence: CONTEXT_CAMERAS.map((camera) =>
              contextCameraCoverageEvidence(
                camera,
                camera === "back" ? "unresolved" : "no_relevant_track",
              ),
            ),
            directCameraObservations: CONTACT_CAMERAS.map((camera) =>
              directCameraCoverageEvidence(camera),
            ),
            kind: "incomplete",
            missingContactCameras: [],
          },
        }),
      ),
    ).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it.each([
    {
      contextCameraEvidence: CONTEXT_CAMERAS.filter((camera) => camera !== "back").map((camera) =>
        contextCameraCoverageEvidence(camera),
      ),
      label: "missing context evidence",
    },
    {
      contextCameraEvidence: [
        ...CONTEXT_CAMERAS.filter((camera) => camera !== "back").map((camera) =>
          contextCameraCoverageEvidence(camera),
        ),
        contextCameraCoverageEvidence("front"),
      ],
      label: "duplicate context evidence",
    },
    {
      contextCameraEvidence: [
        ...CONTEXT_CAMERAS.filter((camera) => camera !== "back").map((camera) =>
          contextCameraCoverageEvidence(camera),
        ),
        { camera: "cabin", state: "no_relevant_track" },
      ],
      label: "unknown context evidence",
    },
    {
      contextCameraEvidence: CONTEXT_CAMERAS.map((camera) => ({
        camera,
        state: camera === "back" ? "forged" : "no_relevant_track",
      })),
      label: "unknown context state",
    },
  ])("fails closed for $label", ({ contextCameraEvidence }) => {
    const contactCoverage = {
      contextCameraEvidence,
      directCameraObservations: CONTACT_CAMERAS.map((camera) =>
        directCameraCoverageEvidence(camera),
      ),
      kind: "complete",
    };
    const evidence = { ...makeEventEvidence(), contactCoverage };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it("accepts context tracks explicitly resolved to direct cameras", () => {
    const contextCameraEvidence = CONTEXT_CAMERAS.map((camera) =>
      contextCameraCoverageEvidence(camera, "resolved_to_direct"),
    );

    expect(
      classifyContactEvent(
        makeEventEvidence({
          contactCoverage: {
            contextCameraEvidence,
            directCameraObservations: CONTACT_CAMERAS.map((camera) =>
              directCameraCoverageEvidence(camera),
            ),
            kind: "complete",
          },
        }),
      ),
    ).toEqual({ reasons: [], verdict: "no_contact_observed" });
  });

  it("does not treat camera pairing as context-track resolution", () => {
    const contactCoverage = {
      contextCameraEvidence: CONTEXT_CAMERAS.map((camera) =>
        contextCameraCoverageEvidence(
          camera,
          camera === "back" ? "unresolved" : "no_relevant_track",
        ),
      ),
      directCameraObservations: CONTACT_CAMERAS.map((camera) =>
        directCameraCoverageEvidence(camera),
      ),
      kind: "complete",
    };
    const evidence = { ...makeEventEvidence(), contactCoverage };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it("fails closed for a forged complete coverage missing a direct camera", () => {
    const forgedCoverage = {
      contextCameraEvidence: CONTEXT_CAMERAS.map((camera) => contextCameraCoverageEvidence(camera)),
      directCameraObservations: [directCameraCoverageEvidence("left_repeater")],
      kind: "complete",
    };
    const evidence = { ...makeEventEvidence(), contactCoverage: forgedCoverage };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it("fails closed for a context-sourced evaluation", () => {
    const forgedEvaluation = { ...evaluation("outside"), source: "context_only" };
    const evidence = { ...makeEventEvidence(), evaluations: [forgedEvaluation] };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it("fails closed when a valid repeater evaluation is mixed with a forged back evaluation", () => {
    const forgedEvaluation = { ...evaluation("outside"), camera: "back" };
    const evidence = {
      ...makeEventEvidence(),
      evaluations: [evaluation("outside"), forgedEvaluation],
    };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it("fails closed for a front evaluation even when it claims contact", () => {
    const forgedEvaluation = { ...evaluation("boundary_overlap"), camera: "front" };
    const evidence = {
      ...makeEventEvidence({ trajectoryDiscontinuity: true }),
      evaluations: [forgedEvaluation],
    };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it("fails closed for a back evaluation even when it claims contact", () => {
    const forgedEvaluation = { ...evaluation("boundary_overlap"), camera: "back" };
    const evidence = {
      ...makeEventEvidence({ trajectoryDiscontinuity: true }),
      evaluations: [forgedEvaluation],
    };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it("does not accept front as corroborating direct-camera reinforcement", () => {
    const evidence = {
      ...makeEventEvidence({ evaluations: [evaluation("boundary_overlap")] }),
      corroboratingContactCamera: "front",
    };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["insufficient_camera_coverage", "insufficient_contact_evidence"],
      verdict: "indeterminate",
    });
  });

  it("does not accept back as corroborating direct-camera reinforcement", () => {
    const evidence = {
      ...makeEventEvidence({ evaluations: [evaluation("boundary_overlap")] }),
      corroboratingContactCamera: "back",
    };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["insufficient_camera_coverage", "insufficient_contact_evidence"],
      verdict: "indeterminate",
    });
  });

  it.each(CONTEXT_CAMERAS)("keeps a %s-only track indeterminate", (contextCamera) => {
    expect(
      classifyContactEvent(
        makeEventEvidence({
          contactCoverage: {
            contextCameraEvidence: CONTEXT_CAMERAS.map((camera) =>
              contextCameraCoverageEvidence(
                camera,
                camera === contextCamera ? "unresolved" : "no_relevant_track",
              ),
            ),
            directCameraObservations: [],
            kind: "incomplete",
            missingContactCameras: CONTACT_CAMERAS,
          },
          evaluations: [],
        }),
      ),
    ).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it.each([
    {
      directCameraObservations: [
        directCameraCoverageEvidence("left_repeater"),
        directCameraCoverageEvidence("left_repeater"),
      ],
      label: "duplicate direct-camera observation proof",
    },
    {
      directCameraObservations: CONTACT_CAMERAS.map((camera) =>
        directCameraCoverageEvidence(camera, {
          observedAtClosestApproach: camera !== "left_repeater",
        }),
      ),
      label: "a false closest-approach observation flag",
    },
    {
      directCameraObservations: [
        directCameraCoverageEvidence("left_repeater"),
        { ...directCameraCoverageEvidence("right_repeater"), camera: "back" },
      ],
      label: "a context-camera observation role",
    },
  ])("fails closed for $label in upstream coverage evidence", ({ directCameraObservations }) => {
    const contactCoverage = {
      contextCameraEvidence: CONTEXT_CAMERAS.map((camera) => contextCameraCoverageEvidence(camera)),
      directCameraObservations,
      kind: "complete",
    };
    const evidence = { ...makeEventEvidence(), contactCoverage };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it("fails closed for a matched result without V2 provenance", () => {
    const evidence = {
      ...makeEventEvidence(),
      profileMatch: { kind: "matched", profileId: "synthetic-profile-v1", schemaVersion: 1 },
    };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["profile_mismatch"],
      verdict: "indeterminate",
    });
  });

  it.each([
    {
      label: "a non-string profile ID",
      profileMatch: { kind: "matched", profileId: 42, schemaVersion: 2 },
    },
    {
      label: "an unsafe profile ID",
      profileMatch: { kind: "matched", profileId: "../forged", schemaVersion: 2 },
    },
    {
      label: "a null match result",
      profileMatch: null,
    },
  ])("fails closed for $label in match provenance", ({ profileMatch }) => {
    const evidence = {
      ...makeEventEvidence({
        evaluations: [evaluation("boundary_overlap")],
        trajectoryDiscontinuity: true,
      }),
      profileMatch,
    };

    expect(Reflect.apply(classifyContactEvent, undefined, [evidence])).toEqual({
      reasons: ["profile_mismatch"],
      verdict: "indeterminate",
    });
  });

  it("does not infer clearance from empty direct evaluation evidence", () => {
    expect(classifyContactEvent(makeEventEvidence({ evaluations: [] }))).toEqual({
      reasons: ["insufficient_camera_coverage"],
      verdict: "indeterminate",
    });
  });

  it("keeps occluded and blind-zone evidence indeterminate", () => {
    expect(
      classifyContactEvent(
        makeEventEvidence({ enteredBlindZone: true, evaluations: [evaluation("occluded")] }),
      ),
    ).toEqual({
      reasons: ["boundary_occluded", "entered_blind_zone"],
      verdict: "indeterminate",
    });
  });

  it("uses frame-level blind-zone evidence even without the event flag", () => {
    expect(
      classifyContactEvent(
        makeEventEvidence({
          evaluations: [{ ...evaluation("outside"), intersectsBlindZone: true }],
        }),
      ),
    ).toEqual({
      reasons: ["entered_blind_zone"],
      verdict: "indeterminate",
    });
  });

  it("does not return clearance when independent reinforcement lacks boundary overlap", () => {
    expect(classifyContactEvent(makeEventEvidence({ globalShake: true }))).toEqual({
      reasons: ["conflicting_evidence"],
      verdict: "indeterminate",
    });
  });

  it("returns every applicable reason once in fixed order", () => {
    expect(
      classifyContactEvent(
        makeEventEvidence({
          cameraEvidenceConflict: true,
          completeTrack: false,
          contactCoverage: {
            contextCameraEvidence: CONTEXT_CAMERAS.map((camera) =>
              contextCameraCoverageEvidence(
                camera,
                camera === "back" ? "unresolved" : "no_relevant_track",
              ),
            ),
            directCameraObservations: [directCameraCoverageEvidence("left_repeater")],
            kind: "incomplete",
            missingContactCameras: ["right_repeater"],
          },
          evaluations: [evaluation("boundary_overlap")],
          profileMatch: { kind: "mismatched", reasons: ["anchor_drift"] },
          qualityAcceptable: false,
          timingReliable: false,
        }),
      ),
    ).toEqual({
      reasons: [
        "profile_mismatch",
        "insufficient_camera_coverage",
        "track_lost",
        "low_visibility",
        "timing_unreliable",
        "conflicting_evidence",
        "insufficient_contact_evidence",
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
