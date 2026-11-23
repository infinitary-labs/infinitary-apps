import { CONNECTION_PORT } from "@shared/connection";
import { COMPUTER } from "@shared/deviceNames";
import type { JoinOutcome } from "@shared/devices";
import {
  HOME_STEPS,
  type HomeAtAnswer,
  type HomeAtOptions,
  type HomeAtRefused,
  type HomeAtStarted,
  type HomeStep,
  homeAtRefusalLines,
  homeConnectLines,
  homeStepsLeft,
} from "@shared/homeAt";
import * as m from "@shared/i18n/messages.generated";
import { computerOf, type JoinAtAnswer, joinAtRefusalWords } from "@shared/joinByAddress";
import { NEARBY_OFF, NEARBY_RENEW_MS, type NearbyMacsView } from "@shared/nearbyMacs";
import {
  addressAtPort,
  addressParts,
  lingerWay,
  type RemoteLoginPasswordQuestion,
  remoteLoginWords,
} from "@shared/remoteLogin";
import { useEffect, useRef, useState } from "react";
import { Button, StatusDot } from "../design";
import { useCopied } from "../settings/DevicesLinks";
import { SettingError } from "../settings/settingRows";
import { AddressForm, PasswordStep } from "./JoinAnotherMac";
import { sshMustBeOn } from "./NearbyList";
import { joinRefusalWords } from "./viewWords";
import "./joinAnotherMac.css";
import "./setUpThere.css";

/**
 * Set me up on another computer, from the welcome screen's Another computer
 * (design skill `components/devices/SetUpThere`, docs/first-launch.md,
 * "Setting it up from here"): the address as Join by its address takes it,
 * then seven steps in a list - read its SSH key, sign in, check its system,
 * send Infinitary, start the first mate there, connect from here, connect a
 * subscription for it - each with what it found once done. The first five
 * are `inf:devices:home-at`, asked again with each answer; connecting from
 * here is Join by its address's two requests, asked again while the first
 * mate there is still opening. Joined, the window starts over as that
 * computer's, whose own first launch is the seventh step. A stop names the
 * step, what to try, and offers Ask again, Set it up with commands and Back.
 */

/** How long connecting waits for the first mate there to open, unless it waits for a login. */
const OPENS_WITHIN_MS = 60_000;
const ASK_EVERY_MS = 2_000;

export type HomePhase =
  | { at: "address"; refused?: HomeAtRefused }
  | { at: "key"; address: string; line: string }
  | { at: "password"; question: RemoteLoginPasswordQuestion }
  | { at: "account"; name: string }
  | { at: "runs"; address: string; name: string }
  | {
      at: "working";
      step: HomeStep;
      name: string;
      sentMb?: number;
      cancelling?: boolean;
      started?: HomeAtStarted;
    }
  | {
      at: "stopped";
      step: HomeStep;
      name: string;
      lines: [string, string];
      /** The first mate there was started, and keeps running. */
      running: boolean;
      /** Something there changed before it stopped: the footer does not say nothing changed. */
      changed: boolean;
      way?: string;
      started?: HomeAtStarted;
    };

/** The requests the screen makes; the app's own by default. */
export type HomeRequests = {
  homeAt: (address: string, options?: HomeAtOptions) => Promise<HomeAtAnswer>;
  cancelHomeAt: (address: string) => Promise<{ ok: true }>;
  joinAt: (address: string) => Promise<JoinAtAnswer>;
  joinHeld: (choice: "join" | "forget") => Promise<JoinOutcome>;
};

export type SetUpThereProps = {
  /** The address it starts with, as typed: Set it up from here brings it. */
  address?: string;
  /** Set it up with commands: the welcome's commands route. */
  onCommands: () => void;
  /** Connect to it instead: Join by its address, with this address. */
  onConnect: (address: string) => void;
  requests?: HomeRequests;
};

/** Computers nearby with Remote Login on, looked for while `open`, as Join by its address does. */
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

/** The computer's own name until the look reads it: the host the address names. */
function hostOf(address: string): string {
  return computerOf(addressParts(address).address);
}

