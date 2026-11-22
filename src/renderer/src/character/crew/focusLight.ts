import type { OrbitFrame } from "./orbit";

/**
 * The project focus on the stage (docs/project-focus.md, docs/crew-orbits.md
 * "Focus"): while the window is focused on a project, or a pointer or the
 * keyboard rests on a project's pill, crewmates of every other project drop
 * to `OUT_OF_FOCUS_LIGHT` of their light, their model names with them. They
 * keep their slot, speed, colour and solid; nothing is hidden and nothing
 * moves for it. The change eases over the surface move (`--dur-med`) and
 * back when focus clears; zero duration (reduced motion) is a cut.
 */

/** The light a crewmate of another project keeps: the captain's staged level on INF-1091. */
export const OUT_OF_FOCUS_LIGHT = 0.25;

export type FocusLightInput = {
  /** The project in light; null lights every crewmate. */
  project: string | null;
  projectOf: (taskId: string) => string | undefined;
};

/** Each crewmate's light as it eases, by task id. */
export type FocusLightState = Map<string, number>;

/** The light a crewmate is headed for: full in the lit project, or with no project known. */
export function lightTarget(input: FocusLightInput, taskId: string): number {
  if (input.project === null) return 1;
  const project = input.projectOf(taskId);
  return project === undefined || project === input.project ? 1 : OUT_OF_FOCUS_LIGHT;
}

/**
 * The frame with each crewmate's alpha times its light, the light moved
 * toward its target by `elapsedMs` of a `durationMs` move. A crewmate gone
 * from the frame lets its light go.
 */
export function lightFrame(
  frame: OrbitFrame,
  input: FocusLightInput,
  state: FocusLightState,
  elapsedMs: number,
  durationMs: number,
): OrbitFrame {
  const present = new Set<string>();
  let changed = false;
  const crew = frame.crew.map((cm) => {
    present.add(cm.id);
    const target = lightTarget(input, cm.id);
    const was = state.get(cm.id) ?? target;
    const step = durationMs <= 0 ? 1 : Math.min(1, Math.max(0, elapsedMs) / durationMs);
    const light =
      Math.abs(target - was) <= step * (1 - OUT_OF_FOCUS_LIGHT)
        ? target
        : was + Math.sign(target - was) * step * (1 - OUT_OF_FOCUS_LIGHT);
    state.set(cm.id, light);
    if (light === 1) return cm;
    changed = true;
    return { ...cm, alpha: cm.alpha * light };
  });
  for (const id of state.keys()) if (!present.has(id)) state.delete(id);
  return changed ? { ...frame, crew } : frame;
}
