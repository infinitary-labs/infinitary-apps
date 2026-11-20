import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { LOAD_COMMAND } from "../../src/shared/load";

/**
 * The environment of a shell whose app has no load line: every PATH entry
 * holding the load command left out. A heavy-run gate started with it starts
 * at once (scripts/heavy-run-place.ts), even when the test itself runs in a
 * task shell that has a line.
 */
export function withoutLoadLine(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const path = (env.PATH ?? "").split(delimiter).filter((dir) => {
    try {
      accessSync(join(dir, LOAD_COMMAND), constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
  return { ...env, PATH: path.join(delimiter) };
}
