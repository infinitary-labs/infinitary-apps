import { COMPUTER, HERE } from "@shared/deviceNames";
import {
  automaticStartupOf,
  automaticStartupWords,
  type DeviceView,
  deviceConnecting,
  deviceLabel,
  deviceRunsWork,
  deviceWords,
} from "@shared/devices";
import { remoteLoginWords } from "@shared/remoteLogin";
import { runsForAnotherFirstmate, sshConnectionWords } from "@shared/sshConnection";
import { useState } from "react";
import { Button, Input } from "../design";
import { sshMustBeOn } from "../devices/NearbyList";
import type { DevicesTabViewProps } from "./devicesState";
import {
  addingWords,
  deviceDetail,
  deviceState,
  deviceSummary,
  heldLine,
  removeLines,
  sshStoppedLine,
  strandedLine,
  wayBack,
} from "./devicesWords";

/**
 * One device in Settings -> Devices (design skill
 * `components/devices/DevicesTab`): its row with what it can do now, and the
 * two questions that stand in its place, Change address and Remove.
 */

export function DeviceRow({
  device,
  signIns,
  now,
  updating,
  updateCopy,
  adding,
  busy,
  onAskRemove,
  onUpdate,
  onKeep,
  onMake,
  moving,
  onTryAgain,
  onAskChangeAddress,
}: DevicesTabViewProps & { device: DeviceView }) {
  const label = deviceLabel(device);
  if (!deviceRunsWork(device.kind)) {
    const summary = deviceSummary(device, undefined);
    return (
      <div
        className="fm-devices-row"
        data-device-row={device.id}
        data-controlling={device.controlling ? "" : undefined}
      >
        <span className="fm-devices-dot" data-tone={device.inReach ? "ok" : "warn"} />
        <span className="fm-devices-text">
          <span className="fm-devices-name">{device.name}</span>
          <span className="fm-devices-detail">{deviceDetail(device, now)}</span>
          {summary && <span className="fm-devices-summary">{summary}</span>}
        </span>
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Remove ${label}`}
          onClick={() => onAskRemove(device.id)}
        >
          Remove
        </Button>
      </div>
    );
  }
  const state = deviceState(device);
  const own = signIns.find((entry) => entry.deviceId === device.id);
  const updatingHere = updating.includes(device.id);
  const copy = updateCopy?.[device.id];
  // Brought back over Remote Login: reached, then told where this Mac is now.
  const finding = adding.find((mac) => mac.deviceId === device.id);
  // Looked for at another address, to be reached there from now on.
  const moved = moving.find((each) => each.deviceId === device.id);
  const settling =
    device.removal === "bringing-work" ||
    device.removal === "cleaning-up" ||
    updatingHere ||
    finding !== undefined ||
    moved !== undefined;
  const startup = automaticStartupOf(device);
  const startupProblem = startup === "unavailable" || startup === "unknown";
  const stranded = settling ? null : strandedLine(device);
  const held = settling || startupProblem ? null : heldLine(device);
  const back = settling ? null : wayBack(device);
  const stopped = settling ? null : sshStoppedLine(device);
  // A Mac that left for another Firstmate is not coming back: Remove only.
  const left = runsForAnotherFirstmate(device.ssh);
  const other = device.otherVersion;
  return (
    <div
      className="fm-devices-row"
      data-device-row={device.id}
      data-controlling={device.controlling ? "" : undefined}
      data-removal={device.removal}
      data-other-version={other ? (other.takesWork ? "takes-work" : "no-work") : undefined}
    >
      <span
        className="fm-devices-dot"
        data-tone={
          device.inReach && other?.takesWork !== false
            ? "ok"
            : deviceConnecting(device)
              ? "idle"
              : "warn"
        }
      />
      <span className="fm-devices-text">
        <span className="fm-devices-name">{label}</span>
        <span className="fm-devices-detail">{deviceDetail(device, now)}</span>
        <span className="fm-devices-summary" role={finding || moved ? "status" : undefined}>
          {finding
            ? addingWords(finding, label)
            : moved
              ? remoteLoginWords.reachingRow(moved.address)
              : updatingHere
                ? copy?.download
                  ? remoteLoginWords.downloading(label, copy.download.received, copy.download.total)
                  : copy?.state === "sending"
                    ? remoteLoginWords.sendingRow(label, copy.sent ?? 0)
                    : copy?.state === "starting"
                      ? remoteLoginWords.startingRow(label)
                      : remoteLoginWords.updatingRow(device)
                : deviceSummary(device, own)}
        </span>
        {startupProblem && !settling && (
          <span className="fm-devices-summary" data-device-startup="">
            {startup === "unavailable"
              ? automaticStartupWords.guidance
              : automaticStartupWords.unchecked}
          </span>
        )}
        {stranded && (
          <span className="fm-devices-summary" data-device-stranded="">
            {stranded}
          </span>
        )}
        {held && (
          <span className="fm-devices-summary" data-device-held="">
            {held}
          </span>
        )}
        {stopped && (
          <span className="fm-devices-version" data-tone="warn" data-device-ssh-stopped="">
            {stopped}
          </span>
        )}
        {other && !updatingHere && (
          <span className="fm-devices-version" data-tone={other.takesWork ? undefined : "warn"}>
            {deviceWords.otherVersion(other)}
          </span>
        )}
      </span>
      {!settling && (
        <span className="fm-devices-state" data-tone={state.tone}>
          {state.text}
        </span>
      )}
      {back && (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy === "link"}
          onClick={() => onMake(back.does)}
        >
          {back.label}
        </Button>
      )}
      {held && (
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Add ${label} by its address`}
          onClick={() => onAskChangeAddress(device.id)}
        >
          Add it by its address
        </Button>
      )}
      {stopped && !left && (
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Try again to reach ${label}`}
          onClick={() => onTryAgain(device.id)}
        >
          Try again
        </Button>
      )}
      {device.ssh && device.remoteLogin && !settling && !left && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Change the address of ${label}`}
          onClick={() => onAskChangeAddress(device.id)}
        >
          Change address
        </Button>
      )}
      {other && !settling && device.removal !== "when-back" && (
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Update ${label}`}
          disabled={busy === "link"}
          onClick={() => onUpdate(device)}
        >
          Update
        </Button>
      )}
      {device.removal === "when-back" ? (
        <Button variant="ghost" size="sm" onClick={() => onKeep(device.id)}>
          Keep it
        </Button>
      ) : settling ? null : (
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Remove ${label}`}
          onClick={() => onAskRemove(device.id)}
        >
          Remove
        </Button>
      )}
    </div>
  );
}

