/**
 * The tag a test carries when it runs only on a Mac and skips elsewhere
 * (docs/testing.md, "Each test owns its prerequisites"): the run-alone pass
 * (scripts/e2e-alone.ts) runs the rest on Linux and these on the Mac, and
 * fails on any other test that skips there. The test keeps its own
 * `test.skip` and reason; the tag only says where it runs.
 */
export const MAC_ONLY_TAG = "@mac-only";
