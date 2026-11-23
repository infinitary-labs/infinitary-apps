import { createHash } from "node:crypto";
import type { ChangePresentation } from "@shared/changePresentation";
import type { HostedPresentationDestination } from "@shared/presentationDestination";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { DEMO_POSTER, DEMO_RECORDING } from "../../../tests/e2e/demoFixtures";
import { BUNDLED_NAMING } from "../../../tests/helpers/namingRunbook";
import {
  PresentationAroundError,
  presentationCardBody,
  presentationCommitMessage,
  presentationMarkdown,
  presentationRegionMarkers,
  readPresentationRegion,
  replaceAroundPresentation,
} from "./presentation";

// INF-155's live reading disproved video widths in GitHub's two-column tables.
// Exercise the renderer with the existing real recording/poster fixture, not source-text pins.
const head = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
const posterBytes = (() => {
  const bytes = DEMO_POSTER.bytes;
  if (!bytes) throw new Error("The recording fixture has no poster bytes.");
  return bytes;
})();
const imageHash = createHash("sha256").update(posterBytes).digest("hex");
const videoHash = createHash("sha256").update(DEMO_RECORDING.bytes).digest("hex");
const image = `sample-${imageHash.slice(0, 32)}`;
const video = `sample-${videoHash.slice(0, 32)}`;
const urls = new Map([
  [image, "https://github.com/user-attachments/assets/8cd18b3d-4c7d-469b-bf18-0db749213313"],
  [video, "https://github.com/user-attachments/assets/48ee7ecf-3f02-410d-acb9-047230ab1966"],
]);

type HostedStory = ChangePresentation & { destination: HostedPresentationDestination };

function story(kinds: ("picture" | "recording")[], visibility: "public" | "private"): HostedStory {
  const entries = kinds.map((kind, index) => ({
    asset: kind === "picture" ? image : video,
    ...(kind === "recording" ? { poster: image } : {}),
    alt: `Sample ${kind} ${index + 1}`,
    captureHead: head,
  }));
  return {
    version: 1,
    taskId: "sample",
    revision: 1,
    title: "The selected evidence",
    base: head,
    head,
    destination: {
      host: "github.com",
      projectId: visibility === "public" ? 1422452335 : 1422452416,
      fullName: `kunchenguid/infinitary-evidence-test-${visibility}`,
      visibility,
    },
    why: ["Show every recording without clipping it."],
    whatChanged: ["Recordings stack in both outputs."],
    before: ["The selected earlier views."],
    after: ["The selected current views."],
    views: [
      {
        id: "comparison",
        kind: "changed",
        caption: "The comparison",
        layout: "adjacent",
        before: entries,
        after: entries,
      },
    ],
    verification: ["Read both rendered descriptions."],
    risk: Object.fromEntries(
      RISK_DIMENSIONS.map((dimension) => [
        dimension,
        { level: "low", why: "Harmless renderer fixture." },
      ]),
    ) as RiskDeclaration,
    requiredActions: [],
    unfinished: [],
    projectText: "",
    pictures: [],
    assets: [
      {
        id: image,
        file: `${image}.png`,
        mediaType: "image/png",
        sourceSha256: imageHash,
        uploadSha256: imageHash,
        bytes: posterBytes.length,
        width: DEMO_POSTER.width,
        height: DEMO_POSTER.height,
      },
      {
        id: video,
        file: `${video}.mp4`,
        mediaType: "video/mp4",
        sourceSha256: videoHash,
        uploadSha256: videoHash,
        bytes: DEMO_RECORDING.bytes.length,
        width: DEMO_RECORDING.width,
        height: DEMO_RECORDING.height,
        durationMs: DEMO_RECORDING.durationMs,
      },
    ],
  };
}

function figures(body: string) {
  return DomUtils.findAll((node) => node.name === "figure", parseDocument(body).children);
}
function tables(body: string) {
  return DomUtils.findAll((node) => node.name === "table", parseDocument(body).children).map(
    (table) => ({
      headers: DomUtils.findAll((node) => node.name === "th", table.children).map((th) =>
        DomUtils.getText(th),
      ),
      rows: DomUtils.findAll(
        (node) => node.name === "tr",
        DomUtils.findAll((node) => node.name === "tbody", table.children),
      ).map((tr) =>
        DomUtils.findAll((node) => node.name === "td", tr.children).map(
          (td) => DomUtils.findOne((node) => node.name === "figure", td.children) ?? null,
        ),
      ),
    }),
  );
}
function inGrid(body: string) {
  return DomUtils.findAll(
    (node) => node.attribs.class === "inf-grid",
    parseDocument(body).children,
  );
}

