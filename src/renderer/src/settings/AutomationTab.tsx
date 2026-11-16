import {
  AUTOMATION_UNREADABLE,
  type AutomationList,
  type AutomationNotes,
  type AutomationRule,
  type AutomationRun,
  type AutomationSave,
  type AutomationSpec,
  RULE_NOTES_MAX_CHARS,
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
import { formatDateTime, formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import type { IntegrationsView } from "@shared/integrations";
import type { ProjectView } from "@shared/tasks";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { KeyedText } from "../cards/TaskKey";
import { Button, GroupedChecks, Input, Row, StatusDot } from "../design";
import { focusWithRing } from "../design/focus";
import { isView, waitsForUpdate } from "../devices/viewWords";
import { appReadExecutor } from "../plugins/reads/appExecutor";
import {
  AUTOMATION_MIN_MINUTES,
  AUTOMATION_SHEET_WORDS,
  blankForm,
  DELIVERY_TONES,
  deliveryNote,
  eventPreviewWords,
  formOf,
  hereZone,
  knownZones,
  localClockWords,
  localTimeNote,
  previewPrompt,
  type RuleForm,
  reviewCanTurnOn,
  reviewFacts,
  runPromptTitle,
  runStateWords,
  runWords,
  saveOf,
  specOf,
  weekdayToggles,
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
  const waits = useShellStore((s) => waitsForUpdate(s.thisMac));
  useEffect(() => {
    let live = true;
    if (!waits)
      window.infinitary.integrations
        .list()
        .then((next) => live && setView(next))
        .catch(() => {});
    const off = window.infinitary.integrations.onChange((next) => setView(next));
    return () => {
      live = false;
      off();
    };
  }, [waits]);
  // The integrations' events, then the app's own, which need nothing connected.
  return [...(view?.integrations ?? []), ...(view?.appEvents ?? [])].flatMap((integration) =>
    (integration.events ?? []).map((event) => ({
      value: `${integration.id}/${event.name}`,
      when: automationEventWords(event.label, integration.name),
      label: m.settingsAutomationEventIn({ event: event.label, integration: integration.name }),
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

  const pauseAllKeys = useCommandKeys("automation.pause-all");
  const pauseAll = () => {
    setError(null);
    window.infinitary.automation.pauseAll().catch((caught) => setError(messageOf(caught)));
  };

  return (
    <div data-automation style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "var(--text-md)", color: "var(--fg-1)", fontWeight: 500 }}>
            {m.settingsAutomationTitle()}
          </div>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
            {m.settingsAutomationDescription()}
          </div>
        </div>
        <Button
          variant="secondary"
          disabled={!running}
          onClick={pauseAll}
          {...pauseAllKeys}
          data-automation-pause-all
        >
          {m.settingsAutomationPauseAll()}
        </Button>
      </div>
      <SettingError error={error} />
      {failed && <SettingError error={AUTOMATION_UNREADABLE} />}
      <div style={{ display: "grid", gridTemplateColumns: "300px minmax(0, 1fr)", gap: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: LABEL_GAP, minWidth: 0 }}>
          <Input
            aria-label={m.settingsAutomationSearch()}
            placeholder={m.settingsAutomationSearch()}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button
            variant="secondary"
            onClick={() => setSelected("new")}
            data-automation-new
            style={{ justifyContent: "center" }}
          >
            {m.settingsAutomationNew()}
          </Button>
          <ul
            aria-label={m.settingsAutomationList()}
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
              {m.settingsAutomationEmpty()}
            </div>
          )}
          {rules !== null && rules.length > 0 && shown.length === 0 && (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
              {m.settingsAutomationNoMatch()}
            </div>
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
              {m.settingsAutomationPickOne()}
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
    return {
      dates,
      timeZone: automationZoneOf(spec),
      prompt: previewPrompt(spec, form.prompt, dates, Date.now()),
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
      aria-label={m.settingsAutomationTitle()}
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
          {AUTOMATION_STATE_WORDS[rule.state]} ·{" "}
          {rule.stopped
            ? AUTOMATION_SHEET_WORDS.stoppedWhen
            : automationWhenWords(rule.spec, rule.when)}
          {rule.captainRequested ? "" : ` · ${m.settingsAutomationSetUpByFirstMate()}`}
        </div>
      )}
      {rule?.stopped && (
        <div data-automation-stopped role="status" style={NOTE_STYLE}>
          {rule.stopped} {AUTOMATION_SHEET_WORDS.stoppedNote}
        </div>
      )}
      {drafting && (
        <div data-automation-draft-note style={NOTE_STYLE}>
          {AUTOMATION_SHEET_WORDS.draftNote}
        </div>
      )}
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
        <label htmlFor="automation-when" style={LABEL_STYLE}>
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
                    ? m.settingsAutomationEventNotConnected()
                    : m.settingsAutomationNoEvents()}
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
        </div>
        {form.kind === "weekly" && (
          <Weekdays days={form.days} onChange={(days) => set("days", days)} />
        )}
      </div>
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
      {calendar && (
        <div style={FIELD_STYLE}>
          <label htmlFor="automation-zone" style={LABEL_STYLE}>
            {m.settingsAutomationTimeZone()}
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
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select
            aria-label={m.settingsAutomationInsertDetail()}
            data-automation-detail
            value=""
            onChange={(event) => {
              const detail = SCHEDULE_DETAILS.find((one) => one.id === event.target.value);
              if (detail) insertDetail(detail.token);
            }}
            style={{ ...SELECT_STYLE, fontSize: "var(--text-sm)", padding: "5px 8px" }}
          >
            <option value="">{m.settingsAutomationInsertDetailChoice()}</option>
            {scheduleDetailsFor(form.kind).map((detail) => (
              <option key={detail.id} value={detail.id}>
                {detail.label}
              </option>
            ))}
          </select>
          <span style={NOTE_STYLE}>{AUTOMATION_SHEET_WORDS.detailNote}</span>
        </div>
        <span style={NOTE_STYLE}>
          {form.kind === "event"
            ? AUTOMATION_SHEET_WORDS.submittedNoteEvents
            : AUTOMATION_SHEET_WORDS.submittedNote}
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
                ? m.settingsAutomationPassed()
                : m.settingsAutomationPreviewNext({
                    dates: preview.dates
                      .map((at) => automationDateWords(at, preview.timeZone))
                      .join(" · "),
                  })}
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
                {m.settingsAutomationEnable()}
              </Button>
              <Button type="submit" variant="secondary" disabled={busy} data-automation-save>
                {m.settingsAutomationSaveDraft()}
              </Button>
            </>
          ) : (
            <Button type="submit" variant="primary" disabled={busy} data-automation-save>
              {m.settingsAutomationSave()}
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => void showPreview()}
          >
            {m.settingsAutomationPreview()}
          </Button>
          {rule && (rule.state === "enabled" || rule.state === "paused") && (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void toggle()}>
              {rule.state === "enabled"
                ? m.settingsAutomationPause()
                : m.settingsAutomationResume()}
            </Button>
          )}
          {rule &&
            (confirmDelete ? (
              <Button type="button" variant="danger" disabled={busy} onClick={() => void remove()}>
                {m.settingsAutomationDeleteForGood()}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                {m.settingsAutomationDelete()}
              </Button>
            ))}
        </div>
      )}
      {rule && review === null && <Notes rule={rule} />}
      {rule && <History id={rule.id} />}
    </form>
  );
}

