import { randomBytes, randomUUID } from "node:crypto";
import type { IntegrationApprovalChoice } from "@shared/integrations";
import { fencedAnswer, fencedSpans } from "@shared/outsideData";
import type { WebReadAsk, WriteAsk, WriteAskOutcome } from "@shared/writeAsk";
import type { TaskService } from "../tasks/taskService";
import {
  PageRefusal,
  pageAddress,
  type ReadPage,
  readPublicPage,
  type WebReadInput,
  type WebReadNetwork,
} from "../web/publicPage";
import type { WriteAskSent } from "./githubGateway";

/** The label a page's words are marked with, as data from outside. */
export const WEB_DATA_LABEL = "web-data";

/**
 * The most characters of a page's text one answer carries. A part and its
 * marks stay well under the length a tool answer reaches its model whole
 * (`ANSWER_WHOLE_MAX_CHARACTERS`), since a reader cannot open the file a
 * longer answer is saved to.
 */
export const WEB_PART_CHARACTERS = 24_000;

/** How long a page read stays kept for its later parts, and a public project's answer for the rule. */
const KEPT_MS = 10 * 60_000;
/** Pages kept for their later parts across every reader, oldest dropped first. */
const KEPT_PAGES = 16;
/** The most characters of a page's title each part repeats. */
const TITLE_CHARACTERS = 300;
/** Random bytes in each answer's fence value, as the integrations draw theirs. */
const FENCE_BYTES = 8;

/** Where a task's project can be read, as `GithubGatewayService.projectVisibility` says. */
type Visibility = "public" | "not-public" | "none" | "unknown";

/** What the reader holds of the captain's, for the timeline and its own words. */
// i18n-exempt: served to the crewmate as a tool answer
const NOT_PUBLIC_PROJECT = "its project, which is not public";
// i18n-exempt: served to the crewmate as a tool answer
const UNKNOWN_PROJECT = "its project, whose host could not say it is public";

/**
 * Break every copy of a web-data mark in the words, as `fencedAnswer`
 * would, before they are cut into parts: a part's length is then its
 * length inside the marks.
 */
function unmarked(words: string): string {
  return words
    .split(`[[${WEB_DATA_LABEL}`)
    .join(`[ [${WEB_DATA_LABEL}`)
    .split(`[[/${WEB_DATA_LABEL}`)
    .join(`[ [/${WEB_DATA_LABEL}`);
}

/** The text cut into parts of at most `WEB_PART_CHARACTERS`, each ending at a line where one is near. */
export function pageParts(text: string, size = WEB_PART_CHARACTERS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const line = rest.lastIndexOf("\n", size);
    const end = line > size * 0.8 ? line + 1 : size;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  parts.push(rest);
  return parts;
}

/** Each whole web address the text names outside every fenced span, without its fragment. */
export function namedAddresses(text: string): Set<string> {
  let open = "";
  let from = 0;
  for (const span of fencedSpans(text)) {
    open += `${text.slice(from, span.start)}\n`;
    from = span.end;
  }
  open += text.slice(from);
  const named = new Set<string>();
  for (const found of open.match(/https:\/\/[^\s<>"'`]+/g) ?? []) {
    const trimmed = found.replace(/[.,;:!?)\]}»]+$/, "");
    try {
      named.add(pageAddress(trimmed).href);
    } catch {
      // Not an address a reader could read, so it names none.
    }
  }
  return named;
}

/**
 * An unsafe data reader's web pages (docs/agents-reach.md, "Web pages"):
 * `web_read` reads a public https page signed out and serves its text
 * marked as web-data, in parts that each reach the model whole.
 *
 * The captain's rule: any public page opens at once while the reader holds
 * nothing of the captain's. Once it does - its project is not public, or a
 * read of the captain's own things marked it (`readerHolds`) - an address
 * could carry what it read, so only an address its brief names exactly, or
 * one the captain already opened for it, opens at once. Any other is kept
 * as an ask on the reader's one approval card, and the captain's Only this
 * time opens it once.
 */
export class ReaderWebService {
  private readonly pages = new Map<string, { page: ReadPage; parts: string[]; at: number }>();
  private readonly publicSeen = new Map<string, number>();

