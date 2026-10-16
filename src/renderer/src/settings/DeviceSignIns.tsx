import type { AccountView } from "@shared/accounts";
import { isCustomApiProvider } from "@shared/customApi";
import type { AuthNotice, AuthPromptView, ProviderView } from "@shared/providers";
import type { QuotaProviderView } from "@shared/quota";
import {
  type DeviceSignIns,
  returnsToLoopback,
  type SignInStep,
  signInPlace,
} from "@shared/signIns";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import {
  AuthMethodChoice,
  CUSTOM_API_UPDATE_THERE_NOTE,
  connectMethods,
  ProviderChips,
} from "../accounts/ConnectChips";
import {
  type CustomApiClient,
  CustomApiDialog,
  CustomApiForm,
  RemoteCustomConnection,
} from "../accounts/CustomApiForm";
import "../accounts/customApi.css";
import { HERE } from "@shared/deviceNames";
import { useShellStore } from "../app/store";
import type { RowMenuItem } from "../design";
import { Button, Input } from "../design";
import { awayWord } from "./devicesWords";
import { LABEL_GAP, ROW_GAP, SECTION_GAP } from "./settingRows";

/**
 * Settings -> Intelligence, grouped by device (design skill
 * `components/devices/SignInOnAMac`; docs/helper.md, "Its own sign-ins"):
 * under this Mac's own list, one group per computer that runs work, with
 * its own sign-ins, the allowance it read, and an "Add account" foot whose
 * chips start the sign-in there. The flow runs on that computer and is drawn
 * here, in the aside under its group; what the captain types goes to that
 * computer once and this window keeps it only while the box shows it.
 *
 * Nothing here draws on a Mac that controls another (`inf:devices:shown`).
 */

const LABEL_STYLE = {
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--fg-3)",
} as const;

const LINE_STYLE = { fontSize: "var(--text-sm)", color: "var(--fg-2)" } as const;
const MONO_NOTE_STYLE = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
} as const;

/** One sign-in running on a computer, as this window draws it. */
export type Flow = {
  /** Null until the computer has said it started. */
  signInId: string | null;
  deviceId: string;
  providerId: string;
  accountId?: string;
  notice?: AuthNotice;
  prompt?: AuthPromptView;
  /** The link to open, kept once the flow has named one. */
  link?: string;
  ended?: Extract<SignInStep, { kind: "ended" }>;
  /** Why it could not start. */
  refused?: string;
  /** What is typed in its box, kept only while its box shows it. */
  typed?: string;
};

export type DeviceAccountRowProps = {
  account: AccountView;
  providerName: string;
  quotaRow?: QuotaProviderView;
  signingIn: boolean;
  onSignIn: () => void;
  menu: RowMenuItem[];
};

/** Under a computer's label while it is not in reach: out of reach, or connecting while its connection is being made. */
export function OutOfReachNote({ device }: { device: DeviceSignIns }) {
  if (device.inReach) return null;
  return (
    <div
      style={{ ...MONO_NOTE_STYLE, marginBottom: "var(--space-2)" }}
      data-device-out-of-reach={device.connecting ? "connecting" : ""}
    >
      {awayWord(device.connecting)}
      {device.asOf ? ` · as of ${timeOf(device.asOf)}` : ""}
    </div>
  );
}

