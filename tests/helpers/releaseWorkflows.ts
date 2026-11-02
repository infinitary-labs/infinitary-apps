import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";

// INF-2267: shared by release workflow contracts and behavioral alpha-handoff tests.
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const require = createRequire(import.meta.url);

/** YAML parser electron-builder uses for electron-builder.yml. */
export function loadYamlFile(path: string): Record<string, unknown> {
  const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml") as {
    load: (input: string) => unknown;
  };
  const parsed = yaml.load(read(path));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} did not parse as a mapping`);
  }
  return parsed as Record<string, unknown>;
}

/** A workflow `if:` or `${{ }}` value, evaluated as GitHub Actions does, as plain JSON. */
export function workflowValue(
  value: string,
  contexts: Record<string, unknown>,
  status: Record<"success" | "failure" | "always" | "cancelled", boolean> = {
    success: true,
    failure: false,
    always: true,
    cancelled: false,
  },
): unknown {
  const expression = value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
  const functions = Object.entries(status).map(([name, result]) => ({
    name,
    minArgs: 0,
    maxArgs: 0,
    call: () => new data.BooleanData(result),
  }));
  const ast = new Parser(
    new Lexer(expression).lex().tokens,
    Object.keys(contexts),
    functions,
  ).parse();
  const context = JSON.parse(JSON.stringify(contexts), data.reviver) as data.Dictionary;
  const result = new Evaluator(ast, context, new Map(functions.map((f) => [f.name, f]))).evaluate();
  return JSON.parse(JSON.stringify(result, data.replacer));
}

/** A string carrying `${{ }}` expressions, interpolated as GitHub Actions does. */
export function workflowString(template: string, contexts: Record<string, unknown>): string {
  return template.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
    const value = workflowValue(expression, contexts);
    return value === null ? "" : String(value);
  });
}
