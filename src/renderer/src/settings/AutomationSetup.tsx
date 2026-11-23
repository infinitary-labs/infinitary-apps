import {
  type AutomationRule,
  type AutomationSave,
  type AutomationSpec,
  scheduleDetailsFor,
} from "@shared/automation";
import {
  automationDateWords,
  automationZoneOf,
  automationZoneWords,
} from "@shared/automationWords";
import * as m from "@shared/i18n/messages.generated";
import type { ProjectView } from "@shared/tasks";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, GroupedChecks, Input } from "../design";
import { focusWithRing } from "../design/focus";
import {
  Facts,
  FIELD_STYLE,
  LABEL_STYLE,
  type Listenable,
  messageOf,
  NOTE_STYLE,
  SELECT_STYLE,
  TEXTAREA_STYLE,
  useListenable,
  useWhere,
} from "./automationParts";
import {
  AUTOMATION_MIN_MINUTES,
  eventRunsWords,
  hereZone,
  knownZones,
  localClockWords,
  previewPrompt,
  type RuleForm,
  reviewCanTurnOn,
  reviewFacts,
  saveOf,
  specOf,
  weekdayToggles,
} from "./automationWords";
import { ROW_GAP, SettingError } from "./settingRows";

/** The next dates the schedule makes, read for the spec they were read for. */
type Dates = { key: string; dates: number[] };

/** The Turn on step: the save it turns on, and what the rule will do. */
type Review = { save: AutomationSave; spec: AutomationSpec; dates: number[]; prompt: string };

/**
 * An automation's Setup (docs/automation.md, "The automation's page"): its
 * name and project, one When group whose caption reads the schedule live,
 * the prompt with its detail buttons, Preview, and a foot with Save or a
 * draft's Turn on…, and Delete at the far end. Turn on… replaces the body
 * with what turning it on means, Turn on and Back.
 */