/** The computer groups, below this Mac's own list; nothing while there are none. */
export function DeviceSignInGroups({
  providerName,
  renderRow,
  onGroups,
}: {
  providerName: (providerId: string) => string;
  /** This Mac's own account row, drawn for an account on a computer. */
  renderRow: (props: DeviceAccountRowProps) => React.ReactNode;
  /** Whether any group draws, so this Mac's list takes its own label. */
  onGroups?: (any: boolean) => void;
}) {
  const [shown, setShown] = useState(false);
  const [devices, setDevices] = useState<DeviceSignIns[]>([]);
  const [flows, setFlows] = useState<Record<string, Flow>>({});
  const [choice, setChoice] = useState<{ deviceId: string; provider: ProviderView } | null>(null);
  const [customFor, setCustomFor] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.infinitary.devices
      .shown()
      .then(({ shown: offered }) => {
        if (!live || !offered) return;
        setShown(true);
        void window.infinitary.devices.signIns().then((next) => live && setDevices(next));
      })
      .catch(() => {});
    const offDevices = window.infinitary.devices.onSignIns((next) => setDevices(next));
    const offStep = window.infinitary.devices.onSignIn((event) => {
      setFlows((current) => {
        const flow =
          Object.values(current).find((entry) => entry.signInId === event.signInId) ??
          // A step can come before the start's own answer.
          (current[event.deviceId]?.signInId === null &&
          current[event.deviceId]?.providerId === event.providerId
            ? current[event.deviceId]
            : undefined);
        if (!flow) return current;
        const next: Flow = { ...flow, signInId: event.signInId };
        const { step } = event;
        if (step.kind === "notice") {
          next.notice = step.notice;
          if (step.notice.url) next.link = step.notice.url;
        } else if (step.kind === "prompt") {
          // Its own new question empties its box; another computer's never does.
          next.prompt = step.prompt;
          delete next.typed;
        } else {
          next.ended = step;
          delete next.prompt;
          delete next.typed;
        }
        // Signed in or stopped: the group's new row, or nothing, says it.
        if (
          step.kind === "ended" &&
          (step.outcome === "signed-in" || step.outcome === "cancelled")
        ) {
          const rest = { ...current };
          delete rest[flow.deviceId];
          return rest;
        }
        return { ...current, [flow.deviceId]: next };
      });
    });
    return () => {
      live = false;
      offDevices();
      offStep();
    };
  }, []);

  const groups = shown ? devices : [];
  useEffect(() => {
    onGroups?.(groups.length > 0);
  }, [groups.length, onGroups]);

  const start = useCallback(
    (deviceId: string, providerId: string, type: "oauth" | "api_key", accountId?: string) => {
      setChoice(null);
      setFlows((current) => {
        const running = current[deviceId]?.signInId;
        // One sign-in at a time on a computer: a new one stops the last.
        if (running) void window.infinitary.devices.cancelSignIn(running).catch(() => {});
        return {
          ...current,
          [deviceId]: { signInId: null, deviceId, providerId, ...(accountId ? { accountId } : {}) },
        };
      });
      void window.infinitary.devices
        .signIn(deviceId, providerId, type, accountId)
        .then(({ signInId }) =>
          setFlows((current) =>
            current[deviceId]?.providerId === providerId && current[deviceId]?.signInId === null
              ? { ...current, [deviceId]: { ...current[deviceId], signInId } }
              : current,
          ),
        )
        .catch((caught: unknown) =>
          setFlows((current) => ({
            ...current,
            [deviceId]: {
              signInId: null,
              deviceId,
              providerId,
              refused: caught instanceof Error ? caught.message : String(caught),
            },
          })),
        );
    },
    [],
  );

  const connect = useCallback(
    (deviceId: string, provider: ProviderView) => {
      const methods = connectMethods(provider);
      if (methods.length > 1) {
        setChoice({ deviceId, provider });
        return;
      }
      start(deviceId, provider.id, methods[0] ?? "api_key");
    },
    [start],
  );

  // Firstmate's card lands here with the sign-in to start (docs/helper.md).
  const pending = useShellStore((s) => s.pendingDeviceSignIn);
  useEffect(() => {
    if (!pending) return;
    const device = groups.find((entry) => entry.deviceId === pending.deviceId);
    const provider = device?.signIns?.providers.find((entry) => entry.id === pending.providerId);
    if (!device || !provider) return;
    useShellStore.getState().clearPendingDeviceSignIn();
    connect(device.deviceId, provider);
  }, [pending, groups, connect]);

  const answer = (flow: Flow, value: string | null) => {
    const { signInId, prompt } = flow;
    if (!signInId || !prompt) return;
    setFlows((current) => {
      const now = current[flow.deviceId];
      if (!now) return current;
      const next = { ...now };
      delete next.prompt;
      delete next.typed;
      return { ...current, [flow.deviceId]: next };
    });
    void window.infinitary.devices.answerSignIn(signInId, prompt.promptId, value).catch(() => {});
  };
  const typeFor = (deviceId: string, value: string) =>
    setFlows((current) => {
      const now = current[deviceId];
      return now ? { ...current, [deviceId]: { ...now, typed: value } } : current;
    });
  const stop = (flow: Flow) => {
    if (flow.signInId) void window.infinitary.devices.cancelSignIn(flow.signInId).catch(() => {});
    setFlows((current) => {
      const rest = { ...current };
      delete rest[flow.deviceId];
      return rest;
    });
  };

  if (groups.length === 0) return null;
  return (
    <>
      {groups.map((device) => {
        const place = signInPlace(device);
        const flow = flows[device.deviceId];
        const accounts = (device.signIns?.accounts ?? []).filter(
          (account) => !isCustomApiProvider(account.providerId),
        );
        const providers = device.signIns?.providers ?? [];
        const placeWords = { who: place.who, on: place.where };
        const customClient: CustomApiClient = {
          profiles: () => window.infinitary.devices.custom.profiles(device.deviceId),
          address: (baseUrl) => window.infinitary.devices.custom.address(device.deviceId, baseUrl),
          connect: (input) => window.infinitary.devices.custom.connect(device.deviceId, input),
          check: (draftId, modelId) =>
            window.infinitary.devices.custom.check(device.deviceId, draftId, modelId),
          save: (draftId, paused) =>
            window.infinitary.devices.custom.save(device.deviceId, draftId, paused),
          cancel: (draftId) => window.infinitary.devices.custom.cancel(device.deviceId, draftId),
          review: (baseUrl, mode, pem) =>
            window.infinitary.devices.custom.review(device.deviceId, baseUrl, mode, pem),
        };
        const quotaRow = (account: AccountView) =>
          device.signIns?.quota?.providers.find((row) => row.accountId === account.id);
        const aside = (anchor: string | undefined) =>
          flow && flow.accountId === anchor ? (
            <DeviceSignInAside
              flow={flow}
              providerName={providerName(flow.providerId)}
              place={place}
              onThisMac={device.onThisMac}
              typed={flow.typed ?? ""}
              onTyped={(value) => typeFor(flow.deviceId, value)}
              onAnswer={(value) => answer(flow, value)}
              onStop={() => stop(flow)}
            />
          ) : null;
        return (
          <section
            key={device.deviceId}
            data-device-sign-ins={device.deviceId}
            style={{ marginTop: SECTION_GAP }}
          >
            <div style={LABEL_STYLE}>{place.label}</div>
            <div style={{ ...LINE_STYLE, margin: `${LABEL_GAP} 0 ${ROW_GAP}` }}>
              Its own sign-ins. A task that runs {place.where} uses only these.
            </div>
            <OutOfReachNote device={device} />
            <div
              data-subscriptions-list
              style={{
                background: "var(--bg-1)",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--radius-m)",
                overflow: "hidden",
              }}
            >
              {accounts.map((account) => {
                const row = quotaRow(account);
                return (
                  <div key={account.id}>
                    {renderRow({
                      account,
                      providerName: providerName(account.providerId),
                      ...(row ? { quotaRow: row } : {}),
                      signingIn: flow?.accountId === account.id && !flow.ended,
                      onSignIn: () =>
                        start(
                          device.deviceId,
                          account.providerId,
                          account.kind === "api_key" ? "api_key" : "oauth",
                          account.id,
                        ),
                      menu: [
                        {
                          id: "disconnect",
                          label: "Disconnect",
                          tone: "danger",
                          onSelect: () =>
                            void window.infinitary.devices
                              .signOut(device.deviceId, account.id)
                              .catch(() => {}),
                        },
                      ],
                    })}
                    {aside(account.id)}
                  </div>
                );
              })}
              {(device.signIns?.custom ?? []).map((view) => (
                <RemoteCustomConnection
                  key={view.accountId}
                  view={view}
                  client={customClient}
                  place={placeWords}
                  onDisconnect={(accountId) =>
                    void window.infinitary.devices
                      .signOut(device.deviceId, accountId)
                      .catch(() => {})
                  }
                />
              ))}
              {accounts.length === 0 && !device.signIns?.custom?.length && (
                <div
                  className="fm-subs-row"
                  data-device-no-sign-ins=""
                  style={{
                    display: "block",
                    minHeight: 0,
                    color: "var(--fg-3)",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  {device.unanswered
                    ? `${place.who} did not say what it is signed in to. It may need ${HERE.this}'s version of Infinitary.`
                    : "No sign-ins yet."}
                </div>
              )}
              {device.signIns && (
                <div className="fm-subs-add">
                  <span style={LABEL_STYLE}>Add account</span>
                  <ProviderChips
                    providers={device.inReach ? providers : []}
                    accounts={accounts}
                    busyProviderId={flow && !flow.ended && !flow.refused ? flow.providerId : null}
                    onConnect={(provider) => connect(device.deviceId, provider)}
                    variant="foot"
                    place="there"
                    custom={
                      device.inReach
                        ? device.customApi
                          ? { onOpen: () => setCustomFor(device.deviceId) }
                          : { note: CUSTOM_API_UPDATE_THERE_NOTE }
                        : undefined
                    }
                  />
                </div>
              )}
              {choice?.deviceId === device.deviceId && (
                <AuthMethodChoice
                  provider={choice.provider}
                  onPick={(type) => start(device.deviceId, choice.provider.id, type)}
                  onCancel={() => setChoice(null)}
                />
              )}
              {aside(undefined)}
            </div>
            {customFor === device.deviceId && (
              <CustomApiDialog
                label={`Add a custom API ${place.where}`}
                onClose={() => setCustomFor(null)}
              >
                <CustomApiForm
                  client={customClient}
                  place={placeWords}
                  onClose={() => setCustomFor(null)}
                />
              </CustomApiDialog>
            )}
          </section>
        );
      })}
    </>
  );
}

