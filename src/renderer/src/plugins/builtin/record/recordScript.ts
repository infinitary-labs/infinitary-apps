import { recordAttentionWaits, taskWaitText } from "@shared/taskWaits";
import raw from "./record.frame.js?raw";

/** The sandbox keeps no second formatter or clock semantics. Both functions are self-contained. */
export const recordScript = raw.replace(
  "/* shared wait functions */",
  `, ${taskWaitText.toString()}, ${recordAttentionWaits.toString()}`,
);
