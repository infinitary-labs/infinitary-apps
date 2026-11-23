import * as m from "@shared/i18n/messages.generated";
import {
  addressAtPort,
  type RemoteLoginConfirmQuestion,
  type RemoteLoginLeaveQuestion,
  type RemoteLoginPasswordQuestion,
  remoteLoginWords,
} from "@shared/remoteLogin";
import { useEffect, useRef, useState } from "react";
import { Button, Input } from "../design";
import { focusWithRing } from "../design/focus";
import { NearbyList, PortField, sshMustBeOn } from "../devices/NearbyList";
import { useFirstMateName, useHereAs } from "../devices/useFirstMatePlace";
import type { DevicesTabViewProps } from "./devicesState";
import { type AddingMac, addingWords } from "./devicesWords";

/**
 * Adding a computer in Settings -> Devices (design skill
 * `components/devices/AddAMac`): + A computer's address form with the
 * computers nearby and the two other ways under it, the check line, the
 * password asked once, the question for a Mac another first mate uses, and
 * the row of one being added.
 */

/**
 * The link and the command, each with when to use it, under + A computer's
 * address form, and in its place on a home that adds no computer by its
 * address (a Windows PC, `DeviceAddresses.addsByAddress`).
 */
function OtherWays({
  busy,
  onMake,
  onCancelAddress,
  alone,
}: DevicesTabViewProps & { alone: boolean }) {
  // Choosing one here closes the address form, as its Cancel would, and drops a try still running.
  const instead = (what: "link" | "command") => {
    onCancelAddress();
    onMake(what);
  };
  return (
    <div className="fm-devices-other-ways" data-device-other-ways="">
      <div className="fm-devices-question">
        {alone ? m.settingsDevicesAddWays() : m.settingsDevicesAddOtherWays()}
      </div>
      <div className="fm-devices-other-way">
        <Button
          variant="secondary"
          size="sm"
          type="button"
          autoFocus={alone}
          disabled={busy === "link"}
          onClick={() => instead("link")}
        >
          {m.settingsDevicesAddByLink()}
        </Button>
        <span className="fm-devices-aside-say">{m.settingsDevicesAddByLinkWhen()}</span>
      </div>
      <div className="fm-devices-other-way">
        <Button
          variant="secondary"
          size="sm"
          type="button"
          disabled={busy === "link"}
          onClick={() => instead("command")}
        >
          {m.settingsDevicesAddByCommand()}
        </Button>
        <span className="fm-devices-aside-say">{m.settingsDevicesAddByCommandWhen()}</span>
      </div>
    </div>
  );
}

/**
 * + A computer's address form (design skill `components/devices/DevicesTab`,
 * captain's pick on INF-4926): the one thing the captain supplies, the
 * address they use with SSH. Computers nearby stand under it; picking one
 * fills the field with your user name selected, to change before Add it, and
 * ↓ in the field reaches them. Under them, the link and the command for a
 * computer that cannot turn Remote Login on, each with when to use it. A
 * worker's package update draws the same form with its own words and neither.
 */
export function AddressQuestion(props: DevicesTabViewProps) {
  // A Windows PC's first mate adds no computer by its address: only the link and the command,
  // which work from every home, as while the home has not yet said whether it does.
  if (!props.packageUpdate && (!props.addresses || props.addresses.addsByAddress === false))
    return (
      <div className="fm-devices-aside" data-device-address-question="">
        <OtherWays {...props} alone />
        <div className="fm-devices-aside-actions">
          <Button variant="ghost" size="sm" type="button" onClick={props.onCancelAddress}>
            {m.settingsDevicesCancel()}
          </Button>
        </div>
      </div>
    );
  return <AddressForm {...props} />;
}

