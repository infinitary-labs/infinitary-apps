import { COMMAND_NOTICE_WORDS, type CommandNotice } from "@shared/commandNotice";
import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useShellStore } from "../app/store";
import { Button } from "../design/core/Button";
import { useModalKeys } from "../design/core/modalKeys";
import { motionEase, motionToken } from "../design/motion";

/**
 * The notice over a window whose command stopped (design skill
 * `components/devices/CommandStopped.prompt.md`; docs/run.md, "When the
 * command stops"). The window was opened beside Infinitary started by a
 * command and holds no first mate of its own, so it says what happened
 * over the whole window: it waits where the command will be started
 * again, and otherwise offers Start it here beside Quit. Escape does
 * nothing; the notice goes when the command runs again.
 */
export function CommandStopped({
  notice,
  onStartHere,
  onQuit,
}: {
  notice: CommandNotice;
  onStartHere: () => void;
  onQuit: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const lineId = useId();
  // Focus starts on Quit, so Enter alone never starts a first mate here; Escape closes nothing.
  useModalKeys(root, () => {});
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
      data-command-stopped={notice.state}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
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
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={lineId}
        style={{
          width: "min(calc(5 * var(--space-9)), 100%)",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
          background: "var(--bg-2)",
          border: "1px solid var(--line-2)",
          borderRadius: "var(--radius-l)",
          boxShadow: "var(--shadow-2)",
          padding: "var(--space-5)",
          textAlign: "start",
          fontFamily: "var(--font-ui)",
        }}
      >
        <h2
          id={titleId}
          style={{ margin: 0, fontSize: "var(--text-md)", fontWeight: 500, color: "var(--fg-1)" }}
        >
          {COMMAND_NOTICE_WORDS.title(notice)}
        </h2>
        <p
          id={lineId}
          style={{
            margin: 0,
            color: "var(--fg-2)",
            fontSize: "var(--text-sm)",
            lineHeight: "var(--leading-body)",
          }}
        >
          {COMMAND_NOTICE_WORDS.line(notice)}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <Button variant="ghost" size="sm" onClick={onQuit}>
            {COMMAND_NOTICE_WORDS.quit}
          </Button>
          {notice.state === "stopped" && (
            <Button variant="primary" size="sm" onClick={onStartHere}>
              {COMMAND_NOTICE_WORDS.startHere}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The notice while this window's command is stopped, and nothing otherwise. */
export function CommandStoppedNotice() {
  const notice = useShellStore((s) => (s.thisMac?.role === "home" ? s.thisMac.command : undefined));
  if (!notice) return null;
  return (
    <CommandStopped
      // A notice that changes what it offers is drawn anew, so its keys follow its buttons.
      key={notice.state}
      notice={notice}
      onStartHere={() => void window.infinitary.app.startHere().catch(() => {})}
      onQuit={() => void window.infinitary.app.quit().catch(() => {})}
    />
  );
}