describe("the layout GitHub can actually display", () => {
  // The commit's words come from the saved story, never from its flattened display.
  it("takes the commit words of either story format from the saved story", () => {
    for (const version of [1, 2] as const) {
      const selected = story([], "private");
      selected.version = version;
      selected.whatChanged = [
        "Keep the summary.\nRetain its line break.",
        "Preserve underscore_names.",
      ];
      selected.projectText = "BREAKING CHANGE: The batch owns merges.";
      expect(presentationCommitMessage(selected, BUNDLED_NAMING)).toBe(
        `${selected.whatChanged.join("\n\n")}\n\n${selected.projectText}`,
      );
    }
  });

  it("keeps the squash summary plain and its breaking footer outside the evidence rendering (INF-228 F2)", () => {
    const selected = story(["picture", "recording"], "private");
    selected.whatChanged = [
      "Keep upload_receipts on restart, with paths like work/tasks.",
      "Stack recordings; keep picture pairs.",
    ];
    selected.projectText =
      "Closes #24\n\nBREAKING CHANGE: update the work computer.\nOlder computers cannot prepare this story.\n\nOther project text.";
    const body = presentationMarkdown(selected, urls, "passed");
    expect(body).toContain("<!-- infinitary-story:");
    expect(body).toContain("### Risk");
    const message = presentationCommitMessage(selected, BUNDLED_NAMING);
    expect(message).toBe(
      "Keep upload_receipts on restart, with paths like work/tasks.\n\nStack recordings; keep picture pairs.\n\nBREAKING CHANGE: update the work computer.\nOlder computers cannot prepare this story.",
    );
    expect(message).not.toMatch(/<!--|<table|user-attachments|\\|Dimension|Other project text/);
    expect(presentationCommitMessage({ ...selected, projectText: "" }, BUNDLED_NAMING)).toBe(
      selected.whatChanged.join("\n\n"),
    );
  });
  it.each(["public", "private"] as const)(
    "stacks recording and mixed pairs as bare native URLs for %s projects",
    (visibility) => {
      for (const kinds of [
        ["recording", "recording"],
        ["picture", "recording"],
        ["recording", "picture"],
      ] as const) {
        const selected = story([...kinds], visibility);
        const markdown = presentationMarkdown(selected, urls, "passed");
        const card = presentationCardBody(selected);
        // Bare paragraphs are the form GitHub signs for private media; HTML video sources stay unsigned.
        expect(markdown.split("\n\n").filter((block) => block === urls.get(video))).toHaveLength(
          kinds.filter((kind) => kind === "recording").length * 2,
        );
        expect(
          DomUtils.findAll(
            (node) => node.name === "video" || node.name === "table",
            parseDocument(markdown).children,
          ),
        ).toEqual([]);
        expect(inGrid(card)).toEqual([]);
        expect(figures(card).map((figure) => DomUtils.getText(figure))).toEqual(
          Array(4).fill("The comparison"),
        );
        expect(
          DomUtils.findAll((node) => node.name === "img", parseDocument(card).children).map(
            (node) => node.attribs.alt,
          ),
        ).toEqual(
          selected.views.flatMap((view) =>
            [...view.before, ...view.after].map((entry) => entry.alt),
          ),
        );
      }
    },
  );

  it("keeps picture-only pairs adjacent in both outputs", () => {
    const selected = story(["picture", "picture"], "public");
    const markdown = presentationMarkdown(selected, urls, "passed");
    const card = presentationCardBody(selected);
    const tables = DomUtils.findAll(
      (node) => node.name === "table",
      parseDocument(markdown).children,
    );
    expect(tables).toHaveLength(2);
    expect(
      tables.map((table) => DomUtils.findAll((node) => node.name === "img", table.children).length),
    ).toEqual([2, 2]);
    expect(
      inGrid(card).map(
        (grid) => DomUtils.findAll((node) => node.name === "figure", grid.children).length,
      ),
    ).toEqual([2, 2]);
  });
});

