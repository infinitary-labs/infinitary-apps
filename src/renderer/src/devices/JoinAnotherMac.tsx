import {
  type JoinOutcome,
  linkNamesPrivateToo,
  parsePairingLink,
  splitDialAddress,
} from "@shared/devices";
import {
  computerOf,
  type JoinAtAnswer,
  type JoinAtOptions,
  type JoinAtRefusal,
  joinAtRefusalWords,
  type SetUpHere,
} from "@shared/joinByAddress";
import { NEARBY_OFF, NEARBY_RENEW_MS, type NearbyMacsView } from "@shared/nearbyMacs";
import {
  addressAtPort,
  addressParts,
  type RemoteLoginPasswordQuestion,
  remoteLoginWords,
} from "@shared/remoteLogin";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useShellStore } from "../app/store";
import { Button, Input, MicroLabel, StatusDot } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { focusWithRing } from "../design/focus";
import { useCopied } from "../settings/DevicesLinks";
import { SettingError } from "../settings/settingRows";
import { NearbyList, PortField, sshMustBeOn } from "./NearbyList";
import { JOIN_CONFIRM_WORDS, JOIN_RUNS_WORK, joinRefusalWords } from "./viewWords";
import "./joinAnotherMac.css";
import "../accounts/connectChips.css";
import "../settings/devices.css";
import { COMPUTER, HERE } from "@shared/deviceNames";
import * as m from "@shared/i18n/messages.generated";

/**
 * Joining Firstmate on another Mac from this app's first launch (design
 * skill `components/devices/JoinAnotherMac`, docs/view.md): the chips under
 * the provider chips - Set up from your first mate's computer first, where
 * this computer can be added by its address, then Paste its link and Join
 * by its address - and the aside each opens. Set up from your first mate's
 * computer: this computer's address to type there, and the wait until that
 * computer adds this one. Paste its link: paste the
 * link, confirm the address it names, reach that Mac, or say why this Mac
 * did not join. A link joins only by being pasted here, and only after the
 * person confirms; it lives in this component's memory and nowhere else.
 * Join by its address: type the account and computer, with an optional
 * port, or pick a computer nearby; this computer signs in there with the
 * person's own SSH, checking its key line first, and the Infinitary open
 * there makes a link the main process keeps. The same confirm question
 * follows, and the join is the pasted link's.
 */

type Step =
  | { step: "closed" }
  | { step: "set-up" }
  | { step: "paste"; notALink: boolean }
  | { step: "address"; refused?: JoinAtRefusal; at?: string }
  | { step: "key"; address: string; line: string }
  | { step: "password"; question: RemoteLoginPasswordQuestion }
  | { step: "signing-in"; address: string; lettingIn?: boolean }
  | {
      step: "confirm";
      address: string;
      runsWork: boolean;
      alsoPrivate?: boolean;
      byAddress?: boolean;
    }
  | { step: "reaching"; address: string }
  | {
      step: "refused";
      refused: Exclude<JoinOutcome, { ok: true }>["refused"];
      address: string | null;
      byAddress?: boolean;
    };

/** What the window may ask the shell for Join by its address; the app's own by default. */
export type JoinByAddress = {
  joinAt: (address: string, options?: JoinAtOptions) => Promise<JoinAtAnswer>;
  joinHeld: (choice: "join" | "forget") => Promise<JoinOutcome>;
};

const plusIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M5 12h14M12 5v14" />
  </svg>
);

/** The address a link names, as it names it: what the confirm question shows. */
function linkAddress(text: string): { address: string; kind: string; alsoPrivate: boolean } | null {
  try {
    const link = parsePairingLink(text);
    return {
      address: splitDialAddress(link.at)?.host ?? link.at,
      kind: link.kind,
      alsoPrivate: linkNamesPrivateToo(link),
    };
  } catch {
    return null;
  }
}

/** How often the first launch asks whether its first mate's computer added it (docs/view.md, "Joining"). */
const FOLLOW_EVERY_MS = 5_000;
/** How often the open aside reads this computer again, so it follows its addresses and Remote Login. */
const SET_UP_RENEW_MS = 5_000;

