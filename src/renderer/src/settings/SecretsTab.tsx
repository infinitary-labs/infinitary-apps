import { formatDate, formatDateTime, formatTime } from "@shared/i18n/format";
import { needsReference, secretName } from "@shared/secretNames";
import {
  decisionWords,
  SECRET_APPROVAL_WORDS,
  SECRET_STATE_WORDS,
  SECRETS_AREAS,
  SECRETS_RECOVERY_WORDS,
  SECRETS_WORDS,
  type SecretAction,
  type SecretEntryInput,
  type SecretsView,
  secretEntryInputSchema,
} from "@shared/secrets";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useShellStore } from "../app/store";
import { Badge, Button, Input } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { LABEL_GAP, ROW_GAP, SECTION_GAP, SettingError } from "./settingRows";
import "./secrets.css";

type Entry = SecretsView["entries"][number];
type Rule = SecretsView["rules"][number];
type Area = (typeof SECRETS_AREAS)[number]["value"];
type Act = (action: SecretAction) => Promise<void>;
/** A badge only when something is wrong; a working store says nothing about itself. */
const PROBLEM: Partial<Record<SecretsView["availability"], string>> = {
  locked: "Storage locked",
  unavailable: "Storage unavailable",
  lost: "Recovery needed",
  tampered: "Permissions need recovery",
};