function AddressForm(props: DevicesTabViewProps) {
  const {
    addressDraft,
    portDraft,
    addressRefusal,
    packageUpdate,
    adding,
    nearby,
    devices,
    onAddressDraft,
    onPortDraft,
    onAddAt,
    onCancelAddress,
  } = props;
  const here = useHereAs();
  const homeName = useFirstMateName();
  // The address with the port typed beside it, or null while either is not one.
  const typed = addressAtPort(addressDraft, portDraft);
  // An add of the typed address under way, said beside the field until it answers.
  const underWay = adding.find((mac) => mac.address === typed);
  const trying = underWay !== undefined;
  const form = useRef<HTMLFormElement>(null);
  const field = () => form.current?.querySelector<HTMLInputElement>("#device-remote-login");
  // The address a pick just filled in, and how much of it is the user name:
  // once the field holds it, the caret goes there with the user name selected.
  const [picked, setPicked] = useState<{ address: string; user: number } | null>(null);
  useEffect(() => {
    if (!picked) return;
    const at = form.current?.querySelector<HTMLInputElement>("#device-remote-login");
    if (at && at.value === picked.address) {
      focusWithRing(at);
      at.setSelectionRange(0, picked.user);
    }
    setPicked(null);
  }, [picked]);
  return (
    <form
      ref={form}
      className="fm-devices-aside"
      data-device-address-question=""
      onSubmit={(event) => {
        event.preventDefault();
        if (typed && !trying) onAddAt(typed);
      }}
    >
      <label className="fm-devices-question" htmlFor="device-remote-login">
        {packageUpdate ? m.settingsDevicesUpdate() : m.settingsDevicesAddressLabel()}
      </label>
      <div className="fm-devices-aside-say">
        {packageUpdate
          ? here(remoteLoginWords.packageUpdateAddress(packageUpdate))
          : m.settingsDevicesAddressSay({ sshOn: sshMustBeOn() })}
      </div>
      {!packageUpdate && (
        <div className="fm-devices-aside-say">
          {homeName
            ? m.settingsDevicesAddressKeepsThere({ name: homeName })
            : m.settingsDevicesAddressKeeps()}
        </div>
      )}
      {underWay && (
        <div
          className="fm-devices-aside-say"
          role="status"
          data-device-address-under-way={underWay.address}
        >
          {here(addingWords(underWay, underWay.name ?? underWay.address))}
        </div>
      )}
      {addressRefusal && (
        <div role="alert">
          {addressRefusal.map((line) => (
            <div
              key={line}
              className="fm-devices-aside-say"
              data-tone="warn"
              data-device-address-refusal=""
            >
              {here(line)}
            </div>
          ))}
        </div>
      )}
      <div className="fm-devices-aside-actions">
        <Input
          id="device-remote-login"
          mono
          autoFocus
          autoComplete="off"
          spellCheck={false}
          // i18n-exempt: a sample SSH address, a code sample
          placeholder="you@mini.local"
          value={addressDraft}
          onChange={(event) => onAddressDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            const first = form.current?.querySelector<HTMLElement>(
              "[data-device-nearby-mac][tabindex='0']",
            );
            if (!first) return;
            event.preventDefault();
            focusWithRing(first);
          }}
          style={{ flex: 1, minWidth: 220, width: "auto" }}
        />
        <PortField id="device-remote-login-port" value={portDraft} onChange={onPortDraft} />
        <Button type="submit" size="sm" disabled={!typed || trying}>
          {addressRefusal
            ? m.settingsDevicesTryAgain()
            : packageUpdate
              ? m.settingsDevicesUpdate()
              : m.settingsDevicesAddIt()}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onCancelAddress}>
          {m.settingsDevicesCancel()}
        </Button>
      </div>
      {packageUpdate && (
        <div className="fm-devices-aside-say">
          {here(remoteLoginWords.packageUpdateThere(packageUpdate))}
        </div>
      )}
      {!packageUpdate && (
        <NearbyList
          nearby={nearby}
          devices={devices}
          onPick={(address) => {
            onAddressDraft(address);
            setPicked({
              address,
              user: nearby.user && address.includes("@") ? nearby.user.length : 0,
            });
          }}
          onLeave={() => {
            const at = field();
            if (at) focusWithRing(at);
          }}
        />
      )}
      {!packageUpdate && <OtherWays {...props} alone={false} />}
    </form>
  );
}

/**
 * The check line, before anything is sent (design skill AddAMac, "Your yes").
 * Cancel holds the focus so Enter never says this is the Mac.
 */
export function ConfirmQuestion({
  question,
  onConfirm,
  onCancelConfirm,
}: DevicesTabViewProps & { question: RemoteLoginConfirmQuestion }) {
  const here = useHereAs();
  const [found, compare] = remoteLoginWords.confirmQuestion(question.address);
  return (
    <div className="fm-devices-aside" data-device-confirm-question={question.address}>
      <div className="fm-devices-question">{here(found)}</div>
      <div className="fm-devices-aside-say">{here(compare)}</div>
      <div className="fm-devices-check" data-device-check-line="">
        {question.line}
      </div>
      <div className="fm-devices-aside-actions">
        <Button size="sm" onClick={() => onConfirm(question)}>
          {m.settingsDevicesConfirmThis()}
        </Button>
        <Button variant="ghost" size="sm" autoFocus onClick={onCancelConfirm}>
          {m.settingsDevicesCancel()}
        </Button>
      </div>
    </div>
  );
}

