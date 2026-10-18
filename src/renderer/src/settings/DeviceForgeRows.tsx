import type { ComputerForges, DeviceSignIns } from "@shared/signIns";
import { signInPlace } from "@shared/signIns";
import { useCallback, useEffect, useState } from "react";
import { useShellStore } from "../app/store";
import { Badge, Button, RowMenu, StatusDot, type StatusDotTone } from "../design";
import { useOverflowTitle } from "../design/core/overflowTitle";
import { DeviceSignInAside, type Flow } from "./DeviceSignIns";
import { DEVICE_FORGE_ROLE } from "./deviceForgeWords";
import { awayWord } from "./devicesWords";

/**
 * Settings -> Projects, "Where your projects live", for each computer that
 * runs work (design skill `components/devices/SignInOnAMac`, "GitHub on
 * another device"; docs/forge.md, "A computer's own sign-in"): under this
 * Mac's own row, a row per computer and host - "GitHub · octo" over "Mac mini
 * · clones and pushes its own work", or the computer's name over "not signed
 * in to GitHub" with a Sign in. The host's device flow runs on that
 * computer: its code to read is drawn in the aside under the row, and that
 * computer finishes the sign-in itself. Nothing is typed here.
 *
 * Nothing here draws on a Mac that controls another (`inf:devices:shown`).
 */

export type DeviceForgeRow = {
  deviceId: string;
  host: string;
  /** The person's word for the host ("GitHub"). */
  hostName: string;
  place: ReturnType<typeof signInPlace>;
  inReach: boolean;
  /** Out of reach only because its connection is being made. */
  connecting: boolean;
  /** Its sign-in there, or null when it has none. */
  signIn: ComputerForges["signIns"][number] | null;
};

/** One row per computer and host it offers, from what each computer last said of itself. */
export function deviceForgeRows(devices: DeviceSignIns[]): DeviceForgeRow[] {
  return devices.flatMap((device) => {
    const forges = device.signIns?.forges;
    if (!forges) return [];
    return forges.hosts.map((host) => ({
      deviceId: device.deviceId,
      host: host.host,
      hostName: host.name,
      place: signInPlace(device),
      inReach: device.reach === "in-reach",
      connecting: device.reach === "connecting",
      signIn: forges.signIns.find((entry) => entry.host === host.host) ?? null,
    }));
  });
}

/** The row's dot, title and mono line, from its sign-in's health and where it runs. */
export function deviceForgeRowView(row: DeviceForgeRow): {
  tone: StatusDotTone;
  label: string;
  title: string;
  line: string;
  reauth: boolean;
} {
  const away = row.inReach ? "" : ` · ${awayWord(row.connecting)}`;
  if (!row.signIn)
    return {
      tone: "idle",
      label: `not signed in to ${row.hostName}`,
      title: row.place.label,
      line: `not signed in to ${row.hostName}${away}`,
      reauth: false,
    };
  const title = row.signIn.login ? `${row.hostName} · ${row.signIn.login}` : row.hostName;
  const line = `${row.place.label} · ${DEVICE_FORGE_ROLE}${away}`;
  switch (row.signIn.state) {
    case "ok":
      return { tone: "ok", label: "signed in", title, line, reauth: false };
    case "needs_reauth":
      return { tone: "danger", label: "sign in again", title, line, reauth: true };
    case "unavailable":
      return {
        tone: "ring",
        label: `signed in · could not reach ${row.hostName}`,
        title,
        line,
        reauth: false,
      };
    default:
      return { tone: "ring", label: "signed in · checking", title, line, reauth: false };
  }
}

/**
 * The computers' rows, below this Mac's own. `onAny` says whether any draws,
 * so this Mac's row names its own part.
 */
