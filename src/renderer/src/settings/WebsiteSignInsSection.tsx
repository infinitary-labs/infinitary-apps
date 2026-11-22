import type { ThisMac } from "@shared/devices";
import { formatDate } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { SECRETS_WORDS } from "@shared/secrets";
import {
  ASK_EACH_TIME_LABEL,
  AUTOMATIC_SIGN_IN_NOTICE,
  type SavedSignIn,
  type SavedSignInsView,
  SIGN_IN_RULE_LABEL,
  USE_WITHOUT_ASKING_LABEL,
} from "@shared/taskBrowser";
import { useCallback, useEffect, useState } from "react";
import { useShellStore } from "../app/store";
import { Button } from "../design";
import { useFirstMatePlace, useHereAs } from "../devices/useFirstMatePlace";
import { isView } from "../devices/viewWords";
import "./secrets.css";
import { ROW_GAP, SECTION_GAP, SectionLabel, SettingError } from "./settingRows";

/**
 * The signed-in sites each computer keeps for task browsers
 * (docs/task-browser.md, "Signed-in sites"; the design skill's
 * `components/cards/TaskBrowser`, "Signed-in sites"): one row per site, with
 * when the captain signed in, the rule for later tasks and Remove, this
 * Mac's first, then one list per computer that runs work. Shown only where
 * this Mac keeps task browsers, so a host with no browser engine draws
 * nothing here.
 *
 * It sits last in Settings → Secrets wherever this window offers that tab,
 * and stays in General where it does not: a build without protected storage,
 * or a computer that controls another (`signInsInSecrets`).
 */

/**
 * Whether the section lives in Secrets: this build keeps protected storage
 * and this window is the first mate's own, the same two facts that offer the
 * Secrets tab (the built-in Secrets section's gate and `showsSection`).
 */
export function signInsInSecrets(secretsShown: boolean, thisMac: ThisMac | null): boolean {
  return secretsShown && !isView(thisMac);
}

export function useSignInsInSecrets(): boolean {
  return useShellStore((s) => signInsInSecrets(s.secretsShown, s.thisMac));
}

/** "signed in today", "signed in yesterday" or "signed in Oct 1": when the captain signed in. */
export function savedWhen(at: number, now: number): string {
  const date = new Date(at);
  const day = new Date(now);
  if (date.toDateString() === day.toDateString()) return m.settingsWebsiteSignInsSavedToday();
  day.setDate(day.getDate() - 1);
  if (date.toDateString() === day.toDateString()) return m.settingsWebsiteSignInsSavedYesterday();
  return m.settingsWebsiteSignInsSavedOn({
    date: formatDate(date, { month: "short", day: "numeric" }),
  });
}

export const WEBSITE_SIGN_INS_WORDS = {
  get lead() {
    return m.settingsWebsiteSignInsLead();
  },
  get empty() {
    return m.settingsWebsiteSignInsEmpty();
  },
} as const;

/** Where a signed-in site is kept: this Mac, or a computer that runs work by its id. */
export type SignInPlace = { deviceId?: string };

