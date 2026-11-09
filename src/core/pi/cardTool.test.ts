import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RISK_WHY_MAX } from "@shared/risk";
import { UNKNOWN_OUTCOME_WORDS } from "@shared/taskBrowser";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { bindTool, type DeclaredCardInput } from "../session/tools";
import { lintCrewmateCard, lintFirstmateCard } from "./cardLint";
import {
  CLOSE_CARD_TOOL_NAME,
  createCloseCardTool,
  createEmitCardTool,
  EMIT_CARD_TOOL,
  EMIT_CARD_TOOL_DESCRIPTION,
  EMIT_CARD_TOOL_NAME,
  type EmittedCard,
  FIRSTMATE_EMIT_CARD_TOOL_DESCRIPTION,
  parseStableCardId,
  resolveFirstmateCardId,
} from "./cardTool";
import { piToolOf } from "./toolSpec";

/** A whole risk declaration: every dimension rated. */
const RISK = {
  blast: { level: "low", why: "Two files in the meter" },
  behavior: { level: "low", why: "Corrects the unit" },
  undo: { level: "low", why: "A revert restores the old meter" },
  evidence: { level: "medium", why: "The meter test" },
  sensitivity: { level: "low", why: "No sign-in, data or release code" },
  novelty: { level: "low", why: "Edits the existing reading" },
  deps: { level: "low", why: "Nothing added" },
} as const;

type AnyTool = {
  name: string;
  description: string;
  parameters: { properties: Record<string, unknown> };
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[] }>;
};

describe("parseStableCardId", () => {
  it("accepts kebab-case ids and treats empty as absent", () => {
    expect(parseStableCardId(undefined)).toBeUndefined();
    expect(parseStableCardId("")).toBeUndefined();
    expect(parseStableCardId("  fm-feed-scroll  ")).toBe("fm-feed-scroll");
    expect(parseStableCardId("card-fm-flagship-move")).toBe("card-fm-flagship-move");
  });
});

describe("resolveFirstmateCardId", () => {
  it("keeps routing-safe card-fm- ids and prefixes the rest", () => {
    expect(resolveFirstmateCardId("card-fm-auth")).toBe("card-fm-auth");
    expect(resolveFirstmateCardId("fm-feed-scroll")).toBe("card-fm-feed-scroll");
    expect(resolveFirstmateCardId("feed-scroll")).toBe("card-fm-feed-scroll");
  });
});

describe("EMIT_CARD_TOOL_DESCRIPTION", () => {
  it("says every action closes the card and offers no keeps_open (contract 4.65)", () => {
    for (const description of [EMIT_CARD_TOOL_DESCRIPTION, FIRSTMATE_EMIT_CARD_TOOL_DESCRIPTION]) {
      expect(description).toContain(
        "every action closes the card, and changes come by reply, never a revise button",
      );
      expect(description).not.toMatch(/keeps_open|explain.more/i);
    }
    const actions = EMIT_CARD_TOOL.parameters.properties.actions as unknown as {
      items: { properties: Record<string, unknown> };
    };
    expect(Object.keys(actions.items.properties)).toEqual([
      "id",
      "label",
      "default",
      "effect",
      "danger",
      // INF-3108: the author's own way to say no, which keeps the app's Decline off.
      "declines",
    ]);
  });
});

