import type { CrewSpeed } from "@shared/crewSpeed";
import type { DecisionModelId, DecisionsSettings, DecisionsView } from "@shared/decisions";
import { DECISION_MODEL_CATALOG } from "@shared/decisions";
import type { DecisionUseRequest } from "@shared/decisionUses";
import { modelNames } from "@shared/modelDisplayName";
import type { ModelSlotsView, ReasoningChoice, Slot } from "@shared/modelSlots";
import { SLOTS } from "@shared/modelSlots";
import type { RoutingSettings } from "@shared/quota";
import { allowanceProviderOf, servedModelKey } from "@shared/quota";
import { useEffect, useRef, useState } from "react";
import { Button } from "../design";
import { DecisionsGroup } from "./DecisionsGroup";
import { ModelLevels } from "./ModelLevels";
import { NOT_IN_USE, STARTING_LEVELS_RESET, STARTING_LEVELS_SUMMARY } from "./modelsWords";

/**
 * "Which of my models may Firstmate use, and as what." Level-first: four
 * levels plus Not in use, each model a pill in every level it is used at
 * (`ModelLevels`). A model may sit in more than one level at once; not in
 * use means in none. Always use (the ✱ pin) wins over every level, and so
 * does asking for premium in words. Automatic selection never picks
 * premium. Rejecting a result may climb one bounded rung (at most two per
 * lineage), the only way into premium without a pin or an ask.
 *
 * Since the Instruments relayout the section is a disclosure: the header
 * line carries the whole story ("premium 2 · high 4 · 31 not in use · 1
 * always use ✱") and the board opens on demand, or from a row's "Model
 * slots".
 *
 * Under the levels sits Decisions (S7b, design section 5.2), a setting of
 * its own rather than a fifth level. It holds exactly ONE model, because
 * ranking makes no sense for a question - there is no quota ladder to walk
 * for one bounded call, and the adapted path's own walk is the slot ladder
 * already. Its rules are different from a level's in every way that
 * matters: it never runs work, routing cannot see it, and the one native
 * option reaches its own endpoint only after the captain pastes their own
 * key and turns it on. Its Uses list, one switch per way Infinitary asks a
 * decision model, and its consent dialog are `DecisionsGroup`.
 */

