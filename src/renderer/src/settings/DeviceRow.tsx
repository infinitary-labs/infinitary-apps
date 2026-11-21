import { offersAddressChange, offersHomeMove, offersStandby } from "@shared/deviceActs";
import { HERE } from "@shared/deviceNames";
import {
  appBehind,
  approvesSecretUses,
  automaticStartupOf,
  automaticStartupWords,
  type DeviceView,
  deviceConnecting,
  deviceLabel,
  deviceRunsWork,
  deviceWords,
  installedThere,
} from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { remoteLoginWords } from "@shared/remoteLogin";
import { RUNS_ON_THIS_MAC } from "@shared/repos";
import { runsForAnotherFirstmate, sshConnectionWords } from "@shared/sshConnection";
import type { StandbyView } from "@shared/standby";
import { Fragment, useState } from "react";
import { Button, GroupedPills, Input } from "../design";
import { sshMustBeOn } from "../devices/NearbyList";
import { useHereAs } from "../devices/useFirstMatePlace";
import type { CarryAsk, DevicesTabViewProps } from "./devicesState";
import {
  addingWords,
  deviceDetail,
  deviceState,
  deviceSummary,
  heldLine,
  offersFixWork,
  removeLines,
  sshStoppedLine,
  strandedLine,
  wayBack,
  workSetupLine,
} from "./devicesWords";
import { PhoneApprovals } from "./PhoneApprovals";
import { StandbyLine } from "./Standby";

/**
 * The version each copy on a device runs (design skill
 * `components/devices/DevicesTab`, "Each copy's version"): its app's, in
 * `--warn` and marked while it is behind this computer's, and its work's
 * on this computer's version.
 */
function CopyVersions({ device }: { device: DeviceView }) {
  const here = useHereAs();
  const words = deviceWords.copyVersions(device);
  if (!words) return null;
  const behind = device.appVersion !== undefined && appBehind(device, device.appVersion);
  return (
    <span
      className="fm-devices-version"
      data-device-copy-versions=""
      data-behind={behind ? "" : undefined}
      data-tone={behind ? "warn" : undefined}
    >
      {here(words)}
    </span>
  );
}

/**
 * One device in Settings -> Devices (design skill
 * `components/devices/DevicesTab`): its row with what it can do now, and the
 * two questions that stand in its place, Change address and Remove.
 */

