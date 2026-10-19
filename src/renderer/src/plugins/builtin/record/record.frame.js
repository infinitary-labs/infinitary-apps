// @ts-check
/**
 * Compact task record. The host owns identity/state/close, the shared task
 * facts above this body (Now and Progress - the crew summary's own, FI3-565
 * piece 2), the fact strip just above the action bar (the model, the change
 * and its checks, FI3-1159), and the action bar below it: every button, Show the card
 * included, is the bar's (FI3-565 piece 4), and the bar says nothing of its
 * own (FI3-948). This frame shows what is wrong or what the task waits on
 * first, then the record as peer rows that each open on their own. Its
 * actions are `open-card`, a Cards row link (FI3-579 piece 1); and, where
 * the window has knowledge, `open-knowledge`, a Knowledge used row that
 * opens the revision the work used in the Knowledge browser's inspector
 * (docs/knowledge.md, "Knowledge used on a task"). Every other task's key it
 * writes - what it waits on, its parent, the key on an Activity line another
 * task wrote (docs/task-record.md, "Whom an event concerns") - is plain
 * text the bridge links, as in a card's body (FI3-1271). Native
 * disclosures stay mounted across pushes, preserving open state and focus; an Activity line that opens to its whole text is rebuilt with
 * each push and keeps its open state by its event, and a control a push
 * rebuilds keeps the keyboard's focus (FI3-1279). Times read relative,
 * the exact time on rest, the pointer's or the keyboard's focus, in the
 * app's label drawn in this page (`restLabel`). A pull request a line
 * names links to its page, where the host says which words name it. All
 * task-authored strings use textContent, never HTML.
 */