/** Trusted application chrome only. No value is rendered back, copied, or passed to an agent frame. */
export function SecretsTab() {
  const [view, setView] = useState<SecretsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<Area>>(new Set());
  const [editing, setEditing] = useState<Entry | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const searchId = useId();
  const entryTrigger = useRef<HTMLButtonElement | null>(null);
  const returnEntryFocus = useRef(false);
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (editing !== null || !returnEntryFocus.current) return;
    returnEntryFocus.current = false;
    // The replacement may no longer match the search. Choose after React's
    // commit, never in a frame that can still contain the about-to-be-removed row.
    if (entryTrigger.current?.isConnected) entryTrigger.current.focus();
    else root.current?.querySelector<HTMLButtonElement>("[data-secret-add]")?.focus();
  }, [editing]);
  const refresh = useCallback(() => window.infinitary.secrets.view().then(setView), []);
  useEffect(() => {
    let live = true;
    const reload = () => {
      void window.infinitary.secrets
        .view()
        .then((next) => {
          if (live) setView(next);
        })
        .catch(() => {
          if (live) setError(SECRETS_WORDS.unavailable);
        });
    };
    reload();
    const off = window.infinitary.secrets.onChange(reload);
    return () => {
      live = false;
      off();
    };
  }, []);
  const act: Act = async (input) => {
    setError(null);
    setBusy(true);
    try {
      const next = await window.infinitary.secrets.action(input);
      setView(next);
      if (next.offeredCard) {
        const shell = useShellStore.getState();
        shell.setView("home");
        shell.focusCard(next.offeredCard);
      }
    } catch {
      setError(SECRETS_WORDS.unavailable);
    } finally {
      setBusy(false);
    }
  };
  const beginEntry = (entry: Entry | "new", trigger: HTMLButtonElement) => {
    entryTrigger.current = trigger;
    setEditing(entry);
  };
  const finishEntry = () => {
    returnEntryFocus.current = true;
    setEditing(null);
  };
  const toggleArea = (area: Area, open: boolean) =>
    setOpened((current) => {
      if (current.has(area) === open) return current;
      const next = new Set(current);
      if (open) next.add(area);
      else next.delete(area);
      return next;
    });
  const all = view?.entries ?? [];
  const query = search.toLocaleLowerCase();
  const entries = all
    .filter((entry) =>
      [entry.label, entry.environment, entry.lastTask ?? ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
    )
    .sort((a, b) => a.label.localeCompare(b.label) || a.ref.localeCompare(b.ref));
  const canWrite = view?.availability === "available" || view?.availability === "uninitialized";
  const notEnabled = view?.availability === "not-enabled";
  const recoveryNeeded = view?.availability === "lost" || view?.availability === "tampered";
  const problem = view ? PROBLEM[view.availability] : undefined;
  const entryNote = !canWrite
    ? SECRETS_WORDS.unavailable
    : editing
      ? "Finish the open secret form first."
      : undefined;
  const waiting = (view?.uses ?? []).filter((use) => use.state === "waiting");
  return (
    <section
      ref={root}
      className="fm-secrets"
      aria-label={SECRETS_WORDS.title}
      style={
        {
          "--secret-row-gap": ROW_GAP,
          "--secret-section-gap": SECTION_GAP,
          "--secret-label-gap": LABEL_GAP,
        } as React.CSSProperties
      }
    >
      <header className="fm-secrets-heading">
        <div>
          <h2 data-secrets-heading="" tabIndex={-1}>
            {SECRETS_WORDS.title}
          </h2>
          {view && !notEnabled && <p>{SECRETS_WORDS.count(all.length, thisDesktop().mac)}</p>}
        </div>
        {problem && <Badge tone="warn">{problem}</Badge>}
      </header>
      {notEnabled ? (
        <div className="fm-secrets-empty">
          <p role="status">{SECRETS_WORDS.disabled}</p>
        </div>
      ) : !view ? (
        <p role="status">Reading Secrets…</p>
      ) : (
        <>
          {view.message && <p role="status">{view.message}</p>}
          {!canWrite && (
            <div className="fm-secrets-notice">
              <p>
                {recoveryNeeded
                  ? "Stored values or permissions need recovery. No access was granted."
                  : "Unlock or check storage to use your secrets. Approval requests keep waiting."}
              </p>
              <Button
                variant="secondary"
                onClick={() =>
                  recoveryNeeded ? toggleArea("copy", true) : void act({ kind: "unlock" })
                }
                pending={busy}
              >
                {recoveryNeeded ? "Recovery options" : "Unlock or check again"}
              </Button>
            </div>
          )}
          {waiting.map((use) => (
            <div key={use.request} className="fm-secrets-notice" data-secret-waiting="">
              <p>
                {SECRETS_WORDS.waitingFor(
                  use.secrets.length
                    ? use.secrets.map((secret) => secretName(all, secret.ref)).join(", ")
                    : use.recipient || SECRETS_WORDS.title,
                )}
              </p>
              <Button
                variant="secondary"
                pending={busy}
                onClick={() => void act({ kind: "review-use", request: use.request })}
              >
                {SECRETS_WORDS.waiting}
              </Button>
            </div>
          ))}
          <div className="fm-secrets-toolbar">
            {all.length > 0 && (
              <label htmlFor={searchId} className="fm-secrets-grow">
                <span className="fm-secrets-visually-hidden">{SECRETS_WORDS.search}</span>
                <Input
                  id={searchId}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={SECRETS_WORDS.search}
                />
              </label>
            )}
            <Button
              data-secret-add=""
              off={!canWrite || editing !== null}
              note={entryNote}
              onClick={(event) => beginEntry("new", event.currentTarget)}
            >
              {SECRETS_WORDS.add}
            </Button>
          </div>
          {editing && (
            <SecureEntry
              key={editing === "new" ? "new" : editing.ref}
              entry={editing === "new" ? undefined : editing}
              onCancel={finishEntry}
              onSaved={(next) => {
                setView(next);
                finishEntry();
              }}
            />
          )}
          {entries.length === 0 ? (
            <div className="fm-secrets-empty">
              <p>
                {all.length
                  ? SECRETS_WORDS.noMatch
                  : canWrite
                    ? SECRETS_WORDS.noneYet
                    : SECRETS_WORDS.waitingStorage}
              </p>
            </div>
          ) : (
            <ul className="fm-secrets-entries">
              {entries.map((entry) => (
                <SecretRow
                  key={entry.ref}
                  entry={entry}
                  view={view}
                  act={act}
                  busy={busy}
                  canWrite={canWrite}
                  entryNote={entryNote}
                  onReplace={(trigger) => beginEntry(entry, trigger)}
                />
              ))}
            </ul>
          )}
          <div className="fm-secrets-areas">
            <QuietRow
              area="decisions"
              summary={view.rules.length ? String(view.rules.length) : ""}
              open={opened.has("decisions")}
              onToggle={toggleArea}
            >
              <section className="fm-secrets-area" aria-label={SECRETS_WORDS.decisionsRegion}>
                <Decisions view={view} rules={view.rules} act={act} busy={busy} />
              </section>
            </QuietRow>
            <QuietRow
              area="phone"
              summary={
                view.devices.length
                  ? view.devices.map((device) => device.label).join(", ")
                  : SECRETS_WORDS.noPhone
              }
              open={opened.has("phone")}
              onToggle={toggleArea}
            >
              <ApprovalDevices view={view} act={act} busy={busy} />
            </QuietRow>
            <QuietRow
              area="history"
              summary={historySummary(view.history)}
              open={opened.has("history")}
              onToggle={toggleArea}
            >
              <History view={view} act={act} busy={busy} refresh={refresh} />
            </QuietRow>
            <QuietRow area="copy" summary="" open={opened.has("copy")} onToggle={toggleArea}>
              <Recovery view={view} act={act} busy={busy || editing !== null} />
            </QuietRow>
          </div>
        </>
      )}
      <SettingError error={error} surface="secrets" />
    </section>
  );
}

