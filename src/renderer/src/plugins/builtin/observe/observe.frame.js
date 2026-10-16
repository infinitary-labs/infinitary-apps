// @ts-check
/**
 * Observe's frame script: the first Tier-2 template in the app
 * (docs/ui-plugins.md, phase 1; docs/dev-observe.md for what it shows).
 * Runs inside the sandboxed frame with `window.inf` as its whole world: it
 * subscribes to the three reads the built-in manifest declares and paints
 * what the host pushes. No IPC, no window.infinitary, no fetch - and no
 * innerHTML: every string the sessions carry lands through textContent.
 *
 * Type-checked as JavaScript against the bridge's own types
 * (tsconfig.frames.json); it is served verbatim and hash-pinned per mount.
 *
 * @typedef {import("@shared/observe").ObserveSessionSummary} Session
 * @typedef {import("@shared/observe").ObserveSessionDetail} Detail
 * @typedef {import("@shared/observe").ObserveLive} Live
 * @typedef {import("@shared/observe").ObserveTurn} Turn
 * @typedef {import("@shared/observe").ObserveUsageTotals} Usage
 * @typedef {import("@shared/personal/manifest").PersonalSnapshot} Mounts
 * @typedef {import("@shared/personal/manifest").PersonalExtensionView} Mount
 * @typedef {import("@shared/preferences").ShellPreferences} Preferences
 * @typedef {import("@shared/plugins/bridge").FrameBridgeApi} Bridge
 */