describe("createEmitCardTool", () => {
  it("carries the explicit continuity declaration on either role, and leaves ordinary cards alone", async () => {
    for (const role of ["crewmate", "firstmate"] as const) {
      const onCard = vi.fn((_card: EmittedCard) => "card-example");
      const tool = piToolOf(createEmitCardTool(onCard, undefined, { role })) as unknown as AnyTool;
      await tool.execute("marked", {
        title: "A round",
        body: "<p>Choose your answer.</p>",
        holds_place: true,
      });
      expect(onCard.mock.calls[0]?.[0].holdsPlace).toBe(true);
      await tool.execute("ordinary", {
        title: "A round",
        body: "<p>Choose your answer.</p>",
        holds_place: false,
      });
      expect(onCard.mock.calls[1]?.[0]).not.toHaveProperty("holdsPlace");
    }
  });

  it("refuses tiny rendered labels before showing the card and accepts a corrected figure", async () => {
    const onCard = vi.fn(() => "card-t1-1");
    const tool = piToolOf(createEmitCardTool(onCard, lintCrewmateCard)) as unknown as AnyTool;
    const body = (width: number) =>
      `<p>A diagram.</p><figure><svg viewBox="0 0 ${width} 200" width="100%"><text style="font-size:11px">Label</text></svg></figure>`;
    await expect(tool.execute("t1", { title: "Diagram", body: body(1000) })).rejects.toThrow(
      /Card refused: figure text would draw at 8\.3 px.*under 11 px/,
    );
    expect(onCard).not.toHaveBeenCalled();
    await tool.execute("t2", { title: "Diagram", body: body(750) });
    expect(onCard).toHaveBeenCalledOnce();
  });
  it("asks the Firstmate for every label, and refuses an action no host words (FI3-249)", async () => {
    // Only a crewmate's completion buttons are the host's to word; the
    // Firstmate's schema still asks each action for its own.
    const firstmate = createEmitCardTool(
      vi.fn(() => "card-fm-1"),
      undefined,
      {
        role: "firstmate",
      },
    );
    const actions = firstmate.parameters.properties.actions as unknown as {
      items: { required: string[] };
    };
    expect(actions.items.required).toEqual(["id", "label"]);
    // This tool has no host behind it to word a button, so an action
    // without words never reaches the lint or the card.
    const onCard = vi.fn(() => "card-t1-1");
    const lint = vi.fn(() => undefined);
    const tool = piToolOf(createEmitCardTool(onCard, lint)) as unknown as AnyTool;
    await expect(
      tool.execute("t1", {
        title: "Pick a meter",
        body: "<p>Two meters read the line.</p>",
        actions: [{ id: "left", default: true }],
      }),
    ).rejects.toThrow(/Card refused: action "left" has no label/);
    expect(lint).not.toHaveBeenCalled();
    expect(onCard).not.toHaveBeenCalled();
  });

  it("returns the card id from onCard so close_card can name it", async () => {
    const onCard = vi.fn(() => "card-fm-1-abc");
    const tool = piToolOf(createEmitCardTool(onCard)) as unknown as AnyTool;
    expect(tool.name).toBe(EMIT_CARD_TOOL_NAME);
    const result = await tool.execute("t1", {
      title: "Stale preview",
      body: "old",
    });
    expect(result.content[0]?.text).toBe("Card shown: Stale preview (card-fm-1-abc)");
  });

  it("forwards an optional id and mentions reuse in the description", async () => {
    const onCard = vi.fn(() => "card-fm-feed-scroll");
    const tool = piToolOf(createEmitCardTool(onCard)) as unknown as AnyTool;
    expect(tool.description).toContain(
      "Reuse an open card's id to revise it in place when new information augments or overlaps it",
    );
    await tool.execute("t1", {
      title: "Feed scroll",
      body: "Updated preview.",
      id: "fm-feed-scroll",
    });
    expect(onCard).toHaveBeenCalledWith({
      title: "Feed scroll",
      body: "Updated preview.",
      actions: [],
      id: "fm-feed-scroll",
    });
  });

  it("carries task_id and related only in the Firstmate's schema (v2.0), and risk only in a crewmate's", async () => {
    const crewTool = piToolOf(createEmitCardTool(vi.fn(() => "card-t1-1"))) as unknown as AnyTool;
    const fmTool = piToolOf(
      createEmitCardTool(
        vi.fn(() => "card-fm-1"),
        undefined,
        {
          role: "firstmate",
        },
      ),
    ) as unknown as AnyTool;
    // The runtime consumes the owned schema; only a task with a browser gets
    // its three browser fields. INF-125 adds a typed validation request here.
    expect(Object.keys(crewTool.parameters.properties)).toEqual(
      Object.keys(EMIT_CARD_TOOL.parameters.properties).filter(
        (key) => !["browser_button", "browser_page", "browser_handoff"].includes(key),
      ),
    );
    expect(crewTool.parameters.properties).toHaveProperty("risk");
    expect(crewTool.parameters.properties).not.toHaveProperty("task_id");
    expect(crewTool.parameters.properties).not.toHaveProperty("related");
    expect(crewTool.parameters.properties).toHaveProperty(
      "validation_request",
      EMIT_CARD_TOOL.parameters.properties.validation_request,
    );
    expect(Object.keys(fmTool.parameters.properties)).toEqual([
      "required_actions",
      "title",
      "body",
      "id",
      "width",
      "holds_place",
      "reply",
      "answering",
      "expected_revision",
      "contribution_reason",
      "operation_id",
      "answers_message",
      "actions",
      "task_id",
      "review_task_id",
      "related",
    ]);
    expect(crewTool.description).toBe(EMIT_CARD_TOOL_DESCRIPTION);
    expect(fmTool.description).toBe(FIRSTMATE_EMIT_CARD_TOOL_DESCRIPTION);
    // A crewmate runtime that passed them anyway attaches nothing: its cards
    // are about its own task by construction.
    const onCard = vi.fn(() => "card-t1-2");
    const tool = piToolOf(createEmitCardTool(onCard)) as unknown as AnyTool;
    await tool.execute("t1", { title: "Note", body: "x", task_id: "t9", related: ["t8"] });
    expect(onCard).toHaveBeenCalledWith({ title: "Note", body: "x", actions: [] });

    // INF-125: the approval names the recorded request and its exact action;
    // forwarding this declaration grants nothing at the tool boundary.
    const request = { request: "shared-record", action: "approve-record" };
    const actions = [
      { id: "hold", label: "Keep it held", default: true },
      { id: request.action, label: "Approve this record" },
    ];
    await tool.execute("t2", {
      title: "Approve one test record",
      body: "<p>This test adds one shared record.</p>",
      actions,
      validation_request: request,
    });
    expect(onCard).toHaveBeenLastCalledWith({
      title: "Approve one test record",
      body: "<p>This test adds one shared record.</p>",
      actions,
      validationDecision: request,
    });
  });

  // INF-1610: an author marks the card that answers the captain's message,
  // the outcome of their work included, on either role.
  it("carries the answering mark on either role and on a saved-story completion", async () => {
    for (const role of ["crewmate", "firstmate"] as const) {
      const onCard = vi.fn((_card: EmittedCard) => "card-example");
      const tool = piToolOf(createEmitCardTool(onCard, undefined, { role })) as unknown as AnyTool;
      await tool.execute("marked", {
        title: "It picks the port",
        body: "<p>It picks the port.</p>",
        answering: true,
      });
      expect(onCard.mock.calls[0]?.[0].answering).toBe(true);
      await tool.execute("ordinary", {
        title: "It picks the port",
        body: "<p>It picks the port.</p>",
        answering: false,
      });
      expect(onCard.mock.calls[1]?.[0]).not.toHaveProperty("answering");
    }
    const onCard = vi.fn(() => "card-task-story");
    const tool = piToolOf(bindTool(EMIT_CARD_TOOL, { onCard })) as unknown as AnyTool;
    await tool.execute("story", {
      title: "fix(cards): keep a replied card in place",
      presentation: 2,
      answering: true,
      actions: [{ id: "merge", default: true, effect: { kind: "merge", after: "close" } }],
    });
    expect(onCard).toHaveBeenCalledWith(
      expect.objectContaining({ presentationRevision: 2, answering: true }),
    );
  });

  // INF-92: a saved story is resolved at the home, never reconstructed by a second tool call.
  // INF-3060: three saved-story merge cards in a day repeated the story's
  // risk or required actions and were refused; the tool hands such a copy to
  // the home, which leaves out an exact repeat and refuses a differing one
  // (crewmateCards.completion.test.ts).
  it("hands a saved-story merge card and a copy of its risk or required actions to the home, refusing a body (INF-2744, INF-3060)", async () => {
    const onCard = vi.fn(() => "card-task-story");
    const tool = piToolOf(bindTool(EMIT_CARD_TOOL, { onCard })) as unknown as AnyTool;
    const params = {
      title: "The story is ready",
      presentation: 2,
      actions: [{ id: "merge", default: true, effect: { kind: "merge", after: "close" } }],
    };
    await tool.execute("t1", params);
    expect(onCard).toHaveBeenCalledWith({
      title: params.title,
      body: "",
      presentationRevision: 2,
      actions: params.actions,
    });
    const repeated = await tool.execute("t2", { ...params, required_actions: [] });
    expect(repeated.content[0]?.text).toBe(
      "Card shown from presentation 2 (card-task-story). The required_actions you passed repeats the saved revision exactly, so the copy was left out.",
    );
    expect(onCard).toHaveBeenLastCalledWith({
      title: params.title,
      body: "",
      presentationRevision: 2,
      actions: params.actions,
      requiredActions: [],
    });
    // A body is refused as before, and so is a risk that does not read.
    for (const competing of [
      { body: "<p>The story.</p>" },
      { body_file: "story.html" },
      { risk: {} },
      { browser_button: "Try it" },
    ])
      await expect(tool.execute("t3", { ...params, ...competing })).rejects.toThrow(/without body/);
    for (const actions of [
      [{ id: "reply", label: "Reply", default: true }],
      [{ id: "discard", effect: { kind: "settle", mode: "discard" } }],
      [...params.actions, { id: "reply", label: "Reply" }],
      [...params.actions, { ...params.actions[0], id: "merge-again" }],
    ]) {
      await expect(tool.execute("t4", { ...params, actions })).rejects.toThrow(/one merge action/);
    }
    expect(onCard).toHaveBeenCalledTimes(2);
  });

  // INF-961: INF-899's crewmate left presentation out and was told only to give a body.
  it("points a merge card with neither body nor presentation at its saved story (INF-2744 words)", async () => {
    const onCard = vi.fn(() => "card-task-story");
    const tool = piToolOf(bindTool(EMIT_CARD_TOOL, { onCard })) as unknown as AnyTool;
    await expect(
      tool.execute("t1", {
        title: "docs(crew): guide referenced pull request merges",
        actions: [{ id: "merge", default: true, effect: { kind: "merge", after: "close" } }],
      }),
    ).rejects.toThrow(
      "Card refused: give exactly one of body or body_file. A saved-story merge card gives presentation: the newest revision prepare_change returned at the committed version. Publish it with open_change before the card, except on local-only work, which skips publication. After a push the host republishes the published story; a story whose words changed needs a new revision.",
    );
    expect(onCard).not.toHaveBeenCalled();
  });

  it("takes a merge card only with its risk, and risk on no other card (FI3-1128, INF-2744)", async () => {
    const onCard = vi.fn(() => "card-t1-9");
    const tool = piToolOf(createEmitCardTool(onCard)) as unknown as AnyTool;
    const merge = [
      { id: "merge", label: "Merge", default: true, effect: { kind: "merge", after: "close" } },
    ];
    const card = { title: "The meter fix is ready", body: "<p>Ready.</p>", actions: merge };
    // A merge with no risk is refused, naming every dimension to rate.
    await expect(tool.execute("t1", card)).rejects.toThrow(
      /Card refused: a merge card carries risk: give each of blast, behavior, undo, evidence, sensitivity, novelty, deps a level/,
    );
    // One with a dimension left out, or a level the scale has not, names it.
    const { deps: _deps, ...sixOfSeven } = RISK;
    await expect(tool.execute("t2", { ...card, risk: sixOfSeven })).rejects.toThrow(
      /Card refused: risk\.deps is missing or not right/,
    );
    await expect(
      tool.execute("t3", { ...card, risk: { ...RISK, undo: { level: "huge", why: "x" } } }),
    ).rejects.toThrow(/Card refused: risk\.undo\.level is missing or not right/);
    // A line over the length is refused; one the model wrapped reads as one.
    await expect(
      tool.execute("t4", {
        ...card,
        risk: { ...RISK, blast: { level: "low", why: "x".repeat(RISK_WHY_MAX + 1) } },
      }),
    ).rejects.toThrow(/Card refused: risk\.blast\.why is missing or not right/);
    expect(onCard).not.toHaveBeenCalled();
    await tool.execute("t5", {
      ...card,
      risk: { ...RISK, blast: { level: "low", why: "  One file\n  in the footer " } },
    });
    expect(onCard).toHaveBeenCalledWith({
      ...card,
      riskDeclaration: { ...RISK, blast: { level: "low", why: "One file in the footer" } },
    });
    // Risk on a card that merges nothing is refused.
    await expect(
      tool.execute("t6", { title: "Pick a meter", body: "<p>Two meters.</p>", risk: RISK }),
    ).rejects.toThrow(/Card refused: risk rides only on a merge card/);
  });

  it("asks the Firstmate for no risk: its merge cards carry none", async () => {
    const onCard = vi.fn(() => "card-fm-9");
    const tool = piToolOf(
      createEmitCardTool(onCard, undefined, { role: "firstmate" }),
    ) as unknown as AnyTool;
    await tool.execute("t1", {
      title: "Merge the meter fix",
      body: "<p>Ready.</p>",
      task_id: "t1",
      actions: [
        { id: "merge", label: "Merge", default: true, effect: { kind: "merge", after: "close" } },
      ],
      risk: RISK,
    });
    expect(onCard).toHaveBeenCalledWith(expect.not.objectContaining({ riskDeclaration: RISK }));
  });

  it("forwards the author's width hint, which only names a wider card", async () => {
    const onCard = vi.fn(() => "card-t1-3");
    const tool = piToolOf(createEmitCardTool(onCard)) as unknown as AnyTool;
    expect(tool.parameters.properties.width).toMatchObject({ enum: ["wide", "full"] });
    await tool.execute("t1", { title: "Note", body: "<p>x</p>", width: "full" });
    expect(onCard).toHaveBeenCalledWith({
      title: "Note",
      body: "<p>x</p>",
      actions: [],
      width: "full",
    });
  });

  it("forwards task_id and related from the Firstmate's schema", async () => {
    const onCard = vi.fn(() => "card-fm-2");
    const tool = piToolOf(
      createEmitCardTool(onCard, undefined, { role: "firstmate" }),
    ) as unknown as AnyTool;
    await tool.execute("t1", {
      title: "Note",
      body: "x",
      task_id: " t9 ",
      review_task_id: " review-1 ",
    });
    expect(onCard).toHaveBeenLastCalledWith({
      title: "Note",
      body: "x",
      actions: [],
      taskId: "t9",
      reviewTaskId: "review-1",
    });
    // INF-2714: the tasks a note mentions, trimmed and named once.
    await tool.execute("t2", {
      title: "Note",
      body: "x",
      related: [" INF-2711 ", "t9", "INF-2711"],
    });
    expect(onCard).toHaveBeenLastCalledWith({
      title: "Note",
      body: "x",
      actions: [],
      relatedTaskIds: ["INF-2711", "t9"],
    });
  });

  it("delivers a picture the body names as a served copy and a record, not a path", async () => {
    const cwd = scratchDir("fm-card-tool-shot-");
    const dir = join(scratchDir("fm-card-tool-copies-"), "cards");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(cwd, "screen.png"), png);
    const onCard = vi.fn((_card: EmittedCard) => "card-t1-shot");
    const tool = piToolOf(
      createEmitCardTool(onCard, undefined, {
        pictures: { worktree: cwd, dir, taskId: "t1" },
      }),
    ) as unknown as AnyTool;

    await tool.execute("t1", {
      title: "Rendered settings",
      body: '<p>Ready.</p><img src="screen.png" alt="Ready settings screen">',
    });

    const emitted = onCard.mock.calls[0]?.[0];
    const [picture] = emitted?.pictures ?? [];
    expect(picture).toMatchObject({ alt: "Ready settings screen", width: 1, height: 1, group: 0 });
    expect(emitted?.body).toBe(
      `<p>Ready.</p><img src="app-frame://images/${picture?.id}.png" alt="Ready settings screen" width="1" height="1">`,
    );
    expect(await readFile(join(dir, `${picture?.id}.png`))).toEqual(png);
  });

  it("rejects a malformed id before emitting", async () => {
    const onCard = vi.fn();
    const tool = piToolOf(createEmitCardTool(onCard)) as unknown as AnyTool;
    await expect(
      tool.execute("t1", {
        title: "Bad",
        body: "nope",
        id: "Not Kebab",
      }),
    ).rejects.toThrow(/kebab-case/);
    expect(onCard).not.toHaveBeenCalled();
  });
});

