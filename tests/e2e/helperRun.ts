// The helper loads its sign-ins and conversations code with the first order
// that needs it (src/core/helper/run.ts). In a journey that starts a helper in
// this process, Playwright compiles that code on the worker's own thread then,
// and never keeps the compile for the next run, so the test's clock froze for
// seconds inside a timed wait once the home marked the Mac in reach (INF-615,
// INF-616: view.spec.ts's in-reach check failed on a busy runner). Loading both
// here compiles them as the spec file loads, before any test's clock starts;
// the helper's own lazy import then finds them already loaded.
import "@core/helper/conversations";
import "@core/helper/signIns";

export { type HelperRun, startHelper } from "@core/helper/run";