// INF-169 F7: the card viewer reads duration and intrinsic poster size from these attributes.
it("supplies the recording's measured duration and poster dimensions to the card viewer", () => {
  const selected = story(["recording", "recording"], "private");
  const body = presentationCardBody(selected);
  expect(figures(body).map((figure) => Number(figure.attribs["data-inf-demo-duration"]))).toEqual(
    Array(4).fill(DEMO_RECORDING.durationMs),
  );
  const images = DomUtils.findAll((node) => node.name === "img", parseDocument(body).children);
  expect(
    images.map((image) => [Number(image.attribs.width), Number(image.attribs.height)]),
  ).toEqual(Array(4).fill([DEMO_POSTER.width, DEMO_POSTER.height]));
});

// INF-223 / accepted INF-132: gitlab.com plays an image link to an MP4 in its own player,
// and its project-relative upload references resolve inside the merge request's project.
describe("the layout GitLab can actually display", () => {
  const gitlabUrls = new Map([
    [image, "/uploads/66dbcd21ec5d24ed6ea225176098d52b/picture.png"],
    [video, "/uploads/0a1b2c3d4e5f60718293a4b5c6d7e8f9/recording.mp4"],
  ]);
  const onGitLab = (selected: HostedStory): HostedStory => ({
    ...selected,
    destination: {
      host: "gitlab.com",
      projectId: 81234567,
      fullName: "infinitary-labs/infinitary-test/infinitary-evidence-test-private",
      visibility: selected.destination.visibility,
    },
  });

  it("stacks each recording as an image link GitLab turns into its own player", () => {
    for (const kinds of [
      ["recording", "recording"],
      ["picture", "recording"],
      ["recording", "picture"],
    ] as const) {
      const selected = onGitLab(story([...kinds], "private"));
      const blocks = presentationMarkdown(selected, gitlabUrls, "passed").split("\n\n");
      const recordings = selected.views.flatMap((view) =>
        [...view.before, ...view.after].filter((entry) => entry.asset === video),
      );
      expect(blocks.filter((block) => block.includes(gitlabUrls.get(video) as string))).toEqual(
        recordings.map((entry) => `![${entry.alt}](${gitlabUrls.get(video)})`),
      );
      // A bare reference would render as a link, never a player; tables would squeeze it.
      expect(blocks).not.toContain(gitlabUrls.get(video));
      expect(
        DomUtils.findAll(
          (node) => node.name === "video" || node.name === "table",
          parseDocument(blocks.join("\n\n")).children,
        ),
      ).toEqual([]);
      expect(inGrid(presentationCardBody(selected))).toEqual([]);
    }
  });

  it("keeps picture-only pairs adjacent with project-relative references", () => {
    const selected = onGitLab(story(["picture", "picture"], "public"));
    const tables = DomUtils.findAll(
      (node) => node.name === "table",
      parseDocument(presentationMarkdown(selected, gitlabUrls, "passed")).children,
    );
    expect(
      tables.map((table) =>
        DomUtils.findAll((node) => node.name === "img", table.children).map(
          (node) => node.attribs.src,
        ),
      ),
    ).toEqual(Array(2).fill(Array(2).fill(gitlabUrls.get(image))));
  });

  // INF-290 F2: GitLab runs a description line that starts with a quick action when it saves it.
  it("never starts a line with a quick action from the author's words", () => {
    const selected = onGitLab(story(["picture"], "private"));
    selected.why = ["/merge"];
    selected.whatChanged = ["/close the old request"];
    selected.unfinished = ["/approve once checks pass"];
    selected.views = selected.views.map((view) => ({ ...view, caption: "/assign @octo" }));
    const markdown = presentationMarkdown(selected, gitlabUrls, "pending");
    expect(markdown.split("\n").filter((line) => line.startsWith("/"))).toEqual([]);
    // The escape still reads as the author's words once rendered.
    expect(markdown.split("\n\n")).toEqual(
      expect.arrayContaining([
        "\\/merge",
        "\\/close the old request",
        "\\/approve once checks pass",
        "\\/assign @octo",
      ]),
    );
  });

  it("never renders one host's receipt in the other host's story", () => {
    expect(() =>
      presentationMarkdown(onGitLab(story(["picture"], "private")), urls, "pending"),
    ).toThrow(/unconfirmed attachment/);
    expect(() =>
      presentationMarkdown(story(["picture"], "private"), gitlabUrls, "pending"),
    ).toThrow(/unconfirmed attachment/);
  });
});

