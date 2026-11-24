import type { AutomationRun } from "@shared/automation";
import { automationDateWords } from "@shared/automationWords";
import * as m from "@shared/i18n/messages.generated";
import { useEffect, useState } from "react";
import { useShellStore } from "../app/store";
import { KeyedText } from "../cards/TaskKey";
import { Button, StatusDot } from "../design";
import { appReadExecutor } from "../plugins/reads/appExecutor";
import { NOTE_STYLE, PromptBox } from "./automationParts";
import {
  DELIVERY_TONES,
  deliveryNote,
  runPromptTitle,
  runStateWords,
  runWords,
} from "./automationWords";

/**
 * A rule's runs, newest first (docs/automation.md, "Deliveries"): each leads
 * with when it was sent and where its delivery stands, then what it found or
 * why it stands so, then the tasks and cards it led to; Details folds its
 * planned and sent times, its version and the prompt as sent.
 */
export function AutomationHistory({ id }: { id: string }) {
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
  if (runs === null || runs.length === 0) {
    return (
      <div data-automation-history style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        {m.settingsAutomationNothingRun()}
      </div>
    );
  }
  return (
    <ul
      data-automation-history
      aria-label={m.settingsAutomationHistory()}
      style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column" }}
    >
      {runs.map((run, index) => (
        <HistoryRow key={run.id} run={run} first={index === 0} />
      ))}
    </ul>
  );
}

function HistoryRow({ run, first }: { run: AutomationRun; first: boolean }) {
  const note = deliveryNote(run);
  const state = runStateWords(run);
  return (
    <li
      data-automation-run={run.id}
      data-delivery={run.delivery}
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr)",
        columnGap: "var(--space-2)",
        alignItems: "start",
        padding: "var(--space-3) 0",
        borderTop: first ? "none" : "1px solid var(--line-1)",
        fontSize: "var(--text-sm)",
        color: "var(--fg-3)",
      }}
    >
      {/* One line tall, so the dot sits beside the first line. */}
      <span style={{ display: "flex", alignItems: "center", height: "1lh" }}>
        <StatusDot tone={DELIVERY_TONES[run.delivery]} label={state} nativeTitle={false} />
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
        <div>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-1)" }}>
            {automationDateWords(run.firedAt)}
          </span>{" "}
          · {state}
        </div>
        {run.found ? (
          <div data-automation-run-found style={{ color: "var(--fg-1)", whiteSpace: "pre-wrap" }}>
            {m.automationRunFound({ words: run.found })}
          </div>
        ) : (
          note && <div style={{ color: "var(--fg-2)" }}>{note}</div>
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
            {m.settingsAutomationDetails()}
          </summary>
          <div
            style={{
              marginTop: "var(--space-1)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-1)",
            }}
          >
            <div>
              {runWords(run)} · {m.settingsAutomationVersion({ version: String(run.revision) })}
            </div>
            {run.found && note && <div>{note}</div>}
            <span style={NOTE_STYLE}>{runPromptTitle(run)}</span>
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
