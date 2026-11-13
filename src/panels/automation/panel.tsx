import type { PanelAutomationRule, PanelProps } from "@infinitary/contracts";
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
 * while a saved rule exists. It reads `automation.list` - the rules
 * Settings → Automation shows - and lists each with its state and its next
 * run; its header counts how many run and how many are paused.
 *
 * A row is a pointing gesture: a click or Enter opens that rule's sheet in
 * Settings → Automation (`point.openSettings`), and nothing runs, pauses or
 * changes. The header's Open Automation, pressed into the panel as an ask,
 * opens the same section at the full list. The rows are one Tab stop, ↑ ↓
 * move between them, and F6 brings focus here (`asks.onFocus`).
 *
 * A list that cannot be read is not an empty one: the rules as the app last
 * read them stay, under its words for why, and the panel stays on its rail.
 */
export default function AutomationPanel({ reads, rail, asks, point }: PanelProps) {
  const [rules, setRules] = useState<PanelAutomationRule[] | null>(null);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const [stop, setStop] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(
    () =>
      reads.subscribe("automation.list", (list) => {
        setUnreadable(list.state === "unavailable" ? list.reason : null);
        // Unreadable keeps the rules last read; with none known, the panel stays as it was.
        if (list.state === "ready" || list.rules.length > 0) setRules(list.rules);
      }),
    [reads],
  );

  // On its rail while a rule is saved; its header counts the running rules
  // and, when there are any, the paused ones.
  useEffect(() => {
    if (!rail || rules === null) return;
    if (rules.length === 0) {
      rail.show(false, m.automationPanelEmpty());
      rail.summarize(null);
      return;
    }
    rail.show(true);
    const active = rules.filter((rule) => rule.state === "enabled").length;
    const paused = rules.filter((rule) => rule.state === "paused").length;
    rail.summarize([
      { text: m.automationPanelActiveCount({ count: active }) },
      ...(paused > 0 ? [{ text: m.automationPanelPausedCount({ count: paused }) }] : []),
      ...(unreadable ? [{ text: m.automationPanelUnreadableSummary() }] : []),
    ]);
  }, [rail, rules, unreadable]);

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
        const row = listRef.current?.querySelector<HTMLElement>('[tabindex="0"]');
        if (row) focusWithRing(row);
      }),
    [asks],
  );

  const shown = rules ?? [];
  const current = shown.some((rule) => rule.id === stop) ? stop : (shown[0]?.id ?? null);
  const onKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const at = shown.findIndex((rule) => rule.id === current);
    const next =
      event.key === "ArrowDown"
        ? Math.min(shown.length - 1, at + 1)
        : event.key === "ArrowUp"
          ? Math.max(0, at - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? shown.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const id = shown[next]?.id;
    if (!id) return;
    setStop(id);
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-automation-rule="${CSS.escape(id)}"] button`,
    );
    if (row) focusWithRing(row);
  };

  return (
    <div className="fm-automation-panel" data-automation-panel="">
      <style>{styles}</style>
      {unreadable && (
        <p className="fm-automation-panel-said" data-automation-unavailable="">
          {unreadable}
        </p>
      )}
      <ul
        ref={listRef}
        className="fm-automation-panel-list"
        aria-label={m.automationPanelListLabel()}
      >
        {shown.map((rule) => (
          <li key={rule.id} data-automation-rule={rule.id}>
            <Row
              title={automationRuleTitle(rule)}
              tone={AUTOMATION_STATE_TONES[rule.state]}
              toneLabel={AUTOMATION_STATE_WORDS[rule.state]}
              trailing={automationNextShort(rule)}
              tabIndex={rule.id === current ? 0 : -1}
              ariaLabel={`${automationRuleTitle(rule)} · ${AUTOMATION_STATE_WORDS[rule.state]} · ${automationNextWords(rule)} · Open in Settings`}
              onFocus={() => setStop(rule.id)}
              onKeyDown={onKey}
              onClick={() => void point.openSettings("automation", rule.id).catch(() => false)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
