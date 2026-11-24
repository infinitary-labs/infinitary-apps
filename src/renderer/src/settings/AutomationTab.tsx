import {
  AUTOMATION_UNREADABLE,
  type AutomationList,
  type AutomationRule,
} from "@shared/automation";
import {
  automationDateWords,
  automationLooksFailingWords,
  automationNextShort,
  automationRuleTitle,
  automationStateTone,
  automationStateWords,
  automationWhenWords,
  automationZoneOf,
} from "@shared/automationWords";
import * as m from "@shared/i18n/messages.generated";
import type { ProjectView } from "@shared/tasks";
import type React from "react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { Button, Input, Row, StatusDot } from "../design";
import { focusWithRing } from "../design/focus";
import { appReadExecutor } from "../plugins/reads/appExecutor";
import { AutomationHistory } from "./AutomationHistory";
import { AutomationNotes } from "./AutomationNotes";
import { AutomationSetup } from "./AutomationSetup";
import { messageOf } from "./automationParts";
import { AUTOMATION_SHEET_WORDS, blankForm, formOf } from "./automationWords";
import { KEPT_ITEM_PREFIX, KeptRunning } from "./KeptRunning";
import { LABEL_GAP, ROW_GAP, SettingError } from "./settingRows";

/** The parts of a saved automation's page past its header, one at a time. */
type Part = "setup" | "history" | "notes";
const PARTS: readonly Part[] = ["setup", "history", "notes"];

/**
 * Settings → Automation (docs/automation.md): the schedules Firstmate runs,
 * as rules. The left column lists them; the right is the selected rule's
 * page: its state in the header, then Setup, History and Notes in tabs
 * (docs/automation.md, "The automation's page"). The same rules are made
 * by asking Firstmate, and the Automation panel opens a rule's page here
 * (`settingsItem`). A computer that controls Firstmate on another shows and
 * changes the same rules, which run over there.
 */
export function AutomationTab() {
  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | "new" | null>(null);
  // The tab shown, kept here so a pause or a save, which draws the page anew, keeps it.
  const [part, setPart] = useState<Part>("setup");
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

  const select = (id: string | "new" | null) => {
    setError(null);
    setPart("setup");
    setSelected(id);
  };

  // A rule a panel row opened: select it once the list holds it, and put
  // the keyboard in its Setup.
  useEffect(() => {
    // A kept job's row is Kept running's to open.
    if (arrival === null || rules === null || arrival.startsWith(KEPT_ITEM_PREFIX)) return;
    useShellStore.getState().clearSettingsItem();
    if (!rules.some((rule) => rule.id === arrival)) return;
    setSearch("");
    setError(null);
    setPart("setup");
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
                  tone={automationStateTone(rule)}
                  toneLabel={automationStateWords(rule)}
                  trailing={
                    rule.failing ? (
                      <span style={{ color: "var(--danger)" }}>{automationStateWords(rule)}</span>
                    ) : (
                      automationNextShort(rule)
                    )
                  }
                  selected={selected === rule.id}
                  onClick={() => select(rule.id)}
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
          <Button
            variant="secondary"
            onClick={() => select("new")}
            data-automation-new
            style={{ alignSelf: "flex-start" }}
          >
            {m.settingsAutomationNew()}
          </Button>
        </div>
        <div ref={sheetRef} style={{ minWidth: 0 }}>
          {selected === "new" && (
            <Sheet
              key="new"
              rule={undefined}
              projects={projects}
              part="setup"
              onPart={setPart}
              onSaved={(rule) => setSelected(rule.id)}
              onDeleted={() => select(null)}
            />
          )}
          {current && (
            <Sheet
              key={`${current.id}-${current.revision}-${current.state}`}
              rule={current}
              projects={projects}
              part={part}
              onPart={setPart}
              onSaved={(rule) => setSelected(rule.id)}
              onDeleted={() => select(null)}
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
      <KeptRunning />
    </div>
  );
}

const PART_WORDS: Record<Part, () => string> = {
  setup: () => m.settingsAutomationSetup(),
  history: () => m.settingsAutomationHistory(),
  notes: () => m.settingsAutomationNotes(),
};

/**
 * One automation's page: the header with its name, state, schedule, next
 * run and Pause or Resume; one note under it; then Setup, History and Notes
 * in tabs. A new automation, not saved yet, has Setup alone. Every tab stays
 * drawn while hidden, so unsaved edits in Setup or Notes survive a switch.
 */
function Sheet({
  rule,
  projects,
  part,
  onPart,
  onSaved,
  onDeleted,
}: {
  rule: AutomationRule | undefined;
  projects: readonly ProjectView[];
  part: Part;
  onPart: (part: Part) => void;
  onSaved: (rule: AutomationRule) => void;
  onDeleted: () => void;
}) {
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownPart = rule ? part : "setup";
  const toggle = async () => {
    if (!rule) return;
    setBusy(true);
    setError(null);
    try {
      await window.infinitary.automation.setState(
        rule.id,
        rule.state === "enabled" ? "pause" : "resume",
      );
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };
  const setup = (
    <AutomationSetup
      initial={rule ? formOf(rule) : blankForm()}
      rule={rule}
      projects={projects}
      onSaved={onSaved}
      onDeleted={onDeleted}
    />
  );
  return (
    <section
      aria-label={rule ? automationRuleTitle(rule) : m.settingsAutomationNew()}
      data-automation-sheet={rule?.id ?? "new"}
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-m)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
          padding: "18px 18px var(--space-3)",
        }}
      >
        <Header rule={rule} busy={busy} onToggle={() => void toggle()} />
        <SettingError error={error} />
        <NoteSlot rule={rule} />
      </div>
      {rule ? (
        <>
          <PartTabs ids={ids} part={shownPart} onPart={onPart} />
          {PARTS.map((one) => (
            <div
              key={one}
              id={`${ids}-panel-${one}`}
              role="tabpanel"
              aria-labelledby={`${ids}-tab-${one}`}
              data-automation-part={one}
              style={{ padding: 18, display: one === shownPart ? "block" : "none" }}
            >
              {one === "setup" ? (
                setup
              ) : one === "history" ? (
                <AutomationHistory id={rule.id} />
              ) : (
                <AutomationNotes rule={rule} />
              )}
            </div>
          ))}
        </>
      ) : (
        <div style={{ padding: "0 18px 18px" }}>{setup}</div>
      )}
    </section>
  );
}

/** The name as the title; the state with its dot, the schedule, the next run and who set it up. */
function Header({
  rule,
  busy,
  onToggle,
}: {
  rule: AutomationRule | undefined;
  busy: boolean;
  onToggle: () => void;
}) {
  const nextFire = rule?.state === "enabled" && !rule.failing ? rule.nextFire : null;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)" }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <h3
          style={{
            margin: 0,
            fontSize: "var(--text-md)",
            color: "var(--fg-1)",
            fontWeight: 500,
            overflowWrap: "anywhere",
          }}
        >
          {rule ? automationRuleTitle(rule) : m.settingsAutomationNew()}
        </h3>
        {rule && (
          <div
            data-automation-state
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "2px 6px",
              fontSize: "var(--text-sm)",
              color: "var(--fg-3)",
            }}
          >
            <StatusDot
              tone={automationStateTone(rule)}
              label={automationStateWords(rule)}
              nativeTitle={false}
            />
            <span style={{ color: rule.failing ? "var(--danger)" : "var(--fg-1)" }}>
              {automationStateWords(rule)}
            </span>
            <span>
              ·{" "}
              {rule.stopped
                ? AUTOMATION_SHEET_WORDS.stoppedWhen
                : automationWhenWords(rule.spec, rule.when)}
            </span>
            {nextFire !== null && (
              <span>
                · {m.settingsAutomationNextRun()}{" "}
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-2)" }}>
                  {automationDateWords(nextFire, automationZoneOf(rule.spec))}
                </span>
              </span>
            )}
            {!rule.captainRequested && <span>· {m.settingsAutomationSetUpByFirstMate()}</span>}
          </div>
        )}
      </div>
      {rule && (rule.state === "enabled" || rule.state === "paused") && (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onToggle}
          data-automation-toggle
        >
          {rule.state === "enabled" ? m.settingsAutomationPause() : m.settingsAutomationResume()}
        </Button>
      )}
    </div>
  );
}

