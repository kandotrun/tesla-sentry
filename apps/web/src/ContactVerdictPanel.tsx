import type { ContactVerdict } from "@sentry-check/camera-geometry";

type VerdictPresentation = {
  readonly body: string;
  readonly heading: string;
  readonly modifier: "warning" | "alert" | "neutral" | "review";
};

function presentVerdict(verdict: ContactVerdict): VerdictPresentation {
  switch (verdict.verdict) {
    case "possible_contact":
      return {
        body: "後方映像で接触の可能性を示す動きを検出しました。映像を確認してください。",
        heading: "接触の可能性があります",
        modifier: "warning",
      };
    case "contact":
      return {
        body: "左右側面の直接幾何判定で、接触を示す所見を検出しました。映像を確認してください。",
        heading: "接触を示す所見があります",
        modifier: "alert",
      };
    case "no_contact_observed":
      return {
        body: "映像上、接触を示す所見は検出されませんでした。映像に映らない範囲については判断できません。",
        heading: "接触を示す所見は検出されませんでした",
        modifier: "neutral",
      };
    case "indeterminate":
      return {
        body: "映像を確認してください。",
        heading: "判定できません",
        modifier: "review",
      };
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
}

export function ContactVerdictPanel({ verdict }: { readonly verdict: ContactVerdict }) {
  const presentation = presentVerdict(verdict);

  return (
    <section
      className={`contact-verdict contact-verdict--${presentation.modifier}`}
      aria-live="polite"
    >
      <p className="contact-verdict__eyebrow">映像判定</p>
      <h2>{presentation.heading}</h2>
      <p className="contact-verdict__body">{presentation.body}</p>
    </section>
  );
}