/**
 * That user's password, asked once when the Mac did not let the captain's
 * key in (design skill AddAMac, "The password, once"). The field holds what
 * is typed until Add it sends it on that one call, then empties; a wrong one
 * is said above an empty field. Enter adds it, and Cancel keeps the address.
 */
export function PasswordQuestion({
  question,
  onPassword,
  onCancelPassword,
}: DevicesTabViewProps & { question: RemoteLoginPasswordQuestion }) {
  const here = useHereAs();
  const [typed, setTyped] = useState("");
  const [found, say] =
    question.for === "update"
      ? remoteLoginWords.passwordUpdateQuestion(question.address)
      : question.for === "install"
        ? remoteLoginWords.passwordInstallQuestion(question.address)
        : remoteLoginWords.passwordQuestion(question.address);
  const field = remoteLoginWords.passwordField(question.user);
  const wrong = question.wrong
    ? remoteLoginWords.refused("password-wrong", { address: question.address })
    : null;
  return (
    <form
      className="fm-devices-aside"
      data-device-password-question={question.address}
      onSubmit={(event) => {
        event.preventDefault();
        if (!typed) return;
        const password = typed;
        setTyped("");
        onPassword(question, password);
      }}
    >
      <div className="fm-devices-question">{here(found)}</div>
      <div className="fm-devices-aside-say">{here(say)}</div>
      {wrong && (
        <div role="alert">
          {wrong.map((line) => (
            <div
              key={line}
              className="fm-devices-aside-say"
              data-tone="warn"
              data-device-password-refusal=""
            >
              {here(line)}
            </div>
          ))}
        </div>
      )}
      <div className="fm-devices-aside-actions">
        <Input
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-label={field}
          placeholder={field}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          style={{ flex: 1, minWidth: 220, width: "auto" }}
        />
        <Button type="submit" size="sm" disabled={!typed}>
          {question.for === "update" ? m.settingsDevicesUpdate() : m.settingsDevicesAddIt()}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onCancelPassword}>
          {m.settingsDevicesCancel()}
        </Button>
      </div>
    </form>
  );
}

/**
 * Add it's one question for a Mac whose user runs another Firstmate's work
 * (design skill `components/devices/AddAMac`, "Another first mate's Mac"),
 * with Cancel focused so Enter never leaves it.
 */
export function LeaveQuestion({
  question,
  onLeaveAndAdd,
  onCancelLeave,
}: DevicesTabViewProps & { question: RemoteLoginLeaveQuestion }) {
  const here = useHereAs();
  const [found, ...said] = remoteLoginWords.leaveQuestion(question);
  return (
    <div className="fm-devices-aside" data-device-leave-question={question.address}>
      <div className="fm-devices-question">{here(found)}</div>
      {said.map((line) => (
        <div key={line} className="fm-devices-aside-say">
          {here(line)}
        </div>
      ))}
      <div className="fm-devices-aside-actions">
        <Button variant="danger" size="sm" onClick={() => onLeaveAndAdd(question.address)}>
          {m.settingsDevicesLeaveAndAdd()}
        </Button>
        <Button variant="ghost" size="sm" autoFocus onClick={onCancelLeave}>
          {m.settingsDevicesCancel()}
        </Button>
      </div>
    </div>
  );
}

/** A Mac being added by its address: an idle dot, and where its setup stands. */
export function AddingRow({ mac }: { mac: AddingMac }) {
  const here = useHereAs();
  return (
    <div
      className="fm-devices-row"
      data-device-adding={mac.address}
      data-copy={mac.copy?.state}
      role="status"
    >
      <span className="fm-devices-dot" />
      <span className="fm-devices-text">
        <span className="fm-devices-name">{mac.name ?? mac.address}</span>
        <span className="fm-devices-detail">
          {m.settingsDevicesAddingDetail({ address: mac.address })}
        </span>
        <span className="fm-devices-summary">
          {here(addingWords(mac, mac.name ?? mac.address))}
        </span>
      </span>
    </div>
  );
}