const TEXTAREA_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
  background: "var(--surface-input)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-m)",
  padding: "9px 14px",
  resize: "vertical",
};

/**
 * A rule's notes (docs/automation.md, "A rule's notes"): what its runs
 * learned, which a crewmate a run starts edits as a file. The captain reads,
 * edits or clears them here, and reads every earlier version. Saving them
 * makes no new revision of the rule; a page past the limit is never sent.
 */
function Notes({ rule }: { rule: AutomationRule }) {
  const [standing, setStanding] = useState<AutomationNotes | undefined>(undefined);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether any version was ever saved, a cleared one included: Earlier versions shows then.
  const [saved, setSaved] = useState(false);
  // A crewmate's newer page replaces the field unless the captain is editing it.
  const shown = useRef("");
  const show = useCallback((notes: AutomationNotes | undefined) => {
    // Cleared notes read as none.
    const page = notes?.text ? notes : undefined;
    setStanding(page);
    // The updater runs at render, after `shown` moves on, so it compares with the page shown before.
    const before = shown.current;
    setText((current) => (current === before ? (page?.text ?? "") : current));
    shown.current = page?.text ?? "";
  }, []);
  useEffect(
    () =>
      appReadExecutor().subscribe(
        "automation.notes",
        { id: rule.id, versions: "current" },
        {
          onValue: (value) => {
            const newest = (value as AutomationNotes[])[0];
            setSaved(newest !== undefined);
            show(newest);
          },
          onError: () => {},
        },
      ),
    [rule.id, show],
  );
  const over = text.trim().length > RULE_NOTES_MAX_CHARS;
  const changed = text.trim() !== (standing?.text ?? "");
  const save = async (next: string) => {
    setBusy(true);
    setError(null);
    try {
      const version = await window.infinitary.automation.saveNotes(rule.id, next);
      // The saved page replaces the field, edited or not.
      shown.current = text;
      if (version) setSaved(true);
      show(version ?? undefined);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-automation-notes style={FIELD_STYLE}>
      <label htmlFor="automation-notes" style={LABEL_STYLE}>
        {m.settingsAutomationNotes()}
      </label>
      <span style={NOTE_STYLE}>{m.settingsAutomationNotesNote()}</span>
      {standing && standing.revision < rule.revision && (
        <span data-automation-notes-older style={NOTE_STYLE}>
          {m.settingsAutomationNotesOlder()}
        </span>
      )}
      <textarea
        id="automation-notes"
        value={text}
        rows={5}
        onChange={(event) => setText(event.target.value)}
        style={TEXTAREA_STYLE}
      />
      <span
        data-automation-notes-count
        style={{ ...NOTE_STYLE, ...(over ? { color: "var(--danger)" } : {}) }}
      >
        {m.settingsAutomationNotesCount({
          count: formatNumber(text.trim().length),
          max: formatNumber(RULE_NOTES_MAX_CHARS),
        })}
      </span>
      <SettingError error={error} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || over || !changed}
          onClick={() => void save(text)}
          data-automation-notes-save
        >
          {m.settingsAutomationNotesSave()}
        </Button>
        {standing && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void save("")}
            data-automation-notes-clear
          >
            {m.settingsAutomationNotesClear()}
          </Button>
        )}
      </div>
      {saved && <EarlierNotes id={rule.id} />}
    </div>
  );
}

