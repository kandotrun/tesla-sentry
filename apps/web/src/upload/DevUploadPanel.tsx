import type { UploadPlanV1 } from "@sentry-check/upload-contract";
import { useState } from "react";
import type { DevApiClient } from "./dev-upload-client";
import { batchDevUploadFiles } from "./dev-upload-pipeline";

type FilePhase = "waiting" | "hashing" | "uploading" | "verifying" | "verified" | "failed";

interface FileRowState {
  readonly fingerprint: string;
  readonly name: string;
  readonly phase: FilePhase;
  readonly reason: string | null;
  readonly size: number;
}

const FAILURE_LABELS: Readonly<Record<string, string>> = {
  container_not_ready: "コンテナ内容が再検査で不合格",
  hash_mismatch: "ハッシュ不一致",
  object_missing: "保存オブジェクトが見つからない",
  size_mismatch: "サイズ不一致",
};

const PHASE_LABELS: Readonly<Record<FilePhase, string>> = {
  failed: "失敗",
  hashing: "ハッシュ計算中",
  uploading: "送信中",
  verified: "検証済み",
  verifying: "検証中",
  waiting: "待機",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export interface DevUploadPanelProps {
  readonly apiClient: DevApiClient;
  readonly filesByFingerprint: ReadonlyMap<string, File>;
  readonly hashFile: (file: File) => Promise<string>;
  readonly plan: UploadPlanV1;
}

/**
 * 開発環境専用：eligibleクリップをWorker経由でローカルR2へアップロードし、
 * サーバー側再検証の結果まで表示する縦切りパネル。
 */
export function DevUploadPanel({
  apiClient,
  filesByFingerprint,
  hashFile,
  plan,
}: DevUploadPanelProps) {
  const [rows, setRows] = useState<readonly FileRowState[]>([]);
  const [running, setRunning] = useState(false);

  const eligibleItems = plan.items.filter((item) => item.status === "eligible");

  function setRow(fingerprint: string, next: Partial<FileRowState>) {
    setRows((current) =>
      current.map((row) => (row.fingerprint === fingerprint ? { ...row, ...next } : row)),
    );
  }

  async function runUpload() {
    if (running || eligibleItems.length === 0) {
      return;
    }
    setRunning(true);
    setRows(
      eligibleItems.map((item) => ({
        fingerprint: item.fingerprint,
        name: item.name,
        phase: "waiting" as const,
        reason: null,
        size: item.size,
      })),
    );

    try {
      const filesWithSha: {
        readonly file: File;
        readonly item: (typeof eligibleItems)[number];
        readonly sha256: string;
        readonly size: number;
      }[] = [];
      for (const item of eligibleItems) {
        const file = filesByFingerprint.get(item.fingerprint);
        if (!file) {
          setRow(item.fingerprint, {
            phase: "failed",
            reason: "選択元ファイルが見つかりません",
          });
          continue;
        }
        setRow(item.fingerprint, { phase: "hashing" });
        const sha256 = await hashFile(file);
        filesWithSha.push({ file, item, sha256, size: item.size });
      }

      for (const batch of batchDevUploadFiles(filesWithSha)) {
        const job = await apiClient.createJob({
          files: batch.map(({ item, sha256 }) => ({
            eventId: item.eventId,
            relativePath: item.relativePath,
            sha256,
            size: item.size,
          })),
        });
        const fileIdByRelativePath = new Map<string, string>();
        for (const accepted of job.accepted) {
          fileIdByRelativePath.set(accepted.relativePath, accepted.fileId);
        }

        for (const { file, item } of batch) {
          const fileId = fileIdByRelativePath.get(item.relativePath);
          if (!fileId) {
            setRow(item.fingerprint, {
              phase: "failed",
              reason: "サーバーがファイルを拒否しました",
            });
            continue;
          }
          try {
            setRow(item.fingerprint, { phase: "uploading" });
            const grant = await apiClient.grant(job.jobId, job.jobToken, fileId);
            await apiClient.upload(grant.uploadToken, file, () => undefined);
            setRow(item.fingerprint, { phase: "verifying" });
            const result = await apiClient.verify(job.jobId, job.jobToken, fileId);
            if (result.status === "verified") {
              setRow(item.fingerprint, { phase: "verified" });
            } else {
              setRow(item.fingerprint, {
                phase: "failed",
                reason: FAILURE_LABELS[result.reason] ?? result.reason,
              });
            }
          } catch (error) {
            setRow(item.fingerprint, {
              phase: "failed",
              reason: error instanceof Error ? error.message : "アップロード失敗",
            });
          }
        }
      }
    } catch {
      setRows((current) =>
        current.map((row) =>
          row.phase === "waiting" || row.phase === "hashing"
            ? { ...row, phase: "failed", reason: "ジョブを作成できませんでした" }
            : row,
        ),
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="dev-upload-panel" aria-label="開発環境アップロード">
      <div className="dev-upload-panel__heading">
        <div>
          <p className="eyebrow eyebrow--green">DEV ONLY / LOCAL R2</p>
          <h3>開発環境アップロード</h3>
        </div>
        <span className="dev-upload-panel__badge">開発環境専用</span>
      </div>
      <p className="dev-upload-panel__note">
        eligibleクリップをローカル開発環境にだけ保存します。本番のストレージ・解析・課金にはつながりません。
      </p>

      {eligibleItems.length === 0 ? (
        <p className="dev-upload-panel__note">アップロード候補がありません。</p>
      ) : (
        <button
          className="dev-upload-panel__button"
          disabled={running}
          onClick={() => void runUpload()}
          type="button"
        >
          {running ? "処理中…" : `${eligibleItems.length}本を開発環境へアップロード`}
        </button>
      )}

      {rows.length > 0 ? (
        <ul className="dev-upload-rows" aria-live="polite">
          {rows.map((row) => (
            <li className={`dev-upload-row dev-upload-row--${row.phase}`} key={row.fingerprint}>
              <span className="dev-upload-row__name">{row.name}</span>
              <span className="dev-upload-row__size">{formatBytes(row.size)}</span>
              <strong>
                {PHASE_LABELS[row.phase]}
                {row.phase === "failed" && row.reason ? `（${row.reason}）` : ""}
              </strong>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