/**
 * One sign-in on a computer, in the shapes `ConnectChips` already uses: a
 * code to read, a code or the address the browser ends on to paste back, or
 * a key; then how it ended. Under a box that takes typing, the line that says
 * where it goes.
 */
export function DeviceSignInAside({
  flow,
  providerName,
  place,
  onThisMac = false,
  typed,
  onTyped,
  onAnswer,
  onStop,
}: {
  flow: Flow;
  providerName: string;
  place: ReturnType<typeof signInPlace>;
  /**
   * Another user on this Mac, whose sign-in a browser coming back to this
   * Mac reaches (`returnsToLoopback`); another Mac's never does.
   */
  onThisMac?: boolean;
  typed: string;
  onTyped: (value: string) => void;
  onAnswer: (value: string | null) => void;
  onStop: () => void;
}) {
  const { prompt, notice, ended, link } = flow;
  const openLink = link
    ? () => void window.infinitary.app.openExternal(link).catch(() => {})
    : undefined;
  const stopButton = (
    <Button variant="ghost" size="sm" onClick={onStop}>
      {ended || flow.refused ? "Done" : "Cancel"}
    </Button>
  );
  let body: React.ReactNode;
  if (flow.refused) {
    body = (
      <>
        <div style={{ ...LINE_STYLE, color: "var(--danger)" }} role="alert">
          {flow.refused}
        </div>
        <div style={{ display: "flex", gap: 8 }}>{stopButton}</div>
      </>
    );
  } else if (ended?.outcome === "signs-in-there") {
    body = (
      <>
        <div style={LINE_STYLE}>
          Claude Code signs in {place.where} itself. Log in to it there once, and Infinitary uses
          that login.
        </div>
        <div style={{ display: "flex", gap: 8 }}>{stopButton}</div>
      </>
    );
  } else if (ended) {
    body = (
      <>
        <div style={{ ...LINE_STYLE, color: "var(--danger)" }} role="alert">
          {ended.error ?? `${place.who} could not sign in to ${providerName}.`}
        </div>
        <div style={{ display: "flex", gap: 8 }}>{stopButton}</div>
      </>
    );
  } else if (prompt?.kind === "select" && prompt.options) {
    body = (
      <>
        <div style={LINE_STYLE}>{prompt.message}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {prompt.options.map((option) => (
            <Button
              key={option.id}
              variant="secondary"
              size="sm"
              onClick={() => onAnswer(option.id)}
            >
              {option.label}
            </Button>
          ))}
          {stopButton}
        </div>
      </>
    );
  } else if (prompt) {
    // A code to paste back after the browser, or a key.
    const code = prompt.kind === "manual_code" || (prompt.kind !== "secret" && openLink);
    const asked = !code ? "key" : returnsToLoopback(link) ? "address" : "code";
    body = (
      <>
        <div style={LINE_STYLE}>
          {asked === "key"
            ? `Paste ${article(providerName)} ${providerName} API key for ${place.who}.`
            : pasteBackLine(asked, place.who, onThisMac)}
        </div>
        <form
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
          onSubmit={(event: React.FormEvent) => {
            event.preventDefault();
            if (typed) onAnswer(typed);
          }}
        >
          {code && openLink && (
            <Button variant="secondary" size="sm" onClick={openLink}>
              Open the link
            </Button>
          )}
          <div style={{ flex: 1, minWidth: 200 }}>
            <Input
              mono
              type="password"
              value={typed}
              placeholder={asked === "key" ? "paste your key" : `paste the ${asked}`}
              onChange={(event) => onTyped(event.target.value)}
              autoFocus
              aria-label={`The ${asked} for ${place.who}`}
            />
          </div>
          <Button variant="primary" size="sm" type="submit" disabled={!typed}>
            Send to {place.who}
          </Button>
          {stopButton}
        </form>
        <div style={MONO_NOTE_STYLE}>
          It goes to {place.who} once. {HERE.This} keeps no copy.
        </div>
      </>
    );
  } else if (notice?.kind === "device_code" && notice.userCode) {
    body = (
      <>
        <div style={LINE_STYLE}>
          Open the link in your browser here and enter this code. {place.who} finishes the sign-in
          itself.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span
            data-device-sign-in-code=""
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--fg-1)",
              letterSpacing: "0.12em",
              background: "var(--bg-3)",
              borderRadius: "var(--radius-s)",
              padding: "var(--space-1) var(--space-2)",
            }}
          >
            {notice.userCode}
          </span>
          {openLink && (
            <Button variant="primary" size="sm" onClick={openLink}>
              Open the link
            </Button>
          )}
          {stopButton}
        </div>
        <div style={MONO_NOTE_STYLE}>waiting for you to finish in the browser</div>
      </>
    );
  } else {
    body = (
      <>
        <div style={LINE_STYLE}>
          {place.who} is signing in to {providerName}.
        </div>
        <div style={{ display: "flex", gap: 8 }}>{stopButton}</div>
      </>
    );
  }
  return (
    <div
      className="fm-connect-aside"
      data-device-sign-in={flow.deviceId}
      data-device-sign-in-provider={flow.providerId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        padding: "var(--space-3) var(--space-4)",
      }}
    >
      <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
        Sign in to {providerName} {place.where}
      </div>
      {body}
    </div>
  );
}

/**
 * What to paste back after the browser. A browser sent back to this Mac
 * lands where another Mac's sign-in does not wait, so the page cannot be
 * reached and its address is what to paste; another user here gets it itself.
 */
function pasteBackLine(asked: "code" | "address", who: string, onThisMac: boolean): string {
  const open = "Open the link in your browser here and sign in.";
  if (asked === "code") return `${open} Then paste the code it shows.`;
  return onThisMac
    ? `${open} ${who} finishes the sign-in itself when your browser comes back. If the page your browser ends on cannot be reached, copy its address and paste it here.`
    : `${open} Your browser then ends on a page that cannot be reached. Copy that page's address and paste it here.`;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
