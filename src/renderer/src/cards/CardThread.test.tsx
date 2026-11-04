import type { CardMessage } from "@shared/cards";
import type { MouseEvent, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardThread, LatestLine, MessageList, settingsRows } from "./CardThread";
import { threadWaitLine } from "./useThreadWait";

describe("card thread working state", () => {
  it("renders only a muted, busy working label while active and removes it when idle", () => {
    const active = renderToStaticMarkup(<MessageList messages={[]} working />);
    const idle = renderToStaticMarkup(<MessageList messages={[]} working={false} />);

    expect(active).toContain('data-thread-working="" aria-busy="true"');
    expect(active).toContain("color:var(--fg-3)");
    expect(active).toMatch(
      /<div data-thread-working=""[^>]*><span style="font-family:var\(--font-mono\)[^"]*">working<\/span><\/div>/,
    );
    expect(active).not.toContain("<canvas");
    expect(idle).not.toContain("data-thread-working");
  });

  // INF-990 friction 3: what the crewmate does on the reply shows beside
  // `working`, open and collapsed, in place of the newest message.
  it("names what the crewmate is doing on the reply beside working", () => {
    const doing = "Rename review to audit across the app";
    const open = renderToStaticMarkup(<MessageList messages={[]} working doing={doing} />);
    expect(open).toMatch(/>working<\/span><span data-thread-doing="" title="[^"]*"[^>]*>Rename/);
    const idle = renderToStaticMarkup(<MessageList messages={[]} doing={doing} />);
    expect(idle).not.toContain(doing);
    const asked: CardMessage[] = [
      { id: 1, cardId: "c", who: "captain", text: "rename review to audit", at: 0 },
    ];
    const cue = renderToStaticMarkup(
      <LatestLine cardId="c" messages={asked} working doing={doing} onOpen={() => {}} />,
    );
    expect(cue).toContain(`data-thread-cue-said="" data-quiet="">${doing}<`);
    expect(cue).toContain('data-thread-cue-state="">working<');
  });
});

describe("card thread messages", () => {
  it("keeps a multi-line reply's line breaks, as typed", () => {
    const markup = renderToStaticMarkup(
      <MessageList
        messages={[
          {
            id: 1,
            cardId: "card-1",
            who: "captain",
            text: "the second option is wrong\n\n  keep the first",
            at: 0,
          },
        ]}
      />,
    );
    const message = markup.slice(markup.indexOf('data-thread-message="captain"'));
    expect(message).toMatch(
      /<span style="[^"]*white-space:pre-wrap[^"]*">the second option is wrong\n\n {2}keep the first/,
    );
  });

  // INF-2225, INF-2214's approved shared cards: a line someone other than the
  // card's author wrote names who wrote it, the same words the phone shows.
  it("names who wrote a line on someone else's card, and a clarification after it closed", () => {
    const contributor = {
      actor: "crewmate" as const,
      taskId: "t2",
      label: "the crewmate on DOP-208",
    };
    const markup = renderToStaticMarkup(
      <MessageList
        messages={[
          { id: 1, cardId: "card-1", who: "captain", text: "Where is the remover?", at: 0 },
          { id: 2, cardId: "card-1", who: "host", text: "revised: Remove it", at: 1, contributor },
          {
            id: 3,
            cardId: "card-1",
            who: "crewmate",
            text: "It is under FleetCheckSetup.",
            at: 2,
            contributor,
            answersMessage: 1,
          },
          {
            id: 4,
            cardId: "card-1",
            who: "firstmate",
            text: "For the record.",
            at: 3,
            contributor: { actor: "firstmate", label: "your first mate" },
            clarification: true,
          },
        ]}
      />,
    );
    const said = [...markup.matchAll(/data-thread-contributor[^>]*>([^<]*)</g)].map(
      (match) => match[1],
    );
    expect(said).toEqual([
      "Revised by the crewmate on DOP-208",
      "Written by the crewmate on DOP-208",
      "Written by your first mate, after the card closed",
    ]);
  });
});

