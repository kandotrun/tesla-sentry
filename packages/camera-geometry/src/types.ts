import type { KnownTeslaCamera, TeslaCamera } from "@sentry-check/teslacam-parser";

export type ContactCapableTeslaCamera = "left_repeater" | "right_repeater";

export type ContextualTeslaCamera = "front" | "back" | "left_pillar" | "right_pillar";

export type NonEmpty<T> = readonly [T, ...T[]];

export type TwoOrMore<T> = readonly [T, T, ...T[]];

export type BackImpactIssue =
  | "analysis_failed"
  | "decode_failed"
  | "frame_timing_unreliable"
  | "insufficient_frames"
  | "low_visibility"
  | "unsupported_video";

export interface BackImpactMetrics {
  readonly globalMotionScore: number;
  readonly impulseScore: number;
  readonly recoveryScore: number;
}

interface BackImpactEvidenceBase {
  readonly analysisDurationMs: number;
  readonly analyzedFrames: number;
  readonly analyzerVersion: "back-temporal-impact-v1";
  readonly camera: "back";
  readonly clipId: string;
  readonly schemaVersion: 1;
  readonly source: "back_temporal_motion";
}

export type BackImpactEvidence =
  | (BackImpactEvidenceBase & {
      readonly candidateTimestampMs: number;
      readonly issues: readonly [];
      readonly metrics: BackImpactMetrics;
      readonly status: "possible_contact";
    })
  | (BackImpactEvidenceBase & {
      readonly candidateTimestampMs: null;
      readonly issues: readonly [];
      readonly metrics: BackImpactMetrics;
      readonly status: "no_impact_signal_observed";
    })
  | (BackImpactEvidenceBase & {
      readonly candidateTimestampMs: null;
      readonly issues: NonEmpty<BackImpactIssue>;
      readonly metrics: null;
      readonly status: "indeterminate";
    });

export type CameraActivityCamera = KnownTeslaCamera;

export type CameraActivityIssue = BackImpactIssue;

export type CameraActivityStatus =
  | "activity_detected"
  | "no_activity_signal_observed"
  | "indeterminate";

export interface CameraActivityMetrics {
  readonly changedPixelRatio: number;
  readonly gradientChangeRatio: number;
  readonly nearCameraScore: number;
  readonly qualifyingSamples: number;
}

interface CameraActivityDirectionBase {
  readonly analysisDurationMs: number;
  readonly analyzedFrames: number;
  readonly analyzerVersion: "camera-temporal-activity-v1";
  readonly camera: CameraActivityCamera;
  readonly clipId: string;
  readonly schemaVersion: 1;
  readonly source: "camera_temporal_activity";
}

export type CameraActivityDirectionEvidence =
  | (CameraActivityDirectionBase & {
      readonly candidateTimestampMs: number;
      readonly issues: readonly [];
      readonly metrics: CameraActivityMetrics;
      readonly status: "activity_detected";
    })
  | (CameraActivityDirectionBase & {
      readonly candidateTimestampMs: null;
      readonly issues: readonly [];
      readonly metrics: CameraActivityMetrics;
      readonly status: "no_activity_signal_observed";
    })
  | (CameraActivityDirectionBase & {
      readonly candidateTimestampMs: null;
      readonly issues: NonEmpty<CameraActivityIssue>;
      readonly metrics: null;
      readonly status: "indeterminate";
    });

export interface CameraActivityEventEvidence {
  readonly analyzerVersion: "camera-temporal-activity-v1";
  readonly cameras: readonly CameraActivityDirectionEvidence[];
  readonly eventId: string;
  readonly schemaVersion: 1;
  readonly source: "camera_temporal_activity";
  readonly status: CameraActivityStatus;
}

export type CameraActivityEvidence = CameraActivityDirectionEvidence | CameraActivityEventEvidence;

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export type NormalizedPolygon = readonly NormalizedPoint[];

export interface NormalizedSegment {
  readonly from: NormalizedPoint;
  readonly to: NormalizedPoint;
}

interface CameraProfileBase {
  readonly codec: "h264";
  readonly height: number;
  readonly width: number;
}

export interface ContactCameraProfileV2 extends CameraProfileBase {
  readonly anchors: TwoOrMore<NormalizedPoint>;
  readonly blindZones: NonEmpty<NormalizedPolygon>;
  readonly camera: ContactCapableTeslaCamera;
  readonly contactBoundary: NonEmpty<NormalizedSegment>;
  readonly kind: "contact_geometry";
  readonly nearBodyZones: NonEmpty<NormalizedPolygon>;
  readonly occlusionThreshold: number;
  readonly pairedCameras: NonEmpty<KnownTeslaCamera>;
  readonly selfVehicleMasks: NonEmpty<NormalizedPolygon>;
}

interface ContextCameraProfileBaseV2 extends CameraProfileBase {
  readonly kind: "context_only";
  readonly pairedCameras: NonEmpty<ContactCapableTeslaCamera>;
}

export interface UnobservableContextCameraProfileV2 extends ContextCameraProfileBaseV2 {
  readonly camera: Exclude<ContextualTeslaCamera, "back">;
  readonly directContactGeometry: "unobservable";
}

export interface UnvalidatedContextCameraProfileV2 extends ContextCameraProfileBaseV2 {
  readonly camera: "back";
  readonly directContactGeometry: "unvalidated";
}

export type ContextCameraProfileV2 =
  | UnobservableContextCameraProfileV2
  | UnvalidatedContextCameraProfileV2;

export type CameraProfileV2 = ContactCameraProfileV2 | ContextCameraProfileV2;

