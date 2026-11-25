import type { AccountView } from "@shared/accounts";
import { isCustomApiProvider } from "@shared/customApi";
import * as m from "@shared/i18n/messages.generated";
import type { ProviderView } from "@shared/providers";
import { allowanceProviderOf, type QuotaProviderView } from "@shared/quota";
import {
  type DeviceSignInFlow,
  type DeviceSignIns,
  REMOTE_SIGN_IN_UPDATE_NOTE,
  returnsToLoopback,
  signInPlace,
} from "@shared/signIns";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import {
  AuthMethodChoice,
  CONNECT_CHIP_NOTES,
  connectMethods,
  ProviderChips,
} from "../accounts/ConnectChips";
import { RemoteCustomConnection, useHomeCustomDefinitions } from "../accounts/CustomApiConnections";
import { CustomApiDialog, CustomApiForm, deviceCustomClient } from "../accounts/CustomApiForm";
import "../accounts/customApi.css";
import { useShellStore } from "../app/store";
import type { RowMenuItem } from "../design";
import { Button, Input } from "../design";
import { useFirstMatePlace } from "../devices/useFirstMatePlace";
import { awayNote, DEVICE_SIGN_INS_WORDS, offersKeepGoing } from "./accountRows";
import { DeviceSignInWait, deviceSignInWaitLine } from "./DeviceSignInWait";
import { LABEL_GAP, ROW_GAP, SECTION_GAP } from "./settingRows";
import { useDeviceSignIns } from "./useDeviceSignIns";

/**
 * Settings -> Intelligence, grouped by device (design skill
 * `components/devices/SignInOnAMac`; docs/helper.md, "Its own sign-ins"):
 * under this Mac's own list, one group per computer that runs work, with
 * its own sign-ins, the allowance it read, and an "Add account" foot whose
 * chips start the sign-in there. The flow runs on that computer and is drawn
 * here, in the aside under its group; what the captain types goes to that
 * computer once and this window keeps it only while the box shows it.
 *
 * A computer that controls the first mate draws it the same way, for that
 * first mate's computers (docs/view.md, "Settings on a view").
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

export type Flow = DeviceSignInFlow;

export type DeviceAccountRowProps = {
  account: AccountView;
  /** The computer the account is on, named where the row's words say "this computer" (`signInPlace`'s `who`). */
  place: string;
  providerName: string;
  quotaRow?: QuotaProviderView;
  signingIn: boolean;
  signInOff?: string;
  onSignIn: () => void;
  menu: RowMenuItem[];
  /**
   * Its Keep going on credits switch, saved on that computer (docs/quota.md):
   * absent where its provider sells no credits. `updateNote` says why it is
   * dim while that computer's Infinitary cannot take it yet.
   */
  keepGoing?: { onSelect: () => void; updateNote?: string };
  /**
   * Its Use a saved reset item, Codex using it on that computer
   * (docs/codex-client.md): absent where its provider keeps none.
   * `updateNote` says why it is dim while that computer cannot take it yet.
   */
  savedReset?: { onSelect: () => void; updateNote?: string };
  /**
   * Its Use saved resets on their own item, saved on that computer
   * (docs/quota.md): absent where its provider keeps none. `updateNote`
   * says why it is dim while that computer cannot take it yet.
   */
  autoResets?: { onSelect: () => void; updateNote?: string };
  /**
   * Rename, Pause or Resume, and Prefer for crew work there, each saved on
   * that computer (docs/helper.md, "Its own sign-ins"). `updateNote` says
   * why they are dim while that computer's Infinitary cannot take them yet.
   */
  settings: {
    rename: (label: string) => Promise<unknown>;
    setEnabled: (enabled: boolean) => Promise<unknown>;
    togglePin: () => Promise<unknown>;
    updateNote?: string;
  };
};

