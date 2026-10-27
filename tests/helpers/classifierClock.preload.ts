import { startClassifierTestClock } from "./classifierClock.ts";

// Only the boxed scorer test passes this preload; the real command never does.
const stop = startClassifierTestClock();
process.once("exit", stop);