// INF-467 direction B and the captain's submitted answers: conventional title,
// no rendered code versions, checked facts with folded commands, paired states.
describe("version-two stories read in two tiers", () => {
  function tiered(kinds: ("picture" | "recording")[] = ["picture"]): HostedStory {
    const selected = story(kinds, "private");
    return {
      ...selected,
      version: 2,
      title: "fix(cards): keep recordings whole",
      checked: [{ check: "Recording", result: "Both players remain whole." }],
      verification: ["Opened both native players and compared their full frames."],
      views: selected.views.map((view) => ({
        ...view,
        layout: undefined,
        after: view.after.map((entry) => ({
          ...entry,
          applicability: `Still applies from ${head}.`,
        })),
      })),
    };
  }
  it("pairs each view's two states and folds commands without printing version data or empty boilerplate", () => {
    const selected = tiered();
    const card = presentationCardBody(selected);
    const body = presentationMarkdown(selected, urls, "pending");
    const document = parseDocument(card);
    // INF-706: Before and After head the table's columns, never a label under a picture.
    const [table] = tables(card);
    expect(table?.headers).toEqual(["Before", "After"]);
    expect(table?.rows.map((row) => row.map((figure) => Boolean(figure)))).toEqual([[true, true]]);
    expect(DomUtils.findAll((node) => node.name === "figcaption", document.children)).toEqual([]);
    const details = DomUtils.findAll((node) => node.name === "details", document.children);
    expect(details).toHaveLength(1);
    const detail = details[0];
    if (!detail) throw new Error("Missing command fold");
    expect(DomUtils.getText(detail)).toContain(selected.verification[0]);
    expect(details[0]?.attribs.open).toBeUndefined();
    const checks = DomUtils.findAll((node) => node.name === "li", document.children);
    expect(checks.map((item) => DomUtils.getText(item))).toContain(
      "✓ Recording: Both players remain whole.",
    );
    expect(body).toContain("- [x] Recording: Both players remain whole\\.");
    expect(body).toContain("<th>Before</th><th>After</th>");
    expect(body).toContain("<summary>Full risk assessment</summary>");
    expect(body).toContain("Risk: low in every dimension");
    for (const rendered of [card, body]) {
      expect(rendered).not.toContain(head);
      expect(rendered).not.toMatch(
        /Story 1|Evidence applicability|Checks are pending|Nothing remains|Required actions|Not done/,
      );
    }
    expect(body).toBe(presentationMarkdown(selected, urls, "passed"));
  });
  // INF-706: the captain's answer puts a recording's poster and Play button in the card's table.
  it("tables recordings on the card, stacks them in the pull request, heads new views New, and retains substantive unfinished work in a fold", () => {
    const selected = tiered(["picture", "recording"]);
    selected.unfinished = ["Continue: inspect playback starts once this is merged."];
    const card = presentationCardBody(selected);
    const body = presentationMarkdown(selected, urls, "passed");
    // Each row pairs the matching entries: the picture beside the picture, the recording beside the recording.
    expect(
      tables(card)[0]?.rows.map((row) => row.map((figure) => figure?.attribs["data-inf-demo"])),
    ).toEqual([
      [undefined, undefined],
      [`app-frame://media/${video}.mp4`, `app-frame://media/${video}.mp4`],
    ]);
    expect(body).not.toContain("<table>");
    expect(body.split("\n\n").filter((block) => block === urls.get(video))).toHaveLength(2);
    expect(card).toContain("<summary>Not done</summary>");
    expect(body).toContain("<summary>Not done</summary>");
    const view = selected.views[0];
    if (!view) throw new Error("Missing selected view");
    view.kind = "new";
    view.before = [];
    const fresh = presentationCardBody(selected);
    // A new view's own table is headed New; its caption keeps no New of its own to cover.
    expect(tables(fresh).map((table) => table.headers)).toEqual([["New"]]);
    expect(tables(fresh)[0]?.rows.map((row) => row.length)).toEqual([1, 1]);
    expect(DomUtils.getText(parseDocument(fresh))).not.toContain("New: ");
    expect(presentationMarkdown(selected, urls, "passed")).toContain("### New: The comparison");
  });
  it("names only raised risk dimensions in the open line and preserves GitLab's native media and inert prose", () => {
    const selected = tiered(["recording"]);
    selected.destination.host = "gitlab.com";
    selected.risk.behavior = { level: "medium", why: "Adds an optional comparison." };
    selected.checked = [{ check: "/merge", result: "This remains text." }];
    const receipt = new Map([
      [image, `/uploads/${"a".repeat(32)}/picture.png`],
      [video, `/uploads/${"b".repeat(32)}/recording.mp4`],
    ]);
    const body = presentationMarkdown(selected, receipt, "passed");
    const openRisk = body.split("### Risk\n\n")[1]?.split("<details>")[0];
    expect(openRisk).toContain("Behavior, medium");
    expect(openRisk).not.toContain("Dependencies");
    expect(body).toContain(`![Sample recording 1](${receipt.get(video)})`);
    expect(body).toContain("- [x] \\/merge:");
    expect(body).not.toMatch(/^\/merge/m);
  });
});