  constructor(
    private readonly options: {
      tasks: TaskService;
      projectVisibility: (taskId: string) => Promise<Visibility>;
      /** Put a kept address on the reader's approval card, with the waiting asks the cap dropped. */
      presentAsk?: (taskId: string, ask: WebReadAsk, dropped: WriteAsk[]) => void;
      network: WebReadNetwork;
      now: () => number;
    },
  ) {}

  /** A reader's `web_read`: the page's part, the ask it was kept as, or why it was refused. */
  async read(taskId: string, input: WebReadInput, signal?: AbortSignal): Promise<string> {
    const task = this.options.tasks.get(taskId);
    if (task?.shape?.unsafe_data_reader !== true)
      // i18n-exempt: served to the crewmate as a tool answer
      return "Refused: web_read is only for an unsafe data reader. Nothing was read.";
    let url: URL;
    try {
      url = pageAddress(input.url);
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    }
    const held = await this.holds(taskId);
    if (held !== undefined && !this.opensAtOnce(taskId, url.href))
      return this.keep(taskId, url, held);
    try {
      return (await this.served(taskId, url.href, input.part ?? 1, signal)).text;
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    }
  }

  /**
   * Open a kept address the captain's click took: Only this time reads its
   * first part once; Not now and an unticked row open nothing. A read that
   * failed after its request went out is unknown, never repeated by the app.
   */
  async sendTaken(
    taskId: string,
    taken: { ask: WriteAsk } | { refused: string },
    choice: IntegrationApprovalChoice = "once",
  ): Promise<WriteAskSent> {
    if ("refused" in taken)
      return { ok: false, call: "", place: "", outcome: { kind: "refused", why: taken.refused } };
    const ask = taken.ask;
    const done = (outcome: WriteAskOutcome, answer?: string): WriteAskSent => {
      this.options.tasks.delivery.recordWriteAskOutcome(taskId, ask.id, outcome);
      return {
        ok: outcome.kind === "answered" && outcome.status < 300,
        ask,
        call: ask.kind === "web" ? `GET ${ask.url}` : "",
        place: ask.place,
        outcome,
        ...(answer !== undefined ? { answer } : {}),
      };
    };
    if (ask.kind !== "web")
      // i18n-exempt: served to the crewmate as a write-answered outcome
      return done({ kind: "refused", why: "it is not a web page, so it was not opened" });
    if (choice === "deny")
      // i18n-exempt: served to the crewmate as a write-answered outcome
      return done({ kind: "refused", why: "The captain chose Not now. Nothing was opened." });
    if (choice !== "once")
      return done({
        kind: "refused",
        // i18n-exempt: served to the crewmate as a write-answered outcome
        why: "a web page opens only on Only this time, so it was not opened",
      });
    try {
      const { text, status } = await this.served(taskId, ask.url, 1);
      return done({ kind: "answered", status, requestId: null }, text);
    } catch (caught) {
      const why = caught instanceof Error ? caught.message : String(caught);
      return caught instanceof PageRefusal && caught.beforeSend
        ? done({ kind: "refused", why })
        : done({ kind: "unknown", why });
    }
  }

  /**
   * What the reader holds of the captain's, or undefined while it holds
   * nothing: the record's mark, or its project, which is marked the first
   * time it reads as not public. A host that cannot say counts as holding,
   * unmarked, so the next read asks it again.
   */
  private async holds(taskId: string): Promise<string | undefined> {
    const kept = this.options.tasks.get(taskId)?.delivery?.readerHolds;
    if (kept) return kept.what;
    const seen = this.publicSeen.get(taskId);
    if (seen !== undefined && this.options.now() - seen < KEPT_MS) return undefined;
    const visibility = await this.options.projectVisibility(taskId);
    if (visibility === "public" || visibility === "none") {
      this.publicSeen.set(taskId, this.options.now());
      return undefined;
    }
    if (visibility === "unknown") return UNKNOWN_PROJECT;
    this.options.tasks.delivery.markReaderHolds(taskId, NOT_PUBLIC_PROJECT);
    return NOT_PUBLIC_PROJECT;
  }

