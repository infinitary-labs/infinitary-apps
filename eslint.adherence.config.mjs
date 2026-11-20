// Runs the design skill's adherence config against renderer code
// (docs/architecture.md §17, delivery discipline). The skill file is the
// single source of truth: it is loaded verbatim; only the `x-omelette`
// tooling-metadata block (not part of the eslintrc schema) is stripped.
// oxlint cannot execute this config - its load-bearing rules
// (no-restricted-syntax AST selectors, react/forbid-elements) are
// ESLint-only - so ESLint interprets it via FlatCompat.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";
import tsParser from "@typescript-eslint/parser";

const here = dirname(fileURLToPath(import.meta.url));
const skillConfig = JSON.parse(
  readFileSync(`${here}/.claude/skills/infinitary-design/_adherence.oxlintrc.json`, "utf8"),
);
delete skillConfig["x-omelette"];

const compat = new FlatCompat({ baseDirectory: here });

export default [
  ...compat.config(skillConfig).map((config) => ({
    ...config,
    files: ["src/renderer/**/*.ts", "src/renderer/**/*.tsx"],
  })),
  {
    files: ["src/renderer/**/*.ts", "src/renderer/**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
];
