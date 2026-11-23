/**
 * The raw-words check (docs/i18n.md, "Words still typed in the code"): the
 * words the window, its panels and the shared, core, main-process and
 * preload code show come from the catalog, so a file under those roots
 * holds no words typed in for a person to read. The files that still do are on `RAW_WORDS_LEDGER` with how many
 * runs of words each held when listed. The check fails only when a file gains
 * words: a file not on it must hold none, a listed file may not hold more than
 * its entry, and a file the branch changed may not hold more than it did where
 * the branch started. A file that lost words needs no edit to the ledger: once
 * the merge batch puts the change on main, main's own lower count is the next
 * change's limit, so two changes that both lower one file never clash over it
 * (INF-5395's fix 1).
 *
 * What counts as words a person reads, read from each file's syntax:
 * - JSX text holding a letter;
 * - a string or template in a JSX attribute a person reads (`aria-label`,
 *   `title`, `placeholder`, `alt`, `label` and their kin);
 * - anywhere else, a string or template that reads as prose: two or more
 *   words holding letters, or one capitalized word such as `Cancel`, that is
 *   not an id, a class list, a key name, a path or a style.
 * A string compared with `===`, used as a case, a property name, a type, an
 * import, a selector or an event name, or handed to an `Error` or `console`
 * is not words a person reads. Words that must stay typed in say why with
 * `i18n-exempt: <reason>` on their line or the line above, which covers the
 * statement or expression starting there: a name, a symbol,
 * or a developer-only view.
 *
 *   node scripts/raw-words.ts          exits 1 naming each file that gained raw words
 *   node scripts/raw-words.ts --list   every file holding raw words, with its count
 *   node scripts/raw-words.ts --show <file>   each run of raw words in one file
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { baseRef } from "./check-changed.ts";

/**
 * Where the check reads: the window, the app's own panels and the built-in
 * runbooks' panels, and the shared,
 * core, main-process and preload code whose words reach a person, so new
 * English there is refused as in the window.
 */
export const RAW_WORDS_ROOTS: readonly string[] = [
  "src/renderer/src/",
  "src/panels/",
  "resources/runbooks/",
  "src/shared/",
  "src/core/",
  "src/main/",
  "src/preload/",
];

/**
 * Files under the roots that are not shown to a person: the developer-only
 * gallery of the design's parts and Observe view, generated files, and the
 * text served only to a model - the prompt's own sections and the tools'
 * definitions - which stays English (docs/i18n.md, "What stays English").
 */
const NOT_SHOWN = [
  /^src\/renderer\/src\/design\/fixtures\//,
  /^src\/renderer\/src\/plugins\/builtin\/observe\//,
  /\.generated\.tsx?$/,
  /^src\/core\/prompts\//,
  /^src\/core\/.*Tools\.ts$/,
];

/** JSX attributes whose value a person reads or hears. */
const TEXT_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "aria-placeholder",
  "title",
  "placeholder",
  "alt",
  "label",
]);

/** Single capitalized words a key or an event names, never words a person reads. */
const KEY_NAMES = new Set([
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "Shift",
  "Meta",
  "Alt",
  "Control",
  "Space",
  "Insert",
  "Dead",
  "Unidentified",
  "Process",
  "PageUp",
  "PageDown",
  "Infinitary",
]);

/** Calls whose string arguments name code, not words: selectors, attributes, events, errors and logs. */
const CODE_CALLS = new Set([
  "querySelector",
  "querySelectorAll",
  "getElementById",
  "getElementsByClassName",
  "closest",
  "matches",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "setAttribute",
  "getAttribute",
  "hasAttribute",
  "removeAttribute",
  "toggleAttribute",
  "setProperty",
  "getPropertyValue",
  "createElement",
  "add",
  "remove",
  "toggle",
  "contains",
  "invoke",
  "send",
  "on",
  "off",
  "emit",
  "postMessage",
  "require",
  "Symbol",
  "Error",
  "TypeError",
  "RangeError",
  "describe",
  "it",
  "test",
]);

const WAIVER = /i18n-exempt:\s*\S/;

