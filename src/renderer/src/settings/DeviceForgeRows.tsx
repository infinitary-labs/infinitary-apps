import { awayWord } from "@shared/devices";
import { kindByName } from "@shared/forge";
import { FORGE_CLI_WORDS } from "@shared/forges";
import type { ComputerForges, DeviceSignIns } from "@shared/signIns";
import { REMOTE_SIGN_IN_UPDATE_NOTE, signInPlace } from "@shared/signIns";
import { useCallback, useEffect } from "react";
import { useShellStore } from "../app/store";
import { Badge, Button, RowMenu, StatusDot, type StatusDotTone } from "../design";
import { useOverflowTitle } from "../design/core/overflowTitle";
import { DeviceSignInAside, type Flow, SignInNeedsUpdate } from "./DeviceSignIns";
import { DEVICE_FORGE_ROLE } from "./deviceForgeWords";
import { GitHubCliLine } from "./GitHubCliLine";
import { useDeviceSignIns } from "./useDeviceSignIns";

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
  /** That computer has GitHub CLI, so its GitHub sign-in may use GitHub CLI's (docs/forge.md, "A computer's own sign-in"). */
  githubCli: boolean;
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
      githubCli: forges.githubCli === true && kindByName(host.host) === "github",
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
  const through = row.signIn.way === "cli" ? ` · ${FORGE_CLI_WORDS.through}` : "";
  const line = `${row.place.label}${through} · ${DEVICE_FORGE_ROLE}${away}`;
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
export function DeviceForgeRows({ onAny }: { onAny?: (any: boolean) => void } = {}) {
  const devices = useDeviceSignIns();
  const rows = deviceForgeRows(devices);
  useEffect(() => {
    onAny?.(rows.length > 0);
  }, [rows.length, onAny]);

  const signIn = useCallback(
    (row: DeviceForgeRow) => {
      if (!devices.find((device) => device.deviceId === row.deviceId)?.flows) return;
      void window.infinitary.devices.forgeSignIn(row.deviceId, row.host).catch(() => {});
    },
    [devices],
  );

  // The host's card for a computer that needs its own sign-in lands here
  // with that sign-in to start, so the code is on screen when the section
  // opens (docs/forge.md, "A computer's own sign-in").
  const pending = useShellStore((s) => s.pendingDeviceForgeSignIn);
  useEffect(() => {
    if (!pending) return;
    const row = rows.find(
      (entry) => entry.deviceId === pending.deviceId && entry.host === pending.host,
    );
    if (!row || !devices.find((device) => device.deviceId === row.deviceId)?.flows) return;
    useShellStore.getState().clearPendingDeviceForgeSignIn();
    if (!row.signIn && row.inReach) signIn(row);
  }, [pending, rows, devices, signIn]);

  const stop = (flow: Flow) => {
    void window.infinitary.devices.cancelSignIn(flow.signInId).catch(() => {});
  };

  return (
    <>
      {rows.map((row) => {
        const key = `${row.deviceId}:${row.host}`;
        const flows = devices.find((device) => device.deviceId === row.deviceId)?.flows;
        const flow = flows?.find(
          (entry) => entry.target === "forge" && entry.providerId === row.host,
        );
        const starting = Boolean(flow && !flow.notice && !flow.ended);
        return (
          <div key={key}>
            <DeviceForgeRowLine
              row={row}
              starting={starting}
              open={Boolean(flow)}
              signInOff={!flows ? REMOTE_SIGN_IN_UPDATE_NOTE : undefined}
              onSignIn={() => signIn(row)}
              onSignOut={() =>
                void window.infinitary.devices.forgeSignOut(row.deviceId, row.host).catch(() => {})
              }
            />
            {!flows && <SignInNeedsUpdate />}
            {flow && (
              <DeviceSignInAside
                flow={flow}
                providerName={row.hostName}
                place={row.place}
                key={flow.signInId}
                onAnswer={() => {}}
                onStop={() => stop(flow)}
              />
            )}
            {flow && row.githubCli && row.inReach && (
              // The code's alternative, as this computer's own GitHub sign-in
              // offers it: that computer asks its own GitHub CLI, and its row
              // turns signed in once it kept the sign-in.
              <div className="fm-connect-aside" data-device-forge-cli={row.deviceId}>
                <GitHubCliLine
                  address={row.host}
                  where={row.place.where}
                  ask={() => window.infinitary.devices.forgeSignInWithCli(row.deviceId, row.host)}
                  onDone={() => stop(flow)}
                />
              </div>
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
  signInOff,
}: {
  row: DeviceForgeRow;
  /** Asked there, and no code back yet. */
  starting: boolean;
  /** Its aside is open: one sign-in at a time. */
  open: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  signInOff?: string;
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
            off={Boolean(signInOff)}
            note={signInOff}
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
