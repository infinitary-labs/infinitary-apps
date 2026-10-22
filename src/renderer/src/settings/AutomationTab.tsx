import {
  AUTOMATION_UNREADABLE,
  type AutomationList,
  type AutomationRule,
  type AutomationRun,
  type AutomationSave,
  type AutomationSpec,
  fillScheduleDetails,
  SCHEDULE_DETAILS,
  scheduleDetailsFor,
} from "@shared/automation";
import {
  AUTOMATION_EVENT_UNKNOWN,
  AUTOMATION_STATE_TONES,
  AUTOMATION_STATE_WORDS,
  automationDateWords,
  automationEventWords,
  automationNextWords,
  automationRuleTitle,
  automationWhenWords,
  automationZoneOf,
  automationZoneWords,
} from "@shared/automationWords";
import type { IntegrationsView } from "@shared/integrations";
import type { ProjectView } from "@shared/tasks";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShellStore } from "../app/store";
import { KeyedText } from "../cards/TaskKey";
import { Button, GroupedChecks, Input, Row, StatusDot } from "../design";
import { focusWithRing } from "../design/focus";
import { isView } from "../devices/viewWords";
import { appReadExecutor } from "../plugins/reads/appExecutor";
import {
  AUTOMATION_MIN_MINUTES,
  blankForm,
  DELIVERY_TONES,
  DELIVERY_WORDS,
  DETAIL_NOTE,
  DRAFT_NOTE,
  deliveryNote,
  EVENTS_PREVIEW,
  eventPreviewWords,
  formOf,
  hereZone,
  knownZones,
  localClockWords,
  localTimeNote,
  lookWords,
  REVIEW_SENDS,
  REVIEW_SENDS_EVENTS,
  type RuleForm,
  reviewMissedWords,
  runWords,
  SUBMITTED_NOTE,
  SUBMITTED_NOTE_EVENTS,
  saveOf,
  specOf,
  WEEKDAY_TOGGLES,
  zoneNote,
} from "./automationWords";
import { LABEL_GAP, ROW_GAP, SettingError } from "./settingRows";

/**
 * The computer Firstmate lives on, by its name, when this one controls it:
 * the automations run there (docs/view.md). Null on that computer itself.
 */
function useWhere(): string | null {
  return useShellStore((s) => (isView(s.thisMac) ? s.thisMac.name : null));
}

/** One event a rule may listen for, as the When choice lists it. */
type Listenable = {
  /** `integration/event`, as the form keeps it. */
  value: string;
  /** "When an item arrives in Stand-in". */
  when: string;
  /** "An item arrives in Stand-in". */
  label: string;
  every: number;
  filters?: { name: string; label: string; defaultValue?: string }[];
};

/**
 * The events each connected integration can tell (docs/automation.md,
 * "Events"), for the When choice; none where the integrations cannot be read.
 */
function useListenable(): Listenable[] {
  const [view, setView] = useState<IntegrationsView | null>(null);
  useEffect(() => {
    let live = true;
    window.infinitary.integrations
      .list()
      .then((next) => live && setView(next))
      .catch(() => {});
    const off = window.infinitary.integrations.onChange((next) => setView(next));
    return () => {
      live = false;
      off();
    };
  }, []);
  return (view?.integrations ?? []).flatMap((integration) =>
    (integration.events ?? []).map((event) => ({
      value: `${integration.id}/${event.name}`,
      when: automationEventWords(event.label, integration.name),
      label: `${event.label} in ${integration.name}`,
      every: event.every,
      filters: event.filters,
    })),
  );
}

/**
 * Settings → Automation (docs/automation.md): the schedules Firstmate runs,
 * as rules. The left column lists them; the right is the selected rule's
 * sheet, where it is edited, previewed, saved as a draft, reviewed and
 * turned on, paused or resumed, deleted, and its history read. The same
 * rules are made by asking Firstmate, and the Automation panel opens a
 * rule's sheet here (`settingsItem`). A computer that controls Firstmate
 * on another shows and changes the same rules, which run over there.
 */
