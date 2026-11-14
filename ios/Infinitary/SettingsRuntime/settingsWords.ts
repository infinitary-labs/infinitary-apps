import { phonePage } from "../../../src/renderer/src/settings/phonePages";

/**
 * The phone's Settings pages in the computer's own words (docs/ios.md,
 * "Settings pages in the computer's words"): the script the app runs in
 * JavaScriptCore, with no page, no network and no timers. The phone hands it
 * what the computer answered, as JSON text, and draws the rows it hands back;
 * every rule and sentence in between is the code the computer's own Settings
 * runs, bundled by `node scripts/generate-phone-settings.ts`.
 */
export const page: (name: string, input: string) => string = phonePage;
