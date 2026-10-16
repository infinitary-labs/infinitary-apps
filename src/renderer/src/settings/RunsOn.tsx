import { AUTOMATIC_COMPUTER, AUTOMATIC_WORD } from "@shared/placement";
import { type RepoView, runsHereOnly } from "@shared/repos";
import { type DeviceSignIns, devicePlace, signInPlace } from "@shared/signIns";
import { useEffect, useState } from "react";
import "./devices.css";
import { COMPUTER, HERE } from "@shared/deviceNames";

/**
 * A project's Runs on (design skill `components/devices/RunsOn`;
 * docs/helper.md, "Runs on"): where its next task starts, this Mac or a
 * computer that runs work. Settings -> Projects draws it only on the Mac
 * where Firstmate lives, once such a computer is on the list; with none, a
 * project's row is as it was.
 */

/**
 * The computers that run work, as the home last heard each, or null on a
 * Mac that controls another. Follows every change the home pushes.
 */
export function useWorkComputers(): DeviceSignIns[] | null {
  const [computers, setComputers] = useState<DeviceSignIns[] | null>(null);
  useEffect(() => {
    let live = true;
    let shown = false;
    void window.infinitary.devices
      .shown()
      .then(({ shown: offered }) => {
        if (!live || !offered) return;
        shown = true;
        void window.infinitary.devices.signIns().then((next) => live && setComputers(next));
      })
      .catch(() => {});
    const off = window.infinitary.devices.onSignIns((next) => {
      if (shown) setComputers(next);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return computers;
}

/** Why a computer cannot take work now, after a middle dot, or nothing. */
function notNow(computer: DeviceSignIns): string {
  if (!computer.inReach) return " · out of reach";
  if (computer.signIns && computer.signIns.accounts.length === 0) return " · no sign-ins yet";
  return "";
}

/** How the row and its badge place a project's computer: "on Mac mini", "as Builder". */
export function runsOnWhere(repo: RepoView, computers: readonly DeviceSignIns[]): string | null {
  if (!repo.runsOn) return null;
  if (repo.runsOn === AUTOMATIC_COMPUTER) return "automatically";
  return devicePlace(
    computers.map((computer) => ({ ...computer, id: computer.deviceId })),
    repo.runsOn,
  ).where;
}

/** The control in the Runs on row: one select, or "This Mac" as text where only this Mac can run it. */
export function RunsOnControl({
  repo,
  computers,
  onChoose,
}: {
  repo: RepoView;
  computers: readonly DeviceSignIns[];
  onChoose: (deviceId: string | null) => void;
}) {
  if (runsHereOnly(repo))
    return <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>{HERE.This}</span>;
  const macs = computers.filter((computer) => !computer.onThisMac);
  const users = computers.filter((computer) => computer.onThisMac);
  const gone =
    repo.runsOn &&
    repo.runsOn !== AUTOMATIC_COMPUTER &&
    !computers.some((computer) => computer.deviceId === repo.runsOn);
  const option = (computer: DeviceSignIns) => (
    <option key={computer.deviceId} value={computer.deviceId}>
      {signInPlace(computer).label}
      {notNow(computer)}
    </option>
  );
  return (
    <select
      aria-label="Runs on"
      className="fm-runs-on"
      value={repo.runsOn ?? ""}
      onChange={(event) => onChoose(event.target.value || null)}
    >
      <option value={AUTOMATIC_COMPUTER}>{AUTOMATIC_WORD}</option>
      <option value="">{HERE.This}</option>
      {macs.length > 0 && <optgroup label={`Your ${COMPUTER.many}`}>{macs.map(option)}</optgroup>}
      {users.length > 0 && <optgroup label="As another user">{users.map(option)}</optgroup>}
      {gone && repo.runsOn && (
        <option value={repo.runsOn}>The other {COMPUTER.one} · removed</option>
      )}
    </select>
  );
}

/** The row's description, in the design's words. */
export function runsOnDescription(repo: RepoView): string {
  if (repo.runsOn === AUTOMATIC_COMPUTER)
    return "Choose a compatible computer with room for each new task. A started task stays there.";
  return (
    runsHereOnly(repo) ??
    `Where its tasks run. While that ${COMPUTER.one} is out of reach they wait, and never run here instead.`
  );
}
