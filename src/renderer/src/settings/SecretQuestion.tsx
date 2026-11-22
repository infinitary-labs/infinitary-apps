import type { SecretsView } from "@shared/secrets";
import { useLayoutEffect, useRef } from "react";
import { Button } from "../design";

type Question = NonNullable<SecretsView["question"]>;

/**
 * The question Secrets asks on the row it is about (docs/secrets.md, "Asking
 * in place"; design skill `components/secrets/SecretsTab`): its title, its
 * sentences, then Keep, which has focus so Enter never confirms, and the
 * danger answer. Both answers send the one-time pass the host made for them;
 * the page never decides by itself. Used in Settings -> Secrets and under the
 * switch in Settings -> Devices, the same way Remove project asks.
 */
export function SecretQuestion({
  question,
  answering,
  onAnswer,
  first = false,
}: {
  question: Question;
  /** Nothing sits above it in its row, so the row's own divider is enough: no line or space of its own. */
  first?: boolean;
  /** A Secrets request is still in flight; both buttons wait. */
  answering: boolean;
  onAnswer: (pass: string, confirmed: boolean) => void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  const focusedPass = useRef<string | null>(null);
  const keepPass = question.keep.pass;
  useLayoutEffect(() => {
    // A change notification can draw the question before the request that opened it finishes.
    // Focus the safe answer once per question, after the DOM enables it.
    if (answering || focusedPass.current === keepPass || !keep.current) return;
    keep.current.focus();
    focusedPass.current = keepPass;
  }, [answering, keepPass]);
  return (
    <div
      data-secret-question={question.about.kind}
      style={{
        display: "grid",
        gap: "var(--space-2)",
        paddingBlockStart: first ? 0 : "var(--space-3)",
        paddingBlockEnd: "var(--space-3)",
        borderBlockStart: first ? "none" : "1px solid var(--line-1)",
        inlineSize: "100%",
      }}
    >
      <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
        {question.title}
      </div>
      {question.lines.map((line) => (
        <div key={line} style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
          {line}
        </div>
      ))}
      <span
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--space-2)",
          paddingBlockStart: "var(--space-1)",
        }}
      >
        <Button
          variant="secondary"
          size="sm"
          ref={keep}
          disabled={answering}
          onClick={() => onAnswer(keepPass, false)}
        >
          {question.keep.label}
        </Button>
        <Button
          variant="danger"
          size="sm"
          pending={answering}
          onClick={() => onAnswer(question.confirm.pass, true)}
        >
          {question.confirm.label}
        </Button>
      </span>
    </div>
  );
}