describe("createCloseCardTool", () => {
  it("forwards card_id and optional reason", async () => {
    const onClose = vi.fn(() => 'Closed card "Stale preview" (card-fm-1-abc).');
    const tool = piToolOf(createCloseCardTool(onClose)) as unknown as AnyTool;
    expect(tool.name).toBe(CLOSE_CARD_TOOL_NAME);
    expect(tool.description).toContain("Close a decision only when the choice no longer applies");
    const result = await tool.execute("t1", {
      card_id: "card-fm-1-abc",
      reason: "prototype superseded",
    });
    expect(onClose).toHaveBeenCalledWith({
      cardId: "card-fm-1-abc",
      reason: "prototype superseded",
    });
    expect(result.content[0]?.text).toContain("Closed card");
  });
});

describe("file-backed card bodies", () => {
  it("reads only on an explicit emission, snapshots the body, and keeps the same revision id", async () => {
    const dir = scratchDir("card-bodies-");
    const path = join(dir, "answer.html");
    const cards: EmittedCard[] = [];
    const tool = piToolOf(
      createEmitCardTool(
        (card) => {
          cards.push(card);
          return "card-t1-answer";
        },
        lintCrewmateCard,
        { cardBodiesDir: dir },
      ),
    ) as unknown as AnyTool;
    const initial = "<p>The first answer.</p><p>Unchanged evidence.</p>";
    const revised = "<p>The revised answer.</p><p>Unchanged evidence.</p>";
    await writeFile(path, initial);
    await tool.execute("first", { title: "Answer", id: "answer", body_file: path });
    await writeFile(path, revised);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.body).toBe(initial);
    await tool.execute("revision", { title: "Answer", id: "answer", body_file: "answer.html" });
    expect(cards.map((c) => ({ id: c.id, body: c.body }))).toEqual([
      { id: "answer", body: initial },
      { id: "answer", body: revised },
    ]);
    expect(await readFile(path, "utf8")).toBe(revised);
  });

  it("runs the same lint on a file and lets the author fix that file after refusal", async () => {
    const dir = scratchDir("card-bodies-lint-");
    const path = join(dir, "diagram.html");
    const onCard = vi.fn();
    const tool = piToolOf(
      createEmitCardTool(onCard, lintCrewmateCard, { cardBodiesDir: dir }),
    ) as unknown as AnyTool;
    const body = (width: number) =>
      `<p>A diagram.</p><figure><svg viewBox="0 0 ${width} 200" width="100%"><text style="font-size:11px">Label</text></svg></figure>`;
    await writeFile(path, body(1000));
    await expect(tool.execute("bad", { title: "Diagram", body_file: path })).rejects.toThrow(
      /Card refused: figure text/,
    );
    expect(onCard).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(body(1000));
    await writeFile(path, body(750));
    await tool.execute("fixed", { title: "Diagram", body_file: path });
    expect(onCard).toHaveBeenCalledOnce();
  });

  it("requires exactly one body source and never permits Firstmate file reads", async () => {
    const onCard = vi.fn();
    const tool = piToolOf(createEmitCardTool(onCard)) as unknown as AnyTool;
    for (const params of [{}, { body: "", body_file: "answer.html" }]) {
      await expect(tool.execute("bad", { title: "Answer", ...params })).rejects.toThrow(
        /exactly one/,
      );
    }
    await expect(
      tool.execute("bad", { title: "Answer", body_file: "answer.html" }),
    ).rejects.toThrow(/no card body folder/);
    const firstmate = piToolOf(
      createEmitCardTool(onCard, undefined, { role: "firstmate" }),
    ) as unknown as AnyTool;
    expect(firstmate.parameters.properties).not.toHaveProperty("body_file");
    await expect(
      firstmate.execute("bad", { title: "Answer", body_file: "answer.html" }),
    ).rejects.toThrow(/the first mate's cards use inline/);
    expect(onCard).not.toHaveBeenCalled();
  });
});

