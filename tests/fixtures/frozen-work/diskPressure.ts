import { startUnitLoadClock } from "../../helpers/budgets";

// The disk tests/wait-window.test.ts gives each run: the worker's load clock
// reads this counter, in microseconds, in place of the computer's own (Linux's
// /proc/pressure/io), so other work on the computer's disk never moves a run's
// waits. A run the test starts with its disk stalled waits on its disk
// throughout, from before its first test, so its counter grows with the
// worker's own time; every other run's stands still. Listed before
// waitWindow.ts, in order, so the clock waitWindow.ts finds started is this one.
const stalled = process.env.INFINITARY_FROZEN_WORK_DISK_STALLED === "1";

startUnitLoadClock(stalled ? () => performance.now() * 1000 : () => 0);