function SignInList({
  label,
  signIns,
  inSecrets,
  empty,
  now,
  busy,
  onRemove,
  onAutomatic,
}: {
  label: string;
  signIns: readonly SavedSignIn[];
  inSecrets: boolean;
  empty: string;
  now: number;
  busy: (site: string) => boolean;
  onRemove: (site: string) => void;
  onAutomatic: (signIn: SavedSignIn, automatic: boolean) => void;
}) {
  return (
    <ul
      aria-label={label}
      className={inSecrets ? "fm-settings-list fm-site-list" : undefined}
      style={
        inSecrets
          ? undefined
          : {
              listStyle: "none",
              margin: 0,
              padding: 0,
              background: "var(--bg-1)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-m)",
              overflow: "hidden",
            }
      }
    >
      {signIns.length === 0 ? (
        <li
          data-website-sign-ins-empty=""
          style={{
            padding: "var(--space-3) var(--space-4)",
            fontSize: "var(--text-sm)",
            color: "var(--fg-3)",
          }}
        >
          {empty}
        </li>
      ) : (
        signIns.map((signIn, index) => {
          const name = <span className="fm-site-name">{signIn.site}</span>;
          const saved = (
            <span className="fm-site-saved" data-website-sign-in-saved="">
              {savedWhen(signIn.savedAt, now)}
            </span>
          );
          const rule = signIn.automatic ? USE_WITHOUT_ASKING_LABEL : ASK_EACH_TIME_LABEL;
          const controls = (
            <>
              <label
                className="fm-site-select"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  fontSize: "var(--text-xs)",
                  color: "var(--fg-2)",
                }}
              >
                {SIGN_IN_RULE_LABEL}
                <select
                  data-website-sign-in-rule=""
                  value={signIn.automatic ? "automatic" : "ask"}
                  disabled={!signIn.id || busy(signIn.site)}
                  onChange={(event) => onAutomatic(signIn, event.target.value === "automatic")}
                  style={{
                    font: "inherit",
                    color: "var(--fg-1)",
                    background: "var(--bg-2)",
                    border: "1px solid var(--line-2)",
                    borderRadius: "var(--radius-s)",
                    padding: "var(--space-1) var(--space-2)",
                  }}
                >
                  <option value="ask">{ASK_EACH_TIME_LABEL}</option>
                  <option value="automatic">{USE_WITHOUT_ASKING_LABEL}</option>
                </select>
              </label>
              <Button
                variant="secondary"
                size="sm"
                pending={busy(signIn.site)}
                onClick={() => onRemove(signIn.site)}
              >
                {m.settingsWebsiteSignInsRemove()}
              </Button>
            </>
          );
          return (
            <li
              key={signIn.site}
              data-website-sign-in={signIn.site}
              className={inSecrets ? undefined : "fm-site-controls fm-site-general"}
              style={!inSecrets && index > 0 ? { borderTop: "1px solid var(--line-1)" } : undefined}
            >
              {inSecrets ? (
                <details>
                  <summary className="fm-settings-list-line">
                    <span className="fm-site-identity">
                      {name}
                      {saved}
                    </span>
                    <span className="fm-site-rule">{rule}</span>
                  </summary>
                  <div className="fm-site-controls fm-settings-list-body">{controls}</div>
                </details>
              ) : (
                <>
                  {name}
                  {saved}
                  {controls}
                </>
              )}
            </li>
          );
        })
      )}
    </ul>
  );
}

/** The busy mark of a computer's Remove all, beside the sites a Remove or rule marks. */
const EVERY_SITE = "*";

/**
 * A computer's Remove all, under its list: it signs that computer out of
 * every site, listed or not, so it shows with an empty list too.
 */
function RemoveAll({
  computer,
  busy,
  onRemoveAll,
}: {
  computer: string;
  busy: boolean;
  onRemoveAll: () => void;
}) {
  return (
    <div
      data-website-sign-ins-remove-all=""
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        marginTop: "var(--space-2)",
      }}
    >
      <span style={{ flex: 1, fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
        {m.settingsWebsiteSignInsRemoveAllHint({ computer })}
      </span>
      <Button variant="secondary" size="sm" pending={busy} onClick={onRemoveAll}>
        {m.settingsWebsiteSignInsRemoveAll()}
      </Button>
    </div>
  );
}

