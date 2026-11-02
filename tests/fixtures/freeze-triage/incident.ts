import type { FreezeLine } from "../../../src/core/freeze/freezeRecorder";

/** INF-2262's approved reports-and-triage option. Retained incident facts,
 * not a reconstruction: the raw line and original offer body are unavailable.
 * Later timings are a different process/snapshot, not a causal profile.
 */
export const knowledgeFreeze: FreezeLine = {
  at: "(not retained)",
  wallMs: 324,
  cpuMs: 298,
  frames: ["rowFactory", "search", "shortlist", "knowledgeShortlist", "mintBrief", "startTask"].map(
    (name) => ({
      name,
      file: "(not retained)",
      line: 0,
      column: 0,
    }),
  ),
};
