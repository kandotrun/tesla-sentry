import type { ContactVerdict } from "@sentry-check/camera-geometry";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContactVerdictPanel } from "./ContactVerdictPanel";

function renderPanel(verdict: ContactVerdict) {
  return render(<ContactVerdictPanel verdict={verdict} />);
}

describe("ContactVerdictPanel", () => {
  it("warns about a possible contact without claiming a collision or damage", () => {
    renderPanel({ reasons: ["back_temporal_impact_signal"], verdict: "possible_contact" });

    expect(screen.getByRole("heading", { name: "接触の可能性があります" })).toBeInTheDocument();
    expect(
      screen.getByText("後方映像で接触の可能性を示す動きを検出しました。映像を確認してください。"),
    ).toBeInTheDocument();
    expect(screen.getByText("接触の可能性があります").closest("section")).toHaveClass(
      "contact-verdict--warning",
    );
    expect(screen.getByText("接触の可能性があります").closest("section")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    expect(screen.queryByText(/接触しました|損傷があります/)).not.toBeInTheDocument();
  });

  it("explains that all-camera temporal activity is not confirmed contact", () => {
    renderPanel({ reasons: ["camera_temporal_activity_signal"], verdict: "possible_contact" });

    expect(screen.getByRole("heading", { name: "接触の可能性があります" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "カメラ映像で接触の可能性につながる時間変化を検出しました。接触を確定する結果ではありません。映像を確認してください。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/接触しました|損傷があります/)).not.toBeInTheDocument();
  });

  it("shows the stricter direct-geometry contact finding with an alert modifier", () => {
    renderPanel({ reasons: [], verdict: "contact" });

    expect(screen.getByRole("heading", { name: "接触を示す所見があります" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "左右側面の直接幾何判定で、接触を示す所見を検出しました。映像を確認してください。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("接触を示す所見があります").closest("section")).toHaveClass(
      "contact-verdict--alert",
    );
  });

  it("describes no observed contact without promising no damage", () => {
    renderPanel({ reasons: [], verdict: "no_contact_observed" });

    expect(
      screen.getByRole("heading", { name: "接触を示す所見は検出されませんでした" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "映像上、接触を示す所見は検出されませんでした。映像に映らない範囲については判断できません。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("接触を示す所見は検出されませんでした").closest("section")).toHaveClass(
      "contact-verdict--neutral",
    );
    expect(screen.queryByText(/接触していません|損傷はありません/)).not.toBeInTheDocument();
  });

  it("asks for video review when the result is indeterminate", () => {
    renderPanel({ reasons: ["insufficient_camera_coverage"], verdict: "indeterminate" });

    expect(screen.getByRole("heading", { name: "判定できません" })).toBeInTheDocument();
    expect(screen.getByText("映像を確認してください。")).toBeInTheDocument();
    expect(screen.getByText("判定できません").closest("section")).toHaveClass(
      "contact-verdict--review",
    );
  });
});
