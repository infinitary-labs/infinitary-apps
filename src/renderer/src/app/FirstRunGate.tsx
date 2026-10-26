import type { AccountView } from "@shared/accounts";
import type { FreshCheck } from "@shared/firstRun";
import type { AuthNotice, AuthPromptView, ProviderView } from "@shared/providers";
import { catalogEntry } from "@shared/providers";
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
import { JoinAnotherMac } from "../devices/JoinAnotherMac";
import { controlsAll, isView, leftLine } from "../devices/viewWords";
import {
  FRESH_CHECK_ACTION,
  FRESH_CHECK_PENDING,
  freshCheckFailure,
  freshCheckLine,
  freshCheckThere,
  freshCheckTitle,
  GATE_HOME_TITLE,
  GATE_STILL_NEEDS,
  GATE_TITLE,
  gateIntro,
  gateRecoveryTitle,
  gateRunLine,
  gateStaysOn,
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
 * Under the chips, a second group joins Firstmate on another Mac instead
 * (docs/view.md); after this app left one, a line says which. An app that
 * controls another Mac shows that Mac's gate with nothing to connect here:
 * sign-ins stay on the Mac where Firstmate lives. One that controls a first
 * mate a command started shows its chips, since nobody sits at that
 * computer to sign in (docs/run.md, "Control from another computer").
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
  // A view whose first mate signs in where it lives, not here.
  const there = view && !controlsAll(thisMac);
  const left = thisMac?.role === "home" ? thisMac.left : null;
  const [joining, setJoining] = useState(false);
  const open = firstRun?.gateOpen === true;
  const fresh = open ? firstRun?.freshCheck : undefined;
  // The caption stays mounted while it dissolves.
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setShown(true);
      return;
    }
    const id = window.setTimeout(() => setShown(false), 700);
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
    if (!shown || there) return;
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
  }, [shown, there, refresh]);

  // A provider that signs in either way asks which first; one way goes at once.
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

  if (!shown) return null;
  // While a sign-in is under way the band holds the display line and the
  // provider's own flow, nothing else: the caption's sentence and the row
  // return with the next choice. The band never reaches the input below.
  const connecting =
    methodChoice !== null ||
    busyProviderId !== null ||
    prompt !== null ||
    notice !== null ||
    expired !== null;
  const connectingName =
    methodChoice?.name ??
    expired?.name ??
    providers.find((entry) => entry.id === busyProviderId)?.name ??
    null;
  const busyProvider = providers.find((entry) => entry.id === busyProviderId);
  return (
    <div
      className="fm-gate"
      data-first-run-gate={open ? "open" : "closing"}
      data-open={open}
      data-sign-in-step={methodChoice || notice || prompt || expired ? "" : undefined}
    >
      <div className="fm-gate-inner">
        <p className="fm-gate-display" data-gate-title="">
          {fresh
            ? freshCheckTitle(fresh.label)
            : view
              ? GATE_TITLE
              : accounts.length > 0
                ? gateRecoveryTitle()
                : GATE_HOME_TITLE}
        </p>
        {!connecting && there && (
          <p className="fm-gate-sub">
            {fresh
              ? freshCheckThere(thisMac.name)
              : `Connect one on ${thisMac.name}, where your first mate lives.`}
          </p>
        )}
        {!connecting && view && !there && !fresh && (
          <p className="fm-gate-sub" data-run-line="">
            {gateRunLine(thisMac.name)}
          </p>
        )}
        {!connecting && !joining && !there && fresh && (
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
              pendingLabel={FRESH_CHECK_PENDING}
              onClick={() => checkAgain(fresh)}
            >
              {FRESH_CHECK_ACTION}
            </Button>
          </div>
        )}
        {!connecting && !joining && !view && !fresh && (
          <p className="fm-gate-sub" data-mac-choice="">
            {accounts.length > 0 ? (
              <>
                {GATE_STILL_NEEDS}
                <br />
                {gateStaysOn()}
              </>
            ) : (
              gateIntro()
            )}
          </p>
        )}
        {!connecting && !joining && !there && (
          <ProviderChips
            providers={providers}
            accounts={accounts}
            busyProviderId={busyProviderId}
            onConnect={connect}
            variant="stage"
          />
        )}
        {!connecting && !view && (
          <JoinAnotherMac
            onOpenChange={setJoining}
            note={
              left && (
                <p className="fm-join-left" data-left-mac={left.reason}>
                  {leftLine(left)}
                </p>
              )
            }
          />
        )}
        {connecting && connectingName && !methodChoice && !prompt && !notice && !expired && (
          <p className="fm-gate-sub" data-connecting={connectingName}>
            Connecting {connectingName}
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
