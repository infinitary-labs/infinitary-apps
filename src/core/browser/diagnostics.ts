import { cutText } from "@shared/textCut";
import type { HostBrowserNetwork, HostConsoleLevel } from "../host";
import { hideKeys } from "../keyFormats";

/** Bounded, page-local diagnostics; never request bodies, headers or cookies. */
export const DIAGNOSTICS_KEPT = 100;
const TEXT_MAX = 300;

function address(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "(non-web address)";
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return cutText(parsed.href, TEXT_MAX);
  } catch {
    return "(unreadable address)";
  }
}

/**
 * A page's console or network list as rows, for a command that prints them
 * compactly: the same bounded rows `read` words, with the totals beside them.
 */
export type DiagnosticsList =
  | {
      show: "console";
      total: number;
      counts: Record<string, number>;
      /** Absent once the page may show the captain's account: only counts are passed on then. */
      rows?: { level: string; text: string }[];
    }
  | {
      show: "network";
      total: number;
      rows: { method: string; url: string; type: string; result: string }[];
    };

export class PageDiagnostics {
  private console: { level: HostConsoleLevel; text: string }[] = [];
  private counts = new Map<HostConsoleLevel, number>();
  private network = new Map<
    string,
    { method: string; url: string; type: string; result: string }
  >();
  private requests = 0;

  clear(): void {
    this.console = [];
    this.counts.clear();
    this.network.clear();
    this.requests = 0;
  }

  log(level: HostConsoleLevel, text: string, hidden: boolean): void {
    this.counts.set(level, (this.counts.get(level) ?? 0) + 1);
    // On a returned/saved-sign-in browser even the retained buffer holds counts only.
    if (hidden) return;
    if (this.console.length === DIAGNOSTICS_KEPT) this.console.shift();
    this.console.push({ level, text: cutText(text, TEXT_MAX).replace(/[\r\n]+/g, " ") });
  }

  request(event: HostBrowserNetwork): void {
    if (event.kind === "request") {
      this.requests += 1;
      // Redirect hops reuse an id; retain the newest hop without evicting a sibling.
      this.network.delete(event.id);
      if (this.network.size === DIAGNOSTICS_KEPT) {
        const first = this.network.keys().next().value;
        if (first !== undefined) this.network.delete(first);
      }
      this.network.set(event.id, {
        method: event.method.slice(0, 16),
        url: address(event.url),
        type: event.type.slice(0, 32),
        result: "pending",
      });
    } else {
      const kept = this.network.get(event.id);
      if (kept) kept.result = event.kind === "response" ? `status ${event.status}` : "failed";
    }
  }

  private rows(hidden: boolean): { method: string; url: string; type: string; result: string }[] {
    return [...this.network.values()].map((entry) => ({
      ...entry,
      url: hidden ? hideKeys(entry.url) : entry.url,
    }));
  }

  list(show: "console" | "network", hidden: boolean): DiagnosticsList {
    if (show === "console") {
      const total = [...this.counts.values()].reduce((sum, count) => sum + count, 0);
      return {
        show,
        total,
        counts: Object.fromEntries(this.counts),
        ...(hidden ? {} : { rows: this.console.map(({ level, text }) => ({ level, text })) }),
      };
    }
    return {
      show,
      total: this.requests,
      rows: this.rows(hidden),
    };
  }

  read(show: "console" | "network", hidden: boolean): string {
    if (show === "console") {
      const total = [...this.counts.values()].reduce((sum, count) => sum + count, 0);
      const counts = [...this.counts].map(([level, count]) => `${level}: ${count}`).join(", ");
      const head = `Console: ${total} messages${counts ? ` (${counts})` : ""}.`;
      if (hidden)
        return `${head}\nOn a page that may show the captain's account, only counts are passed on.`;
      const omitted = total - this.console.length;
      return [
        head,
        ...this.console.map(({ level, text }) => `- ${level}: ${text}`),
        ...(omitted > 0 ? [`(${omitted} older messages not kept.)`] : []),
      ].join("\n");
    }
    return [
      `Network: ${this.requests} requests; ${this.network.size} kept. Addresses omit credentials, query and fragment; no bodies, headers or cookies.`,
      ...this.rows(hidden).map(
        (entry) => `- ${entry.method} ${entry.url} (${entry.type}; ${entry.result})`,
      ),
      ...(this.requests > this.network.size
        ? [`(${this.requests - this.network.size} older requests not kept.)`]
        : []),
    ].join("\n");
  }
}
