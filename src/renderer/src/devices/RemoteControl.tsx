import * as m from "@shared/i18n/messages.generated";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShellStore } from "../app/store";
import { StatusDot } from "../design";
import { textIsHidden, useOverflowTitle } from "../design/core/overflowTitle";
import { backWords, clockTime, isView, pillWords, topLine, type ViewMac } from "./viewWords";
import "./remoteControl.css";

/**
 * The app while it controls Firstmate on another Mac (design skill
 * `components/devices/RemoteControl`, docs/view.md): the top line that
 * names that Mac, and the one pill under the top bar that says why changes
 * are off, or that it is back.
 */

/** At the top bar's left: "Controlling your Firstmate on MacBook Pro", or that it is out of reach. */
export function RemoteControlLine() {
  const thisMac = useShellStore((s) => s.thisMac);
  if (!isView(thisMac)) return null;
  return <RemoteControlLineView mac={thisMac} />;
}

export function RemoteControlLineView({ mac }: { mac: ViewMac }) {
  const line = topLine(mac);
  const away = mac.contact === "lost" || mac.contact === "closed";
  const nameFit = useOverflowTitle(line.name);
  const stateFit = useOverflowTitle([line.lead, line.name, line.tail].filter(Boolean).join(" "));
  return (
    <div className="fm-remote-line" data-remote-control={mac.contact} ref={stateFit.ref}>
      <StatusDot
        tone={line.tone}
        label={
          away
            ? m.devicesRemoteOutOfReach({ name: mac.name })
            : m.devicesRemoteControlling({ name: mac.name })
        }
        nativeTitle={nameFit.hidden || stateFit.hidden}
      />
      {line.lead && <span className="fm-remote-lead">{line.lead}</span>}
      <span className="fm-remote-name" ref={nameFit.ref}>
        {line.name}
      </span>
      {line.tail && <span className="fm-remote-lead">{line.tail}</span>}
      {away && mac.heardAt !== null && (
        <span className="fm-remote-time" data-as-of="">
          {clockTime(mac.heardAt)}
        </span>
      )}
    </div>
  );
}

/** How long "is back" stands before it fades. */
const BACK_SHOWN_MS = 2_600;

/** The one centred line under the top bar, while changes are off or just after they come back. */
export function ViewPill() {
  const thisMac = useShellStore((s) => s.thisMac);
  const mac = isView(thisMac) ? thisMac : null;
  const words = mac ? pillWords(mac) : null;
  // Contact that returns says so once, then fades.
  const [back, setBack] = useState<"shown" | "fading" | null>(null);
  const wasAway = useRef(false);
  const away = mac !== null && (mac.contact === "lost" || mac.contact === "closed");
  useEffect(() => {
    if (away) {
      wasAway.current = true;
      setBack(null);
      return;
    }
    if (!wasAway.current || mac?.contact !== "in-reach") return;
    wasAway.current = false;
    setBack("shown");
    const fade = window.setTimeout(() => setBack("fading"), BACK_SHOWN_MS);
    const gone = window.setTimeout(() => setBack(null), BACK_SHOWN_MS + 1_000);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(gone);
    };
  }, [away, mac?.contact]);
  const notice = mac ? (words ?? (back ? backWords(mac) : null)) : null;
  const repeats =
    notice !== null &&
    mac !== null &&
    (notice.includes(m.devicesRemoteChangesOff()) ||
      notice.includes(m.devicesRemoteBack({ name: mac.name })));
  const noticeFit = useOverflowTitle(repeats ? notice : undefined);
  if (!mac) return null;
  if (words)
    return (
      <div className="fm-remote-pill" role="status" data-view-pill={mac.readOnly ?? mac.contact}>
        <StatusDot
          tone="warn"
          label={m.devicesRemoteChangesOff()}
          nativeTitle={!repeats || noticeFit.hidden}
        />
        <span data-view-pill-words="" ref={repeats ? noticeFit.ref : undefined}>
          {words}
        </span>
      </div>
    );
  if (!back) return null;
  return (
    <div
      className="fm-remote-pill"
      role="status"
      data-view-pill="back"
      data-fading={back === "fading"}
    >
      <StatusDot
        tone="ok"
        label={m.devicesRemoteBack({ name: mac.name })}
        nativeTitle={!repeats || noticeFit.hidden || back === "fading"}
      />
      <span data-view-pill-words="" ref={noticeFit.ref}>
        {backWords(mac)}
      </span>
    </div>
  );
}

/** True when the visible connection notice already shows this exact sentence and is not cut short. */
export function useConnectionNoticeCovers(sentence: string | null): boolean {
  const [covers, setCovers] = useState(false);
  useLayoutEffect(() => {
    if (!sentence) {
      setCovers(false);
      return;
    }
    const measure = () => {
      const words = document.querySelector("[data-view-pill-words]");
      const pill = words?.closest("[data-view-pill]");
      if (!(words instanceof HTMLElement) || pill?.getAttribute("data-fading") === "true") {
        setCovers(false);
        return;
      }
      const text = words.textContent ?? "";
      setCovers(text.includes(sentence) && !textIsHidden(words));
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    const words = document.querySelector("[data-view-pill-words]");
    if (words) observer?.observe(words);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [sentence]);
  return covers;
}
