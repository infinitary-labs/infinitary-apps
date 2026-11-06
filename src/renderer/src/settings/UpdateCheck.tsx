import { useEffect } from "react";
import { UpdateStepButtons, UpdateStepText, useUpdateStep } from "../app/UpdateStepView";
import { refreshUpdateStatus } from "../app/updateState";

/**
 * The update row's two pieces on the Version row in Settings → General
 * (docs/alpha.md "Update channels"): the ladder's line under the version,
 * and the step's buttons in the row's control, drawn from the same step as
 * the top-right update notice (../app/UpdateStepView.tsx). Every state names its
 * next step beside a button that takes it; installing still waits for its
 * own click.
 */

export function UpdateRowLine() {
  const { step } = useUpdateStep();
  useEffect(() => {
    void refreshUpdateStatus();
  }, []);
  if (!step) return null;
  return (
    <div style={{ marginTop: "var(--space-2)" }}>
      <UpdateStepText step={step} />
    </div>
  );
}

export function UpdateRowControl() {
  const { step } = useUpdateStep();
  if (!step) return null;
  // The next step is what command search's Check for updates focuses.
  return <UpdateStepButtons step={step} hook />;
}
