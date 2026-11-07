import type { CrewSpeed } from "@shared/crewSpeed";
import type { ReasoningChoice, Slot, SlotModelView } from "@shared/modelSlots";
import { offeringKey, SLOTS } from "@shared/modelSlots";
import { reasoningWord } from "@shared/reasoning";
import { levelDefaultReasoning } from "@shared/routingPolicy";
import type React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, IconButton, Input, SlotBadge, Switch, useRestLabel } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { fixedKeys } from "../design/core/fixedKeys";
import {
  ALWAYS_USE_LEAD,
  chipDisplayParts,
  type DropPlan,
  dropPlan,
  type LevelTarget,
  levelList,
  newModelNote,
  providerPrefix,
  removeAllLine,
  usedLine,
} from "./levelDrops";
import { removeFromLevelOnly } from "./modelsWords";
import { ReasoningControl } from "./ReasoningControl";
import { SpeedControl } from "./SpeedControl";
import "./models.css";

/**
 * The levels and their models (Settings → Intelligence → Models): four lanes
 * plus Not in use, each model a pill in every level it is used at. Where a
 * control sits says how far it reaches. Inside a lane, the × on a pill and
 * "Add model" change that one level. A pill can be dragged to another lane:
 * a plain drop moves it, ⌥ at the drop keeps it at both, and a drop on Not
 * in use takes it out of every level - the lane says which before the drop.
 * Everything about a model as a whole lives in the panel its name opens:
 * all four levels at once, always use (the ✱ pin, which skips the levels),
 * and removing it from all of them. The panel is absent until a name is
 * clicked.
 */

const SLOT_HINT: Record<Slot, string> = {
  premium:
    "Crew never picks this automatically; your first mate's Auto may fall back to it after high and medium.",
  high: "Plans, research, reproduction, and work without a verified basis",
  medium: "Building or fixing from a verified plan, spec, or reproduction",
  low: "Config, docs, cosmetic chores",
};

/**
 * What an empty level's work does instead. Premium is the one that never
 * falls lower on its own: an ask for it waits until a premium model can
 * serve it or the captain starts it lower (docs/architecture.md §6, "Degradation").
 */
const EMPTY_HINT: Record<Slot, string> = {
  premium:
    "Empty. Work that asks for premium waits until you add a model here or choose to run it lower.",
  high: "Empty. This work runs on medium.",
  medium: "Empty. This work runs on high.",
  low: "Empty. This work runs on medium.",
};

const SLOT_COLOR: Record<Slot, string> = {
  premium: "var(--slot-premium)",
  high: "var(--slot-high)",
  medium: "var(--slot-medium)",
  low: "var(--slot-low)",
};

const PICKER_MAX_HEIGHT = 232;

/** How many unlisted models a search shows (design skill: ModelsBoard). */
const BY_NAME_LIMIT = 12;

/** How far the pointer travels before a press on a pill becomes a drag. */
const DRAG_START_DISTANCE = 5;

/**
 * Whether a row matches what was typed: every word, anywhere in the
 * provider, the label or the id - "opus 4.8" finds "Claude Opus 4.8".
 */