/** The one note under the header: why a rule gets nothing new, a lost integration, or a draft. */
function NoteSlot({ rule }: { rule: AutomationRule | undefined }) {
  const drafting = rule === undefined || rule.state === "draft";
  if (rule?.failing) {
    const [since, answer] = automationLooksFailingWords(rule.failing);
    return (
      <div
        data-automation-failing
        role="status"
        style={{
          ...NOTE_BOX,
          background: "var(--danger-dim)",
          color: "var(--fg-1)",
        }}
      >
        <span>{since}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>{answer}</span>
      </div>
    );
  }
  if (rule?.stopped) {
    return (
      <div data-automation-stopped role="status" style={NOTE_BOX}>
        {rule.stopped} {AUTOMATION_SHEET_WORDS.stoppedNote}
      </div>
    );
  }
  if (drafting) {
    return (
      <div data-automation-draft-note role="status" style={NOTE_BOX}>
        {AUTOMATION_SHEET_WORDS.draftNote}
      </div>
    );
  }
  return null;
}

const NOTE_BOX: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-s)",
  background: "var(--bg-2)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

/** Setup, History and Notes as one Tab stop, moved between with the arrow keys, Home and End. */
function PartTabs({
  ids,
  part,
  onPart,
}: {
  ids: string;
  part: Part;
  onPart: (part: Part) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const at = PARTS.indexOf(part);
    const to =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? PARTS.length - 1
          : (at + (event.key === "ArrowRight" ? 1 : -1) + PARTS.length) % PARTS.length;
    const next = PARTS[to] ?? "setup";
    onPart(next);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  };
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={m.settingsAutomationTitle()}
      onKeyDown={onKeyDown}
      style={{
        display: "flex",
        gap: "var(--space-3)",
        padding: "0 18px",
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      {PARTS.map((one) => {
        const chosen = one === part;
        return (
          <button
            key={one}
            id={`${ids}-tab-${one}`}
            type="button"
            role="tab"
            aria-selected={chosen}
            aria-controls={`${ids}-panel-${one}`}
            tabIndex={chosen ? 0 : -1}
            data-automation-tab={one}
            onClick={() => onPart(one)}
            style={{
              padding: "var(--space-2) 0",
              marginBottom: -1,
              border: 0,
              borderBottom: `2px solid ${chosen ? "var(--accent)" : "transparent"}`,
              background: "transparent",
              fontFamily: "var(--font-ui)",
              fontSize: "var(--text-sm)",
              color: chosen ? "var(--fg-1)" : "var(--fg-3)",
              cursor: chosen ? "default" : "pointer",
            }}
          >
            {PART_WORDS[one]()}
          </button>
        );
      })}
    </div>
  );
}
