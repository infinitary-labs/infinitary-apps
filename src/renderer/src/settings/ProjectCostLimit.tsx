import { COST_LIMIT_DEFAULT_USD, type CostLimit } from "@shared/costLimit";
import { useEffect, useState } from "react";
import { GroupedPills, Input } from "../design";

import { PROJECT_COST_WORDS } from "./projectCostWords";

/** The project's standing choice, through the same project-settings action as Care. */
export function ProjectCostLimit({
  id,
  limit,
  onChange,
}: {
  id: string;
  limit: CostLimit | null | undefined;
  onChange: (limit: CostLimit | null) => void;
}) {
  const amount = limit && "usd" in limit ? limit.usd : COST_LIMIT_DEFAULT_USD;
  const [draft, setDraft] = useState(String(amount));
  useEffect(() => setDraft(String(amount)), [amount]);
  const mode = !limit ? "follow" : "usd" in limit ? "amount" : "none";
  const commit = () => {
    const usd = Number(draft);
    if (!Number.isFinite(usd) || usd <= 0) {
      setDraft(String(amount));
      return;
    }
    if (usd !== amount) onChange({ usd });
  };
  return (
    <div
      data-project-cost-limit=""
      style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}
    >
      <GroupedPills
        name={PROJECT_COST_WORDS.title}
        htmlName={`cost-${id}`}
        value={mode}
        options={[...PROJECT_COST_WORDS.choices]}
        onChange={(value) =>
          onChange(value === "follow" ? null : value === "none" ? { none: true } : { usd: amount })
        }
      />
      {mode === "amount" && (
        <span style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
          <span style={{ color: "var(--fg-3)" }}>$</span>
          <Input
            aria-label={PROJECT_COST_WORDS.amount}
            type="number"
            min={0.01}
            step={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
            }}
            style={{ width: 90 }}
          />
        </span>
      )}
    </div>
  );
}