it("binds file emission through the runtime-neutral crewmate delegate and preserves pictures", async () => {
  const dir = scratchDir("body-file-bound-");
  const cwd = scratchDir("body-file-pictures-");
  const copies = scratchDir("body-file-copies-");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(join(cwd, "screen.png"), png);
  await writeFile(join(dir, "answer.html"), '<p>Ready.</p><img src="screen.png" alt="The result">');
  const onCard = vi.fn((_card: DeclaredCardInput) => "card-t1-result");
  const tool = bindTool(EMIT_CARD_TOOL, {
    onCard,
    cardBodiesDir: dir,
    cwd,
    picturesDir: copies,
    taskId: "t1",
  });
  await tool.run({ title: "The result", body_file: "answer.html" });
  const emitted = onCard.mock.calls[0]?.[0];
  const picture = emitted?.pictures?.[0];
  expect(picture).toMatchObject({ alt: "The result", width: 1, height: 1 });
  expect(emitted?.body).toContain(`app-frame://images/${picture?.id}.png`);
  expect(await readFile(join(copies, `${picture?.id}.png`))).toEqual(png);
  await writeFile(join(dir, "answer.html"), "x".repeat(65_537));
  await expect(tool.run({ title: "Too big", body_file: "answer.html" })).rejects.toThrow(
    /too large/,
  );
  expect(onCard).toHaveBeenCalledOnce();
});

