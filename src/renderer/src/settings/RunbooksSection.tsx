import { useEffect } from "react";
import { Switch } from "../design/core/Switch";
import { ROW_GAP, SECTION_GAP, SectionLabel, SettingError, SettingRow } from "./settingRows";
import { useSettingSave } from "./useSettingSave";

export function RunbooksSection() {
  const saved = useSettingSave(() => window.infinitary.settings.getRunbooks());
  useEffect(() => {
    void saved.refresh();
  }, [saved.refresh]);
  return (
    <section aria-label="Runbooks" data-runbooks style={{ marginTop: SECTION_GAP }}>
      <SectionLabel>Runbooks</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
        {(saved.value ?? []).map((book) => (
          <SettingRow
            key={book.id}
            id={`runbook-${book.id}`}
            title={book.name}
            description={book.description}
            control={
              <Switch
                aria-label={book.name}
                checked={book.enabled}
                disabled={saved.saving}
                onChange={(enabled) =>
                  void saved.save(() => window.infinitary.settings.setRunbook(book.id, enabled))
                }
              />
            }
          />
        ))}
      </div>
      <SettingError error={saved.error} surface="runbooks" />
    </section>
  );
}
