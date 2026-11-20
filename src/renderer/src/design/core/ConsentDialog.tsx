import * as m from "@shared/i18n/messages.generated";
import { type ReactNode, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motionEase, motionToken } from "../motion";
import { Button } from "./Button";
import { useModalKeys } from "./modalKeys";

/**
 * The one dialog that asks the person to agree before something is shared or
 * charged (design skill `components/core/ConsentDialog.prompt.md`): a title,
 * the rows that say what is agreed to, an optional field, and Not now beside
 * the act. Escape and Not now close it having changed nothing; only the act
 * calls `onAct`.
 */
export function ConsentDialog({
  title,
  facts,
  act,
  actDisabled = false,
  onAct,
  onClose,
  children,
}: {
  title: string;
  /** The rows, label then sentence, in the order the dialog shows them. */
  facts: readonly (readonly [label: string, text: string])[];
  /** The act's verb on the primary button: "Turn on", "Allow". */
  act: string;
  actDisabled?: boolean;
  onAct: () => void;
  onClose: () => void;
  /** A field the act needs, under the rows. */
  children?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const factsId = useId();
  // Focus starts on the first field, or on Not now: Enter alone never agrees.
  useModalKeys(root, onClose);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const duration = motionToken(el, "--dur-quick");
    if (duration <= 0) return;
    const scale = motionToken(el, "--scale-pop") || 1;
    el.animate(
      [
        { opacity: 0, transform: `scale(${scale})` },
        { opacity: 1, transform: "none" },
      ],
      { duration, easing: motionEase(el) },
    );
  }, []);
  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-4)",
        background: "color-mix(in srgb, var(--bg-0) 80%, transparent)",
        backdropFilter: "var(--blur-overlay)",
        WebkitBackdropFilter: "var(--blur-overlay)",
      }}
    >
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={factsId}
        style={{
          width: "min(calc(5 * var(--space-9)), 100%)",
          maxHeight: "calc(100dvh - 2 * var(--space-4))",
          overflowY: "auto",
          boxSizing: "border-box",
          background: "var(--bg-2)",
          border: "1px solid var(--line-2)",
          borderRadius: "var(--radius-l)",
          boxShadow: "var(--shadow-2)",
          padding: "var(--space-5)",
          textAlign: "start",
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!actDisabled) onAct();
          }}
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
        >
          <h2
            id={titleId}
            style={{
              margin: 0,
              fontSize: "var(--text-md)",
              fontWeight: 500,
              color: "var(--fg-1)",
            }}
          >
            {title}
          </h2>
          <dl
            id={factsId}
            style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", margin: 0 }}
          >
            {facts.map(([label, text]) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  columnGap: "var(--space-3)",
                  rowGap: "var(--space-1)",
                  alignItems: "baseline",
                }}
              >
                <dt
                  style={{
                    flex: "0 0 7em",
                    color: "var(--fg-2)",
                    fontSize: "var(--text-sm)",
                    fontWeight: 500,
                  }}
                >
                  {label}
                </dt>
                <dd
                  style={{
                    flex: "1 1 24ch",
                    margin: 0,
                    color: "var(--fg-2)",
                    fontSize: "var(--text-sm)",
                    lineHeight: "var(--leading-body)",
                  }}
                >
                  {text}
                </dd>
              </div>
            ))}
          </dl>
          {children}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {m.uiConsentNotNow()}
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={actDisabled}>
              {act}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
