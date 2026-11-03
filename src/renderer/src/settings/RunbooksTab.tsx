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
      setError("Could not open this folder. Please try again.");
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
      error={book.error}
      control={
        book.error ? null : (
          <div style={{ display: "flex", alignItems: "center", gap: ROW_GAP }}>
            {book.source === "builtin" && !remote && (
              <Button
                size="sm"
                variant="secondary"
                note={RUNBOOK_VIEW_NOTE}
                aria-label={`View ${book.name}`}
                pending={opening === book.id}
                disabled={opening !== null}
                onClick={() => void open(book.id)}
              >
                View
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
      <section aria-label="Built in">
        <SectionLabel>Built in</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
          {builtins.map(row)}
        </div>
      </section>
      <section data-runbooks-group="yours" aria-label="Yours" style={{ marginTop: SECTION_GAP }}>
        <SectionLabel>Yours</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
          {yours.length ? (
            yours.map(row)
          ) : (
            <p style={{ margin: 0, color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>
              Runbooks you add or make with the first mate appear here.
            </p>
          )}
        </div>
      </section>
      <section aria-label="Make your own" style={{ marginTop: SECTION_GAP }}>
        <SectionLabel>Make your own</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
          <SettingRow
            id="runbooks-folder"
            title="Your runbooks folder"
            description={
              remote
                ? `Your runbooks folder is on ${thisMac.name}. Open and view runbooks there.`
                : "Runbooks the first mate makes or copies for you live here."
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
                  Open folder
                </Button>
              )
            }
          />
          <p style={{ margin: 0, color: "var(--fg-2)", fontSize: "var(--text-sm)" }}>
            Ask the first mate, in your own words. For example:
          </p>
          <ul
            style={{
              margin: 0,
              paddingLeft: "var(--space-5)",
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
