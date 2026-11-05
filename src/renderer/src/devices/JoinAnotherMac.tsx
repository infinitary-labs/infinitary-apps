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
import { Button, Input, MicroLabel, StatusDot } from "../design";
import { focusWithRing } from "../design/focus";
import { NearbyList, PortField, sshMustBeOn } from "./NearbyList";
import { JOIN_CONFIRM_WORDS, JOIN_RUNS_WORK, joinRefusalWords } from "./viewWords";
import "./joinAnotherMac.css";
import "../accounts/connectChips.css";
import "../settings/devices.css";
import { COMPUTER, HERE } from "@shared/deviceNames";

/**
 * Joining Firstmate on another Mac from this app's first launch (design
 * skill `components/devices/JoinAnotherMac`, docs/view.md): two chips under
 * the provider chips, and the aside each opens. Paste its link: paste the
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
      runsWork: read.kind === "mac",
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
  if (step.step === "closed")
    return (
      <div className="fm-join-group" data-join-another-mac="closed">
        <div className="fm-join-row">
          <MicroLabel>Your first mate is on another {COMPUTER.one}</MicroLabel>
          <div className="fm-connect-chips" data-connect-chips="stage">
            <button
              type="button"
              className="fm-connect-chip"
              data-join-chip=""
              onClick={props.onOpen}
            >
              {plusIcon}
              <span>Paste its link</span>
            </button>
            <button
              type="button"
              className="fm-connect-chip"
              data-join-address-chip=""
              onClick={props.onOpenAddress}
            >
              {plusIcon}
              <span>Join by its address</span>
            </button>
          </div>
        </div>
        {props.note}
      </div>
    );
  return (
    <div className="fm-connect-aside-frame fm-join-aside" data-join-another-mac={step.step}>
      {step.step === "paste" && (
        <form
          onSubmit={(event: React.FormEvent) => {
            event.preventDefault();
            if (value.trim()) props.onContinue();
          }}
        >
          <p className="fm-join-head">
            Paste the link from Infinitary on your other {COMPUTER.one}
          </p>
          <p className="fm-join-sub">
            You make it there, in Settings → Devices, or by asking your first mate.
          </p>
          <div className="fm-join-field">
            <div>
              <Input
                mono
                aria-label={`The link from your other ${COMPUTER.one}`}
                placeholder="infinitary://join?…"
                value={value}
                onChange={(event) => props.onValue(event.target.value)}
                autoFocus
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <Button variant="primary" size="sm" type="submit" disabled={!value.trim()}>
              Continue
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onCancel}>
              Cancel
            </Button>
          </div>
          {step.notALink && (
            <p className="fm-join-warn" role="alert" data-join-warn="">
              <StatusDot tone="warn" label="Not joined" />
              {joinRefusalWords("not-a-link", null)}
            </p>
          )}
        </form>
      )}
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
              This is the {COMPUTER.one}
            </Button>
            <Button variant="ghost" size="sm" autoFocus onClick={props.onKeyCancel}>
              Cancel
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
          <p className="fm-join-sub">This takes a moment.</p>
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
            {HERE.This} shows your first mate. Its cards, tasks and conversation stay on that{" "}
            {COMPUTER.one}.
          </p>
          {step.runsWork && <p className="fm-join-sub">{JOIN_RUNS_WORK}</p>}
          <p className="fm-join-sub">
            To keep your first mate on {HERE.this} instead, cancel and set it up here.
          </p>
          <div className="fm-join-buttons">
            <Button
              variant="primary"
              size="sm"
              autoFocus
              onClick={() => props.onConfirm(step.address)}
            >
              Control it from here
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {step.step === "reaching" && (
        <div role="status">
          <p className="fm-join-head">
            Reaching the {COMPUTER.one} at <code>{step.address}</code>…
          </p>
          <p className="fm-join-sub">This takes a moment.</p>
        </div>
      )}
      {step.step === "refused" && (
        <div data-join-refused={step.refused}>
          <p className="fm-join-head">{HERE.This} did not join</p>
          <p className="fm-join-warn" role="alert" data-join-warn="">
            <StatusDot tone="warn" label="Not joined" nativeTitle={false} />
            <span>{withAddress(joinRefusalWords(step.refused, step.address), step.address)}</span>
          </p>
          <div className="fm-join-buttons">
            <Button
              variant="primary"
              size="sm"
              autoFocus
              onClick={step.byAddress ? props.onOpenAddress : props.onOpen}
            >
              {step.byAddress ? "Try again" : "Paste another link"}
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
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
        Join by its address
      </label>
      <p className="fm-join-sub">
        The account and {COMPUTER.one}, as you sign in to it with SSH. {sshMustBeOn()}
      </p>
      <div className="fm-join-field">
        <div>
          <Input
            id="join-address"
            mono
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
          Continue
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
      {step.refused && (
        <p className="fm-join-warn" role="alert" data-join-warn="" data-join-refused={step.refused}>
          <StatusDot tone="warn" label="Not joined" nativeTitle={false} />
          <span>{joinAtRefusalWords(step.refused, step.at ?? address.trim())}</span>
        </p>
      )}
      {nearby.macs.length > 0 && (
        <div className="fm-join-account">
          <label className="fm-devices-nearby-label" htmlFor="join-account">
            Your account
          </label>
          <Input
            id="join-account"
            mono
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
          <p className="fm-join-sub">
            Type your account, then pick your {COMPUTER.one} to fill its address.
          </p>
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
          Continue
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onKeyCancel}>
          Cancel
        </Button>
      </div>
      {question.wrong && (
        <p className="fm-join-warn" role="alert" data-join-warn="">
          <StatusDot tone="warn" label="Not joined" nativeTitle={false} />
          <span>{joinAtRefusalWords("password-wrong", question.address)}</span>
        </p>
      )}
    </form>
  );
}
