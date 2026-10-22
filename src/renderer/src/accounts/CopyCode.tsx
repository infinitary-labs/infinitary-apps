import { FORGE_SECTION_WORDS } from "@shared/forges";
import { useState } from "react";
import { Button } from "../design";

type CopyState = "idle" | "copying" | "copied" | "failed";

/**
 * Copying a sign-in code, and the one status line that says how it went.
 * Feedback belongs only to this code and this sign-in attempt, so a caller
 * keys the owner by the code.
 */
export function useCopyCode(
  code: string,
  /** The status line sits beside the button rather than under it. */
  inline = false,
): {
  state: CopyState;
  copy: () => Promise<void>;
  status: React.ReactNode;
} {
  const [state, setState] = useState<CopyState>("idle");
  const copy = async () => {
    setState("copying");
    try {
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  const status = (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        display: inline ? "inline" : "block",
        marginLeft: inline ? "var(--space-2)" : undefined,
        fontSize: "var(--text-sm)",
        color: state === "failed" ? "var(--danger)" : "var(--fg-2)",
      }}
    >
      {state === "copied"
        ? FORGE_SECTION_WORDS.copied
        : state === "failed"
          ? FORGE_SECTION_WORDS.copyFailed
          : ""}
    </span>
  );
  return { state, copy, status };
}

/** The Copy code button and its status line. */
export function CopyCode({ code }: { code: string }) {
  const { state, copy, status } = useCopyCode(code);
  return (
    <>
      <CopyCodeButton state={state} onCopy={() => void copy()} />
      {status}
    </>
  );
}

export function CopyCodeButton({ state, onCopy }: { state: CopyState; onCopy: () => void }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      pending={state === "copying"}
      pendingLabel="Copying..."
      style={{ marginLeft: "var(--space-2)" }}
      onClick={onCopy}
    >
      Copy code
    </Button>
  );
}