export function AutomationSetup({
  initial,
  rule,
  projects,
  onSaved,
  onDeleted,
}: {
  initial: RuleForm;
  rule: AutomationRule | undefined;
  projects: readonly ProjectView[];
  onSaved: (rule: AutomationRule) => void;
  onDeleted: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const enableRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  // Back returns the keyboard to Turn on… once the foot is back.
  const [backToEnable, setBackToEnable] = useState(0);
  useEffect(() => {
    if (backToEnable > 0 && enableRef.current) focusWithRing(enableRef.current);
  }, [backToEnable]);
  const where = useWhere();
  const listenable = useListenable();
  const listened = listenable.find((one) => one.value === form.event);
  // A new rule and a draft are saved as drafts and turned on after a review.
  const drafting = rule === undefined || rule.state === "draft";
  // A stopped rule saves unchanged to listen to what is picked under When.
  const changed = JSON.stringify(form) !== JSON.stringify(initial);
  const saveable = drafting || changed || rule?.stopped !== undefined;
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setReview(null);
  };

  const spec = useMemo(() => specOf(form), [form]);
  // The schedule as text, so an edit elsewhere in the form reads no dates again.
  const schedule = typeof spec === "string" || spec.kind === "event" ? null : JSON.stringify(spec);
  const [dates, setDates] = useState<Dates | null>(null);
  useEffect(() => {
    if (schedule === null) return;
    let live = true;
    window.infinitary.automation
      .preview(JSON.parse(schedule) as AutomationSpec)
      .then(({ dates: next }) => live && setDates({ key: schedule, dates: next }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [schedule]);
  const shownDates = dates !== null && dates.key === schedule ? dates.dates : null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      if (!saveable) return;
      const request = saveOf(form);
      if (typeof request === "string") throw new Error(request);
      onSaved(await window.infinitary.automation.save(request));
    });
  const remove = () =>
    run(async () => {
      if (!rule) return;
      await window.infinitary.automation.delete(rule.id);
      onDeleted();
    });
  const openReview = () =>
    run(async () => {
      const request = saveOf(form, true);
      if (typeof request === "string") throw new Error(request);
      const { dates: next } = await window.infinitary.automation.preview(request.spec);
      setReview({
        save: request,
        spec: request.spec,
        dates: next,
        prompt: previewPrompt(request.spec, form.prompt, next, Date.now()),
      });
    });
  const closeReview = () => {
    setReview(null);
    setBackToEnable((count) => count + 1);
  };
  const turnOn = () =>
    run(async () => {
      if (!review) return;
      onSaved(await window.infinitary.automation.save(review.save));
    });

  // A detail goes in at the caret, and the caret lands after it in the prompt.
  const insertDetail = (token: string) => {
    const field = promptRef.current;
    const at = field?.selectionStart ?? form.prompt.length;
    const end = field?.selectionEnd ?? at;
    set("prompt", form.prompt.slice(0, at) + token + form.prompt.slice(end));
    requestAnimationFrame(() => {
      if (!field) return;
      field.focus();
      field.setSelectionRange(at + token.length, at + token.length);
    });
  };

  if (review !== null) {
    return (
      <ReviewPanel
        review={review}
        listened={listened}
        projects={projects}
        where={where}
        busy={busy}
        error={error}
        onTurnOn={() => void turnOn()}
        onBack={closeReview}
      />
    );
  }

  const caption =
    typeof spec === "string"
      ? spec
      : spec.kind === "event"
        ? eventRunsWords(listened?.every)
        : shownDates === null
          ? ""
          : shownDates.length === 0
            ? m.settingsAutomationPassed()
            : m.settingsAutomationPreviewNext({
                dates: shownDates
                  .map((at) => automationDateWords(at, automationZoneOf(spec)))
                  .join(" · "),
              });
  const calendar = form.kind === "daily" || form.kind === "weekly";
  return (
    <form
      aria-label={m.settingsAutomationSetup()}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: "var(--space-3)",
        }}
      >
        <div style={FIELD_STYLE}>
          <label htmlFor="automation-name" style={LABEL_STYLE}>
            {m.settingsAutomationName()}
          </label>
          <Input
            id="automation-name"
            value={form.name}
            maxLength={80}
            placeholder={m.settingsAutomationNamePlaceholder()}
            onChange={(event) => set("name", event.target.value)}
          />
        </div>
        <div style={FIELD_STYLE}>
          <label htmlFor="automation-project" style={LABEL_STYLE}>
            {m.settingsAutomationProject()}
          </label>
          <select
            id="automation-project"
            value={form.projectId}
            onChange={(event) => set("projectId", event.target.value)}
            style={SELECT_STYLE}
          >
            <option value="">{m.settingsAutomationNoProject()}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
            {form.projectId && !projects.some((project) => project.id === form.projectId) && (
              <option value={form.projectId}>{m.settingsAutomationRemovedProject()}</option>
            )}
          </select>
        </div>
      </div>
      <When
        form={form}
        setForm={(next) => {
          setForm(next);
          setReview(null);
        }}
        set={set}
        listenable={listenable}
        listened={listened}
        where={where}
        calendar={calendar}
        caption={caption}
      />
      <div style={FIELD_STYLE}>
        <label htmlFor="automation-prompt" style={LABEL_STYLE}>
          {m.settingsAutomationPrompt()}
        </label>
        <textarea
          id="automation-prompt"
          ref={promptRef}
          value={form.prompt}
          rows={4}
          placeholder={m.settingsAutomationPromptPlaceholder()}
          onChange={(event) => set("prompt", event.target.value)}
          style={TEXTAREA_STYLE}
        />
        <DetailButtons
          details={scheduleDetailsFor(form.kind)}
          onInsert={(token) => insertDetail(token)}
        />
      </div>
      <details data-automation-preview style={{ fontSize: "var(--text-sm)" }}>
        <summary style={{ cursor: "pointer", width: "fit-content", color: "var(--fg-2)" }}>
          {m.settingsAutomationPreview()}
        </summary>
        <div style={{ marginTop: "var(--space-2)" }}>
          {typeof spec === "string" ? (
            <span style={NOTE_STYLE}>{spec}</span>
          ) : !form.prompt.trim() ? (
            <span style={NOTE_STYLE}>{m.settingsAutomationWritePrompt()}</span>
          ) : (
            <Facts
              preview
              facts={reviewFacts(
                {
                  spec,
                  dates: shownDates ?? [],
                  prompt: previewPrompt(spec, form.prompt, shownDates ?? [], Date.now()),
                  projectId: form.projectId || undefined,
                  listened,
                },
                projects,
                where,
                { zoneNote: true },
              )}
            />
          )}
        </div>
      </details>
      <SettingError error={error} />
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
          paddingTop: "var(--space-3)",
          borderTop: "1px solid var(--line-1)",
        }}
      >
        {drafting ? (
          <>
            <Button
              ref={enableRef}
              type="button"
              variant="primary"
              disabled={busy}
              onClick={() => void openReview()}
              data-automation-enable
            >
              {m.settingsAutomationEnable()}
            </Button>
            <Button type="submit" variant="secondary" disabled={busy} data-automation-save>
              {m.settingsAutomationSaveDraft()}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !saveable}
              data-automation-save
            >
              {m.settingsAutomationSave()}
            </Button>
            {changed && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setForm(initial)}
                data-automation-discard
              >
                {m.settingsAutomationDiscard()}
              </Button>
            )}
          </>
        )}
        <span style={{ flex: 1 }} />
        {rule &&
          (confirmDelete ? (
            <DeleteForGood
              busy={busy}
              onDelete={() => void remove()}
              onCancel={(refocus) => {
                setConfirmDelete(false);
                if (refocus) requestAnimationFrame(() => deleteRef.current?.focus());
              }}
            />
          ) : (
            <Button
              ref={deleteRef}
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
              data-automation-delete
            >
              {m.settingsAutomationDelete()}
            </Button>
          ))}
      </div>
    </form>
  );
}

