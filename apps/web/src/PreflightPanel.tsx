import type { VideoPreflightCode, VideoPreflightResult } from "@sentry-check/video-preflight";
import type { ClipPreflightRecord, ClipPreflightState } from "./video-preflight";

type ReviewCode = Exclude<VideoPreflightCode, "ready">;
type ReviewRecord = ClipPreflightRecord & {
  readonly result: VideoPreflightResult & { readonly code: ReviewCode };
};

const ISSUE_LABELS: Readonly<Record<ReviewCode, string>> = {
  empty_file: "空の動画ファイル",
  encrypted: "暗号化された動画",
  invalid_container: "破損した可能性のあるMP4",
  metadata_not_found: "MP4メタデータを取得できません",
  missing_video_track: "動画トラックがありません",
  unsupported_codec: "非対応の動画コーデック",
};

function isReviewRecord(record: ClipPreflightRecord): record is ReviewRecord {
  return record.result.code !== "ready";
}

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function formatCodec(codec: string): string {
  if (/^avc[1-4](?:\.|$)/i.test(codec)) {
    return "H.264";
  }
  if (/^(?:hvc[12]|hev[12])(?:\.|$)/i.test(codec)) {
    return "H.265 / HEVC";
  }
  return codec;
}

function readySummary(results: readonly VideoPreflightResult[]): string | null {
  if (results.length === 0) {
    return null;
  }

  const durationSeconds = results.reduce(
    (total, result) => total + (result.durationSeconds ?? 0),
    0,
  );
  const codecs = [
    ...new Set(results.flatMap((result) => (result.codec ? [formatCodec(result.codec)] : []))),
  ];
  const dimensions = [
    ...new Set(
      results.flatMap((result) =>
        result.width && result.height ? [`${result.width}×${result.height}`] : [],
      ),
    ),
  ];
  const parts = [`動画合計 ${formatDuration(durationSeconds)}`, ...codecs];
  if (dimensions.length === 1) {
    parts.push(dimensions[0] ?? "");
  } else if (dimensions.length > 1) {
    parts.push(`${dimensions.length}種類の解像度`);
  }
  return parts.join(" · ");
}

export function PreflightPanel({ state }: { readonly state: ClipPreflightState }) {
  const readyRecords = state.records.filter((record) => record.result.code === "ready");
  const reviewRecords = state.records
    .filter(isReviewRecord)
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const complete = state.completed === state.total;
  const summary = readySummary(readyRecords.map((record) => record.result));

  return (
    <section className="preflight-panel" aria-live="polite" aria-label="動画の事前検査">
      <div className="preflight-panel__heading">
        <div>
          <p className="eyebrow eyebrow--green">MP4 HEADER / LOCAL ONLY</p>
          <h3>動画の事前検査</h3>
        </div>
        <div className="preflight-panel__counts">
          {complete ? (
            <>
              <strong>解析可能 {readyRecords.length}本</strong>
              {reviewRecords.length > 0 ? (
                <strong className="preflight-panel__warning">
                  要確認 {reviewRecords.length}本
                </strong>
              ) : null}
            </>
          ) : (
            <strong>
              検査中 {state.completed}/{state.total}本
            </strong>
          )}
        </div>
      </div>
      <p className="preflight-panel__note">
        MP4の時間・コーデック・解像度・暗号化/破損候補をブラウザ内で確認しています。
        動画も結果もサーバーへ送信しません。
      </p>
      {summary ? <p className="preflight-panel__summary">{summary}</p> : null}
      {complete && reviewRecords.length > 0 ? (
        <ul className="preflight-issues" aria-label="要確認クリップ">
          {reviewRecords.slice(0, 5).map((record) => (
            <li key={record.fingerprint}>
              <span>{record.name}</span>
              <strong>{ISSUE_LABELS[record.result.code]}</strong>
            </li>
          ))}
          {reviewRecords.length > 5 ? <li>ほか {reviewRecords.length - 5}本</li> : null}
        </ul>
      ) : null}
    </section>
  );
}