describe("card thread reply settings", () => {
  it("shows his words alone, with the settings as one collapsed line under them", () => {
    const markup = renderToStaticMarkup(
      <MessageList
        messages={[
          {
            id: 1,
            cardId: "card-1",
            who: "captain",
            text: "slow the ease a little",
            at: 0,
            answers: [
              {
                name: "settings",
                values: ['{"ms":160,"ease":{"in":0.2}}'],
                changed: true,
                json: true,
              },
            ],
          },
        ]}
      />,
    );
    expect(markup).toContain("slow the ease a little");
    expect(markup).not.toContain("Current settings");
    expect(markup).toMatch(
      /<button type="button" data-thread-settings-toggle="" aria-expanded="false" aria-controls="[^"]+">/,
    );
    expect(markup).toContain("settings · 2 values");
    // Collapsed by default: the panel is not drawn until he opens it.
    expect(markup).not.toContain("data-thread-settings=");
  });

  it("draws no settings line on a reply that carried none, or on an author's line", () => {
    const markup = renderToStaticMarkup(
      <MessageList
        messages={[
          { id: 1, cardId: "card-1", who: "captain", text: "looks right", at: 0 },
          {
            id: 2,
            cardId: "card-1",
            who: "crewmate",
            text: "kept it",
            at: 1,
            answers: [{ name: "tone", values: ["plain"], changed: true }],
          },
        ]}
      />,
    );
    expect(markup).not.toContain("data-thread-settings-toggle");
  });

  it("opens a snapshot into one row per leaf, and a question into its picked label", () => {
    expect(
      settingsRows([
        {
          name: "settings",
          values: ['{"ms":160,"ease":{"in":0.2},"tags":["a"]}'],
          changed: true,
          json: true,
        },
      ]),
    ).toEqual([
      { key: "ms", value: "160" },
      { key: "ease.in", value: "0.2" },
      { key: "tags", value: '["a"]' },
    ]);
    expect(
      settingsRows([
        { name: "variant", values: ["hold"], labels: ["Hold then crossfade"], changed: true },
        { name: "speed", values: [], changed: false },
        { name: "look", values: ['{"tilt":42}'], changed: true, json: true },
        { name: "raw", values: ["not json"], changed: true, json: true },
      ]),
    ).toEqual([
      { key: "variant", value: "Hold then crossfade", state: "changed" },
      { key: "speed", value: "no answer", state: "as proposed" },
      { key: "look.tilt", value: "42" },
      { key: "raw", value: "not json" },
    ]);
  });

  it("reads words written under Something else after the picks, in quotes (FI3-1002)", () => {
    expect(
      settingsRows([
        { name: "key_app", values: [], changed: true, written: "Try once, then tell me" },
        {
          name: "launch_list",
          values: ["FI3-962"],
          labels: ["Devices keeps this Mac's old address"],
          changed: true,
          written: "also FI3-957",
        },
      ]),
    ).toEqual([
      { key: "key_app", value: "“Try once, then tell me”", state: "changed" },
      {
        key: "launch_list",
        value: "Devices keeps this Mac's old address, “also FI3-957”",
        state: "changed",
      },
    ]);
  });
});