export function AutomationTab() {
  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const arrival = useShellStore((s) =>
    s.settingsItem?.section === "automation" ? s.settingsItem.item : null,
  );
  const sheetRef = useRef<HTMLDivElement>(null);
  const [focusSheet, setFocusSheet] = useState(0);

  useEffect(
    () =>
      appReadExecutor().subscribe(
        "automation.list",
        {},
        {
          onValue: (value) => {
            const list = value as AutomationList;
            setFailed(list.state === "unavailable");
            // Unreadable is not empty: the rules as last read stay.
            if (list.state === "ready" || list.rules.length > 0) setRules(list.rules);
          },
          onError: () => setFailed(true),
        },
      ),
    [],
  );
  useEffect(
    () =>
      appReadExecutor().subscribe(
        "projects.list",
        {},
        {
          onValue: (value) =>
            setProjects((value as ProjectView[]).filter((project) => !project.archived)),
          onError: () => {},
        },
      ),
    [],
  );

  // A rule a panel row opened: select it once the list holds it, and put
  // the keyboard in its sheet.
  useEffect(() => {
    if (arrival === null || rules === null) return;
    useShellStore.getState().clearSettingsItem();
    if (!rules.some((rule) => rule.id === arrival)) return;
    setSearch("");
    setError(null);
    setSelected(arrival);
    setFocusSheet((count) => count + 1);
  }, [arrival, rules]);
  useEffect(() => {
    if (focusSheet === 0) return;
    const first = sheetRef.current?.querySelector<HTMLElement>("input, select, textarea");
    if (first) focusWithRing(first);
  }, [focusSheet]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (rules ?? []).filter(
      (rule) =>
        !needle ||
        `${rule.name ?? ""} ${rule.prompt}`.toLowerCase().includes(needle) ||
        automationWhenWords(rule.spec, rule.when).toLowerCase().includes(needle),
    );
  }, [rules, search]);
  const current = rules?.find((rule) => rule.id === selected);
  const running = (rules ?? []).some((rule) => rule.state === "enabled");

  const pauseAll = () => {
    setError(null);
    window.infinitary.automation.pauseAll().catch((caught) => setError(messageOf(caught)));
  };

  return (
    <div data-automation style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "var(--text-md)", color: "var(--fg-1)", fontWeight: 500 }}>
            Automation
          </div>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
            Prompts your first mate gets on a schedule. You can also ask your first mate to set one
            up.
          </div>
        </div>
        <Button
          variant="secondary"
          disabled={!running}
          onClick={pauseAll}
          data-automation-pause-all
        >
          Pause all
        </Button>
      </div>
      <SettingError error={error} />
      {failed && <SettingError error={AUTOMATION_UNREADABLE} />}
      <div style={{ display: "grid", gridTemplateColumns: "300px minmax(0, 1fr)", gap: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: LABEL_GAP, minWidth: 0 }}>
          <Input
            aria-label="Search automations"
            placeholder="Search automations"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button
            variant="secondary"
            onClick={() => setSelected("new")}
            data-automation-new
            style={{ justifyContent: "center" }}
          >
            New automation
          </Button>
          <ul
            aria-label="Automations"
            style={{
              display: "flex",
              flexDirection: "column",
              listStyle: "none",
              margin: 0,
              padding: 0,
            }}
          >
            {shown.map((rule) => (
              <li key={rule.id} data-automation-row={rule.id}>
                <Row
                  title={automationRuleTitle(rule)}
                  tone={AUTOMATION_STATE_TONES[rule.state]}
                  toneLabel={AUTOMATION_STATE_WORDS[rule.state]}
                  trailing={automationNextWords(rule)}
                  selected={selected === rule.id}
                  onClick={() => {
                    setError(null);
                    setSelected(rule.id);
                  }}
                />
              </li>
            ))}
          </ul>
          {rules !== null && rules.length === 0 && (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
              No automations yet. Make one here, or tell your first mate what to run and when.
            </div>
          )}
          {rules !== null && rules.length > 0 && shown.length === 0 && (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>Nothing matches.</div>
          )}
        </div>
        <div ref={sheetRef} style={{ minWidth: 0 }}>
          {selected === "new" && (
            <Sheet
              key="new"
              initial={blankForm()}
              rule={undefined}
              projects={projects}
              onSaved={(rule) => setSelected(rule.id)}
              onDeleted={() => setSelected(null)}
            />
          )}
          {current && (
            <Sheet
              key={`${current.id}-${current.revision}-${current.state}`}
              initial={formOf(current)}
              rule={current}
              projects={projects}
              onSaved={(rule) => setSelected(rule.id)}
              onDeleted={() => setSelected(null)}
            />
          )}
          {/* Nothing picked, or the picked rule is gone: a one-time rule leaves once it ran. */}
          {selected !== "new" && !current && (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
              Pick an automation to read or change it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const LABEL_STYLE = { fontSize: "var(--text-sm)", color: "var(--fg-2)", fontWeight: 500 } as const;
const FIELD_STYLE = { display: "flex", flexDirection: "column", gap: 4 } as const;
const NOTE_STYLE = { fontSize: "var(--text-xs)", color: "var(--fg-3)" } as const;
const SELECT_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
  background: "var(--surface-input)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-m)",
  padding: "9px 10px",
  minWidth: 0,
};

type Preview = { dates: number[]; prompt: string; timeZone: string | undefined };

/** The review before Turn on: the save it turns on, and what the rule will do. */
type Review = Preview & { save: AutomationSave; spec: AutomationSpec; listened?: Listenable };

function Sheet({
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
  const [preview, setPreview] = useState<Preview | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const enableRef = useRef<HTMLButtonElement>(null);
  // Back returns the keyboard to Enable once the sheet's buttons are back.
  const [backToEnable, setBackToEnable] = useState(0);
  useEffect(() => {
    if (backToEnable > 0 && enableRef.current) focusWithRing(enableRef.current);
  }, [backToEnable]);
  const where = useWhere();
  const listenable = useListenable();
  const listened = listenable.find((one) => one.value === form.event);
  // A new rule and a draft are saved as drafts and turned on after a review.
  const drafting = rule === undefined || rule.state === "draft";
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setPreview(null);
    setReview(null);
  };

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

  // The next dates and the prompt as it is sent the first time; sends nothing.
  const previewOf = async (spec: AutomationSpec): Promise<Preview> => {
    const { dates } = await window.infinitary.automation.preview(spec);
    const timeZone = automationZoneOf(spec);
    const first = spec.kind === "event" ? Date.now() : dates[0];
    return {
      dates,
      timeZone,
      prompt:
        first === undefined
          ? form.prompt.trim()
          : fillScheduleDetails(form.prompt.trim(), {
              plannedAt: first,
              timeZone: timeZone ?? hereZone(),
              missed: 0,
              ...(spec.kind === "event" ? { events: EVENTS_PREVIEW } : {}),
            }),
    };
  };

  const save = () =>
    run(async () => {
      const request = saveOf(form);
      if (typeof request === "string") throw new Error(request);
      onSaved(await window.infinitary.automation.save(request));
    });
  const toggle = () =>
    run(async () => {
      if (!rule) return;
      await window.infinitary.automation.setState(
        rule.id,
        rule.state === "enabled" ? "pause" : "resume",
      );
    });
  const remove = () =>
    run(async () => {
      if (!rule) return;
      await window.infinitary.automation.delete(rule.id);
      onDeleted();
    });
  const showPreview = () =>
    run(async () => {
      const spec = specOf(form);
      if (typeof spec === "string") throw new Error(spec);
      setPreview(await previewOf(spec));
    });
  // Enable: the review of what turning it on means, with Turn on in reach.
  const openReview = () =>
    run(async () => {
      const request = saveOf(form, true);
      if (typeof request === "string") throw new Error(request);
      setPreview(null);
      setReview({
        ...(await previewOf(request.spec)),
        save: request,
        spec: request.spec,
        ...(listened ? { listened } : {}),
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

  // Insert schedule detail: its placeholder goes in at the caret, and the
  // caret lands after it.
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

  const calendar = form.kind === "daily" || form.kind === "weekly";
  return (
    <form
      aria-label="Automation"
      data-automation-sheet={rule?.id ?? "new"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: ROW_GAP,
        padding: 18,
        background: "var(--bg-1)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-m)",
      }}
    >
      {rule && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
          {AUTOMATION_STATE_WORDS[rule.state]} · {automationWhenWords(rule.spec, rule.when)}
          {rule.captainRequested ? "" : " · set up by your first mate"}
        </div>
      )}
      {drafting && (
        <div data-automation-draft-note style={NOTE_STYLE}>
          {DRAFT_NOTE}
        </div>
      )}
      <div style={FIELD_STYLE}>
        <label htmlFor="automation-name" style={LABEL_STYLE}>
          Name
        </label>
        <Input
          id="automation-name"
          value={form.name}
          maxLength={80}
          placeholder="Weekly review"
          onChange={(event) => set("name", event.target.value)}
        />
      </div>
      <div style={FIELD_STYLE}>
        <label htmlFor="automation-when" style={LABEL_STYLE}>
          When
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select
            id="automation-when"
            value={form.kind}
            onChange={(event) => {
              const kind = event.target.value as AutomationSpec["kind"];
              // Chosen days always keep a zone: a rule that followed this
              // computer's clock takes this computer's zone, shown.
              setForm((prev) => ({
                ...prev,
                kind,
                ...(kind === "weekly" && !prev.timeZone ? { timeZone: hereZone() } : {}),
                // Something happening starts at the first event listed.
                ...(kind === "event" && !prev.event ? { event: listenable[0]?.value ?? "" } : {}),
              }));
              setPreview(null);
              setReview(null);
            }}
            style={SELECT_STYLE}
          >
            <option value="every">Repeats</option>
            <option value="daily">Every day</option>
            <option value="weekly">On chosen days</option>
            <option value="once">Once</option>
            {(listenable.length > 0 || form.kind === "event") && (
              <option value="event">When something happens</option>
            )}
          </select>
          {form.kind === "event" && (
            <select
              aria-label="What happens"
              data-automation-event
              value={form.event}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, event: event.target.value, filter: {} }))
              }
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
                    ? "An integration not connected now"
                    : "Nothing connected tells events"}
                </option>
              )}
            </select>
          )}
          {form.kind === "event" &&
            listened?.filters?.map((field) => (
              <label
                key={field.name}
                htmlFor={`automation-filter-${field.name}`}
                style={LABEL_STYLE}
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
          {form.kind === "every" && (
            <>
              <Input
                aria-label="Minutes between runs"
                type="number"
                min={AUTOMATION_MIN_MINUTES}
                value={form.minutes}
                onChange={(event) => set("minutes", event.target.value)}
                style={{ width: 90 }}
              />
              <span style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>minutes</span>
            </>
          )}
          {calendar && (
            <Input
              aria-label="Time of day"
              type="time"
              value={form.time}
              onChange={(event) => set("time", event.target.value)}
              style={{ width: 140 }}
            />
          )}
          {form.kind === "once" && (
            <Input
              aria-label="Date and time"
              type="datetime-local"
              value={form.at}
              onChange={(event) => set("at", event.target.value)}
              style={{ width: 220 }}
            />
          )}
        </div>
        {form.kind === "weekly" && (
          <Weekdays days={form.days} onChange={(days) => set("days", days)} />
        )}
      </div>
      {calendar && (
        <div style={FIELD_STYLE}>
          <label htmlFor="automation-zone" style={LABEL_STYLE}>
            Time zone
          </label>
          <ZoneSelect
            value={form.timeZone}
            where={where}
            onChange={(zone) => set("timeZone", zone)}
          />
          <span style={NOTE_STYLE}>{form.timeZone ? zoneNote(where) : localTimeNote(where)}</span>
        </div>
      )}
      <div style={FIELD_STYLE}>
        <label htmlFor="automation-project" style={LABEL_STYLE}>
          Project
        </label>
        <select
          id="automation-project"
          value={form.projectId}
          onChange={(event) => set("projectId", event.target.value)}
          style={SELECT_STYLE}
        >
          <option value="">No project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
          {form.projectId && !projects.some((project) => project.id === form.projectId) && (
            <option value={form.projectId}>A removed project</option>
          )}
        </select>
      </div>
      <div style={FIELD_STYLE}>
        <label htmlFor="automation-prompt" style={LABEL_STYLE}>
          Tell your first mate
        </label>
        <textarea
          id="automation-prompt"
          ref={promptRef}
          value={form.prompt}
          rows={4}
          placeholder="Review my open tasks and suggest this week's priorities."
          onChange={(event) => set("prompt", event.target.value)}
          style={{
            fontFamily: "var(--font-ui)",
            fontSize: "var(--text-base)",
            color: "var(--fg-1)",
            background: "var(--surface-input)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-m)",
            padding: "9px 14px",
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select
            aria-label="Insert schedule detail"
            data-automation-detail
            value=""
            onChange={(event) => {
              const detail = SCHEDULE_DETAILS.find((one) => one.id === event.target.value);
              if (detail) insertDetail(detail.token);
            }}
            style={{ ...SELECT_STYLE, fontSize: "var(--text-sm)", padding: "5px 8px" }}
          >
            <option value="">Insert schedule detail…</option>
            {scheduleDetailsFor(form.kind).map((detail) => (
              <option key={detail.id} value={detail.id}>
                {detail.label}
              </option>
            ))}
          </select>
          <span style={NOTE_STYLE}>{DETAIL_NOTE}</span>
        </div>
        <span style={NOTE_STYLE}>
          {form.kind === "event" ? SUBMITTED_NOTE_EVENTS : SUBMITTED_NOTE}
        </span>
      </div>
      {preview !== null && (
        <div
          data-automation-preview
          style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--text-sm)" }}
        >
          <div style={{ color: "var(--fg-2)" }}>
            {form.kind === "event"
              ? eventPreviewWords(listened?.when ?? AUTOMATION_EVENT_UNKNOWN, listened?.every)
              : preview.dates.length === 0
                ? "That time has already passed."
                : `Next: ${preview.dates.map((at) => automationDateWords(at, preview.timeZone)).join(" · ")}. Nothing is sent.`}
          </div>
          {preview.prompt && <PromptBox prompt={preview.prompt} preview />}
        </div>
      )}
      {review !== null && (
        <ReviewPanel
          review={review}
          projects={projects}
          where={where}
          busy={busy}
          onTurnOn={() => void turnOn()}
          onBack={closeReview}
        />
      )}
      <SettingError error={error} />
      {review === null && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
                Enable…
              </Button>
              <Button type="submit" variant="secondary" disabled={busy} data-automation-save>
                Save draft
              </Button>
            </>
          ) : (
            <Button type="submit" variant="primary" disabled={busy} data-automation-save>
              Save
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => void showPreview()}
          >
            Preview
          </Button>
          {rule && (rule.state === "enabled" || rule.state === "paused") && (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void toggle()}>
              {rule.state === "enabled" ? "Pause" : "Resume"}
            </Button>
          )}
          {rule &&
            (confirmDelete ? (
              <Button type="button" variant="danger" disabled={busy} onClick={() => void remove()}>
                Delete for good
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            ))}
        </div>
      )}
      {rule && <History id={rule.id} />}
    </form>
  );
}