export function DeviceForgeRows({ onAny }: { onAny?: (any: boolean) => void }) {
  const [shown, setShown] = useState(false);
  const [devices, setDevices] = useState<DeviceSignIns[]>([]);
  const [flows, setFlows] = useState<Record<string, Flow>>({});

  useEffect(() => {
    let live = true;
    void window.infinitary.devices
      .shown()
      .then(({ shown: offered }) => {
        if (!live || !offered) return;
        setShown(true);
        void window.infinitary.devices.signIns().then((next) => live && setDevices(next));
      })
      .catch(() => {});
    const offDevices = window.infinitary.devices.onSignIns((next) => setDevices(next));
    const offStep = window.infinitary.devices.onSignIn((event) => {
      setFlows((current) => {
        const key = `${event.deviceId}:${event.providerId}`;
        const flow = current[key];
        // Only a sign-in this section started: Intelligence draws the others.
        if (!flow || (flow.signInId !== null && flow.signInId !== event.signInId)) return current;
        const next: Flow = { ...flow, signInId: event.signInId };
        const { step } = event;
        if (step.kind === "notice") {
          next.notice = step.notice;
          if (step.notice.url) next.link = step.notice.url;
        } else if (step.kind === "ended") {
          // Signed in, or said no on the host's page: the row says it.
          if (step.outcome === "signed-in" || step.outcome === "cancelled") {
            const rest = { ...current };
            delete rest[key];
            return rest;
          }
          next.ended = step;
        }
        return { ...current, [key]: next };
      });
    });
    return () => {
      live = false;
      offDevices();
      offStep();
    };
  }, []);

  const rows = shown ? deviceForgeRows(devices) : [];
  useEffect(() => {
    onAny?.(rows.length > 0);
  }, [rows.length, onAny]);

  const signIn = useCallback((row: DeviceForgeRow) => {
    const key = `${row.deviceId}:${row.host}`;
    setFlows((current) => ({
      ...current,
      [key]: { signInId: null, deviceId: row.deviceId, providerId: row.host },
    }));
    void window.infinitary.devices
      .forgeSignIn(row.deviceId, row.host)
      .then(({ signInId }) =>
        setFlows((current) =>
          current[key]?.signInId === null
            ? { ...current, [key]: { ...current[key], signInId } }
            : current,
        ),
      )
      .catch((caught: unknown) =>
        setFlows((current) => ({
          ...current,
          [key]: {
            signInId: null,
            deviceId: row.deviceId,
            providerId: row.host,
            refused: caught instanceof Error ? caught.message : String(caught),
          },
        })),
      );
  }, []);

  // The host's card for a computer that needs its own sign-in lands here
  // with that sign-in to start, so the code is on screen when the section
  // opens (docs/forge.md, "A computer's own sign-in").
  const pending = useShellStore((s) => s.pendingDeviceForgeSignIn);
  useEffect(() => {
    if (!pending) return;
    const row = rows.find(
      (entry) => entry.deviceId === pending.deviceId && entry.host === pending.host,
    );
    if (!row) return;
    useShellStore.getState().clearPendingDeviceForgeSignIn();
    if (!row.signIn && row.inReach) signIn(row);
  }, [pending, rows, signIn]);

  const stop = (key: string, flow: Flow) => {
    if (flow.signInId && !flow.ended && !flow.refused)
      void window.infinitary.devices.cancelSignIn(flow.signInId).catch(() => {});
    setFlows((current) => {
      const rest = { ...current };
      delete rest[key];
      return rest;
    });
  };

  return (
    <>
      {rows.map((row) => {
        const key = `${row.deviceId}:${row.host}`;
        const flow = flows[key];
        const starting = Boolean(flow && !flow.notice && !flow.ended && !flow.refused);
        return (
          <div key={key}>
            <DeviceForgeRowLine
              row={row}
              starting={starting}
              open={Boolean(flow)}
              onSignIn={() => signIn(row)}
              onSignOut={() =>
                void window.infinitary.devices.forgeSignOut(row.deviceId, row.host).catch(() => {})
              }
            />
            {flow && (
              <DeviceSignInAside
                flow={flow}
                providerName={row.hostName}
                place={row.place}
                typed=""
                onTyped={() => {}}
                onAnswer={() => {}}
                onStop={() => stop(key, flow)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function DeviceForgeRowLine({
  row,
  starting,
  open,
  onSignIn,
  onSignOut,
}: {
  row: DeviceForgeRow;
  /** Asked there, and no code back yet. */
  starting: boolean;
  /** Its aside is open: one sign-in at a time. */
  open: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const view = deviceForgeRowView(row);
  const notSignedIn = view.label.startsWith("not signed in to ");
  const lineFit = useOverflowTitle(notSignedIn ? view.line : undefined);
  const nativeTitle =
    view.label !== "signed in" &&
    view.label !== "sign in again" &&
    !(notSignedIn && view.line.startsWith(view.label) && !lineFit.hidden);
  return (
    <div
      className="fm-forges-row"
      data-device-forge-row={row.deviceId}
      data-forge-host={row.host}
      data-forge-state={row.signIn?.state ?? "none"}
    >
      <span className="fm-forges-dot">
        <StatusDot tone={view.tone} label={view.label} nativeTitle={nativeTitle} focusable />
      </span>
      <span className="fm-forges-name">{view.title}</span>
      <span className="fm-forges-who">
        {row.signIn &&
          (view.reauth ? (
            <span className="fm-forges-state" data-tone="danger">
              Sign in again.
            </span>
          ) : (
            <Badge tone="ok">signed in</Badge>
          ))}
        <span className="fm-forges-sub" ref={notSignedIn ? lineFit.ref : undefined}>
          {view.line}
        </span>
      </span>
      <span className="fm-forges-action">
        {(!row.signIn || view.reauth) && (
          <Button
            variant={view.reauth ? "primary" : "secondary"}
            size="sm"
            pending={starting}
            pendingLabel="Starting..."
            disabled={!row.inReach || open}
            onClick={onSignIn}
          >
            {view.reauth ? "Sign in again" : "Sign in"}
          </Button>
        )}
      </span>
      <span className="fm-forges-menu">
        {row.signIn && (
          <RowMenu
            label={`${row.hostName} ${row.place.where} actions`}
            items={[{ id: "sign-out", label: "Sign out", tone: "danger", onSelect: onSignOut }]}
          />
        )}
      </span>
    </div>
  );
}
