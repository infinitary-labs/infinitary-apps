import {
  type JoinOutcome,
  linkNamesPrivateToo,
  parsePairingLink,
  splitDialAddress,
} from "@shared/devices";
import type React from "react";
import { useState } from "react";
import { Button, Input, MicroLabel, StatusDot } from "../design";
import { JOIN_CONFIRM_WORDS, JOIN_RUNS_WORK, joinRefusalWords } from "./viewWords";
import "./joinAnotherMac.css";
import { COMPUTER, HERE } from "@shared/deviceNames";

/**
 * Joining Firstmate on another Mac from this app's first launch (design
 * skill `components/devices/JoinAnotherMac`, docs/view.md): one chip under
 * the provider chips, and the aside it opens - paste the link, confirm the
 * address it names, reach that Mac, or say why this Mac did not join. A
 * link joins only by being pasted here, and only after the person
 * confirms; it lives in this component's memory and nowhere else.
 */

type Step =
  | { step: "closed" }
  | { step: "paste"; notALink: boolean }
  | { step: "confirm"; address: string; runsWork: boolean; alsoPrivate?: boolean }
  | { step: "reaching"; address: string }
  | {
      step: "refused";
      refused: Exclude<JoinOutcome, { ok: true }>["refused"];
      address: string | null;
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
};

export function JoinAnotherMac({ onOpenChange, note, join }: JoinAnotherMacProps) {
  const [step, setStepState] = useState<Step>({ step: "closed" });
  const [value, setValue] = useState("");
  const setStep = (next: Step) => {
    setStepState(next);
    onOpenChange?.(next.step !== "closed");
  };
  const cancel = () => {
    setValue("");
    setStep({ step: "closed" });
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
      onConfirm={(address) => void reach(address)}
      onCancel={cancel}
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
            <Button variant="primary" size="sm" autoFocus onClick={props.onOpen}>
              Paste another link
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