/** CSS functions and the like: a value with one of these is a style, not words. */
const CSS_FUNCTIONS =
  /var\(--|calc\(|min\(|max\(|minmax\(|clamp\(|color-mix\(|translate[XYZ3d]*\(|rotate\(|scale[XY]?\(|rgba?\(|hsla?\(|oklch\(|cubic-bezier\(|steps\(|repeat\(|(linear|radial|conic)-gradient\(|inset\(|drop-shadow\(|blur\(/;
/** One word of a CSS value: a length, a time, a keyword or an easing. */
const CSS_WORD =
  /^(-?[\d.]+(px|em|rem|%|ms|s|deg|turn|fr|vh|vw|vmin|vmax|ch|ex|lh|dvh|svh)?|auto|none|solid|dashed|dotted|double|transparent|inherit|initial|unset|currentcolor|ease|ease-in|ease-out|ease-in-out|linear|normal|bold|italic|nowrap|hidden|visible|clip|scroll|absolute|relative|fixed|sticky|flex|grid|block|contents|inline|inline-flex|inline-block|inline-grid|center|start|end|flex-start|flex-end|space-between|space-around|baseline|stretch|pointer|default|column|row|wrap|both|forwards|backwards|infinite|alternate|opacity|transform|background|color|border-color|box-shadow|width|height|top|left|right|bottom|span|dense|min-content|max-content|fit-content|break-word|anywhere|pre-wrap|uppercase|lowercase|tabular-nums|ellipsis|[a-z]+(-[a-z]+)*\(.*\)?|\/)$/i;

/** Whether a literal is a style, a media query or a selector rather than words. */
function readsAsCode(text: string): boolean {
  if (CSS_FUNCTIONS.test(text)) return true;
  if (/^\(\s*[a-z-]+\s*(:|\))/.test(text) || text.startsWith("@media")) return true;
  if (/^\(.*\b\d+(px|vh|vw|%)/.test(text)) return true;
  if (/^\s*(<|&lt;)[a-z/!]/i.test(text)) return true;
  if (/^[MmLlHhVvCcSsQqTtAaZz][\d\s.,MmLlHhVvCcSsQqTtAaZz-]*$/.test(text) && /\d/.test(text)) return true;
  if (/\[[\w-]+(?:[~|^$*]?=[^\]]*)?\]|:not\(|:focus|:hover|::?[a-z-]+\(/.test(text)) return true;
  return text.split(/[\s,]+/).every((word) => word === "" || CSS_WORD.test(word));
}

export function readsAsWords(text: string): boolean {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!/\p{L}/u.test(trimmed)) return false;
  if (readsAsCode(trimmed)) return false;
  if (/^(https?:|mailto:|file:|data:|[./~]|#[\w-]+$)/.test(trimmed)) return false;
  if (/[{};]/.test(trimmed) && /:/.test(trimmed)) return false;
  const words = trimmed.split(" ").filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) return false;
  if (words.length === 1) {
    const word = (words[0] ?? "").replace(/[.,:;!?…)]+$/, "").replace(/^[(]+/, "");
    if (KEY_NAMES.has(word)) return false;
    return /^\p{Lu}\p{Ll}+$/u.test(word) || (/^\p{Lu}\p{Ll}/u.test(word) && /[.!?…:]$/.test(trimmed));
  }
  if (!/\p{Ll}/u.test(trimmed)) return false;
  if (words.every((word) => /^[a-z0-9]+([-_:/.][a-z0-9]+)+$/.test(word) || /^--/.test(word))) return false;
  if (words.some((word) => /^[a-z][\w]*-[\w-]+$/.test(word)) && words.every((word) => /^[\w-]+$/.test(word)))
    return false;
  if (words.every((word) => /^[a-z]+[A-Z]\w*$/.test(word) || /^[\w.]+\(.*\)$/.test(word))) return false;
  return true;
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) {
    if (ts.isIdentifier(callee.expression) && callee.expression.text === "console") return "console";
    return callee.name.text;
  }
  return undefined;
}

/** Whether a literal sits where its text names code rather than words a person reads. */
function inCodePosition(node: ts.Node): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent) ||
      (ts.isConditionalExpression(parent) && child !== parent.condition) ||
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)))
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent))
    return true;
  if (ts.isLiteralTypeNode(parent) || ts.isImportTypeNode(parent)) return true;
  if (ts.isCaseClause(parent)) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === child) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === child)
    return true;
  if (ts.isEnumMember(parent)) return true;
  if (ts.isExpressionStatement(parent)) return true;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.InKeyword
    )
      return true;
  }
  if (ts.isJsxAttribute(parent) || (ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent))) {
    const attribute = ts.isJsxAttribute(parent) ? parent : (parent.parent as ts.JsxAttribute);
    return !TEXT_ATTRIBUTES.has(attribute.name.getText());
  }
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    const name = calleeName(parent);
    if (name === "console" || (name && (CODE_CALLS.has(name) || /Error$/.test(name)))) return true;
    if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
      const receiver = parent.expression.expression.getText();
      if (/\b(classList|dataset|style|localStorage|sessionStorage)$/.test(receiver)) return true;
    }
  }
  if (ts.isTaggedTemplateExpression(parent)) return true;
  if (ts.isThrowStatement(parent)) return true;
  return false;
}

/** A template's own text, with each hole standing for a number. */
function templateText(node: ts.TemplateExpression): string {
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("0");
}

/** CSS units and other short code a template writes beside a hole. */
const TEMPLATE_CODE = /^(px|em|rem|ms|s|vh|vw|deg|fr|ch|ex|x|n|k|kb|mb|gb)$/i;

/** Whether a template's own text reads as words: as a string does, or one plain word beside a hole, such as `{n} closed`. */
function templateReadsAsWords(text: string): boolean {
  if (readsAsCode(text)) return false;
  if (readsAsWords(text)) return true;
  if (/[{};()=<>]/.test(text) || /^\s*[./#~-]/.test(text)) return false;
  const words = text.split(/\s+/).filter((word) => /\p{L}/u.test(word));
  const [word] = words;
  return words.length === 1 && word !== undefined && /^\p{Ll}{3,}[.,]?$/u.test(word) && !TEMPLATE_CODE.test(word);
}

export type RawWords = { line: number; text: string };

export function rawWordsIn(path: string, text: string): RawWords[] {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const lines = text.split("\n");
  const found: RawWords[] = [];
  const at = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line;
  // A waiver on a node's line or the line above covers it, and one above a
  // statement or an expression covers every run inside it.
  const waived = (node: ts.Node) => {
    for (let around: ts.Node | undefined = node; around && !ts.isSourceFile(around); around = around.parent) {
      if (ts.isBlock(around) || ts.isModuleBlock(around)) break;
      const line = at(around);
      if (WAIVER.test(lines[line] ?? "") || WAIVER.test(lines[line - 1] ?? "")) return true;
    }
    return false;
  };
  const add = (node: ts.Node, words: string) => {
    if (!waived(node)) found.push({ line: at(node) + 1, text: words.replace(/\s+/g, " ").trim() });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (/\p{L}/u.test(node.text)) add(node, node.text);
      return;
    }
    if (ts.isJsxAttribute(node) && TEXT_ATTRIBUTES.has(node.name.getText()) && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) {
        if (/\p{L}/u.test(node.initializer.text)) add(node, node.initializer.text);
        return;
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!inCodePosition(node) && readsAsWords(node.text)) add(node, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      if (!inCodePosition(node) && templateReadsAsWords(templateText(node))) add(node, node.getText(tree));
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

export function isCheckedFile(path: string): boolean {
  if (!/\.(tsx?|js)$/.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path) || path.endsWith(".d.ts")) return false;
  if (NOT_SHOWN.some((pattern) => pattern.test(path))) return false;
  return RAW_WORDS_ROOTS.some((root) => (root.endsWith("/") ? path.startsWith(root) : path === root));
}

/**
 * The files that still hold raw words, with how many runs each held when
 * listed: the most each may hold. A change never has to lower an entry; the
 * branch's starting point holds a file to what main holds now
 * (`ledgerProblems`'s `atBase`). An entry is added only for a file that must
 * hold words, such as one split out of a listed file, and the ledger is
 * emptied when every area's words are in the catalog.
 */
export const RAW_WORDS_LEDGER: Readonly<Record<string, number>> = {
  "src/core/attachments.ts": 1,
  "src/core/axi/axiProcess.ts": 2,
  "src/core/axi/browserCommands.ts": 97,
  "src/core/axi/captainCommands.ts": 158,
  "src/core/axi/channel.ts": 33,
  "src/core/axi/cli.ts": 9,
  "src/core/axi/commandDoor.ts": 19,
  "src/core/axi/fileCommands.ts": 24,
  "src/core/axi/integrationCommands.ts": 21,
  "src/core/axi/loadCommands.ts": 7,
  "src/core/axi/secretsCommands.ts": 15,
  "src/core/axi/stopCommands.ts": 26,
  "src/core/batches/batches.ts": 16,
  "src/core/batches/combine.ts": 11,
  "src/core/batches/description.ts": 5,
  "src/core/bootRecovery.ts": 4,
  "src/core/browser/browserRecord.ts": 9,
  "src/core/browser/changes.ts": 7,
  "src/core/browser/connectionGuard.ts": 11,
  "src/core/browser/crewmateCommands.ts": 104,
  "src/core/browser/destinations.ts": 6,
  "src/core/browser/diagnostics.ts": 7,
  "src/core/browser/evidenceFiles.ts": 5,
  "src/core/browser/homeTaskBrowsers.ts": 1,
  "src/core/browser/outline.ts": 21,
  "src/core/browser/pageActions.ts": 58,
  "src/core/browser/pageNotices.ts": 56,
  "src/core/browser/projectServer.ts": 11,
  "src/core/browser/savedSignInGrants.ts": 22,
  "src/core/browser/taskBrowsers.ts": 61,
  "src/core/browser/window.ts": 24,
  "src/core/claude/claudeAuth.ts": 18,
  "src/core/claude/claudeCli.ts": 1,
  "src/core/claude/claudeCostReports.ts": 1,
  "src/core/claude/claudeEvents.ts": 2,
  "src/core/claude/claudeModelCatalog.ts": 2,
  "src/core/claude/claudeModels.ts": 4,
  "src/core/claude/claudeOneShotSession.ts": 1,
  "src/core/claude/claudeProjectResources.ts": 5,
  "src/core/claude/claudeQueryCore.ts": 1,
  "src/core/claude/claudeQuota.ts": 1,
  "src/core/claude/claudeRollingSession.ts": 8,
  "src/core/claude/claudeSessionRecord.ts": 5,
  "src/core/claude/session.ts": 1,
  "src/core/connection/connection.ts": 50,
  "src/core/decisions/cardReader.ts": 18,
  "src/core/decisions/correctionCases.ts": 12,
  "src/core/decisions/correctionConsumer.ts": 1,
  "src/core/decisions/correctionContext.ts": 1,
  "src/core/decisions/correctionQuestion.ts": 14,
  "src/core/decisions/decisionModel.ts": 6,
  "src/core/decisions/eventScreen.ts": 9,
  "src/core/decisions/eventScreenOffer.ts": 7,
  "src/core/decisions/jev/jevClient.ts": 1,
  "src/core/devices/captainPlaces.ts": 1,
  "src/core/devices/computers.ts": 1,
  "src/core/devices/deviceSetup.ts": 5,
  "src/core/devices/deviceSignIns.ts": 3,
  "src/core/devices/deviceUpdateNudge.ts": 6,
  "src/core/devices/dial.ts": 3,
  "src/core/devices/dnsSd.ts": 4,
  "src/core/devices/farSystems.ts": 85,
  "src/core/devices/firewall.ts": 1,
  "src/core/devices/homeDevices.ts": 1,
  "src/core/devices/homeLink.ts": 4,
  "src/core/devices/hostKey.ts": 1,
  "src/core/devices/identity.ts": 2,
  "src/core/devices/joinCommand.ts": 54,
  "src/core/devices/joinedHome.ts": 1,
  "src/core/devices/pairing.ts": 24,
  "src/core/devices/pairingRules.ts": 9,
  "src/core/devices/pairingPushRecords.ts": 5,
  "src/core/devices/phoneDoor.ts": 3,
  "src/core/devices/publishedBuilds.ts": 1,
  "src/core/devices/remoteDownload.ts": 23,
  "src/core/devices/remoteLogin.ts": 1,
  "src/core/devices/sshPassword.ts": 11,
  "src/core/devices/ubuntuPackage.ts": 44,
  "src/core/devices/windowsAnnounce.ts": 1,
  "src/core/devices/windowsDnsSd.ts": 6,
  "src/core/dispatcher.ts": 9,
  "src/core/dispatcher/actionTrail.ts": 3,
  "src/core/dispatcher/catalogDispatch.ts": 10,
  "src/core/files/cardFileReads.ts": 2,
  "src/core/files/fileReach.ts": 14,
  "src/core/files/fileRouter.ts": 19,
  "src/core/files/setAside.ts": 10,
  "src/core/folderMove/copy.ts": 1,
  "src/core/folderMove/rewrite.ts": 8,
  "src/core/folderMove/taskFolders.ts": 3,
  "src/core/folderMove/tree.ts": 3,
  "src/core/fontFormat.ts": 25,
  "src/core/forge/api.ts": 24,
  "src/core/forge/apiWriteGuard.ts": 1,
  "src/core/forge/contributions.ts": 1,
  "src/core/forge/forge.ts": 3,
  "src/core/forge/forkStory.ts": 1,
  "src/core/forge/githubCli.ts": 3,
  "src/core/forge/healthNote.ts": 1,
  "src/core/forge/pipelineAttestation.ts": 3,
  "src/core/forge/presentation.ts": 23,
  "src/core/forge/presentationTiers.ts": 19,
  "src/core/forge/presentationValidation.ts": 2,
  "src/core/forge/projects.ts": 11,
  "src/core/forge/providers/bitbucket/client.ts": 2,
  "src/core/forge/providers/bitbucket/signIn.ts": 3,
  "src/core/forge/providers/github/attachments.ts": 1,
  "src/core/forge/providers/github/changes.ts": 1,
  "src/core/forge/providers/github/githubForge.ts": 21,
  "src/core/forge/providers/github/oauth.ts": 5,
  "src/core/forge/providers/gitlab/api.ts": 5,
  "src/core/forge/providers/gitlab/attachments.ts": 2,
  "src/core/forge/providers/gitlab/client.ts": 11,
  "src/core/forge/providers/gitlab/contributions.ts": 1,
  "src/core/forge/providers/gitlab/gitlabForge.ts": 18,
  "src/core/forge/providers/gitlab/oauth.ts": 1,
  "src/core/forge/providers/gitlab/signIn.ts": 2,
  "src/core/forge/providers/gitlab/workflows.ts": 8,
  "src/core/forge/releaseFile.ts": 10,
  "src/core/forge/signInRefusal.ts": 3,
  "src/core/forge/signIns.ts": 22,
  "src/core/gifFormat.ts": 19,
  "src/core/helper/accounts.ts": 1,
  "src/core/helper/background.ts": 9,
  "src/core/helper/browsers.ts": 2,
  "src/core/helper/cli.ts": 3,
  "src/core/helper/conversations.ts": 6,
  "src/core/helper/forges.ts": 4,
  "src/core/helper/integrationsThere.ts": 1,
  "src/core/helper/lock.ts": 1,
  "src/core/helper/moveWork.ts": 7,
  "src/core/helper/run.ts": 17,
  "src/core/helper/runAgent.ts": 1,
  "src/core/helper/secretUses.ts": 2,
  "src/core/helper/sessionHost.ts": 12,
  "src/core/helper/signIns.ts": 2,
  "src/core/helper/toolCallbacks.ts": 1,
  "src/core/helper/update.ts": 4,
  "src/core/helper/updateTrial.ts": 9,
  "src/core/helper/windowsTask.ts": 3,
  "src/core/helper/words.ts": 141,
  "src/core/helper/workingCopies.ts": 1,
  "src/core/homeMove/arriving.ts": 5,
  "src/core/homeMove/handlers.ts": 1,
  "src/core/homeMove/record.ts": 1,
  "src/core/homeMove/wiring.ts": 3,
  "src/core/homeMove/words.ts": 44,
  "src/core/homeProjects.ts": 1,
  "src/core/hostEnv.ts": 3,
  "src/core/integrations/appEvents.ts": 3,
  "src/core/integrations/commandWords.ts": 1,
  "src/core/integrations/providers/github.ts": 6,
  "src/core/integrations/providers/githubRuns.ts": 18,
  "src/core/integrations/providers/google/calendar.ts": 27,
  "src/core/integrations/providers/google/gmail.ts": 43,
  "src/core/integrations/providers/google/googleIntegration.ts": 16,
  "src/core/integrations/providers/google/signIn.ts": 3,
  "src/core/integrations/providers/inbox.ts": 7,
  "src/core/integrations/providers/mcp/mcpIntegration.ts": 28,
  "src/core/integrations/providers/standIn.ts": 4,
  "src/core/integrations/scopes.ts": 9,
  "src/core/integrations/secrets.ts": 1,
  "src/core/integrations/service.ts": 60,
  "src/core/jobs/jobManager.ts": 1,
  "src/core/keyFormats.ts": 1,
  "src/core/knowledge/access.ts": 13,
  "src/core/knowledge/context.ts": 10,
  "src/core/knowledge/directions.ts": 11,
  "src/core/knowledge/knowledgeService.ts": 8,
  "src/core/knowledge/render.ts": 41,
  "src/core/knowledge/search.ts": 1,
  "src/core/knowledge/sources.ts": 36,
  "src/core/knowledge/windowReads.ts": 4,
  "src/core/knowledge/writes.ts": 70,
  "src/core/loginShellStub.ts": 2,
  "src/core/models/catalogChecks.ts": 5,
  "src/core/models/clientLists.ts": 2,
  "src/core/models/piAccountLists.ts": 2,
  "src/core/models/servedModels.ts": 2,
  "src/core/observe/claudeTranscript.ts": 2,
  "src/core/observe/gate.ts": 1,
  "src/core/observe/observeService.ts": 11,
  "src/core/observe/redact.ts": 18,
  "src/core/observe/transcript.ts": 3,
  "src/core/orchestrator/answerDelivery.ts": 7,
  "src/core/orchestrator/askAttribution.ts": 2,
  "src/core/orchestrator/askCapture.ts": 5,
  "src/core/orchestrator/askEnding.ts": 3,
  "src/core/orchestrator/captainOverrides.ts": 16,
  "src/core/orchestrator/captainWakes.ts": 63,
  "src/core/orchestrator/cardActions.ts": 30,
  "src/core/orchestrator/cardBrowserActions.ts": 3,
  "src/core/orchestrator/cardChanges.ts": 3,
  "src/core/orchestrator/cardEmit.ts": 2,
  "src/core/orchestrator/cardMutationText.ts": 20,
  "src/core/orchestrator/cardNavigation.ts": 1,
  "src/core/orchestrator/cardService.ts": 8,
  "src/core/orchestrator/cardSignOff.ts": 9,
  "src/core/orchestrator/cardThreads.ts": 40,
  "src/core/orchestrator/changeChecks.ts": 22,
  "src/core/orchestrator/changeContext.ts": 13,
  "src/core/orchestrator/changeMerge.ts": 80,
  "src/core/orchestrator/changePresentations.ts": 20,
  "src/core/orchestrator/changePublication.ts": 75,
  "src/core/orchestrator/checkChangeTool.ts": 39,
  "src/core/orchestrator/checkRepair.ts": 19,
  "src/core/orchestrator/checkVerdicts.ts": 7,
  "src/core/orchestrator/ciFact.ts": 1,
  "src/core/orchestrator/costLimits.ts": 19,
  "src/core/orchestrator/crewBrief.ts": 4,
  "src/core/orchestrator/crewFacts.ts": 16,
  "src/core/orchestrator/crewmateCards.ts": 40,
  "src/core/orchestrator/crewmatePrograms.ts": 11,
  "src/core/orchestrator/crewSession.ts": 18,
  "src/core/orchestrator/crewSessions.ts": 23,
  "src/core/orchestrator/crewSteer.ts": 13,
  "src/core/orchestrator/crewSupervisor.ts": 10,
  "src/core/orchestrator/crewToolHooks.ts": 3,
  "src/core/orchestrator/crewTurns.ts": 34,
  "src/core/orchestrator/crewUpdates.ts": 9,
  "src/core/orchestrator/crewWatch.ts": 31,
  "src/core/orchestrator/declaredCloses.ts": 3,
  "src/core/orchestrator/deliveryWakes.ts": 106,
  "src/core/orchestrator/doneClose.ts": 63,
  "src/core/orchestrator/draftReadiness.ts": 3,
  "src/core/orchestrator/endedCards.ts": 1,
  "src/core/orchestrator/firstmateAgent.ts": 15,
  "src/core/orchestrator/firstmateContext.ts": 71,
  "src/core/orchestrator/firstmateSeat.ts": 55,
  "src/core/orchestrator/flagship.ts": 17,
  "src/core/orchestrator/githubGateway.ts": 25,
  "src/core/orchestrator/holdRules.ts": 6,
  "src/core/orchestrator/holds.ts": 8,
  "src/core/orchestrator/homeCrew.ts": 1,
  "src/core/orchestrator/hostCards.ts": 36,
  "src/core/orchestrator/hostOps.ts": 28,
  "src/core/orchestrator/idleLadder.ts": 21,
  "src/core/orchestrator/idleStallCard.ts": 11,
  "src/core/orchestrator/idleStallCardNames.ts": 1,
  "src/core/orchestrator/idleWakes.ts": 44,
  "src/core/orchestrator/inPlaceWork.ts": 14,
  "src/core/orchestrator/intake.ts": 58,
  "src/core/orchestrator/integrationApprovalCard.ts": 15,
  "src/core/orchestrator/integrationAsks.ts": 4,
  "src/core/orchestrator/intentBrief.ts": 215,
  "src/core/orchestrator/jobWakes.ts": 12,
  "src/core/orchestrator/keptApproval.ts": 28,
  "src/core/orchestrator/keptMerge.ts": 19,
  "src/core/orchestrator/leftoverBranches.ts": 1,
  "src/core/orchestrator/localOrchestrator.ts": 6,
  "src/core/orchestrator/lostStarts.ts": 6,
  "src/core/orchestrator/mainCheckWake.ts": 1,
  "src/core/orchestrator/mergeAuthorization.ts": 48,
  "src/core/orchestrator/mergeCardSteps.ts": 32,
  "src/core/orchestrator/mergedStory.ts": 4,
  "src/core/orchestrator/mergeReviews.ts": 66,
  "src/core/orchestrator/namedModel.ts": 2,
  "src/core/orchestrator/nextMove.ts": 12,
  "src/core/orchestrator/noticeWakes.ts": 101,
  "src/core/orchestrator/openWork.ts": 22,
  "src/core/orchestrator/outageWakes.ts": 16,
  "src/core/orchestrator/ownBatches.ts": 4,
  "src/core/orchestrator/putOffs.ts": 1,
  "src/core/orchestrator/reasoningHolds.ts": 3,
  "src/core/orchestrator/replyLine.ts": 1,
  "src/core/orchestrator/reportIntake.ts": 51,
  "src/core/orchestrator/reportPlausibility.ts": 3,
  "src/core/orchestrator/reportSort.ts": 29,
  "src/core/orchestrator/reportWakes.ts": 42,
  "src/core/orchestrator/requestStrips.ts": 1,
  "src/core/orchestrator/requiredActionCard.ts": 7,
  "src/core/orchestrator/restartWatch.ts": 2,
  "src/core/orchestrator/reviewCarry.ts": 1,
  "src/core/orchestrator/reviewerChoice.ts": 26,
  "src/core/orchestrator/reviewHistory.ts": 8,
  "src/core/orchestrator/reviewPick.ts": 7,
  "src/core/orchestrator/reviews.ts": 27,
  "src/core/orchestrator/ruleNotes.ts": 8,
  "src/core/orchestrator/runWatch.ts": 2,
  "src/core/orchestrator/scheduler.ts": 28,
  "src/core/orchestrator/seat.ts": 17,
  "src/core/orchestrator/settleCardFacts.ts": 16,
  "src/core/orchestrator/settleRefusals.ts": 19,
  "src/core/orchestrator/settleService.ts": 53,
  "src/core/orchestrator/settleWords.ts": 19,
  "src/core/orchestrator/sinceSeen.ts": 8,
  "src/core/orchestrator/startSettle.ts": 16,
  "src/core/orchestrator/startedFromCard.ts": 2,
  "src/core/orchestrator/starts.ts": 31,
  "src/core/orchestrator/startWakes.ts": 16,
  "src/core/orchestrator/taskClose.ts": 7,
  "src/core/orchestrator/taskDrop.ts": 4,
  "src/core/orchestrator/taskEvents.ts": 4,
  "src/core/orchestrator/taskMoves.ts": 85,
  "src/core/orchestrator/taskPlacement.ts": 26,
  "src/core/orchestrator/teamQueueLeft.ts": 1,
  "src/core/orchestrator/threadWords.ts": 2,
  "src/core/orchestrator/turnWakes.ts": 17,
  "src/core/orchestrator/waitingWords.ts": 4,
  "src/core/orchestrator/wakes.ts": 7,
  "src/core/orchestrator/workflowEvidence.ts": 22,
  "src/core/orchestrator/workPosture.ts": 1,
  "src/core/orchestrator/workShape.ts": 8,
  "src/core/overflow.ts": 1,
  "src/core/panels/panelProcess.ts": 6,
  "src/core/panels/panelRuntimes.ts": 4,
  "src/core/panels/panelStops.ts": 9,
  "src/core/personal/compiler.ts": 12,
  "src/core/personal/liveWorkspace.ts": 1,
  "src/core/personal/panelEvents.ts": 2,
  "src/core/personal/panelGraph.ts": 1,
  "src/core/personal/panelInstructions.ts": 3,
  "src/core/personal/panelLibrary.ts": 1,
  "src/core/personal/panelLines.ts": 6,
  "src/core/personal/panelMounts.ts": 16,
  "src/core/personal/personalExtensions.ts": 33,
  "src/core/personal/personalStore.ts": 15,
  "src/core/personal/safeMode.ts": 1,
  "src/core/personal/seed/tsconfigJson.ts": 1,
  "src/core/personal/workspace.ts": 6,
  "src/core/phoneAsks.ts": 2,
  "src/core/phonePush.ts": 4,
  "src/core/pi/accountVault.ts": 2,
  "src/core/pi/appReads.ts": 8,
  "src/core/pi/bashTool.ts": 13,
  "src/core/pi/bashWords.ts": 2,
  "src/core/pi/bedrock.ts": 8,
  "src/core/pi/bedrockProfile.ts": 3,
  "src/core/pi/cardImages.ts": 8,
  "src/core/pi/cardLint.ts": 29,
  "src/core/pi/cardTool.ts": 55,
  "src/core/pi/changePresentation.ts": 5,
  "src/core/pi/correctionTool.ts": 4,
  "src/core/pi/crewSpeed.ts": 4,
  "src/core/pi/customApiAccounts.ts": 1,
  "src/core/pi/customApiAccountsFixture.ts": 7,
  "src/core/pi/customApiCheck.ts": 6,
  "src/core/pi/customApiPolicy.ts": 22,
  "src/core/pi/customApiTransport.ts": 2,
  "src/core/pi/customPictureContext.ts": 1,
  "src/core/pi/decisionModels.ts": 5,
  "src/core/pi/emoteTool.ts": 6,
  "src/core/pi/locateTool.ts": 6,
  "src/core/pi/ollamaProfile.ts": 1,
  "src/core/pi/ollamaStream.ts": 3,
  "src/core/pi/openWorkTool.ts": 4,
  "src/core/pi/personalizeTool.ts": 22,
  "src/core/pi/piAccountBackend.ts": 1,
  "src/core/pi/piAuthInteraction.ts": 2,
  "src/core/pi/piResourceLoader.ts": 1,
  "src/core/pi/piResources.ts": 19,
  "src/core/pi/session.ts": 2,
  "src/core/pi/unansweredCalls.ts": 1,
  "src/core/pi/validationEvidence.ts": 2,
  "src/core/placed/automaticPlacement.ts": 12,
  "src/core/placed/computerChoice.ts": 29,
  "src/core/placed/loadLine.ts": 6,
  "src/core/placed/personalSync.ts": 1,
  "src/core/placed/placedAccounts.ts": 1,
  "src/core/placed/placedBrowsers.ts": 10,
  "src/core/placed/placedCallbacks.ts": 4,
  "src/core/placed/placedCloses.ts": 1,
  "src/core/placed/placedCopies.ts": 18,
  "src/core/placed/placedLedger.ts": 2,
  "src/core/placed/placedSession.ts": 2,
  "src/core/placed/placedSessions.ts": 23,
  "src/core/placed/placedWork.ts": 1,
  "src/core/placed/recordCopy.ts": 2,
  "src/core/placed/resourcePressure.ts": 10,
  "src/core/placed/windowsProcesses.ts": 12,
  "src/core/plugins/consentWords.ts": 8,
  "src/core/plugins/homePlugins.ts": 1,
  "src/core/plugins/mediatedFetch.ts": 1,
  "src/core/plugins/pluginInstaller.ts": 47,
  "src/core/plugins/pluginLint.ts": 10,
  "src/core/plugins/pluginRecords.ts": 8,
  "src/core/plugins/pluginSource.ts": 1,
  "src/core/privacy/appDataWatch.ts": 6,
  "src/core/program/programAsk.ts": 5,
  "src/core/program/programRunner.ts": 30,
  "src/core/program/programScript.ts": 5,
  "src/core/quota/auth.ts": 5,
  "src/core/quota/creditsCards.ts": 1,
  "src/core/quota/creditsSwitch.ts": 3,
  "src/core/quota/grpcWeb.ts": 1,
  "src/core/quota/homeQuota.ts": 3,
  "src/core/quota/http.ts": 2,
  "src/core/quota/providers/claude.ts": 4,
  "src/core/quota/providers/copilot.ts": 3,
  "src/core/quota/providers/grok.ts": 8,
  "src/core/quota/providers/kimi.ts": 6,
  "src/core/quota/pushedQuota.ts": 12,
  "src/core/recordReads/recordProcess.ts": 1,
  "src/core/releaseNotes/briefing.ts": 42,
  "src/core/releaseNotes/catalog.ts": 87,
  "src/core/releaseNotes/select.ts": 2,
  "src/core/releaseNotes/testCatalog.ts": 4,
  "src/core/routing/accountPolicy.ts": 23,
  "src/core/routing/accountRouter.ts": 1,
  "src/core/routing/candidates.ts": 1,
  "src/core/routing/capability.ts": 2,
  "src/core/routing/computerPool.ts": 1,
  "src/core/routing/decisionKindClassifier.ts": 16,
  "src/core/routing/modelNews.ts": 4,
  "src/core/routing/modelSlots.ts": 5,
  "src/core/routing/placedWork.ts": 4,
  "src/core/routing/policy.ts": 14,
  "src/core/routing/router.ts": 10,
  "src/core/routing/routingEngine.ts": 33,
  "src/core/runbooks/parts/map.draw.js": 27,
  "src/core/runbooks/parts/map.input.js": 8,
  "src/core/runbooks/parts/map.js": 40,
  "src/core/runbooks/parts/map.layout.js": 2,
  "src/core/runbooks/runbooks.ts": 8,
  "src/core/runbooks/words.ts": 3,
  "src/core/secrets/approvalCard.ts": 1,
  "src/core/secrets/askToKeep.ts": 1,
  "src/core/secrets/bring.ts": 1,
  "src/core/secrets/commandWords.ts": 37,
  "src/core/secrets/programBroker.ts": 1,
  "src/core/secrets/protected.ts": 7,
  "src/core/secrets/requests.ts": 1,
  "src/core/secrets/settings.ts": 8,
  "src/core/selfSource/resolve.ts": 3,
  "src/core/services.ts": 2,
  "src/core/session/answerFiles.ts": 1,
  "src/core/session/bounds.ts": 6,
  "src/core/session/homePersonalSet.ts": 1,
  "src/core/session/openReads.ts": 1,
  "src/core/session/personalResources.ts": 2,
  "src/core/session/session.ts": 2,
  "src/core/session/tools.ts": 1,
  "src/core/session/workRecovery.ts": 59,
  "src/core/signInReturns.ts": 4,
  "src/core/soundFormat.ts": 29,
  "src/core/sql/sqlEngine.ts": 8,
  "src/core/sql/sqlProcess.ts": 1,
  "src/core/sql/sqlService.ts": 5,
  "src/core/standby/keeper.ts": 9,
  "src/core/standby/lock.ts": 2,
  "src/core/standby/peers.ts": 18,
  "src/core/standby/secrets.ts": 8,
  "src/core/standby/stepDown.ts": 9,
  "src/core/standby/stream.ts": 10,
  "src/core/standby/takeOver.ts": 8,
  "src/core/standby/words.ts": 52,
  "src/core/storage/activityStore.ts": 6,
  "src/core/storage/addColumn.ts": 1,
  "src/core/storage/askStore.ts": 25,
  "src/core/storage/cardMigrations.ts": 16,
  "src/core/storage/cardStore.ts": 62,
  "src/core/storage/changeStore.ts": 20,
  "src/core/storage/correctionMigrations.ts": 2,
  "src/core/storage/costLimitStore.ts": 10,
  "src/core/storage/dataFolderRefusal.ts": 11,
  "src/core/storage/db.ts": 8,
  "src/core/storage/decisionStore.ts": 20,
  "src/core/storage/feedProjection.ts": 12,
  "src/core/storage/inboxMigrations.ts": 8,
  "src/core/storage/inboxStore.ts": 58,
  "src/core/storage/jobStore.ts": 5,
  "src/core/storage/knowledgeStore.ts": 52,
  "src/core/storage/migrateAlwaysRoute.ts": 7,
  "src/core/storage/migrateModelSlots.ts": 5,
  "src/core/storage/migrations.ts": 61,
  "src/core/storage/moveLock.ts": 2,
  "src/core/storage/outsideDataScrub.ts": 1,
  "src/core/storage/ownerOnly.ts": 1,
  "src/core/storage/projectStore.ts": 26,
  "src/core/storage/queryIndexes.ts": 1,
  "src/core/storage/quotaSnapshotStore.ts": 3,
  "src/core/storage/retiredProfile.ts": 2,
  "src/core/storage/retireKeepOpen.ts": 17,
  "src/core/storage/savedDataCompatibility.ts": 2,
  "src/core/storage/scheduleStore.ts": 32,
  "src/core/storage/sessionCompletionStore.ts": 19,
  "src/core/storage/settingsStore.ts": 4,
  "src/core/storage/taskDeliveryFields.ts": 3,
  "src/core/storage/taskDeliveryStore.ts": 15,
  "src/core/storage/taskEventCompaction.ts": 1,
  "src/core/storage/taskEventStore.ts": 47,
  "src/core/storage/taskExecutionStore.ts": 11,
  "src/core/storage/taskInvariants.ts": 2,
  "src/core/storage/taskLinkStore.ts": 11,
  "src/core/storage/taskOwnedShapeStore.ts": 5,
  "src/core/storage/taskPolicyStore.ts": 7,
  "src/core/storage/taskRecordFields.ts": 1,
  "src/core/storage/taskRecordMigrations.ts": 50,
  "src/core/storage/taskRecordProjection.ts": 12,
  "src/core/storage/taskRecords.ts": 64,
  "src/core/storage/taskReferenceFields.ts": 3,
  "src/core/storage/taskReferenceStore.ts": 8,
  "src/core/storage/taskRepetitionStore.ts": 6,
  "src/core/storage/taskSelection.ts": 4,
  "src/core/storage/taskSessionStore.ts": 9,
  "src/core/storage/taskSpecificationStore.ts": 10,
  "src/core/storage/usageDays.ts": 9,
  "src/core/storage/usageStore.ts": 12,
  "src/core/storage/views.ts": 34,
  "src/core/tasks/briefReceipt.ts": 1,
  "src/core/tasks/containerParents.ts": 4,
  "src/core/tasks/crewActions.ts": 20,
  "src/core/tasks/crewTranscript.ts": 1,
  "src/core/tasks/homeTaskFiles.ts": 1,
  "src/core/tasks/keptRunning.ts": 4,
  "src/core/tasks/leftBehind.ts": 7,
  "src/core/tasks/leftoverPrograms.ts": 2,
  "src/core/tasks/liveValidation.ts": 37,
  "src/core/tasks/projectKey.ts": 4,
  "src/core/tasks/projectMove.ts": 13,
  "src/core/tasks/queueWait.ts": 13,
  "src/core/tasks/recordActivity.ts": 69,
  "src/core/tasks/taskArchive.ts": 13,
  "src/core/tasks/taskCapture.ts": 11,
  "src/core/tasks/taskDeliveries.ts": 54,
  "src/core/tasks/taskDetail.ts": 4,
  "src/core/tasks/taskFieldEdits.ts": 56,
  "src/core/tasks/taskGraph.ts": 24,
  "src/core/tasks/taskLeftovers.ts": 4,
  "src/core/tasks/taskOrigin.ts": 6,
  "src/core/tasks/taskPlacement.ts": 4,
  "src/core/tasks/taskQuery.ts": 7,
  "src/core/tasks/taskRelationships.ts": 6,
  "src/core/tasks/taskResult.ts": 5,
  "src/core/tasks/taskService.ts": 15,
  "src/core/tasks/taskStarts.ts": 11,
  "src/core/tasks/taskStops.ts": 8,
  "src/core/tasks/taskTemp.ts": 13,
  "src/core/tasks/taskTimeline.ts": 12,
  "src/core/tasks/taskTurns.ts": 21,
  "src/core/tasks/taskWaits.ts": 10,
  "src/core/tasks/timelineCompaction.ts": 1,
  "src/core/telemetry.ts": 14,
  "src/core/update/activeMark.ts": 1,
  "src/core/update/linuxInstall.ts": 16,
  "src/core/update/macUpdates.ts": 4,
  "src/core/update/tapPublication.ts": 90,
  "src/core/update/updateChannels.ts": 8,
  "src/core/update/updateChecker.ts": 3,
  "src/core/update/updateHold.ts": 1,
  "src/core/userBin.ts": 2,
  "src/core/videoFormat.ts": 67,
  "src/core/windowsGit.ts": 7,
  "src/core/workspace/artifacts.ts": 1,
  "src/core/workspace/git.ts": 3,
  "src/core/workspace/projectChanges.ts": 31,
  "src/core/workspace/projectContributions.ts": 9,
  "src/core/workspace/projectLocator.ts": 9,
  "src/core/workspace/projectPage.ts": 9,
  "src/core/workspace/projectSetups.ts": 15,
  "src/core/workspace/repoRegistry.ts": 28,
  "src/core/workspace/repositoryMove.ts": 1,
  "src/core/workspace/taskBranches.ts": 11,
  "src/core/workspace/workMove.ts": 12,
  "src/core/workspace/workspaceService.ts": 16,
  "src/core/workspace/worktreePool.ts": 1,
  "src/main/app.ts": 1,
  "src/main/frames/frameMounts.ts": 2,
  "src/main/frames/frameProtocol.ts": 5,
  "src/main/frames/mediaResponse.ts": 2,
  "src/main/handOver.ts": 3,
  "src/main/handOverPage.ts": 52,
  "src/main/host/autostartEntry.ts": 1,
  "src/main/host/axiProcess.ts": 1,
  "src/main/host/chrome/chromeEngine.ts": 11,
  "src/main/host/chrome/chromePage.ts": 2,
  "src/main/host/chrome/findChrome.ts": 9,
  "src/main/host/claudeKeychainTool.ts": 1,
  "src/main/host/darwinFreshAuthentication.ts": 4,
  "src/main/host/darwinKeychain.ts": 14,
  "src/main/host/darwinSecretCustody.ts": 5,
  "src/main/host/electronKeychain.ts": 3,
  "src/main/host/keychainProcess.ts": 6,
  "src/main/host/keychainProcessRuntime.ts": 2,
  "src/main/host/linuxSecretCustody.ts": 29,
  "src/main/host/macUpdates.ts": 2,
  "src/main/host/nativeSecrets.ts": 6,
  "src/main/host/pageProtocol.ts": 3,
  "src/main/host/panelProcess.ts": 1,
  "src/main/host/programProcess.ts": 1,
  "src/main/host/setAsideProcess.ts": 1,
  "src/main/host/sqlProcess.ts": 1,
  "src/main/host/windowsFreshAuthentication.ts": 8,
  "src/main/keyboard.ts": 5,
  "src/main/lifecycle.ts": 1,
  "src/main/linkCommand.ts": 9,
  "src/main/linuxStartup.ts": 6,
  "src/main/mediaProbe.ts": 4,
  "src/main/noScreen.ts": 2,
  "src/main/ownDisplay.ts": 2,
  "src/main/runCommand.ts": 22,
  "src/main/runEnvironment.ts": 2,
  "src/main/runSettings.ts": 10,
  "src/main/runStatus.ts": 22,
  "src/main/savedDataRefusal.ts": 3,
  "src/main/security/baseline.ts": 4,
  "src/main/shell.ts": 3,
  "src/main/startAtBoot.ts": 53,
  "src/main/typefaceProbePage.ts": 2,
  "src/main/view/viewBackend.ts": 2,
  "src/main/view/viewTakeOver.ts": 10,
  "src/main/voice/voiceHelper.ts": 1,
  "src/main/windowsGitSetup.ts": 15,
  "src/panels/now/words.ts": 6,
  "src/preload/readableRequest.ts": 121,
  "src/renderer/src/devices/viewWords.ts": 28,
  "src/shared/actions.ts": 205,
  "src/shared/afterMerge.ts": 5,
  "src/shared/ambientActions.ts": 4,
  "src/shared/appearanceActions.ts": 10,
  "src/shared/appParts.ts": 1,
  "src/shared/attachments.ts": 1,
  "src/shared/authFailure.ts": 4,
  "src/shared/automation.ts": 10,
  "src/shared/automationWords.ts": 31,
  "src/shared/batches.ts": 12,
  "src/shared/captainAllowances.ts": 10,
  "src/shared/cardAnswerLines.ts": 5,
  "src/shared/cardHeadings.ts": 8,
  "src/shared/cardLeave.ts": 4,
  "src/shared/cardNotes.ts": 3,
  "src/shared/cardPictures.ts": 3,
  "src/shared/cards.ts": 8,
  "src/shared/cardSize.ts": 6,
  "src/shared/changePresentation.ts": 16,
  "src/shared/checkSnapshot.ts": 11,
  "src/shared/checksSpan.ts": 6,
  "src/shared/claudeAccess.ts": 21,
  "src/shared/claudeClient.ts": 3,
  "src/shared/codeNames.ts": 3,
  "src/shared/commandNotice.ts": 14,
  "src/shared/composer.ts": 16,
  "src/shared/contributions.ts": 13,
  "src/shared/correctionWords.ts": 4,
  "src/shared/costLimit.ts": 9,
  "src/shared/createPanelSlot.ts": 3,
  "src/shared/credentialHealth.ts": 2,
  "src/shared/crewSpeed.ts": 13,
  "src/shared/crewTranscript.ts": 6,
  "src/shared/csp.ts": 8,
  "src/shared/customApi.ts": 11,
  "src/shared/decisions.ts": 9,
  "src/shared/decisionUses.ts": 18,
  "src/shared/deliveryFacts.ts": 4,
  "src/shared/deviceNames.ts": 24,
  "src/shared/devices.ts": 65,
  "src/shared/deviceSetup.ts": 32,
  "src/shared/deviceUpdateNudge.ts": 24,
  "src/shared/diagnostics.ts": 29,
  "src/shared/dictation.ts": 3,
  "src/shared/emotes.ts": 3,
  "src/shared/endedCard.ts": 7,
  "src/shared/events.ts": 2,
  "src/shared/factDot.ts": 2,
  "src/shared/firstRun.ts": 10,
  "src/shared/folderRefresh.ts": 12,
  "src/shared/fonts.ts": 31,
  "src/shared/forge.ts": 1,
  "src/shared/forgeKinds.ts": 5,
  "src/shared/forges.ts": 50,
  "src/shared/handoverActions.ts": 46,
  "src/shared/holds.ts": 36,
  "src/shared/homeMove.ts": 1,
  "src/shared/i18n/languages.ts": 9,
  "src/shared/integrations.ts": 102,
  "src/shared/intents.ts": 22,
  "src/shared/ipc.ts": 1,
  "src/shared/joinByAddress.ts": 10,
  "src/shared/keymap.ts": 73,
  "src/shared/keyPresets.ts": 5,
  "src/shared/knowledge.ts": 7,
  "src/shared/leftoverPrograms.ts": 20,
  "src/shared/levelWords.ts": 6,
  "src/shared/liveValidation.ts": 35,
  "src/shared/liveValidationSummary.ts": 8,
  "src/shared/load.ts": 6,
  "src/shared/localOrchestrator.ts": 2,
  "src/shared/macBookResourceReading.ts": 2,
  "src/shared/mapPart.ts": 1,
  "src/shared/mergeReview.ts": 18,
  "src/shared/modelChoice.ts": 21,
  "src/shared/modelDisplayName.ts": 27,
  "src/shared/modelListing.ts": 1,
  "src/shared/modelReason.ts": 20,
  "src/shared/modelSlots.ts": 3,
  "src/shared/nearbyMacs.ts": 7,
  "src/shared/nowPanel.ts": 2,
  "src/shared/observe.ts": 1,
  "src/shared/outsideData.ts": 4,
  "src/shared/ownWindow.ts": 3,
  "src/shared/panelActions.ts": 3,
  "src/shared/personal/manifest.ts": 8,
  "src/shared/personal/panelFiles.ts": 1,
  "src/shared/phoneCode.ts": 1,
  "src/shared/phoneLink.ts": 23,
  "src/shared/placement.ts": 44,
  "src/shared/plainProblem.ts": 28,
  "src/shared/plugins/bridge.ts": 1,
  "src/shared/plugins/containment.ts": 9,
  "src/shared/plugins/fetch.ts": 2,
  "src/shared/plugins/frameDocument.ts": 4,
  "src/shared/plugins/frameScript.ts": 2,
  "src/shared/plugins/manifest.ts": 8,
  "src/shared/plugins/panelCards.ts": 14,
  "src/shared/presentationDestination.ts": 1,
  "src/shared/presentationValidation.ts": 1,
  "src/shared/privateSites.ts": 16,
  "src/shared/projectFocus.ts": 1,
  "src/shared/projectPage.ts": 2,
  "src/shared/projectSetup.ts": 18,
  "src/shared/providers.ts": 22,
  "src/shared/publishedContract.ts": 39,
  "src/shared/quota.ts": 24,
  "src/shared/quotaSignals.ts": 2,
  "src/shared/reads.ts": 35,
  "src/shared/reasoning.ts": 8,
  "src/shared/recordAttention.ts": 32,
  "src/shared/recordBar.ts": 17,
  "src/shared/recordCloseDone.ts": 5,
  "src/shared/recordDrop.ts": 16,
  "src/shared/remoteLogin.ts": 151,
  "src/shared/repos.ts": 21,
  "src/shared/requiredActions.ts": 4,
  "src/shared/resources.ts": 5,
  "src/shared/rigor.ts": 10,
  "src/shared/risk.ts": 32,
  "src/shared/routingPolicy.ts": 1,
  "src/shared/runbookWords.ts": 6,
  "src/shared/savedOutsideData.ts": 12,
  "src/shared/secretBring.ts": 27,
  "src/shared/secretNames.ts": 1,
  "src/shared/secrets.ts": 211,
  "src/shared/settingsActs.ts": 16,
  "src/shared/sharing.ts": 4,
  "src/shared/showActions.ts": 15,
  "src/shared/signIns.ts": 8,
  "src/shared/sql.ts": 3,
  "src/shared/sshConnection.ts": 36,
  "src/shared/taskBrowser.ts": 55,
  "src/shared/taskFacts.ts": 3,
  "src/shared/taskHold.ts": 16,
  "src/shared/taskMoves.ts": 28,
  "src/shared/taskPin.ts": 6,
  "src/shared/taskPlan.ts": 3,
  "src/shared/taskPolicies.ts": 18,
  "src/shared/taskPresentation.ts": 33,
  "src/shared/taskQueue.ts": 15,
  "src/shared/taskTitle.ts": 1,
  "src/shared/taskWaits.ts": 9,
  "src/shared/threadLines.ts": 2,
  "src/shared/threadWait.ts": 12,
  "src/shared/timelineWords.ts": 13,
  "src/shared/updateWords.ts": 46,
  "src/shared/vocabulary.ts": 58,
  "src/shared/voice.ts": 1,
  "src/shared/welcome.ts": 1,
  "src/shared/workPosture.ts": 15,
  "src/shared/workSetup.ts": 1,
  "src/shared/writeAsk.ts": 2,
};

/**
 * Each file that gained raw words, as one line: one not on the ledger that
 * holds some, a listed one holding more than its entry, and one holding more
 * than it did where the branch started (`atBase`, read only for the files that
 * existed there). A file that lost words, or an entry left above its file's
 * count, is no problem: the check fails only when a file gains words.
 */
export function ledgerProblems(
  counts: Record<string, number>,
  ledger: Readonly<Record<string, number>>,
  atBase: Readonly<Record<string, number>> = {},
): string[] {
  const problems: string[] = [];
  for (const [path, count] of Object.entries(counts)) {
    const listed = ledger[path];
    const before = atBase[path];
    if (count === 0) continue;
    if (listed === undefined)
      problems.push(
        `${path}: ${count} run(s) of words typed in for a person to read; put them in the catalog (docs/i18n.md), or say why one stays with i18n-exempt`,
      );
    else if (count > listed)
      problems.push(
        `${path}: ${count} run(s) of raw words, more than the ledger's ${listed}; put the new words in the catalog (docs/i18n.md)`,
      );
    else if (before !== undefined && count > before)
      problems.push(
        `${path}: ${count} run(s) of raw words, more than the ${before} it held where this branch started; put the new words in the catalog (docs/i18n.md)`,
      );
  }
  return problems;
}

/**
 * The raw words each checked file the working copy changed held at `base`,
 * read under its name there, so a renamed file keeps its count. A file new
 * since then has none here and answers to the ledger alone.
 */
export function countsAtBase(
  base: string,
  checked: (path: string) => boolean,
  count: (path: string, text: string) => number,
): Record<string, number> {
  const git = (args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const atBase: Record<string, number> = {};
  for (const line of git(["diff", "--name-status", "-M", "--diff-filter=MR", base, "--", "src"]).split("\n")) {
    const [status, from, to = from] = line.split("\t");
    if (!status || !from || !to || !checked(to)) continue;
    atBase[to] = count(to, git(["show", `${base}:${from}`]));
  }
  return atBase;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const showing = process.argv.indexOf("--show");
  if (showing !== -1) {
    const path = process.argv[showing + 1] ?? "";
    for (const words of rawWordsIn(path, readFileSync(path, "utf8"))) console.log(`${path}:${words.line}: ${words.text}`);
  } else {
    const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(isCheckedFile);
    const counts: Record<string, number> = {};
    for (const path of new Set(paths)) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      counts[path] = rawWordsIn(path, text).length;
    }
    if (process.argv.includes("--list")) {
      for (const [path, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
        if (count) console.log(`  "${path}": ${count},`);
    } else {
      // Where the branch started: the pull request check's base, or the
      // branch's merge base with main. On main's own one-commit checkout it is
      // HEAD, nothing has changed since, and the ledger alone holds each file.
      const base = process.env.CHANGE_BASE || baseRef();
      const atBase = countsAtBase(base, isCheckedFile, (path, text) => rawWordsIn(path, text).length);
      const problems = ledgerProblems(counts, RAW_WORDS_LEDGER, atBase);
      if (problems.length) {
        console.error(problems.join("\n"));
        process.exitCode = 1;
      }
    }
  }
}
