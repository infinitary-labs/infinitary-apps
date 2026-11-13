import * as m from "@shared/i18n/messages.generated";
import {
  offeringKey,
  type ReasoningChoice,
  type Slot,
  type SlotModelView,
} from "@shared/modelSlots";
import { reasoningWord } from "@shared/reasoning";
import { useEffect, useRef, useState } from "react";
import { Button } from "../design";
import { focusWithRing } from "../design/focus";
import { REASONING_WORDS, reasoningLabel } from "./reasoningWords";

/** One control reaches only this offering in this level. Saved state is never optimistic. */
export function ReasoningControl({
  model,
  slot,
  onSave,
}: {
  model: SlotModelView;
  slot: Slot;
  onSave?: (key: string, slot: Slot, value: ReasoningChoice | null) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const restoreFocus = useRef(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!saving && restoreFocus.current) {
      restoreFocus.current = false;
      if (
        document.activeElement === document.body ||
        root.current?.contains(document.activeElement)
      ) {
        const target =
          root.current?.querySelector<HTMLElement>("select,button") ??
          root.current?.parentElement?.querySelector<HTMLElement>(".fm-models-chip-name");
        if (target) focusWithRing(target);
      }
    }
  }, [saving]);
  const save = async (value: ReasoningChoice | null) => {
    if (saving) return;
    restoreFocus.current = root.current?.contains(document.activeElement) ?? false;
    setSaving(true);
    setError(false);
    try {
      setError(!(await onSave?.(offeringKey(model), slot, value)));
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  const capabilities = model.reasoningCapabilities;
  const saved = model.reasoning?.[slot];
  const chosen = saved?.chosen;
  const offered = capabilities?.levels ?? [];
  const unavailable = chosen && !offered.includes(chosen);
  return (
    <span ref={root} className="fm-models-reasoning">
      {offered.length > 0 ? (
        <select
          aria-label={reasoningLabel(model, slot)}
          value={chosen ?? ""}
          aria-busy={saving}
          onChange={(event) =>
            void save((event.currentTarget.value as ReasoningChoice | "") || null)
          }
        >
          <option value="">{REASONING_WORDS.useLevelDefault}</option>
          {unavailable && (
            <option value={chosen} disabled>
              {m.settingsReasoningSavedUnavailable({ reasoning: reasoningWord({ level: chosen }) })}
            </option>
          )}
          {offered.map((level) => (
            <option key={level} value={level}>
              {reasoningWord({ level })}
            </option>
          ))}
        </select>
      ) : (
        <span>
          {capabilities?.fixed
            ? reasoningWord({ level: capabilities.fixed })
            : m.settingsReasoningUnavailable()}
        </span>
      )}
      {chosen && offered.length === 0 && (
        <Button variant="ghost" size="sm" onClick={() => void save(null)}>
          {REASONING_WORDS.useLevelDefault}
        </Button>
      )}
      {error && (
        <span role="alert" className="fm-models-hint">
          {m.settingsReasoningSaveFailed()}
        </span>
      )}
    </span>
  );
}
