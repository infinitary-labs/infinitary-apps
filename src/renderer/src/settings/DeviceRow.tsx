import {
  approvesSecretUses,
  automaticStartupOf,
  automaticStartupWords,
  type DeviceView,
  deviceConnecting,
  deviceLabel,
  deviceRunsWork,
  deviceWords,
} from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { remoteLoginWords } from "@shared/remoteLogin";
import { runsForAnotherFirstmate, sshConnectionWords } from "@shared/sshConnection";
import { useState } from "react";
import { Button, Input } from "../design";
import { sshMustBeOn } from "../devices/NearbyList";
import { useHereAs } from "../devices/useFirstMatePlace";
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
import { offersHomeMove } from "./HomeMove";
import { PhoneApprovals } from "./PhoneApprovals";

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
  onAskMoveHome,
}: DevicesTabViewProps & {
  device: DeviceView;
  /** Opens the Ready list for moving the first mate there; absent in a window of another computer. */
  onAskMoveHome?: (deviceId: string) => void;
}) {
  const here = useHereAs();
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
          <span className="fm-devices-detail">{here(deviceDetail(device, now))}</span>
          {summary && <span className="fm-devices-summary">{summary}</span>}
          {approvesSecretUses(device) && <PhoneApprovals paired={device.id} name={device.name} />}
        </span>
        <Button
          variant="secondary"
          size="sm"
          aria-label={m.settingsDevicesRemoveNamed({ device: label })}
          onClick={() => onAskRemove(device.id)}
        >
          {m.settingsDevicesRemoveButton()}
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
        <span className="fm-devices-detail">{here(deviceDetail(device, now))}</span>
        <span className="fm-devices-summary" role={finding || moved ? "status" : undefined}>
          {here(
            finding
              ? addingWords(finding, label)
              : moved
                ? remoteLoginWords.reachingRow(moved.address)
                : updatingHere
                  ? copy?.download
                    ? remoteLoginWords.downloading(
                        label,
                        copy.download.received,
                        copy.download.total,
                      )
                    : copy?.state === "sending"
                      ? remoteLoginWords.sendingRow(label, copy.sent ?? 0)
                      : copy?.state === "starting"
                        ? remoteLoginWords.startingRow(label)
                        : remoteLoginWords.updatingRow(device)
                  : deviceSummary(device, own),
          )}
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
            {here(stranded)}
          </span>
        )}
        {held && (
          <span className="fm-devices-summary" data-device-held="">
            {here(held)}
          </span>
        )}
        {stopped && (
          <span className="fm-devices-version" data-tone="warn" data-device-ssh-stopped="">
            {here(stopped)}
          </span>
        )}
        {other && !updatingHere && (
          <span className="fm-devices-version" data-tone={other.takesWork ? undefined : "warn"}>
            {here(deviceWords.otherVersion(other))}
          </span>
        )}
        {approvesSecretUses(device) && <PhoneApprovals paired={device.id} name={label} />}
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
          aria-label={m.settingsDevicesAddByAddressNamed({ device: label })}
          onClick={() => onAskChangeAddress(device.id)}
        >
          {m.settingsDevicesAddByAddress()}
        </Button>
      )}
      {stopped && !left && (
        <Button
          variant="secondary"
          size="sm"
          aria-label={m.settingsDevicesTryAgainNamed({ device: label })}
          onClick={() => onTryAgain(device.id)}
        >
          {m.settingsDevicesTryAgain()}
        </Button>
      )}
      {device.ssh && device.remoteLogin && !settling && !left && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={m.settingsDevicesChangeAddressNamed({ device: label })}
          onClick={() => onAskChangeAddress(device.id)}
        >
          {m.settingsDevicesChangeAddress()}
        </Button>
      )}
      {other && !settling && device.removal !== "when-back" && (
        <Button
          variant="secondary"
          size="sm"
          aria-label={m.settingsDevicesUpdateNamed({ device: label })}
          disabled={busy === "link"}
          onClick={() => onUpdate(device)}
        >
          {m.settingsDevicesUpdate()}
        </Button>
      )}
      {onAskMoveHome && !left && offersHomeMove(device, settling) && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={m.settingsDevicesMoveHereNamed({ device: label })}
          data-home-move-ask={device.id}
          onClick={() => onAskMoveHome(device.id)}
        >
          {m.settingsDevicesMoveHere()}
        </Button>
      )}
      {device.removal === "when-back" ? (
        <Button variant="ghost" size="sm" onClick={() => onKeep(device.id)}>
          {m.settingsDevicesKeepIt()}
        </Button>
      ) : settling ? null : (
        <Button
          variant="secondary"
          size="sm"
          aria-label={m.settingsDevicesRemoveNamed({ device: label })}
          onClick={() => onAskRemove(device.id)}
        >
          {m.settingsDevicesRemoveButton()}
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
  const here = useHereAs();
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
        {here(sshConnectionWords.changeAddress(device))}
      </label>
      <div className="fm-devices-aside-say">
        {!adding
          ? here(m.settingsDevicesAddressChangeSay())
          : device.user
            ? m.settingsDevicesAddressAddSayAs({ user: device.user, sshOn: sshMustBeOn() })
            : m.settingsDevicesAddressAddSay({ sshOn: sshMustBeOn() })}
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
          {adding ? m.settingsDevicesAddIt() : m.settingsDevicesAddressChange()}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={() => onAskChangeAddress(null)}>
          {m.settingsDevicesCancel()}
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
  const here = useHereAs();
  const keep = (
    <Button
      variant="ghost"
      size="sm"
      autoFocus
      disabled={busy === "remove"}
      onClick={() => onAskRemove(null)}
    >
      {m.settingsDevicesKeepIt()}
    </Button>
  );
  const lines = removeLines(device).map(here);
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
              {device.otherVersion
                ? m.settingsDevicesRemoveOnceUpdated()
                : m.settingsDevicesRemoveWhenBack()}
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            disabled={busy === "remove"}
            onClick={() => onRemove(device.id, "now")}
          >
            {m.settingsDevicesRemoveNow()}
          </Button>
        </>
      ) : (
        <Button
          variant="danger"
          size="sm"
          pending={busy === "remove"}
          pendingLabel={m.settingsDevicesRemoving()}
          onClick={() => onRemove(device.id)}
        >
          {m.settingsDevicesRemoveButton()}
        </Button>
      )}
    </div>
  );
}
