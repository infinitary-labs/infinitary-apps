import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { presentationCardBody } from "../../src/core/forge/presentation";
import { stageChangePresentation } from "../../src/core/pi/changePresentation";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import type { ChangePresentation } from "../../src/shared/changePresentation";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot, regionShot } from "./pictures";
import { MOCK_GITHUB_STORY } from "./scenarios/changeStory";
import { showCard, shownCard } from "./stack";

const TITLE = "fix(cards): compare each view in one place";
const CAPTION = "The reply view in two themes";

/**
 * INF-467 direction B: the two real card pictures remain whole and share one
 * caption, with the earlier state beside the result. A local hidden window,
 * disposable HOME and userData, no sign-in, and no shared resource.
 * Publication itself is owned by forge-signin.spec.ts; this owns the layout.
 */
test("a saved story pairs the states of each view and preserves the old drawing", async () => {
  const pictureDir = process.env.INFINITARY_STORY_PICTURES;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  for (const version of [1, 2] as const) {
    const userDataDir = scratchDir("infinitary-story-layout-");
    const taskId = "story-layout";
    const dir = join(userDataDir, "crewmates", taskId, "cards");
    mkdirSync(dir, { recursive: true });
    const { noPicture: _invisible, ...content } = MOCK_GITHUB_STORY;
    const staged = await stageChangePresentation(
      {
        ...content,
        title: TITLE,
        base: head,
        head,
        publishable: true,
        why: ["The reply view should be easy to compare in both themes."],
        whatChanged: ["Each changed view keeps its two states together."],
        before: ["The earlier views sat above the results."],
        after: ["Each view shows its earlier state beside the result."],
        checked: [{ check: "Reply view", result: "Both pictures remain whole." }],
        verification: ["Compared both complete reply-view pictures in the isolated app."],
        views: [
          {
            id: "footer",
            kind: "changed",
            caption: CAPTION,
            before: [
              {
                path: "release-notes/pictures/action-reply-line-dark.webp",
                alt: "The reply view in the dark theme",
                inspected: true,
                captureHead: head,
              },
            ],
            after: [
              {
                path: "release-notes/pictures/action-reply-line-light.webp",
                alt: "The reply view in the light theme",
                inspected: true,
                captureHead: head,
              },
            ],
          },
        ],
      },
      { taskId, worktree: process.cwd(), dir },
    );
    const story: ChangePresentation = {
      ...staged,
      version,
      taskId,
      revision: 1,
      destination: {
        host: "github.com",
        projectId: 1,
        fullName: "octo/meterlab",
        visibility: "private",
      },
    };
    const db = openDatabase(userDataDir);
    try {
      new CardStore(db).upsert({
        id: "story-layout-card",
        title: TITLE,
        author: "firstmate",
        meta: "firstmate",
        priority: 20,
        status: "ready",
        createdAt: Date.now(),
        body: presentationCardBody(story),
        pictures: story.pictures,
        actions: [],
      });
    } finally {
      db.close();
    }
    const launched = await launchApp({ userDataDir, withMockProvider: true });
    try {
      const { app, page } = launched;
      await resizeWindow(app, page, { width: 1280, height: 1800 });
      await showCard(page, TITLE);
      const body = cardBody(page, TITLE);
      const images = body.locator("img");
      await expect(images).toHaveCount(2);
      await expect
        .poll(() =>
          images.evaluateAll((nodes) =>
            nodes.every((node) => (node as HTMLImageElement).naturalWidth > 0),
          ),
        )
        .toBe(true);
      const boxes = await images.evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().toJSON()),
      );
      const [before, after] = boxes;
      if (!before || !after) throw new Error("Missing comparison pictures");
      if (version === 2) {
        expect(before.x + before.width).toBeLessThanOrEqual(after.x);
        expect(before.y).toBe(after.y);
        await expect(body.getByText(CAPTION, { exact: true })).toHaveCount(1);
      } else expect(before.y + before.height).toBeLessThanOrEqual(after.y);
      if (pictureDir) {
        // Version 1 is the unchanged legacy renderer, reproduced after implementation.
        const section = version === 2 ? body.locator("section") : body.locator("body");
        await regionShot(
          section,
          join(pictureDir, version === 1 ? "paired-legacy-reproduction.png" : "paired-after.png"),
        );
      }
      if (version === 2 && process.env.INFINITARY_STORY_HERO) {
        const hero = await heroShot(page, {
          region: shownCard(page, TITLE),
          name: "two-tier-change-stories",
        });
        writeFileSync(test.info().outputPath("hero.json"), JSON.stringify(hero));
      }
    } finally {
      await launched.close();
    }
  }
});
