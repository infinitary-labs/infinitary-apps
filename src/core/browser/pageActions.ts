import { realpath, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type { HostBrowserPage, HostFileChooser } from "../host";
import { type Browser, type BrowsersCore, quoted } from "./browserRecord";
import { browserCommand } from "./commandWords";
import {
  answer,
  type BrowserActInput,
  type BrowserAnswer,
  DID_NAME_MAX,
  invalid,
  labelOf,
  nameOf,
  refused,
  TOP,
  WAIT_POLL_MS,
} from "./crewmateCommands";
import { BROWSER_KEYS, type BrowserKey } from "./keys";
import type { RefEntry } from "./outline";
import { clip } from "./pageNotices";

/**
 * A crewmate's actions on its task's page (docs/task-browser.md, "What a
 * crewmate does on a page"): click, type, choose, press, scroll, hover,
 * fill, drag and attach a file, each with real input at a control's place,
 * then a wait for the page to answer before the answer reads it again.
 */

/** After an action, a moment for the page to answer it before it is read again. */
const ACT_SETTLE_MS = 250;
/**
 * How long a click on a link, Enter, or a submitted field waits for the
 * address or title to change, including a move that does not load a new
 * document. Polled at `WAIT_POLL_MS`.
 */
const SOFT_NAV_POLLS = 16;
/** How long any other click waits for a move that starts after the first moment. */
const CLICK_NAV_POLLS = 8;
/** Polls after the address or title changes, for the page to finish drawing. */
const POST_NAV_POLLS = 2;

export class PageActions {
  constructor(private readonly core: BrowsersCore) {}

  async act(taskId: string, input: BrowserActInput): Promise<BrowserAnswer> {
    const commands = this.core.commands;
    const browser = this.core.browsers.get(taskId);
    if (!browser) return commands.noBrowser(taskId);
    const actedPage = browser.current;
    const page = actedPage.page;
    const needsRef = ["click", "type", "select", "set", "hover", "drag"].includes(input.action);
    if (needsRef && !input.ref)
      return invalid(`${input.action} needs the ref of what to ${input.action}.`);
    let entry: RefEntry | undefined;
    // The book the ref came from: what the crewmate types is noted there, and goes with it.
    const refs = browser.current.refs;
    if (input.ref) {
      entry = refs.resolve(input.ref);
      if (!entry) return refused(commands.refusedRef(taskId, browser, input.ref));
    }
    let destination: RefEntry | undefined;
    if (input.action === "drag") {
      if (!input.to) return invalid("drag needs to: the destination element's ref.");
      destination = refs.resolve(input.to);
      if (!destination) return refused(commands.refusedRef(taskId, browser, input.to));
    }
    let upload: { chooser: HostFileChooser; paths: string[] } | undefined;
    if (input.action === "upload") {
      const chooser = actedPage.chooser;
      if (!chooser)
        return refused(
          `The page has not asked for a file. Click its file button or field first, then run ${browserCommand("upload <path>")}.`,
        );
      if (!input.files?.length)
        return invalid("upload needs the path of a file in your working copy.");
      if (!chooser.multiple && input.files.length > 1)
        return invalid("The page's file field takes one file.");
      const found = await this.workingCopyFiles(taskId, input.files);
      if ("refusal" in found) return refused(found.refusal);
      upload = { chooser, paths: found.paths };
    }
    const fields: { entry: RefEntry; text: string }[] = [];
    if (input.action === "fill") {
      if (!input.fields?.length || input.fields.length > 50)
        return invalid(
          "fill needs fields: between 1 and 50 fields, each with ref and text. It never submits a form.",
        );
      // Resolve every ref before sending any input, so a stale later field changes nothing.
      for (const field of input.fields) {
        const target = refs.resolve(field.ref);
        if (!target) return refused(commands.refusedRef(taskId, browser, field.ref));
        if (typeof field.text !== "string")
          return invalid("Each field needs text; empty text clears it.");
        fields.push({ entry: target, text: field.text });
      }
    }
    return commands.guarded(taskId, browser, `${input.action} on the page`, async () => {
      const gone = (): BrowserAnswer =>
        refused(
          `${entry ? labelOf(entry) : "That element"} is not on the page now (hidden or removed); run ${browserCommand("snapshot")} to see the page as it is.`,
        );
      let lead: string;
      const before = { url: page.url(), title: page.title() };
      switch (input.action) {
        case "hover": {
          const target = entry as RefEntry;
          const box = await page.box(target.target);
          if (!box) return gone();
          browser.did = `hovered over ${nameOf(target)}`;
          await page.hover({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
          lead = `Hovered over ${labelOf(target)}.`;
          break;
        }
        case "drag": {
          const target = entry as RefEntry;
          const to = destination as RefEntry;
          if (!(await page.drag(target.target, to.target)))
            return refused(
              `Did not drag: both elements must be visible together. Read the page with ${browserCommand("snapshot")}.`,
            );
          browser.did = `dragged ${nameOf(target)} onto ${nameOf(to)}`;
          lead = `Dragged ${labelOf(target)} onto ${labelOf(to)}.`;
          break;
        }
        case "fill": {
          const nodes = await page.nodes();
          for (const field of fields) {
            const node = nodes.find((node) => node.target === field.entry.target);
            if (
              !node ||
              !(
                node.properties.editable ||
                ["textbox", "searchbox", "spinbutton"].includes(node.role)
              )
            )
              return refused(
                `${labelOf(field.entry)} is not an editable text field; no fields were filled.`,
              );
          }
          // Preflight visibility; no input is sent when a field is absent.
          for (const field of fields) {
            if (!(await page.box(field.entry.target)))
              return refused(
                `${labelOf(field.entry)} is not on the page now; no fields were filled.`,
              );
          }
          browser.did = `filled ${fields.length} fields`;
          let filled = 0;
          for (const field of fields) {
            if (
              browser.current !== actedPage ||
              browser.current.refs !== refs ||
              page.url() !== before.url
            )
              return answer(
                browser,
                `Stopped after filling ${filled} fields: the page moved. Read it before filling more.`,
              );
            if (!(await page.box(field.entry.target)))
              return answer(
                browser,
                `Stopped after filling ${filled} fields: ${labelOf(field.entry)} is no longer visible.`,
              );
            await page.focus(field.entry.target, { selectAll: true });
            if (field.text) await page.insertText(field.text);
            else await page.press("Backspace");
            refs.noteTyped(field.entry.target, field.text);
            filled++;
          }
          lead = `Filled ${filled} fields without submitting a form.`;
          break;
        }
        case "upload": {
          const { chooser, paths } = upload as NonNullable<typeof upload>;
          if (actedPage.chooser !== chooser)
            return refused("The page's request for a file is gone; read the page again.");
          await page.setFiles(chooser.target, paths);
          actedPage.chooser = undefined;
          const names = paths.map((path) => quoted(basename(path))).join(", ");
          browser.did = `attached ${clip(names, DID_NAME_MAX)}`;
          lead = `Attached ${names} to the page's file field from your working copy.`;
          break;
        }
        case "click": {
          const target = entry as RefEntry;
          const clicked = await this.clickAt(browser, page, target.target, () => {
            browser.did = `clicked ${nameOf(target)}`;
          });
          if (!clicked) return gone();
          lead = `Clicked ${labelOf(target)}.`;
          break;
        }
        case "set":
        case "type": {
          const target = entry as RefEntry;
          if (input.text === undefined)
            return invalid(`${input.action} needs text: what to enter.`);
          const text = input.text;
          // A list takes the option of that label; anything else is typed into.
          if (input.action === "set" && text) {
            const chosen = await page.choose(target.target, text);
            if (chosen.kind === "no-match") {
              return refused(
                `${labelOf(target)} has no option ${quoted(text)}. Its options: ${chosen.options.map(quoted).join(", ") || "none"}.`,
              );
            }
            if (chosen.kind === "chosen") {
              browser.did = `chose ${quoted(clip(text, DID_NAME_MAX))} in ${nameOf(target)}`;
              lead = `Chose ${quoted(text)} in ${labelOf(target)}.`;
              break;
            }
          }
          const clicked = await this.clickAt(browser, page, target.target, () => {
            // What was typed never reaches the captain's line, only where.
            browser.did = `${text ? "typed into" : "cleared"} ${nameOf(target)}${input.submit ? " and pressed Enter" : ""}`;
            refs.noteTyped(target.target, text);
          });
          if (!clicked) return gone();
          await page.focus(target.target, { selectAll: true });
          if (text) await page.insertText(text);
          else await page.press("Backspace");
          if (input.submit) await page.press("Enter");
          lead = text
            ? `Typed into ${labelOf(target)}${input.submit ? " and pressed Enter" : ""}.`
            : `Cleared ${labelOf(target)}${input.submit ? " and pressed Enter" : ""}.`;
          break;
        }
        case "select": {
          const target = entry as RefEntry;
          if (!input.option)
            return invalid("select needs option: the label of the option to choose.");
          const chosen = await page.choose(target.target, input.option);
          if (chosen.kind === "not-a-list") {
            return refused(
              `${labelOf(target)} is not a list of options; click it, then click the option you want.`,
            );
          }
          if (chosen.kind === "no-match") {
            return refused(
              `${labelOf(target)} has no option ${quoted(input.option)}. Its options: ${chosen.options.map(quoted).join(", ") || "none"}.`,
            );
          }
          browser.did = `chose ${quoted(clip(input.option, DID_NAME_MAX))} in ${nameOf(target)}`;
          lead = `Chose ${quoted(input.option)} in ${labelOf(target)}.`;
          break;
        }
        case "press": {
          const key = BROWSER_KEYS.find(
            (known) => known.toLowerCase() === input.key?.toLowerCase(),
          );
          if (!key) return invalid(`press needs key, one of: ${BROWSER_KEYS.join(", ")}.`);
          browser.did = `pressed ${key}`;
          if (entry) await page.focus(entry.target);
          await page.press(key as BrowserKey);
          lead = entry ? `Pressed ${key} on ${labelOf(entry)}.` : `Pressed ${key}.`;
          break;
        }
        case "scroll": {
          if (entry) {
            if (!(await page.box(entry.target))) return gone();
            browser.did = `scrolled to ${nameOf(entry)}`;
            lead = `Scrolled ${labelOf(entry)} into view.`;
            break;
          }
          if (!["up", "down", "top", "bottom"].includes(input.direction ?? "")) {
            return invalid(
              "scroll needs a ref to bring into view, or direction up, down, top or bottom.",
            );
          }
          browser.did = `scrolled ${input.direction}`;
          await page.scroll(input.direction as "up" | "down" | "top" | "bottom");
          lead = `Scrolled ${input.direction}.`;
          break;
        }
        default:
          return invalid(
            "action is one of click, type, select, set, press, scroll, hover, fill, drag or upload.",
          );
      }
      await this.awaitAction(page, before, input, entry);
      // A scroll answers with what the page's window shows now.
      return answer(browser, lead, input.action === "scroll" ? { kind: "screen" } : TOP, {
        entry: actedPage,
        refs,
      });
    });
  }

  /**
   * The crewmate's files for the page's request, each a regular file inside
   * its task's working copy, by its own path there: a link out of the
   * working copy, or a path outside it, is refused.
   */
  private async workingCopyFiles(
    taskId: string,
    files: readonly string[],
  ): Promise<{ paths: string[] } | { refusal: string }> {
    const root = this.core.options.workingCopy?.(taskId);
    if (!root) return { refusal: "This task has no working copy to attach a file from." };
    const top = await realpath(root).catch(() => undefined);
    if (!top) return { refusal: "This task's working copy is not there to attach a file from." };
    const paths: string[] = [];
    for (const file of files) {
      const outside = `${quoted(file)} is not in your working copy: this browser attaches only files from it.`;
      const real = await realpath(resolve(root, file)).catch(() => undefined);
      if (!real) return { refusal: `${quoted(file)} is not a file in your working copy.` };
      if (!real.startsWith(`${top}${sep}`)) return { refusal: outside };
      if (
        real
          .slice(top.length + 1)
          .split(sep)
          .includes(".git")
      )
        return { refusal: outside };
      const kind = await stat(real).catch(() => undefined);
      if (!kind?.isFile())
        return { refusal: `${quoted(file)} is not a file in your working copy.` };
      paths.push(real);
    }
    return { paths };
  }

  /**
   * Click a control at its place on the page, with no resize between
   * finding it and pressing it. `found` runs once it has a place, before
   * the press; false when it has none.
   */
  private clickAt(
    browser: Browser,
    page: HostBrowserPage,
    target: number,
    found: () => void,
  ): Promise<boolean> {
    return this.core.steadily(browser, async () => {
      const box = await page.box(target);
      if (!box) return false;
      found();
      await page.click({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
      return true;
    });
  }

  /**
   * How many times to look for a same-document move. A link, Enter and a
   * submitted field look the longest; any other click looks too, so a move
   * that starts after the first moment is still the answer's page. Typing,
   * choosing and scrolling look once, and look further only if the address
   * or title has already changed.
   */
  private navPolls(input: BrowserActInput, entry?: RefEntry): number {
    if (
      (input.action === "click" && (entry?.role === "link" || entry?.role === "menuitem")) ||
      (input.action === "press" && input.key?.toLowerCase() === "enter") ||
      (input.action === "type" && input.submit === true)
    ) {
      return SOFT_NAV_POLLS;
    }
    // Any other click can open a page without a full load too, a little sooner.
    if (input.action === "click") return CLICK_NAV_POLLS;
    return 1;
  }

  /**
   * Wait for a same-document move to commit, then for the page to settle,
   * before the answer reads the address and the outline. A move that never
   * comes ends after its bound, so a click that only acts on this page does
   * not wait the whole bound.
   */
  private async awaitAction(
    page: HostBrowserPage,
    before: { url: string; title: string },
    input: BrowserActInput,
    entry: RefEntry | undefined,
  ): Promise<void> {
    const polls = this.navPolls(input, entry);
    const read = (fn: () => string): string => {
      try {
        return fn();
      } catch {
        // The page closed itself during the wait. The click already happened.
        return "";
      }
    };
    const sleep = (ms: number): Promise<void> => this.core.commands.sleep(ms);
    try {
      for (let poll = 0; poll < polls; poll += 1) {
        await sleep(poll === 0 && polls === 1 ? ACT_SETTLE_MS : WAIT_POLL_MS);
        const url = read(() => page.url());
        const title = read(() => page.title());
        // An empty address is a page that closed itself. The click already landed.
        if (url === "") return;
        if (url === before.url && title === before.title) continue;
        await page.settle();
        for (let quiet = 0; quiet < POST_NAV_POLLS; quiet += 1) await sleep(WAIT_POLL_MS);
        await page.settle();
        return;
      }
      await page.settle();
    } catch {
      // A page that closed itself has already been acted on.
    }
  }
}