/** Delete's one question: it takes the keyboard, and Escape or leaving it takes it back. */
function DeleteForGood({
  busy,
  onDelete,
  onCancel,
}: {
  busy: boolean;
  onDelete: () => void;
  onCancel: (refocus: boolean) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (ref.current) focusWithRing(ref.current);
  }, []);
  return (
    <Button
      ref={ref}
      type="button"
      variant="danger"
      disabled={busy}
      onClick={onDelete}
      onKeyDown={(event) => {
        // Escape here answers the question, never closes Settings.
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel(true);
      }}
      onBlur={() => onCancel(false)}
      data-automation-delete-for-good
    >
      {m.settingsAutomationDeleteForGood()}
    </Button>
  );
}

/**
 * When, as one group: the kind and its parameters on one line with the time
 * zone, the weekdays, an event's filters and Only if, and one caption that
 * says what is missing, else the next runs, else how often Infinitary looks.
 */
function When({
  form,
  setForm,
  set,
  listenable,
  listened,
  where,
  calendar,
  caption,
}: {
  form: RuleForm;
  setForm: (form: RuleForm) => void;
  set: <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => void;
  listenable: Listenable[];
  listened: Listenable | undefined;
  where: string | null;
  calendar: boolean;
  caption: string;
}) {
  return (
    <fieldset
      aria-labelledby="automation-when-label"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        margin: 0,
        padding: 0,
        border: 0,
        minWidth: 0,
      }}
    >
      <label id="automation-when-label" htmlFor="automation-when" style={LABEL_STYLE}>
        {m.settingsAutomationWhen()}
      </label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          id="automation-when"
          value={form.kind}
          onChange={(event) => {
            const kind = event.target.value as AutomationSpec["kind"];
            // Chosen days always keep a zone: a rule that followed this
            // computer's clock takes this computer's zone, shown.
            setForm({
              ...form,
              kind,
              ...(kind === "weekly" && !form.timeZone ? { timeZone: hereZone() } : {}),
              // Something happening starts at the first event listed.
              ...(kind === "event" && !form.event ? { event: listenable[0]?.value ?? "" } : {}),
            });
          }}
          style={SELECT_STYLE}
        >
          <option value="every">{m.settingsAutomationKindEvery()}</option>
          <option value="daily">{m.settingsAutomationKindDaily()}</option>
          <option value="weekly">{m.settingsAutomationKindWeekly()}</option>
          <option value="once">{m.settingsAutomationKindOnce()}</option>
          {(listenable.length > 0 || form.kind === "event") && (
            <option value="event">{m.settingsAutomationKindEvent()}</option>
          )}
        </select>
        {form.kind === "event" && (
          <select
            aria-label={m.settingsAutomationWhatHappens()}
            data-automation-event
            value={form.event}
            onChange={(event) => setForm({ ...form, event: event.target.value, filter: {} })}
            style={SELECT_STYLE}
          >
            {listenable.map((one) => (
              <option key={one.value} value={one.value}>
                {one.label}
              </option>
            ))}
            {!listened && (
              <option value={form.event}>
                {form.event
                  ? m.settingsAutomationEventNotConnected()
                  : m.settingsAutomationNoEvents()}
              </option>
            )}
          </select>
        )}
        {form.kind === "every" && (
          <>
            <Input
              aria-label={m.settingsAutomationMinutesBetween()}
              type="number"
              min={AUTOMATION_MIN_MINUTES}
              value={form.minutes}
              onChange={(event) => set("minutes", event.target.value)}
              style={{ width: 90 }}
            />
            <span style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>
              {m.settingsAutomationMinutes()}
            </span>
          </>
        )}
        {calendar && (
          <Input
            aria-label={m.settingsAutomationTimeOfDay()}
            type="time"
            value={form.time}
            onChange={(event) => set("time", event.target.value)}
            style={{ width: 140 }}
          />
        )}
        {form.kind === "once" && (
          <Input
            aria-label={m.settingsAutomationDateAndTime()}
            type="datetime-local"
            value={form.at}
            onChange={(event) => set("at", event.target.value)}
            style={{ width: 220 }}
          />
        )}
        {calendar && (
          <ZoneSelect
            value={form.timeZone}
            where={where}
            onChange={(zone) => set("timeZone", zone)}
          />
        )}
      </div>
      {form.kind === "weekly" && (
        <Weekdays days={form.days} onChange={(days) => set("days", days)} />
      )}
      {form.kind === "event" && listened?.filters && listened.filters.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: "var(--space-2) var(--space-3)",
          }}
        >
          {listened.filters.map((field) => (
            <label
              key={field.name}
              htmlFor={`automation-filter-${field.name}`}
              style={{ ...FIELD_STYLE, ...LABEL_STYLE }}
            >
              {field.label}
              <Input
                id={`automation-filter-${field.name}`}
                aria-label={field.label}
                placeholder={field.defaultValue}
                value={form.filter[field.name] ?? ""}
                onChange={(event) =>
                  set("filter", { ...form.filter, [field.name]: event.target.value })
                }
              />
            </label>
          ))}
        </div>
      )}
      {form.kind === "event" && (
        <div style={FIELD_STYLE}>
          <label htmlFor="automation-waits-for" style={LABEL_STYLE}>
            {m.automationWaitsFor()}
          </label>
          <Input
            id="automation-waits-for"
            placeholder={m.automationWaitsForPlaceholder()}
            value={form.waitsFor}
            onChange={(event) => set("waitsFor", event.target.value)}
          />
        </div>
      )}
      <span data-automation-when-caption aria-live="polite" style={NOTE_STYLE}>
        {caption}
      </span>
    </fieldset>
  );
}