export function DeviceRow({
  device,
  devices,
  signIns,
  now,
  updating,
  updateCopy,
  adding,
  busy,
  onAskRemove,
  onUpdate,
  onKeep,
  onAskCarry,
  onMake,
  moving,
  onTryAgain,
  onFixWork,
  onAskChangeAddress,
  onAskMoveHome,
  standby,
  onKeepCopy,
  onAskStandbyReady,
}: DevicesTabViewProps & {
  device: DeviceView;
  /** Opens the Ready list for moving the first mate there; absent in a window of another computer. */
  onAskMoveHome?: (deviceId: string) => void;
  /** Where its copy of the first mate stands; undefined while it keeps none. */
  standby?: StandbyView | undefined;
  /** Keep a copy here; absent where copies cannot be kept. */
  onKeepCopy?: (deviceId: string) => void;
  /** Opens its Ready to take over list. */
  onAskStandbyReady?: (deviceId: string) => void;
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
          <CopyVersions device={device} />
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
    device.carrying !== undefined ||
    updatingHere ||
    finding !== undefined ||
    moved !== undefined;
  const startup = automaticStartupOf(device);
  const startupProblem = startup === "unavailable" || startup === "unknown";
  const stranded = settling ? null : strandedLine(device);
  const held = settling || startupProblem ? null : heldLine(device);
  const working = settling ? null : workSetupLine(device);
  const fix = !settling && onFixWork !== undefined && offersFixWork(device);
  const back = settling ? null : wayBack(device);
  const stopped = settling ? null : sshStoppedLine(device);
  // A Mac that left for another Firstmate is not coming back: Remove only.
  const left = runsForAnotherFirstmate(device.ssh);
  // Joined again under a new key: the earlier entry out of reach, and what it holds.
  const earlier =
    settling || !device.inReach
      ? undefined
      : devices.find((each) => device.earlier?.includes(each.id));
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
            : deviceConnecting(device) || device.ssh?.state === "reconnecting"
              ? "idle"
              : "warn"
        }
      />
      <span className="fm-devices-text">
        <span className="fm-devices-name">{label}</span>
        <span className="fm-devices-detail">
          <DetailParts text={here(deviceDetail(device, now))} />
        </span>
        <span className="fm-devices-summary" role={finding || moved ? "status" : undefined}>
          {here(
            finding
              ? addingWords(finding, label)
              : moved
                ? remoteLoginWords.reachingRow(moved.address)
                : device.carrying
                  ? m.settingsDevicesCarrying({ to: carryName(devices, device.carrying) })
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
        {earlier && (
          <span className="fm-devices-summary" data-device-earlier={earlier.id}>
            {earlier.carriesOn
              ? m.settingsDevicesCarryEarlier({ count: earlier.carriesOn })
              : m.settingsDevicesCarryEarlierProjects()}
          </span>
        )}
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
        {working && (
          <span
            className="fm-devices-summary"
            data-device-work-setup={device.workSetup?.reason ?? device.workSetup?.state}
          >
            {here(working)}
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
            {here(deviceWords.otherVersion(other, installedThere(device)))}
          </span>
        )}
        {!updatingHere && <CopyVersions device={device} />}
        {standby && <StandbyLine view={standby} now={now} />}
        {approvesSecretUses(device) && <PhoneApprovals paired={device.id} name={label} />}
      </span>
      {!settling && (
        <span className="fm-devices-state" data-tone={state.tone}>
          {state.text}
        </span>
      )}
      {earlier && onAskCarry && (
        <Button
          variant="secondary"
          size="sm"
          aria-label={m.settingsDevicesCarryHereNamed({ device: label })}
          data-device-carry-here={earlier.id}
          onClick={() => onAskCarry({ row: device.id, from: earlier.id, to: device.id })}
        >
          {m.settingsDevicesCarryHere()}
        </Button>
      )}
      {device.carriesOn && !settling && onAskCarry && (
        <Button
          variant="secondary"
          size="sm"
          aria-label={m.settingsDevicesCarryToNamed({ device: label })}
          data-device-carry-to={device.id}
          onClick={() => onAskCarry({ row: device.id, from: device.id })}
        >
          {m.settingsDevicesCarryTo()}
        </Button>
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
      {fix && (
        <Button
          variant="secondary"
          size="sm"
          aria-label={m.settingsDevicesFixItNamed({ device: label })}
          data-device-fix-work={device.id}
          onClick={() => onFixWork?.(device.id)}
        >
          {m.settingsDevicesFixIt()}
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
      {offersAddressChange(device, settling) && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={m.settingsDevicesChangeAddressNamed({ device: label })}
          onClick={() => onAskChangeAddress(device.id)}
        >
          {m.settingsDevicesChangeAddress()}
        </Button>
      )}
      {other && !settling && device.removal !== "when-back" && !installedThere(device) && (
        <Button
          variant="secondary"
          size="sm"
          aria-label={
            other.than === "newer"
              ? m.settingsDevicesUpdateOlderNamed({ device: label })
              : m.settingsDevicesUpdateNamed({ device: label })
          }
          disabled={busy === "link"}
          onClick={() => onUpdate(device)}
        >
          {other.than === "newer" ? m.settingsDevicesUpdateOlder() : m.settingsDevicesUpdate()}
        </Button>
      )}
      {onAskMoveHome && offersHomeMove(device, settling) && (
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
      {standby && onAskStandbyReady ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={m.settingsDevicesStandbyReadyNamed({ device: label })}
          data-standby-ask={device.id}
          onClick={() => onAskStandbyReady(device.id)}
        >
          {m.settingsDevicesStandbyReady()}
        </Button>
      ) : (
        onKeepCopy &&
        offersStandby(device, standby !== undefined) && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={m.settingsDevicesStandbyKeepNamed({ device: label })}
            data-standby-keep={device.id}
            onClick={() => onKeepCopy(device.id)}
          >
            {m.settingsDevicesStandbyKeep()}
          </Button>
        )
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

/** The name a carry's destination goes by: a computer on the list, or this one. */
function carryName(devices: readonly DeviceView[], id: string): string {
  const device = devices.find((each) => each.id === id);
  return device ? deviceLabel(device) : HERE.this;
}

/**
 * Carry its tasks on's one question, in place of the row it was asked
 * from (docs/devices.md, "Joined again"), with Cancel focused so Enter
 * never moves anything: where the tasks of a computer out of reach
 * continue, from what this computer holds, what stays behind on it, and
 * that it then comes off the list. Asked from the computer that joined
 * again, the destination is that one; asked from the computer out of
 * reach, the captain picks one in reach, or this computer.
 */
export function CarryQuestion({
  ask,
  devices,
  busy,
  onAskCarry,
  onCarry,
}: DevicesTabViewProps & { ask: CarryAsk }) {
  const here = useHereAs();
  const [picked, setPicked] = useState(ask.to ?? "");
  const from = devices.find((each) => each.id === ask.from);
  if (!from) return null;
  const choices = ask.to
    ? []
    : [
        ...devices
          .filter(
            (each) =>
              each.id !== from.id &&
              deviceRunsWork(each.kind) &&
              each.inReach === true &&
              each.removal === undefined &&
              each.carrying === undefined,
          )
          .map((each) => ({ value: each.id, label: deviceLabel(each) })),
        { value: RUNS_ON_THIS_MAC, label: here(HERE.This) },
      ];
  const to = picked ? here(carryName(devices, picked)) : "";
  const fromName = deviceLabel(from);
  // Only tasks that move: a review follows its builder, and Remove now stops it.
  const count = from.carriesOn ?? 0;
  return (
    <div className="fm-devices-row" data-device-carrying={ask.row}>
      <span className="fm-devices-dot" />
      <span className="fm-devices-text">
        {!ask.to && (
          <span className="fm-devices-question" id={`carry-pick-${from.id}`}>
            {m.settingsDevicesCarryPick({ device: fromName })}
          </span>
        )}
        {!ask.to && (
          <span className="fm-devices-aside-actions" data-device-carry-pick="">
            <GroupedPills
              name={m.settingsDevicesCarryPick({ device: fromName })}
              htmlName={`carry-${from.id}`}
              value={picked}
              options={choices}
              onChange={setPicked}
            />
          </span>
        )}
        {to && (
          <span className="fm-devices-question" data-device-carry-ask="">
            {count > 0
              ? here(m.settingsDevicesCarryAsk({ count, to }))
              : m.settingsDevicesCarryAskNone()}
          </span>
        )}
        {to && count > 0 && (
          <span className="fm-devices-question">
            {m.settingsDevicesCarryLeft({ from: fromName })}
          </span>
        )}
        {to && (
          <span className="fm-devices-question">
            {m.settingsDevicesCarryThen({ from: fromName, to })}
          </span>
        )}
      </span>
      <Button
        variant="ghost"
        size="sm"
        autoFocus
        disabled={busy === "carry"}
        onClick={() => onAskCarry?.(null)}
      >
        {m.settingsDevicesCancel()}
      </Button>
      <Button
        size="sm"
        disabled={!picked || busy === "carry"}
        data-device-carry-confirm=""
        onClick={() => picked && onCarry?.(from.id, picked)}
      >
        {m.settingsDevicesCarryConfirm()}
      </Button>
    </div>
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

/**
 * A row's detail line, each part kept whole where it fits: a narrow row,
 * its actions beside it, wraps between parts, never inside "seen just now";
 * only a part wider than the whole line wraps inside itself.
 */
function DetailParts({ text }: { text: string }) {
  const parts = text.split(" · ");
  return (
    <>
      {parts.map((part, index) => {
        const last = index === parts.length - 1;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line, in their order.
          <Fragment key={index}>
            <span className="fm-devices-detail-part">{last ? part : `${part} ·`}</span>
            {last ? "" : " "}
          </Fragment>
        );
      })}
    </>
  );
}
