import * as m from "@shared/i18n/messages.generated";
import { type AnyCommandId, commandEntry, keyHint, keysOf } from "@shared/keyboard";
import { remindsOf } from "@shared/keyReminders";
import { useEffect, useRef, useState } from "react";
import { thisDesktop } from "../design/core/desktop";
import { installedKeymap, useInstalledKeymap } from "../design/core/installedKeys";
import { KeyCap } from "../design/core/KeyCap";
import { motionEase, motionToken } from "../design/motion";
import { clickedCommand } from "./keyClick";
import { keyReminders, onPanelKeyClick, useKeyReminders } from "./keyReminderState";
import { pressNotice } from "./presses";

/** How long a reminder shows when the token cannot be read (`--hold-key-reminder`). */
const HOLD_FALLBACK_MS = 5000;

/**
 * The key reminder (design skill `components/core/KeyReminder.prompt.md`,
 * docs/keyboard.md "The key reminder"): after a mouse click on a control
 * whose command has a key, one quiet line at the bottom of the window names
 * the command and the key its label shows, for about five seconds, fading in
 * and out as an in-place fade does; a click in a panel's own page reaches it
 * through the page (`onPanelKeyClick`). Any key, or another click, takes it
 * away at once, in a frame too. It stops for a command once that command's
 * key was pressed, and never shows while the switch is off. It takes no
 * pointer and no focus, and a screen reader skips it: the control already
 * names its key.
 */
export function KeyReminder() {
  const [shown, setShown] = useState<AnyCommandId | null>(null);
  const reminders = useKeyReminders();
  const { bindings, panels } = useInstalledKeymap();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hide = () => setShown(null);
    const remind = (id: AnyCommandId) => {
      if (remindsOf(keyReminders(), installedKeymap().bindings, id)) setShown(id);
    };
    // Capture: the clicked control may go with its own click, as Put aside does.
    const onClick = (event: MouseEvent) => {
      const id = clickedCommand(event) as AnyCommandId | null;
      if (id) remind(id);
    };
    // A press inside a card's or a panel's frame passes the page by: its bridge says so.
    const onNotice = (event: MessageEvent) => {
      if (pressNotice(event)) hide();
    };
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", hide, true);
    window.addEventListener("message", onNotice);
    // A key the window took for itself reaches no document.
    const stopTaken = window.infinitary.keyboard.onTaken(hide);
    // A click inside a panel's page reaches the window through the page (`keys.clicked`).
    const stopPanel = onPanelKeyClick(remind);
    return () => {
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", hide, true);
      window.removeEventListener("message", onNotice);
      stopTaken();
      stopPanel();
    };
  }, []);

  useEffect(() => {
    if (shown === null) return;
    const hold = motionToken(document.documentElement, "--hold-key-reminder") || HOLD_FALLBACK_MS;
    let leaving: Animation | undefined;
    // Its time up, it fades out the way it faded in; reduced motion reads 0, a cut.
    const timer = setTimeout(() => {
      const el = box.current;
      const duration = el ? motionToken(el, "--dur-fast") : 0;
      if (!el || duration <= 0) {
        setShown(null);
        return;
      }
      leaving = el.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration,
        easing: motionEase(el),
        fill: "forwards",
      });
      leaving.onfinish = () => setShown(null);
    }, hold);
    return () => {
      clearTimeout(timer);
      leaving?.cancel();
    };
  }, [shown]);

  if (shown === null || !remindsOf(reminders, bindings, shown)) return null;
  const system = thisDesktop().keys;
  const key = keyHint(shown, bindings, system);
  const label = commandEntry(shown, panels, system)?.label;
  if (key === undefined || label === undefined) return null;
  const notTyping = keysOf(bindings, shown)[0]?.when === "not-typing";
  return (
    <div
      key={shown}
      ref={box}
      aria-hidden="true"
      data-key-reminder={shown}
      data-in-place-reveal="fade"
      style={{
        position: "absolute",
        left: "50%",
        bottom: "var(--space-3)",
        transform: "translateX(-50%)",
        maxWidth: "calc(100% - 2 * var(--space-4))",
        display: "flex",
        alignItems: "baseline",
        flexWrap: "wrap",
        columnGap: "var(--space-3)",
        rowGap: "var(--space-1)",
        padding: "var(--space-2) var(--space-3)",
        background: "var(--bg-1)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-m)",
        boxShadow: "var(--shadow-2)",
        pointerEvents: "none",
        fontSize: "var(--text-sm)",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "baseline", gap: "var(--space-2)" }}>
        <KeyCap>{key}</KeyCap>
        <span data-key-reminder-label="" style={{ color: "var(--fg-1)" }}>
          {label}
        </span>
        {notTyping && (
          <span data-key-reminder-not-typing="" style={{ color: "var(--fg-3)" }}>
            {m.shellKeyReminderNotTyping()}
          </span>
        )}
      </span>
      <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
        {m.shellKeyReminderHint()}
      </span>
    </div>
  );
}