export function SetUpThere({ onCommands, onConnect, requests, ...props }: SetUpThereProps) {
  const [phase, setPhase] = useState<HomePhase>({ at: "address" });
  const [address, setAddress] = useState(() => addressParts(props.address ?? "").address);
  const [port, setPort] = useState(() => addressParts(props.address ?? "").port);
  const [account, setAccount] = useState<string | null>(null);
  const nearby = useNearby(phase.at === "address");
  /** The address as asked, with its port: each later step asks it again. */
  const asked = useRef("");
  /** What the person agreed to on the way: asked again with every later step. */
  const agreed = useRef<HomeAtOptions>({});
  const cancelled = useRef(false);
  /** Something changed at the address asked: kept until Continue asks a new one. */
  const changedThere = useRef(false);
  /** The address a setup request is under way for, until it answers. */
  const underWay = useRef<string | null>(null);
  const live = useRef(true);
  const ask = (): HomeRequests => requests ?? window.infinitary.devices;
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      // Leaving the screen mid-setup stops it there at its next step, as Cancel does.
      const at = underWay.current;
      if (at)
        void askRef
          .current()
          .cancelHomeAt(at)
          .catch(() => undefined);
    };
  }, []);
  const set = (next: HomePhase) => {
    if (live.current) setPhase(next);
  };
  // The first mate here says how far the setup has gone there; the list follows it.
  const working = phase.at === "working" && !phase.started;
  useEffect(() => {
    if (!working) return;
    return window.infinitary.events.on((event) => {
      if (event.type !== "device_setup" || event.doing !== "add") return;
      setPhase((now) => {
        if (now.at !== "working" || now.started) return now;
        const name = event.name ?? now.name;
        if (event.stage === "reaching") return { ...now, name, step: "sign-in" };
        if (event.stage !== "setting-up") return { ...now, name };
        if (event.copy?.state === "starting") return { ...now, name, step: "start" };
        const sent = event.copy?.sent;
        return {
          ...now,
          name,
          step: "send",
          ...(sent ? { sentMb: Math.max(1, Math.round(sent / 1_000_000)) } : {}),
        };
      });
    });
  }, [working]);

  const stop = (refused: HomeAtRefused) => {
    const name = refused.name ?? hostOf(asked.current);
    if (refused.changed) changedThere.current = true;
    const changed =
      changedThere.current || HOME_STEPS.indexOf(refused.step) >= HOME_STEPS.indexOf("start");
    set({
      at: "stopped",
      step: refused.step,
      name,
      lines: homeAtRefusalLines(refused, asked.current, changed),
      running: false,
      changed,
    });
  };

  // One step of setting it up there; each answer is the next step.
  const setUp = async (password?: string) => {
    cancelled.current = false;
    const at = asked.current;
    set({ at: "working", step: password ? "sign-in" : "key", name: hostOf(at) });
    let answer: HomeAtAnswer;
    underWay.current = at;
    try {
      answer = await ask().homeAt(at, { ...agreed.current, ...(password ? { password } : {}) });
    } catch {
      answer = { refused: "failed", step: "key" };
    } finally {
      underWay.current = null;
    }
    if ("refused" in answer) {
      if (answer.refused === "not-an-address") return set({ at: "address", refused: answer });
      return stop(answer);
    }
    if ("started" in answer) {
      // Cancel pressed while it started there: it keeps running, and Ask again still connects.
      if (cancelled.current) return keepsRunning(answer);
      return void connect(answer);
    }
    if (answer.asks === "confirm")
      return set({ at: "key", address: answer.address, line: answer.line });
    if (answer.asks === "password") return set({ at: "password", question: answer });
    if (answer.asks === "account") return set({ at: "account", name: answer.name });
    set({ at: "runs", address: answer.address, name: answer.name });
  };

  const keepsRunning = (started: HomeAtStarted) =>
    set({
      at: "stopped",
      step: "connect",
      name: started.name,
      lines: [m.devicesHomeKeepsRunning({ computer: started.name }), ""],
      running: true,
      changed: true,
      started,
    });

  // 6. Connect from here as Join by its address does, once the first mate there opens.
  const connect = async (started: HomeAtStarted) => {
    const name = started.name;
    const stopped = (lines: [string, string], way?: string) =>
      set({
        at: "stopped",
        step: "connect",
        name,
        lines,
        running: true,
        changed: true,
        started,
        ...(way ? { way } : {}),
      });
    // A start that found no private address still tries: its words only say why a join failed.
    set({ at: "working", step: "connect", name, started });
    const until = Date.now() + OPENS_WITHIN_MS;
    for (;;) {
      if (!live.current) return;
      if (cancelled.current) return keepsRunning(started);
      let answer: JoinAtAnswer;
      try {
        answer = await ask().joinAt(started.address);
      } catch {
        answer = { refused: "failed" };
      }
      if (cancelled.current) return keepsRunning(started);
      if ("refused" in answer) {
        if (answer.refused === "not-open" && (started.waitsForLogin || Date.now() < until)) {
          await new Promise((done) => setTimeout(done, ASK_EVERY_MS));
          continue;
        }
        if (answer.refused === "not-open")
          return stopped([m.devicesHomeNotStarted({ computer: name }), m.devicesHomeOrCommands()]);
        return stopped([joinAtRefusalWords(answer.refused, started.address, answer.reach), ""]);
      }
      // Its key line was said yes to before it started; any other question is not this setup's.
      if (answer.asks !== "join")
        return stopped([joinAtRefusalWords("failed", started.address), ""]);
      let outcome: JoinOutcome;
      try {
        outcome = await ask().joinHeld("join");
      } catch {
        outcome = { ok: false, refused: "other" };
      }
      // Joined: the window starts over as that computer's, whose first launch is the last step.
      if (outcome.ok) return;
      if (outcome.refused === "unreachable") {
        const said = homeConnectLines(started, name);
        return stopped(said.lines, said.way);
      }
      return stopped([joinRefusalWords(outcome.refused, name), ""]);
    }
  };

  const toAddress = () => {
    const at = addressAtPort(address, port);
    agreed.current = {};
    changedThere.current = false;
    if (!at) return set({ at: "address", refused: { refused: "not-an-address", step: "key" } });
    asked.current = at;
    void setUp();
  };
  const cancel = () => {
    if (phase.at !== "working" || phase.cancelling) return;
    cancelled.current = true;
    setPhase({ ...phase, cancelling: true });
    if (!phase.started)
      void ask()
        .cancelHomeAt(asked.current)
        .catch(() => undefined);
  };
  return (
    <SetUpThereView
      phase={phase}
      address={address}
      port={port}
      account={account ?? nearby.user ?? ""}
      nearby={nearby}
      asked={asked.current}
      onAddress={setAddress}
      onPort={setPort}
      onAccount={setAccount}
      onContinueAddress={toAddress}
      onKeyYes={(line) => {
        agreed.current = { ...agreed.current, confirm: line };
        void setUp();
      }}
      onPassword={(password) => void setUp(password)}
      onAccountYes={() => {
        agreed.current = { ...agreed.current, account: true };
        void setUp();
      }}
      onConnect={() => phase.at === "runs" && onConnect(phase.address)}
      onCancel={cancel}
      onAskAgain={() => {
        cancelled.current = false;
        if (phase.at === "stopped" && phase.started) void connect(phase.started);
        else void setUp();
      }}
      onBack={() => set({ at: "address" })}
      onCommands={onCommands}
    />
  );
}

