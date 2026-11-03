import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { CLAUDE_STORE_RULE, lintClaudeStore } from "../tests/lint/e2eClaudeStore.ts";
import { FIXTURE_OWNER_RULE, lintFixtureOwners } from "../tests/lint/e2eFixtureOwners.ts";
import { FRAME_ACTION_RULE, lintFrameActions } from "../tests/lint/e2eFrameActions.ts";
import { lintMacTag, MAC_TAG_RULE } from "../tests/lint/e2eMacTag.ts";
import { lintTypedWords, productWords, TYPED_WORDS_RULE } from "../tests/lint/e2eTypedWords.ts";
import { lintWriters, WRITER_RULE } from "../tests/lint/e2eWriters.ts";

const root = resolve(process.argv[2] ?? ".");
const files = readdirSync(resolve(root, "tests/e2e"), { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => resolve(root, "tests/e2e", file));
const specs = files.filter((file) => file.endsWith(".spec.ts"));
const found = [
  ...lintFixtureOwners(files).map((diagnostic) => ({ ...diagnostic, rule: FIXTURE_OWNER_RULE })),
  ...lintClaudeStore(specs).map((diagnostic) => ({ ...diagnostic, rule: CLAUDE_STORE_RULE })),
  ...lintFrameActions(files).map((diagnostic) => ({ ...diagnostic, rule: FRAME_ACTION_RULE })),
  ...lintWriters(specs).map((diagnostic) => ({ ...diagnostic, rule: WRITER_RULE })),
  ...lintMacTag(specs).map((diagnostic) => ({ ...diagnostic, rule: MAC_TAG_RULE })),
  ...lintTypedWords(files, productWords(resolve(root, "src"))).map((diagnostic) => ({
    ...diagnostic,
    rule: TYPED_WORDS_RULE,
  })),
];
const count = (rule: string) => found.filter((diagnostic) => diagnostic.rule === rule).length;
for (const diagnostic of found)
  console.error(
    `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.rule}: ${diagnostic.message}`,
  );
console.log(`${FRAME_ACTION_RULE}: ${count(FRAME_ACTION_RULE)} error(s), ${files.length} files checked`);
console.log(`${WRITER_RULE}: ${count(WRITER_RULE)} error(s), ${specs.length} specs checked`);
console.log(`${MAC_TAG_RULE}: ${count(MAC_TAG_RULE)} error(s), ${specs.length} specs checked`);
console.log(`${TYPED_WORDS_RULE}: ${count(TYPED_WORDS_RULE)} error(s), ${files.length} files checked`);
console.log(`${CLAUDE_STORE_RULE}: ${count(CLAUDE_STORE_RULE)} error(s), ${specs.length} specs checked`);
console.log(`${FIXTURE_OWNER_RULE}: ${count(FIXTURE_OWNER_RULE)} error(s), ${files.length} files checked`);
if (found.length) process.exitCode = 1;
