import type { DeviceView } from "@shared/devices";
import { deviceLabel } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import type { StandbyReady, StandbyView, StandbyViews } from "@shared/standby";
import { useEffect, useState } from "react";
import { useShellStore } from "../app/store";
import { Button } from "../design";
import { useHereAs } from "../devices/useFirstMatePlace";
import { sinceWhen } from "../devices/viewWords";

/**
 * Keeping a copy of the first mate on other computers (design skill
 * `components/devices/DevicesTab`, "Keeping a copy"): where each copy
 * stands, by computer, as the first mate pushes it.
 */
/** Where each copy stands, and a second home that answers with this one's number, as the first mate pushes them. */
export function useStandbyViews(): StandbyViews {
  const [views, setViews] = useState<StandbyViews>({ standbys: [] });
  useEffect(() => {
    const standby = window.infinitary?.devices?.standby;
    if (!standby) return;
    let current = true;
    const stop = standby.onViews((next) => setViews(next));
    standby
      .list()
      .then((next) => {
        if (current) setViews(next);
      })
      .catch(() => {});
    return () => {
      current = false;
      stop();
    };
  }, []);
  return views;
}

/** A computer's copy in one line under its summary, with a count in mono when it counts. */
export function StandbyLine({ view, now }: { view: StandbyView; now: number }) {
  const count =
    view.state === "copying" && view.total && view.done !== undefined
      ? `${Math.min(100, Math.floor((view.done / view.total) * 100))}%`
      : null;
  const text =
    view.state === "copying"
      ? m.settingsDevicesStandbyCopying()
      : view.state === "in-sync"
        ? m.settingsDevicesStandbyInSync()
        : view.state === "catching-up"
          ? m.settingsDevicesStandbyCatchingUp({ count: view.behind ?? 0 })
          : view.state === "needs-update"
            ? m.settingsDevicesStandbyNeedsUpdate()
            : view.copyAt === null
              ? m.settingsDevicesStandbyAwayNone()
              : m.settingsDevicesStandbyAway({ time: sinceWhen(view.copyAt, now) });
  return (
    <span
      className="fm-devices-version"
      data-standby={view.state}
      data-tone={view.state === "needs-update" ? "warn" : undefined}
    >
      {text}
      {count && <span className="fm-devices-move-count">{count}</span>}
    </span>
  );
}

/**
 * The Ready to take over list under a computer's row (design skill
 * `components/devices/DevicesTab`, "Keeping a copy"): the copy's own line,
 * then each gap a move there would show, with Stop keeping a copy and Close.
 */
export function StandbyQuestion({
  device,
  view,
  onClose,
}: {
  device: DeviceView;
  /** Its copy's line, so the list is read again once its secrets moved. */
  view?: StandbyView | undefined;
  onClose: () => void;
}) {
  const here = useHereAs();
  const label = deviceLabel(device);
  const [ready, setReady] = useState<StandbyReady | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const secrets = view?.secrets;
  // The list is read again when the copy's own state or its secrets move, so
  // a line read while a change was on its way does not stay.
  const copyState = view?.state;
  useEffect(() => {
    let current = true;
    // Once the computer answered, its own line says where its secrets stand.
    if (secrets !== "asking") setSaid(null);
    void copyState;
    window.infinitary.devices.standby
      .ready(device.id)
      .then((answer) => {
        if (current) setReady(answer);
      })
      .catch(() => {
        if (current) setProblem(m.settingsDevicesMoveCouldNot({ device: label }));
      });
    return () => {
      current = false;
    };
  }, [device.id, label, secrets, copyState]);
  const keepSecrets = () => {
    setProblem(null);
    void window.infinitary.devices.standby
      .keepSecrets(device.id)
      .then((answer) => {
        if (answer.ok) setSaid(answer.text);
        else setProblem(answer.text);
      })
      .catch(() => setProblem(m.settingsDevicesMoveCouldNot({ device: label })));
  };
  // Its own sign-ins are made from this window, where Settings starts them on that computer.
  const signInThere = (to: { providerId: string } | { host: string }) =>
    useShellStore.setState(
      "providerId" in to
        ? {
            view: "settings",
            settingsSection: "subscriptions",
            pendingDeviceSignIn: { deviceId: device.id, providerId: to.providerId },
          }
        : {
            view: "settings",
            settingsSection: "integrations",
            pendingDeviceForgeSignIn: { deviceId: device.id, host: to.host },
          },
    );
  const stop = () => {
    setProblem(null);
    void window.infinitary.devices.standby
      .name(device.id, false)
      .then((answer) => {
        if (answer.ok) onClose();
        else setProblem(answer.text);
      })
      .catch(() => setProblem(m.settingsDevicesMoveCouldNot({ device: label })));
  };
  return (
    <div className="fm-devices-aside" data-standby-ready={device.id}>
      <div className="fm-devices-question">
        {m.settingsDevicesStandbyQuestion({ device: label })}
      </div>
      <div className="fm-devices-aside-say">{m.settingsDevicesStandbySay({ device: label })}</div>
      {ready === null && !problem ? (
        <div className="fm-devices-aside-say" role="status">
          {m.settingsDevicesMoveChecking({ device: label })}
        </div>
      ) : ready ? (
        <ul className="fm-devices-move-gaps" data-standby-gaps="">
          {ready.gaps.map((gap) => (
            <li key={gap.id} data-level={gap.level} data-gap={gap.id}>
              {here(gap.text)}
              {gap.id === "secrets" && gap.level === "blocks" && secrets !== "asking" && (
                <div className="fm-devices-aside-actions">
                  <Button variant="ghost" size="sm" onClick={keepSecrets}>
                    {m.settingsDevicesStandbyKeepSecrets()}
                  </Button>
                </div>
              )}
              {gap.id === "sign-ins" && gap.level === "blocks" && ready.missing && (
                <div className="fm-devices-aside-actions">
                  {ready.missing.providers.map((provider) => (
                    <Button
                      key={provider.id}
                      variant="ghost"
                      size="sm"
                      onClick={() => signInThere({ providerId: provider.id })}
                    >
                      {m.settingsDevicesStandbySignInThere({ name: provider.name })}
                    </Button>
                  ))}
                  {ready.missing.forges.map((forge) => (
                    <Button
                      key={forge.host}
                      variant="ghost"
                      size="sm"
                      onClick={() => signInThere({ host: forge.host })}
                    >
                      {m.settingsDevicesStandbySignInThere({ name: forge.name })}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {said && !problem && (
        <div className="fm-devices-aside-say" role="status">
          {here(said)}
        </div>
      )}
      {problem && (
        <div className="fm-devices-aside-say" data-tone="warn" role="alert">
          {here(problem)}
        </div>
      )}
      <div className="fm-devices-aside-actions">
        <Button variant="ghost" size="sm" onClick={stop}>
          {m.settingsDevicesStandbyStop()}
        </Button>
        <Button variant="ghost" size="sm" autoFocus onClick={onClose}>
          {m.settingsDevicesStandbyClose()}
        </Button>
      </div>
    </div>
  );
}
