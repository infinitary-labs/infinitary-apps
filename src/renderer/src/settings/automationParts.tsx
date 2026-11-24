import { automationEventWords } from "@shared/automationWords";
import * as m from "@shared/i18n/messages.generated";
import type { IntegrationsView } from "@shared/integrations";
import type React from "react";
import { useEffect, useState } from "react";
import { useShellStore } from "../app/store";
import { isView, waitsForUpdate } from "../devices/viewWords";
import type { ReviewFact } from "./automationWords";

/**
 * What the parts of an automation's page in Settings → Automation share
 * (docs/automation.md, "The automation's page"): their field styles, the
 * events a rule may listen for, and the prompt and facts as the first mate
 * gets them.
 */

export const LABEL_STYLE = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  fontWeight: 500,
} as const;
export const FIELD_STYLE = { display: "flex", flexDirection: "column", gap: 4 } as const;
export const NOTE_STYLE = { fontSize: "var(--text-xs)", color: "var(--fg-3)" } as const;
export const SELECT_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
  background: "var(--surface-input)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-m)",
  padding: "9px 10px",
  minWidth: 0,
};
export const TEXTAREA_STYLE: React.CSSProperties = {
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
 * The computer Firstmate lives on, by its name, when this one controls it:
 * the automations run there (docs/view.md). Null on that computer itself.
 */
export function useWhere(): string | null {
  return useShellStore((s) => (isView(s.thisMac) ? s.thisMac.name : null));
}

/** One event a rule may listen for, as the When choice lists it. */
export type Listenable = {
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
export function useListenable(): Listenable[] {
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

/** The prompt exactly as Firstmate gets it. */
export function PromptBox({ prompt, preview = false }: { prompt: string; preview?: boolean }) {
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
 * What a rule will do, as Preview and the Turn on step both show it: one
 * term a row, a list value one entry a line, the prompt in its box.
 */
export function Facts({ facts, preview = false }: { facts: ReviewFact[]; preview?: boolean }) {
  return (
    <dl
      style={{
        display: "grid",
        gridTemplateColumns: "140px minmax(0, 1fr)",
        gap: "var(--space-2) var(--space-3)",
        margin: 0,
        fontSize: "var(--text-sm)",
      }}
    >
      {facts.map((fact) => (
        <div key={fact.term} style={{ display: "contents" }}>
          <dt style={{ color: "var(--fg-3)" }}>{fact.term}</dt>
          <dd style={{ margin: 0, color: "var(--fg-1)", minWidth: 0 }}>
            {fact.prompt ? (
              <PromptBox prompt={fact.value} preview={preview} />
            ) : fact.lines ? (
              fact.lines.map((line) => <div key={line}>{line}</div>)
            ) : (
              fact.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function messageOf(caught: unknown): string {
  const text = caught instanceof Error ? caught.message : String(caught);
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
}