/**
 * Following along at first launch (docs/view.md, "Joining"): while this
 * group is up, the window asks the shell now and then whether its first
 * mate's computer added this one by its address; the shell itself decides,
 * and on a yes the window starts over as that first mate's. Only while
 * nothing was done here (`FirstRunView.untouched`), the one profile the
 * shell follows along from.
 */
function useFollowAdded(can: boolean): void {
  useEffect(() => {
    if (!can) return;
    let live = true;
    const ask = () => {
      if (live) void window.infinitary.devices.followAdded().catch(() => undefined);
    };
    ask();
    const every = setInterval(ask, FOLLOW_EVERY_MS);
    return () => {
      live = false;
      clearInterval(every);
    };
  }, [can]);
}

/**
 * Whether the address way sets this computer up, read once for the chips
 * with no account, address or key, so the chip never waits for a key.
 */
function useSetUpOffered(): boolean {
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    let live = true;
    void window.infinitary.devices
      .setUpHere("offered")
      .then((read) => {
        if (live) setOffered(read.offered);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return offered;
}

/**
 * This computer as its first mate's computer reaches it, read only while
 * the Set up aside is open: the account and addresses at once, then the
 * keys, one read at a time, the next a moment after the last answered, so
 * an older answer never replaces a newer one. `unread` says the addresses
 * could not be read yet; the next read tries again.
 */
function useSetUpHere(open: boolean): { here: SetUpHere | null; unread: boolean } {
  const [here, setHere] = useState<SetUpHere | null>(null);
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    let keyed = false;
    let next: ReturnType<typeof setTimeout> | undefined;
    void window.infinitary.devices
      .setUpHere("addresses")
      .then((read) => {
        if (live && !keyed) setHere(read);
      })
      .catch(() => {
        if (live && !keyed) setUnread(true);
      });
    const read = () =>
      void window.infinitary.devices
        .setUpHere("keys")
        .then((read) => {
          if (!live) return;
          keyed = true;
          setHere(read);
          setUnread(false);
        })
        .catch(() => {
          if (live) setUnread(true);
        })
        .finally(() => {
          if (live) next = setTimeout(read, SET_UP_RENEW_MS);
        });
    read();
    return () => {
      live = false;
      clearTimeout(next);
      setHere(null);
      setUnread(false);
    };
  }, [open]);
  return { here, unread };
}

export type JoinAnotherMacProps = {
  /** The aside opened or closed; the stage hides its chips while it is open. */
  onOpenChange?: (open: boolean) => void;
  /** A line under the chip, while it is closed. */
  note?: React.ReactNode;
  /** Joins with the link; the app's own by default. */
  join?: (link: string) => Promise<JoinOutcome>;
  /** Join by its address's two requests; the app's own by default. */
  byAddress?: JoinByAddress;
};

/**
 * Computers nearby with Remote Login on (docs/devices.md, "Macs nearby"),
 * looked for while `open`, asked again inside the core's minute, and
 * stopped once it closes, as Settings -> Devices looks for them.
 */
function useNearby(open: boolean): NearbyMacsView {
  const [nearby, setNearby] = useState<NearbyMacsView>(NEARBY_OFF);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const off = window.infinitary.devices.onNearby((view) => {
      if (live) setNearby(view);
    });
    const ask = () => void window.infinitary.devices.nearby(true).catch(() => undefined);
    ask();
    const renew = setInterval(ask, NEARBY_RENEW_MS);
    return () => {
      live = false;
      off();
      clearInterval(renew);
      setNearby(NEARBY_OFF);
      void window.infinitary.devices.nearby(false).catch(() => undefined);
    };
  }, [open]);
  return nearby;
}

