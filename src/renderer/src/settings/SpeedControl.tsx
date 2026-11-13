import {
  CREW_SPEEDS,
  type CrewSpeed,
  SPEED_ALLOWANCE_WARNING,
  SPEED_NAMES,
  SPEED_SCOPE,
} from "@shared/crewSpeed";
import * as m from "@shared/i18n/messages.generated";
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
        <span>{m.settingsSpeedCrewSpeed()}</span>
        <select
          ref={select}
          aria-label={m.settingsSpeedLabel({ model: model.label })}
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
              {speed !== "standard" && !offered?.includes(speed)
                ? chosen === speed
                  ? m.settingsSpeedSavedUnavailable({ speed: SPEED_NAMES[speed] })
                  : m.settingsSpeedUnavailable({ speed: SPEED_NAMES[speed] })
                : SPEED_NAMES[speed]}
            </option>
          ))}
        </select>
      </label>
      <p>{SPEED_ALLOWANCE_WARNING}</p>
      <p>{SPEED_SCOPE}</p>
      <p>{offered ? m.settingsSpeedShared() : m.settingsSpeedUnknown()}</p>
      {error && <p role="alert">{m.settingsSpeedSaveFailed()}</p>}
    </div>
  );
}
