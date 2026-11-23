import { posix } from "node:path";
import ts from "typescript";

/**
 * The messages between the app's window and its core that a change edits,
 * and the ways a journey reaches them (docs/testing.md, "Journeys on the
 * pull request", rule 7). A journey calls the window's interface directly -
 * `window.infinitary.retention.scope()` - so a changed answer breaks it with
 * no hook, sentence or symbol of its own changing. knowledge-gate compares
 * that answer whole, so a new field in it breaks the journey (INF-1136).
 *
 * A message is a channel of the contract (`invokeContract` or
 * `pushContract` in `src/shared/ipc.ts`, with the groups of channels it
 * spreads in from their own modules, such as `src/shared/channels/`). It
 * changes when its entry's code changes, or a declaration of the entry's own
 * module that the entry uses. A schema the contract imports is not followed: the task and card
 * schemas there change with most changes, and most journeys call a method
 * that carries them. The window reaches a message through a method of the
 * preload's `window.infinitary` object, whose own code can change too, or
 * through a read named over it (`readCatalog` in `src/shared/reads.ts`, with
 * the declarations of that module). Comments and spacing are not code.
 */

const CONTRACT = "src/shared/ipc.ts";
/** Where the window API's methods are written (`createApi`), named in a journey's reason. */
export const PRELOAD = "src/preload/api.ts";
/**
 * The preload's modules that may write the API's methods: `createApi`'s
 * returned object in ./api.ts, or a `const api` object in the preload itself,
 * where the API stood before it moved; both sides of a change are read whole.
 */
const PRELOAD_FILES = [PRELOAD, "src/preload/index.ts"];
const READS = "src/shared/reads.ts";

/** The contract's own objects, whose entries are compared one by one with those they spread in. */
const CONTRACT_OBJECTS = ["invokeContract", "pushContract"];

type Read = (file: string) => string | undefined;

/** One top-level declaration or entry: its code without comments or spacing, and the names it uses. */
type Part = { code: string; uses: Set<string> };

/** The changed messages, by the window method or read that carries each, with its channel. */
export type WindowMessages = { methods: Map<string, string>; reads: Map<string, string> };

const printer = ts.createPrinter({ removeComments: true });

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function partOf(node: ts.Node, source: ts.SourceFile): Part {
  const code = printer.printNode(ts.EmitHint.Unspecified, node, source).replace(/\s+/g, " ");
  const uses = new Set<string>();
  const visit = (child: ts.Node) => {
    const parent = child.parent;
    // A property's own name (`.object`, `{ kept: ... }`) is not a declaration it uses.
    const named =
      (ts.isPropertyAccessExpression(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent)) &&
      parent.name === child;
    if (ts.isIdentifier(child) && !named) uses.add(child.text);
    child.forEachChild(visit);
  };
  visit(node);
  return { code, uses };
}

/** A module's top-level declarations, but for the objects whose entries are compared one by one. */
function declarationsOf(file: string, text: string, objects: readonly string[]): Map<string, Part> {
  const source = parse(file, text);
  const parts = new Map<string, Part>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name))
          parts.set(declaration.name.text, partOf(declaration, source));
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      // An overloaded function is every signature together.
      const name = statement.name.text;
      const part = partOf(statement, source);
      const known = parts.get(name);
      parts.set(
        name,
        known
          ? { code: `${known.code} ${part.code}`, uses: new Set([...known.uses, ...part.uses]) }
          : part,
      );
    }
  }
  for (const name of objects) parts.delete(name);
  return parts;
}

/** The declarations the change edits in one module, and those that use one it edits. */
function changedDeclarations(
  file: string,
  before: string,
  after: string,
  objects: readonly string[],
): Set<string> {
  const old = declarationsOf(file, before, objects);
  const next = before === after ? old : declarationsOf(file, after, objects);
  const all = new Set([...old.keys(), ...next.keys()]);
  const changed = new Set([...all].filter((name) => old.get(name)?.code !== next.get(name)?.code));
  let grew = changed.size > 0;
  while (grew) {
    grew = false;
    for (const name of all) {
      if (changed.has(name)) continue;
      const uses = [...(old.get(name)?.uses ?? []), ...(next.get(name)?.uses ?? [])];
      if (uses.some((used) => changed.has(used))) {
        changed.add(name);
        grew = true;
      }
    }
  }
  return changed;
}

/** The properties of a top-level object literal, such as the contract's channels or the read catalog. */
function propertiesOf(source: ts.SourceFile, object: string): ts.ObjectLiteralElementLike[] {
  const properties: ts.ObjectLiteralElementLike[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== object) continue;
      let value = declaration.initializer;
      while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)))
        value = value.expression;
      if (value && ts.isObjectLiteralExpression(value)) properties.push(...value.properties);
    }
  }
  return properties;
}

function entriesOf(file: string, text: string, object: string): Map<string, Part> {
  const source = parse(file, text);
  const entries = new Map<string, Part>();
  for (const property of propertiesOf(source, object)) {
    const name = property.name;
    if (name && (ts.isStringLiteral(name) || ts.isIdentifier(name)))
      entries.set(name.text, partOf(property, source));
  }
  return entries;
}

/**
 * The objects the contract spreads into its own (`...talkChannels`), by the
 * module each is imported from, with the contract's own two objects. An
 * object built by a call (`...channelsOf(workRequests)`) is not followed:
 * like a schema the contract imports, its entries are not the window's.
 */