/**
 * Every version of a rule's notes, newest first, each naming who wrote it
 * and when. Read only while it is open: versions are never pruned.
 */
function EarlierNotes({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<AutomationNotes[]>([]);
  useEffect(() => {
    if (!open) return;
    return appReadExecutor().subscribe(
      "automation.notes",
      { id, versions: "all" },
      {
        onValue: (value) => setVersions(value as AutomationNotes[]),
        onError: () => setVersions([]),
      },
    );
  }, [id, open]);
  return (
    <details
      data-automation-notes-earlier
      style={{ fontSize: "var(--text-sm)" }}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary style={{ cursor: "pointer", width: "fit-content", color: "var(--fg-2)" }}>
        {m.settingsAutomationNotesEarlier()}
      </summary>
      {open && (
        <ul
          style={{
            margin: "var(--space-2) 0 0",
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
          }}
        >
          {versions.map((version) => (
            <li
              key={version.version}
              data-automation-notes-version={version.version}
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
            >
              <div style={{ color: "var(--fg-3)" }}>
                {notesVersionWords(version)}
                {version.task && (
                  <>
                    {" · "}
                    <KeyedText text={`${version.task.key} ${version.task.title}`} />
                  </>
                )}
              </div>
              {version.text ? (
                <PromptBox prompt={version.text} />
              ) : (
                <div style={{ color: "var(--fg-3)" }}>{m.settingsAutomationNotesEmpty()}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function notesVersionWords(version: AutomationNotes): string {
  const words = {
    version: formatNumber(version.version),
    date: formatDateTime(version.at, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  };
  return version.by === "captain"
    ? m.settingsAutomationNotesByYou(words)
    : m.settingsAutomationNotesByCrew(words);
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
  const facts = reviewFacts({ ...review, projectId: review.save.projectId }, projects, where).map(
    (fact): [string, React.ReactNode] => [
      fact.term,
      fact.prompt ? <PromptBox key="prompt" prompt={fact.value} /> : fact.value,
    ],
  );
  return (
    <section
      aria-label={m.settingsAutomationTurnOnLabel()}
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
        {m.settingsAutomationTurnOnQuestion()}
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

/** The weekdays a rule runs on: one pill each, any number chosen. */
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
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={{ ...SELECT_STYLE, alignSelf: "flex-start" }}
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
        {m.settingsAutomationHistory()}
      </div>
      {runs === null || runs.length === 0 ? (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
          {m.settingsAutomationNothingRun()}
        </div>
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
          label={runStateWords(run)}
          nativeTitle={false}
        />
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
        <div>
          <span style={{ color: "var(--fg-1)" }}>{runStateWords(run)}</span> · {runWords(run)} ·{" "}
          {m.settingsAutomationVersion({ version: String(run.revision) })}
        </div>
        {note && <div>{note}</div>}
        {run.found && (
          <div data-automation-run-found style={{ color: "var(--fg-2)", whiteSpace: "pre-wrap" }}>
            {m.automationRunFound({ words: run.found })}
          </div>
        )}
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
            <span>{m.settingsAutomationLedTo()}</span>
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
                {card.open
                  ? m.settingsAutomationCard({ title: card.title })
                  : m.settingsAutomationPastCard({ title: card.title })}
              </Button>
            ))}
          </div>
        )}
        <details data-automation-run-prompt>
          <summary style={{ cursor: "pointer", width: "fit-content" }}>
            {runPromptTitle(run)}
          </summary>
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
