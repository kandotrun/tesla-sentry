import {
  type LocalFileDescriptor,
  parseTeslaCamManifest,
  type TeslaCamEvent,
  type TeslaCamManifest,
} from "@sentry-check/teslacam-parser";
import { type ChangeEvent, useEffect, useId, useRef, useState } from "react";
import { PreflightPanel } from "./PreflightPanel";
import "./styles.css";
import {
  type ClipFileInput,
  type ClipPreflightProbe,
  type ClipPreflightState,
  defaultClipPreflightProbe,
  preflightClipFiles,
} from "./video-preflight";

export type { ClipPreflightProbe } from "./video-preflight";

const CAMERA_LABELS = new Map([
  ["front", "前方"],
  ["back", "後方"],
  ["left_pillar", "左ピラー"],
  ["left_repeater", "左側面"],
  ["right_pillar", "右ピラー"],
  ["right_repeater", "右側面"],
  ["unknown", "未識別"],
]);

function toDescriptor(file: File): LocalFileDescriptor {
  return {
    lastModified: file.lastModified,
    name: file.name,
    relativePath: file.webkitRelativePath || file.name,
    size: file.size,
    type: file.type,
  };
}

function descriptorFingerprint(file: LocalFileDescriptor): string {
  return `${file.relativePath}:${file.size}:${file.lastModified}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatEventId(eventId: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(eventId);
  if (!match) {
    return eventId;
  }
  const [, date, hour, minute, second] = match;
  return `${date} ${hour}:${minute}:${second}`;
}

function EventRow({ event }: { readonly event: TeslaCamEvent }) {
  return (
    <li className="event-row">
      <div>
        <p className="event-time">{formatEventId(event.id)}</p>
        <p className="event-meta">
          {event.clipCount}クリップ · {formatBytes(event.selectedBytes)}
        </p>
      </div>
      <ul className="camera-list" aria-label="カメラ">
        {event.cameras.map((camera) => (
          <li className={camera === "unknown" ? "camera camera--warning" : "camera"} key={camera}>
            {CAMERA_LABELS.get(camera) ?? camera}
          </li>
        ))}
      </ul>
    </li>
  );
}

function ManifestPanel({
  manifest,
  preflight,
}: {
  readonly manifest: TeslaCamManifest;
  readonly preflight: ClipPreflightState | null;
}) {
  if (manifest.totals.eventCount === 0) {
    return (
      <>
        <section className="empty-result" aria-live="polite">
          <span className="empty-result__mark" aria-hidden="true">
            !
          </span>
          <div>
            <h2>SentryClipsが見つかりませんでした</h2>
            <p>TeslaCamフォルダ全体、またはSentryClipsフォルダを選び直してください。</p>
          </div>
        </section>
        <div className="scope-strip">
          <span className="scope-strip__active">SentryClipsを対象</span>
          <span>RecentClips {manifest.excluded.recentClips}本を既定除外</span>
          {manifest.excluded.savedClips > 0 ? (
            <span>SavedClips {manifest.excluded.savedClips}本を除外</span>
          ) : null}
          {manifest.excluded.unknownScope > 0 ? (
            <span className="scope-strip__warning">
              未識別の動画 {manifest.excluded.unknownScope}本
            </span>
          ) : null}
          {manifest.warnings.length > 0 ? (
            <span className="scope-strip__warning">要確認 {manifest.warnings.length}件</span>
          ) : null}
        </div>
      </>
    );
  }

  const visibleEvents = manifest.events.slice(0, 8);
  const hiddenEventCount = manifest.events.length - visibleEvents.length;

  return (
    <section className="manifest" aria-live="polite">
      <div className="manifest__header">
        <div>
          <p className="eyebrow eyebrow--green">LOCAL MANIFEST / PREFLIGHT</p>
          <h2>アップロード前の確認</h2>
        </div>
        <p className="manifest__status">まだ外部送信されていません</p>
      </div>

      <dl className="metrics">
        <div className="metric">
          <dt>対象イベント</dt>
          <dd>{manifest.totals.eventCount}イベント</dd>
        </div>
        <div className="metric">
          <dt>対象動画</dt>
          <dd>{manifest.totals.clipCount}クリップ</dd>
        </div>
        <div className="metric">
          <dt>対象容量</dt>
          <dd>{formatBytes(manifest.totals.selectedBytes)}</dd>
        </div>
      </dl>

      {preflight ? <PreflightPanel state={preflight} /> : null}

      <div className="scope-strip">
        <span className="scope-strip__active">SentryClipsを対象</span>
        <span>RecentClips {manifest.excluded.recentClips}本を既定除外</span>
        {manifest.excluded.savedClips > 0 ? (
          <span>SavedClips {manifest.excluded.savedClips}本を除外</span>
        ) : null}
        {manifest.excluded.unknownScope > 0 ? (
          <span className="scope-strip__warning">
            未識別の動画 {manifest.excluded.unknownScope}本
          </span>
        ) : null}
        {manifest.warnings.length > 0 ? (
          <span className="scope-strip__warning">要確認 {manifest.warnings.length}件</span>
        ) : null}
      </div>

      <div className="event-list-heading">
        <h3>イベント一覧</h3>
        <span>新しい順</span>
      </div>
      <ol className="event-list">
        {visibleEvents.map((event) => (
          <EventRow event={event} key={event.id} />
        ))}
      </ol>
      {hiddenEventCount > 0 ? (
        <p className="more-events">ほか {hiddenEventCount}イベント（次段階で全件表示）</p>
      ) : null}

      <footer className="manifest__footer">
        <p>
          MP4事前検査を通過した動画だけを、次段階のアップロード候補にします。
          現時点ではアップロード・解析・課金は始まりません。
        </p>
      </footer>
    </section>
  );
}

interface AppProps {
  readonly probeVideoFile?: ClipPreflightProbe;
}

export function App({ probeVideoFile = defaultClipPreflightProbe }: AppProps = {}) {
  const inputId = useId();
  const [manifest, setManifest] = useState<TeslaCamManifest | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<ClipPreflightState | null>(null);
  const activeScan = useRef<AbortController | null>(null);
  const scanVersion = useRef(0);

  useEffect(
    () => () => {
      activeScan.current?.abort();
    },
    [],
  );

  function handleFolderSelection(event: ChangeEvent<HTMLInputElement>) {
    activeScan.current?.abort();
    const controller = new AbortController();
    activeScan.current = controller;
    scanVersion.current += 1;
    const currentVersion = scanVersion.current;

    const files = Array.from(event.currentTarget.files ?? []);
    const descriptors = files.map(toDescriptor);
    const nextManifest = parseTeslaCamManifest(descriptors);
    setManifest(nextManifest);
    setPreflight(null);
    const firstPath = descriptors[0]?.relativePath.replaceAll("\\", "/");
    setFolderName(firstPath?.split("/")[0] ?? null);

    const filesByFingerprint = new Map<string, File>();
    for (const [index, descriptor] of descriptors.entries()) {
      const file = files[index];
      if (file) {
        filesByFingerprint.set(descriptorFingerprint(descriptor), file);
      }
    }
    const clipFiles: ClipFileInput[] = nextManifest.events
      .flatMap((teslaEvent) => teslaEvent.clips)
      .flatMap((clip) => {
        const file = filesByFingerprint.get(clip.fingerprint);
        return file ? [{ file, fingerprint: clip.fingerprint }] : [];
      });

    if (clipFiles.length === 0) {
      return;
    }

    setPreflight({ completed: 0, records: [], total: clipFiles.length });
    void preflightClipFiles(clipFiles, probeVideoFile, controller.signal, (record) => {
      if (controller.signal.aborted || currentVersion !== scanVersion.current) {
        return;
      }
      setPreflight((current) => {
        if (!current || current.total !== clipFiles.length) {
          return current;
        }
        return {
          completed: current.completed + 1,
          records: [...current.records, record],
          total: current.total,
        };
      });
    }).catch(() => {
      // A new folder selection aborts the old scan. Per-file probe failures become review results.
    });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="#top" aria-label="Sentry Check ホーム">
          <span className="wordmark__signal" aria-hidden="true" />
          <span>SENTRY</span>
          <span className="wordmark__slash">/</span>
          <span>CHECK</span>
        </a>
        <span className="build-label">ローカル事前検査版 · 動画送信なし</span>
      </header>

      <section className="hero" id="top">
        <div className="hero__copy">
          <p className="eyebrow">TESLACAM / LOCAL PREFLIGHT</p>
          <h1>
            セントリー映像、
            <br />
            全部見なくていい。
          </h1>
          <p className="hero__lead">
            TeslaCamフォルダを選ぶと、PC内でSentryClipsをイベント単位に整理。
            件数・容量に加え、MP4の時間・コーデック・破損候補をアップロード前に確認できます。
          </p>
          <div className="selector">
            <input
              aria-label="TeslaCamフォルダを選択"
              className="selector__input"
              id={inputId}
              multiple
              onChange={handleFolderSelection}
              type="file"
              webkitdirectory=""
            />
            <label className="selector__button" htmlFor={inputId}>
              <span aria-hidden="true">＋</span>
              フォルダを選んで事前検査する
            </label>
            <p className="selector__hint">
              {folderName
                ? `選択中：${folderName}`
                : "TeslaCam全体またはSentryClipsを選択 · RecentClipsは除外"}
            </p>
          </div>
        </div>

        <aside className="privacy-plate" aria-label="プライバシー方針">
          <div className="privacy-plate__scan" aria-hidden="true" />
          <div className="folder-map" aria-hidden="true">
            <span>TeslaCam/</span>
            <span>└─ SentryClips/</span>
          </div>
          <h2>フォルダを選択しても、動画本体は送信されません</h2>
          <p>
            ファイル名・相対パス・容量と、必要なMP4メタデータをこのブラウザ内だけで読み取ります。
            動画もメタデータもサーバーへ送信しません。
          </p>
          <ul>
            <li>Teslaアカウント連携なし</li>
            <li>RecentClipsは既定除外</li>
            <li>MP4ヘッダーもブラウザ内だけで確認します。</li>
          </ul>
        </aside>
      </section>

      {manifest ? (
        <ManifestPanel manifest={manifest} preflight={preflight} />
      ) : (
        <section className="waiting-grid" aria-label="処理ステップ">
          <article>
            <span>01</span>
            <h2>フォルダを読む</h2>
            <p>明示的に選んだファイルだけをローカル確認。</p>
          </article>
          <article>
            <span>02</span>
            <h2>イベントを束ねる</h2>
            <p>日時とカメラ方向からSentryClipsを整理。</p>
          </article>
          <article>
            <span>03</span>
            <h2>送る前に検査</h2>
            <p>時間・コーデック・解像度・破損候補を事前表示。</p>
          </article>
        </section>
      )}
    </main>
  );
}