export type SetUpThereViewProps = {
  phase: HomePhase;
  address: string;
  port: string;
  account: string;
  nearby: NearbyMacsView;
  /** The address as asked, with its port. */
  asked: string;
  onAddress: (address: string) => void;
  onPort: (port: string) => void;
  onAccount: (account: string) => void;
  onContinueAddress: () => void;
  onKeyYes: (line: string) => void;
  onPassword: (password: string) => void;
  onAccountYes: () => void;
  onConnect: () => void;
  onCancel: () => void;
  onAskAgain: () => void;
  onBack: () => void;
  onCommands: () => void;
};

/** One command to run there, with its own Copy. */
function WayLine({ text }: { text: string }) {
  const [copied, copy] = useCopied();
  return (
    <>
      <div className="fm-join-copy" data-home-way="">
        <code className="fm-devices-link">{text}</code>
        <Button variant="secondary" size="sm" type="button" onClick={() => void copy(text)}>
          {copied === "copied" ? m.settingsDevicesCopied() : m.devicesJoinSetUpCopy()}
        </Button>
      </div>
      {copied === "failed" && <SettingError error={m.devicesJoinSetUpCopyFailed()} />}
    </>
  );
}

/** The address form's fields, without the steps' Cancel: the welcome's Back leaves this form. */
function fields({ onCancel: _steps, ...props }: SetUpThereViewProps) {
  return props;
}

