import type React from "react";

/**
 * The quiet strip under the input (design skill `components/voice/
 * VoiceInput.prompt.md`, "Under the pill"): one line of plain words and at
 * most two small buttons. The voice notice and the first-launch diagnostics
 * notice both wear it, at the input's own width so the edges line up.
 */
export function NoticeStrip({
  width,
  children,
  ...rest
}: { width: string; children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        width,
        boxSizing: "border-box",
        padding: "var(--space-3) var(--space-4)",
        background: "var(--bg-1)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-m)",
      }}
    >
      {children}
    </div>
  );
}