export interface VehicleCameraProfileV2 {
  readonly anchorToleranceNormalized: number;
  readonly cameras: readonly CameraProfileV2[];
  readonly profileId: string;
  readonly requiredCameras: readonly KnownTeslaCamera[];
  readonly requiredContactCameras: readonly ContactCapableTeslaCamera[];
  readonly schemaVersion: 2;
  readonly vehicleFamily: "model_y_2025_plus_long_range";
}

export interface FrameGeometryObservation {
  readonly boundaryOcclusionRatio: number;
  readonly camera: ContactCapableTeslaCamera;
  readonly frameTimestampMs: number;
  readonly objectMask: NormalizedPolygon;
}

export type FrameGeometryState = "boundary_overlap" | "near" | "occluded" | "outside";

export type ProfileGeometryFingerprintV1 = `sha256-v1:${string}`;

export interface FrameGeometryEvaluation {
  readonly camera: ContactCapableTeslaCamera;
  readonly frameTimestampMs: number;
  readonly intersectsBlindZone: boolean;
  readonly minimumBoundaryDistanceNormalized: number;
  readonly profileGeometryFingerprint: ProfileGeometryFingerprintV1;
  readonly profileId: string;
  readonly profileSchemaVersion: 2;
  readonly source: "contact_geometry";
  readonly state: FrameGeometryState;
}

export interface CameraRecordingDescriptor {
  readonly anchorErrorNormalized: number | null;
  readonly camera: TeslaCamera;
  readonly codec: string;
  readonly cropped: boolean;
  readonly height: number;
  readonly rotationDegrees: number;
  readonly width: number;
}

export type ProfileMismatchReason =
  | "anchor_drift"
  | "anchor_unavailable"
  | "codec_mismatch"
  | "cropped_input"
  | "duplicate_camera"
  | "invalid_profile"
  | "missing_required_camera"
  | "resolution_mismatch"
  | "rotation_mismatch"
  | "unexpected_camera";

export type ProfileMatchResult =
  | {
      readonly kind: "matched";
      readonly profileGeometryFingerprint: ProfileGeometryFingerprintV1;
      readonly profileId: string;
      readonly schemaVersion: 2;
    }
  | { readonly kind: "mismatched"; readonly reasons: readonly ProfileMismatchReason[] };

export interface DirectCameraCoverageEvidence {
  readonly boundaryUnobscuredAtClosestApproach: boolean;
  readonly camera: ContactCapableTeslaCamera;
  readonly observedAfterClosestApproach: boolean;
  readonly observedAtClosestApproach: boolean;
  readonly observedBeforeClosestApproach: boolean;
}

export interface ContextCameraCoverageEvidence {
  readonly camera: ContextualTeslaCamera;
  readonly state: "no_relevant_track" | "resolved_to_direct" | "unresolved";
}

export type ContactCoverage =
  | {
      readonly contextCameraEvidence: readonly ContextCameraCoverageEvidence[];
      readonly directCameraObservations: readonly DirectCameraCoverageEvidence[];
      readonly kind: "complete";
    }
  | {
      readonly contextCameraEvidence: readonly ContextCameraCoverageEvidence[];
      readonly directCameraObservations: readonly DirectCameraCoverageEvidence[];
      readonly kind: "incomplete";
      readonly missingContactCameras: readonly ContactCapableTeslaCamera[];
    };

export type IndeterminateReason =
  | "back_impact_analysis_unavailable"
  | "boundary_occluded"
  | "camera_activity_analysis_unavailable"
  | "conflicting_evidence"
  | "entered_blind_zone"
  | "insufficient_camera_coverage"
  | "insufficient_contact_evidence"
  | "low_visibility"
  | "profile_mismatch"
  | "timing_unreliable"
  | "track_lost";

export interface ContactEventEvidence {
  readonly backImpactEvidence: BackImpactEvidence;
  readonly cameraEvidenceConflict: boolean;
  readonly completeTrack: boolean;
  readonly contactCoverage: ContactCoverage;
  readonly corroboratingContactCamera: ContactCapableTeslaCamera | null;
  readonly deformationOrRebound: boolean;
  readonly enteredBlindZone: boolean;
  readonly evaluations: readonly FrameGeometryEvaluation[];
  readonly globalShake: boolean;
  readonly profileMatch: ProfileMatchResult;
  readonly qualityAcceptable: boolean;
  readonly timingReliable: boolean;
  readonly trackedBeforeAndAfterClosestApproach: boolean;
  readonly trajectoryDiscontinuity: boolean;
}

export type ContactVerdict =
  | { readonly reasons: readonly []; readonly verdict: "contact" }
  | {
      readonly reasons: readonly [
        "back_temporal_impact_signal" | "camera_temporal_activity_signal",
      ];
      readonly verdict: "possible_contact";
    }
  | { readonly reasons: readonly []; readonly verdict: "no_contact_observed" }
  | {
      readonly reasons: readonly IndeterminateReason[];
      readonly verdict: "indeterminate";
    };

export type ProfileValidationIssueCode =
  | "duplicate_camera"
  | "invalid_anchor_count"
  | "invalid_anchor_tolerance"
  | "invalid_camera_role"
  | "invalid_codec"
  | "invalid_contact_pairing"
  | "invalid_context_pairing"
  | "invalid_coordinate"
  | "invalid_direct_geometry"
  | "invalid_occlusion_threshold"
  | "invalid_polygon"
  | "invalid_profile_identity"
  | "invalid_profile_shape"
  | "invalid_required_camera_set"
  | "invalid_required_contact_camera_set"
  | "invalid_resolution"
  | "invalid_schema_version"
  | "missing_required_camera";

export interface ProfileValidationIssue {
  readonly camera: KnownTeslaCamera | null;
  readonly code: ProfileValidationIssueCode;
}
