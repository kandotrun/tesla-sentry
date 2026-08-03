import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

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

describe("App", () => {
  it("explains the local-first folder selection before any file is chosen", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "セントリー映像、全部見なくていい。" }),
    ).toBeInTheDocument();
    expect(screen.getByText("フォルダを選択しても、動画本体は送信されません")).toBeInTheDocument();
    expect(screen.getByText("フォルダを選んで整理結果を見る")).toBeInTheDocument();
    expect(screen.getByText("このMVPではローカル整理まで")).toBeInTheDocument();
    const input = screen.getByLabelText("TeslaCamフォルダを選択");
    expect(input).toHaveAttribute("webkitdirectory");
    expect(input).toHaveAttribute("multiple");
  });

  it("shows the SentryClips manifest and excluded RecentClips after selection", () => {
    render(<App />);
    const eventPath = "TeslaCam/SentryClips/2026-08-03_12-34-56";
    const files = [
      localFile(`${eventPath}/2026-08-03_12-32-00-front.mp4`),
      localFile(`${eventPath}/2026-08-03_12-32-00-back.mp4`),
      localFile(`${eventPath}/2026-08-03_12-32-00-left_repeater.mp4`),
      localFile(`${eventPath}/2026-08-03_12-32-00-right_repeater.mp4`),
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
    expect(screen.getByText("未識別の動画 1本")).toBeInTheDocument();
    expect(screen.getByText("2026-08-03 12:34:56")).toBeInTheDocument();
  });

  it("does not pretend analysis can start when SentryClips is missing", () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("TeslaCamフォルダを選択"), {
      target: {
        files: [localFile("TeslaCam/RecentClips/2026-08-03_12-33-00-front.mp4")],
      },
    });

    expect(screen.getByText("SentryClipsが見つかりませんでした")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解析を開始" })).not.toBeInTheDocument();
  });

  it("shows unknown-scope exclusions alongside the empty SentryClips result", () => {
    render(<App />);

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
