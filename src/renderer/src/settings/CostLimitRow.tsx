import { COST_LIMIT_DEFAULT_USD } from "@shared/costLimit";
import { useEffect, useState } from "react";
import { Input, Switch } from "../design";
import { COST_LIMIT_WORDS, costLimitDescription } from "./costLimitWords";
import { SettingRow } from "./GeneralTab";
import { useSettingSave } from "./useSettingSave";

/**
 * The app's own cost limit (docs/usage.md, "The cost limit"): a task, and
 * everything under it, that passes this many estimated dollars stops at a
 * safe point and asks the captain. The switch turns the asking off; the
 * amount saves on Enter or when focus leaves it.
 */
export function CostLimitRow() {
  const save = useSettingSave(() => window.infinitary.settings.getCostLimit());
  useEffect(() => {
    void save.refresh();
  }, [save.refresh]);
  const view = save.value;
  const on = view !== null && "usd" in view.limit;
  const saved = view && "usd" in view.limit ? view.limit.usd : COST_LIMIT_DEFAULT_USD;
  const [draft, setDraft] = useState(String(saved));
  useEffect(() => setDraft(String(saved)), [saved]);
  const commit = () => {
    const usd = Number(draft);
    if (!Number.isFinite(usd) || usd <= 0) {
      setDraft(String(saved));
      return;
    }
    if (usd === saved) return;
    void save.save(() => window.infinitary.settings.setCostLimit({ usd }));
  };
  return (
    <SettingRow
      id="cost-limit"
      error={save.error}
      title={COST_LIMIT_WORDS.title}
      description={costLimitDescription(view)}
      control={
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          {on ? (
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>$</span>
              <Input
                aria-label={COST_LIMIT_WORDS.amountLabel}
                type="number"
                min={1}
                step={1}
                value={draft}
                disabled={save.saving}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commit();
                }}
                style={{ width: 90 }}
              />
            </span>
          ) : null}
          <Switch
            aria-label={COST_LIMIT_WORDS.switchLabel}
            checked={on}
            disabled={view === null || save.saving}
            onChange={(checked) =>
              void save.save(() =>
                window.infinitary.settings.setCostLimit(
                  checked ? { usd: COST_LIMIT_DEFAULT_USD } : { none: true },
                ),
              )
            }
          />
        </div>
      }
    />
  );
}
