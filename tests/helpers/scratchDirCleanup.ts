import { afterAll, beforeAll } from "vitest";
import { initAttachmentsDir } from "../../src/core/attachments";
import { removeScratchDirs, scratchDir } from "./scratchDirs";

// Message-owned picture copies land in a per-file scratch directory, never in
// the run's TMPDIR root, where an unremoved one would fail the run.
beforeAll(() => {
  initAttachmentsDir(scratchDir("infinitary-attachments-"));
});

// Registered first, so it runs after every hook the test file adds itself:
// a file's own afterAll (closing a database, stopping a child) sees its
// directories still in place.
afterAll(() => {
  removeScratchDirs();
});
