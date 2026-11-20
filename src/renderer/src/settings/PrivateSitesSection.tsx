import { PRIVATE_SITES_WORDS, type PrivateSitesView } from "@shared/privateSites";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { useShellStore } from "../app/store";
import { Button, Input } from "../design";
import { useFirstMatePlace, useHereAs } from "../devices/useFirstMatePlace";
import { plusIcon } from "./ForgeSection";
import "../accounts/connectChips.css";
import "./forges.css";
import "./integrations.css";

/**
 * The captain's private sites list for task browsers on every computer
 * (docs/task-browser.md, "Private sites"; design skill
 * `components/integrations/IntegrationRow`): one box in Settings ›
 * Integrations that holds the title, the lead, one row per name or suffix
 * with Remove, and a "+ Site" chip that opens the add form in its place.
 * The app's Allow card lands here with the site it names
 * (`pendingPrivateSite`), which is added on arrival with the box in view.
 * Shown only where the home keeps task browsers.
 */
export function PrivateSitesSectionView({
  view,
  adding,
  draft,
  busy,
  error,
  arrived,
  onOpen,
  onCancel,
  onDraft,
  onAdd,
  onRemove,
}: {
  view: PrivateSitesView | null;
  /** Whether the add form is open in the chip's place. */
  adding: boolean;
  draft: string;
  /** The entry whose add or Remove is on its way. */
  busy: string | null;
  error: string | null;
  /** Bumped when the Allow card lands here, to bring the box into view. */
  arrived?: number;
  onOpen: () => void;
  onCancel: () => void;
  onDraft: (value: string) => void;
  onAdd: () => void;
  onRemove: (site: string) => void;
}) {
  const ids = useId();
  const box = useRef<HTMLElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const wasAdding = useRef(adding);
  // Closing the form, by Add, Cancel or Escape, puts the focus back on the chip.
  useEffect(() => {
    if (wasAdding.current && !adding) chip.current?.focus();
    wasAdding.current = adding;
  }, [adding]);
  useEffect(() => {
    if (!arrived || !box.current) return;
    box.current.scrollIntoView({ block: "nearest" });
    box.current.focus({ preventScroll: true });
  }, [arrived]);
  if (!view?.available) return null;
  const typed = draft.trim();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (typed !== "" && busy === null) onAdd();
  };
  return (
    <section
      ref={box}
      tabIndex={-1}
      aria-labelledby={`${ids}-title`}
      className="fm-forges-box fm-private-sites"
      data-private-sites=""
    >
      <div className="fm-private-sites-head">
        <div id={`${ids}-title`} className="fm-integrations-inbox-title">
          {PRIVATE_SITES_WORDS.title}
        </div>
        <p className="fm-integrations-door-lead">{PRIVATE_SITES_WORDS.lead}</p>
      </div>
      {view.sites.length === 0 ? (
        <p className="fm-private-sites-empty" data-private-sites-empty="">
          {PRIVATE_SITES_WORDS.empty}
        </p>
      ) : (
        <ul className="fm-private-sites-list" aria-label={PRIVATE_SITES_WORDS.title}>
          {view.sites.map((site) => (
            <li key={site} className="fm-private-sites-row" data-private-site={site}>
              <span className="fm-private-sites-name">
                {site}
                {site.startsWith(".") && (
                  <span className="fm-private-sites-suffix"> {PRIVATE_SITES_WORDS.suffix}</span>
                )}
              </span>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`${PRIVATE_SITES_WORDS.remove} ${site}`}
                pending={busy === site}
                onClick={() => onRemove(site)}
              >
                {PRIVATE_SITES_WORDS.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="fm-private-sites-foot">
        {adding ? (
          <form
            className="fm-private-sites-form"
            data-private-sites-form=""
            aria-label={PRIVATE_SITES_WORDS.openLabel}
            onSubmit={submit}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }}
          >
            <div className="fm-forges-field">
              <label htmlFor={`${ids}-field`}>{PRIVATE_SITES_WORDS.field}</label>
              <Input
                mono
                id={`${ids}-field`}
                value={draft}
                placeholder={PRIVATE_SITES_WORDS.placeholder}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
                aria-describedby={`${ids}-hint`}
                aria-invalid={error ? true : undefined}
                onChange={(event) => onDraft(event.target.value)}
              />
            </div>
            <p
              id={`${ids}-hint`}
              role="status"
              aria-live="polite"
              className={error ? "fm-private-sites-error" : "fm-private-sites-hint"}
              data-private-sites-error={error ? "" : undefined}
            >
              {error ?? PRIVATE_SITES_WORDS.hint}
            </p>
            <div className="fm-forges-aside-actions">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={typed === ""}
                pending={busy !== null && busy === typed}
              >
                {PRIVATE_SITES_WORDS.add}
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancel}>
                {PRIVATE_SITES_WORDS.cancel}
              </Button>
            </div>
          </form>
        ) : (
          <>
            {error && (
              <p role="status" className="fm-private-sites-error" data-private-sites-error="">
                {error}
              </p>
            )}
            <div className="fm-connect-chips">
              <button
                ref={chip}
                type="button"
                className="fm-connect-chip"
                aria-label={PRIVATE_SITES_WORDS.openLabel}
                aria-expanded={false}
                data-private-sites-open=""
                onClick={onOpen}
              >
                {plusIcon}
                <span>{PRIVATE_SITES_WORDS.open}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export function PrivateSitesSection() {
  const place = useFirstMatePlace();
  const here = useHereAs();
  const arriving = useShellStore((s) => s.pendingPrivateSite);
  const [view, setView] = useState<PrivateSitesView | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [arrived, setArrived] = useState(0);
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
  // The captain's Allow click on the app's card: the site it names is added once,
  // and the box comes into view with the focus on it.
  useEffect(() => {
    if (!arriving) return;
    useShellStore.setState({ pendingPrivateSite: null });
    void add(arriving).then(() => setArrived((count) => count + 1));
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
  const close = () => {
    setAdding(false);
    setDraft("");
    setError(null);
  };
  return (
    <PrivateSitesSectionView
      view={view}
      adding={adding}
      draft={draft}
      busy={busy}
      error={error && here(error)}
      arrived={arrived}
      onOpen={() => {
        setError(null);
        setAdding(true);
      }}
      onCancel={close}
      onDraft={(value) => {
        setDraft(value);
        setError(null);
      }}
      onAdd={() => {
        const site = draft.trim();
        if (!site) return;
        void add(site).then((added) => {
          if (added) close();
        });
      }}
      onRemove={(site) => void remove(site)}
    />
  );
}
