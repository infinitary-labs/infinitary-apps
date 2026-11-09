import { PRIVATE_SITES_WORDS, type PrivateSitesView } from "@shared/privateSites";
import { useCallback, useEffect, useState } from "react";
import { useShellStore } from "../app/store";
import { Button, Input } from "../design";
import { useFirstMatePlace } from "../devices/useFirstMatePlace";
import { ROW_GAP, SECTION_GAP, SectionLabel, SettingError } from "./settingRows";

/**
 * The captain's private sites list for task browsers on every computer
 * (docs/task-browser.md, "Private sites"): one row per name or suffix with
 * Remove, and a field that adds one. The app's Allow card lands here with
 * the site it names (`pendingPrivateSite`), which is added on arrival.
 * Shown only where the home keeps task browsers.
 */
export function PrivateSitesSectionView({
  view,
  draft,
  busy,
  error,
  onDraft,
  onAdd,
  onRemove,
}: {
  view: PrivateSitesView | null;
  draft: string;
  /** The entry whose add or Remove is on its way. */
  busy: string | null;
  error: string | null;
  onDraft: (value: string) => void;
  onAdd: () => void;
  onRemove: (site: string) => void;
}) {
  if (!view?.available) return null;
  return (
    <div data-private-sites="" style={{ marginTop: SECTION_GAP }}>
      <SectionLabel>{PRIVATE_SITES_WORDS.title}</SectionLabel>
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--fg-2)",
          marginTop: -4,
          marginBottom: ROW_GAP,
        }}
      >
        {PRIVATE_SITES_WORDS.lead}
      </div>
      <ul
        aria-label={PRIVATE_SITES_WORDS.title}
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
        {view.sites.length === 0 ? (
          <li
            data-private-sites-empty=""
            style={{
              padding: "var(--space-3) var(--space-4)",
              fontSize: "var(--text-sm)",
              color: "var(--fg-3)",
            }}
          >
            {PRIVATE_SITES_WORDS.empty}
          </li>
        ) : (
          view.sites.map((site, index) => (
            <li
              key={site}
              data-private-site={site}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
                padding: "var(--space-3) var(--space-4)",
                borderTop: index === 0 ? undefined : "1px solid var(--line-1)",
                minWidth: 0,
              }}
            >
              <span
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-sm)",
                  color: "var(--fg-1)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {site}
              </span>
              <Button
                variant="secondary"
                size="sm"
                pending={busy === site}
                onClick={() => onRemove(site)}
              >
                {PRIVATE_SITES_WORDS.remove}
              </Button>
            </li>
          ))
        )}
      </ul>
      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: ROW_GAP }}>
        <Input
          mono
          aria-label={PRIVATE_SITES_WORDS.field}
          placeholder={PRIVATE_SITES_WORDS.placeholder}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onAdd();
          }}
          style={{ flex: 1, fontSize: "var(--text-sm)", padding: "var(--space-2) var(--space-3)" }}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={draft.trim() === ""}
          pending={busy !== null && busy === draft.trim()}
          onClick={onAdd}
        >
          {PRIVATE_SITES_WORDS.add}
        </Button>
      </div>
      <SettingError error={error} surface="private-sites" />
    </div>
  );
}

export function PrivateSitesSection() {
  const place = useFirstMatePlace();
  const arriving = useShellStore((s) => s.pendingPrivateSite);
  const [view, setView] = useState<PrivateSitesView | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setView(await window.infinitary.browser.privateSites().catch(() => null));
  }, []);
  const add = useCallback(
    async (site: string): Promise<boolean> => {
      setBusy(site);
      setError(null);
      try {
        const result = await window.infinitary.browser.addPrivateSite(site);
        if (!result.ok) {
          setError(result.text);
          return false;
        }
        setView({ available: true, sites: result.sites });
        return true;
      } catch {
        setError(`${place.This} could not add that site right now. Try again.`);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [place.This],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // The captain's Allow click on the app's card: the site it names is added once.
  useEffect(() => {
    if (!arriving) return;
    useShellStore.setState({ pendingPrivateSite: null });
    void add(arriving);
  }, [arriving, add]);
  const remove = async (site: string) => {
    setBusy(site);
    setError(null);
    try {
      const result = await window.infinitary.browser.removePrivateSite(site);
      if (!result.ok) setError(result.text);
      else setView({ available: true, sites: result.sites });
    } catch {
      setError(`${place.This} could not remove that site right now. Try again.`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <PrivateSitesSectionView
      view={view}
      draft={draft}
      busy={busy}
      error={error}
      onDraft={setDraft}
      onAdd={() => {
        const site = draft.trim();
        if (!site) return;
        void add(site).then((added) => {
          if (added) setDraft("");
        });
      }}
      onRemove={(site) => void remove(site)}
    />
  );
}