describe("card thread waiting line", () => {
  const replied = { author: "crewmate", awaiting: "answer", taskId: "t1" } as const;
  const held = {
    assignee: "crewmate 7",
    workPosture: {
      state: "paused",
      reason: "access",
      hold: { class: "refused", provider: "Claude" },
    },
  } as const;

  it("ends an idle thread with one quiet line naming the wait, its hold and who goes next", () => {
    const waiting = threadWaitLine(replied, held, 0);
    expect(waiting).toMatchObject({ on: "account", hold: "refused" });
    const markup = renderToStaticMarkup(<MessageList messages={[]} waiting={waiting} />);
    expect(markup).toContain('data-thread-waiting="account"');
    expect(markup).toContain('data-thread-hold="refused"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("color:var(--fg-3)");
    expect(markup).toContain("It goes to crewmate 7");
    expect(markup).not.toContain("data-thread-working");
  });

  it("shows working alone while a turn runs, and nothing once the author has written", () => {
    const waiting = threadWaitLine(replied, held, 0);
    const working = renderToStaticMarkup(<MessageList messages={[]} working waiting={waiting} />);
    expect(working).toContain("data-thread-working");
    expect(working).not.toContain("data-thread-waiting");
    expect(threadWaitLine({ ...replied, awaiting: "close-out" }, held, 0)).toBeUndefined();
    expect(threadWaitLine(replied, undefined, 0)).toBeUndefined();
  });
});

describe("a thread collapsed into its card (FI3-1130)", () => {
  const said = (id: number, who: CardMessage["who"], text: string): CardMessage => ({
    id,
    cardId: "c",
    who,
    text,
    at: 0,
  });
  const thread = [
    said(1, "captain", "can fixes go first instead?"),
    said(2, "host", "revised: fixes now lead the page"),
    said(3, "crewmate", "Done in the preview. The headings read Fixes, Features, Other."),
  ];
  const crew = { author: "crewmate", taskId: "t1" } as const;

  it("puts one collapse in the thread's head, never an ×, with the command's key", () => {
    const markup = renderToStaticMarkup(
      <CardThread cardId="c" card={crew} onCollapse={() => {}} />,
    );
    const button = markup.match(/<button[^>]*data-thread-collapse=""[^>]*>/)?.[0] ?? "";
    expect(button).toContain('aria-label="Collapse thread"');
    expect(button).toContain('aria-keyshortcuts="Meta+\\"');
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).not.toContain("×");
    // Its chevron points left, into the card.
    expect(markup).toContain('d="m11 15-3-3 3-3"');
    // A column drawn with nothing to collapse it into has no control.
    expect(renderToStaticMarkup(<CardThread cardId="c" card={crew} />)).not.toContain("<button");
  });

  it("shows who wrote last, the newest message and the count, and opens the thread", () => {
    const markup = renderToStaticMarkup(
      <LatestLine cardId="c" messages={thread} keyShortcuts={"Meta+\\"} onOpen={() => {}} />,
    );
    expect(markup).toMatch(/^<button type="button" data-thread-cue="c"/);
    expect(markup).toContain('aria-label="Show thread, 3 messages"');
    expect(markup).toContain('aria-keyshortcuts="Meta+\\"');
    expect(markup).toMatch(/data-thread-cue-who="" style="color:var\(--accent\)">crew</);
    expect(markup).toContain(">Done in the preview. The headings read Fixes, Features, Other.<");
    expect(markup).toContain('data-thread-cue-state="">3 messages<');
    // Its chevron points right, toward where the thread opens.
    expect(markup).toContain('d="m8 9 3 3-3 3"');
    const opened: boolean[] = [];
    const row = LatestLine({
      cardId: "c",
      messages: thread,
      onOpen: (byKey) => opened.push(byKey),
    }) as ReactElement<{ onClick: (event: Pick<MouseEvent, "detail">) => void }>;
    // Enter or Space press it with no click counted; a pointer counts one.
    row.props.onClick({ detail: 0 });
    row.props.onClick({ detail: 1 });
    expect(opened).toEqual([true, false]);
  });

  it("reads a host line quietly, and one message as one", () => {
    const host = renderToStaticMarkup(
      <LatestLine cardId="c" messages={thread.slice(0, 2)} onOpen={() => {}} />,
    );
    expect(host).toContain(
      'data-thread-cue-said="" data-quiet="">revised: fixes now lead the page<',
    );
    expect(host).toMatch(/style="color:var\(--fg-3\)">app</);
    const one = renderToStaticMarkup(
      <LatestLine cardId="c" messages={thread.slice(0, 1)} onOpen={() => {}} />,
    );
    expect(one).toContain('aria-label="Show thread, 1 message"');
    expect(one).toMatch(/style="color:var\(--captain\)">you</);
    expect(renderToStaticMarkup(<LatestLine cardId="c" messages={[]} onOpen={() => {}} />)).toBe(
      "",
    );
  });

  it("says working while the author's turn runs, and the waiting line in place of the message", () => {
    const replied = { author: "crewmate", awaiting: "answer", taskId: "t1" } as const;
    const waiting = threadWaitLine(
      replied,
      {
        assignee: "crewmate 7",
        workPosture: {
          state: "paused",
          reason: "access",
          hold: { class: "refused", provider: "Claude" },
        },
      },
      0,
    );
    const asked = [...thread, said(4, "captain", "can each fix link to its pull request?")];
    const working = renderToStaticMarkup(
      <LatestLine cardId="c" messages={asked} working waiting={waiting} onOpen={() => {}} />,
    );
    expect(working).toContain('aria-label="Show thread, author working"');
    expect(working).toContain('data-thread-cue-state="">working<');
    expect(working).toContain(">can each fix link to its pull request?<");
    const held = renderToStaticMarkup(
      <LatestLine cardId="c" messages={asked} waiting={waiting} onOpen={() => {}} />,
    );
    expect(held).toMatch(/data-thread-cue-who="" style="[^"]*"><\/span>/);
    expect(held).toContain('data-thread-cue-said="" data-quiet="">');
    expect(held).toContain("It goes to crewmate 7");
    expect(held).not.toContain("can each fix link to its pull request?");
    expect(held).toContain('data-thread-cue-state="">4 messages<');
  });
});