/** One secret: its name, its place, and what last happened with it; opening it offers its changes. */
function SecretRow({
  entry,
  view,
  act,
  busy,
  canWrite,
  entryNote,
  onReplace,
}: {
  entry: Entry;
  view: SecretsView;
  act: Act;
  busy: boolean;
  canWrite: boolean;
  entryNote: string | undefined;
  onReplace: (trigger: HTMLButtonElement) => void;
}) {
  const uses = view.uses.filter((use) => use.secrets.some((secret) => secret.ref === entry.ref));
  const reads = view.reads.filter((read) => read.secrets.includes(entry.ref));
  const rules = view.rules.filter((rule) => rule.secret === entry.ref);
  const status = uses.some((use) => use.state === "executing")
    ? SECRETS_WORDS.inUse
    : uses.some((use) => use.state === "waiting")
      ? SECRETS_WORDS.waitingRow
      : entry.lastRequest === null
        ? SECRETS_WORDS.notUsed
        : SECRETS_WORDS.used(dayOf(entry.lastRequest), entry.lastTask);
  return (
    <li className="fm-secrets-key">
      <details className="fm-secrets-entry">
        <summary>
          <span className="fm-secrets-key-name">
            <strong>{entry.label}</strong>
            {entry.environment && (
              <span className="fm-secrets-entry-environment">{entry.environment}</span>
            )}
            {needsReference(view.entries, entry) && (
              <span className="fm-secrets-entry-reference fm-secrets-mono">{entry.ref}</span>
            )}
          </span>
          <span className="fm-secrets-key-status">{status}</span>
        </summary>
        <div className="fm-secrets-key-body">
          <div className="fm-secrets-actions">
            <Button
              variant="secondary"
              off={!canWrite || entryNote !== undefined}
              note={entryNote}
              onClick={(event) => onReplace(event.currentTarget)}
            >
              {SECRETS_WORDS.replace}
            </Button>
            <Button
              variant="ghost"
              off={busy || !canWrite}
              note={
                !canWrite
                  ? SECRETS_WORDS.unavailable
                  : busy
                    ? "Wait for the current change to finish."
                    : undefined
              }
              onClick={() => void act({ kind: "forget", ref: entry.ref })}
            >
              {SECRETS_WORDS.forget}
            </Button>
          </div>
          {rules.length > 0 && <Decisions view={view} rules={rules} act={act} busy={busy} />}
        </div>
      </details>
      {reads.map((read) => (
        <div key={read.id} className="fm-secrets-key-read">
          <span>{SECRETS_WORDS.readingUntil(timeOf(read.expires))}</span>
          <Button variant="secondary" onClick={() => void act({ kind: "end-read", id: read.id })}>
            {SECRETS_WORDS.end}
          </Button>
        </div>
      ))}
    </li>
  );
}