const chevron = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export function ModelsSection({
  saving = false,
  slots,
  routing,
  decisions,
  open,
  onToggle,
  focusAccountId,
  onFocused,
  onSaveRouting,
  onSetSlotMembership,
  onSetReasoning,
  onSetSpeed,
  onResetSlots,
  onSetDecisions,
  onSetDecisionKey,
  onRemoveDecisionKey,
  onSetDecisionUse,
}: {
  saving?: boolean;
  slots: ModelSlotsView | null;
  routing: RoutingSettings | null;
  /** The Decisions group's whole state; null until the first read lands. */
  decisions: DecisionsView | null;
  open: boolean;
  onToggle: () => void;
  /** Kept so a kebab "Model slots" can open the board; no per-account card. */
  focusAccountId: string | null;
  onFocused: () => void;
  onSaveRouting: (settings: RoutingSettings) => void;
  /**
   * Adds or removes one slot from an offering's membership - it may hold
   * more than one. Resolves false when the write was refused.
   */
  onSetSlotMembership: (key: string, slot: Slot, on: boolean) => Promise<boolean>;
  onSetSpeed?: (key: string, speed: CrewSpeed) => Promise<boolean>;
  onSetReasoning?: (key: string, slot: Slot, value: ReasoningChoice | null) => Promise<boolean>;
  onResetSlots: () => void;
  /** The row, never a key. */
  onSetDecisions: (decisions: DecisionsSettings) => void;
  /** Write-only: the key goes down, the row's new state comes back. */
  onSetDecisionKey: (id: DecisionModelId, key: string) => Promise<boolean>;
  onRemoveDecisionKey: (id: DecisionModelId) => void;
  /** One use switched, after the consent dialog when it asks first. */
  onSetDecisionUse: (request: DecisionUseRequest) => void;
}) {
  const models = slots?.models ?? [];
  const byName = slots?.byName ?? [];
  const [resetArmed, setResetArmed] = useState(false);
  const resetButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open || !focusAccountId) return;
    document.getElementById("fm-subs-models-panel")?.scrollIntoView({ block: "nearest" });
    onFocused();
  }, [open, focusAccountId, onFocused]);

  if (models.length === 0) return null;

  const pinRefFor = (model: { provider: string; id: string }) => ({
    provider: allowanceProviderOf(model.provider) ?? model.provider,
    id: model.id,
  });

  const isPinned = (model: { provider: string; id: string }): boolean =>
    routing?.pins.some((pin) => servedModelKey(pin) === servedModelKey(model)) ?? false;

  const togglePin = (model: { provider: string; id: string }) => {
    if (!routing) return;
    onSaveRouting({
      ...routing,
      pins: isPinned(model)
        ? routing.pins.filter((pin) => servedModelKey(pin) !== servedModelKey(model))
        : [...routing.pins, pinRefFor(model)],
    });
  };

  const inLevel = (slot: Slot) => models.filter((model) => model.slots.includes(slot)).length;
  const notInUse = models.filter((model) => model.slots.length === 0).length;
  // In the order routing tries them: the first that can take the work wins.
  const alwaysUse = (routing?.pins ?? []).flatMap((pin) => {
    const model = models.find((row) => servedModelKey(row) === servedModelKey(pin));
    return model ? [model] : [];
  });
  const newCount = models.filter((model) => model.isNew).length;
  const summary = slots?.usingDefaults
    ? STARTING_LEVELS_SUMMARY
    : [
        ...SLOTS.map((slot) => (inLevel(slot) > 0 ? `${slot} ${inLevel(slot)}` : "")),
        notInUse > 0 ? `${notInUse} ${NOT_IN_USE}` : "",
        alwaysUse.length ? `${alwaysUse.length} always use ✱` : "",
        newCount ? `${newCount} new` : "",
        decisionsSummary(decisions, modelNames([...models, ...byName])),
      ]
        .filter(Boolean)
        .join(" · ");

  const board = (
    <section aria-label="Models" className="fm-subs-disclose">
      <button
        type="button"
        className="fm-subs-disclose-head"
        aria-expanded={open}
        aria-controls="fm-subs-models-panel"
        onClick={onToggle}
      >
        <span style={{ fontSize: "var(--text-base)", fontWeight: 500, color: "var(--fg-1)" }}>
          Models
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
            minWidth: 0,
            overflowWrap: "anywhere",
          }}
        >
          {summary}
        </span>
        <span className="fm-subs-chevron">{chevron}</span>
      </button>
      {open && (
        <div
          id="fm-subs-models-panel"
          className="fm-subs-disclose-body"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "0 18px 16px",
          }}
        >
          <ModelLevels
            models={models}
            byName={byName}
            alwaysUse={alwaysUse}
            dynamicRouting={routing?.dynamicRouting ?? true}
            isPinned={isPinned}
            onTogglePin={togglePin}
            onSetSlotMembership={onSetSlotMembership}
            onSetReasoning={onSetReasoning}
            onSetSpeed={onSetSpeed}
          />
          {decisions && slots && (
            <DecisionsGroup
              decisions={decisions}
              slots={slots}
              onSetDecisions={onSetDecisions}
              onSetDecisionKey={onSetDecisionKey}
              onRemoveDecisionKey={onRemoveDecisionKey}
              onSetDecisionUse={onSetDecisionUse}
            />
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Button
              ref={resetButton}
              variant={resetArmed ? "danger" : "ghost"}
              size="sm"
              onClick={() => {
                if (!resetArmed) {
                  setResetArmed(true);
                  return;
                }
                onResetSlots();
                setResetArmed(false);
              }}
            >
              {resetArmed ? STARTING_LEVELS_RESET.confirm : STARTING_LEVELS_RESET.reset}
            </Button>
            {resetArmed && (
              <>
                {/* Cancel leaves the levels as they are and hands focus back to the reset. */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setResetArmed(false);
                    resetButton.current?.focus();
                  }}
                >
                  {STARTING_LEVELS_RESET.cancel}
                </Button>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                  {STARTING_LEVELS_RESET.note}
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
  return (
    <fieldset
      disabled={saving}
      aria-busy={saving}
      style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}
    >
      {board}
    </fieldset>
  );
}

/**
 * The header line's one extra token: which model answers decisions. It says
 * the model, never the state of a key; a pick that cannot answer says who
 * answers in its place.
 */
function decisionsSummary(
  decisions: DecisionsView | null,
  nameOf: (offering: string) => string,
): string {
  if (!decisions) return "";
  const answerer = decisions.settings.answerer;
  if (answerer.kind === "native") {
    const row = DECISION_MODEL_CATALOG.find((entry) => entry.id === answerer.id);
    return `decisions ${row?.name ?? answerer.id}`;
  }
  if (answerer.kind === "openrouter")
    return `decisions ${decisions.openrouter?.models.find((model) => model.id === answerer.model)?.name ?? "OpenRouter"}`;
  if (answerer.offering === "auto" || decisions.pinned === "fallback") return "decisions auto";
  if (decisions.pinned === "held") return "decisions unanswered";
  return `decisions ${nameOf(answerer.offering)}`;
}
