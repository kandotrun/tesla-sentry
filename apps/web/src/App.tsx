import {
  type LocalFileDescriptor,
  parseTeslaCamManifest,
  type TeslaCamEvent,
  type TeslaCamManifest,
} from "@sentry-check/teslacam-parser";
import { type ChangeEvent, useId, useState } from "react";
import "./styles.css";

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

function ManifestPanel({ manifest }: { readonly manifest: TeslaCamManifest }) {
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
          <p className="eyebrow eyebrow--green">LOCAL MANIFEST / READY</p>
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
          次は、このmanifestを基準に再開可能なR2直接アップロードを接続します。
          現時点では解析・課金は始まりません。
        </p>
      </footer>
    </section>
  );
}

export function App() {
  const inputId = useId();
  const [manifest, setManifest] = useState<TeslaCamManifest | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);

  function handleFolderSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    const descriptors = files.map(toDescriptor);
    setManifest(parseTeslaCamManifest(descriptors));
    const firstPath = descriptors[0]?.relativePath.replaceAll("\\", "/");
    setFolderName(firstPath?.split("/")[0] ?? null);
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
        <span className="build-label">ローカル確認版 · 動画送信なし</span>
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
            件数・容量・除外対象をアップロード前に確認できます。
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
              フォルダを選んで整理結果を見る
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
            現在のMVPはファイル名・相対パス・容量を、このブラウザ内だけで整理します。
            動画もメタデータもサーバーへ送信しません。
          </p>
          <ul>
            <li>Teslaアカウント連携なし</li>
            <li>RecentClipsは既定除外</li>
            <li>このMVPではローカル整理まで</li>
          </ul>
        </aside>
      </section>

      {manifest ? (
        <ManifestPanel manifest={manifest} />
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
            <h2>送る前に判断</h2>
            <p>件数・容量・除外・未識別ファイルを事前表示。</p>
          </article>
        </section>
      )}
    </main>
  );
}
