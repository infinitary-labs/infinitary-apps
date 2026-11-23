import type { AccountView } from "@shared/accounts";
import type { FreshCheck } from "@shared/firstRun";
import * as m from "@shared/i18n/messages.generated";
import type { AuthNotice, AuthPromptView, ProviderView } from "@shared/providers";
import { catalogEntry } from "@shared/providers";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AuthAside,
  AuthMethodChoice,
  CodeExpired,
  connectMethods,
  ProviderChips,
  signInEnd,
} from "../accounts/ConnectChips";
import {
  answeredSignInPrompt,
  lastSignInNotice,
  runAccountAdd,
  signInFlightSnapshot,
  subscribeSignInFlight,
} from "../accounts/signInFlight";
import { Button } from "../design";
import { focusWithRing } from "../design/focus";
import { JoinAnotherMac } from "../devices/JoinAnotherMac";
import { useFollowAdded } from "../devices/useFollowAdded";
import { isView, leftLine, updateThereWords, waitsForUpdate } from "../devices/viewWords";
import { useCopied } from "../settings/DevicesLinks";
import { SettingError } from "../settings/settingRows";
import {
  FRESH_CHECK_ACTION,
  FRESH_CHECK_PENDING,
  freshCheckFailure,
  freshCheckLine,
  freshCheckTitle,
  GATE_CHOICES,
  GATE_COMMANDS,
  GATE_STILL_NEEDS,
  GATE_TITLE,
  type GateChoice,
  gateBack,
  gateChoiceWords,
  gateHomeTitle,
  gateIntro,
  gateMoveLater,
  gateRecoveryTitle,
  gateRunLine,
  gateStaysOn,
  gateWhere,
  MAC_COMMAND,
} from "./firstRunGateWords";
import { useShellStore } from "./store";
import "./firstRunGate.css";

/**
 * The first-launch gate (captain decisions 2026-09-19; docs/first-launch.md).
 * While no model can answer the Firstmate, the null state carries one
 * caption under the character in the design system's reserved null-state
 * display type, and the same provider chip row the Intelligence tab has, so
 * the sign-in happens right here; the input is disabled meanwhile. It is
 * derived from state, not a first-run flag: it returns if the last such
 * account is ever removed, and an account connected that cannot answer yet
 * shows in place of its chip while the caption restates the one remaining
 * need. When the gate closes the caption dissolves over `--dur-slow`, and
 * the host commits approved Firstmate copy before publishing readiness.
 *
 * On the first mate's own computer the gate asks first where the first mate
 * lives (captain's approval of INF-6207): three equal choices, This
 * computer (the chips), Another computer (the commands that set it up
 * there, ending at Paste its link) and One already running (the chips that
 * join it, docs/view.md), with a line that moving it later stays possible.
 * No choice opens until a press; a subscription connected that cannot answer
 * yet opens on This computer, where it shows. After this app left a first
 * mate, a line under the choices says which. An app that controls another
 * computer shows that computer's gate with its chips, and the first mate
 * there signs in from here (docs/view.md).
 *
 * When the gate is open only because the custom connection the Firstmate
 * was chosen on needs one fresh check (`FreshCheck`, saved checks an earlier
 * version made), the caption names that connection and the check runs right
 * here, ahead of the chips.
 */
