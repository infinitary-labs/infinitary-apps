import * as m from "@shared/i18n/messages.generated";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../design";
import { SettingRow } from "./settingRows";

/**
 * Reset Infinitary, in Settings → General (docs/reset.md): the row asks on
 * itself, as Secrets' Forget does, with Keep everything focused so Enter
 * never resets. Confirming quits the app; its next start wipes this
 * computer's Infinitary and opens on the welcome screen.
 */
export function ResetRow() {
  const [asking, setAsking] = useState(false);
  const [openTasks, setOpenTasks] = useState(0);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const reset = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useLayoutEffect(() => {
    if (asking) keep.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      reset.current?.focus();
    }
  }, [asking]);

  const ask = () => {
    setError(null);
    setAsking(true);
    void window.infinitary.app
      .resetScope()
      .then(({ tasks }) => setOpenTasks(tasks))
      .catch(() => setOpenTasks(0));
  };
  const keepEverything = () => {
    returnFocus.current = true;
    setAsking(false);
  };
  const confirm = () => {
    setResetting(true);
    void window.infinitary.app.reset().catch((caught: unknown) => {
      setResetting(false);
      setAsking(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  };

  return (
    <SettingRow
      id="reset-infinitary"
      error={error}
      title={m.settingsGeneralReset()}
      description={m.settingsGeneralResetDescription()}
      detail={
        asking ? (
          <div
            data-reset-question=""
            style={{ display: "grid", gap: "var(--space-2)", marginBlockStart: "var(--space-3)" }}
          >
            <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
              {m.settingsGeneralResetQuestion()}
            </div>
            {[
              m.settingsGeneralResetDeletes(),
              ...(openTasks > 0 ? [m.settingsGeneralResetOpenTasks({ count: openTasks })] : []),
              m.settingsGeneralResetKeeps(),
            ].map((line) => (
              <div key={line} style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
                {line}
              </div>
            ))}
            <span
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--space-2)",
                paddingBlockStart: "var(--space-1)",
              }}
            >
              <Button
                variant="secondary"
                size="sm"
                ref={keep}
                disabled={resetting}
                onClick={keepEverything}
              >
                {m.settingsGeneralResetKeep()}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={confirm}
                pending={resetting}
                pendingLabel={m.settingsGeneralResetting()}
              >
                {m.settingsGeneralReset()}
              </Button>
            </span>
          </div>
        ) : undefined
      }
      control={
        asking ? null : (
          <Button variant="ghost" size="sm" ref={reset} onClick={ask}>
            {m.settingsGeneralResetButton()}
          </Button>
        )
      }
    />
  );
}
