import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const componentPath = resolve(root, "src/renderer/src/design/cards/ResponseCard.tsx");
const rulePath = resolve(root, ".claude/skills/infinitary-design/_adherence.oxlintrc.json");

const source = ts.createSourceFile(
  componentPath,
  readFileSync(componentPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function typeAlias(name: string): ts.TypeAliasDeclaration {
  let found: ts.TypeAliasDeclaration | undefined;
  source.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) found = node;
  });
  if (!found) throw new Error(`${name} is not declared on ResponseCard`);
  return found;
}

function declaredProps(): string[] {
  const alias = typeAlias("ResponseCardProps");
  if (!ts.isTypeLiteralNode(alias.type)) throw new Error("ResponseCardProps is not a type literal");
  return alias.type.members.map((member) => {
    if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name)) {
      throw new Error("ResponseCardProps has a member that is not a named property");
    }
    return member.name.text;
  });
}

function declaredKinds(): string[] {
  const alias = typeAlias("ResponseCardKind");
  if (!ts.isUnionTypeNode(alias.type)) throw new Error("ResponseCardKind is not a union");
  return alias.type.types.map((type) => {
    if (!ts.isLiteralTypeNode(type) || !ts.isStringLiteral(type.literal)) {
      throw new Error("ResponseCardKind has a member that is not a string literal");
    }
    return type.literal.text;
  });
}

type RestrictedRule = { selector: string; message: string };

function responseCardRules(): RestrictedRule[] {
  const config = JSON.parse(readFileSync(rulePath, "utf8")) as {
    rules: { "no-restricted-syntax": unknown[] };
  };
  return config.rules["no-restricted-syntax"].filter(
    (entry): entry is RestrictedRule =>
      typeof entry === "object" &&
      entry !== null &&
      "message" in entry &&
      typeof entry.message === "string" &&
      entry.message.startsWith("<ResponseCard>"),
  );
}

function allowlist(selector: string): string[] {
  const match = selector.match(/\/\^\(\?:([^)]+)\)\$\//);
  if (!match?.[1]) throw new Error(`no allowlist in ${selector}`);
  return [...new Set(match[1].split("|"))];
}

const callSites = [
  "src/renderer/src/app/stage/StackedCard.tsx",
  "src/renderer/src/cards/PastCard.tsx",
  "src/renderer/src/cards/RecordCard.tsx",
];

async function lint(filesOrCode: string[] | { code: string; filePath: string }) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: resolve(root, "eslint.adherence.config.mjs"),
  });
  if (Array.isArray(filesOrCode)) return eslint.lintFiles(filesOrCode);
  return eslint.lintText(filesOrCode.code, { filePath: filesOrCode.filePath });
}

function responseCardWarnings(results: Awaited<ReturnType<typeof lint>>) {
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.message.startsWith("<ResponseCard>"))
      .map((message) => `${result.filePath}:${message.line} ${message.message}`),
  );
}

describe("ResponseCard adherence rule", () => {
  it("names every prop and kind the component declares", () => {
    const [props, kind] = responseCardRules();
    expect(props?.message).toBe(
      `<ResponseCard> doesn't accept that prop. Declared props: ${declaredProps().join(", ")}.`,
    );
    expect(allowlist(props?.selector ?? "").sort()).toEqual(
      [...declaredProps(), "key", "ref", "className"].sort(),
    );
    const kinds = declaredKinds();
    expect(kind?.message).toBe(
      `<ResponseCard> kind must be one of ${kinds.map((value) => `'${value}'`).join(" | ")}.`,
    );
    expect(allowlist(kind?.selector ?? "")).toEqual(kinds);
  });

  it("accepts a real prop and kind, and still warns on one the component does not declare", async () => {
    const props = declaredProps();
    const opening = props
      .map((name) =>
        name === "kind" ? 'kind="note"' : name === "children" ? "" : `${name}={null}`,
      )
      .filter(Boolean)
      .join(" ");
    const filePath = resolve(root, "src/renderer/src/design/cards/adherence-probe.tsx");
    const accepted = await lint({
      filePath,
      code: `export const probe = <ResponseCard ${opening}>body</ResponseCard>;`,
    });
    const refused = await lint({
      filePath,
      code: `export const probe = <ResponseCard notAProp={null} kind="result" />;`,
    });
    expect(responseCardWarnings(accepted)).toEqual([]);
    expect(responseCardWarnings(refused).map((line) => line.replace(/^.*?:\d+ /, ""))).toEqual([
      `<ResponseCard> doesn't accept that prop. Declared props: ${props.join(", ")}.`,
      `<ResponseCard> kind must be one of ${declaredKinds()
        .map((value) => `'${value}'`)
        .join(" | ")}.`,
    ]);
  });

  it("no longer warns on HomeScreen, PastCard and RecordCard for a real ResponseCard prop", async () => {
    const results = await lint(callSites);
    expect(responseCardWarnings(results)).toEqual([]);
  });
});