/** Under a computer's label while it is not in reach: out of reach, or connecting while its connection is being made. */
export function OutOfReachNote({ device }: { device: DeviceSignIns }) {
  const note = awayNote(device);
  if (note === null) return null;
  return (
    <div
      style={{ ...MONO_NOTE_STYLE, marginBottom: "var(--space-2)" }}
      data-device-out-of-reach={device.reach === "connecting" ? "connecting" : ""}
    >
      {note}
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
  const home = useFirstMatePlace();
  const groups = useDeviceSignIns();
  // The home's own connections, for a computer's connection approved from one of them.
  const homeDefinitions = useHomeCustomDefinitions(groups.length > 0);
  const [choice, setChoice] = useState<{ deviceId: string; provider: ProviderView } | null>(null);
  const [customFor, setCustomFor] = useState<string | null>(null);

  useEffect(() => {
    onGroups?.(groups.length > 0);
  }, [groups.length, onGroups]);

  const start = useCallback(
    (deviceId: string, providerId: string, type: "oauth" | "api_key", accountId?: string) => {
      if (!groups.find((device) => device.deviceId === deviceId)?.flows) return;
      setChoice(null);
      void window.infinitary.devices.signIn(deviceId, providerId, type, accountId).catch(() => {});
    },
    [groups],
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
    if (device && device.reach !== "in-reach") {
      useShellStore.getState().clearPendingDeviceSignIn();
      return;
    }
    if (!device?.flows || !provider) return;
    useShellStore.getState().clearPendingDeviceSignIn();
    connect(device.deviceId, provider);
  }, [pending, groups, connect]);

  // A card's Use a saved reset lands here with that computer's account (`accountId@deviceId`).
  const pendingUse = useShellStore((s) => s.pendingUseSavedReset);
  useEffect(() => {
    const at = pendingUse?.lastIndexOf("@") ?? -1;
    if (!pendingUse || at <= 0) return;
    const deviceId = pendingUse.slice(at + 1);
    const device = groups.find((entry) => entry.deviceId === deviceId);
    if (!device) return;
    useShellStore.getState().clearPendingUseSavedReset();
    // One that cannot start (an older or unreachable computer) ends under the row, saying why.
    if (device.flows) applySavedReset(deviceId, pendingUse.slice(0, at));
  }, [pendingUse, groups]);

  // A run-out card's Use saved resets on their own lands here with that computer's account.
  const pendingAuto = useShellStore((s) => s.pendingUseSavedResets);
  useEffect(() => {
    const at = pendingAuto?.lastIndexOf("@") ?? -1;
    if (!pendingAuto || at <= 0) return;
    const deviceId = pendingAuto.slice(at + 1);
    const device = groups.find((entry) => entry.deviceId === deviceId);
    if (!device) return;
    useShellStore.getState().clearPendingUseSavedResets();
    if (device.reach === "in-reach" && device.autoSavedResets && device.flows)
      applyAutoResets(deviceId, pendingAuto.slice(0, at), true);
  }, [pendingAuto, groups]);

  const answer = (flow: Flow, value: string | null) => {
    const { signInId, prompt } = flow;
    if (!signInId || !prompt) return;
    void window.infinitary.devices.answerSignIn(signInId, prompt.promptId, value).catch(() => {});
  };
  const stop = (flow: Flow) => {
    void window.infinitary.devices.cancelSignIn(flow.signInId).catch(() => {});
  };

  if (groups.length === 0) return null;
  return (
    <>
      {groups.map((device) => {
        const place = signInPlace(device);
        // A saved reset's use runs beside a sign-in there, each under its own account's row.
        const flows = device.flows?.filter((entry) => entry.target === "account") ?? [];
        const flowOf = (anchor: string | undefined) =>
          flows.find((entry) => entry.accountId === anchor);
        const busy = flows.find((entry) => !entry.ended);
        const accounts = (device.signIns?.accounts ?? []).filter(
          (account) => !isCustomApiProvider(account.providerId),
        );
        const providers = device.signIns?.providers ?? [];
        const placeWords = { who: place.who, on: place.where };
        const customClient = deviceCustomClient(device.deviceId);
        const quotaRow = (account: AccountView) =>
          device.signIns?.quota?.providers.find((row) => row.accountId === account.id);
        const aside = (anchor: string | undefined) => {
          const flow = flowOf(anchor);
          return flow ? (
            <DeviceSignInAside
              flow={flow}
              providerName={providerName(flow.providerId)}
              place={place}
              onThisMac={device.onThisMac}
              key={`${flow.signInId}:${flow.prompt?.promptId ?? ""}`}
              onAnswer={(value) => answer(flow, value)}
              onStop={() => stop(flow)}
            />
          ) : null;
        };
        return (
          <section
            key={device.deviceId}
            data-device-sign-ins={device.deviceId}
            style={{ marginTop: SECTION_GAP }}
          >
            <div style={LABEL_STYLE}>{place.label}</div>
            <div style={{ ...LINE_STYLE, margin: `${LABEL_GAP} 0 ${ROW_GAP}` }}>
              {DEVICE_SIGN_INS_WORDS.own(place.where)}
            </div>
            {device.signIns ? (
              <OutOfReachNote device={device} />
            ) : (
              <DeviceSignInWait device={device} line={deviceSignInWaitLine(device, home.this)} />
            )}
            <div
              data-subscriptions-list={device.signIns || flows.length > 0 ? "" : undefined}
              style={
                device.signIns || flows.length > 0
                  ? {
                      background: "var(--bg-1)",
                      border: "1px solid var(--line-1)",
                      borderRadius: "var(--radius-m)",
                      overflow: "hidden",
                    }
                  : undefined
              }
            >
              {accounts.map((account) => {
                const row = quotaRow(account);
                const own = flowOf(account.id);
                return (
                  <div key={account.id}>
                    {renderRow({
                      account,
                      place: place.who,
                      providerName: providerName(account.providerId),
                      ...(row ? { quotaRow: row } : {}),
                      signingIn: !!own && !own.ended,
                      ...(!device.flows ? { signInOff: REMOTE_SIGN_IN_UPDATE_NOTE } : {}),
                      onSignIn: () =>
                        start(
                          device.deviceId,
                          account.providerId,
                          account.kind === "api_key" ? "api_key" : "oauth",
                          account.id,
                        ),
                      ...(offersKeepGoing(account)
                        ? {
                            keepGoing: {
                              onSelect: () =>
                                void window.infinitary.accounts
                                  .keepGoing(
                                    account.id,
                                    !account.keepGoingOnCredits,
                                    device.deviceId,
                                  )
                                  .catch(() => {}),
                              ...(device.keepGoing
                                ? {}
                                : { updateNote: m.settingsDevicesSignInsKeepGoingUpdate() }),
                            },
                          }
                        : {}),
                      ...(allowanceProviderOf(account.providerId) === "codex"
                        ? {
                            savedReset: {
                              onSelect: () => applySavedReset(device.deviceId, account.id),
                              ...(device.savedReset && device.flows
                                ? {}
                                : { updateNote: m.settingsDevicesSignInsKeepGoingUpdate() }),
                            },
                            autoResets: {
                              onSelect: () =>
                                applyAutoResets(
                                  device.deviceId,
                                  account.id,
                                  account.useSavedResets !== true,
                                ),
                              ...(device.autoSavedResets && device.flows
                                ? {}
                                : { updateNote: m.settingsDevicesSignInsKeepGoingUpdate() }),
                            },
                          }
                        : {}),
                      settings: {
                        rename: (label) =>
                          window.infinitary.accounts.rename(account.id, label, device.deviceId),
                        setEnabled: (enabled) =>
                          window.infinitary.accounts.setEnabled(
                            account.id,
                            enabled,
                            device.deviceId,
                          ),
                        togglePin: () =>
                          window.infinitary.accounts.pin(
                            account.providerId,
                            account.pinned ? null : account.id,
                            device.deviceId,
                          ),
                        ...(device.accountSettings
                          ? {}
                          : { updateNote: m.settingsDevicesSignInsKeepGoingUpdate() }),
                      },
                      menu: [
                        {
                          id: "disconnect",
                          label: m.settingsDevicesSignInsDisconnect(),
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
              {(device.signIns?.custom ?? []).map((view, _index, views) => (
                <RemoteCustomConnection
                  key={view.accountId}
                  view={view}
                  replaced={
                    view.home?.state === "changed" &&
                    views.some(
                      (other) =>
                        other !== view &&
                        other.home?.name === view.home?.name &&
                        other.home?.state === "current",
                    )
                  }
                  {...(view.home && homeDefinitions.has(view.home.name)
                    ? { homeDefinition: homeDefinitions.get(view.home.name) }
                    : {})}
                  client={customClient}
                  place={placeWords}
                  onDisconnect={(accountId) =>
                    void window.infinitary.devices
                      .signOut(device.deviceId, accountId)
                      .catch(() => {})
                  }
                  onSetEnabled={(accountId, enabled) =>
                    void window.infinitary.accounts
                      .setEnabled(accountId, enabled, device.deviceId)
                      .catch(() => {})
                  }
                  {...(device.accountSettings
                    ? {}
                    : { pauseOff: m.settingsDevicesSignInsKeepGoingUpdate() })}
                />
              ))}
              {device.signIns && accounts.length === 0 && !device.signIns.custom?.length && (
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
                  {DEVICE_SIGN_INS_WORDS.none}
                </div>
              )}
              {device.signIns && (
                <div className="fm-subs-add">
                  <span style={LABEL_STYLE}>{m.settingsDevicesSignInsAddAccount()}</span>
                  <ProviderChips
                    providers={device.reach === "in-reach" ? providers : []}
                    accounts={accounts}
                    busyProviderId={busy ? busy.providerId : null}
                    signInOff={!device.flows ? REMOTE_SIGN_IN_UPDATE_NOTE : undefined}
                    onConnect={(provider) => connect(device.deviceId, provider)}
                    variant="foot"
                    place="there"
                    custom={
                      device.reach === "in-reach"
                        ? device.customApi
                          ? { onOpen: () => setCustomFor(device.deviceId) }
                          : { note: CONNECT_CHIP_NOTES.updateThere }
                        : undefined
                    }
                  />
                </div>
              )}
              {device.signIns && !device.flows && <SignInNeedsUpdate />}
              {device.flows && choice?.deviceId === device.deviceId && (
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
                label={m.settingsDevicesSignInsCustomApi({ where: place.where })}
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

/** A newer view does not fall back to reconstructing steps from an older home. */
export function SignInNeedsUpdate() {
  return (
    <p style={{ ...LINE_STYLE, paddingInline: "var(--space-4)" }}>{REMOTE_SIGN_IN_UPDATE_NOTE}</p>
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
  onAnswer: (value: string | null) => void;
  onStop: () => void;
}) {
  const home = useFirstMatePlace();
  // Callers key this aside by the sign-in and prompt. Leaving the box,
  // ending the flow or answering it destroys its draft, never publishing it.
  const [typed, setTyped] = useState("");
  const { prompt, notice, ended, link } = flow;
  const openLink = link
    ? () => void window.infinitary.app.openExternal(link).catch(() => {})
    : undefined;
  const stopButton = (
    <Button variant="ghost" size="sm" onClick={onStop}>
      {ended ? m.settingsDevicesDone() : m.settingsDevicesCancel()}
    </Button>
  );
  let body: React.ReactNode;
  if (ended?.outcome === "signs-in-there") {
    body = (
      <>
        <div style={LINE_STYLE}>{m.settingsDevicesSignInsClaudeCode({ where: place.where })}</div>
        <div style={{ display: "flex", gap: 8 }}>{stopButton}</div>
      </>
    );
  } else if (ended) {
    body = (
      <>
        <div style={{ ...LINE_STYLE, color: "var(--danger)" }} role="alert">
          {ended.error ??
            m.settingsDevicesSignInsFailed({ who: place.who, provider: providerName })}
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
    const code = prompt.kind === "manual_code" || (prompt.kind !== "secret" && openLink);
    const asked = !code ? "key" : returnsToLoopback(link) ? "address" : "code";
    body = (
      <>
        <div style={LINE_STYLE}>
          {asked === "key"
            ? anArticle(providerName)
              ? m.settingsDevicesSignInsPasteKeyAn({ provider: providerName, who: place.who })
              : m.settingsDevicesSignInsPasteKeyA({ provider: providerName, who: place.who })
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
              {m.settingsDevicesSignInsOpenLink()}
            </Button>
          )}
          <div style={{ flex: 1, minWidth: 200 }}>
            <Input
              mono
              type="password"
              value={typed}
              placeholder={
                asked === "key"
                  ? m.settingsDevicesSignInsPasteYourKey()
                  : asked === "address"
                    ? m.settingsDevicesSignInsPasteAddress()
                    : m.settingsDevicesSignInsPasteCode()
              }
              onChange={(event) => setTyped(event.target.value)}
              autoFocus
              aria-label={
                asked === "key"
                  ? m.settingsDevicesSignInsKeyFor({ who: place.who })
                  : asked === "address"
                    ? m.settingsDevicesSignInsAddressFor({ who: place.who })
                    : m.settingsDevicesSignInsCodeFor({ who: place.who })
              }
            />
          </div>
          <Button variant="primary" size="sm" type="submit" disabled={!typed}>
            {m.settingsDevicesSignInsSendTo({ who: place.who })}
          </Button>
          {stopButton}
        </form>
        <div style={MONO_NOTE_STYLE}>
          {m.settingsDevicesSignInsGoesOnce({ who: place.who, home: home.This })}
        </div>
      </>
    );
  } else if (notice?.kind === "device_code" && notice.userCode) {
    body = (
      <>
        <div style={LINE_STYLE}>{m.settingsDevicesSignInsEnterCode({ who: place.who })}</div>
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
              {m.settingsDevicesSignInsOpenLink()}
            </Button>
          )}
          {stopButton}
        </div>
        <div style={MONO_NOTE_STYLE}>{m.settingsDevicesSignInsWaiting()}</div>
      </>
    );
  } else {
    body = (
      <>
        <div style={LINE_STYLE}>
          {m.settingsDevicesSignInsSigningIn({ who: place.who, provider: providerName })}
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
        {m.settingsDevicesSignInsTitle({ provider: providerName, where: place.where })}
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
/**
 * Uses one saved reset of that computer's own account there
 * (docs/codex-client.md). Codex there signs in on the row first when it
 * must; a refusal stays under the row as the flow's end, and the feed says
 * what it came to.
 */
function applySavedReset(deviceId: string, accountId: string): void {
  void window.infinitary.accounts
    .redeemSavedReset(accountId, { deviceId, signIn: true })
    .catch(() => {});
}

/**
 * Turns that computer's own account's Use saved resets on their own on or
 * off there (docs/quota.md). Turning it on lets Codex there sign in on the
 * row first when it must; a refusal stays under the row as the flow's end.
 */
function applyAutoResets(deviceId: string, accountId: string, on: boolean): void {
  void window.infinitary.accounts
    .setUseSavedResets(accountId, on, { deviceId, ...(on ? { signIn: true } : {}) })
    .catch(() => {});
}

function pasteBackLine(asked: "code" | "address", who: string, onThisMac: boolean): string {
  if (asked === "code") return m.settingsDevicesSignInsPasteBackCode();
  return onThisMac
    ? m.settingsDevicesSignInsPasteBackHere({ who })
    : m.settingsDevicesSignInsPasteBackAddress();
}

/** Whether English writes "an" before the provider's name. */
function anArticle(word: string): boolean {
  return /^[aeiou]/i.test(word);
}