export function WebsiteSignInsSectionView({
  view,
  now,
  removing,
  error,
  onRemove,
  onAutomatic,
  onRemoveAll,
  inSecrets = false,
}: {
  view: SavedSignInsView | null;
  now: number;
  /** The site whose Remove or rule is on its way, and the computer that keeps it. */
  removing: (SignInPlace & { site: string }) | null;
  error: string | null;
  onRemove: (site: string, place: SignInPlace) => void;
  onAutomatic?: (signIn: SavedSignIn, automatic: boolean, place: SignInPlace) => void;
  /** Remove all on one computer: it signs out of every site, listed or not. */
  onRemoveAll?: (place: SignInPlace) => void;
  /** Shown in Secrets, where the lead also names the sign-ins' own storage. */
  inSecrets?: boolean;
}) {
  const here = useHereAs();
  const place = useFirstMatePlace();
  if (!view?.available) return null;
  const computers = view.computers ?? [];
  const busy =
    (deviceId?: string) =>
    (site: string): boolean =>
      removing?.site === site && removing.deviceId === deviceId;
  const any = view.signIns.length > 0 || computers.some((one) => one.signIns.length > 0);
  const label = inSecrets ? SECRETS_WORDS.signedInSites : m.settingsWebsiteSignInsHeading();
  const heading = (name: string) => (
    <div
      style={{
        fontSize: "var(--text-xs)",
        color: "var(--fg-2)",
        margin: "var(--space-3) 0 var(--space-2)",
      }}
    >
      {m.settingsWebsiteSignInsOn({ computer: name })}
    </div>
  );
  return (
    <div data-website-sign-ins="" tabIndex={-1} style={{ marginTop: SECTION_GAP, outline: "none" }}>
      <SectionLabel>{label}</SectionLabel>
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--fg-2)",
          marginTop: -4,
          marginBottom: ROW_GAP,
        }}
      >
        {inSecrets ? m.settingsWebsiteSignInsStorage() : WEBSITE_SIGN_INS_WORDS.lead}
      </div>
      {computers.length > 0 && heading(place.this)}
      <SignInList
        label={label}
        inSecrets={inSecrets}
        signIns={view.signIns}
        empty={WEBSITE_SIGN_INS_WORDS.empty}
        now={now}
        busy={busy()}
        onRemove={(site) => onRemove(site, {})}
        onAutomatic={(signIn, automatic) => onAutomatic?.(signIn, automatic, {})}
      />
      {onRemoveAll && (
        <RemoveAll
          computer={place.this}
          busy={busy()(EVERY_SITE)}
          onRemoveAll={() => onRemoveAll({})}
        />
      )}
      {computers.map((computer) => (
        <div key={computer.deviceId} data-website-sign-ins-computer={computer.deviceId}>
          {heading(computer.name)}
          <SignInList
            label={m.settingsWebsiteSignInsOn({ computer: computer.name })}
            inSecrets={inSecrets}
            signIns={computer.signIns}
            empty={
              computer.unreachable
                ? m.settingsWebsiteSignInsUnreachable({ computer: computer.name })
                : WEBSITE_SIGN_INS_WORDS.empty
            }
            now={now}
            busy={busy(computer.deviceId)}
            onRemove={(site) => onRemove(site, { deviceId: computer.deviceId })}
            onAutomatic={(signIn, automatic) =>
              onAutomatic?.(signIn, automatic, { deviceId: computer.deviceId })
            }
          />
          {onRemoveAll && (
            <RemoveAll
              computer={computer.name}
              busy={busy(computer.deviceId)(EVERY_SITE)}
              onRemoveAll={() => onRemoveAll({ deviceId: computer.deviceId })}
            />
          )}
        </div>
      ))}
      {any && (
        <p style={{ color: "var(--fg-3)", fontSize: "var(--text-xs)" }}>
          {here(AUTOMATIC_SIGN_IN_NOTICE)}
        </p>
      )}
      <SettingError error={error} surface="website-sign-ins" />
    </div>
  );
}

export function WebsiteSignInsSection({ inSecrets = false }: { inSecrets?: boolean } = {}) {
  const place = useFirstMatePlace();
  const [view, setView] = useState<SavedSignInsView | null>(null);
  const [removing, setRemoving] = useState<(SignInPlace & { site: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const next = await window.infinitary.browser.signIns().catch(() => null);
    setView(next);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const remove = async (site: string, where: SignInPlace) => {
    setRemoving({ site, ...where });
    setError(null);
    try {
      const result = await window.infinitary.browser.removeSignIn(site, where.deviceId);
      if (!result.ok) setError(result.text);
    } catch {
      setError(m.settingsWebsiteSignInsRemoveFailed({ place: place.This }));
    } finally {
      setRemoving(null);
      await load();
    }
  };
  const removeAll = async (where: SignInPlace) => {
    setRemoving({ site: EVERY_SITE, ...where });
    setError(null);
    try {
      const result = await window.infinitary.browser.removeAllSignIns(where.deviceId);
      if (!result.ok) setError(result.text);
    } catch {
      setError(m.settingsWebsiteSignInsRemoveAllFailed({ place: place.This }));
    } finally {
      setRemoving(null);
      await load();
    }
  };
  const automatic = async (signIn: SavedSignIn, allowed: boolean, where: SignInPlace) => {
    if (!signIn.id) return;
    setRemoving({ site: signIn.site, ...where });
    setError(null);
    try {
      const result = await window.infinitary.browser.allowAutomaticSignIn(
        signIn.site,
        signIn.id,
        allowed,
        where.deviceId,
      );
      if (!result.ok) setError(result.text);
    } catch {
      setError(m.settingsWebsiteSignInsAutomaticFailed({ place: place.This }));
    } finally {
      setRemoving(null);
      await load();
    }
  };
  return (
    <WebsiteSignInsSectionView
      view={view}
      now={Date.now()}
      removing={removing}
      error={error}
      onRemove={(site, where) => void remove(site, where)}
      onAutomatic={(signIn, allowed, where) => void automatic(signIn, allowed, where)}
      onRemoveAll={(where) => void removeAll(where)}
      inSecrets={inSecrets}
    />
  );
}
