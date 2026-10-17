import { createHash } from "node:crypto";
import type { ChangePresentation } from "@shared/changePresentation";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { DEMO_POSTER, DEMO_RECORDING } from "../../../tests/e2e/demoFixtures";
import {
  presentationCardBody,
  presentationCommitMessage,
  presentationMarkdown,
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

function story(
  kinds: ("picture" | "recording")[],
  visibility: "public" | "private",
): ChangePresentation {
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
function inGrid(body: string) {
  return DomUtils.findAll(
    (node) => node.attribs.class === "inf-grid",
    parseDocument(body).children,
  );
}

describe("the layout GitHub can actually display", () => {
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
    const message = presentationCommitMessage(selected);
    expect(message).toBe(
      "Keep upload_receipts on restart, with paths like work/tasks.\n\nStack recordings; keep picture pairs.\n\nBREAKING CHANGE: update the work computer.\nOlder computers cannot prepare this story.",
    );
    expect(message).not.toMatch(/<!--|<table|user-attachments|\\|Dimension|Other project text/);
    expect(presentationCommitMessage({ ...selected, projectText: "" })).toBe(
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
