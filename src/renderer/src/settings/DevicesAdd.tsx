import { COMPUTER } from "@shared/deviceNames";
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
import type { DevicesTabViewProps } from "./devicesState";
import { type AddingMac, addingWords } from "./devicesWords";

/**
 * Adding a computer in Settings -> Devices (design skill
 * `components/devices/AddAMac`): + A computer's question, the address with
 * Macs nearby under it, the check line, the password asked once, the
 * question for a Mac another first mate uses, and the row of one being added.
 */

/**
 * + A Mac's question: a link for a Mac its person sits at, a command for one
 * with no screen, or its address, to set it up from here over Remote Login.
 */
export function AddChooser({ busy, onMake, onCancelChoose, onAskAddress }: DevicesTabViewProps) {
  return (
    <div className="fm-devices-aside" data-device-chooser="">
      <div className="fm-devices-question">How do you want to add it?</div>
      <div className="fm-devices-aside-say">
        Each way adds the same kind of {COMPUTER.one}. Pick the one that suits it.
      </div>
      <div className="fm-devices-aside-actions">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy === "link"}
          onClick={() => onMake("link")}
        >
          Paste a link into Infinitary there
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy === "link"}
          onClick={() => onMake("command")}
        >
          Run a command there
        </Button>
        <Button variant="secondary" size="sm" disabled={busy === "link"} onClick={onAskAddress}>
          By its address
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancelChoose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * By its address (design skill `components/devices/DevicesTab`): the one
 * thing the captain supplies, the address he uses with SSH. Macs nearby
 * stand under it; picking one fills the field with your user name selected,
 * to change before Add it, and ↓ in the field reaches them.
 */
export function AddressQuestion({
  addressDraft,
  portDraft,
  addressRefusal,
  adding,
  nearby,
  devices,
  onAddressDraft,
  onPortDraft,
  onAddAt,
  onCancelAddress,
}: DevicesTabViewProps) {
  // The address with the port typed beside it, or null while either is not one.
  const typed = addressAtPort(addressDraft, portDraft);
  const trying = adding.some((mac) => mac.address === typed);
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
        The other {COMPUTER.one}'s address
      </label>
      <div className="fm-devices-aside-say">The one you use with SSH. {sshMustBeOn()}</div>
      {addressRefusal && (
        <div role="alert">
          {addressRefusal.map((line) => (
            <div
              key={line}
              className="fm-devices-aside-say"
              data-tone="warn"
              data-device-address-refusal=""
            >
              {line}
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
          {addressRefusal ? "Try again" : "Add it"}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onCancelAddress}>
          Cancel
        </Button>
      </div>
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
  const [found, compare] = remoteLoginWords.confirmQuestion(question.address);
  return (
    <div className="fm-devices-aside" data-device-confirm-question={question.address}>
      <div className="fm-devices-question">{found}</div>
      <div className="fm-devices-aside-say">{compare}</div>
      <div className="fm-devices-check" data-device-check-line="">
        {question.line}
      </div>
      <div className="fm-devices-aside-actions">
        <Button size="sm" onClick={() => onConfirm(question)}>
          This is the {COMPUTER.one}
        </Button>
        <Button variant="ghost" size="sm" autoFocus onClick={onCancelConfirm}>
          Cancel
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
      <div className="fm-devices-question">{found}</div>
      <div className="fm-devices-aside-say">{say}</div>
      {wrong && (
        <div role="alert">
          {wrong.map((line) => (
            <div
              key={line}
              className="fm-devices-aside-say"
              data-tone="warn"
              data-device-password-refusal=""
            >
              {line}
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
          {question.for === "update" ? "Update" : "Add it"}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onCancelPassword}>
          Cancel
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
  const [found, ...said] = remoteLoginWords.leaveQuestion(question);
  return (
    <div className="fm-devices-aside" data-device-leave-question={question.address}>
      <div className="fm-devices-question">{found}</div>
      {said.map((line) => (
        <div key={line} className="fm-devices-aside-say">
          {line}
        </div>
      ))}
      <div className="fm-devices-aside-actions">
        <Button variant="danger" size="sm" onClick={() => onLeaveAndAdd(question.address)}>
          Leave it and add
        </Button>
        <Button variant="ghost" size="sm" autoFocus onClick={onCancelLeave}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A Mac being added by its address: an idle dot, and where its setup stands. */
export function AddingRow({ mac }: { mac: AddingMac }) {
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
          a {COMPUTER.one} · {mac.address}
        </span>
        <span className="fm-devices-summary">{addingWords(mac, mac.name ?? mac.address)}</span>
      </span>
    </div>
  );
}