it("offers the browser button only to a crewmate whose task has its own browser", async () => {
  const onCard = vi.fn((_card: DeclaredCardInput) => "card-t1-try");
  const browser = {
    navigate: vi.fn(async () => ({ text: "" })),
    inspect: vi.fn(async () => ({ text: "" })),
    act: vi.fn(async () => ({ text: "" })),
    capture: vi.fn(async () => ({ text: "" })),
    close: vi.fn(async () => ({ text: "" })),
    pages: vi.fn(async () => ({ text: "" })),
  };
  const card = { title: "The page works", body: "<p>It thanks the name.</p>" };
  const withBrowser = bindTool(EMIT_CARD_TOOL, { onCard, taskId: "t1", browser });
  const description = (
    withBrowser.parameters.properties.browser_button as unknown as { description: string }
  ).description;
  // Its rules ride its own description, which a Claude model reads.
  expect(description).toContain("never answers or closes the card");
  expect(description.length).toBeLessThan(2048);
  await withBrowser.run({ ...card, browser_button: "Try it" });
  expect(onCard.mock.calls[0]?.[0]).toMatchObject({ browserButton: "Try it" });

  // Without a browser the schema has no such field, and a stray one is not carried.
  const without = bindTool(EMIT_CARD_TOOL, { onCard, taskId: "t1" });
  expect(without.parameters.properties).not.toHaveProperty("browser_button");
  await without.run({ ...card, browser_button: "Try it" });
  expect(onCard.mock.calls[1]?.[0]).not.toHaveProperty("browserButton");
  // Nor does the Firstmate's.
  const firstmate = createEmitCardTool(onCard, undefined, { role: "firstmate" });
  expect(firstmate.parameters.properties).not.toHaveProperty("browser_button");
});