/** A rare thing, kept under the list: one quiet row that opens in place. */
function QuietRow({
  area,
  summary,
  open,
  onToggle,
  children,
}: {
  area: Area;
  summary: string;
  open: boolean;
  onToggle: (area: Area, open: boolean) => void;
  children: React.ReactNode;
}) {
  const label = SECRETS_AREAS.find((option) => option.value === area)?.label;
  return (
    <details
      className="fm-secrets-quiet"
      data-secrets-area={area}
      open={open}
      onToggle={(event) => onToggle(area, event.currentTarget.open)}
    >
      <summary>
        <span>{label}</span>
        {summary && <span className="fm-secrets-quiet-summary">{summary}</span>}
      </summary>
      <div className="fm-secrets-quiet-body">{children}</div>
    </details>
  );
}

/** Saved decisions in plain sentences. Removing one asks for confirmation on a card; nothing here edits a decision. */
function Decisions({
  view,
  rules,
  act,
  busy,
}: {
  view: SecretsView;
  rules: readonly Rule[];
  act: Act;
  busy: boolean;
}) {
  if (rules.length === 0) return <p className="fm-secrets-muted">{SECRETS_WORDS.noDecisions}</p>;
  const writable = view.availability === "available";
  return (
    <ul className="fm-secrets-decisions">
      {rules.map((rule) => (
        <li key={rule.id} className="fm-secrets-row">
          <span>{decisionWords(rule, secretName(view.entries, rule.secret))}</span>
          <Button
            variant="ghost"
            pending={busy}
            off={!writable}
            note={writable ? undefined : SECRETS_WORDS.unavailable}
            onClick={() =>
              void act({
                kind: "save-rules",
                rules: view.rules.filter((saved) => saved.id !== rule.id),
              })
            }
          >
            {SECRETS_WORDS.remove}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function SecureEntry({
  entry,
  onCancel,
  onSaved,
}: {
  entry?: Entry;
  onCancel: () => void;
  onSaved: (view: SecretsView) => void;
}) {
  const prefix = useId();
  const [label, setLabel] = useState(entry?.label ?? "");
  const [value, setValue] = useState("");
  const [environment, setEnvironment] = useState(entry?.environment ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    // A new secret names no reference: the controller makes a stable one from its name.
    const input: SecretEntryInput = {
      ...(entry ? { ref: entry.ref } : {}),
      label,
      value,
      environment,
      expectedVersion: entry?.version ?? 0,
      expectedRevision: entry?.revision ?? null,
    };
    const parsed = secretEntryInputSchema.safeParse(input);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      setError(field === "label" ? SECRETS_WORDS.nameRequired : SECRETS_WORDS.valueRequired);
      requestAnimationFrame(() => {
        const id = `${prefix}-${field === "label" ? "name" : "value"}`;
        form.current?.ownerDocument.getElementById(id)?.focus();
      });
      return;
    }
    setValue("");
    setBusy(true);
    setError(null);
    try {
      const next = await window.infinitary.secrets.entry(input);
      const saved = next.entries.find((row) => row.ref === next.saved?.ref);
      if (
        saved?.version === input.expectedVersion + 1 &&
        next.saved?.version === saved.version &&
        (!input.ref || saved.ref === input.ref) &&
        next.message === SECRETS_WORDS.saved
      )
        onSaved(next);
      else setError(next.message ?? SECRETS_WORDS.unavailable);
    } catch {
      setError(SECRETS_WORDS.unavailable);
    } finally {
      input.value = "";
      setBusy(false);
    }
  };
  return (
    <form
      ref={form}
      className="fm-secrets-form"
      onSubmit={(event) => void save(event)}
      autoComplete="off"
      aria-label={entry ? SECRETS_WORDS.replace : SECRETS_WORDS.add}
    >
      <h3>{entry ? `${SECRETS_WORDS.replace} ${entry.label}` : SECRETS_WORDS.add}</h3>
      <label htmlFor={`${prefix}-name`}>
        {SECRETS_WORDS.name}
        <Input
          id={`${prefix}-name`}
          required
          value={label}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="For example, Website deployment"
        />
      </label>
      <label htmlFor={`${prefix}-value`}>
        {SECRETS_WORDS.value}
        <Input
          id={`${prefix}-value`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <p className="fm-secrets-muted">{SECRETS_WORDS.noReveal}</p>
      <label htmlFor={`${prefix}-place`}>
        {SECRETS_WORDS.place}
        <Input
          id={`${prefix}-place`}
          value={environment}
          disabled={busy}
          onChange={(event) => setEnvironment(event.target.value)}
          placeholder={SECRETS_WORDS.placeHint}
        />
      </label>
      <SettingError error={error} surface="secret-entry" />
      <div className="fm-secrets-actions">
        <Button type="submit" pending={busy} pendingLabel="Saving…">
          {SECRETS_WORDS.save}
        </Button>
        <Button
          type="button"
          variant="ghost"
          off={busy}
          note={busy ? "Wait for saving to finish." : undefined}
          onClick={() => {
            setValue("");
            onCancel();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** INF-1109's phone approvals (docs/secrets.md, "Remote decisions"): each enrolled device, and the way to stop it. */
function ApprovalDevices({ view, act, busy }: { view: SecretsView; act: Act; busy: boolean }) {
  return (
    <section className="fm-secrets-area" aria-label={SECRETS_WORDS.devicesRegion}>
      {view.devices.length === 0 ? (
        <p className="fm-secrets-muted">{SECRETS_WORDS.noDevices}</p>
      ) : (
        view.devices.map((device) => (
          <div key={device.device} className="fm-secrets-row">
            <div>
              <strong>{device.label}</strong>
              <p className="fm-secrets-muted">Code {device.code}</p>
            </div>
            <Button
              variant="ghost"
              pending={busy}
              onClick={() => void act({ kind: "forget-device", device: device.device })}
            >
              {SECRETS_WORDS.stopApprovals}
            </Button>
          </div>
        ))
      )}
    </section>
  );
}

function History({
  view,
  act,
  busy,
  refresh,
}: {
  view: SecretsView;
  act: Act;
  busy: boolean;
  refresh: () => Promise<void>;
}) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <section className="fm-secrets-area" aria-label={SECRETS_WORDS.historyRegion}>
      <p>{SECRETS_WORDS.history}</p>
      <p className="fm-secrets-muted">{SECRETS_WORDS.storageUse(sizeOf(view.historyBytes))}</p>
      <div className="fm-secrets-actions">
        <Button
          variant="secondary"
          onClick={() => {
            void window.infinitary.secrets
              .exportHistory()
              .then((result) => setMessage(result.saved ? "History exported." : "No export saved."))
              .catch(() => setMessage("History could not be exported."));
          }}
        >
          Export history
        </Button>
        <Button variant="ghost" pending={busy} onClick={() => void act({ kind: "delete-history" })}>
          Delete history
        </Button>
        <Button variant="ghost" onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
      {view.history.length === 0 ? (
        <p>No history recorded.</p>
      ) : (
        [...view.history].reverse().map((item) => (
          <div className="fm-secrets-history" key={item.request}>
            <div className="fm-secrets-actions">
              <strong>{item.secrets.map((ref) => secretName(view.entries, ref)).join(", ")}</strong>
              <span className="fm-secrets-muted">
                {SECRET_STATE_WORDS[item.state]} · {dateOf(item.requestedAt)}
              </span>
            </div>
            <p>{item.reason}</p>
            {item.recoveredFrom && (
              <details>
                <summary>{SECRETS_RECOVERY_WORDS.recoveredHistory}</summary>
                <p className="fm-secrets-mono">Source: {item.recoveredFrom}</p>
                <p className="fm-secrets-mono">Recovered: {dateOf(item.recoveredAt ?? null)}</p>
              </details>
            )}
            <p className="fm-secrets-muted">
              <span className="fm-secrets-mono">{item.program}</span>
              {item.approval ? ` · ${SECRET_APPROVAL_WORDS[item.approval]}` : ""}
              {item.reconciled && !item.recoveredFrom
                ? ` · ${SECRETS_RECOVERY_WORDS.reconciledAfterRestart}`
                : ""}
            </p>
          </div>
        ))
      )}
    </section>
  );
}

function Recovery({ view, act, busy }: { view: SecretsView; act: Act; busy: boolean }) {
  const ready = view.recoveryAvailable && view.availability === "available";
  const restoreReady = view.recoveryAvailable && view.availability !== "locked";
  const waiting = "Finish the open secret form or current change first.";
  return (
    <section className="fm-secrets-area" aria-label={SECRETS_RECOVERY_WORDS.region}>
      {!view.recoveryAvailable && <p role="status">{SECRETS_RECOVERY_WORDS.unavailable}</p>}
      <div className="fm-secrets-recovery-choice">
        <div>
          <p>
            Save an encrypted copy and a separate recovery key. Keep them apart: anyone with both
            can read the saved values. There is no key reset.
          </p>
        </div>
        <Button
          variant="secondary"
          off={busy || !ready}
          note={
            busy
              ? waiting
              : !view.recoveryAvailable
                ? SECRETS_RECOVERY_WORDS.unavailable
                : !ready
                  ? SECRETS_WORDS.unavailable
                  : undefined
          }
          onClick={() => void act({ kind: "backup-recovery" })}
        >
          {SECRETS_RECOVERY_WORDS.saveButton}
        </Button>
      </div>
      <div className="fm-secrets-recovery-choice">
        <div>
          <p>
            Restoring replaces stored values and clears saved decisions, phone approvals and
            temporary access. History stays, and it never allows a use.
          </p>
        </div>
        <Button
          variant="secondary"
          off={busy || !restoreReady}
          note={
            busy
              ? waiting
              : !view.recoveryAvailable
                ? SECRETS_RECOVERY_WORDS.unavailable
                : !restoreReady
                  ? "Unlock protected storage before restoring."
                  : undefined
          }
          onClick={() => void act({ kind: "restore-recovery" })}
        >
          {SECRETS_RECOVERY_WORDS.restoreButton}
        </Button>
      </div>
      <p className="fm-secrets-muted">
        Choose the files, then confirm with your computer. Cancelling changes nothing. Never put the
        recovery key in a card or conversation.
      </p>
    </section>
  );
}

function historySummary(history: SecretsView["history"]): string {
  if (history.length === 0) return SECRETS_WORDS.noHistory;
  const newest = Math.max(...history.map((item) => item.requestedAt));
  return SECRETS_WORDS.historySummary(history.length, dayOf(newest));
}

/** Today, yesterday, or the month and day. */
function dayOf(at: number): string {
  const day = new Date(at);
  const today = new Date();
  const start = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start(today) - start(day)) / 86_400_000);
  if (days === 0) return SECRETS_WORDS.today;
  if (days === 1) return SECRETS_WORDS.yesterday;
  return formatDate(day, { month: "short", day: "numeric" });
}

function timeOf(at: number): string {
  return formatTime(at, { hour: "numeric", minute: "2-digit" });
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dateOf(at: number | null): string {
  return at === null ? "Not requested yet" : formatDateTime(at);
}
