import { PlacedTasks } from "../../src/core/helper/placedTasks";

/**
 * Entry the temporary folder test bundles and runs inside Electron, on a
 * computer's work folder: `temp <dataDir> <task>` removes a closed task's
 * provisioned temporary folder, `leftovers <dataDir> <task>` its leftover
 * files, each the way that computer does when the home asks. Prints the
 * answer as JSON.
 */
const [mode, dataDir, task] = process.argv.slice(2) as [string, string, string];
const tasks = new PlacedTasks(dataDir);
const run = mode === "temp" ? tasks.removeOwnedTemp(task) : tasks.removeLeftovers(task);
run.then(
  (answer) => console.log(JSON.stringify(answer)),
  (error: Error) => {
    console.error(error.message);
    process.exit(1);
  },
);