(function observe(/** @type {Bridge} */ bridge) {
  const FIRSTMATE_SESSION_ID = "firstmate";
  /** Distance from the bottom that still counts as pinned. */
  const STICK_THRESHOLD_PX = 24;

  /** @type {Record<Session["status"], string>} */
  const statusTone = {
    streaming: "accent",
    idle: "ok",
    done: "ok",
    failed: "danger",
    cancelled: "neutral",
    interrupted: "warn",
    none: "outline",
  };
  /** @type {Record<Session["status"], string>} */
  const statusLabel = {
    streaming: "streaming",
    idle: "idle",
    done: "done",
    failed: "failed",
    cancelled: "cancelled",
    interrupted: "interrupted",
    none: "no session",
  };
  /**
   * The main session carries the accent; crewmates are outlined.
   * Labels, group headings, and the role line all say the same word, so
   * nothing depends on colour alone.
   * @type {Record<Session["kind"], string>}
   */
  const kindLabel = { orchestrator: "main", crewmate: "crewmate" };
  /** @type {Record<Session["kind"], string>} */
  const kindTone = { orchestrator: "accent", crewmate: "outline" };
  /** @type {Record<Session["kind"], string | null>} */
  const kindRole = {
    orchestrator:
      "The first mate you talk to. Captain turns, cards, spawns, and escalations land here.",
    crewmate: null,
  };
  /** @type {Record<Session["kind"], string | null>} */
  const kindRoleShort = {
    orchestrator: "The session you talk to.",
    crewmate: null,
  };
  /** @type {Record<Session["kind"], string>} */
  const groupLabel = { orchestrator: "Main", crewmate: "Crew" };
  /**
   * The reviewers get a group of their own (delivery rigor phase 4). A
   * review task IS a crewmate session, but it reads a change instead of
   * making one and its row answers a different question - what the verdict
   * was - so listing it beside the builders buried it. Observe is the one
   * surface where the words "review" and "verdict" render at all.
   */
  const REVIEW_GROUP_LABEL = "Review";

  const listEl = must(document.querySelector("[data-observe-session-list]"));
  const detailEl = must(document.querySelector("[data-observe-detail]"));
  const errorEl = must(document.querySelector("[data-observe-error]"));

  /** @type {Session[]} */
  let sessions = [];
  /**
   * Personal panels (talk-to-personalize Step 5): the panels the
   * captain asked for, as the core has them right now. They are NOT
   * sessions - a mount has no transcript and no turns - so they are a
   * group of their own with their facts on the row, and nothing here is
   * selectable. What it is for: seeing that the host-owned switch has them
   * all off, that one refused to compile, or that a server module is
   * running background work, without reading the core's log.
   * @type {Mount[]}
   */
  let mounts = [];
  /** Whether the captain's own panels run at all, and why not. @type {Preferences["panels"] | null} */
  let panels = null;
  let selectedId = FIRSTMATE_SESSION_ID;
  /** @type {Detail | null} */
  let detail = null;
  /** @type {Live} */
  let live = { id: selectedId, text: "", tools: [] };
  /** @type {string | null} */
  let loadError = null;
  /** @type {{ unsubscribe: () => Promise<void> } | null} */
  let detailSub = null;
  /** @type {{ unsubscribe: () => Promise<void> } | null} */
  let liveSub = null;
  /** @type {Map<string, { node: HTMLElement, window: ReturnType<typeof sessionWindow> }>} */
  const groups = new Map();
  const personalEl = el("div", null);
  listEl.append(personalEl);
  const headerEl = el("div", null);
  const scroller = el("div", {
    "data-observe-transcript": "",
    tabindex: "0",
    "aria-label": "Session transcript",
  });
  const body = el("div", { class: "transcript-body" });
  scroller.append(body);
  detailEl.append(headerEl, scroller);
  /** @typedef {{ id: string, turn?: Turn, text?: string, attrs?: Record<string, string> }} TranscriptRow */
  const transcript = windowRows(
    scroller,
    body,
    (/** @type {TranscriptRow} */ row) =>
      row.turn ? turnRow(row.turn) : el("div", row.attrs || null, [row.text]),
    100,
    true,
  );
  let headerSignature = "";
  let listSignature = "";
  let detailSignature = "";
  let liveSignature = "";

  /**
   * @template {Element} T
   * @param {T | null} node
   * @returns {T}
   */
  function must(node) {
    if (!node) throw new Error("Observe template markup is missing a region");
    return node;
  }

  /**
   * @param {string} tag
   * @param {Record<string, string> | null} attrs
   * @param {(Node | string | null | false | undefined)[]} [children]
   * @returns {HTMLElement}
   */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    for (const child of children || []) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  /**
   * @param {string} tone
   * @param {string} text
   * @param {{ mono?: boolean, dot?: boolean }} [options]
   */
  function badge(tone, text, options) {
    const opts = options || {};
    return el("span", { class: `badge ${tone}${opts.mono ? " mono" : ""}` }, [
      opts.dot ? el("span", { class: "dot" }) : null,
      text,
    ]);
  }

  /**
   * A model named in a container's top row: the outline chip in mono, never
   * truncated (the design skill's ModelChip).
   * @param {string} label
   */
  function modelChip(label) {
    const chip = badge("outline", label, { mono: true });
    chip.setAttribute("data-model-chip", "");
    return chip;
  }

  /** @param {number} n */
  function formatTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  /** @param {number} ms */
  function formatClock(ms) {
    const date = new Date(ms);
    /** @param {number} value */
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /**
   * Known recorded sums, not a turn count or a bill.
   * @param {Usage | import("@shared/observe").ObserveUsageModel} usage
   */
  function usageLine(usage) {
    const parts = [];
    const records = usage.records;
    for (const [key, label] of /** @type {const} */ ([
      ["input", "in"],
      ["output", "out"],
      ["cacheRead", "cache read"],
      ["cacheWrite", "cache write"],
    ])) {
      const reported = usage.reported?.[key];
      const value = reported === 0 ? "Not available" : formatTokens(usage[key]);
      const coverage =
        reported === undefined || records === undefined
          ? " (coverage unknown)"
          : reported > 0 && reported < records
            ? ` (${reported}/${records} records)`
            : "";
      parts.push(`${value} ${label}${coverage}`);
    }
    const priced = usage.priced;
    const cost =
      typeof usage.cost === "number" && usage.cost > 0
        ? usage.cost < 0.0001
          ? "<$0.0001"
          : `$${usage.cost.toFixed(4)}`
        : "Not available";
    const coverage =
      priced === undefined || records === undefined
        ? "coverage unknown"
        : `${priced}/${records} records priced`;
    parts.push(`Estimated ${cost} (${coverage})`);
    parts.push(
      records === undefined
        ? "Usage record count unavailable"
        : `${records} usage record${records === 1 ? "" : "s"}`,
    );
    return parts.join(" · ");
  }

  /** @param {Usage} usage */
  function recordedModelsLabel(usage) {
    if (!usage.models) return "model coverage unknown";
    if (usage.models.some((model) => !model.model)) return "model attribution incomplete";
    return `${usage.models.length} recorded model${usage.models.length === 1 ? "" : "s"}`;
  }

  /** @param {Usage} usage */
  function modelUsage(usage) {
    if (!usage.models?.length) return null;
    return el("div", { class: "header-usage", "data-observe-model-usage": "" }, [
      "Recorded usage by model (not conversation turns):",
      ...usage.models.map((model) => {
        const label =
          model.provider && model.model
            ? `${model.provider}/${model.model}`
            : (model.model ?? "Model not recorded");
        const attribution = !model.model
          ? "attribution unknown"
          : model.attribution === "served"
            ? "provider-reported"
            : model.attribution === "requested"
              ? "requested model"
              : "historical label; may combine models";
        return el("div", {}, [`${label} (${attribution}) · ${usageLine(model)}`]);
      }),
    ]);
  }

  /** @param {NonNullable<Turn["usage"]>} usage */
  function usageFromTurn(usage) {
    /** @type {string[]} */
    const parts = [];
    if (usage.input !== undefined) parts.push(`${formatTokens(usage.input)} in`);
    if (usage.output !== undefined) parts.push(`${formatTokens(usage.output)} out`);
    if (usage.cacheRead) parts.push(`${formatTokens(usage.cacheRead)} cache`);
    if (usage.cacheWrite) parts.push(`${formatTokens(usage.cacheWrite)} cache write`);
    if (usage.cost !== undefined) parts.push(`$${usage.cost.toFixed(4)}`);
    return parts.join(" · ");
  }

  /** @param {Session} session */
  function identityLine(session) {
    const parts = [session.taskId];
    if (session.repo) parts.push(session.repo);
    if (session.startedAt) parts.push(formatClock(session.startedAt));
    return parts.join(" · ");
  }

  /** @param {Turn} turn */
  function turnLabel(turn) {
    if (turn.kind === "tool") return turn.toolName || "tool";
    if (turn.kind === "user") return "you";
    if (turn.kind === "op") return "op";
    if (turn.kind === "context") return "context";
    if (turn.kind === "compaction") return "compact";
    if (turn.kind === "usage") return "usage";
    if (turn.kind === "error") return "error";
    return "assistant";
  }

  /** @param {Turn} turn */
  function turnTone(turn) {
    if (turn.kind === "error" || turn.isError) return "tone-danger";
    if (turn.kind === "user") return "tone-fg1";
    if (turn.kind === "context" || turn.kind === "op" || turn.kind === "compaction") {
      return "tone-fg3";
    }
    return "tone-fg2";
  }

  /** @param {Session} session */
  function sessionRow(session) {
    const hot = session.status === "failed" || session.authFailure;
    const selected = session.id === selectedId;
    const row = el(
      "button",
      {
        type: "button",
        class: `session-row${selected ? " selected" : hot ? " hot" : ""}`,
        "data-observe-session": session.id,
      },
      [
        el("div", { class: "row-badges" }, [
          session.kind !== "crewmate"
            ? badge(kindTone[session.kind], kindLabel[session.kind])
            : null,
          badge(statusTone[session.status], statusLabel[session.status], {
            dot: session.status === "streaming",
          }),
          session.kind === "crewmate" && session.backend
            ? badge("outline", session.backend, { mono: true })
            : null,
          // The model is its chip on the top row (the captain's 1C), never
          // a word in the identity line below.
          session.model ? modelChip(`Session model: ${session.model}`) : null,
          session.authFailure ? badge("danger", "auth", { mono: true }) : null,
        ]),
        el("div", { class: "row-title" }, [session.title]),
        kindRoleShort[session.kind]
          ? el("div", { class: "row-role" }, [kindRoleShort[session.kind]])
          : null,
        el("div", { class: "row-identity" }, [identityLine(session)]),
        // On a reviewer's row the verdict IS the answer the row exists to
        // give; "awaiting verdict" is said out loud rather than left blank,
        // because a blank reads as a row that failed to load.
        session.routing?.reviewOf
          ? el("div", { class: "row-identity" }, [
              `${session.routing.review ?? "awaiting verdict"} · reviews ${session.routing.reviewOf}`,
            ])
          : null,
        session.usage
          ? el("div", { class: "row-usage" }, [
              `Recorded usage (${recordedModelsLabel(session.usage)}) · ${usageLine(session.usage)}`,
            ])
          : null,
      ],
    );
    row.addEventListener("click", () => select(session.id));
    return row;
  }

  /** @param {Mount} mount */
  function mountRow(mount) {
    // What a reader needs at a glance, and never a guess: refused names the
    // file that refused, a panel off its rail says whether it has one at
    // all or is simply waiting on the store key its presence rule reads.
    const state = mount.error
      ? { tone: "danger", label: `${mount.error.stage} refused` }
      : mount.present
        ? { tone: "ok", label: "on a rail" }
        : mount.panel || mount.frame
          ? { tone: "outline", label: "waiting on its data" }
          : { tone: "outline", label: "no panel" };
    const facts = [`${mount.placement.x} rail, ${mount.placement.y}`];
    if (mount.panel) facts.push(mount.panel.version.slice(0, 8));
    // An added panel is drawn from this version in the frame realm (Phase A item 4).
    if (mount.frame) facts.push(`frame ${mount.frame.version.slice(0, 8)}`);
    if (mount.server) {
      if (mount.server.actions.length > 0) facts.push(`${mount.server.actions.length} action(s)`);
      for (const task of mount.server.background) facts.push(`${task.id} ${task.everyMs / 1000}s`);
    }
    if (mount.reads.length > 0) facts.push(mount.reads.join(" "));
    return el("div", { class: "mount-row", "data-observe-mount": mount.id }, [
      el("div", { class: "row-badges" }, [
        badge(state.tone, state.label),
        mount.running ? badge("accent", "building", { dot: true }) : null,
        mount.source === "installed" ? badge("neutral", `added · ${mount.by}`) : null,
        mount.server ? badge("neutral", "server", { mono: true }) : null,
      ]),
      el("div", { class: "row-title" }, [mount.title]),
      el("div", { class: "row-identity" }, [`${mount.id} · ${facts.join(" · ")}`]),
      mount.error ? el("div", { class: "row-role tone-danger" }, [mount.error.message]) : null,
    ]);
  }

  function renderMounts() {
    const off = panels !== null && !panels.enabled;
    if (!off && mounts.length === 0) return null;
    const note = off
      ? panels && panels.offReason === "safe-mode"
        ? "Off: the app closed twice just after starting, so this launch came up without them - the captain's own and the added ones. The switch is Settings > General > Your panels."
        : "Off by the switch in Settings > General > Your panels, the captain's own and the added ones. Nothing is compiled, mounted, or loaded."
      : null;
    return el("div", { "data-observe-group": "personal" }, [
      el("div", { class: "group-label" }, ["Panels"]),
      note ? el("div", { class: "mount-note" }, [note]) : null,
      ...(off ? [] : mounts.map(mountRow)),
    ]);
  }

  /** @param {HTMLElement} host */
  function sessionWindow(host) {
    return windowRows(
      listEl,
      host,
      (/** @type {Session & { selected: boolean }} */ row) => sessionRow(row),
      130,
    );
  }

  function renderList() {
    const isReview = (/** @type {Session} */ session) => Boolean(session.routing?.reviewOf);
    const sections = [
      {
        id: "orchestrator",
        title: groupLabel.orchestrator,
        rows: sessions.filter((s) => s.kind === "orchestrator"),
      },
      {
        id: "crewmate",
        title: groupLabel.crewmate,
        rows: sessions.filter((s) => s.kind === "crewmate" && !isReview(s)),
      },
      {
        id: "review",
        title: REVIEW_GROUP_LABEL,
        rows: sessions.filter((s) => s.kind === "crewmate" && isReview(s)),
      },
    ];
    for (const section of sections) {
      let group = groups.get(section.id);
      if (!group) {
        const host = el("div", null);
        const node = el("div", { "data-observe-group": section.id }, [
          el("div", { class: "group-label" }, [section.title]),
          host,
        ]);
        listEl.insertBefore(node, personalEl);
        group = { node, window: sessionWindow(host) };
        groups.set(section.id, group);
      }
      group.node.hidden = section.rows.length === 0;
      group.window.set(section.rows.map((row) => ({ ...row, selected: row.id === selectedId })));
    }
    const personal = renderMounts();
    personalEl.replaceChildren(...(personal ? [personal] : []));
  }

  // Windowed buttons remain keyboard reachable, including those not mounted.
  listEl.addEventListener("keydown", (event) => {
    if (
      !(event instanceof KeyboardEvent) ||
      !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    )
      return;
    const target =
      event.target instanceof Element ? event.target.closest("[data-observe-session]") : null;
    if (!target) return;
    const ordered = [
      ...sessions.filter((s) => s.kind === "orchestrator"),
      ...sessions.filter((s) => s.kind === "crewmate" && !s.routing?.reviewOf),
      ...sessions.filter((s) => s.kind === "crewmate" && s.routing?.reviewOf),
    ];
    const index = ordered.findIndex((s) => s.id === target.getAttribute("data-observe-session"));
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? ordered.length - 1
          : Math.max(0, Math.min(ordered.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    const row = ordered[next];
    if (!row) return;
    event.preventDefault();
    groups
      .get(
        row.kind === "orchestrator"
          ? "orchestrator"
          : row.routing?.reviewOf
            ? "review"
            : "crewmate",
      )
      ?.window.focus(row.id);
  });

  /**
   * How this crewmate's work was routed (intelligence-bucket routing S5).
   * The tier is computed from the work's shape, so the model alone does not
   * say why: the rule that chose the slot, the slot the ladder could
   * actually serve, and how the kind was established are the rest of it.
   * Absent facts are simply not rendered - Observe never invents a tier.
   * @param {NonNullable<Session["routing"]>} routing
   */
  function routingLine(routing) {
    /** @type {string[]} */
    const parts = [];
    if (routing.rule) parts.push(`rule ${routing.rule}`);
    if (routing.tier) parts.push(`tier ${routing.tier}`);
    // Only a serving that differs is worth a word: saying "served high" on
    // a high tier would be noise, and saying nothing on a fallback would
    // hide the one fact the header exists for.
    if (routing.served && routing.served !== routing.tier) {
      parts.push(`served ${routing.served}`);
    }
    if (routing.kind) {
      parts.push(routing.kindSource ? `${routing.kind} (${routing.kindSource})` : routing.kind);
    }
    // The delivery rigor beside the tier (phase 3): how carefully the work
    // ships, a builder's review verdict with its risk, and on a review task
    // the builder it reads - absent facts stay unrendered like the rest.
    if (routing.deliverable) parts.push(`delivers ${routing.deliverable}`);
    if (routing.rigor) parts.push(`rigor ${routing.rigor}`);
    if (routing.review) parts.push(`review ${routing.review}`);
    if (routing.reviewOf) parts.push(`reviews ${routing.reviewOf}`);
    if (parts.length === 0) return null;
    return el(
      "div",
      { class: "header-identity", "data-observe-routing": "" },
      parts.map((part) => el("span", null, [part])),
    );
  }

  /**
   * Card threads on this session (cards-as-threads phase 2). Same identity
   * row as routing: one span per card that has messages.
   *
   * @param {NonNullable<Detail["threads"]>} threads
   */
  function threadsLine(threads) {
    return el(
      "div",
      { class: "header-identity", "data-observe-threads": "" },
      threads.map((thread) => {
        const last = thread.messages[thread.messages.length - 1];
        const who = last?.who ?? "host";
        return el("span", null, [`${thread.title}: ${thread.messages.length} · last ${who}`]);
      }),
    );
  }

  /** @param {Session} session
   *  @param {Detail["threads"] | undefined} threads
   */
  function detailHeader(session, threads) {
    return el("div", { "data-observe-detail-header": "" }, [
      el("div", { class: "header-title" }, [
        el("span", { class: "name" }, [session.title]),
        badge(kindTone[session.kind], kindLabel[session.kind]),
        badge(statusTone[session.status], statusLabel[session.status], {
          dot: session.status === "streaming",
          mono: true,
        }),
        session.kind === "crewmate"
          ? badge("outline", session.backend || "backend unknown", { mono: true })
          : null,
        session.model ? modelChip(`Session model: ${session.model}`) : null,
        session.authFailure ? badge("danger", "auth", { mono: true }) : null,
      ]),
      kindRole[session.kind]
        ? el("div", { "data-observe-role": "" }, [kindRole[session.kind]])
        : null,
      el("div", { class: "header-identity" }, [
        el("span", null, [`task ${session.taskId}`]),
        session.repo ? el("span", null, [session.repo]) : null,
        session.startedAt ? el("span", null, [`start ${formatClock(session.startedAt)}`]) : null,
        session.endedAt ? el("span", null, [`end ${formatClock(session.endedAt)}`]) : null,
      ]),
      session.routing ? routingLine(session.routing) : null,
      threads && threads.length > 0 ? threadsLine(threads) : null,
      session.usage
        ? el("div", { class: "header-usage" }, [`Recorded usage · ${usageLine(session.usage)}`])
        : null,
      session.usage ? modelUsage(session.usage) : null,
      session.usage
        ? el("div", { class: "header-usage" }, [
            "Coverage counts saved records, not dollars or turns. Unrecorded usage is not included.",
          ])
        : null,
    ]);
  }

  /** @param {Turn} turn */
  function turnRow(turn) {
    const tone = turnTone(turn);
    /** @type {Node | null} */
    let body = null;
    if (turn.kind === "usage" && turn.usage) {
      body = el("div", { class: "turn-usage" }, [usageFromTurn(turn.usage)]);
    } else if (turn.text) {
      const variant = turn.kind === "context" ? " context" : turn.kind === "tool" ? " mono" : "";
      body = el("div", { class: `turn-text${variant} ${tone}`, "data-observe-turn-text": "" }, [
        turn.text,
      ]);
    }
    return el("div", { "data-observe-turn": turn.kind }, [
      el("div", { class: "turn-clock" }, [turn.at ? formatClock(turn.at) : "live"]),
      el("div", { class: "turn-main" }, [
        el("div", { class: `turn-label ${tone}` }, [turnLabel(turn)]),
        body,
      ]),
    ]);
  }

  /** @type {TranscriptRow[]} */
  let recordedRows = [];
  function renderDetail() {
    const current = detail && detail.id === selectedId ? detail : null;
    const selected = sessions.find((session) => session.id === selectedId) || current;
    const signature = JSON.stringify([selected, current?.threads]);
    if (signature !== headerSignature) {
      headerSignature = signature;
      headerEl.replaceChildren(
        selected
          ? detailHeader(selected, current?.threads)
          : el("div", { class: "detail-empty" }, ["Select a session."]),
      );
    }
    if (!selected) {
      transcript.set([]);
      return;
    }
    const transcriptNote = current ? current.transcriptNote : selected.transcriptNote;
    const hasLive = live.text.length > 0 || live.tools.length > 0;
    /** @type {TranscriptRow[]} */
    const rows = [];
    if (selected.error || selected.authFailure)
      rows.push({
        id: "error",
        attrs: { class: "error-banner" },
        text: `${selected.authFailure ? "Auth failure. " : ""}${selected.error || "The session ended with an error."}`,
      });
    if (transcriptNote)
      rows.push({
        id: "note",
        attrs: { "data-observe-transcript-note": "" },
        text: transcriptNote,
      });
    rows.push(...recordedRows);
    if (!rows.length && !hasLive)
      rows.push({
        id: "empty",
        attrs: current ? { "data-observe-empty": "" } : { "data-observe-loading": "" },
        text: current ? "No turns recorded yet." : "Loading the transcript.",
      });
    for (const tool of live.tools)
      rows.push({
        id: `live-${tool.callId}`,
        turn: {
          id: tool.callId,
          at: 0,
          kind: "tool",
          text: tool.isError ? "failed" : "running",
          toolName: tool.toolName,
          ...(tool.isError !== undefined ? { isError: tool.isError } : {}),
        },
      });
    if (live.text)
      rows.push({
        id: "live-assistant",
        turn: { id: "live-assistant", at: 0, kind: "assistant", text: live.text },
      });
    transcript.set(rows);
  }

  /**
   * Variable-height window, local to this frame. Only the viewport plus one
   * viewport of overscan is DOM. Offscreen heights are estimates until visited;
   * measured rows are keyed by id. A correction preserves the visible row and
   * its pixel offset, not an ever-drifting numeric scrollTop. Browser anchoring
   * is disabled in CSS so it cannot apply the correction a second time.
   *
   * @template {{ id: string }} T
   * @param {Element} viewport
   * @param {HTMLElement} host
   * @param {(row: T) => HTMLElement} render
   * @param {number} estimate
   * @param {boolean} [follow]
   */
  function windowRows(viewport, host, render, estimate, follow = false) {
    /** @typedef {{ value: T, signature: string, height: number, node?: HTMLElement }} Item */
    /** @type {Item[]} */
    let items = [];
    /** @type {Map<string, Item>} */
    let byId = new Map();
    let offsets = [0];
    let pinned = follow;
    let writtenTop = -1;
    let frame = 0;
    /** @type {Set<Item>} */
    const mounted = new Set();
    /** @type {{ id: string, offset: number } | null} */
    let pendingAnchor = null;
    let pendingTop = 0;
    /** @type {string | null} */
    let focusId = null;
    const top = el("div", { "aria-hidden": "true" });
    const bottom = el("div", { "aria-hidden": "true" });
    host.append(top, bottom);

    function origin() {
      return (
        host.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop +
        (Number.parseFloat(getComputedStyle(host).paddingTop) || 0)
      );
    }
    /** Index of the row containing a local y. @param {number} y */
    function indexAt(y) {
      let lo = 0;
      let hi = items.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((offsets[mid + 1] || 0) <= y) lo = mid + 1;
        else hi = mid;
      }
      return Math.min(lo, Math.max(0, items.length - 1));
    }
    function anchor() {
      const y = viewport.scrollTop - origin();
      if (pinned || y < 0 || y >= (offsets[items.length] || 0)) return null;
      const index = indexAt(y);
      const item = items[index];
      return item ? { id: item.value.id, offset: y - (offsets[index] || 0) } : null;
    }
    function readingAnchor() {
      return pendingAnchor && Math.abs(viewport.scrollTop - pendingTop) < 1
        ? pendingAnchor
        : anchor();
    }
    function layout() {
      offsets = [0];
      let total = 0;
      for (const item of items) {
        total += item.height;
        offsets.push(total);
      }
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(paint);
    }
    function paint() {
      frame = 0;
      if (!host.isConnected || viewport.clientHeight === 0) return;
      // Old measurements remain estimates after resize; mounted rows and
      // every subsequent visit measure at the current width and font size.
      // Explicit scrolling wins over an update queued earlier in this frame.
      const saved = readingAnchor();
      pendingAnchor = null;
      const startY = origin();
      if (!pinned && saved) restore(saved, startY);
      const y = pinned
        ? Math.max(0, (offsets[items.length] || 0) - viewport.clientHeight)
        : viewport.scrollTop - startY;
      const overscan = viewport.clientHeight;
      const first =
        items.length && y < (offsets[items.length] || 0) + overscan
          ? indexAt(Math.max(0, y - overscan))
          : items.length;
      const end =
        y + viewport.clientHeight + overscan < 0
          ? 0
          : Math.min(items.length, indexAt(y + viewport.clientHeight + overscan) + 1);
      const visible = items.slice(Math.min(first, end), end);
      const keep = new Set(visible);
      for (const item of mounted) {
        if (!keep.has(item)) {
          item.node?.remove();
          delete item.node;
          mounted.delete(item);
        }
      }
      let previous = top;
      for (const item of visible) {
        if (!item.node)
          item.node = el("div", { class: "window-row", "data-window-id": item.value.id }, [
            render(item.value),
          ]);
        mounted.add(item);
        if (previous.nextSibling !== item.node) host.insertBefore(item.node, previous.nextSibling);
        previous = item.node;
      }
      top.style.height = `${offsets[Math.min(first, end)] || 0}px`;
      bottom.style.height = `${(offsets[items.length] || 0) - (offsets[end] || 0)}px`;
      let changed = false;
      for (const item of visible) {
        const height = item.node?.getBoundingClientRect().height || estimate;
        if (Math.abs(height - item.height) > 0.25) {
          item.height = height;
          changed = true;
        }
      }
      if (changed) {
        layout();
        top.style.height = `${offsets[Math.min(first, end)] || 0}px`;
        bottom.style.height = `${(offsets[items.length] || 0) - (offsets[end] || 0)}px`;
      }
      if (pinned) setTop(viewport.scrollHeight);
      else if (saved) restore(saved, origin());
      if (focusId) {
        const button = byId.get(focusId)?.node?.querySelector("button");
        if (button) {
          button.focus({ preventScroll: true });
          focusId = null;
        }
      }
      // A measured tall row may have pushed the range away from the viewport.
      // Fill on the next frame, never synchronously render the entire history.
      if (changed) schedule();
    }
    /** @param {number} value */
    function setTop(value) {
      viewport.scrollTop = value;
      writtenTop = viewport.scrollTop;
    }
    /** @param {{ id: string, offset: number }} saved @param {number} start */
    function restore(saved, start) {
      const index = items.findIndex((item) => item.value.id === saved.id);
      if (index >= 0)
        setTop(
          start +
            (offsets[index] || 0) +
            Math.min(saved.offset, (items[index]?.height || estimate) - 1),
        );
    }
    viewport.addEventListener(
      "scroll",
      () => {
        if (Math.abs(viewport.scrollTop - writtenTop) > 1) pinned = follow && atBottom(viewport);
        schedule();
      },
      { passive: true },
    );
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    void document.fonts.ready.then(schedule);
    return {
      /** @param {T[]} rows */
      set(rows) {
        const saved = readingAnchor();
        let changed = rows.length !== items.length;
        const next = rows.map((value, index) => {
          const old = byId.get(value.id);
          if (old?.value === value) {
            if (items[index] !== old) changed = true;
            return old;
          }
          const signature = JSON.stringify(value);
          if (old?.signature === signature) {
            if (items[index] !== old) changed = true;
            return old;
          }
          changed = true;
          if (old?.node?.contains(document.activeElement)) focusId = value.id;
          return { value, signature, height: old?.height || estimate };
        });
        // Capture before ANY group changes DOM: a preceding group's new
        // height must not move the crew row the reader is looking at.
        pendingAnchor = saved;
        pendingTop = viewport.scrollTop;
        schedule();
        if (!changed) return;
        items = next;
        byId = new Map(items.map((item) => [item.value.id, item]));
        layout();
      },
      reset() {
        pinned = follow;
        pendingAnchor = null;
        focusId = null;
        // A set may be queued but not painted: mounted still owns the old
        // nodes, while items already names the new data.
        for (const item of mounted) item.node?.remove();
        items = [];
        byId.clear();
        mounted.clear();
        layout();
        top.style.height = bottom.style.height = "0px";
        setTop(0);
      },
      /** @param {string} id */
      focus(id) {
        const index = items.findIndex((item) => item.value.id === id);
        if (index < 0) return;
        pinned = false;
        pendingAnchor = null;
        focusId = id;
        setTop(origin() + (offsets[index] || 0));
        schedule();
      },
    };
  }

  /** @param {Element} scroller */
  function atBottom(scroller) {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= STICK_THRESHOLD_PX;
  }

  function renderError() {
    if (loadError) {
      errorEl.textContent = loadError;
      errorEl.removeAttribute("hidden");
    } else {
      errorEl.textContent = "";
      errorEl.setAttribute("hidden", "");
    }
  }

  function renderAll() {
    renderError();
    renderList();
    renderDetail();
  }

  /** @param {string} id */
  function select(id) {
    if (id === selectedId && detailSub) return;
    selectedId = id;
    detail = null;
    live = { id, text: "", tools: [] };
    recordedRows = [];
    detailSignature = liveSignature = "";
    transcript.reset();
    resubscribe();
    renderAll();
  }

  function resubscribe() {
    if (detailSub) void detailSub.unsubscribe().catch(() => {});
    if (liveSub) void liveSub.unsubscribe().catch(() => {});
    const id = selectedId;
    detailSub = bridge.subscribe(
      "observe.session",
      { id },
      (/** @type {Detail} */ next) => {
        if (selectedId !== id) return;
        const signature = JSON.stringify(next);
        if (signature === detailSignature) return;
        detailSignature = signature;
        detail = next;
        recordedRows = next.turns.map((turn) => ({ id: `turn:${turn.id}`, turn }));
        renderDetail();
      },
      () => {
        if (selectedId !== id) return;
        detail = null;
        recordedRows = [];
        detailSignature = "";
        renderDetail();
      },
    );
    liveSub = bridge.subscribe("observe.live", { id }, (/** @type {Live} */ next) => {
      if (selectedId !== id) return;
      const signature = JSON.stringify(next);
      if (signature === liveSignature) return;
      liveSignature = signature;
      live = next;
      renderDetail();
    });
  }

  const listSub = bridge.subscribe(
    "observe.sessions",
    {},
    (/** @type {Session[]} */ next) => {
      loadError = null;
      renderError();
      const signature = JSON.stringify(next);
      if (signature === listSignature) return;
      listSignature = signature;
      sessions = next;
      renderList();
      renderDetail();
    },
    (error) => {
      loadError = error.message;
      renderAll();
    },
  );
  bridge.subscribe("personal.mounts", {}, (/** @type {Mounts} */ next) => {
    mounts = next.extensions;
    renderList();
  });
  bridge.subscribe("shell.preferences", {}, (/** @type {Preferences} */ next) => {
    panels = next.panels;
    renderList();
  });
  listSub.ready.catch((/** @type {Error} */ error) => {
    loadError = error.message;
    renderAll();
  });
  resubscribe();
  renderAll();
})(/** @type {any} */ (window).inf);
