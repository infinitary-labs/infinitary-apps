import type { CrewSpeed } from "@shared/crewSpeed";
import type {
  DecisionModelId,
  DecisionsSettings,
  DecisionsView,
  OpenRouterDecisionOffering,
} from "@shared/decisions";
import {
  DECISION_MODEL_CATALOG,
  decisionConsent,
  openRouterDecisionConsent,
  openRouterDecisionLine,
} from "@shared/decisions";
import { modelNames } from "@shared/modelDisplayName";
import type { ModelSlotsView, ReasoningChoice, Slot } from "@shared/modelSlots";
import { offeringKey, SLOTS } from "@shared/modelSlots";
import type { RoutingSettings } from "@shared/quota";
import { allowanceProviderOf, servedModelKey } from "@shared/quota";
import { useEffect, useState } from "react";
import { Button, Input, RowMenu, type RowMenuItem, StatusDot, type StatusDotTone } from "../design";
import { useOverflowTitle } from "../design/core/overflowTitle";
import { ModelLevels } from "./ModelLevels";
import { NOT_IN_USE, STARTING_LEVELS_SUMMARY, USE_OPENROUTER_DECISION_MODEL } from "./modelsWords";

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
 * key and turns it on.
 */

const CARD_MAX_ROWS_HEIGHT = 232;

