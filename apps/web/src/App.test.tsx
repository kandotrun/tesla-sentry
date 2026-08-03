import type { VideoPreflightResult } from "@sentry-check/video-preflight";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App, type ClipPreflightProbe } from "./App";

const MiB = 1024 * 1024;

function localFile(relativePath: string, size = 2 * MiB): File {
  const file = new File(["test"], relativePath.split("/").at(-1) ?? "clip.mp4", {
    type: "video/mp4",
    lastModified: 1_786_000_000_000,
  });
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function readyResult(overrides: Partial<VideoPreflightResult> = {}): VideoPreflightResult {
  return {
    code: "ready",
    codec: "avc1.42c00a",
    durationSeconds: 60,
    encrypted: false,
    height: 90,
    scannedBytes: 1024,
    width: 160,
    ...overrides,
  };
}

const readyProbe: ClipPreflightProbe = async () => readyResult();

function renderApp(probeVideoFile: ClipPreflightProbe = readyProbe) {
  return render(<App probeVideoFile={probeVideoFile} />);
}

describe("App", () => {
  it("explains the local-first folder selection before any file is chosen", () => {
    renderApp();

    expect(
      screen.getByRole("heading", { name: "セントリー映像、全部見なくていい。" }),
    ).toBeInTheDocument();
    expect(screen.getByText("フォルダを選択しても、動画本体は送信されません")).toBeInTheDocument();
    expect(screen.getByText("フォルダを選んで事前検査する")).toBeInTheDocument();
    expect(screen.getByText("MP4ヘッダーもブラウザ内だけで確認します。")).toBeInTheDocument();
    const input = screen.getByLabelText("TeslaCamフォルダを選択");
    expect(input).toHaveAttribute("webkitdirectory");
    expect(input).toHaveAttribute("multiple");
  });

  it("shows the SentryClips manifest and probes only selected clips", async () => {
    const probe = vi.fn(readyProbe);
    renderApp(probe);
    const eventPath = "TeslaCam/SentryClips/2026-08-03_12-34-56";
    const files = [
      localFile(`${eventPath}/2026-08-03_12-32-00-front.mp4`),
      localFile(`${eventPath}/2026-08-03_12-32-00-back.mp4`),
      localFile(`${eventPath}/2026-08-03_12-32-00-left_repeater.mp4`),
      localFile(`${eventPath}/2026-08-03_12-32-00-right_repeater.mp4`),
      localFile(`${eventPath}/event.mp4`, 512 * 1024),
      localFile("TeslaCam/RecentClips/2026-08-03_12-33-00-front.mp4"),
      localFile("TeslaCam/FutureClips/2026-08-03_12-35-00-front.mp4"),
    ];

    fireEvent.change(screen.getByLabelText("TeslaCamフォルダを選択"), {
      target: { files },
    });

    expect(screen.getByText("1イベント")).toBeInTheDocument();
    expect(screen.getByText("4クリップ")).toBeInTheDocument();
    expect(screen.getByText("8.0 MiB")).toBeInTheDocument();
    expect(screen.getByText("RecentClips 1本を既定除外")).toBeInTheDocument();
    expect(
      screen.getByText("Tesla生成プレビュー 1本を除外（カメラ映像ではありません）"),
    ).toBeInTheDocument();
    expect(screen.getByText("未識別の動画 1本")).toBeInTheDocument();
    expect(screen.getByText("2026-08-03 12:34:56")).toBeInTheDocument();
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(4));
  });

  it("shows duration, codec and dimensions after local MP4 preflight", async () => {
    renderApp();
    const eventPath = "TeslaCam/SentryClips/2026-08-03_12-34-56";

    fireEvent.change(screen.getByLabelText("TeslaCamフォルダを選択"), {
      target: {
        files: [
          localFile(`${eventPath}/2026-08-03_12-32-00-front.mp4`),
          localFile(`${eventPath}/2026-08-03_12-32-00-back.mp4`),
        ],
      },
    });

    expect(await screen.findByText("解析可能 2本")).toBeInTheDocument();
    expect(screen.getByText("動画合計 2:00 · H.264 · 160×90")).toBeInTheDocument();
    expect(screen.queryByText(/要確認 \d+本/)).not.toBeInTheDocument();
  });

  it("keeps encrypted clips in a named review list", async () => {
    const probe: ClipPreflightProbe = async (file) =>
      file.name.endsWith("back.mp4")
        ? readyResult({ code: "encrypted", codec: "encv", encrypted: true })
        : readyResult();
    renderApp(probe);
    const eventPath = "TeslaCam/SentryClips/2026-08-03_12-34-56";

    fireEvent.change(screen.getByLabelText("TeslaCamフォルダを選択"), {
      target: {
        files: [
          localFile(`${eventPath}/2026-08-03_12-32-00-front.mp4`),
          localFile(`${eventPath}/2026-08-03_12-32-00-back.mp4`),
        ],
      },
    });

    expect(await screen.findByText("解析可能 1本")).toBeInTheDocument();
    expect(screen.getByText("要確認 1本")).toBeInTheDocument();
    expect(screen.getByText("2026-08-03_12-32-00-back.mp4")).toBeInTheDocument();
    expect(screen.getByText("暗号化された動画")).toBeInTheDocument();
  });

  it("ignores an earlier folder preflight that completes after a reselection", async () => {
    let resolveFirst: ((result: VideoPreflightResult) => void) | undefined;
    let resolveSecond: ((result: VideoPreflightResult) => void) | undefined;
    const probe: ClipPreflightProbe = (file) =>
      new Promise((resolve) => {
        if (file.name.includes("12-32-00")) {
          resolveFirst = resolve;
        } else {
          resolveSecond = resolve;
        }
      });
    renderApp(probe);
    const input = screen.getByLabelText("TeslaCamフォルダを選択");

    fireEvent.change(input, {
      target: {
        files: [
          localFile("TeslaCam/SentryClips/2026-08-03_12-34-56/2026-08-03_12-32-00-front.mp4"),
        ],
      },
    });
    fireEvent.change(input, {
      target: {
        files: [
          localFile("TeslaCam/SentryClips/2026-08-03_13-34-56/2026-08-03_13-32-00-front.mp4"),
        ],
      },
    });

    await act(async () => {
      resolveFirst?.(readyResult());
      await Promise.resolve();
    });
    expect(screen.getByText("検査中 0/1本")).toBeInTheDocument();

    await act(async () => {
      resolveSecond?.(readyResult({ code: "encrypted", codec: "encv", encrypted: true }));
      await Promise.resolve();
    });
    expect(await screen.findByText("要確認 1本")).toBeInTheDocument();
    expect(screen.getByText("解析可能 0本")).toBeInTheDocument();
    expect(screen.queryByText("解析可能 1本")).not.toBeInTheDocument();
  });

  it("does not pretend analysis can start when SentryClips is missing", () => {
    renderApp();

    fireEvent.change(screen.getByLabelText("TeslaCamフォルダを選択"), {
      target: {
        files: [localFile("TeslaCam/RecentClips/2026-08-03_12-33-00-front.mp4")],
      },
    });

    expect(screen.getByText("SentryClipsが見つかりませんでした")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解析を開始" })).not.toBeInTheDocument();
  });

  it("shows unknown-scope exclusions alongside the empty SentryClips result", () => {
    renderApp();

    fireEvent.change(screen.getByLabelText("TeslaCamフォルダを選択"), {
      target: {
        files: [localFile("TeslaCam/FutureClips/2026-08-03_12-35-00-front.mp4")],
      },
    });

    expect(screen.getByText("SentryClipsが見つかりませんでした")).toBeInTheDocument();
    expect(screen.getByText("未識別の動画 1本")).toBeInTheDocument();
    expect(screen.getByText("要確認 1件")).toBeInTheDocument();
  });
});
