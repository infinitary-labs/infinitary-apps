import {
  SECRET_APPROVAL_WORDS,
  SECRET_OVERVIEW_FACTS,
  SECRET_STATE_WORDS,
  SECRETS_AREAS,
  SECRETS_RECOVERY_WORDS,
  SECRETS_WORDS,
  type SecretAction,
  type SecretEntryInput,
  type SecretRehearsal,
  type SecretsView,
  secretEntryInputSchema,
  secretRehearsalInputSchema,
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
import { Badge, Button, GroupedPills, Input } from "../design";
import { SecretChoices } from "./SecretChoices";
import { LABEL_GAP, ROW_GAP, SECTION_GAP, SettingError } from "./settingRows";
import "./secrets.css";

type Entry = SecretsView["entries"][number];
type Rule = SecretsView["rules"][number];
type Area = (typeof SECRETS_AREAS)[number]["value"];
const STATUS: Record<SecretsView["availability"], string> = {
  "not-enabled": "Not enabled",
  available: "Protected storage ready",
  locked: "Storage locked",
  unavailable: "Storage unavailable",
  uninitialized: "Ready to add secrets",
  lost: "Recovery needed",
  tampered: "Permissions need recovery",
};

/** Trusted application chrome only. No value is rendered back, copied, or passed to an agent frame. */
export function SecretsTab() {
  const [view, setView] = useState<SecretsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [area, setArea] = useState<Area>("uses");
  const [editing, setEditing] = useState<Entry | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const searchId = useId();
  const areaId = useId();
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
  const act = async (input: SecretAction) => {
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
  const identityCounts = new Map<string, number>();
  for (const entry of view?.entries ?? []) {
    const identity = JSON.stringify([entry.label, entry.environment]);
    identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
  }
  const entries = (view?.entries ?? [])
    .filter((entry) =>
      [entry.label, entry.ref, entry.environment]
        .join(" ")
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
    )
    .sort((a, b) => a.label.localeCompare(b.label) || a.ref.localeCompare(b.ref));
  const canWrite = view?.availability === "available" || view?.availability === "uninitialized";
  const notEnabled = view?.availability === "not-enabled";
  const recoveryNeeded = view?.availability === "lost" || view?.availability === "tampered";
  const entryNote = !canWrite
    ? SECRETS_WORDS.unavailable
    : editing
      ? "Finish the open secret form first."
      : undefined;
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
          {!notEnabled && <p>{SECRETS_WORDS.intro}</p>}
        </div>
        {view && <Badge tone="neutral">{STATUS[view.availability]}</Badge>}
      </header>
      {notEnabled ? (
        <div className="fm-secrets-empty">
          <p role="status">{SECRETS_WORDS.disabled}</p>
          <p className="fm-secrets-muted">{SECRETS_WORDS.migration}</p>
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
                  recoveryNeeded ? setArea("recovery") : void act({ kind: "unlock" })
                }
                pending={busy}
              >
                {recoveryNeeded ? "Recovery options" : "Unlock or check again"}
              </Button>
            </div>
          )}
          <div className="fm-secrets-toolbar">
            {view.entries.length > 0 ? (
              <label htmlFor={searchId} className="fm-secrets-grow">
                <span className="fm-secrets-visually-hidden">{SECRETS_WORDS.search}</span>
                <Input
                  id={searchId}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={SECRETS_WORDS.search}
                />
              </label>
            ) : (
              <h3 className="fm-secrets-grow">Your secrets</h3>
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
          <div className="fm-secrets-entries">
            {entries.length === 0 ? (
              <div className="fm-secrets-empty">
                <p>
                  {view.entries.length
                    ? "No matching secrets."
                    : canWrite
                      ? "No secrets added yet."
                      : "Secrets will appear when storage is available."}
                </p>
                {!view.entries.length && canWrite && !editing && (
                  <p className="fm-secrets-muted">
                    Add a credential your crew needs. Its name is visible to the crew; its value
                    stays hidden.
                  </p>
                )}
              </div>
            ) : (
              entries.map((entry) => (
                <details key={entry.ref} className="fm-secrets-entry">
                  <summary>
                    <strong>{entry.label}</strong>
                    {entry.environment && (
                      <span className="fm-secrets-entry-environment">{entry.environment}</span>
                    )}
                    {(identityCounts.get(JSON.stringify([entry.label, entry.environment])) ?? 0) >
                      1 && (
                      <span className="fm-secrets-entry-reference fm-secrets-mono">
                        {entry.ref}
                      </span>
                    )}
                  </summary>
                  <dl className="fm-secrets-facts">
                    <dt>Reference</dt>
                    <dd className="fm-secrets-mono">{entry.ref}</dd>
                    <dt>Saved version</dt>
                    <dd className="fm-secrets-mono">{entry.version}</dd>
                    <dt>Last request</dt>
                    <dd className="fm-secrets-mono">{dateOf(entry.lastRequest)}</dd>
                  </dl>
                  <div className="fm-secrets-actions">
                    <Button
                      variant="secondary"
                      off={!canWrite || editing !== null}
                      note={entryNote}
                      onClick={(event) => beginEntry(entry, event.currentTarget)}
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
                      Forget locally
                    </Button>
                  </div>
                </details>
              ))
            )}
          </div>
          <div className="fm-secrets-section">
            <GroupedPills
              name={SECRETS_WORDS.area}
              htmlName={areaId}
              value={area}
              options={SECRETS_AREAS}
              onChange={setArea}
            />
          </div>
          {area === "uses" && <Uses view={view} act={act} busy={busy} />}
          {area === "rules" && (
            <>
              <Rules view={view} act={act} busy={busy} />
              <ApprovalDevices view={view} act={act} busy={busy} />
            </>
          )}
          {area === "history" && <History view={view} act={act} busy={busy} refresh={refresh} />}
          {area === "recovery" && (
            <Recovery view={view} act={act} busy={busy || editing !== null} />
          )}
          <p className="fm-secrets-migration fm-secrets-muted">{SECRETS_WORDS.migration}</p>
        </>
      )}
      <SettingError error={error} surface="secrets" />
    </section>
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
  const [ref, setRef] = useState(entry?.ref ?? "");
  const [value, setValue] = useState("");
  const [environment, setEnvironment] = useState(entry?.environment ?? "");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const input: SecretEntryInput = {
      ...(ref ? { ref } : {}),
      label,
      value,
      environment,
      expectedVersion: entry?.version ?? 0,
      expectedRevision: entry?.revision ?? null,
    };
    const parsed = secretEntryInputSchema.safeParse(input);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      setError(
        field === "label"
          ? SECRETS_WORDS.nameRequired
          : field === "ref"
            ? SECRETS_WORDS.referenceInvalid
            : SECRETS_WORDS.valueRequired,
      );
      if (field === "ref") setAdvanced(true);
      requestAnimationFrame(() => {
        const id = `${prefix}-${field === "label" ? "name" : field === "ref" ? "ref" : "value"}`;
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
      <h3>{entry ? `${SECRETS_WORDS.replace}: ${entry.label}` : SECRETS_WORDS.add}</h3>
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
      <details
        open={advanced}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
        className="fm-secrets-advanced"
      >
        <summary>{SECRETS_WORDS.details}</summary>
        <div className="fm-secrets-optional-fields">
          <label htmlFor={`${prefix}-env`}>
            {SECRETS_WORDS.environment} (optional)
            <Input
              id={`${prefix}-env`}
              value={environment}
              disabled={busy}
              onChange={(event) => setEnvironment(event.target.value)}
              placeholder="For example, staging or production"
            />
          </label>
          <label htmlFor={`${prefix}-ref`}>
            {SECRETS_WORDS.reference}
            <Input
              id={`${prefix}-ref`}
              readOnly={!!entry}
              placeholder={entry ? undefined : "Created from the name when you save"}
              mono
              value={ref}
              disabled={busy}
              onChange={(event) => setRef(event.target.value)}
            />
          </label>
          <p className="fm-secrets-muted">
            {entry
              ? "The crew uses this stable reference to request the secret. Replacing the value keeps the same reference."
              : "Leave blank to create a readable reference from the name. Once saved, it does not change."}
          </p>
        </div>
      </details>
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

function Uses({
  view,
  act,
  busy,
}: {
  view: SecretsView;
  act: (action: SecretAction) => Promise<void>;
  busy: boolean;
}) {
  return (
    <section className="fm-secrets-area" aria-label="Secret uses">
      <h3>Requests</h3>
      {view.uses.length === 0 ? (
        <p className="fm-secrets-muted">
          No requests yet. When the crew needs a secret, its request appears here.
        </p>
      ) : (
        view.uses.map((use) => (
          <details key={use.request} className="fm-secrets-entry" open={use.state === "waiting"}>
            <summary>
              <strong>
                {use.secrets.length
                  ? use.secrets.map((secret) => secret.label).join(", ")
                  : use.recipient || "Secret request"}
              </strong>
              <span className="fm-secrets-request-state">{SECRET_STATE_WORDS[use.state]}</span>
            </summary>
            <p className="fm-secrets-mono">{use.recipient}</p>
            <p>{use.reason}</p>
            <CheckedFacts facts={use.facts} />
            {use.exitCode !== undefined && (
              <p className="fm-secrets-mono">Exit status {use.exitCode}</p>
            )}
            {use.state === "waiting" && (
              <div className="fm-secrets-actions">
                <Button
                  variant="secondary"
                  pending={busy}
                  onClick={() => void act({ kind: "review-use", request: use.request })}
                >
                  {SECRETS_WORDS.waiting}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void act({ kind: "cancel-use", request: use.request })}
                >
                  Cancel request
                </Button>
              </div>
            )}
          </details>
        ))
      )}
      <h3>{SECRETS_WORDS.temporaryAccess}</h3>
      {view.reads.length === 0 ? (
        <p className="fm-secrets-muted">{SECRETS_WORDS.noAccess}</p>
      ) : (
        view.reads.map((read) => (
          <div key={read.id} className="fm-secrets-row">
            <div>
              <strong>{read.label}</strong>
              <p className="fm-secrets-mono">{read.destination}</p>
              <p className="fm-secrets-mono">
                {read.remaining} uses left · ends {dateOf(read.expires)}
              </p>
            </div>
            <Button variant="secondary" onClick={() => void act({ kind: "end-read", id: read.id })}>
              {SECRETS_WORDS.end}
            </Button>
          </div>
        ))
      )}
    </section>
  );
}

function Rules({
  view,
  act,
  busy,
}: {
  view: SecretsView;
  act: (action: SecretAction) => Promise<void>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<Rule[]>(view.rules);
  const [rehearsal, setRehearsal] = useState<SecretRehearsal>(null);
  const id = useId();
  return (
    <section className="fm-secrets-area" aria-label="Secret rules">
      <h3>Permissions</h3>
      <p>
        New uses ask for approval. A saved permission covers one exact use; a block always wins.
      </p>
      {draft.map((rule, i) => (
        <div className="fm-secrets-rule" key={rule.id}>
          <label htmlFor={`${id}-secret-${i}`}>
            {SECRETS_WORDS.ruleSecret}
            <select
              id={`${id}-secret-${i}`}
              value={rule.secret}
              onChange={(event) =>
                setDraft((rows) =>
                  rows.map((row, at) => (at === i ? { ...row, secret: event.target.value } : row)),
                )
              }
            >
              <SecretChoices entries={view.entries} selected={rule.secret} />
            </select>
          </label>
          <label htmlFor={`${id}-effect-${i}`}>
            Rule
            <select
              id={`${id}-effect-${i}`}
              value={rule.effect}
              onChange={(event) =>
                setDraft((rows) =>
                  rows.map((row, at) =>
                    at === i ? { ...row, effect: event.target.value as Rule["effect"] } : row,
                  ),
                )
              }
            >
              <option value="ask">Ask each time</option>
              <option value="never">Never allow</option>
              <option value="allow">Allow this exact use</option>
            </select>
          </label>
          <label htmlFor={`${id}-operation-${i}`}>
            Applies to
            <select
              id={`${id}-operation-${i}`}
              value={rule.operation ?? ""}
              onChange={(event) =>
                setDraft((rows) =>
                  rows.map((row, at) =>
                    at === i ? { ...row, operation: event.target.value || undefined } : row,
                  ),
                )
              }
            >
              <option value="" disabled={rule.effect === "allow"}>
                {rule.effect === "allow" ? "Choose a rehearsed command" : "Every use"}
              </option>
              {rule.operation && rule.operation !== rehearsal?.operation && (
                <option value={rule.operation}>Saved exact operation</option>
              )}
              {rehearsal && <option value={rehearsal.operation}>Rehearsed command</option>}
            </select>
          </label>
          <Button
            variant="ghost"
            onClick={() => setDraft((rows) => rows.filter((_row, at) => at !== i))}
          >
            Remove rule
          </Button>
        </div>
      ))}
      <div className="fm-secrets-actions">
        <Button
          variant="secondary"
          off={view.entries.length === 0}
          note={view.entries.length === 0 ? "Add a secret first." : undefined}
          onClick={() =>
            setDraft((rows) => [
              ...rows,
              {
                id: crypto.randomUUID(),
                secret: view.entries[0]?.ref ?? "",
                effect: "ask",
                ...(rehearsal ? { operation: rehearsal.operation } : {}),
              },
            ])
          }
        >
          {SECRETS_WORDS.addRule}
        </Button>
        <Button
          variant="secondary"
          pending={busy}
          off={
            view.availability !== "available" ||
            draft.some((rule) => rule.effect === "allow" && !rule.operation)
          }
          note={
            view.availability !== "available"
              ? SECRETS_WORDS.unavailable
              : draft.some((rule) => rule.effect === "allow" && !rule.operation)
                ? "Allow needs the exact operation from a rehearsal."
                : undefined
          }
          onClick={() => void act({ kind: "save-rules", rules: draft })}
        >
          Review rule changes
        </Button>
      </div>
      <details className="fm-secrets-advanced">
        <summary>{SECRETS_WORDS.advancedPermissions}</summary>
        <Rehearsal onChecked={setRehearsal} />
      </details>
      {rehearsal && (
        <div className="fm-secrets-rehearsal" role="status">
          <h3>Rehearsal: {rehearsal.effect}</h3>
          <p>No program ran and no secret value was read.</p>
          <p>Choose Rehearsed command in a rule to use these checked facts.</p>
          <CheckedFacts facts={rehearsal.facts} />
        </div>
      )}
    </section>
  );
}

function CheckedFacts({ facts }: { facts: NonNullable<SecretRehearsal>["facts"] }) {
  const list = (rows: typeof facts) => (
    <dl className="fm-secrets-facts">
      {rows.map((fact) => (
        <div key={fact.name}>
          <dt>{fact.name}</dt>
          <dd className="fm-secrets-mono">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <>
      {list(facts.filter((fact) => SECRET_OVERVIEW_FACTS.includes(fact.name)))}
      <details>
        <summary>Checked files and delivery</summary>
        {list(facts)}
      </details>
    </>
  );
}

function Rehearsal({ onChecked }: { onChecked: (result: SecretRehearsal) => void }) {
  const id = useId();
  const [program, setProgram] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [mapping, setMapping] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const lines = mapping.split("\n").filter(Boolean);
    if (lines.some((line) => !line.includes("="))) {
      setError("Write one VARIABLE=reference on each line.");
      return;
    }
    const env = Object.fromEntries(
      lines.map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
    );
    const parsed = secretRehearsalInputSchema.safeParse({
      argv: [program, ...(args === "" ? [] : args.split("\n"))],
      cwd,
      env,
    });
    if (!parsed.success) {
      setError("Name a program, a working folder and valid references.");
      return;
    }
    setBusy(true);
    try {
      const result = await window.infinitary.secrets.rehearse(parsed.data);
      onChecked(result);
      if (!result) setError("This operation could not be checked. Nothing ran.");
    } catch {
      setError("This operation could not be checked. Nothing ran.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="fm-secrets-form"
      aria-label="Rehearsal"
      onSubmit={(event) => void check(event)}
    >
      <h3>Rehearse an exact command</h3>
      <p>This checks the program and rules without running it or reading a secret value.</p>
      <label htmlFor={`${id}-program`}>
        Program
        <Input
          id={`${id}-program`}
          mono
          required
          value={program}
          onChange={(event) => setProgram(event.target.value)}
          placeholder="/bin/sh"
        />
      </label>
      <label htmlFor={`${id}-args`}>
        Arguments, one per line
        <textarea
          id={`${id}-args`}
          value={args}
          onChange={(event) => setArgs(event.target.value)}
          placeholder="scripts/check-staging.sh"
        />
      </label>
      <label htmlFor={`${id}-cwd`}>
        Working folder
        <Input
          id={`${id}-cwd`}
          mono
          required
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
        />
      </label>
      <Button
        variant="ghost"
        type="button"
        onClick={() => {
          void window.infinitary.app.chooseFolder().then((folder) => {
            if (folder) setCwd(folder);
          });
        }}
      >
        Choose working folder
      </Button>
      <label htmlFor={`${id}-mapping`}>
        Variable to reference, one per line
        <textarea
          id={`${id}-mapping`}
          value={mapping}
          onChange={(event) => setMapping(event.target.value)}
          placeholder="SERVICE_TOKEN=staging-deploy"
        />
      </label>
      <SettingError error={error} surface="secret-rehearsal" />
      <Button variant="secondary" type="submit" pending={busy}>
        Rehearse without running
      </Button>
    </form>
  );
}

/** INF-1109's phone approvals (docs/secrets.md, "Remote decisions"): each enrolled device, and the way to stop it. */
function ApprovalDevices({
  view,
  act,
  busy,
}: {
  view: SecretsView;
  act: (action: SecretAction) => Promise<void>;
  busy: boolean;
}) {
  return (
    <section className="fm-secrets-area" aria-label={SECRETS_WORDS.devicesRegion}>
      <h3>{SECRETS_WORDS.devicesRegion}</h3>
      {view.devices.length === 0 ? (
        <p className="fm-secrets-muted">{SECRETS_WORDS.noDevices}</p>
      ) : (
        view.devices.map((device) => (
          <div key={device.device} className="fm-secrets-row">
            <div>
              <strong>{device.label}</strong>
              <p className="fm-secrets-mono">Code {device.code}</p>
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
  act: (action: SecretAction) => Promise<void>;
  busy: boolean;
  refresh: () => Promise<void>;
}) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <section className="fm-secrets-area" aria-label={SECRETS_WORDS.historyRegion}>
      <h3>History</h3>
      <p>{SECRETS_WORDS.history}</p>
      <p className="fm-secrets-mono">{view.historyBytes.toLocaleString()} bytes stored</p>
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
        view.history.map((item) => (
          <div className="fm-secrets-history" key={item.request}>
            <div className="fm-secrets-actions">
              <strong>{item.program}</strong>
              <span className="fm-secrets-mono">
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
            <p className="fm-secrets-mono">
              {item.secrets.join(", ")}
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

function Recovery({
  view,
  act,
  busy,
}: {
  view: SecretsView;
  act: (input: SecretAction) => Promise<void>;
  busy: boolean;
}) {
  const ready = view.recoveryAvailable && view.availability === "available";
  const restoreReady = view.recoveryAvailable && view.availability !== "locked";
  const waiting = "Finish the open secret form or current change first.";
  return (
    <section className="fm-secrets-area" aria-label={SECRETS_RECOVERY_WORDS.region}>
      <h3>Recovery</h3>
      {!view.recoveryAvailable && <p role="status">{SECRETS_RECOVERY_WORDS.unavailable}</p>}
      <div className="fm-secrets-recovery-choice">
        <div>
          <h3>Back up your secrets</h3>
          <p>
            Save an encrypted archive and a separate recovery key. Keep them apart: anyone with both
            can read the saved values.
          </p>
          <p className="fm-secrets-muted">
            There is no key reset. Never put the recovery key in a card or conversation.
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
          <h3>Restore from a backup</h3>
          <p>
            Restoring replaces stored values and clears permissions, phone approvals and temporary
            access. Running uses must finish first.
          </p>
          <p className="fm-secrets-muted">History stays. Recovered history cannot grant access.</p>
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
        Choose the files, then confirm with your computer. Cancelling confirmation changes nothing.
      </p>
      <details className="fm-secrets-advanced">
        <summary>About retained history</summary>
        <p>
          Old records stay even if a lost key means they can no longer be checked. Delete history
          only when you choose to.
        </p>
      </details>
    </section>
  );
}

function dateOf(at: number | null): string {
  return at === null ? "Not requested yet" : new Date(at).toLocaleString();
}