const LABEL_STYLE = {
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--fg-3)",
} as const;

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
}) {
  const models = slots?.models ?? [];
  const byName = slots?.byName ?? [];
  const [resetArmed, setResetArmed] = useState(false);
  const [pickingOpenRouter, setPickingOpenRouter] = useState(false);
  const [openRouterConsent, setOpenRouterConsent] = useState<OpenRouterDecisionOffering | null>(
    null,
  );
  const [pickingDecisionModel, setPickingDecisionModel] = useState(false);
  const [turningOn, setTurningOn] = useState<DecisionModelId | null>(null);
  /**
   * The key as it is being typed, and nowhere else. It is cleared the
   * moment it is submitted or the form is closed, and no state here ever
   * holds a key that was already stored: the view cannot return one.
   */
  const [keyDraft, setKeyDraft] = useState("");

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

  const decisionsCard = () => {
    if (!decisions) return null;
    const answerer = decisions.settings.answerer;
    const write = (next: DecisionsSettings) => onSetDecisions(next);
    const chooseAdapted = (offering: string) =>
      write({ ...decisions.settings, answerer: { kind: "adapted", offering } });

    const rows = DECISION_MODEL_CATALOG.map((row) => {
      const native = decisions.natives.find((entry) => entry.id === row.id);
      const chosen = answerer.kind === "native" && answerer.id === row.id;
      if (!native?.keyStored) {
        return { row, native, chosen, state: "absent" as const };
      }
      return { row, native, chosen, state: native.state };
    });

    // A pick is named only while it is the model answering.
    const pinned = answerer.kind === "adapted" ? decisions.pinned : undefined;
    const activeNative = rows.find((entry) => entry.chosen && entry.state === "ready");
    const rejected = rows.find((entry) => entry.chosen && entry.state === "key-rejected");

    const chooseOpenRouter = (model: OpenRouterDecisionOffering) => {
      write({
        ...decisions.settings,
        answerer: { kind: "openrouter", model: model.id },
        egress: {
          ...decisions.settings.egress,
          openrouter: { enabled: true, consentedVersion: decisions.stateVersion },
        },
      });
      setPickingOpenRouter(false);
      setOpenRouterConsent(null);
    };
    const openRouterModel =
      answerer.kind === "openrouter"
        ? decisions.openrouter?.models.find((model) => model.id === answerer.model)
        : undefined;
    const openRouterReady = openRouterModel && decisions.openrouter?.state === "ready";
    const adaptedItems: RowMenuItem[] = [
      ...(decisions.openrouter?.models.length
        ? [
            {
              id: "openrouter",
              label: USE_OPENROUTER_DECISION_MODEL,
              onSelect: () => {
                setPickingOpenRouter((open) => !open);
                setPickingDecisionModel(false);
              },
            },
          ]
        : []),
      ...(answerer.kind === "adapted" && answerer.offering === "auto"
        ? []
        : [{ id: "auto", label: "Use auto", onSelect: () => chooseAdapted("auto") }]),
      {
        id: "specific",
        label: "Use a specific model",
        onSelect: () => setPickingDecisionModel((open) => !open),
      },
      ...rows.map((entry) => ({
        id: `native-${entry.row.id}`,
        label: entry.chosen
          ? `Turn off ${entry.row.name}`
          : `Use ${entry.row.name} (${entry.row.vendor})`,
        onSelect: () => {
          if (entry.chosen) {
            chooseAdapted("auto");
            return;
          }
          if (entry.native?.keyStored && entry.native.consented) {
            write({
              ...decisions.settings,
              answerer: { kind: "native", id: entry.row.id },
              egress: {
                ...decisions.settings.egress,
                [entry.row.id]: {
                  enabled: true,
                  consentedVersion: decisions.stateVersion,
                },
              },
            });
            return;
          }
          setTurningOn(entry.row.id);
        },
      })),
      ...rows
        .filter((entry) => entry.native?.keyStored)
        .flatMap((entry) => [
          {
            id: `replace-${entry.row.id}`,
            label: `Replace ${entry.row.name} key`,
            onSelect: () => setTurningOn(entry.row.id),
          },
          {
            id: `remove-${entry.row.id}`,
            label: `Remove ${entry.row.name}`,
            onSelect: () => onRemoveDecisionKey(entry.row.id),
          },
        ]),
    ];

    const line =
      answerer.kind === "openrouter"
        ? openRouterReady
          ? openRouterDecisionLine(openRouterModel)
          : "OpenRouter unavailable · using one of your own models"
        : activeNative
          ? `${activeNative.row.name} · ${activeNative.row.vendor} · on`
          : rejected
            ? `key rejected · using one of your own models`
            : pinned === "ready" && answerer.kind === "adapted"
              ? modelNames([...models, ...byName])(answerer.offering)
              : pinned === "fallback"
                ? "chosen model unavailable · using your cheapest slotted model"
                : pinned === "held"
                  ? "chosen model unavailable · decisions go unanswered"
                  : "auto · your cheapest slotted model";
    const tone = rejected
      ? "danger"
      : pinned === "held"
        ? "warn"
        : activeNative || openRouterReady
          ? "ok"
          : "ring";
    const last = openRouterReady ? decisions.openrouter?.last : activeNative?.native?.last;
    const offering = turningOn
      ? DECISION_MODEL_CATALOG.find((row) => row.id === turningOn)
      : undefined;

    return (
      <div
        data-slot-group="decisions"
        style={{
          background: "var(--bg-2)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-m)",
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          minWidth: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
          <span style={{ ...LABEL_STYLE }}>Decisions</span>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)", minWidth: 0, flex: 1 }}>
            Efficient decision making
          </span>
        </div>
        <DecisionAnswerer
          line={line}
          tone={tone}
          danger={Boolean(rejected)}
          last={last}
          items={adaptedItems}
        />
        {pickingOpenRouter && !!decisions.openrouter?.models.length && (
          <fieldset
            aria-label="OpenRouter decision models"
            style={{
              border: 0,
              borderTop: "1px solid var(--line-1)",
              margin: 0,
              padding: "8px 0",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {decisions.openrouter.models.map((model) => (
              <Button
                key={model.id}
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (decisions.openrouter?.consented) chooseOpenRouter(model);
                  else setOpenRouterConsent(model);
                }}
              >
                {model.name} · {model.vendor} · ${model.inputPrice} / million input tokens
              </Button>
            ))}
          </fieldset>
        )}
        {openRouterConsent && !!decisions.openrouter?.models.length && (
          <form
            aria-label={`Turn on ${openRouterConsent.name} through OpenRouter`}
            onSubmit={(event) => {
              event.preventDefault();
              chooseOpenRouter(openRouterConsent);
            }}
            style={{
              borderTop: "1px solid var(--line-1)",
              paddingTop: 8,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {openRouterDecisionConsent(openRouterConsent).map((sentence) => (
              <p
                key={sentence}
                style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-3)" }}
              >
                {sentence}
              </p>
            ))}
            <div style={{ display: "flex", gap: 10 }}>
              <Button type="submit" variant="primary" size="sm">
                Turn on
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setOpenRouterConsent(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {pickingDecisionModel && (
          <fieldset
            id="fm-decision-picker"
            aria-label="Choose the model that answers decisions"
            className="fm-subs-scroll"
            style={{
              borderTop: "1px solid var(--line-1)",
              margin: 0,
              paddingTop: 8,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: CARD_MAX_ROWS_HEIGHT,
              overflowY: "auto",
            }}
          >
            {models.map((model) => (
              <button
                key={offeringKey(model)}
                type="button"
                aria-label={`Answer decisions with ${model.label}`}
                onClick={() => {
                  chooseAdapted(offeringKey(model));
                  setPickingDecisionModel(false);
                }}
                style={{
                  background: "transparent",
                  border: 0,
                  borderRadius: "var(--radius-s)",
                  color: "var(--fg-2)",
                  cursor: "pointer",
                  display: "flex",
                  gap: 10,
                  padding: "7px 8px",
                  textAlign: "left",
                }}
              >
                <span
                  style={{ ...LABEL_STYLE, textTransform: "none", letterSpacing: 0, width: 64 }}
                >
                  {model.providerLabel}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-sm)",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {model.label}
                </span>
              </button>
            ))}
          </fieldset>
        )}
        {offering && (
          <form
            aria-label={`Turn on ${offering.name}`}
            onSubmit={(event) => {
              event.preventDefault();
              const key = keyDraft.trim();
              if (!key) return;
              // Two acts, in order: store the credential, then make this the
              // model that answers. The core keeps them apart - a key is not
              // a pick - so the form that means "use Jev" says both.
              void onSetDecisionKey(offering.id, key).then((saved) => {
                if (!saved) return;
                write({
                  ...decisions.settings,
                  answerer: { kind: "native", id: offering.id },
                  egress: {
                    ...decisions.settings.egress,
                    [offering.id]: {
                      enabled: true,
                      consentedVersion: decisions.stateVersion,
                    },
                  },
                });
              });
              setKeyDraft("");
              setTurningOn(null);
            }}
            style={{
              borderTop: "1px solid var(--line-1)",
              paddingTop: 8,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {decisionConsent(offering).map((sentence: string) => (
              <p
                key={sentence}
                style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-3)" }}
              >
                {sentence}
              </p>
            ))}
            <Input
              // Write-only: the field starts empty every time, and no call
              // this component can make ever returns a stored key.
              type="password"
              mono
              autoComplete="off"
              aria-label={`${offering.name} key`}
              placeholder={`Your ${offering.vendor} key`}
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Button type="submit" variant="primary" size="sm" disabled={!keyDraft.trim()}>
                Turn on
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setKeyDraft("");
                  setTurningOn(null);
                }}
              >
                Cancel
              </Button>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                Keys come from {offering.keysUrl}
              </span>
            </div>
          </form>
        )}
      </div>
    );
  };

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
          {decisionsCard()}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Button
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
              {resetArmed ? "Confirm reset" : "Reset to starting levels"}
            </Button>
            {resetArmed && (
              <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
                Always use choices are untouched.
              </span>
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

/** The answerer line and its dot. The dot's tooltip stays only while the line is cut short. */
function DecisionAnswerer({
  line,
  tone,
  danger,
  last,
  items,
}: {
  line: string;
  tone: StatusDotTone;
  danger: boolean;
  last: { value: string; tokens: number } | null | undefined;
  items: RowMenuItem[];
}) {
  const lineFit = useOverflowTitle(line);
  return (
    <div
      data-decision-row="answerer"
      style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}
    >
      {/*
        Same columns as a slot-card model row (64 + flex): the StatusDot
        sits in the label column where a provider name would, and the
        value column carries the answerer line.
      */}
      <span
        data-col="provider"
        style={{
          flexShrink: 0,
          width: 64,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
        }}
      >
        <StatusDot tone={tone} label={line} nativeTitle={lineFit.hidden} />
      </span>
      <span
        data-col="value"
        ref={lineFit.ref}
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          color: danger ? "var(--danger)" : "var(--fg-2)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {line}
      </span>
      {last && (
        <span
          style={{
            flexShrink: 0,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
          }}
        >
          last answer {last.value} · {last.tokens} tokens
        </span>
      )}
      <RowMenu label="Decision model actions" items={items} size={24} />
    </div>
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