/**
 * Change address's one question, in place of the row (design skill
 * `components/devices/DevicesTab`, "Reached over your SSH"): the address
 * the captain reaches that Mac at with SSH now, which this Mac checks is the
 * same computer before it uses it. For a Mac a command added that macOS
 * holds on the local network it is Add it by its address ("Held on the local
 * network"): the address the captain reaches it at with SSH, as the user it
 * runs work as, where this Mac finds it again as the same computer and
 * reaches it over its own SSH connection from then on.
 */
export function AddressChange({
  device,
  onChangeAddress,
  onAddAt,
  onAskChangeAddress,
}: DevicesTabViewProps & { device: DeviceView }) {
  const adding = device.heldOnLocalNetwork === true;
  const [address, setAddress] = useState(device.remoteLogin ?? "");
  const typed = address.trim();
  const unchanged = !adding && typed === device.remoteLogin;
  const id = `device-address-${device.id}`;
  return (
    <form
      className="fm-devices-aside"
      data-device-address-change={device.id}
      data-adding={adding ? "" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (!typed || unchanged) return;
        if (adding) onAddAt(typed);
        else onChangeAddress(device.id, typed);
      }}
    >
      <label className="fm-devices-question" htmlFor={id}>
        {sshConnectionWords.changeAddress(device)}
      </label>
      <div className="fm-devices-aside-say">
        {!adding
          ? `The address you use with SSH for it now. ${HERE.This} checks it is the same ${COMPUTER.one} first.`
          : device.user
            ? `The address you use with SSH for it, as ${device.user}. ${sshMustBeOn()}`
            : `The address you use with SSH for it. ${sshMustBeOn()}`}
      </div>
      <div className="fm-devices-aside-actions">
        <Input
          id={id}
          mono
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder={adding ? `${device.user ?? "you"}@mini.local` : "you@mini.local"}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          style={{ flex: 1, minWidth: 220, width: "auto" }}
        />
        <Button type="submit" size="sm" disabled={!typed || unchanged}>
          {adding ? "Add it" : "Change it"}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={() => onAskChangeAddress(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Remove's one question, in place, with Keep it focused so Enter never
 * removes: a Mac that controls this Firstmate is cut off at once; a
 * computer that runs work brings its unmerged work here first; one out of
 * reach asks whether to wait for it or remove it now.
 */
export function RemoveQuestion({
  device,
  busy,
  onAskRemove,
  onRemove,
}: DevicesTabViewProps & { device: DeviceView }) {
  const keep = (
    <Button
      variant="ghost"
      size="sm"
      autoFocus
      disabled={busy === "remove"}
      onClick={() => onAskRemove(null)}
    >
      Keep it
    </Button>
  );
  const lines = removeLines(device);
  return (
    <div className="fm-devices-row" data-device-removing={device.id}>
      <span className="fm-devices-dot" />
      <span className="fm-devices-text">
        {lines.map((line) => (
          <span key={line} className="fm-devices-question">
            {line}
          </span>
        ))}
      </span>
      {keep}
      {deviceRunsWork(device.kind) && !device.inReach ? (
        <>
          {/* One that runs work for another Firstmate now is not coming back. */}
          {!runsForAnotherFirstmate(device.ssh) && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy === "remove"}
              onClick={() => onRemove(device.id, "when-back")}
            >
              {device.otherVersion ? "Remove once it is updated" : "Remove when it is back"}
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            disabled={busy === "remove"}
            onClick={() => onRemove(device.id, "now")}
          >
            Remove now
          </Button>
        </>
      ) : (
        <Button
          variant="danger"
          size="sm"
          pending={busy === "remove"}
          pendingLabel="Removing..."
          onClick={() => onRemove(device.id)}
        >
          Remove
        </Button>
      )}
    </div>
  );
}