export function JoinAnotherMac({ onOpenChange, note, join, byAddress }: JoinAnotherMacProps) {
  const [step, setStepState] = useState<Step>({ step: "closed" });
  const [value, setValue] = useState("");
  // Join by its address: what is typed, kept across every step and refusal.
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  /** The address as asked, with its port: each later step asks it again. */
  const asked = useRef("");
  const nearby = useNearby(step.step === "address");
  const setUpOffered = useSetUpOffered();
  const { here, unread } = useSetUpHere(step.step === "set-up");
  const followsAlong = useShellStore((s) => s.firstRun?.untouched === true);
  useFollowAdded(followsAlong);
  const setStep = (next: Step) => {
    setStepState(next);
    onOpenChange?.(next.step !== "closed");
  };
  const requests = (): JoinByAddress => byAddress ?? window.infinitary.devices;
  const cancel = () => {
    setValue("");
    setStep({ step: "closed" });
  };
  // One step of asking the computer for its link; each answer is the next step.
  const ask = async (at: string, options: JoinAtOptions = {}) => {
    asked.current = at;
    setStep({ step: "signing-in", address: at, ...(options.password ? { lettingIn: true } : {}) });
    let answer: JoinAtAnswer;
    try {
      answer = await requests().joinAt(at, options);
    } catch {
      answer = { refused: "failed" };
    }
    if ("refused" in answer) return setStep({ step: "address", refused: answer.refused, at });
    if (answer.asks === "confirm")
      return setStep({ step: "key", address: answer.address, line: answer.line });
    if (answer.asks === "password") return setStep({ step: "password", question: answer });
    setStep({
      step: "confirm",
      address: computerOf(addressParts(at).address),
      runsWork: answer.runsWork,
      alsoPrivate: answer.alsoPrivate,
      byAddress: true,
    });
  };
  const toAddress = () => {
    const at = addressAtPort(address, port);
    if (!at) return setStep({ step: "address", refused: "not-an-address", at: address.trim() });
    void ask(at);
  };
  const joinHeld = async (computer: string) => {
    setStep({ step: "reaching", address: computer });
    let outcome: JoinOutcome;
    try {
      outcome = await requests().joinHeld("join");
    } catch {
      outcome = { ok: false, refused: "other" };
    }
    if (outcome.ok) return;
    setStep({ step: "refused", refused: outcome.refused, address: computer, byAddress: true });
  };
  const forget = () => {
    void requests()
      .joinHeld("forget")
      .catch(() => undefined);
    cancel();
  };
  const toConfirm = () => {
    const read = linkAddress(value);
    if (!read) return setStep({ step: "paste", notALink: true });
    // A link for another user on that Mac is not for Firstmate here.
    if (read.kind === "work") return setStep({ step: "refused", refused: "kind", address: null });
    setStep({
      step: "confirm",
      address: read.address,
      // A computer whose system runs no work only controls, so its question says nothing of work.
      runsWork: read.kind === "mac" && thisDesktop().runsWork,
      alsoPrivate: read.alsoPrivate,
    });
  };
  const reach = async (address: string) => {
    setStep({ step: "reaching", address });
    let outcome: JoinOutcome;
    try {
      outcome = await (join ?? window.infinitary.devices.join)(value);
    } catch {
      outcome = { ok: false, refused: "other" };
    }
    // Joined: the window starts over as the other Mac's, and this one goes.
    if (outcome.ok) return;
    setValue("");
    setStep({ step: "refused", refused: outcome.refused, address });
  };
  return (
    <JoinAnotherMacView
      step={step}
      note={note}
      value={value}
      onValue={setValue}
      onOpen={() => setStep({ step: "paste", notALink: false })}
      here={here}
      unread={unread}
      setUpOffered={setUpOffered}
      followsAlong={followsAlong}
      onOpenSetUp={() => setStep({ step: "set-up" })}
      onOpenSharing={() => void window.infinitary.devices.openSharing().catch(() => undefined)}
      onContinue={toConfirm}
      onConfirm={(computer) => {
        if (step.step === "confirm" && step.byAddress) void joinHeld(computer);
        else void reach(computer);
      }}
      onCancel={step.step === "confirm" && step.byAddress ? forget : cancel}
      address={address}
      port={port}
      account={account ?? nearby.user ?? ""}
      nearby={nearby}
      onAddress={setAddress}
      onPort={setPort}
      onAccount={setAccount}
      onOpenAddress={() => setStep({ step: "address" })}
      onContinueAddress={toAddress}
      onKeyYes={(line) => void ask(asked.current, { confirm: line })}
      onKeyCancel={() => setStep({ step: "address" })}
      onPassword={(password) => void ask(asked.current, { password })}
    />
  );
}

