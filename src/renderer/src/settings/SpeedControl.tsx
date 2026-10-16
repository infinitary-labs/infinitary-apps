import {
  CREW_SPEEDS,
  type CrewSpeed,
  SPEED_ALLOWANCE_WARNING,
  SPEED_NAMES,
  SPEED_SCOPE,
} from "@shared/crewSpeed";
import { offeringKey, type SlotModelView } from "@shared/modelSlots";
import { useEffect, useRef, useState } from "react";
import { focusWithRing } from "../design/focus";

/** One speed choice for the whole offering, never one for each intelligence level. */
export function SpeedControl({
  model,
  onSave,
}: {
  model: SlotModelView;
  onSave?: (key: string, speed: CrewSpeed) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const select = useRef<HTMLSelectElement>(null);
  const restore = useRef(false);
  useEffect(() => {
    if (!saving && restore.current) {
      restore.current = false;
      if (select.current) focusWithRing(select.current);
    }
  }, [saving]);
  if (model.provider !== "openai-codex") return null;
  const chosen = model.speed ?? "standard";
  const offered = model.speeds;
  const save = async (speed: CrewSpeed) => {
    if (saving) return;
    restore.current = document.activeElement === select.current;
    setSaving(true);
    setError(false);
    try {
      setError(!(await onSave?.(offeringKey(model), speed)));
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="fm-models-speed">
      <label>
        <span>Crew speed</span>
        <select
          ref={select}
          aria-label={`${model.label} crew speed`}
          aria-busy={saving}
          disabled={saving}
          value={chosen}
          onChange={(event) => void save(event.currentTarget.value as CrewSpeed)}
        >
          {CREW_SPEEDS.map((speed) => (
            <option
              key={speed}
              value={speed}
              disabled={speed !== "standard" && !offered?.includes(speed)}
            >
              {SPEED_NAMES[speed]}
              {speed !== "standard" && !offered?.includes(speed)
                ? chosen === speed
                  ? " · saved, unavailable"
                  : " · unavailable"
                : ""}
            </option>
          ))}
        </select>
      </label>
      <p>{SPEED_ALLOWANCE_WARNING}</p>
      <p>{SPEED_SCOPE}</p>
      <p>
        {offered
          ? "Shared across accounts that offer this speed. Otherwise, work uses Standard on the same model and account."
          : "Availability is unknown. Work uses Standard until an account confirms support."}
      </p>
      {error && (
        <p role="alert">
          Could not save crew speed. Your previous choice is still shown. Try again.
        </p>
      )}
    </div>
  );
}
