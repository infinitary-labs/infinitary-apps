// Only a queue job runs this entry; the app imports gitlab.mjs without
// starting work, including when an ESM build inlines that module.
import { run } from "./gitlab.mjs";

run(process.argv[2]).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