export type JoinAnotherMacViewProps = {
  step: Step;
  /** This computer as its first mate's computer reaches it; null until read. */
  here?: SetUpHere | null;
  /** This computer's addresses could not be read yet; the next read tries again. */
  unread?: boolean;
  /** Set up from your first mate's computer leads the chips: the address way sets this computer up. */
  setUpOffered?: boolean;
  /** This window opens the first mate once its computer adds this one: nothing was done here yet. */
  followsAlong?: boolean;
  onOpenSetUp?: () => void;
  onOpenSharing?: () => void;
  /** A line under the chip, while it is closed: which Mac this app last left. */
  note?: React.ReactNode;
  value: string;
  onValue: (value: string) => void;
  onOpen: () => void;
  onContinue: () => void;
  onConfirm: (address: string) => void;
  onCancel: () => void;
  /** Join by its address's fields: the account and computer, the port, and Your account above the nearby list. */
  address: string;
  port: string;
  account: string;
  nearby: NearbyMacsView;
  onAddress: (address: string) => void;
  onPort: (port: string) => void;
  onAccount: (account: string) => void;
  onOpenAddress: () => void;
  onContinueAddress: () => void;
  /** The captain's yes on the key line. */
  onKeyYes: (line: string) => void;
  /** Cancel on the key line: nothing is sent, and the address stays. */
  onKeyCancel: () => void;
  /** That account's password, typed once. */
  onPassword: (password: string) => void;
};

/** A sentence with the address it names in mono, where the address is the thing itself. */
function withAddress(words: string, address: string | null): React.ReactNode {
  if (!address || !words.includes(address)) return words;
  const at = words.indexOf(address);
  return (
    <>
      {words.slice(0, at)}
      <code>{address}</code>
      {words.slice(at + address.length)}
    </>
  );
}

