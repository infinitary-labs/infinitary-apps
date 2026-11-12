import type { ThisMac } from "@shared/devices";
import { formatDate } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import {
  AUTOMATIC_SIGN_IN_LABEL,
  AUTOMATIC_SIGN_IN_NOTICE,
  type SavedSignIn,
  type SavedSignInsView,
} from "@shared/taskBrowser";
import { useCallback, useEffect, useState } from "react";
import { useShellStore } from "../app/store";
import { Button } from "../design";
import { useFirstMatePlace, useHereAs } from "../devices/useFirstMatePlace";
import { isView } from "../devices/viewWords";
import { ROW_GAP, SECTION_GAP, SectionLabel, SettingError } from "./settingRows";

/**
 * The website sign-ins saved on this Mac for task browsers
 * (docs/task-browser.md, "Saved sign-ins"; the design skill's
 * `components/cards/TaskBrowser`, "Saved sign-ins"): one row per site, with
 * when it was saved and Remove. Shown only where this Mac keeps task
 * browsers, so a host with no browser engine draws nothing here.
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

/** "saved today", "saved yesterday" or "saved Oct 1": when a sign-in was saved. */
export function savedWhen(at: number, now: number): string {
  const date = new Date(at);
  const day = new Date(now);
  if (date.toDateString() === day.toDateString()) return "saved today";
  day.setDate(day.getDate() - 1);
  if (date.toDateString() === day.toDateString()) return "saved yesterday";
  return `saved ${formatDate(date, { month: "short", day: "numeric" })}`;
}

export const WEBSITE_SIGN_INS_LEAD =
  "Sign-ins you saved as you handed a task's browser back. Allow future tasks separately for each site, or choose access on each task’s request.";
export const WEBSITE_SIGN_INS_EMPTY =
  "None yet. Tick Remember as you return control of a task's browser to save one.";

export function WebsiteSignInsSectionView({
  view,
  now,
  removing,
  error,
  onRemove,
  onAutomatic,
  inSecrets = false,
}: {
  view: SavedSignInsView | null;
  now: number;
  /** The site whose Remove is on its way. */
  removing: string | null;
  error: string | null;
  onRemove: (site: string) => void;
  onAutomatic?: (signIn: SavedSignIn, automatic: boolean) => void;
  /** Shown in Secrets, where the lead also names the sign-ins' own storage. */
  inSecrets?: boolean;
}) {
  const here = useHereAs();
  if (!view?.available) return null;
  return (
    <div data-website-sign-ins="" tabIndex={-1} style={{ marginTop: SECTION_GAP, outline: "none" }}>
      <SectionLabel>Website sign-ins</SectionLabel>
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--fg-2)",
          marginTop: -4,
          marginBottom: ROW_GAP,
        }}
      >
        {WEBSITE_SIGN_INS_LEAD}
        {/* Said in Secrets, beside the protected secrets these sign-ins are not. */}
        {inSecrets && ` ${m.settingsWebsiteSignInsStorage()}`}
      </div>
      <ul
        aria-label="Website sign-ins"
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          background: "var(--bg-1)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-m)",
          overflow: "hidden",
        }}
      >
        {view.signIns.length === 0 ? (
          <li
            data-website-sign-ins-empty=""
            style={{
              padding: "var(--space-3) var(--space-4)",
              fontSize: "var(--text-sm)",
              color: "var(--fg-3)",
            }}
          >
            {WEBSITE_SIGN_INS_EMPTY}
          </li>
        ) : (
          view.signIns.map((signIn: SavedSignIn, index) => (
            <li
              key={signIn.site}
              data-website-sign-in={signIn.site}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
                padding: "var(--space-3) var(--space-4)",
                borderTop: index === 0 ? undefined : "1px solid var(--line-1)",
                minWidth: 0,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-sm)",
                  color: "var(--fg-1)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {signIn.site}
              </span>
              <span
                data-website-sign-in-saved=""
                style={{
                  flex: 1,
                  fontSize: "var(--text-xs)",
                  color: "var(--fg-3)",
                  whiteSpace: "nowrap",
                }}
              >
                {savedWhen(signIn.savedAt, now)}
              </span>
              <Button
                variant="secondary"
                size="sm"
                pending={removing === signIn.site}
                onClick={() => onRemove(signIn.site)}
              >
                Remove
              </Button>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  fontSize: "var(--text-xs)",
                  color: "var(--fg-2)",
                  flexBasis: "100%",
                }}
              >
                <input
                  type="checkbox"
                  checked={signIn.automatic ?? false}
                  disabled={!signIn.id || removing === signIn.site}
                  onChange={(event) => onAutomatic?.(signIn, event.target.checked)}
                  style={{ accentColor: "var(--accent)" }}
                />
                {AUTOMATIC_SIGN_IN_LABEL}
              </label>
            </li>
          ))
        )}
      </ul>
      {view.signIns.length > 0 && (
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
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const next = await window.infinitary.browser.signIns().catch(() => null);
    setView(next);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const remove = async (site: string) => {
    setRemoving(site);
    setError(null);
    try {
      const result = await window.infinitary.browser.removeSignIn(site);
      if (!result.ok) setError(result.text);
    } catch {
      setError(`${place.This} could not remove that sign-in right now. Try again.`);
    } finally {
      setRemoving(null);
      await load();
    }
  };
  const automatic = async (signIn: SavedSignIn, allowed: boolean) => {
    if (!signIn.id) return;
    setRemoving(signIn.site);
    setError(null);
    try {
      const result = await window.infinitary.browser.allowAutomaticSignIn(
        signIn.site,
        signIn.id,
        allowed,
      );
      if (!result.ok) setError(result.text);
    } catch {
      setError(`${place.This} could not change that permission right now.`);
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
      onRemove={(site) => void remove(site)}
      onAutomatic={(signIn, allowed) => void automatic(signIn, allowed)}
      inSecrets={inSecrets}
    />
  );
}