it('carries a crewmate\'s request that the captain take its browser over (docs/task-browser.md, "Asking for help")', async () => {
  const onCard = vi.fn((_card: DeclaredCardInput) => "card-t1-sign-in");
  const browser = {
    navigate: vi.fn(async () => ({ text: "" })),
    inspect: vi.fn(async () => ({ text: "" })),
    act: vi.fn(async () => ({ text: "" })),
    capture: vi.fn(async () => ({ text: "" })),
    close: vi.fn(async () => ({ text: "" })),
    pages: vi.fn(async () => ({ text: "" })),
  };
  const request = {
    title: "Sign in to aurora.example to continue the booking",
    body: "<p>Aurora needs your account to hold the fare.</p>",
    browser_handoff: {
      site: "aurora.example",
      reason: "Aurora needs your account to hold the fare",
      after: "fill in the passenger details",
    },
    actions: [
      { id: "leave", label: "Leave waiting" },
      {
        id: "sign-in",
        label: "Open browser and sign in",
        default: true,
        effect: { kind: "open" as const, target: "browser" as const },
      },
    ],
  };
  const withBrowser = bindTool(EMIT_CARD_TOOL, { onCard, taskId: "t1", browser });
  const description = (
    withBrowser.parameters.properties.browser_handoff as unknown as { description: string }
  ).description;
  // Its rules ride its own top-level description, which a Claude model reads.
  expect(description).toContain('{ kind: "open", target: "browser" }');
  expect(description).toContain("never permission to buy, pay or submit");
  // The final submission is the captain's, and the card is its review
  // (docs/task-browser.md, "A final submission"): the knowledge rides here.
  expect(description).toContain("is the captain's to make: prepare it up to its last step");
  expect(description).toContain(
    "dates and times with time zones, passengers, seller, total and currency",
  );
  expect(description).toContain(
    "If the price or terms change after a review, stop and review again",
  );
  expect(description).toContain("the outcome is unknown: never submit, reload or resend it");
  // An unconfirmed outcome stays unknown in its words too: no guess either
  // way from a missing booking, and no hint that anyone may try again.
  expect(description).toContain(UNKNOWN_OUTCOME_WORDS);
  expect(description.length).toBeLessThan(2048);
  await withBrowser.run(request);
  expect(onCard.mock.calls[0]?.[0]).toMatchObject({
    browserHandoff: request.browser_handoff,
    actions: [
      { id: "leave", label: "Leave waiting" },
      {
        id: "sign-in",
        label: "Open browser and sign in",
        default: true,
        effect: { kind: "open", target: "browser" },
      },
    ],
  });
  // Without a browser there is no request, and a stray one is not carried.
  const without = bindTool(EMIT_CARD_TOOL, { onCard, taskId: "t1" });
  expect(without.parameters.properties).not.toHaveProperty("browser_handoff");
  await without.run({ ...request, actions: [{ id: "ok", label: "Looks right", default: true }] });
  expect(onCard.mock.calls[1]?.[0]).not.toHaveProperty("browserHandoff");
  // The Firstmate opens no task's browser: its lint says so.
  expect(
    lintFirstmateCard(
      {
        title: "Sign in for the crewmate",
        body: "<p>The crewmate needs your sign-in.</p>",
        taskId: "t1",
        actions: [
          { id: "leave", label: "Leave it" },
          {
            id: "open",
            label: "Open browser",
            default: true,
            effect: { kind: "open", target: "browser" },
          },
        ],
      },
      { resolveCardId: (id) => id, taskExists: () => true },
    ),
  ).toContain("only that task's crewmate may ask the captain to take over");
});