/**
 * One button per schedule detail, one Tab stop with the arrow keys, Home and
 * End between them; a press puts the detail in the prompt at its caret.
 */
function DetailButtons({
  details,
  onInsert,
}: {
  details: readonly { id: string; label: string; token: string }[];
  onInsert: (token: string) => void;
}) {
  const [at, setAt] = useState(0);
  const row = useRef<HTMLDivElement>(null);
  const current = Math.min(at, details.length - 1);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const last = details.length - 1;
    const to =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : (current + (event.key === "ArrowRight" ? 1 : -1) + details.length) % details.length;
    setAt(to);
    row.current?.querySelectorAll<HTMLElement>("button")[to]?.focus();
  };
  if (details.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span style={NOTE_STYLE}>{m.settingsAutomationInsert()}</span>
      <div
        ref={row}
        role="toolbar"
        aria-label={m.settingsAutomationInsertDetail()}
        data-automation-detail
        onKeyDown={onKeyDown}
        style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
      >
        {details.map((detail, index) => (
          <Button
            key={detail.id}
            type="button"
            variant="secondary"
            size="sm"
            tabIndex={index === current ? 0 : -1}
            onFocus={() => setAt(index)}
            onClick={() => onInsert(detail.token)}
            data-automation-detail-insert={detail.id}
          >
            {detail.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * The Turn on step (docs/automation.md, "Drafts"): before a rule runs, the
 * captain reads its schedule, zone, project, the exact prompt, the next
 * dates, what it sends and what happens to a missed time. Turn on runs it;
 * Back returns to Setup with nothing changed.
 */
function ReviewPanel({
  review,
  listened,
  projects,
  where,
  busy,
  error,
  onTurnOn,
  onBack,
}: {
  review: Review;
  listened: Listenable | undefined;
  projects: readonly ProjectView[];
  where: string | null;
  busy: boolean;
  error: string | null;
  onTurnOn: () => void;
  onBack: () => void;
}) {
  // The step opens with the keyboard on Turn on, so Enter turns it on.
  const turnOnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (turnOnRef.current) focusWithRing(turnOnRef.current);
  }, []);
  return (
    <section
      aria-label={m.settingsAutomationTurnOnLabel()}
      data-automation-review
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
    >
      <div style={{ fontSize: "var(--text-md)", color: "var(--fg-1)", fontWeight: 500 }}>
        {m.settingsAutomationTurnOnQuestion()}
      </div>
      <Facts
        facts={reviewFacts(
          { ...review, projectId: review.save.projectId, listened },
          projects,
          where,
          { zoneNote: true },
        )}
      />
      <SettingError error={error} />
      <div
        style={{
          display: "flex",
          gap: 8,
          paddingTop: "var(--space-3)",
          borderTop: "1px solid var(--line-1)",
        }}
      >
        <Button
          ref={turnOnRef}
          type="button"
          variant="primary"
          disabled={busy || !reviewCanTurnOn(review.spec, review.dates)}
          onClick={onTurnOn}
          data-automation-turn-on
        >
          {m.settingsAutomationTurnOn()}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
          {m.settingsAutomationBack()}
        </Button>
      </div>
    </section>
  );
}

function Weekdays({ days, onChange }: { days: number[]; onChange: (days: number[]) => void }) {
  return (
    <div data-automation-days style={{ alignSelf: "flex-start" }}>
      <GroupedChecks
        name="Days"
        values={days.map(String)}
        options={weekdayToggles().map(({ day, label, name }) => ({
          value: String(day),
          label,
          ariaLabel: name,
        }))}
        onChange={(values) => onChange(values.map(Number))}
      />
    </div>
  );
}

/**
 * Every zone the platform knows, by city, this computer's first; a rule
 * that follows this computer's clock keeps that choice until another is
 * picked.
 */
function ZoneSelect({
  value,
  where,
  onChange,
}: {
  value: string;
  where: string | null;
  onChange: (zone: string) => void;
}) {
  const here = hereZone();
  const zones = useMemo(
    () =>
      knownZones()
        .filter((zone) => zone !== here)
        .map((zone) => ({ zone, words: automationZoneWords(zone) }))
        .sort((a, b) => a.words.localeCompare(b.words)),
    [here],
  );
  return (
    <select
      id="automation-zone"
      aria-label={m.settingsAutomationTimeZone()}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={SELECT_STYLE}
    >
      {value === "" && <option value="">{localClockWords(where)}</option>}
      <option value={here}>
        {m.settingsAutomationZoneThisComputer({ zone: automationZoneWords(here) })}
      </option>
      {value !== "" && value !== here && !zones.some((one) => one.zone === value) && (
        <option value={value}>{automationZoneWords(value)}</option>
      )}
      {zones.map(({ zone, words }) => (
        <option key={zone} value={zone}>
          {words}
        </option>
      ))}
    </select>
  );
}