/** The prompt exactly as Firstmate gets it. */
function PromptBox({ prompt, preview = false }: { prompt: string; preview?: boolean }) {
  return (
    <div
      {...(preview ? { "data-automation-preview-prompt": "" } : {})}
      style={{
        color: "var(--fg-2)",
        whiteSpace: "pre-wrap",
        padding: "8px 10px",
        background: "var(--bg-2)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-s)",
      }}
    >
      {prompt}
    </div>
  );
}

/**
 * Enable's review (docs/automation.md, "Drafts"): before a rule runs, the
 * captain reads its schedule, zone, project, the exact prompt, the next
 * dates, what it sends and what happens to a missed time. Turn on runs it;
 * Back returns to the sheet with nothing changed.
 */
function ReviewPanel({
  review,
  projects,
  where,
  busy,
  onTurnOn,
  onBack,
}: {
  review: Review;
  projects: readonly ProjectView[];
  where: string | null;
  busy: boolean;
  onTurnOn: () => void;
  onBack: () => void;
}) {
  // The review opens with the keyboard on Turn on, so Enter turns it on.
  const turnOnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (turnOnRef.current) focusWithRing(turnOnRef.current);
  }, []);
  const zone = automationZoneOf(review.spec);
  const calendar = review.spec.kind === "daily" || review.spec.kind === "weekly";
  const project = review.save.projectId
    ? (projects.find((one) => one.id === review.save.projectId)?.name ?? "A removed project")
    : "No project";
  const event = review.spec.kind === "event";
  const facts: [string, React.ReactNode][] = [
    ["When", automationWhenWords(review.spec, review.listened?.when)],
    ...(calendar
      ? ([["Time zone", zone ? automationZoneWords(zone) : localClockWords(where)]] as [
          string,
          React.ReactNode,
        ][])
      : []),
    ...(review.spec.kind === "event"
      ? (review.listened?.filters ?? []).map(
          (field) =>
            [
              field.label,
              review.spec.kind === "event"
                ? review.spec.filter?.[field.name] || field.defaultValue || "Not specified"
                : "",
            ] as [string, React.ReactNode],
        )
      : []),
    ["Project", project],
    event
      ? ["Runs", `Each time new events arrive. ${lookWords(review.listened?.every)}`.trim()]
      : [
          review.spec.kind === "once" ? "Runs" : "Next runs",
          review.dates.length === 0
            ? "That time has already passed."
            : review.dates.map((at) => automationDateWords(at, review.timeZone)).join(" · "),
        ],
    ["Your first mate gets", <PromptBox key="prompt" prompt={review.prompt} />],
    ["What it sends", event ? REVIEW_SENDS_EVENTS : REVIEW_SENDS],
    ["A missed time", reviewMissedWords(review.spec, where)],
  ];
  return (
    <section
      aria-label="Turn on this automation"
      data-automation-review
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        padding: "var(--space-4)",
        border: "1px solid var(--line-2)",
        borderRadius: "var(--radius-m)",
        background: "var(--bg-2)",
      }}
    >
      <div style={{ fontSize: "var(--text-md)", color: "var(--fg-1)", fontWeight: 500 }}>
        Turn on this automation?
      </div>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "120px minmax(0, 1fr)",
          gap: "var(--space-2) var(--space-3)",
          margin: 0,
          fontSize: "var(--text-sm)",
        }}
      >
        {facts.map(([term, value]) => (
          <div key={term} style={{ display: "contents" }}>
            <dt style={{ color: "var(--fg-3)" }}>{term}</dt>
            <dd style={{ margin: 0, color: "var(--fg-1)", minWidth: 0 }}>{value}</dd>
          </div>
        ))}
      </dl>
      <div style={{ display: "flex", gap: 8 }}>
        <Button
          ref={turnOnRef}
          type="button"
          variant="primary"
          disabled={busy || (!event && review.dates.length === 0)}
          onClick={onTurnOn}
          data-automation-turn-on
        >
          Turn on
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
          Back
        </Button>
      </div>
    </section>
  );
}