/** The chip group or the aside, for each step; drawn alone by the tests. */
export function JoinAnotherMacView(props: JoinAnotherMacViewProps) {
  const { step, value } = props;
  if (step.step === "closed") {
    // Only a computer its first mate's computer can add by its address offers it, first.
    const setUp = Boolean(props.setUpOffered);
    return (
      <div className="fm-join-group" data-join-another-mac="closed">
        <div className="fm-join-row" data-join-chips-alone={setUp ? "" : undefined}>
          <MicroLabel>{m.devicesJoinElsewhere({ computer: COMPUTER.one })}</MicroLabel>
          <div className="fm-connect-chips" data-connect-chips="stage">
            {setUp && (
              <button
                type="button"
                className="fm-connect-chip"
                data-join-set-up-chip=""
                onClick={props.onOpenSetUp}
              >
                {plusIcon}
                <span>{m.devicesJoinSetUpChip()}</span>
              </button>
            )}
            <button
              type="button"
              className="fm-connect-chip"
              data-join-chip=""
              onClick={props.onOpen}
            >
              {plusIcon}
              <span>{m.devicesJoinPasteChip()}</span>
            </button>
            <button
              type="button"
              className="fm-connect-chip"
              data-join-address-chip=""
              onClick={props.onOpenAddress}
            >
              {plusIcon}
              <span>{m.devicesJoinAddressChip()}</span>
            </button>
          </div>
        </div>
        {props.note}
      </div>
    );
  }
  return (
    <div className="fm-connect-aside-frame fm-join-aside" data-join-another-mac={step.step}>
      {step.step === "paste" && (
        <form
          onSubmit={(event: React.FormEvent) => {
            event.preventDefault();
            if (value.trim()) props.onContinue();
          }}
        >
          <p className="fm-join-head">{m.devicesJoinPasteHead({ computer: COMPUTER.one })}</p>
          <p className="fm-join-sub">{m.devicesJoinPasteSub()}</p>
          <div className="fm-join-field">
            <div>
              <Input
                mono
                aria-label={m.devicesJoinLinkLabel({ computer: COMPUTER.one })}
                // i18n-exempt: a sample link
                placeholder="infinitary://join?…"
                value={value}
                onChange={(event) => props.onValue(event.target.value)}
                autoFocus
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <Button variant="primary" size="sm" type="submit" disabled={!value.trim()}>
              {m.devicesJoinContinue()}
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onCancel}>
              {m.devicesJoinCancel()}
            </Button>
          </div>
          {step.notALink && (
            <p className="fm-join-warn" role="alert" data-join-warn="">
              <StatusDot tone="warn" label={m.devicesJoinNotJoined()} />
              {joinRefusalWords("not-a-link", null)}
            </p>
          )}
        </form>
      )}
      {step.step === "set-up" && <SetUpStep here={props.here ?? null} {...props} />}
      {step.step === "address" && <AddressStep {...props} step={step} />}
      {step.step === "key" && (
        <div data-join-key={step.address}>
          <p className="fm-join-head">{remoteLoginWords.confirmQuestion(step.address)[0]}</p>
          <p className="fm-join-sub">{remoteLoginWords.confirmQuestion(step.address)[1]}</p>
          <div className="fm-devices-check" data-join-key-line="">
            {step.line}
          </div>
          <div className="fm-join-buttons">
            <Button variant="primary" size="sm" onClick={() => props.onKeyYes(step.line)}>
              {m.devicesJoinKeyYes({ computer: COMPUTER.one })}
            </Button>
            <Button variant="ghost" size="sm" autoFocus onClick={props.onKeyCancel}>
              {m.devicesJoinCancel()}
            </Button>
          </div>
        </div>
      )}
      {step.step === "password" && <PasswordStep {...props} question={step.question} />}
      {step.step === "signing-in" && (
        <div role="status" data-join-signing-in="">
          <p className="fm-join-head">
            {step.lettingIn
              ? remoteLoginWords.lettingInRow(step.address)
              : remoteLoginWords.reachingRow(step.address)}
          </p>
          <p className="fm-join-sub">{m.devicesJoinMoment()}</p>
        </div>
      )}
      {step.step === "confirm" && (
        <div>
          <p className="fm-join-head">
            {JOIN_CONFIRM_WORDS.before} <code>{step.address}</code>
            {step.alsoPrivate ? JOIN_CONFIRM_WORDS.orPrivate : ""}
            {JOIN_CONFIRM_WORDS.after}
          </p>
          <p className="fm-join-sub">
            {m.devicesJoinShows({ here: HERE.This, computer: COMPUTER.one })}
          </p>
          {step.runsWork && <p className="fm-join-sub">{JOIN_RUNS_WORK}</p>}
          <p className="fm-join-sub">{m.devicesJoinKeepHere({ here: HERE.this })}</p>
          <div className="fm-join-buttons">
            <Button
              variant="primary"
              size="sm"
              autoFocus
              onClick={() => props.onConfirm(step.address)}
            >
              {m.devicesJoinControl()}
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onCancel}>
              {m.devicesJoinCancel()}
            </Button>
          </div>
        </div>
      )}
      {step.step === "reaching" && (
        <div role="status">
          <p className="fm-join-head">
            {withAddress(
              m.devicesJoinReaching({ computer: COMPUTER.one, address: step.address }),
              step.address,
            )}
          </p>
          <p className="fm-join-sub">{m.devicesJoinMoment()}</p>
        </div>
      )}
      {step.step === "refused" && (
        <div data-join-refused={step.refused}>
          <p className="fm-join-head">{m.devicesJoinDidNotJoin({ here: HERE.This })}</p>
          <p className="fm-join-warn" role="alert" data-join-warn="">
            <StatusDot tone="warn" label={m.devicesJoinNotJoined()} nativeTitle={false} />
            <span>{withAddress(joinRefusalWords(step.refused, step.address), step.address)}</span>
          </p>
          <div className="fm-join-buttons">
            <Button
              variant="primary"
              size="sm"
              autoFocus
              onClick={step.byAddress ? props.onOpenAddress : props.onOpen}
            >
              {step.byAddress ? m.devicesJoinTryAgain() : m.devicesJoinPasteAnother()}
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onCancel}>
              {m.devicesJoinCancel()}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One address to type on the first mate's computer, with its own Copy. */
function CopyLine({ text, name, autoFocus }: { text: string; name: string; autoFocus: boolean }) {
  const [copied, copy] = useCopied();
  return (
    <>
      <div className="fm-join-copy" data-join-set-up-address={name}>
        <code className="fm-devices-link">{text}</code>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          autoFocus={autoFocus}
          onClick={() => void copy(text)}
        >
          {copied === "copied" ? m.settingsDevicesCopied() : m.devicesJoinSetUpCopy()}
        </Button>
      </div>
      {copied === "failed" && <SettingError error={m.devicesJoinSetUpCopyFailed()} />}
    </>
  );
}

/**
 * Set up from your first mate's computer (design skill JoinAnotherMac, "Set
 * up from your first mate's computer"): the address to type there, private
 * network first, the local name for the same network, whether Remote Login
 * is on here, the check line that computer asks about, and the wait that
 * ends when this window follows along by itself.
 */
function SetUpStep(props: JoinAnotherMacViewProps & { here: SetUpHere | null }) {
  const { here } = props;
  const at = (address: string) => (here?.user ? `${here.user}@${address}` : address);
  // On Linux, Remote Login is its SSH server.
  const mac = thisDesktop().mac;
  const remoteLogin =
    here?.remoteLogin === "on"
      ? mac
        ? m.devicesJoinSetUpOn()
        : m.devicesJoinSetUpSshOn()
      : mac
        ? m.devicesJoinSetUpOff()
        : m.devicesJoinSetUpSshOff();
  // Focus lands on the first address to copy, or on Cancel before this computer is read.
  const first = here?.privateAddress ? "private" : here?.localName ? "local" : null;
  return (
    <div data-join-set-up="">
      <p className="fm-join-head">{m.devicesJoinSetUpHead()}</p>
      <p className="fm-join-sub">{m.devicesJoinSetUpSub()}</p>
      {here?.privateAddress && (
        <>
          <CopyLine name="private" text={at(here.privateAddress)} autoFocus={first === "private"} />
          <p className="fm-join-sub fm-join-under">{m.devicesJoinSetUpPrivate()}</p>
        </>
      )}
      {here?.localName && (
        <>
          {here.privateAddress && (
            <p className="fm-join-sub fm-join-under">{m.devicesJoinSetUpLocal()}</p>
          )}
          <CopyLine name="local" text={at(here.localName)} autoFocus={first === "local"} />
        </>
      )}
      {((props.unread && !here) || (here && !here.privateAddress && !here.localName)) && (
        <p className="fm-join-sub" role="alert" data-join-set-up-unread="">
          {m.devicesJoinSetUpUnread()}
        </p>
      )}
      {here && here.remoteLogin !== "unknown" && (
        <div className="fm-join-state" data-join-remote-login={here.remoteLogin}>
          <StatusDot
            tone={here.remoteLogin === "on" ? "ok" : "warn"}
            label={remoteLogin}
            nativeTitle={false}
          />
          <span>{remoteLogin}</span>
          {here.remoteLogin === "off" && here.opensSharing && (
            <Button variant="secondary" size="sm" type="button" onClick={props.onOpenSharing}>
              {m.devicesJoinSetUpOpenSharing()}
            </Button>
          )}
        </div>
      )}
      {here?.line && here.lineAt && (
        <>
          <p className="fm-join-sub fm-join-under">
            {m.devicesJoinSetUpCompare({ address: at(here.lineAt) })}
          </p>
          <div className="fm-devices-check" data-join-set-up-line="">
            {here.line}
          </div>
        </>
      )}
      <p className="fm-join-sub fm-join-waiting" role="status">
        {props.followsAlong ? m.devicesJoinSetUpWaiting() : m.devicesJoinSetUpKept()}
      </p>
      <div className="fm-join-buttons">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          autoFocus={first === null}
          onClick={props.onCancel}
        >
          {m.devicesJoinCancel()}
        </Button>
      </div>
    </div>
  );
}

/**
 * Join by its address's first step (design skill JoinAnotherMac, "By its
 * address"): the account and computer, an optional port, Continue and
 * Cancel, then Your account above the computers nearby. A refusal is one
 * warning line, with what was typed still in the fields.
 */
function AddressStep(
  props: JoinAnotherMacViewProps & { step: Extract<Step, { step: "address" }> },
) {
  const { step, address, port, account, nearby } = props;
  const form = useRef<HTMLFormElement>(null);
  const field = () => form.current?.querySelector<HTMLInputElement>("#join-address");
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (picked === null) return;
    const at = form.current?.querySelector<HTMLInputElement>("#join-address");
    if (at && at.value === picked) focusWithRing(at);
    setPicked(null);
  }, [picked]);
  const user = account.trim();
  return (
    <form
      ref={form}
      data-join-address=""
      onSubmit={(event: React.FormEvent) => {
        event.preventDefault();
        if (address.trim()) props.onContinueAddress();
      }}
    >
      <label className="fm-join-head" htmlFor="join-address">
        {m.devicesJoinAddressChip()}
      </label>
      <p className="fm-join-sub">
        {m.devicesJoinAddressSub({ computer: COMPUTER.one, mustBeOn: sshMustBeOn() })}
      </p>
      <div className="fm-join-field">
        <div>
          <Input
            id="join-address"
            mono
            // i18n-exempt: a sample account and computer address
            placeholder="kun@studio"
            value={address}
            onChange={(event) => props.onAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              const first = form.current?.querySelector<HTMLElement>(
                "[data-device-nearby-mac][tabindex='0']",
              );
              if (!first) return;
              event.preventDefault();
              focusWithRing(first);
            }}
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <PortField id="join-port" value={port} onChange={props.onPort} />
        <Button variant="primary" size="sm" type="submit" disabled={!address.trim()}>
          {m.devicesJoinContinue()}
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onCancel}>
          {m.devicesJoinCancel()}
        </Button>
      </div>
      {step.refused && (
        <p className="fm-join-warn" role="alert" data-join-warn="" data-join-refused={step.refused}>
          <StatusDot tone="warn" label={m.devicesJoinNotJoined()} nativeTitle={false} />
          <span>{joinAtRefusalWords(step.refused, step.at ?? address.trim())}</span>
        </p>
      )}
      {nearby.macs.length > 0 && (
        <div className="fm-join-account">
          <label className="fm-devices-nearby-label" htmlFor="join-account">
            {m.devicesJoinYourAccount()}
          </label>
          <Input
            id="join-account"
            mono
            // i18n-exempt: a sample account name
            placeholder="kun"
            value={account}
            onChange={(event) => props.onAccount(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              const first = form.current?.querySelector<HTMLElement>(
                "[data-device-nearby-mac][tabindex='0']",
              );
              if (!first) return;
              event.preventDefault();
              focusWithRing(first);
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <p className="fm-join-sub">{m.devicesJoinPickHint({ computer: COMPUTER.one })}</p>
        </div>
      )}
      <NearbyList
        nearby={nearby}
        devices={[]}
        addressOf={(mac) => (user ? `${user}@${mac.at}` : mac.at)}
        onPick={(picked) => {
          props.onAddress(picked);
          props.onPort("");
          setPicked(picked);
        }}
        onLeave={() => {
          const above = form.current?.querySelector<HTMLInputElement>("#join-account") ?? field();
          if (above) focusWithRing(above);
        }}
      />
    </form>
  );
}

