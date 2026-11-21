import { formatList } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import type { RunbookView } from "@shared/runbooks";
import { RUNBOOK_EXAMPLES, RUNBOOK_VIEW_NOTE } from "@shared/runbookWords";
import { useEffect, useState } from "react";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { Button } from "../design/core/Button";
import { Switch } from "../design/core/Switch";
import { isView } from "../devices/viewWords";
import { ROW_GAP, SECTION_GAP, SectionLabel, SettingError, SettingRow } from "./settingRows";
import { useSettingSave } from "./useSettingSave";

export function RunbooksTab() {
  const saved = useSettingSave(() => window.infinitary.settings.getRunbooks());
  const thisMac = useShellStore((s) => s.thisMac);
  const remote = isView(thisMac);
  const folderKeys = useCommandKeys("runbooks.open-folder");
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void saved.refresh();
  }, [saved.refresh]);
  const open = async (id?: string) => {
    setOpening(id ?? "personal");
    setError(null);
    try {
      if (id) await window.infinitary.settings.viewRunbook(id);
      else await window.infinitary.settings.openRunbooksFolder();
    } catch {
      setError(m.settingsRunbooksOpenFailed());
    } finally {
      setOpening(null);
    }
  };
  const row = (book: RunbookView) => (
    <SettingRow
      key={book.id}
      id={`runbook-${book.id}`}
      title={book.name}
      description={book.description}
      detail={
        book.panels?.length ? (
          <span data-runbook-panels="">
            {m.settingsRunbooksPanels({
              panels: formatList(book.panels.map((panel) => panel.title)),
            })}
          </span>
        ) : undefined
      }
      error={book.error}
      control={
        book.error ? null : (
          <div style={{ display: "flex", alignItems: "center", gap: ROW_GAP }}>
            {book.source === "builtin" && !remote && (
              <Button
                size="sm"
                variant="secondary"
                note={RUNBOOK_VIEW_NOTE}
                aria-label={m.settingsRunbooksViewLabel({ name: book.name })}
                pending={opening === book.id}
                disabled={opening !== null}
                onClick={() => void open(book.id)}
              >
                {m.settingsRunbooksView()}
              </Button>
            )}
            <Switch
              aria-label={book.name}
              checked={book.enabled}
              disabled={saved.saving}
              onChange={(enabled) =>
                void saved.save(() => window.infinitary.settings.setRunbook(book.id, enabled))
              }
            />
          </div>
        )
      }
    />
  );
  const builtins = (saved.value ?? []).filter((book) => book.source === "builtin");
  const yours = (saved.value ?? []).filter((book) => book.source !== "builtin");
  return (
    <div data-runbooks>
      <section aria-label={m.settingsRunbooksBuiltIn()}>
        <SectionLabel>{m.settingsRunbooksBuiltIn()}</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
          {builtins.map(row)}
        </div>
      </section>
      <section
        data-runbooks-group="yours"
        aria-label={m.settingsRunbooksYours()}
        style={{ marginTop: SECTION_GAP }}
      >
        <SectionLabel>{m.settingsRunbooksYours()}</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
          {yours.length ? (
            yours.map(row)
          ) : (
            <p style={{ margin: 0, color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>
              {m.settingsRunbooksYoursEmpty()}
            </p>
          )}
        </div>
      </section>
      <section aria-label={m.settingsRunbooksMakeYourOwn()} style={{ marginTop: SECTION_GAP }}>
        <SectionLabel>{m.settingsRunbooksMakeYourOwn()}</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
          <SettingRow
            id="runbooks-folder"
            title={m.settingsRunbooksFolder()}
            description={
              remote
                ? m.settingsRunbooksFolderRemote({ computer: thisMac.name })
                : m.settingsRunbooksFolderHere()
            }
            control={
              remote ? null : (
                <Button
                  data-runbooks-open-folder
                  variant="secondary"
                  size="sm"
                  {...folderKeys}
                  pending={opening === "personal"}
                  disabled={opening !== null}
                  onClick={() => void open()}
                >
                  {m.settingsRunbooksOpenFolder()}
                </Button>
              )
            }
          />
          <p style={{ margin: 0, color: "var(--fg-2)", fontSize: "var(--text-sm)" }}>
            {m.settingsRunbooksAsk()}
          </p>
          <ul
            style={{
              margin: 0,
              paddingInlineStart: "var(--space-5)",
              color: "var(--fg-2)",
              fontSize: "var(--text-sm)",
              display: "grid",
              gap: ROW_GAP,
            }}
          >
            {RUNBOOK_EXAMPLES.map((example) => (
              <li key={example}>“{example}”</li>
            ))}
          </ul>
        </div>
      </section>
      <SettingError error={saved.error ?? error} surface="runbooks" />
    </div>
  );
}