/** The screen for each phase; drawn alone by the tests. */
export function SetUpThereView(props: SetUpThereViewProps) {
  const { phase } = props;
  return (
    <div className="fm-connect-aside-frame fm-join-aside fm-home" data-home-at={phase.at}>
      {phase.at === "address" && (
        <>
          <AddressForm
            {...fields(props)}
            id="home"
            head={m.devicesHomeAddressHead()}
            sub={m.devicesJoinAddressSub({ computer: COMPUTER.one, mustBeOn: sshMustBeOn() })}
            warning={
              phase.refused && (
                <p className="fm-join-warn" role="alert" data-home-warn="">
                  <StatusDot tone="warn" label={m.devicesJoinNotJoined()} nativeTitle={false} />
                  <span>{homeAtRefusalLines(phase.refused, props.address.trim())[0]}</span>
                </p>
              )
            }
          />
          <div className="fm-join-buttons">
            <Button variant="ghost" size="sm" data-home-commands="" onClick={props.onCommands}>
              {m.devicesHomeCommands()}
            </Button>
          </div>
        </>
      )}
      {phase.at === "key" && (
        <div data-home-key={phase.address}>
          <p className="fm-join-head">{remoteLoginWords.confirmQuestion(phase.address)[0]}</p>
          <p className="fm-join-sub">{remoteLoginWords.confirmQuestion(phase.address)[1]}</p>
          <div className="fm-devices-check" data-home-key-line="">
            {phase.line}
          </div>
          <div className="fm-join-buttons">
            <Button variant="primary" size="sm" onClick={() => props.onKeyYes(phase.line)}>
              {m.devicesJoinKeyYes({ computer: COMPUTER.one })}
            </Button>
            <Button variant="ghost" size="sm" autoFocus onClick={props.onBack}>
              {m.devicesJoinCancel()}
            </Button>
          </div>
        </div>
      )}
      {phase.at === "password" && (
        <PasswordStep
          question={phase.question}
          onPassword={props.onPassword}
          onKeyCancel={props.onBack}
        />
      )}
      {phase.at === "account" && (
        <div data-home-account="">
          <p className="fm-join-head">{m.devicesHomeRoot({ computer: phase.name })}</p>
          <p className="fm-join-sub">{m.devicesHomeAccountAsk()}</p>
          <div className="fm-join-buttons">
            <Button variant="primary" size="sm" autoFocus onClick={props.onAccountYes}>
              {m.devicesHomeAccountMake()}
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onBack}>
              {m.devicesJoinCancel()}
            </Button>
          </div>
        </div>
      )}
      {phase.at === "runs" && (
        <div data-home-runs="">
          <p className="fm-join-head">{m.devicesHomeRuns({ computer: phase.name })}</p>
          <p className="fm-join-sub">{m.devicesHomeRunsAsk()}</p>
          <div className="fm-join-buttons">
            <Button variant="primary" size="sm" autoFocus onClick={props.onConnect}>
              {m.devicesHomeRunsConnect()}
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onBack}>
              {m.devicesHomeBack()}
            </Button>
          </div>
        </div>
      )}
      {(phase.at === "working" || phase.at === "stopped") && <Steps {...props} phase={phase} />}
    </div>
  );
}

function stepLabel(step: HomeStep, asked: string): string {
  switch (step) {
    case "key": {
      // Only a typed port is known here; the person's SSH settings may name another.
      const port = addressParts(asked).port;
      return port ? m.devicesHomeStepKey({ port }) : m.devicesHomeStepKeyAny();
    }
    case "sign-in":
      return m.devicesHomeStepSignIn();
    case "look":
      return m.devicesHomeStepLook();
    case "send":
      return m.devicesHomeStepSend();
    case "start":
      return m.devicesHomeStepStart();
    case "connect":
      return m.devicesHomeStepConnect();
    case "sign-up":
      return m.devicesHomeStepSignUp();
  }
}

/** What a step found, said beside it once done; empty where it found nothing to say. */
function stepDetail(
  step: HomeStep,
  phase: Extract<HomePhase, { at: "working" | "stopped" }>,
  asked: string,
): string {
  const started = phase.started;
  switch (step) {
    case "sign-in":
      return addressParts(started?.address ?? asked).address;
    case "look":
      return phase.name;
    case "send":
      return phase.at === "working" && phase.sentMb
        ? m.devicesHomeSentMb({ mb: String(phase.sentMb) })
        : "";
    case "start":
      return started && !started.lingerOff && !started.waitsForLogin ? m.devicesHomeStartOn() : "";
    case "connect":
      return m.devicesHomePort({ port: String(CONNECTION_PORT) });
    case "sign-up":
      return m.devicesHomeSignsIn();
    default:
      return "";
  }
}