/** The weekdays a rule runs on: one pill each, any number chosen. */
function Weekdays({ days, onChange }: { days: number[]; onChange: (days: number[]) => void }) {
  return (
    <div data-automation-days style={{ alignSelf: "flex-start" }}>
      <GroupedChecks
        name="Days"
        values={days.map(String)}
        options={WEEKDAY_TOGGLES.map(({ day, label, name }) => ({
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
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={{ ...SELECT_STYLE, alignSelf: "flex-start" }}
    >
      {value === "" && <option value="">{localClockWords(where)}</option>}
      <option value={here}>{automationZoneWords(here)} · this computer</option>
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

/**
 * A rule's runs, newest first (docs/automation.md, "Deliveries"): each with
 * where its delivery stands - waiting, retrying, handled or cancelled - why
 * it was cancelled, and the tasks and cards the turn that handled it led to.
 */
function History({ id }: { id: string }) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  useEffect(
    () =>
      appReadExecutor().subscribe(
        "automation.history",
        { id },
        { onValue: (value) => setRuns(value as AutomationRun[]), onError: () => setRuns([]) },
      ),
    [id],
  );
  return (
    <div data-automation-history>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", fontWeight: 500 }}>
        History
      </div>
      {runs === null || runs.length === 0 ? (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>Nothing has run yet.</div>
      ) : (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
          }}
        >
          {runs.map((run) => (
            <HistoryRow key={run.id} run={run} />
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryRow({ run }: { run: AutomationRun }) {
  const note = deliveryNote(run);
  return (
    <li
      data-automation-run={run.id}
      data-delivery={run.delivery}
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr)",
        columnGap: "var(--space-2)",
        alignItems: "start",
        fontSize: "var(--text-sm)",
        color: "var(--fg-3)",
      }}
    >
      {/* One line tall, so the dot sits beside the first line. */}
      <span style={{ display: "flex", alignItems: "center", height: "1lh" }}>
        <StatusDot
          tone={DELIVERY_TONES[run.delivery]}
          label={DELIVERY_WORDS[run.delivery]}
          nativeTitle={false}
        />
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
        <div>
          <span style={{ color: "var(--fg-1)" }}>{DELIVERY_WORDS[run.delivery]}</span> ·{" "}
          {runWords(run)} · version {run.revision}
        </div>
        {note && <div>{note}</div>}
        {(run.tasks.length > 0 || run.cards.length > 0) && (
          <div
            data-automation-run-work
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0 var(--space-3)",
              alignItems: "baseline",
            }}
          >
            <span>Led to</span>
            {run.tasks.map((task) => (
              <span key={task.id} data-automation-run-task={task.id}>
                <KeyedText text={`${task.key} ${task.title}`} />
              </span>
            ))}
            {run.cards.map((card) => (
              <Button
                key={card.id}
                type="button"
                variant="ghost"
                size="sm"
                data-automation-run-card={card.id}
                onClick={() => openCard(card)}
              >
                {card.open ? `Card: ${card.title}` : `Past card: ${card.title}`}
              </Button>
            ))}
          </div>
        )}
        <details data-automation-run-prompt>
          <summary style={{ cursor: "pointer", width: "fit-content" }}>Prompt as sent</summary>
          <div style={{ marginTop: "var(--space-1)" }}>
            <PromptBox prompt={run.prompt} />
          </div>
        </details>
      </div>
    </li>
  );
}

/** A card a delivery led to, on the main view: forward while it is up, else as it closed. */
function openCard(card: AutomationRun["cards"][number]): void {
  const shell = useShellStore.getState();
  shell.setView("home");
  if (card.open && shell.focusCard(card.id)) return;
  shell.openPastCard(card.id);
}

function messageOf(caught: unknown): string {
  const text = caught instanceof Error ? caught.message : String(caught);
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
}
