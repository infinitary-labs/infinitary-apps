import { useRef, useState } from "react";
import { SettingSave, type SettingSaveState } from "./settingSave";

export function useSettingSave<T>(read: () => Promise<T>, recoveryHint?: string) {
  const readRef = useRef(read);
  readRef.current = read;
  const [state, setState] = useState<SettingSaveState<T>>({
    value: null,
    error: null,
    saving: false,
  });
  const [writer] = useState(() => new SettingSave(() => readRef.current(), setState, recoveryHint));
  return { ...state, refresh: writer.refresh, apply: writer.apply, save: writer.save };
}