/**
 * The seven steps, the one under way lit, each done step with what it
 * found, and a stop's lines under the step it stopped at with its three
 * ways on.
 */
function Steps(
  props: SetUpThereViewProps & { phase: Extract<HomePhase, { at: "working" | "stopped" }> },
) {
  const { phase, asked } = props;
  const now = HOME_STEPS.indexOf(phase.step);
  const started = phase.started;
  const left = homeStepsLeft(phase.step);
  return (
    <div data-home-steps={phase.step}>
      <p className="fm-join-head">{m.devicesHomeTitle({ computer: phase.name })}</p>
      <p className="fm-join-sub fm-home-address" data-home-address="">
        {addressParts(started?.address ?? asked).address}
      </p>
      <ol className="fm-home-steps">
        {HOME_STEPS.map((step, index) => {
          const state =
            index < now
              ? "done"
              : index > now
                ? "next"
                : phase.at === "stopped"
                  ? "stopped"
                  : "current";
          // A done step says what it found, the step under way how far it has gone,
          // and the last two where they happen before they start.
          const shows = state !== "next" || step === "connect" || step === "sign-up";
          const detail = shows ? stepDetail(step, phase, asked) : "";
          return (
            <li
              key={step}
              className="fm-home-step"
              data-home-step={step}
              data-state={state}
              aria-current={state === "current" ? "step" : undefined}
            >
              <StatusDot
                tone={
                  state === "done"
                    ? "ok"
                    : state === "current"
                      ? "busy"
                      : state === "stopped"
                        ? "warn"
                        : "idle"
                }
                label={stepLabel(step, asked)}
                nativeTitle={false}
              />
              <span className="fm-home-step-name">{stepLabel(step, asked)}</span>
              {detail && <span className="fm-home-step-detail">{detail}</span>}
            </li>
          );
        })}
      </ol>
      {phase.at === "working" && started?.waitsForLogin && (
        <p className="fm-join-sub" role="status" data-home-waits-login="">
          {m.devicesHomeWaitsLogin({ computer: phase.name })}
        </p>
      )}
      {started?.lingerOff && started.user && (
        <div data-home-linger="">
          <p className="fm-join-sub">{m.devicesHomeLinger({ computer: phase.name })}</p>
          <WayLine text={lingerWay(started.user)} />
        </div>
      )}
      {phase.at === "working" && (
        <div className="fm-join-buttons">
          <Button
            variant="ghost"
            size="sm"
            autoFocus
            disabled={phase.cancelling}
            data-home-cancel=""
            onClick={props.onCancel}
          >
            {m.devicesJoinCancel()}
          </Button>
        </div>
      )}
      {phase.at === "stopped" && (
        <div data-home-stopped="">
          <p className="fm-join-warn" role="alert" data-home-warn="">
            <StatusDot tone="warn" label={stepLabel(phase.step, asked)} nativeTitle={false} />
            <span>{phase.lines[0]}</span>
          </p>
          {phase.lines[1] && <p className="fm-join-sub fm-home-way">{phase.lines[1]}</p>}
          {phase.way && <WayLine text={phase.way} />}
          <div className="fm-join-buttons">
            <Button
              variant="primary"
              size="sm"
              autoFocus
              data-home-ask-again=""
              onClick={props.onAskAgain}
            >
              {m.devicesHomeAskAgain()}
            </Button>
            <Button variant="secondary" size="sm" data-home-commands="" onClick={props.onCommands}>
              {m.devicesHomeCommands()}
            </Button>
            <Button variant="ghost" size="sm" data-home-back="" onClick={props.onBack}>
              {m.devicesHomeBack()}
            </Button>
          </div>
          {left > 0 && (phase.running || !phase.changed) && (
            <p className="fm-join-left fm-home-left" data-home-left="">
              {phase.running
                ? m.devicesHomeLeftRunning({ count: left, computer: phase.name })
                : m.devicesHomeLeftNothing({ count: left, computer: phase.name })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
