import type { HomeUpdate } from "@shared/homeUpdate";
import * as m from "@shared/i18n/messages.generated";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../design";
import { focusWithRing } from "../design/focus";
import type { ViewMac } from "../devices/viewWords";
import {
  homeUpdateAboutToRestart,
  homeUpdateConfirm,
  homeUpdateLine,
  homeUpdateOffersUpdate,
  homeUpdateUnderWay,
} from "./homeUpdateWords";
import { SettingRow } from "./settingRows";

/** How often the row reads the home's update again while it moves on by itself. */
const READ_EVERY_MS = 3_000;
/** How long a home restarting for its update has to answer before the row says it has not come back. */
const BACK_WITHIN_MS = 3 * 60_000;

/** The row's hook, which command search's Update the first mate's computer focuses. */
export const HOME_UPDATE_ROW = "[data-home-update] button:not([disabled])";

/**
 * Settings → General on a Mac that controls another (docs/view.md, "Updating
 * the first mate's computer"): Infinitary on that Mac, its version and where
 * its update stands, with Update and Update later. Update asks first, naming
 * the running work that finishes before the restart and that nothing undoes
 * it from here. The home offers only what its own Version row offers and
 * saves its crew's work as an update started there does.
 */
export function HomeUpdateRow({ mac }: { mac: ViewMac }) {
  const [update, setUpdate] = useState<HomeUpdate | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** When the home stopped answering just as it was about to restart. */
  const [restartingSince, setRestartingSince] = useState<number | null>(null);
  const [notBack, setNotBack] = useState(false);
  const last = useRef<HomeUpdate | null>(null);
  const row = useRef<HTMLDivElement>(null);

  const read = useCallback(async (): Promise<HomeUpdate | null> => {
    try {
      const next = await window.infinitary.update.home.status();
      last.current = next;
      setUpdate(next);
      setRestartingSince(null);
      setNotBack(false);
      return next;
    } catch {
      // A home that stops answering as it restarts is the restart, never a success.
      if (homeUpdateAboutToRestart(last.current))
        setRestartingSince((since) => since ?? Date.now());
      return null;
    }
  }, []);

  // The confirmation names what the restart stops now, so Update reads the home again first.
  const arm = async () => {
    setBusy(true);
    const fresh = await read();
    setBusy(false);
    if (fresh && homeUpdateOffersUpdate(fresh)) setArmed(true);
  };

  useEffect(() => {
    void read();
  }, [read]);

  const moving = homeUpdateUnderWay(update) || restartingSince !== null;
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => void read(), READ_EVERY_MS);
    return () => clearInterval(timer);
  }, [moving, read]);

  useEffect(() => {
    if (restartingSince === null) return;
    const timer = setTimeout(
      () => setNotBack(true),
      Math.max(0, restartingSince + BACK_WITHIN_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [restartingSince]);

  // Arming moves focus to the confirming Update, so Enter twice is the whole journey.
  useEffect(() => {
    if (!armed) return;
    const confirm = row.current?.querySelector<HTMLButtonElement>("[data-home-update-confirm]");
    if (confirm) focusWithRing(confirm);
  }, [armed]);

  const press = async (ask: () => Promise<HomeUpdate>) => {
    setBusy(true);
    setProblem(null);
    try {
      const next = await ask();
      last.current = next;
      setUpdate(next);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  if (!update) return null;
  const name = mac.name;
  const confirm = armed ? homeUpdateConfirm(update, name) : null;
  const description = notBack
    ? m.viewHomeUpdateNotBack({ name })
    : restartingSince !== null
      ? m.viewHomeUpdateRestarting({ name })
      : confirm
        ? confirm.title
        : homeUpdateLine(update, name);

  let control: React.ReactNode = null;
  if (restartingSince === null && confirm) {
    control = (
      <>
        <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
          {m.viewHomeUpdateNotNow()}
        </Button>
        <Button
          variant="primary"
          size="sm"
          data-home-update-confirm=""
          pending={busy}
          onClick={() => void press(() => window.infinitary.update.home.install())}
        >
          {m.viewHomeUpdateButton({ name })}
        </Button>
      </>
    );
  } else if (restartingSince === null && homeUpdateOffersUpdate(update)) {
    control = (
      <Button variant="secondary" size="sm" pending={busy} onClick={() => void arm()}>
        {update.step === "failed" ? m.viewHomeUpdateTryAgain() : m.viewHomeUpdateButton({ name })}
      </Button>
    );
  } else if (restartingSince === null && update.step === "saving") {
    control = (
      <Button
        variant="secondary"
        size="sm"
        pending={busy}
        onClick={() => void press(() => window.infinitary.update.home.later())}
      >
        {m.viewHomeUpdateLater()}
      </Button>
    );
  }

  return (
    <div ref={row} data-home-update={update.step}>
      <SettingRow
        id="home-update"
        title={m.viewHomeUpdateRow({ name })}
        description={<span role="status">{description}</span>}
        detail={
          confirm && (
            <ul
              data-home-update-stops=""
              style={{
                margin: "var(--space-2) 0 0",
                paddingInlineStart: "var(--space-4)",
                fontSize: "var(--text-sm)",
                color: "var(--fg-2)",
              }}
            >
              {confirm.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )
        }
        control={
          control && (
            <div style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}>{control}</div>
          )
        }
        error={problem}
      />
    </div>
  );
}
