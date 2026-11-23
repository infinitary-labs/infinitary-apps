import type { PanelAutomationRule, PanelKeptJob, PanelProps } from "@infinitary/contracts";
import {
  AUTOMATION_STATE_TONES,
  AUTOMATION_STATE_WORDS,
  automationNextShort,
  automationNextWords,
  automationRuleTitle,
  focusWithRing,
  Row,
} from "@infinitary/ui";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import * as m from "./messages.generated";
import styles from "./panel.css";

/**
 * The Automation panel (docs/automation.md, "The Automation panel"): an
 * ordinary panel folder under Tasks on the right rail, registered only
 * while a saved rule or a kept job exists. It reads `automation.list` - the
 * rules Settings → Automation shows - and lists each with its state and its
 * next run; its header counts how many run and how many are paused.
 *
 * A row is a pointing gesture: a click or Enter opens that rule's sheet in
 * Settings → Automation (`point.openSettings`), and nothing runs, pauses or
 * changes. The header's Open Automation, pressed into the panel as an ask,
 * opens the same section at the full list. The rows are one Tab stop, ↑ ↓
 * move between them, and F6 brings focus here (`asks.onFocus`).
 *
 * A list that cannot be read is not an empty one: the rules as the app last
 * read them stay, under its words for why, and the panel stays on its rail.
 *
 * Below the rules, under Kept running, it lists the jobs the captain asked
 * to keep running past their task's close (`automation.kept`;
 * docs/leftover-programs.md, "Kept running"), by label and computer, and
 * counts them in its header. A kept job's row opens Settings → Automation
 * at that job, whose Check and Remove act on it; the panel runs nothing.
 * The rules and the kept jobs are one Tab stop between them.
 */

/** The Settings item that opens Kept running at one job (`KEPT_ITEM_PREFIX` in Settings). */
const KEPT_ITEM = (id: string) => `kept:${id}`;

const KEPT_TONES = {
  running: "ok",
  "not-running": "warn",
  "timed-out": "idle",
  unreachable: "idle",
} as const;
export default function AutomationPanel({ reads, rail, asks, point }: PanelProps) {
  const [rules, setRules] = useState<PanelAutomationRule[] | null>(null);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const [kept, setKept] = useState<PanelKeptJob[]>([]);
  const [stop, setStop] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      reads.subscribe("automation.list", (list) => {
        setUnreadable(list.state === "unavailable" ? list.reason : null);
        // Unreadable keeps the rules last read; with none known, the panel stays as it was.
        if (list.state === "ready" || list.rules.length > 0) setRules(list.rules);
      }),
    [reads],
  );

  // A list of kept jobs that cannot be read keeps the jobs last read.
  useEffect(() => reads.subscribe("automation.kept", (list) => setKept(list.jobs)), [reads]);

  // On its rail while a rule is saved or a job is kept; its header counts
  // the running rules while any rule is saved and, when there are any, the
  // paused ones and the kept jobs.
  useEffect(() => {
    if (!rail || rules === null) return;
    if (rules.length === 0 && kept.length === 0) {
      rail.show(false, m.automationPanelEmpty());
      rail.summarize(null);
      return;
    }
    rail.show(true);
    const active = rules.filter((rule) => rule.state === "enabled").length;
    const paused = rules.filter((rule) => rule.state === "paused").length;
    rail.summarize([
      ...(rules.length > 0 ? [{ text: m.automationPanelActiveCount({ count: active }) }] : []),
      ...(paused > 0 ? [{ text: m.automationPanelPausedCount({ count: paused }) }] : []),
      ...(kept.length > 0 ? [{ text: m.automationPanelKeptCount({ count: kept.length }) }] : []),
      ...(unreadable ? [{ text: m.automationPanelUnreadableSummary() }] : []),
    ]);
  }, [rail, rules, kept, unreadable]);

  // The header's Open Automation: Settings → Automation, every rule listed.
  useEffect(
    () =>
      asks.subscribe((button) => {
        if (button === "open") void point.openSettings("automation").catch(() => false);
      }),
    [asks, point],
  );

  // F6 lands on the list's stop.
  useEffect(
    () =>
      asks.onFocus(() => {
        const row = rootRef.current?.querySelector<HTMLElement>('[tabindex="0"]');
        if (row) focusWithRing(row);
      }),
    [asks],
  );

  const shown = rules ?? [];
  const stops = [...shown.map((rule) => `rule:${rule.id}`), ...kept.map((job) => `kept:${job.id}`)];
  const current = stops.includes(stop ?? "") ? stop : (stops[0] ?? null);
  const onKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const at = stops.indexOf(current ?? "");
    const next =
      event.key === "ArrowDown"
        ? Math.min(stops.length - 1, at + 1)
        : event.key === "ArrowUp"
          ? Math.max(0, at - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? stops.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const id = stops[next];
    if (!id) return;
    setStop(id);
    const row = rootRef.current?.querySelector<HTMLElement>(
      `[data-automation-stop="${CSS.escape(id)}"] button`,
    );
    if (row) focusWithRing(row);
  };

  return (
    <div ref={rootRef} className="fm-automation-panel" data-automation-panel="">
      <style>{styles}</style>
      {unreadable && (
        <p className="fm-automation-panel-said" data-automation-unavailable="">
          {unreadable}
        </p>
      )}
      <ul className="fm-automation-panel-list" aria-label={m.automationPanelListLabel()}>
        {shown.map((rule) => (
          <li key={rule.id} data-automation-rule={rule.id} data-automation-stop={`rule:${rule.id}`}>
            <Row
              title={automationRuleTitle(rule)}
              tone={AUTOMATION_STATE_TONES[rule.state]}
              toneLabel={AUTOMATION_STATE_WORDS[rule.state]}
              trailing={automationNextShort(rule)}
              tabIndex={`rule:${rule.id}` === current ? 0 : -1}
              ariaLabel={`${automationRuleTitle(rule)} · ${AUTOMATION_STATE_WORDS[rule.state]} · ${automationNextWords(rule)} · Open in Settings`}
              onFocus={() => setStop(`rule:${rule.id}`)}
              onKeyDown={onKey}
              onClick={() => void point.openSettings("automation", rule.id).catch(() => false)}
            />
          </li>
        ))}
      </ul>
      {kept.length > 0 && (
        <section data-automation-kept="" aria-labelledby="automation-panel-kept">
          <h3 id="automation-panel-kept" className="fm-automation-panel-heading">
            {m.automationPanelKeptHeading()}
          </h3>
          <ul className="fm-automation-panel-list" aria-label={m.automationPanelKeptHeading()}>
            {kept.map((job) => (
              <li
                key={job.id}
                data-automation-kept-job={job.id}
                data-automation-stop={`kept:${job.id}`}
              >
                <Row
                  title={job.label}
                  tone={job.checked ? KEPT_TONES[job.checked.outcome] : "ring"}
                  toneLabel={m.automationPanelKeptHeading()}
                  trailing={job.computerName}
                  tabIndex={`kept:${job.id}` === current ? 0 : -1}
                  ariaLabel={m.automationPanelKeptRow({
                    label: job.label,
                    computer: job.computerName,
                  })}
                  onFocus={() => setStop(`kept:${job.id}`)}
                  onKeyDown={onKey}
                  onClick={() =>
                    void point.openSettings("automation", KEPT_ITEM(job.id)).catch(() => false)
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