function contractObjects(text: string): Map<string, Set<string>> {
  const source = parse(CONTRACT, text);
  const modules = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!specifier.startsWith(".") || !bindings || !ts.isNamedImports(bindings)) continue;
    const file = `${posix.join(posix.dirname(CONTRACT), specifier)}.ts`;
    for (const element of bindings.elements) modules.set(element.name.text, file);
  }
  const objects = new Map([[CONTRACT, new Set(CONTRACT_OBJECTS)]]);
  for (const object of CONTRACT_OBJECTS)
    for (const property of propertiesOf(source, object)) {
      if (!ts.isSpreadAssignment(property) || !ts.isIdentifier(property.expression)) continue;
      const name = property.expression.text;
      const file = modules.get(name);
      if (file) objects.set(file, new Set([...(objects.get(file) ?? []), name]));
    }
  return objects;
}

/**
 * Every method of the preload's `window.infinitary` object, by its path
 * (`retention.scope`), with its code. A property whose value is an object
 * literal is a group of methods, however deep. The object is a `const api`
 * or the one `createApi` returns.
 */
function windowMethods(file: string, text: string): Map<string, Part> {
  const source = parse(file, text);
  const methods = new Map<string, Part>();
  const walk = (object: ts.ObjectLiteralExpression, path: string[]) => {
    for (const property of object.properties) {
      const name = property.name;
      if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name))) continue;
      const at = [...path, name.text];
      if (ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer))
        walk(property.initializer, at);
      else methods.set(at.join("."), partOf(property, source));
    }
  };
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "createApi" &&
      statement.body
    ) {
      for (const inner of statement.body.statements)
        if (
          ts.isReturnStatement(inner) &&
          inner.expression &&
          ts.isObjectLiteralExpression(inner.expression)
        )
          walk(inner.expression, []);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations)
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "api" &&
        declaration.initializer &&
        ts.isObjectLiteralExpression(declaration.initializer)
      )
        walk(declaration.initializer, []);
  }
  return methods;
}

function channelsOf(part: Part): string[] {
  return [
    ...new Set([...part.code.matchAll(/["'`](inf:[^"'`\s]+)["'`]/g)].map((match) => match[1] ?? "")),
  ];
}

/**
 * What changed about an entry or a method: the changed channel it names, or
 * when its own code or a declaration it uses changed, the first channel it
 * names ("" for none). Nothing when it is unchanged.
 */
function changeOf(
  before: Part | undefined,
  after: Part | undefined,
  edited: ReadonlySet<string>,
  channels: ReadonlySet<string> = new Set(),
): string | undefined {
  const parts = [after, before].filter((part): part is Part => part !== undefined);
  const named = parts.flatMap(channelsOf);
  const hit = named.find((channel) => channels.has(channel));
  if (hit) return hit;
  const changed =
    before?.code !== after?.code ||
    parts.some((part) => [...part.uses].some((name) => edited.has(name)));
  return changed ? (named[0] ?? "") : undefined;
}

/**
 * The window methods and reads whose message the change edits, with the
 * channel each carries. A change that edits neither module of the contract
 * nor the preload changes none.
 */
export function changedMessages(
  changed: readonly string[],
  read: Read,
  readBefore: Read,
): WindowMessages {
  const messages: WindowMessages = { methods: new Map(), reads: new Map() };
  const sides = (file: string) => [readBefore(file) ?? "", read(file) ?? ""] as const;
  const contract = new Map<string, Set<string>>();
  for (const text of new Set(sides(CONTRACT)))
    for (const [file, objects] of contractObjects(text))
      contract.set(file, new Set([...(contract.get(file) ?? []), ...objects]));
  if (
    !changed.some((file) => contract.has(file) || file === READS || PRELOAD_FILES.includes(file))
  )
    return messages;
  const compare = (
    file: string,
    object: string,
    edited: ReadonlySet<string>,
    channels?: ReadonlySet<string>,
  ) => {
    const [before, after] = sides(file);
    const old = entriesOf(file, before, object);
    const next = entriesOf(file, after, object);
    const result = new Map<string, string>();
    for (const name of new Set([...old.keys(), ...next.keys()])) {
      const channel = changeOf(old.get(name), next.get(name), edited, channels);
      if (channel !== undefined) result.set(name, channel);
    }
    return result;
  };
  const channels = new Set<string>();
  for (const [file, objects] of contract) {
    const edited = changedDeclarations(file, ...sides(file), [...objects]);
    for (const object of objects)
      for (const channel of compare(file, object, edited).keys()) channels.add(channel);
  }
  const methodsOf = (side: 0 | 1) =>
    new Map(PRELOAD_FILES.flatMap((file) => [...windowMethods(file, sides(file)[side])]));
  const old = methodsOf(0);
  const next = methodsOf(1);
  for (const method of new Set([...old.keys(), ...next.keys()])) {
    const channel = changeOf(old.get(method), next.get(method), new Set(), channels);
    if (channel !== undefined) messages.methods.set(method, channel);
  }
  const reads = changedDeclarations(READS, ...sides(READS), ["readCatalog"]);
  messages.reads = compare(READS, "readCatalog", reads, channels);
  return messages;
}

/** The text calls the window method by its whole path: `window.infinitary.retention.scope`, not `...scopes`. */
export function callsMethod(text: string, method: string): boolean {
  const path = method
    .split(".")
    .map((part) => part.replace(/[$]/g, "\\$"))
    .join("\\??\\.");
  return new RegExp(`\\bwindow\\??\\.(?:infinitary|firstmate)\\??\\.${path}(?![\\w$])`).test(text);
}