function matchesQuery(model: SlotModelView, query: string): boolean {
  const haystack = `${model.providerLabel} ${model.label} ${model.id}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

/** One press on a pill, from pointer down until it is released. */
type Press = {
  key: string;
  from: LevelTarget;
  startX: number;
  startY: number;
  /** Where inside the pill it was grabbed, so the pill stays under the pointer. */
  grabX: number;
  grabY: number;
  width: number;
  x: number;
  y: number;
  dragging: boolean;
  cancelled: boolean;
  stop: () => void;
};

/** What the board draws while a pill is in the air. */
type DragView = { key: string; from: LevelTarget; over: LevelTarget | null; keepBoth: boolean };

/** The board's own instruction, which every pill's name points at. */
const BOARD_HINT_ID = "models-board-hint";

/**
 * A pill's name, the button that opens its model's panel. Its description
 * is its own words - the provider, "new" on a new model, and the note a
 * new model's "new" carries in a level - then the board's instruction, all
 * by reference, since a description by reference leaves `aria-description`
 * unread. The note also shows on rest, the pointer's or the keyboard's
 * focus: the "new" sits inside the button, so the button carries what it
 * says (docs/keyboard.md, "Facts shown on rest").
 */
function PillName({
  words,
  note,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-describedby" | "aria-description"> & {
  /** The pill's own words: its provider, and "new" on a new model. */
  words: string;
  note: string | undefined;
}) {
  const wordsId = useId();
  const rest = useRestLabel(note, { fact: true });
  return (
    <>
      <button type="button" {...props} aria-describedby={`${wordsId} ${BOARD_HINT_ID}`} {...rest} />
      <span id={wordsId} hidden>
        {note ? `${words}. ${note}` : words}
      </span>
    </>
  );
}

/**
 * A pill's ×, which takes the model out of this one level: "only" shows on
 * rest, the pointer's or the keyboard's focus, as an icon button's name
 * does, and is its description.
 */
function PillRemove({
  words,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { words: string }) {
  const rest = useRestLabel(words);
  return <button type="button" {...props} aria-description={words} {...rest} />;
}

function levelAt(x: number, y: number): LevelTarget | null {
  const level = document
    .elementFromPoint(x, y)
    ?.closest("[data-drop-level]")
    ?.getAttribute("data-drop-level");
  if (level === "off") return "off";
  return SLOTS.find((slot) => slot === level) ?? null;
}

export function ModelLevels({
  models,
  byName,
  alwaysUse,
  dynamicRouting,
  isPinned,
  onTogglePin,
  onSetSlotMembership,
  onSetReasoning,
  onSetSpeed,
}: {
  models: SlotModelView[];
  byName: SlotModelView[];
  /** The models set to always use, in the order routing tries them. */
  alwaysUse: SlotModelView[];
  dynamicRouting: boolean;
  isPinned: (model: SlotModelView) => boolean;
  onTogglePin: (model: SlotModelView) => void;
  /** Resolves false when the write was refused, so a move stops after its first half. */
  onSetSlotMembership: (key: string, slot: Slot, on: boolean) => Promise<boolean>;
  onSetSpeed?: (key: string, speed: CrewSpeed) => Promise<boolean>;
  onSetReasoning?: (key: string, slot: Slot, value: ReasoningChoice | null) => Promise<boolean>;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<Slot | null>(null);
  /** What the open picker's search holds; cleared whenever a picker opens or closes. */
  const [pickerQuery, setPickerQuery] = useState("");
  const [drag, setDrag] = useState<DragView | null>(null);
  const press = useRef<Press | null>(null);
  const ghost = useRef<HTMLSpanElement | null>(null);
  /** A drop that ends on the pill it started from would otherwise open its panel. */
  const suppressClick = useRef(false);
  const latest = useRef({ models, onSetSlotMembership });
  latest.current = { models, onSetSlotMembership };

  useEffect(() => () => press.current?.stop(), []);

  const selected = models.find((model) => offeringKey(model) === selectedKey);
  // A model chosen with the keyboard opens its levels with focus in them,
  // the keyboard's way to do what a drag does; Escape there goes back to the
  // pill it came from (docs/keyboard.md, "Lists and Settings").
  const opener = useRef<HTMLElement | null>(null);
  const focusPanel = useRef(false);
  useEffect(() => {
    if (!focusPanel.current || !selectedKey) return;
    focusPanel.current = false;
    document
      .querySelector<HTMLElement>(
        `[data-model-panel="${CSS.escape(selectedKey)}"] [role="checkbox"]`,
      )
      ?.focus();
  }, [selectedKey]);
  const dragged = drag ? models.find((model) => offeringKey(model) === drag.key) : undefined;
  const inLevel = (slot: Slot) => models.filter((model) => model.slots.includes(slot));
  const notInUse = models.filter((model) => model.slots.length === 0);

  const apply = (model: SlotModelView, plan: DropPlan) => {
    const key = offeringKey(model);
    const set = latest.current.onSetSlotMembership;
    if (plan.kind === "add") {
      void set(key, plan.to, true);
    } else if (plan.kind === "remove-all") {
      for (const slot of model.slots) void set(key, slot, false);
    } else if (plan.kind === "move") {
      // Join first: a refused write must never leave the model in no level.
      void set(key, plan.to, true).then((saved) => {
        if (saved) void set(key, plan.from, false);
      });
    }
  };

  const beginPress = (
    event: React.PointerEvent<HTMLButtonElement>,
    key: string,
    from: LevelTarget,
  ) => {
    const pill = event.currentTarget.parentElement;
    if (event.button !== 0 || press.current || !pill) return;
    const box = pill.getBoundingClientRect();
    const state: Press = {
      key,
      from,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - box.left,
      grabY: event.clientY - box.top,
      width: box.width,
      x: event.clientX,
      y: event.clientY,
      dragging: false,
      cancelled: false,
      stop: () => {},
    };
    const show = (keepBoth: boolean) => {
      const over = levelAt(state.x, state.y);
      setDrag((current) =>
        current && current.over === over && current.keepBoth === keepBoth
          ? current
          : { key, from, over, keepBoth },
      );
    };
    const onMove = (moved: PointerEvent) => {
      state.x = moved.clientX;
      state.y = moved.clientY;
      if (!state.dragging) {
        const travelled =
          Math.abs(moved.clientX - state.startX) + Math.abs(moved.clientY - state.startY);
        if (travelled < DRAG_START_DISTANCE) return;
        state.dragging = true;
      }
      if (state.cancelled) return;
      if (ghost.current) {
        ghost.current.style.left = `${state.x - state.grabX}px`;
        ghost.current.style.top = `${state.y - state.grabY}px`;
      }
      show(moved.altKey);
    };
    const onKey = (pressed: KeyboardEvent) => {
      if (!state.dragging || state.cancelled) return;
      if (pressed.key === "Escape") {
        state.cancelled = true;
        setDrag(null);
      } else if (pressed.key === "Alt") {
        show(pressed.type === "keydown");
      }
    };
    const finish = (released: PointerEvent, dropped: boolean) => {
      state.stop();
      press.current = null;
      if (!state.dragging) return;
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      setDrag(null);
      if (!dropped || state.cancelled) return;
      const model = latest.current.models.find((row) => offeringKey(row) === key);
      const over = levelAt(released.clientX, released.clientY);
      const plan = model && over ? dropPlan(model, from, over, released.altKey) : null;
      if (model && plan) apply(model, plan);
    };
    const onUp = (released: PointerEvent) => finish(released, true);
    const onCancel = (released: PointerEvent) => finish(released, false);
    state.stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
    press.current = state;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
  };

  const planOver = (target: LevelTarget): DropPlan | null =>
    drag && dragged && drag.over === target
      ? dropPlan(dragged, drag.from, target, drag.keepBoth)
      : null;

  const face = (model: SlotModelView) => {
    const parts = chipDisplayParts(model);
    return (
      <>
        {parts.provider && <span>{parts.provider}</span>}
        {(parts.label || isPinned(model)) && (
          <span className="fm-models-chip-label">
            {parts.label}
            {isPinned(model) ? " ✱" : ""}
          </span>
        )}
        {model.place && <span className="fm-models-place">{model.place}</span>}
        {model.isNew && <span className="fm-models-new">new</span>}
      </>
    );
  };

  const pill = (model: SlotModelView, level: LevelTarget) => {
    const key = offeringKey(model);
    const pinned = isPinned(model);
    return (
      <span
        key={key}
        className="fm-models-chip"
        data-model-row={key}
        data-selected={selectedKey === key ? "" : undefined}
        data-pinned={pinned ? "" : undefined}
        data-picked={drag?.key === key && drag.from === level ? "" : undefined}
      >
        <PillName
          className="fm-models-chip-name"
          aria-label={pinned ? `${model.label} ✱` : model.label}
          words={model.isNew ? `${model.providerLabel}, new` : model.providerLabel}
          aria-pressed={selectedKey === key}
          note={model.isNew ? newModelNote(model) : undefined}
          onPointerDown={(event) => beginPress(event, key, level)}
          onClick={(event) => {
            if (suppressClick.current) return;
            const opening = selectedKey !== key;
            // A click the keyboard made (Enter or Space) has no pointer detail.
            opener.current = event.currentTarget;
            focusPanel.current = opening && event.detail === 0;
            setSelectedKey(opening ? key : null);
          }}
        >
          {face(model)}
        </PillName>
        {level !== "off" && (
          <PillRemove
            className="fm-models-chip-x"
            aria-label={`Remove ${model.label} from ${level}`}
            words={removeFromLevelOnly(level)}
            onClick={() => void onSetSlotMembership(key, level, false)}
          >
            ×
          </PillRemove>
        )}
      </span>
    );
  };

  const dropHint = (plan: DropPlan | null) =>
    plan && (
      <span className="fm-models-drop" data-drop-hint="">
        {plan.label}
      </span>
    );

  const lane = (slot: Slot) => {
    const rows = inLevel(slot);
    const pickerOpen = addingTo === slot;
    // Everything not already HERE - a model already in another level may
    // still be added to this one, so the picker excludes only membership
    // in `slot` itself, not membership elsewhere.
    const addableModels = models.filter((model) => !model.slots.includes(slot));
    const query = pickerOpen ? pickerQuery.trim() : "";
    const listedMatches = query
      ? addableModels.filter((model) => matchesQuery(model, query))
      : addableModels;
    // The rest of what the subscriptions serve is reachable by name only:
    // it shows only for a query, and choosing one keeps it listed.
    const moreMatches = query
      ? byName.filter((model) => matchesQuery(model, query)).slice(0, BY_NAME_LIMIT)
      : [];
    const pickerRow = (model: SlotModelView) => (
      <button
        key={offeringKey(model)}
        type="button"
        aria-label={`Add ${model.label} to ${slot}`}
        onClick={() => {
          void onSetSlotMembership(offeringKey(model), slot, true);
          setAddingTo(null);
          setPickerQuery("");
        }}
        style={{
          background: "transparent",
          border: 0,
          borderRadius: "var(--radius-s)",
          color: "var(--fg-2)",
          cursor: "pointer",
          display: "flex",
          gap: 10,
          padding: "var(--space-2)",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)", width: 64 }}>
          {model.providerLabel}
        </span>
        <span
          className="fm-models-mono"
          style={{ fontSize: "var(--text-sm)", flex: 1, minWidth: 0 }}
        >
          {model.label}
        </span>
        {/* Where else it sits, if anywhere. */}
        <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)", flexShrink: 0 }}>
          {model.slots.length > 0 ? `in ${levelList(model.slots)}` : "not in use"}
        </span>
      </button>
    );
    const plan = planOver(slot);
    return (
      <div
        key={slot}
        className="fm-models-lane"
        data-slot-group={slot}
        data-drop-level={slot}
        data-drop={plan?.kind}
      >
        <div className="fm-models-lane-head">
          <SlotBadge slot={slot} />
          <span className="fm-models-hint">
            {SLOT_HINT[slot]}
            <br />
            Default reasoning · {reasoningWord({ level: levelDefaultReasoning(slot) })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={addableModels.length === 0 && byName.length === 0}
            aria-expanded={pickerOpen}
            aria-controls={`fm-slot-picker-${slot}`}
            onClick={() => {
              setAddingTo(pickerOpen ? null : slot);
              setPickerQuery("");
            }}
          >
            Add model
          </Button>
        </div>
        <div className="fm-models-chips">
          {rows.map((model) => (
            <div key={offeringKey(model)} className="fm-models-reasoning-row">
              {pill(model, slot)}
              <ReasoningControl model={model} slot={slot} onSave={onSetReasoning} />
            </div>
          ))}
          {rows.length === 0 && !plan && <span className="fm-models-hint">{EMPTY_HINT[slot]}</span>}
          {dropHint(plan)}
        </div>
        {pickerOpen && (
          <fieldset
            id={`fm-slot-picker-${slot}`}
            aria-label={`Add a model to ${slot}`}
            className="fm-subs-scroll"
            style={{
              border: 0,
              borderTop: "1px solid var(--line-1)",
              margin: 0,
              padding: "var(--space-2) 0 0",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: PICKER_MAX_HEIGHT,
              overflowY: "auto",
            }}
          >
            <div
              style={{
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--bg-2)",
                paddingBottom: 4,
              }}
            >
              <Input
                mono
                autoFocus
                aria-label={`Find a model to add to ${slot}`}
                placeholder="Find a model by name"
                value={pickerQuery}
                onChange={(event) => setPickerQuery(event.target.value)}
                style={{ fontSize: "var(--text-sm)", padding: "var(--space-2) var(--space-3)" }}
              />
            </div>
            {listedMatches.map(pickerRow)}
            {moreMatches.length > 0 && (
              <>
                <span
                  className="fm-models-label"
                  style={{ padding: "var(--space-2) var(--space-2) var(--space-1)" }}
                >
                  More from your subscriptions
                </span>
                {moreMatches.map(pickerRow)}
              </>
            )}
            {query && listedMatches.length === 0 && moreMatches.length === 0 && (
              <div className="fm-models-hint" style={{ padding: "var(--space-1) var(--space-2)" }}>
                No model by that name
              </div>
            )}
          </fieldset>
        )}
      </div>
    );
  };

  const panel = (model: SlotModelView) => {
    const key = offeringKey(model);
    return (
      <aside
        className="fm-models-panel"
        data-model-panel={key}
        aria-label={`${model.label} levels`}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // Escape closes the levels alone, not Settings around them.
          event.stopPropagation();
          setSelectedKey(null);
          if (opener.current?.isConnected) opener.current.focus();
        }}
      >
        <div className="fm-models-panel-head">
          <div className="fm-models-panel-name">
            <span>{model.providerLabel}</span>
            <span>{model.label}</span>
          </div>
          <IconButton
            label={`Close ${model.label}`}
            {...fixedKeys("Escape")}
            size={24}
            onClick={() => setSelectedKey(null)}
          >
            ×
          </IconButton>
        </div>
        <p className="fm-models-panel-used">{usedLine(model)}</p>
        <fieldset
          aria-label="Levels"
          className="fm-models-checks"
          style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
        >
          <span className="fm-models-label">Levels</span>
          {SLOTS.map((slot) => {
            const used = model.slots.includes(slot);
            return (
              // biome-ignore lint/a11y/useSemanticElements: a native checkbox cannot hold the level badge it is drawn with
              <button
                key={slot}
                type="button"
                role="checkbox"
                aria-checked={used}
                aria-label={`Use ${model.label} at ${slot}`}
                className="fm-models-check"
                style={{ "--level": SLOT_COLOR[slot] } as React.CSSProperties}
                onClick={() => void onSetSlotMembership(key, slot, !used)}
              >
                <span className="fm-models-box" />
                <SlotBadge slot={slot} />
              </button>
            );
          })}
        </fieldset>
        <SpeedControl model={model} onSave={onSetSpeed} />
        <div className="fm-models-panel-row">
          <div>
            <span>
              Always use <span className="fm-models-star">✱</span>
            </span>
            <span>All crew work goes to this model. Levels are skipped.</span>
          </div>
          <Switch
            checked={isPinned(model)}
            aria-label={`Always use ${model.label}`}
            onChange={() => onTogglePin(model)}
          />
        </div>
        <div className="fm-models-panel-row">
          <div>
            <span>Remove from all levels</span>
            <span>{removeAllLine(model)}</span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={model.slots.length === 0}
            aria-label={`Remove ${model.label} from all levels`}
            onClick={() => apply(model, { kind: "remove-all", label: "" })}
          >
            Remove
          </Button>
        </div>
      </aside>
    );
  };

  const first = alwaysUse[0];
  const second = alwaysUse[1];
  const offPlan = planOver("off");
  const named = (model: SlotModelView) => (
    <span className="fm-models-mono">{`${providerPrefix(model)} ${model.label}`.trim()}</span>
  );

  return (
    <div className="fm-models-wrap">
      {first && (
        <div className="fm-models-banner" data-models-banner="">
          <span className="fm-models-star">✱</span>
          {dynamicRouting ? (
            <span>
              {ALWAYS_USE_LEAD} {named(first)}
              {second && <>, then {named(second)} if it cannot take the work</>}. Levels are skipped
              while always use is on.
            </span>
          ) : (
            <span>
              Always use is set for {named(first)}. It applies when Dynamic routing is on.
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Turn off always use for ${first.label}`}
            onClick={() => onTogglePin(first)}
          >
            Turn off
          </Button>
        </div>
      )}
      <div
        className="fm-models-board"
        data-models-board=""
        data-panel={selected ? "" : undefined}
        data-dragging={drag ? "" : undefined}
      >
        <div className="fm-models-lanes">
          <span className="fm-models-hint" id={BOARD_HINT_ID}>
            Drag a model to another level to move it. Hold {thisDesktop().mac ? "⌥" : "Alt"} as you
            drop to use it at both. Or choose it to pick its levels.
          </span>
          {SLOTS.map(lane)}
          <div
            className="fm-models-lane"
            data-slot-group="off"
            data-drop-level="off"
            data-drop={offPlan?.kind}
          >
            <div className="fm-models-lane-head">
              <span className="fm-models-label">Not in use</span>
              <span className="fm-models-hint">
                Never picked on their own. Drag one to a level to place it.
              </span>
            </div>
            <div className="fm-models-chips">
              {notInUse.map((model) => pill(model, "off"))}
              {notInUse.length === 0 && !offPlan && (
                <span className="fm-models-hint">
                  {/* Unlisted models are in no level either, so never claim all are placed. */}
                  {byName.length > 0
                    ? "Every model shown is in a level. Find more from your subscriptions by name under Add model."
                    : "Every model sits in a level."}
                </span>
              )}
              {dropHint(offPlan)}
            </div>
          </div>
        </div>
        {selected && panel(selected)}
      </div>
      {drag &&
        dragged &&
        createPortal(
          <span
            ref={ghost}
            className="fm-models-chip fm-models-ghost"
            data-pinned={isPinned(dragged) ? "" : undefined}
            aria-hidden="true"
            style={{
              left: (press.current?.x ?? 0) - (press.current?.grabX ?? 0),
              top: (press.current?.y ?? 0) - (press.current?.grabY ?? 0),
              width: press.current?.width,
            }}
          >
            <span className="fm-models-chip-name">{face(dragged)}</span>
            {drag.from !== "off" && <span className="fm-models-chip-x">×</span>}
          </span>,
          document.body,
        )}
    </div>
  );
}