// INF-497 (the captain on INF-100's PR #138): correct only the words around a
// published story and leave the story itself unchanged.
describe("the words around a published story", () => {
  const task = "ab12cd34";
  const { start, end } = presentationRegionMarkers(task);
  const region = `${start}\n## Why\n\nThe story the captain approved.\n${end}`;
  const obsolete =
    "This first publication advances the published protocol to 9.0.0. One Linux integration failure remains open and is tracked separately.";
  const corrected =
    "The published protocol advances to 10.0.0; every check on this version passed.";
  const footer = "BREAKING CHANGE: The published protocol advances to 10.0.0.";
  const body = `${obsolete}\n\n${footer}\n\n${region}\n\nA person's closing note.`;

  it("replaces one exact passage in place and keeps the story byte for byte", () => {
    const above = replaceAroundPresentation(body, { from: obsolete, to: corrected }, task, false);
    expect(above).toBe(`${corrected}\n\n${footer}\n\n${region}\n\nA person's closing note.`);
    expect(readPresentationRegion(above, task)).toBe(region);
    const below = replaceAroundPresentation(
      body,
      { from: "A person's closing note.", to: "Closes #24" },
      task,
      false,
    );
    expect(below).toBe(`${obsolete}\n\n${footer}\n\n${region}\n\nCloses #24`);
    // The new words are text: a replacement pattern is never expanded.
    expect(
      replaceAroundPresentation(body, { from: "9.0.0", to: "$& and $1" }, task, false),
    ).toContain("protocol to $& and $1.");
  });

  it("sends nothing for a passage someone changed since it was read, and quotes what is there now", () => {
    const edited = body.replace(obsolete, "The captain's own sentence.");
    expect(() =>
      replaceAroundPresentation(edited, { from: obsolete, to: corrected }, task, false),
    ).toThrow(PresentationAroundError);
    expect(() =>
      replaceAroundPresentation(edited, { from: obsolete, to: corrected }, task, false),
    ).toThrow(/no longer hold around\.from exactly[\s\S]*The captain's own sentence\./);
  });

  it("refuses a passage that names more than one place, and never reaches into the story", () => {
    const twice = `${footer}\n\n${region}\n\n${footer}`;
    expect(() => replaceAroundPresentation(twice, { from: footer, to: "" }, task, false)).toThrow(
      /appears 2 times/,
    );
    expect(() =>
      replaceAroundPresentation(
        body,
        { from: "The story the captain approved.", to: "" },
        task,
        false,
      ),
    ).toThrow(/no longer hold around\.from/);
  });

  it("adds words with an empty passage only when nothing surrounds the story", () => {
    expect(replaceAroundPresentation(region, { from: "", to: footer }, task, false)).toBe(
      `${footer}\n\n${region}`,
    );
    expect(() => replaceAroundPresentation(body, { from: "", to: footer }, task, false)).toThrow(
      /Name the passage you change/,
    );
    expect(() =>
      replaceAroundPresentation(
        `${obsolete}\n\n${start}`,
        { from: obsolete, to: corrected },
        task,
        false,
      ),
    ).toThrow(/markers are missing or duplicated/);
  });

  // INF-290 F2: GitLab runs a line that starts with a quick action; only the captain's click merges.
  it("never starts a line of the new words with a quick action on GitLab", () => {
    const to = `${corrected}\n/merge\n  /close`;
    const gitlab = replaceAroundPresentation(body, { from: obsolete, to }, task, true);
    expect(gitlab.split("\n").filter((line) => line.trimStart().startsWith("/"))).toEqual([]);
    expect(gitlab).toContain(`${corrected}\n\\/merge\n  \\/close`);
    expect(replaceAroundPresentation(body, { from: obsolete, to }, task, false)).toContain(to);
  });
});