export function FirstRunGate() {
  const firstRun = useShellStore((s) => s.firstRun);
  const loadFirstRun = useShellStore((s) => s.loadFirstRun);
  const thisMac = useShellStore((s) => s.thisMac);
  const view = isView(thisMac);
  const left = thisMac?.role === "home" ? thisMac.left : null;
  const [joining, setJoining] = useState(false);
  // Where the first mate lives, as pressed: nothing until a press, and "ask" after Where I live.
  const [picked, setPicked] = useState<GateChoice | "ask" | null>(null);
  // Another computer's last step opens One already running at its paste box.
  const [pasteFirst, setPasteFirst] = useState(false);
  const open = firstRun?.gateOpen === true;
  // A first mate on an older version answers no check from here: the update line says so.
  const waits = waitsForUpdate(thisMac);
  const fresh = open && !waits ? firstRun?.freshCheck : undefined;
  // The caption stays mounted while it dissolves.
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setShown(true);
      return;
    }
    // A gate that comes back asks afresh where the first mate lives.
    const id = window.setTimeout(() => {
      setShown(false);
      setPicked(null);
      setPasteFirst(false);
    }, 700);
    return () => window.clearTimeout(id);
  }, [open]);

  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<AuthPromptView | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.infinitary.auth
      .providers()
      .then(setProviders)
      .catch(() => {});
    void window.infinitary.accounts
      .list()
      .then(setAccounts)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!shown || waits) return;
    refresh();
    const offPrompt = window.infinitary.auth.onPrompt((incoming) => {
      setPrompt(incoming);
      setPromptValue("");
    });
    const offNotice = window.infinitary.auth.onNotice((incoming) => setNotice(incoming));
    return () => {
      offPrompt();
      offNotice();
    };
  }, [shown, waits, refresh]);

  const [methodChoice, setMethodChoice] = useState<ProviderView | null>(null);
  const connect = (provider: ProviderView) => {
    const methods = connectMethods(provider);
    if (methods.length > 1) {
      setMethodChoice(provider);
      setError(null);
      return;
    }
    start(provider, methods[0] ?? "api_key");
  };
  // The person's own Cancel ends the sign-in quietly (INF-838); a code
  // step's Enterprise row starts it again on the chosen host.
  const cancelled = useRef(false);
  const restart = useRef<{ provider: ProviderView; host: string | undefined } | null>(null);
  const [expired, setExpired] = useState<ProviderView | null>(null);
  const [enterpriseHost, setEnterpriseHost] = useState<string | undefined>(undefined);
  const start = (provider: ProviderView, type: "oauth" | "api_key", host?: string) => {
    setMethodChoice(null);
    setExpired(null);
    setBusyProviderId(provider.id);
    setError(null);
    setNotice(null);
    setEnterpriseHost(host);
    cancelled.current = false;
    void runAccountAdd(provider.id, () =>
      window.infinitary.accounts.add(
        provider.id,
        type,
        host ? { enterpriseHost: host } : undefined,
      ),
    )
      .then(() => {
        // The sign-in finished in the browser: the window comes forward.
        void window.infinitary.app.controlWindow("front").catch(() => {});
      })
      .catch((caught) => {
        const end = signInEnd({
          cancelled: cancelled.current,
          notice: lastSignInNotice(provider.id),
          now: Date.now(),
        });
        if (end === "expired") setExpired(provider);
        else if (end === "failed")
          setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        setBusyProviderId(null);
        setPrompt(null);
        setNotice(null);
        refresh();
        // The gate may have just closed: the store re-reads and the
        // caption dissolves; the quota snapshot that follows re-reads too.
        void loadFirstRun();
        void window.infinitary.quota.refresh().catch(() => {});
        const next = restart.current;
        restart.current = null;
        if (next) start(next.provider, "oauth", next.host);
      });
  };
  const cancel = () => {
    cancelled.current = true;
    void window.infinitary.auth.cancel().catch(() => {});
  };

  useEffect(() => {
    let sawFlight = false;
    const apply = () => {
      const snap = signInFlightSnapshot();
      if (snap.providerId) {
        sawFlight = true;
        setBusyProviderId(snap.providerId);
        if (snap.notice) setNotice(snap.notice);
        if (snap.prompt) setPrompt(snap.prompt);
        return;
      }
      if (!sawFlight) return;
      sawFlight = false;
      setBusyProviderId(null);
      setPrompt(null);
      setNotice(null);
    };
    apply();
    return subscribeSignInFlight(apply);
  }, []);

  // The connection's one fresh check: a failure takes the sentence's place
  // above the action, where the bounded band still shows it, and a passing
  // check re-reads the gate, which then dissolves.
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  // A failure belongs to the ask it answered; a gate that comes back asks afresh.
  const freshAccount = fresh?.accountId;
  useEffect(() => {
    if (!freshAccount) setCheckError(null);
  }, [freshAccount]);
  const checkAgain = (check: FreshCheck) => {
    setChecking(true);
    setCheckError(null);
    void window.infinitary.accounts.custom
      .recheck(check.accountId)
      .then((view) => {
        const failed = view.models.find((model) => model.failure);
        if (failed?.failure) setCheckError(freshCheckFailure(failed.id, failed.failure));
      })
      .catch((caught) => {
        setCheckError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        setChecking(false);
        void loadFirstRun();
      });
  };

  const answerPrompt = (value: string | null) => {
    if (!prompt) return;
    if (value === null) cancelled.current = true;
    void window.infinitary.auth.replyPrompt(prompt.promptId, value);
    answeredSignInPrompt(prompt.promptId);
    setPrompt(null);
  };

  // While a sign-in is under way the band holds the display line and the
  // provider's own flow, nothing else: the caption's sentence and the row
  // return with the next choice. The band never reaches the input below.
  const connecting =
    methodChoice !== null ||
    busyProviderId !== null ||
    prompt !== null ||
    notice !== null ||
    expired !== null;
  const followStatus = useFollowAdded(open && !view && !connecting, firstRun?.untouched === true);
  if (!shown) return null;
  const connectingName =
    methodChoice?.name ??
    expired?.name ??
    providers.find((entry) => entry.id === busyProviderId)?.name ??
    null;
  const busyProvider = providers.find((entry) => entry.id === busyProviderId);
  // The first mate's own computer asks where it lives; a view and a fresh check do not.
  const asks = !view && !fresh;
  const choice = asks ? (picked ?? (accounts.length > 0 ? "here" : "ask")) : null;
  const pick = (next: GateChoice | "ask") => {
    setPasteFirst(false);
    setError(null);
    setPicked(next);
  };
  const leftNote = left && (
    <p className="fm-join-left" data-left-mac={left.reason}>
      {leftLine(left)}
    </p>
  );
  return (
    <div
      className="fm-gate"
      data-first-run-gate={open ? "open" : "closing"}
      data-open={open}
      data-sign-in-step={
        methodChoice || notice || prompt || expired || choice === "another" ? "" : undefined
      }
    >
      <div className="fm-gate-inner">
        {/* The commands route is a setup step, as a sign-in is: it takes the heading's room. */}
        {choice !== "another" && (
          <p className="fm-gate-display" data-gate-title="">
            {fresh
              ? freshCheckTitle(fresh.label)
              : view
                ? GATE_TITLE()
                : accounts.length > 0
                  ? gateRecoveryTitle()
                  : gateHomeTitle()}
          </p>
        )}
        {!connecting && view && !fresh && (
          <p className="fm-gate-sub" data-run-line="">
            {thisMac.needsUpdateThere ? updateThereWords(thisMac) : gateRunLine(thisMac.name)}
          </p>
        )}
        {!connecting && !joining && fresh && (
          <div className="fm-gate-check" data-fresh-check={fresh.accountId}>
            {checkError ? (
              <p role="alert" className="fm-gate-error" data-fresh-check-line="">
                {checkError}
              </p>
            ) : (
              <p className="fm-gate-sub" data-fresh-check-line="">
                {freshCheckLine(fresh)}
              </p>
            )}
            <Button
              variant="primary"
              pending={checking}
              pendingLabel={FRESH_CHECK_PENDING()}
              onClick={() => checkAgain(fresh)}
            >
              {FRESH_CHECK_ACTION()}
            </Button>
          </div>
        )}
        {!connecting && !joining && asks && choice !== "another" && (
          <p className="fm-gate-sub" data-mac-choice="">
            {accounts.length > 0 ? (
              <>
                {GATE_STILL_NEEDS()}
                <br />
                {gateStaysOn()}
              </>
            ) : (
              gateIntro()
            )}
          </p>
        )}
        {!connecting && choice === "ask" && (
          <>
            <p className="fm-gate-sub" data-gate-where="">
              {gateWhere()}
            </p>
            <GateChoices onPick={pick} />
            <p className="fm-gate-later" data-gate-later="">
              {gateMoveLater()}
            </p>
            {leftNote}
          </>
        )}
        {!connecting && !joining && choice !== null && choice !== "ask" && (
          <button
            type="button"
            className="fm-gate-back"
            data-gate-back={choice}
            onClick={() => pick("ask")}
          >
            <span aria-hidden="true">‹</span> {gateBack()}
          </button>
        )}
        {!connecting && !joining && !waits && (choice === null || choice === "here") && (
          <ProviderChips
            providers={providers}
            accounts={accounts}
            busyProviderId={busyProviderId}
            onConnect={connect}
            variant="stage"
          />
        )}
        {!connecting && choice === "another" && (
          <CommandsRoute
            onPaste={() => {
              setPicked("running");
              setPasteFirst(true);
            }}
          />
        )}
        {!connecting && (choice === "running" || (choice === null && !view)) && (
          <JoinAnotherMac
            followStatus={followStatus}
            key={pasteFirst ? "paste" : "chips"}
            {...(pasteFirst ? { opens: "paste" as const } : {})}
            onOpenChange={setJoining}
            note={choice === null ? leftNote : undefined}
          />
        )}
        {connecting && connectingName && !methodChoice && !prompt && !notice && !expired && (
          <p className="fm-gate-sub" data-connecting={connectingName}>
            {m.shellGateConnecting({ name: connectingName })}
          </p>
        )}
        {error && (
          <p role="alert" className="fm-gate-error">
            {error}
          </p>
        )}
        {methodChoice && (
          <AuthMethodChoice
            framed
            provider={methodChoice}
            onPick={(type) => start(methodChoice, type)}
            onCancel={() => setMethodChoice(null)}
          />
        )}
        {(notice || prompt) && (
          <AuthAside
            framed
            {...(notice ? { notice } : {})}
            {...(prompt ? { prompt } : {})}
            promptValue={promptValue}
            onPromptValue={setPromptValue}
            onAnswerPrompt={answerPrompt}
            onCancel={cancel}
            {...(busyProvider && catalogEntry(busyProvider.id)?.codeSignIn?.enterprise
              ? {
                  enterprise: {
                    ...(enterpriseHost ? { host: enterpriseHost } : {}),
                    onUse: (host: string | null) => {
                      restart.current = { provider: busyProvider, host: host ?? undefined };
                      cancel();
                    },
                  },
                }
              : {})}
          />
        )}
        {expired && !notice && !prompt && (
          <CodeExpired
            framed
            providerId={expired.id}
            onNewCode={() => start(expired, "oauth", enterpriseHost)}
            onClose={() => setExpired(null)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The three choices of where the first mate lives (captain's approval of
 * INF-6207): equal cards in one row, each a button saying what happens
 * before it is pressed. Tab reaches each, the arrow keys move between them,
 * and Enter or Space opens one.
 */
function GateChoices({ onPick }: { onPick: (choice: GateChoice) => void }) {
  const row = useRef<HTMLDivElement>(null);
  const move = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const rtl = row.current ? getComputedStyle(row.current).direction === "rtl" : false;
    const step =
      event.key === "ArrowDown" || event.key === (rtl ? "ArrowLeft" : "ArrowRight")
        ? 1
        : event.key === "ArrowUp" || event.key === (rtl ? "ArrowRight" : "ArrowLeft")
          ? -1
          : 0;
    if (step === 0 || !row.current) return;
    const cards = [...row.current.querySelectorAll<HTMLButtonElement>("[data-gate-choice]")];
    const at = cards.indexOf(document.activeElement as HTMLButtonElement);
    const next = cards[(at + step + cards.length) % cards.length];
    if (!next) return;
    event.preventDefault();
    focusWithRing(next);
  };
  return (
    <div ref={row} className="fm-gate-choices" data-gate-choices="">
      {GATE_CHOICES.map((choice) => {
        const words = gateChoiceWords(choice);
        return (
          <button
            key={choice}
            type="button"
            className="fm-gate-choice"
            data-gate-choice={choice}
            onClick={() => onPick(choice)}
            onKeyDown={move}
          >
            <span className="fm-gate-choice-name">{words.name}</span>
            <span className="fm-gate-choice-line">{words.line}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Another computer, by commands (docs/run.md): install Infinitary there,
 * start it at boot, make a link, and paste that link in One already
 * running's paste box, which the last step opens.
 */
function CommandsRoute({ onPaste }: { onPaste: () => void }) {
  return (
    <div className="fm-connect-aside-frame fm-join-aside fm-gate-commands" data-gate-commands="">
      <p className="fm-join-head">{m.shellGateCommandsHead()}</p>
      <ol className="fm-gate-steps">
        <li>{m.shellGateCommandsInstall()}</li>
        <li>
          <span>{m.shellGateCommandsStart()}</span>
          <CommandLine text={GATE_COMMANDS.start} name="start" />
        </li>
        <li>
          <span>{m.shellGateCommandsLink()}</span>
          <CommandLine text={GATE_COMMANDS.link} name="link" />
        </li>
        <li>
          <span>{m.shellGateCommandsPaste()}</span>
          <Button variant="primary" size="sm" data-gate-paste="" onClick={onPaste}>
            {m.devicesJoinPasteChip()}
          </Button>
        </li>
      </ol>
      <p className="fm-join-sub fm-gate-mac">{m.shellGateCommandsMac({ path: MAC_COMMAND })}</p>
    </div>
  );
}

/** One command to run on the other computer, with its own Copy. */
function CommandLine({ text, name }: { text: string; name: string }) {
  const [copied, copy] = useCopied();
  return (
    <>
      <div className="fm-join-copy" data-gate-command={name}>
        <code className="fm-devices-link">{text}</code>
        <Button variant="secondary" size="sm" type="button" onClick={() => void copy(text)}>
          {copied === "copied" ? m.settingsDevicesCopied() : m.devicesJoinSetUpCopy()}
        </Button>
      </div>
      {copied === "failed" && <SettingError error={m.devicesJoinSetUpCopyFailed()} />}
    </>
  );
}
