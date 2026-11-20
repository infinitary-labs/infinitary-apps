import { freshPage } from "./freshPage";

// The browser project's setup (vitest.config.ts): before each file, a page
// holding nothing an earlier file left.
await freshPage();