(function record(/** @type {import("@shared/plugins/bridge").FrameBridgeApi} */ bridge) {
  /** @typedef {import("@shared/tasks").TaskDetail} Detail */
  /** @typedef {import("@shared/tasks").TaskBoard} Board */
  /** @typedef {import("@shared/tasks").TaskActivityRow} Row */
  /** @typedef {import("@shared/knowledge").KnowledgeUses} Uses */

  /** How many activity rows the tail shows. */
  const TIMELINE_TAIL = 8;

  const root = /** @type {HTMLElement} */ (must(document.querySelector("[data-record]")));
  const taskId = root.getAttribute("data-task-id") ?? "";
  // Only where the window has knowledge does the record read what the work used.
  const knowledge = root.getAttribute("data-knowledge") === "on";
  const noteEl = /** @type {HTMLElement} */ (must(document.querySelector("[data-record-note]")));
  const contentEl = /** @type {HTMLElement} */ (
    must(document.querySelector("[data-record-content]"))
  );
  const whyEl = must(document.querySelector("[data-record-why]"));
  const verdictEl = /** @type {HTMLElement} */ (
    must(document.querySelector("[data-record-verdict]"))
  );
  const overviewEl = /** @type {HTMLElement} */ (
    must(document.querySelector("[data-record-overview]"))
  );
  const attentionEl = /** @type {HTMLElement} */ (
    must(document.querySelector("[data-record-attention]"))
  );
  const attentionTitleEl = must(document.querySelector("[data-record-attention-title]"));
  const guidanceEl = must(document.querySelector("[data-record-attention-guidance]"));
  const contextEl = /** @type {HTMLElement} */ (
    must(document.querySelector("[data-record-context]"))
  );
  const goalEl = /** @type {HTMLElement} */ (must(document.querySelector("[data-record-goal]")));
  const filedWhyEl = must(document.querySelector("[data-record-filed-why]"));
  const filedVerdictEl = /** @type {HTMLElement} */ (
    must(document.querySelector("[data-record-filed-verdict]"))
  );
  const planSkipEl = /** @type {HTMLElement} */ (
    must(document.querySelector("[data-record-plan-skip]"))
  );
  const planSkipSection = /** @type {HTMLElement} */ (
    must(document.querySelector("[data-record-plan-skip-section]"))
  );
  const wordsEl = /** @type {HTMLElement} */ (must(document.querySelector("[data-record-words]")));
  const asksEl = must(document.querySelector("[data-record-asks]"));
  const cardsEl = must(document.querySelector("[data-record-cards]"));
  const cardsCountEl = must(document.querySelector("[data-record-cards-count]"));
  const activityCountEl = must(document.querySelector("[data-record-activity-count]"));
  const earlierEl = /** @type {HTMLElement} */ (
    must(document.querySelector("[data-record-earlier]"))
  );
  const earlierLabelEl = must(document.querySelector("[data-record-earlier-label]"));
  const historyEl = must(document.querySelector("[data-record-history]"));
  const timelineEl = must(document.querySelector("[data-record-timeline]"));
  const caretEl = must(document.querySelector('[data-record-section="timeline"] .caret'));
  const factsEl = must(document.querySelector("[data-record-facts]"));
  const usesEl = must(document.querySelector("[data-record-knowledge]"));
  const usesCountEl = must(document.querySelector("[data-record-knowledge-count]"));
  const usesMoreEl = /** @type {HTMLElement} */ (
    must(document.querySelector("[data-record-knowledge-more]"))
  );
  let readable = false;

  /** @type {Detail | null} */
  let detail = null;
  /** @type {Map<string, string>} */
  let keyById = new Map();
  /**
   * The keys of parents the board does not list, as their own records say
   * them, so Part of names a key and never an id.
   * @type {Map<string, string>}
   */
  const parentKeys = new Map();
  /** @type {string | null} */
  let parentAsked = null;
  /** What the work declared it used, as `knowledge.uses` last answered; null before it does. @type {Uses | null} */
  let uses = null;
  /**
   * Every relative time on the page, repainted each minute in place (the
   * text only - never a disclosure or its DOM).
   * @type {{ node: Element, at: number, text: (at: number) => string }[]}
   */
  let ages = [];
  /**
   * The events whose Activity line the captain opened, kept across pushes.
   * @type {Set<number>}
   */
  const openLines = new Set();
  let comparisonOpen = false;

  /**
   * @template {Element} T
   * @param {T | null} node
   * @returns {T}
   */
  function must(node) {
    if (!node) throw new Error("Record template markup is missing a region");
    return node;
  }

  /**
   * @param {string} name
   * @param {boolean} shown
   */
  function section(name, shown) {
    const node = /** @type {HTMLElement} */ (
      must(document.querySelector(`[data-record-section="${name}"]`))
    );
    node.hidden = !shown;
  }

  /**
   * @param {string} className
   * @param {string} text
   */
  function span(className, text) {
    const node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    return node;
  }

  /** @param {number} at */
  function ago(at) {
    const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
    const days = Math.floor(minutes / 1440);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }

  /** The activity gutter's short form, as the feed paints its ages. @param {number} at */
  function short(at) {
    const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    return `${Math.floor(minutes / 1440)}d`;
  }

  /**
   * The label the app draws for a fact on rest (the design skill's
   * IconButton label; docs/keyboard.md, "Facts shown on rest"), drawn in this
   * page, which the window's own label cannot reach: the exact time behind a
   * short age. The pointer's rest or the keyboard's focus shows it after
   * `--delay-label`, or at once while one shows or just went; leaving, a
   * press or any key lets it go, and Esc while it shows lets it go and
   * nothing else. It is decoration, hidden from assistive technology: the
   * age's own name carries the same words.
   */
  const restLabel = (() => {
    /** How soon after a label went the next one still shows at once, ms (`LABEL_RECENT_MS`). */
    const RECENT_MS = 400;
    /** @type {HTMLElement | null} */
    let el = null;
    /** @type {Element | null} */
    let on = null;
    /** The age waiting for its first label (`wait`), as the window's label keeps it. @type {Element | null} */
    let pending = null;
    let wait = 0;
    let goneAt = Number.NEGATIVE_INFINITY;
    /**
     * The key press that last took a label away, and the age it showed for:
     * the Esc that lets it go does nothing else.
     * @type {{ event: Event, from: Element } | null}
     */
    let took = null;

    /** @param {string} name */
    function token(name) {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const amount = Number.parseFloat(value);
      if (!Number.isFinite(amount)) return 0;
      return value.endsWith("ms") ? amount : amount * 1000;
    }

    function hide() {
      window.clearTimeout(wait);
      pending = null;
      if (on) goneAt = performance.now();
      on = null;
      if (el) el.hidden = true;
    }

    /** The page's one label, made on its first showing with what takes it away. */
    function label() {
      if (el) return el;
      el = document.createElement("div");
      el.setAttribute("data-record-label", "");
      el.setAttribute("aria-hidden", "true");
      el.hidden = true;
      document.body.appendChild(el);
      document.addEventListener("pointerdown", hide, true);
      document.addEventListener(
        "keydown",
        (event) => {
          took = on && el && !el.hidden ? { event, from: on } : null;
          hide();
        },
        true,
      );
      window.addEventListener("blur", hide);
      return el;
    }

    /**
     * Centred under the anchor, or over it near the page's bottom, inside the page.
     * @param {Element} anchor
     * @param {string} words
     */
    function show(anchor, words) {
      if (!anchor.isConnected) return;
      const node = label();
      node.textContent = words;
      node.hidden = false;
      const box = anchor.getBoundingClientRect();
      const edge = 8;
      const gap = 6;
      const x = Math.max(
        edge,
        Math.min(
          window.innerWidth - edge - node.offsetWidth,
          (box.left + box.right) / 2 - node.offsetWidth / 2,
        ),
      );
      const below = box.bottom + gap;
      const y =
        below + node.offsetHeight <= window.innerHeight - edge
          ? below
          : box.top - gap - node.offsetHeight;
      node.style.left = `${Math.round(x)}px`;
      node.style.top = `${Math.round(Math.max(edge, y))}px`;
      on = anchor;
    }

    /**
     * Leaving an age takes its own label, or its own wait for one, and
     * nothing another age shows or waits for (`labelLeave`).
     * @param {Element} anchor
     */
    function leave(anchor) {
      if (pending === anchor) {
        window.clearTimeout(wait);
        pending = null;
      }
      if (on === anchor) hide();
    }

    /** @param {Element} anchor @param {string} words */
    function enter(anchor, words) {
      window.clearTimeout(wait);
      pending = null;
      if ((on && el && !el.hidden) || performance.now() - goneAt < RECENT_MS) {
        show(anchor, words);
        return;
      }
      pending = anchor;
      wait = window.setTimeout(() => {
        pending = null;
        show(anchor, words);
      }, token("--delay-label"));
    }

    return {
      /**
       * Shows `words()` for `anchor` on the pointer's rest over `anchor`
       * and the keyboard's focus on `holder`: the age itself, or the
       * control the age sits in, which carries it.
       * @param {Element} anchor
       * @param {Element} holder
       * @param {() => string} words
       */
      hold(anchor, holder, words) {
        anchor.addEventListener("pointerenter", (event) => {
          if (/** @type {PointerEvent} */ (event).pointerType === "mouse") enter(anchor, words());
        });
        anchor.addEventListener("pointerleave", () => leave(anchor));
        // The keyboard rests on it as the pointer does; a click's focus shows no label of its own.
        holder.addEventListener("focus", () => {
          if (holder.matches(":focus-visible")) enter(anchor, words());
        });
        holder.addEventListener("blur", () => leave(anchor));
        holder.addEventListener("keydown", (event) => {
          const key = /** @type {KeyboardEvent} */ (event).key;
          if (key !== "Escape" || took?.event !== event || took.from !== anchor) return;
          event.preventDefault();
          event.stopPropagation();
        });
      },
      /** A drawing took the anchor away: its label goes with it. */
      drop() {
        if (on && !on.isConnected) hide();
      },
    };
  })();

  /**
   * A node whose text is a relative time, with its exact time on rest, the
   * pointer's or the keyboard's focus (`restLabel`). The age is a Tab stop
   * named by both, unless it sits in a control (`holder`, an Activity line
   * that opens), which then takes the keyboard's focus and reads the age's
   * name in its own (docs/keyboard.md, "Facts shown on rest").
   * @param {Element} node
   * @param {number} at
   * @param {(at: number) => string} text
   * @param {Element} [holder]
   */
  function aged(node, at, text, holder) {
    const exact = new Date(at).toLocaleString();
    node.textContent = text(at);
    node.setAttribute("data-record-age", "");
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", `${node.textContent} · ${exact}`);
    if (!holder) node.setAttribute("tabindex", "0");
    restLabel.hold(node, holder ?? node, () => exact);
    ages.push({ node, at, text });
    return node;
  }

  /**
   * A repeated full-text tooltip: present only while the node's own text is
   * cut, hidden, or not yet measurable. A resize measures it again.
   * @param {Element} node
   * @param {string} text
   */
  function repeatTitle(node, text) {
    const hidden = () => {
      if (typeof getComputedStyle !== "function" || typeof node.scrollWidth !== "number")
        return true;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return true;
      return node.scrollWidth - node.clientWidth > 1 || node.scrollHeight - node.clientHeight > 1;
    };
    const apply = () => {
      if (hidden()) node.setAttribute("title", text);
      else node.removeAttribute("title");
    };
    apply();
    if (typeof ResizeObserver === "function") new ResizeObserver(apply).observe(node);
  }

  function paintAges() {
    if (!readable) return;
    for (const entry of ages) {
      entry.node.textContent = entry.text(entry.at);
      entry.node.setAttribute(
        "aria-label",
        `${entry.node.textContent} · ${new Date(entry.at).toLocaleString()}`,
      );
    }
  }

  /** The change by the label the forge gave it (`#N`, or a pushed branch's name). */
  function changeLabelOf(/** @type {Detail} */ current) {
    const facts = current.delivery;
    return facts?.changeLabel ?? (facts?.prNumber ? `#${facts.prNumber}` : undefined);
  }

  /** A numbered change is a pull request; anything else the forge named is a branch. */
  function changeNoun(/** @type {Detail} */ current) {
    const facts = current.delivery;
    const label = changeLabelOf(current);
    return facts?.prNumber || label?.startsWith("#") ? "pull request" : "branch";
  }

  /**
   * The change, linked where the host has a page for it.
   * @param {Detail} current
   * @param {string} prefix
   */
  function changeNode(current, prefix) {
    const label = changeLabelOf(current);
    const text = label ? `${prefix} ${label}` : prefix;
    if (!current.delivery?.prUrl) return span("change", text);
    const link = document.createElement("a");
    link.href = current.delivery.prUrl;
    link.textContent = text;
    return link;
  }

  const CLOSE_WORDS = {
    landed: "Merged",
    merged: "Merged",
    released: "Released",
    answered: "Answered",
    settled: "Closed",
    finished: "Finished",
    cancelled: "Dropped",
    discarded: "Discarded",
    failed: "Failed",
    superseded: "Superseded",
  };

  /**
   * How a closed row closed, as one line of nodes: a put-in names its change
   * and its checks once (A10); a drop carries the words recorded with it (A4).
   * @param {Detail} current
   * @returns {(Node | string)[]}
   */
  function closedLine(current) {
    const at = current.closing?.at ?? current.closedAt;
    const when = span("", "");
    if (at !== null) aged(when, at, ago);
    if (current.closedReason === "landed" || current.closedReason === "merged") {
      const line = /** @type {(Node | string)[]} */ (["Merged ", when]);
      if (changeLabelOf(current)) line.push(" as ", changeNode(current, changeNoun(current)));
      line.push(".");
      if (current.delivery?.ci === "green") line.push(" The checks passed.");
      return line;
    }
    const reason = current.closedReason;
    const word = reason
      ? (CLOSE_WORDS[reason] ?? reason)
      : current.status === "done"
        ? "Done"
        : "Dropped";
    const note = current.closing?.note;
    return [`${word} `, when, note ? `: ${note}` : "."];
  }

  /**
   * What needs saying, beside the host's facts and its bar: an attention box
   * when something is wrong or the task waits on something, and how a
   * closed task closed. A waiting decision is the bar's Show the card, and
   * an open task's next step the status reason beside its pill; the bar says
   * nothing of its own (FI3-948).
   * @param {Detail} current
   */
  function paintOverview(current) {
    const closed = current.status === "done" || current.status === "dropped";
    const live = !closed;

    let title = "";
    let guidance = "";
    let urgent = false;
    let danger = false;
    if (current.closedReason === "failed" || (live && current.activity === "interrupted")) {
      title = current.closedReason === "failed" ? "Task failed" : "Work was interrupted";
      guidance = current.problem ?? "Ask your first mate how to continue.";
      urgent = true;
      danger = true;
    } else if (live && current.blockedBy.length > 0) {
      title = `Waiting on ${current.blockedBy.join(", ")}`;
      guidance = "This task is blocked by other work.";
      urgent = true;
    } else if (live && current.waitingCardId) {
      // The status says a decision is waiting, and the bar has Show the card.
    } else if (current.status === "open" && current.flags.blocked) {
      // Blocked with no live blocker: what it waited on was dropped, and its
      // edge still needs Firstmate's decision before it starts
      // (docs/task-graph.md).
      title = "A task it waits on was dropped";
      guidance = "Ask your first mate about its dependencies before starting.";
    } else if (live && current.workPosture?.state === "active") {
      // Checks, jobs and replies still move without the captain. A declared
      // wait or an older report must not turn them into a request for him.
    } else if (live && current.hold) {
      // Queued work a gate holds never reported anything: the host words
      // what the gate waits for and what ends the wait (docs/task-record.md).
      title = current.hold.title;
      guidance = current.hold.text;
    } else if (live && (current.flags.needsYou || current.flags.held || current.captainWait)) {
      title = "Work is paused";
      // Reports are authored facts, not a prose classifier. Keep the last
      // report in view even when a later dismissed note occupies Now.
      guidance = current.outcomeSummary || "No reason has been reported yet.";
    } else if (current.status === "open" && current.children.total > 0) {
      // A parent's parts do the work, so it has no Start (A6).
      const { total, closed: done } = current.children;
      title = `Its ${total} ${total === 1 ? "part does" : "parts do"} the work`;
      guidance = `${done} closed, ${total - done} still open.`;
    }
    attentionEl.hidden = !title;
    attentionEl.toggleAttribute("data-urgent", urgent);
    attentionEl.toggleAttribute("data-danger", danger);
    attentionTitleEl.textContent = title;
    guidanceEl.textContent = guidance;
    /** @type {(Node | string)[]} */
    const context = closed && !title ? closedLine(current) : [];
    contextEl.replaceChildren(...context);
    contextEl.hidden = context.length === 0;
  }

  /**
   * A line's words, the pull request they name linked to its page (the
   * design skill's TaskRecord, "Pull request links"): the host says which
   * words name it (`change`), so the frame reads nothing out of the text.
   * @param {string} text
   * @param {Row["change"]} [change]
   */
  function words(text, change) {
    const node = span("text", "");
    if (!change || change.from < 0 || change.to > text.length || change.from >= change.to) {
      node.textContent = text;
      return node;
    }
    const link = document.createElement("a");
    link.href = change.url;
    link.textContent = text.slice(change.from, change.to);
    link.setAttribute("data-record-change", "");
    node.append(text.slice(0, change.from), link, text.slice(change.to));
    return node;
  }

  /**
   * One activity or ask line: its short age (absolute on hover), then the words.
   * @param {string} className
   * @param {number} at
   * @param {string} text
   * @param {Row["change"]} [change]
   */
  function line(className, at, text, change) {
    const node = document.createElement("div");
    node.className = className;
    node.append(aged(span("mono", ""), at, short), words(text, change));
    return node;
  }

  /**
   * The Cards row: every card the task showed, newest first (the host's
   * order), one line each. A closed card's link brings it forward as the read
   * only past card; an open one's focuses the live card. The frame only asks:
   * the host decides what opening means and the row writes nothing.
   * @param {Detail["cards"]} cards
   */
  function paintCards(cards) {
    cardsCountEl.textContent = String(cards.length);
    cardsEl.replaceChildren(
      ...cards.map((card) => {
        const node = document.createElement("div");
        node.className = "card-line";
        node.setAttribute("data-record-card", card.id);
        node.setAttribute("data-record-card-state", card.state);
        const link = document.createElement("button");
        link.className = "card-link";
        link.setAttribute("type", "button");
        link.textContent = card.title;
        repeatTitle(link, card.title);
        link.addEventListener("click", () => {
          bridge.action("open-card", { id: card.id }).catch(() => {});
        });
        const how = span("how", "");
        if (card.state === "open") how.textContent = card.minimized ? "Minimized" : "On the stage";
        else {
          const text = card.ending ?? "Closed";
          aged(how, card.at, (at) => `${text} · ${short(at)}`);
        }
        node.append(span("mono", card.kind === "note" ? "Note" : "Decision"), link, how);
        return node;
      }),
    );
    section("cards", cards.length > 0);
  }

  /**
   * Knowledge used: each entry and revision the work declared it relied on,
   * newest first, as that revision said it, with the current revision
   * beside it. A row asks the host to open that exact revision in the
   * Knowledge browser's inspector; it writes nothing and records no use.
   * Hidden until a use is declared, and wherever the window has no knowledge.
   */
  function paintUses() {
    const ready = uses && uses.state === "ready" ? uses : null;
    const rows = ready ? ready.uses : [];
    usesCountEl.textContent = String(ready ? ready.total : 0);
    usesEl.replaceChildren(
      ...rows.map((use) => {
        const node = document.createElement("div");
        node.className = "use-line";
        node.setAttribute("data-record-use", `${use.id}@${use.revision}`);
        const link = document.createElement("button");
        link.className = "card-link";
        link.setAttribute("type", "button");
        link.textContent = use.title;
        repeatTitle(link, use.title);
        link.addEventListener("click", () => {
          bridge
            .action("open-knowledge", {
              id: use.id,
              scope: use.scope,
              ...(use.revision === use.current ? {} : { revision: use.revision }),
            })
            .catch(() => {});
        });
        const kind = use.kind === "finding" ? "Finding" : "Concept";
        const revisions =
          use.revision === use.current
            ? `used revision ${use.revision}, the current one`
            : `used revision ${use.revision} · current revision ${use.current}`;
        const how = span("how", `${kind} · ${revisions}${use.retired ? " · retired since" : ""}`);
        how.setAttribute("data-record-use-revisions", "");
        node.append(link, how);
        if (use.purpose) node.append(span("why", use.purpose));
        return node;
      }),
    );
    const more = ready ? ready.total - rows.length : 0;
    usesMoreEl.textContent = more > 0 ? `And ${more} more.` : "";
    usesMoreEl.hidden = more <= 0;
    section("knowledge", rows.length > 0);
  }

  /**
   * Activity's lines. A line opens beneath when it says less than there is:
   * to the events folded under it and what the crewmate did that led to it,
   * in time order with what came after it last (docs/task-record.md, "What
   * Activity holds" and "A crewmate's actions"), and to a whole text that
   * says more than the line, in the line's text column (FI3-901: there is no
   * Full report row).
   * @param {Row[]} rows
   * @param {Map<number, string>} wholeText
   */
  function activityRows(rows, wholeText) {
    return rows.map((row) => {
      if (row.from) return linkedLine(row, row.from);
      const whole = wholeText.get(row.id) ?? "";
      /** @type {{ at: number, text: string, kind: string, after: boolean, change?: Row["change"] }[]} */
      const folded = [
        ...(row.folded ?? []).map((event) => ({ ...event, after: event.id > row.id })),
        ...(row.actions ?? []).map((action) => ({
          ...action,
          kind: "action",
          after: action.at > row.at,
        })),
      ].sort((a, b) => a.at - b.at);
      const says = Boolean(whole.trim()) && whole.trim() !== row.text.trim();
      if (!says && folded.length === 0) {
        const node = line("event", row.at, row.text, row.change);
        node.setAttribute("data-record-event", row.kind);
        return node;
      }
      const node = /** @type {HTMLDetailsElement} */ (document.createElement("details"));
      node.className = "event";
      node.setAttribute("data-record-event", row.kind);
      const summary = document.createElement("summary");
      const end = span("end", "");
      if (folded.length > 0) {
        const count = span("count", `+${folded.length}`);
        count.setAttribute("data-record-folded-count", "");
        count.setAttribute("aria-label", `${folded.length} more`);
        end.append(count);
      }
      end.append(caretEl.cloneNode(true));
      summary.append(
        aged(span("mono", ""), row.at, short, summary),
        words(row.text, row.change),
        end,
      );
      /** @param {typeof folded} lines */
      const foldedLines = (lines) =>
        lines.map((event) => {
          const node = line("event folded", event.at, event.text, event.change);
          node.setAttribute("data-record-folded", event.kind);
          return node;
        });
      node.append(summary, ...foldedLines(folded.filter((event) => !event.after)));
      if (says) {
        const text = document.createElement("p");
        text.className = "whole";
        text.setAttribute("data-record-whole", "");
        text.textContent = whole;
        node.append(text);
      }
      node.append(...foldedLines(folded.filter((event) => event.after)));
      node.open = openLines.has(row.id);
      node.addEventListener("toggle", () => {
        if (node.open) openLines.add(row.id);
        else openLines.delete(row.id);
      });
      return node;
    });
  }

  /**
   * A line another task wrote that concerns this one: its words, then that
   * task's key, which the bridge links to that task like every key here.
   * @param {Row} row
   * @param {{ id: string, key: string }} from
   */
  function linkedLine(row, from) {
    const node = line("event linked", row.at, row.text, row.change);
    node.setAttribute("data-record-event", row.kind);
    node.setAttribute("data-record-from", from.key);
    const source = span("from", `from ${from.key}`);
    source.setAttribute("data-record-from-key", "");
    node.append(source);
    return node;
  }

  /**
   * The key of the task this one is part of: the board's, or for a parent
   * the board does not list, its own record's, read once.
   * @param {string} parentId
   */
  function parentKeyOf(parentId) {
    const key = keyById.get(parentId) ?? parentKeys.get(parentId);
    if (key || parentAsked === parentId) return key;
    parentAsked = parentId;
    const read = bridge.subscribe(
      "tasks.detail",
      { id: parentId },
      (/** @type {Detail} */ parent) => {
        parentKeys.set(parentId, parent.key);
        read.unsubscribe().catch(() => {});
        paint();
      },
      () => {},
    );
    return undefined;
  }

  /**
   * @param {import("@shared/recordFacts").RecordFact} id
   * @param {string} term
   * @param {string} value
   * @param {boolean} [code]
   */
  function fact(id, term, value, code = false) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.setAttribute("data-record-fact", id);
    if (code) dd.className = "code";
    dd.textContent = value;
    return [dt, dd];
  }

  /** @param {Detail} current */
  function paintFacts(current) {
    /** @type {Node[]} */
    const facts = [];
    if (current.assignee) {
      const model = current.modelLabel ? ` on ${current.modelLabel}` : "";
      facts.push(...fact("crewmate", "Crewmate", `${current.assignee}${model}`));
    }
    if (current.repo) {
      facts.push(...fact("project", "Project", current.repo.name));
      if (current.repo.branch) facts.push(...fact("branch", "Branch", current.repo.branch, true));
    }
    const delivery = current.delivery;
    const modeWords = {
      "direct-pr": "As a pull request",
      "local-only": "Merged locally, no pull request",
      "in-place": "Built in place",
    };
    const careWords = { quick: "Quick", standard: "Default", reviewed: "Careful" };
    const lands = [
      ...(delivery ? [modeWords[delivery.mode] ?? delivery.mode] : []),
      ...(delivery?.landedMode ? ["merged"] : []),
      ...(current.rigor ? [`care: ${careWords[current.rigor] ?? current.rigor}`] : []),
    ];
    const policies = current.policies;
    const sourceWords = { task: "This task", parent: "Parent task", project: "Project setting" };
    /** @param {"delivery" | "merging" | "care" | "runs-on"} id
     * @param {string} label
     * @param {string} value
     * @param {"task" | "parent" | "project"} source */
    const policy = (id, label, value, source) => {
      const nodes = fact(id, label, value);
      const origin = document.createElement("span");
      origin.className = "policy-source";
      origin.textContent = sourceWords[source];
      nodes[1]?.appendChild(origin);
      facts.push(...nodes);
    };
    if (policies) {
      policy(
        "delivery",
        "Delivery",
        policies.delivery.value === "direct-pr" ? "Pull request" : "Local merge",
        policies.delivery.source,
      );
      policy(
        "merging",
        "Merging",
        policies.autonomy.value ? "Merges on its own" : "Asks first",
        policies.autonomy.source,
      );
      policy("care", "Care", careWords[policies.rigor.value], policies.rigor.source);
    } else if (lands.length > 0) facts.push(...fact("delivery", "Delivery", lands.join(" · ")));
    // Where it runs (docs/helper.md, "A task's own Runs on"), once another Mac runs work.
    if (current.runsOn) {
      policy("runs-on", "Runs on", current.runsOn.label, current.runsOn.source);
      if (current.runsOn.reason) {
        const nodes = fact("computer-choice", "Computer choice", current.runsOn.reason);
        if (current.runsOn.candidates?.length) {
          const comparison = document.createElement("details");
          comparison.className = "row";
          comparison.dataset.placementComparison = "";
          const summary = document.createElement("summary");
          summary.append("Compared computers at start", caretEl.cloneNode(true));
          const body = document.createElement("div");
          body.className = "row-body";
          for (const text of current.runsOn.candidates) {
            const line = document.createElement("p");
            line.className = "policy-source";
            line.textContent = text;
            body.appendChild(line);
          }
          comparison.open = comparisonOpen;
          comparison.addEventListener("toggle", () => {
            comparisonOpen = comparison.open;
          });
          comparison.append(summary, body);
          nodes[1]?.appendChild(comparison);
        }
        facts.push(...nodes);
      }
    }
    const closed = current.status === "done" || current.status === "dropped";
    const helper = must(document.querySelector("[data-policy-helper]"));
    helper.textContent = [
      ...(policies && policies.rigor.requested !== policies.rigor.value
        ? ["Local merge uses Default care; Careful remains requested for pull requests."]
        : []),
      ...(closed && policies ? ["This task is closed. Its policies are kept as history."] : []),
      ...(!closed && (policies || current.runsOn)
        ? ["Ask your first mate to change these for this task."]
        : []),
    ].join(" ");
    const parentKey = current.parentId ? parentKeyOf(current.parentId) : undefined;
    if (parentKey) facts.push(...fact("parent", "Part of", parentKey, true));
    if (current.blockedBy.length > 0)
      facts.push(...fact("blocked-by", "Waits on", current.blockedBy.join("  "), true));
    if (current.blocks.length > 0)
      facts.push(...fact("blocks", "Holds up", current.blocks.join("  "), true));
    if (current.children.total > 0) {
      facts.push(
        ...fact(
          "children",
          "Parts",
          `${current.children.closed} of ${current.children.total} closed`,
        ),
      );
    }
    factsEl.replaceChildren(...facts);
    section("details", facts.length > 0);
  }

  /**
   * Where the keyboard is in the record (FI3-1279). A push draws Activity's
   * lines, the Cards and Knowledge used rows, the Details and every key the
   * bridge linked in them anew, so the control that held focus leaves the
   * page with the line it was in. Its place is the part of the record it
   * sits in and its turn among that part's controls that read the same,
   * which holds while the record only grows.
   */
  function keyboardPlace() {
    const focused = document.activeElement;
    if (!focused || focused === document.body || !document.hasFocus()) return null;
    const tag = focused.tagName;
    const key = focused.getAttribute("data-inf-task");
    const text = focused.textContent;
    const part = focused.closest("[data-record-section]") ?? root;
    const controls = () =>
      [...part.querySelectorAll(tag)].filter(
        (node) => node.getAttribute("data-inf-task") === key && node.textContent === text,
      );
    return { controls, turn: controls().indexOf(focused) };
  }

  /**
   * Gives the control at `place` focus again when drawing the record anew
   * took it, once the bridge has linked the keys the drawing wrote: it links
   * them as the page changes, before this runs. Only while the frame holds
   * the window's focus: for a few seconds after the captain's last key here
   * the frame may still take focus, and it never takes it from the message
   * box (docs/ui-plugins.md, "Focus and the frames").
   * @param {ReturnType<typeof keyboardPlace>} place
   */
  function keepKeyboard(place) {
    if (!place) return;
    queueMicrotask(() => {
      if (document.activeElement !== document.body || !document.hasFocus()) return;
      const control = /** @type {HTMLElement | undefined} */ (place.controls()[place.turn]);
      control?.focus({ preventScroll: true });
    });
  }

  function paint() {
    if (!detail || !readable) return;
    const current = detail;
    const place = keyboardPlace();
    ages = [];
    noteEl.hidden = true;
    contentEl.hidden = false;

    // A crew filing's reason leads only while it is charted, the moment
    // the captain decides whether it runs; afterwards it is part of the
    // record (A5). A closed row's verdict has nothing left to decide.
    const filing = current.filing;
    const charted = current.status === "open";
    const closed = current.status === "done" || current.status === "dropped";
    const why = filing ? filing.why || "No reason was recorded." : "";
    const verdict = filing?.verdict
      ? `First mate: ${filing.verdict}`
      : "Your first mate has not said yet.";
    section("filing", Boolean(filing) && charted);
    section("filed", Boolean(filing) && !charted);
    whyEl.textContent = why;
    filedWhyEl.textContent = why;
    verdictEl.textContent = verdict;
    filedVerdictEl.textContent = verdict;
    filedVerdictEl.hidden = closed;

    paintOverview(current);
    overviewEl.hidden = !(Boolean(filing) && charted) && attentionEl.hidden && contextEl.hidden;

    goalEl.textContent = current.goal ?? "";
    goalEl.hidden = !current.goal;
    // The captain's words: the intent's verbatim words that started the
    // task, then every ask attached since, each with its age.
    const words = current.intent?.userWords ?? "";
    planSkipEl.textContent = current.skippedPlanBecause ?? "";
    planSkipEl.hidden = !current.skippedPlanBecause;
    planSkipSection.hidden = !current.skippedPlanBecause;
    wordsEl.textContent = words;
    wordsEl.hidden = words.length === 0;
    const asks = current.asks.filter((ask) => ask.text !== words);
    asksEl.replaceChildren(
      ...asks.map((ask) => {
        const node = line("ask", ask.at, ask.text);
        node.setAttribute("data-record-ask", ask.id);
        return node;
      }),
    );
    section(
      "words",
      Boolean(current.goal) ||
        Boolean(filing && !charted) ||
        Boolean(current.skippedPlanBecause) ||
        words.length > 0 ||
        asks.length > 0,
    );

    paintCards(current.cards);
    paintUses();

    const rows = current.activityLog;
    // Each whole text opens from the Activity line it came with: a report
    // from its own line, and an answer or an operation's result that no
    // report carries from the line that closed the task.
    /** @type {Map<number, string>} */
    const wholeText = new Map();
    for (const event of current.events) {
      if (event.kind === "report") wholeText.set(event.id, event.text);
    }
    const outcome = current.outcome ?? "";
    if (outcome && ![...wholeText.values()].includes(outcome)) {
      const closing = [...rows].reverse().find((row) => row.kind === "status" && !row.from);
      if (closing) wholeText.set(closing.id, outcome);
    }
    const tail = rows.slice(-TIMELINE_TAIL);
    const earlier = rows.length - tail.length;
    activityCountEl.textContent = String(rows.length);
    earlierEl.hidden = earlier === 0;
    earlierLabelEl.textContent = `Show earlier · ${earlier}`;
    historyEl.replaceChildren(...activityRows(rows.slice(0, earlier), wholeText));
    timelineEl.replaceChildren(...activityRows(tail, wholeText));
    section("timeline", rows.length > 0);

    paintFacts(current);
    restLabel.drop();
    keepKeyboard(place);
  }

  /** @param {string} text */
  function note(text) {
    readable = false;
    contentEl.hidden = true;
    noteEl.textContent = text;
    noteEl.hidden = false;
  }

  // Refresh only the age text, not disclosures or timeline DOM.
  window.setInterval(paintAges, 60_000);

  bridge.subscribe(
    "tasks.detail",
    { id: taskId },
    (/** @type {Detail} */ next) => {
      detail = next;
      readable = true;
      paint();
    },
    () => note("This record could not be read."),
  );
  bridge.subscribe("tasks.board", {}, (/** @type {Board} */ board) => {
    keyById = new Map(board.tasks.map((task) => [task.id, task.key]));
    paint();
  });
  if (knowledge) {
    bridge.subscribe(
      "knowledge.uses",
      { task: taskId },
      (/** @type {Uses} */ next) => {
        uses = next;
        paint();
      },
      () => {
        uses = null;
        paint();
      },
    );
  }
  // The sections the captain opened outlive this document: the host keeps
  // them per task and hands them back at birth, so a record paged away from
  // and back to reads as it was left.
  const sections = /** @type {HTMLDetailsElement[]} */ ([
    ...document.querySelectorAll("details.row[data-record-section]"),
  ]);
  let restoredSections = false;
  /** @param {unknown} state */
  const restoreSections = (state) => {
    const open = /** @type {{ openSections?: unknown } | null} */ (state)?.openSections;
    if (restoredSections || !Array.isArray(open)) return;
    restoredSections = true;
    for (const node of sections) {
      if (open.includes(node.getAttribute("data-record-section"))) node.open = true;
    }
  };
  restoreSections(bridge.state);
  bridge.onState(restoreSections);
  for (const node of sections) {
    node.addEventListener("toggle", () => {
      restoredSections = true;
      const open = sections
        .filter((one) => one.open)
        .map((one) => one.getAttribute("data-record-section"));
      bridge.action("record-sections", { open }).catch(() => {});
    });
  }
})(/** @type {any} */ (window).inf);