  /** The address is one the brief names, or one the captain already opened for this task. */
  private opensAtOnce(taskId: string, href: string): boolean {
    const asks = this.options.tasks.get(taskId)?.delivery?.writeAsks ?? [];
    if (
      asks.some(
        (ask) =>
          ask.kind === "web" &&
          ask.url === href &&
          ask.sentAt !== undefined &&
          ask.outcome !== undefined &&
          ask.outcome.kind !== "refused",
      )
    )
      return true;
    const briefed = this.options.tasks
      .timeline(taskId)
      .filter((event) => event.kind === "briefed")
      .at(-1);
    return briefed ? namedAddresses(this.options.tasks.servedBrief(briefed)).has(href) : false;
  }

  /** Keep the address for the captain's click, or name the ask it already waits as. */
  private keep(taskId: string, url: URL, held: string): string {
    const waiting = (this.options.tasks.get(taskId)?.delivery?.writeAsks ?? []).find(
      (ask) => ask.kind === "web" && ask.url === url.href && ask.sentAt === undefined,
    );
    if (waiting)
      // i18n-exempt: served to the crewmate as a tool answer
      return `Not opened: ${url.href} already waits for the captain as ask ${waiting.id} on the app's approval card. You hear what came of it (write-answered); do not ask again or emit a card for it.`;
    const ask: WebReadAsk = {
      id: `wa${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      kind: "web",
      url: url.href,
      place: url.host,
      at: this.options.now(),
    };
    const dropped = this.options.tasks.delivery.keepWriteAsk(taskId, ask);
    this.options.presentAsk?.(taskId, ask, dropped);
    return [
      // i18n-exempt: served to the crewmate as a tool answer
      `Not opened: this task holds ${held}, so a web address its brief does not name waits for the captain: an address can carry what you read to whoever runs its site. Kept as ask ${ask.id}: GET ${url.href}.`,
      // i18n-exempt: served to the crewmate as a tool answer
      "The app put it on its own approval card for the captain, with its whole address, joined with this task's other waiting asks. Do not emit a card for it.",
      // i18n-exempt: served to the crewmate as a tool answer
      "Only the captain's click opens it, once, and you then hear its first part (write-answered); after that this address opens at once. Never open it another way.",
    ].join("\n");
  }

  /** One part of the page, read now or kept from a read in the last ten minutes, marked as web-data. */
  private async served(
    taskId: string,
    href: string,
    part: number,
    signal?: AbortSignal,
  ): Promise<{ text: string; status: number }> {
    const key = `${taskId}\n${href}`;
    const now = this.options.now();
    let kept = this.pages.get(key);
    if (!kept || now - kept.at >= KEPT_MS) {
      const page = await readPublicPage(href, this.options.network, signal);
      const title =
        page.title.length > TITLE_CHARACTERS
          ? `${page.title.slice(0, TITLE_CHARACTERS)}...`
          : page.title;
      // i18n-exempt: served to the crewmate as a tool answer
      const head = [`Address: ${page.address}`, title ? `Title: ${title}` : ""]
        .filter(Boolean)
        .join("\n");
      kept = { page, parts: pageParts(unmarked(page.text)), at: now };
      kept.parts = kept.parts.map((words) => `${unmarked(head)}\n\n${words}`);
      this.pages.delete(key);
      this.pages.set(key, kept);
      for (const old of this.pages.keys()) {
        if (this.pages.size <= KEPT_PAGES) break;
        this.pages.delete(old);
      }
    }
    const count = kept.parts.length;
    const words = kept.parts[part - 1];
    if (words === undefined)
      throw new PageRefusal(
        // i18n-exempt: served to the crewmate as a tool answer
        `Refused: ${href} has ${count} part${count === 1 ? "" : "s"}; part ${part} is not one of them.`,
        true,
      );
    // i18n-exempt: served to the crewmate as a tool answer
    const next = part < count ? ` Read the next with part ${part + 1}.` : "";
    return {
      // i18n-exempt: served to the crewmate as a tool answer
      text: `web_read ${href}: part ${part} of ${count}, answered ${kept.page.status}.${next}\n${fencedAnswer(
        words,
        {
          label: WEB_DATA_LABEL,
          value: randomBytes(FENCE_BYTES).toString("hex"),
          at: now,
        },
      )}`,
      status: kept.page.status,
    };
  }
}
