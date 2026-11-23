import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CARD_MEDIA_PIECE_BYTES } from "@shared/cardPictures";
import type { CardPicture } from "@shared/cards";
import { placedTaskFolders } from "@shared/work";
import { describe, expect, it } from "vitest";
import { fillMapPart, MAP_DATA } from "../../../tests/helpers/architectureMap";
import { expectBytesEqual } from "../../../tests/helpers/expectBytes";
import { projectFontBytes } from "../../../tests/helpers/fontFixture";
import { gif } from "../../../tests/helpers/gifFixture";
import { box, mp4 } from "../../../tests/helpers/mp4Fixture";
import {
  api,
  model,
  placed,
  png,
  sessionHostHooks,
  TASK,
} from "../../../tests/helpers/sessionHostWorld";
import { CREWMATE_TOOLS } from "../pi/crewmateTaskTools";

sessionHostHooks();

const MAP_PART = readFileSync(
  join(
    __dirname,
    "../../../resources/runbooks/architecture/skills/advanced-architecture/parts/map.html",
  ),
  "utf8",
);

describe("a conversation held on a computer that runs work", () => {
  it("sends a card's picture before the card, from the folder the crewmate wrote it in", async () => {
    const at = await placed();
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    const picture_ = png();
    writeFileSync(join(folders.evidence, "after.png"), picture_);
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "Done on another Mac",
              body: `<p>It works.</p><img src="${join(folders.evidence, "after.png")}" alt="It works">`,
            },
          },
        ],
      },
      { text: "Shown." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:4", task: TASK, text: "Show it." }]);
    await at.ended(1);

    expect(at.home.effects.map((effect) => effect.channel)).toEqual([
      "inf:work:picture",
      "inf:work:card",
    ]);
    const [picture, card] = at.home.effects;
    expect(at.home.pictures.get(String(picture?.request.id))).toEqual(picture_);
    expect(card?.request.card).toMatchObject({
      title: "Done on another Mac",
      pictures: [{ id: picture?.request.id, alt: "It works" }],
    });
    expect(String((card?.request.card as { body?: string } | undefined)?.body)).toContain(
      `${picture?.request.id}.png`,
    );
    const toolEnd = at.home.events.find(
      (record) => record.event.type === "tool_end" && record.event.toolName === "emit_card",
    );
    expect(toolEnd?.event).toMatchObject({ isError: false });
  });

  it("sends a demo's recording in pieces after its poster and before the card, checked by this computer's decoder", async () => {
    const decoded: number[] = [];
    const at = await placed({
      probeMedia: async ({ bytes }) => {
        decoded.push(bytes.length);
        return { ok: true, width: 400, height: 300, durationMs: 2000 };
      },
    });
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    // Past one piece, so it crosses in two.
    const recording = Buffer.concat([
      mp4({ width: 400, height: 300 }),
      box("free", Buffer.alloc(CARD_MEDIA_PIECE_BYTES)),
    ]);
    writeFileSync(join(folders.evidence, "demo.mp4"), recording);
    writeFileSync(join(folders.evidence, "demo.png"), png());
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "A demo from another Mac",
              body: `<p>It moves.</p><figure data-inf-demo="${join(folders.evidence, "demo.mp4")}"><img src="${join(folders.evidence, "demo.png")}" alt="It moves"></figure>`,
            },
          },
        ],
      },
      { text: "Shown." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:demo", task: TASK, text: "Show it." }]);
    await at.ended(1);

    expect(decoded).toEqual([recording.length]);
    expect(at.home.effects.map((effect) => effect.channel)).toEqual([
      "inf:work:picture",
      "inf:work:media",
      "inf:work:media",
      "inf:work:card",
    ]);
    const card = at.home.effects.at(-1)?.request.card as { pictures?: CardPicture[] };
    const demo = card.pictures?.[0]?.demo;
    expect(demo).toMatchObject({ kind: "mp4", bytes: recording.length });
    const received = at.home.recordings.get(String(demo?.id));
    expect(received).toBeDefined();
    expectBytesEqual(received as Buffer, recording);
    expect(at.home.effects[1]?.request).toMatchObject({ offset: 0, size: recording.length });
    expect(at.home.effects[2]?.request).toMatchObject({
      offset: CARD_MEDIA_PIECE_BYTES,
      size: recording.length,
    });
  });

  it("sends a GIF demo as a GIF after its poster, by its own walk with no decoder asked", async () => {
    const decoded: number[] = [];
    const at = await placed({
      probeMedia: async ({ bytes }) => {
        decoded.push(bytes.length);
        return { ok: false, reason: "a GIF is never probed" };
      },
    });
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    const recording = gif({ width: 400, height: 300, frames: 4 });
    writeFileSync(join(folders.evidence, "demo.gif"), recording);
    writeFileSync(join(folders.evidence, "demo.png"), png());
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "A GIF demo from another Mac",
              body: `<p>It moves.</p><figure data-inf-demo="${join(folders.evidence, "demo.gif")}"><img src="${join(folders.evidence, "demo.png")}" alt="It moves"></figure>`,
            },
          },
        ],
      },
      { text: "Shown." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:gif", task: TASK, text: "Show it." }]);
    await at.ended(1);

    expect(decoded).toEqual([]);
    expect(at.home.effects.map((effect) => effect.channel)).toEqual([
      "inf:work:picture",
      "inf:work:media",
      "inf:work:card",
    ]);
    expect(at.home.effects[1]?.request).toMatchObject({ extension: "gif", offset: 0 });
    const card = at.home.effects.at(-1)?.request.card as { pictures?: CardPicture[] };
    const demo = card.pictures?.[0]?.demo;
    expect(demo).toMatchObject({ kind: "gif", bytes: recording.length, durationMs: 400 });
    const received = at.home.recordings.get(String(demo?.id));
    expect(received).toBeDefined();
    expectBytesEqual(received as Buffer, recording);
  });

  // INF-128's plan, with the captain's "In this build" for other computers:
  // a preview's project font, checked where the crewmate runs, goes home
  // before the card that names it.
  it("sends a preview's project font before the card, checked by this computer's font loader", async () => {
    const loaded: string[] = [];
    const at = await placed({
      probeTypeface: async (typefaces) => {
        loaded.push(...typefaces.map(({ contentType }) => contentType));
        return typefaces.map(() => ({ ok: true }));
      },
    });
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    const font = projectFontBytes();
    writeFileSync(join(folders.evidence, "face.woff2"), font);
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "A preview from another Mac",
              body: `<p>The balance screen.</p><style>@font-face{font-family:"Wallet";src:url("${join(folders.evidence, "face.woff2")}")}.b{font-family:"Wallet"}</style><p class="b">$42.50</p>`,
            },
          },
        ],
      },
      { text: "Shown." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:font", task: TASK, text: "Show it." }]);
    await at.ended(1);

    expect(loaded).toEqual(["font/woff2"]);
    expect(at.home.effects.map((effect) => effect.channel)).toEqual([
      "inf:work:typeface",
      "inf:work:card",
    ]);
    const [typeface, card] = at.home.effects;
    expect(typeface?.request).toMatchObject({ extension: "woff2" });
    expectBytesEqual(at.home.typefaces.get(String(typeface?.request.id)) as Buffer, font);
    expect(String((card?.request.card as { body?: string } | undefined)?.body)).toContain(
      `url("app-frame://typefaces/${typeface?.request.id}.woff2")`,
    );
  });

  it("refuses a card naming a project font to a home too old to keep one, sending none of it", async () => {
    const at = await placed({
      probeTypeface: async (typefaces) => typefaces.map(() => ({ ok: true })),
      // A minor before the one that keeps project fonts (`CARD_TYPEFACES_SINCE`).
      homeVersion: "8.8.0",
    });
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    writeFileSync(join(folders.evidence, "face.woff2"), projectFontBytes());
    writeFileSync(join(folders.evidence, "after.png"), png());
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "A preview for an older home",
              // A picture beside the font: refused first, it never crosses either.
              body: `<style>@font-face{font-family:"Wallet";src:url("${join(folders.evidence, "face.woff2")}")}</style><p>$42.50</p><img src="${join(folders.evidence, "after.png")}" alt="The screen">`,
            },
          },
        ],
      },
      { text: "Refused." },
    ]);
    await at.order("inf:session:prompt", [{ orderId: "rows:old", task: TASK, text: "Show it." }]);
    await at.ended(1);

    expect(at.home.effects.map((effect) => effect.channel)).toEqual([]);
    const toolEnd = at.home.events.find(
      (record) => record.event.type === "tool_end" && record.event.toolName === "emit_card",
    );
    expect(toolEnd?.event).toMatchObject({ isError: true });
    // The crewmate reads why, and what to do instead, in the tool's answer.
    expect(JSON.stringify(api.requests.at(-1)?.body?.messages)).toContain(
      "runs an older Infinitary that cannot show a project's fonts",
    );
  });

  // INF-4543's plan: a crewmate's narration plays on the home's card, so its
  // clip goes home before the card, and only to a home that keeps clips.
  it.each([
    { homeChanges: ["card-sound-clips"], keeps: true },
    { homeChanges: [], keeps: false },
  ])(
    "sends a card's sound clip before the card only to a home that keeps one ($homeChanges)",
    async ({ homeChanges, keeps }) => {
      const at = await placed({
        homeChanges,
        probeMedia: async ({ contentType }) =>
          contentType === "audio/wav"
            ? { ok: true, width: 0, height: 0, durationMs: 2000 }
            : { ok: false, reason: "not sound" },
      });
      await at.open();
      const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
      const clip = readFileSync("tests/fixtures/sound/tone.wav");
      writeFileSync(join(folders.evidence, "narration.wav"), clip);
      model([
        {
          tools: [
            {
              name: "emit_card",
              args: {
                title: "Narration from another Mac",
                body: `<figure data-inf-sound="${join(folders.evidence, "narration.wav")}"><figcaption>Narration</figcaption></figure>`,
              },
            },
          ],
        },
        { text: "Done." },
      ]);
      await at.order("inf:session:prompt", [
        { orderId: "rows:sound", task: TASK, text: "Show it." },
      ]);
      await at.ended(1);

      if (!keeps) {
        expect(at.home.effects.map((effect) => effect.channel)).toEqual([]);
        expect(JSON.stringify(api.requests.at(-1)?.body?.messages)).toContain(
          "runs an older Infinitary that cannot play a card's sound clips",
        );
        return;
      }
      expect(at.home.effects.map((effect) => effect.channel)).toEqual([
        "inf:work:media",
        "inf:work:card",
      ]);
      expect(at.home.effects[0]?.request).toMatchObject({ extension: "wav", size: clip.length });
      const id = String(at.home.effects[0]?.request.id);
      expectBytesEqual(at.home.recordings.get(id) as Buffer, clip);
      const card = at.home.effects.at(-1)?.request.card as { body: string };
      expect(card.body).toContain(`data-inf-sound="app-frame://media/${id}.wav"`);
    },
  );

  // The captain, on the map grown too large for a card: "the actual data
  // should live in a file, and the renderer loads from the file". A card's
  // data file goes home before the card, so the home holds it when the
  // card's script asks. Major 16 folded `card-data` into the work major, so
  // every home this computer works for takes one, whatever name it lists.
  it.each([{ homeChanges: ["card-data"] }, { homeChanges: [] }])(
    "sends a card's data file before the card after work admission ($homeChanges)",
    async ({ homeChanges }) => {
      const at = await placed({ homeChanges });
      await at.open();
      const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
      const mapJson = JSON.stringify(MAP_DATA);
      writeFileSync(join(folders.evidence, "map-data.json"), mapJson);
      writeFileSync(join(folders.evidence, "after.png"), png());
      model([
        {
          tools: [
            {
              name: "emit_card",
              args: {
                title: "The core's map from another Mac",
                // A picture beside the data: refused first, it never crosses either.
                body: `<p>The core's parts.</p><script type="application/json" data-map src="${join(folders.evidence, "map-data.json")}"></script><img src="${join(folders.evidence, "after.png")}" alt="The map">`,
              },
            },
          ],
        },
        { text: "Done." },
      ]);
      await at.order("inf:session:prompt", [
        { orderId: "rows:data", task: TASK, text: "Show it." },
      ]);
      await at.ended(1);

      const toolEnd = at.home.events.find(
        (record) => record.event.type === "tool_end" && record.event.toolName === "emit_card",
      );
      expect(toolEnd?.event).toMatchObject({ isError: false });
      expect(at.home.effects.map((effect) => effect.channel)).toEqual([
        "inf:work:media",
        "inf:work:picture",
        "inf:work:card",
      ]);
      const [data, , card] = at.home.effects;
      expect(data?.request).toMatchObject({ extension: "json", offset: 0, size: mapJson.length });
      expect(String(at.home.recordings.get(String(data?.request.id)))).toBe(mapJson);
      expect(String((card?.request.card as { body?: string } | undefined)?.body)).toContain(
        `src="app-frame://data/${data?.request.id}.json"`,
      );
    },
  );

  // The captain, on map cards carrying the map's code: "does our cards not
  // support importing repetitive boilerplates, avoiding counting them in the
  // card size?" A card names the map part by reference. Major 16 folded
  // `card-app-parts` into the work major: every home this computer works for
  // fills the reference in its window, so the card crosses as written, the
  // part's code never counted against the card size limit.
  it.each([
    { case: "lists the retired name", homeChanges: ["card-app-parts"], pad: 0 },
    { case: "lists nothing", homeChanges: [], pad: 0 },
    {
      case: "lists nothing, when the part's code would not fit beside it",
      homeChanges: [],
      pad: 50_000,
    },
  ])(
    "sends a card naming the map part as written to a home that $case",
    async ({ homeChanges, pad }) => {
      const at = await placed({ homeChanges });
      await at.open();
      // The part as the runbook ships it, with an empty map and, to go over, a long note.
      const body = fillMapPart(MAP_PART, JSON.stringify({ maps: {}, note: "x".repeat(pad) }));
      model([
        {
          tools: [{ name: "emit_card", args: { title: "The core's map from another Mac", body } }],
        },
        { text: "Done." },
      ]);
      await at.order("inf:session:prompt", [
        { orderId: "rows:part", task: TASK, text: "Show it." },
      ]);
      await at.ended(1);

      const sent = at.home.effects.find((effect) => effect.channel === "inf:work:card");
      const sentBody = String((sent?.request.card as { body?: string } | undefined)?.body);
      expect(sentBody).toBe(body);
      expect(sentBody).toContain("data-inf-part");
    },
  );

  // INF-3715: the summary of what changed since the captain saw an earlier merge
  // card. Major 16 folded `merge-card-since-seen` into the work major, so every
  // home this computer works for keeps it.
  it.each([{ homeChanges: ["merge-card-since-seen"] }, { homeChanges: [] }])(
    "sends a merge card's since_seen after work admission ($homeChanges)",
    async ({ homeChanges }) => {
      const at = await placed({ homeChanges });
      await at.open();
      model([
        {
          tools: [
            {
              name: "emit_card",
              args: {
                title: "feat(queue): merge passed batches without an open app",
                presentation: 2,
                since_seen: "Review repairs grew this from 1,366 to 4,562 added lines.",
                actions: [
                  { id: "merge", default: true, effect: { kind: "merge", after: "close" } },
                ],
              },
            },
          ],
        },
        { text: "Done." },
      ]);
      await at.order("inf:session:prompt", [{ orderId: "since:1", task: TASK, text: "Show it." }]);
      await at.ended(1);

      const cards = at.home.effects.filter((effect) => effect.channel === "inf:work:card");
      expect(cards[0]?.request.card).toMatchObject({
        presentationRevision: 2,
        sinceSeen: "Review repairs grew this from 1,366 to 4,562 added lines.",
      });
    },
  );

  // INF-3717 piece 2: the one call that shows a merge card. Major 16 folded
  // `show-merge-card` into the work major, so every home this computer works
  // for answers the order.
  it.each([{ homeChanges: ["show-merge-card"] }, { homeChanges: [] }])(
    "sends show_merge_card after work admission ($homeChanges)",
    async ({ homeChanges }) => {
      const at = await placed({
        homeChanges,
        tools: CREWMATE_TOOLS.filter((tool) => tool.name === "show_merge_card"),
      });
      await at.open();
      model([
        { tools: [{ name: "show_merge_card", args: { id: "merge-footer", after: "close" } }] },
        { text: "Done." },
      ]);
      await at.order("inf:session:prompt", [{ orderId: "merge:1", task: TASK, text: "Show it." }]);
      await at.ended(1);

      const asked = at.home.effects.filter(
        (effect) => effect.channel === "inf:work:show-merge-card",
      );
      expect(asked[0]?.request.input).toEqual({ card: { id: "merge-footer", after: "close" } });
    },
  );

  // INF-3757, direction C, and the captain's condition on it: "the file
  // content should not physically get attached to the card. data transfer
  // should only happen when user click". The card crosses to the home with
  // the file's reference alone; the copy stays in the task's `cards` folder
  // here until a Save reads it.
  it("keeps a card's file for the captain here and sends the home only its reference", async () => {
    const at = await placed({ homeChanges: ["card-files"] });
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    const letter = Buffer.from("Dear landlord, the heating in flat 4 has been off since Monday.\n");
    writeFileSync(join(folders.temp, "letter to the landlord.txt"), letter);
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "The letter is ready",
              body: "<p>The letter to the landlord is ready to send.</p>",
              files: [join(folders.temp, "letter to the landlord.txt")],
            },
          },
        ],
      },
      { text: "Shown." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "rows:files", task: TASK, text: "Hand it over." },
    ]);
    await at.ended(1);

    // Only the card crosses: no picture order carries the file.
    expect(at.home.effects.map((effect) => effect.channel)).toEqual(["inf:work:card"]);
    const sha256 = createHash("sha256").update(letter).digest("hex");
    const id = `${TASK}-${sha256.slice(0, 32)}`;
    const card = at.home.effects[0]?.request.card as { files?: unknown[] };
    expect(card.files).toEqual([
      {
        id,
        name: "letter to the landlord.txt",
        bytes: letter.length,
        sha256,
        path: join(folders.cards, `${id}.file`),
      },
    ]);
    expect(JSON.stringify(at.home.effects)).not.toContain("heating in flat 4");
    expect(readFileSync(join(folders.cards, `${id}.file`))).toEqual(letter);
  });

  // Major 16 folded `card-files` into the work major: a home that lists no name still shows a card's files.
  it("sends a card's file reference to a home that lists no retired name", async () => {
    const at = await placed({ homeChanges: [] });
    await at.open();
    const folders = placedTaskFolders(join(at.dataDir, "tasks"), TASK);
    writeFileSync(join(folders.temp, "letter to the landlord.txt"), "Dear landlord.\n");
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              title: "The letter is ready",
              body: "<p>The letter is ready.</p>",
              files: [join(folders.temp, "letter to the landlord.txt")],
            },
          },
        ],
      },
      { text: "Shown." },
    ]);
    await at.order("inf:session:prompt", [
      { orderId: "rows:old-files", task: TASK, text: "Hand it over." },
    ]);
    await at.ended(1);

    expect(at.home.effects.map((effect) => effect.channel)).toEqual(["inf:work:card"]);
    const card = at.home.effects[0]?.request.card as { files?: { name: string }[] };
    expect(card.files?.map((file) => file.name)).toEqual(["letter to the landlord.txt"]);
    expect(JSON.stringify(at.home.effects)).not.toContain("Dear landlord");
  });
});