// INF-1849 piece 2: the crewmate's word that a saved sign-in did not sign its page in.
it("carries saved_failed inside browser_handoff to the declared handoff", async () => {
  const onCard = vi.fn((_card: DeclaredCardInput) => "card-1");
  const browser = {
    navigate: vi.fn(async () => ({ text: "" })),
    inspect: vi.fn(async () => ({ text: "" })),
    act: vi.fn(async () => ({ text: "" })),
    capture: vi.fn(async () => ({ text: "" })),
    close: vi.fn(async () => ({ text: "" })),
    pages: vi.fn(async () => ({ text: "" })),
  };
  const request = {
    title: "Sign in to aurora.example again",
    body: "<p>Aurora still asks for a sign-in after the saved one.</p>",
    browser_handoff: {
      site: "aurora.example",
      reason: "The saved sign-in did not sign the page in",
      after: "fill in the passenger details",
    },
    actions: [
      { id: "leave", label: "Leave waiting" },
      {
        id: "sign-in",
        label: "Open browser and sign in",
        default: true,
        effect: { kind: "open" as const, target: "browser" as const },
      },
    ],
  };
  const tool = bindTool(EMIT_CARD_TOOL, { onCard, taskId: "t1", browser });
  await tool.run({
    ...request,
    browser_handoff: { ...request.browser_handoff, saved_failed: true },
  });
  expect(onCard.mock.calls[0]?.[0]).toMatchObject({
    browserHandoff: { ...request.browser_handoff, savedFailed: true },
  });
  await tool.run(request);
  expect(onCard.mock.calls[1]?.[0]).toMatchObject({ browserHandoff: request.browser_handoff });
  expect(onCard.mock.calls[1]?.[0]?.browserHandoff).not.toHaveProperty("savedFailed");
  expect(onCard).toHaveBeenCalledTimes(2);
});