/**
 * That account's password, asked once when the computer did not let the
 * person's SSH key in, as Settings -> Devices asks it: the field holds what
 * is typed until Continue sends it on that one call, then empties.
 */
function PasswordStep(props: JoinAnotherMacViewProps & { question: RemoteLoginPasswordQuestion }) {
  const { question } = props;
  const [typed, setTyped] = useState("");
  const [found, say] = remoteLoginWords.passwordQuestion(question.address);
  const field = remoteLoginWords.passwordField(question.user);
  return (
    <form
      data-join-password={question.address}
      onSubmit={(event: React.FormEvent) => {
        event.preventDefault();
        if (!typed) return;
        const password = typed;
        setTyped("");
        props.onPassword(password);
      }}
    >
      <p className="fm-join-head">{found}</p>
      <p className="fm-join-sub">{say}</p>
      <div className="fm-join-field">
        <div>
          <Input
            type="password"
            aria-label={field}
            placeholder={field}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <Button variant="primary" size="sm" type="submit" disabled={!typed}>
          {m.devicesJoinContinue()}
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onKeyCancel}>
          {m.devicesJoinCancel()}
        </Button>
      </div>
      {question.wrong && (
        <p className="fm-join-warn" role="alert" data-join-warn="">
          <StatusDot tone="warn" label={m.devicesJoinNotJoined()} nativeTitle={false} />
          <span>{joinAtRefusalWords("password-wrong", question.address)}</span>
        </p>
      )}
    </form>
  );
}
