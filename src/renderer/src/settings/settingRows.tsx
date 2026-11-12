import type React from "react";
import { useEffect, useRef } from "react";

/** The Settings row primitives every section shares: a section's micro label and a labeled row with one control. */

/**
 * The only Settings gaps, owned here so no tab writes its own: 32 above a section, 12 between the
 * rows inside one (and from a label or intro line to its first row), 8 from a label to its intro line.
 */
export const SECTION_GAP = "var(--space-6)";
export const ROW_GAP = "var(--space-3)";
export const LABEL_GAP = "var(--space-2)";

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "var(--text-xs)",
        fontWeight: 500,
        letterSpacing: "var(--tracking-label)",
        textTransform: "uppercase",
        color: "var(--fg-3)",
        marginBottom: ROW_GAP,
      }}
    >
      {children}
    </div>
  );
}

export function SettingRow({
  id,
  title,
  description,
  detail,
  control,
  controlOnTitle = false,
  error,
}: {
  /** A stable hook for the row, so a control with no visible label is findable. */
  id?: string;
  title: string;
  description: React.ReactNode;
  /** What the setting holds, when the words alone do not show it (a folder's path). */
  detail?: React.ReactNode;
  control: React.ReactNode;
  /**
   * Put the control at the top right, on the title's line, and give the text
   * the row's full width: for a row whose detail runs tall (Version's release
   * notes), where a control centred beside it would float mid-row (INF-2917).
   */
  controlOnTitle?: boolean;
  error?: string | null;
}) {
  const titleText = (
    <div style={{ fontSize: "var(--text-base)", color: "var(--fg-1)", fontWeight: 500 }}>
      {title}
    </div>
  );
  return (
    <div
      data-setting={id}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        padding: "14px 18px",
        background: "var(--bg-1)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-m)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {controlOnTitle ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--space-4)",
              fontSize: "var(--text-base)",
            }}
          >
            {titleText}
            {/* As tall as the title's line, so a taller control overhangs it evenly
                and the description below stays where it was. */}
            <div style={{ display: "flex", alignItems: "center", height: "1lh" }}>{control}</div>
          </div>
        ) : (
          titleText
        )}
        <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>{description}</div>
        {detail}
        {error && <SettingError error={error} />}
      </div>
      {!controlOnTitle && control}
    </div>
  );
}

export function SettingError({ error, surface }: { error: string | null; surface?: string }) {
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) feedback.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  if (!error) return null;
  return (
    <div
      ref={feedback}
      role="alert"
      data-settings-error={surface}
      style={{
        marginTop: "var(--space-2)",
        fontSize: "var(--text-sm)",
        color: "var(--danger)",
        overflowWrap: "anywhere",
      }}
    >
      {error}
    </div>
  );
}
