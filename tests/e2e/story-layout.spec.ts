import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
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
import { showCard } from "./stack";

const TITLE = "fix(cards): compare each view in one place";
const CAPTION = "The reply view in two themes";
const NEW_CAPTION = "The choice keys in two themes";

/**
 * INF-467 direction B, and INF-706's approved table (the captain: "a table
 * format may work better, and before/after would be in the table header"):
 * real release-note pictures, two per state, stay whole; each view's caption
 * sits above its table, Before and After head their own columns, matching
 * pictures share a row, and a new view's table is headed New. A local hidden
 * window, disposable HOME and userData, no sign-in, and no shared resource.
 * Publication itself is owned by forge-signin.spec.ts; this owns the layout.
 */
test("a saved story pairs the states of each view and preserves the old drawing", async () => {
  const pictureDir = process.env.INFINITARY_STORY_PICTURES;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const shown = (name: string, theme: string) => ({
    path: `release-notes/pictures/${name}.webp`,
    alt: `${name.replaceAll("-", " ")} in the ${theme} theme`,
    inspected: true as const,
    captureHead: head,
  });
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
            id: "reply",
            kind: "changed",
            caption: CAPTION,
            before: [
              shown("action-reply-line-dark", "dark"),
              shown("action-reply-line-light", "light"),
            ],
            after: [
              shown("anything-else-box-dark", "dark"),
              shown("anything-else-box-light", "light"),
            ],
          },
          {
            id: "keys",
            kind: "new",
            caption: NEW_CAPTION,
            layout: "adjacent",
            before: [],
            after: [
              shown("card-choice-keys-dark", "dark"),
              shown("card-choice-keys-light", "light"),
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
      await expect(images).toHaveCount(6);
      await expect
        .poll(() =>
          images.evaluateAll((nodes) =>
            nodes.every((node) => (node as HTMLImageElement).naturalWidth > 0),
          ),
        )
        .toBe(true);
      if (pictureDir) {
        // Version 1 is the unchanged legacy renderer, reproduced after implementation.
        await regionShot(
          body.locator("body"),
          join(pictureDir, version === 1 ? "paired-legacy-reproduction.png" : "paired-after.png"),
        );
      }
      if (version === 1) {
        const boxes = await images.evaluateAll((nodes) =>
          nodes.map((node) => node.getBoundingClientRect().toJSON()),
        );
        const [before, after] = boxes;
        if (!before || !after) throw new Error("Missing comparison pictures");
        expect(before.y + before.height).toBeLessThanOrEqual(after.y);
      } else {
        // Each view: its caption, then a table whose header cells sit over their own pictures.
        const placed = async (target: Locator) => {
          const box = await target.boundingBox();
          if (!box) throw new Error("A part of the view is not drawn");
          return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
        };
        const tables = body.getByRole("table");
        await expect(tables).toHaveCount(2);
        const views = await Promise.all(
          [CAPTION, NEW_CAPTION].map(async (text, index) => {
            const table = tables.nth(index);
            const headers = table.getByRole("columnheader");
            const rows = table.getByRole("row").filter({ has: body.getByRole("cell") });
            return {
              caption: { text, box: await placed(body.getByText(text, { exact: true })) },
              headers: await Promise.all(
                (await headers.all()).map(async (header) => ({
                  text: await header.textContent(),
                  box: await placed(header),
                })),
              ),
              rows: await Promise.all(
                (await rows.all()).map((row) =>
                  row
                    .getByRole("img")
                    .all()
                    .then((pictures) => Promise.all(pictures.map(placed))),
                ),
              ),
              labels: await table.locator("figcaption").count(),
            };
          }),
        );
        expect(views.map((view) => view.caption?.text)).toEqual([CAPTION, NEW_CAPTION]);
        expect(views.map((view) => view.headers.map((header) => header.text))).toEqual([
          ["Before", "After"],
          ["New"],
        ]);
        expect(views.map((view) => view.labels)).toEqual([0, 0]);
        const [changed, fresh] = views;
        if (!changed || !fresh) throw new Error("Missing a view");
        expect(changed.rows).toHaveLength(2);
        for (const view of views) {
          const headerBottom = Math.max(...view.headers.map((header) => header.box.bottom));
          const captionBottom = view.caption?.box.bottom ?? Number.POSITIVE_INFINITY;
          // The caption ends before the header starts, so no header or tag covers it.
          for (const header of view.headers)
            expect(captionBottom).toBeLessThanOrEqual(header.box.top);
          for (const row of view.rows) {
            const [left, right] = row;
            if (!left || !right) throw new Error("A row is missing a picture");
            // Matching pictures share a row, left beside right, below the header.
            expect(left.top).toBe(right.top);
            expect(left.right).toBeLessThanOrEqual(right.left);
            expect(headerBottom).toBeLessThanOrEqual(left.top);
          }
        }
        // Before heads the left column and After the right one.
        const [beforeHeader, afterHeader] = changed.headers;
        if (!beforeHeader || !afterHeader) throw new Error("Missing a header");
        for (const [left, right] of changed.rows) {
          if (!left || !right) throw new Error("A row is missing a picture");
          for (const [picture, header] of [
            [left, beforeHeader],
            [right, afterHeader],
          ] as const) {
            expect(picture.left).toBeGreaterThanOrEqual(header.box.left);
            expect(picture.right).toBeLessThanOrEqual(header.box.right);
          }
        }
      }
      if (version === 2 && process.env.INFINITARY_STORY_HERO) {
        const hero = await heroShot(page, {
          region: body.locator("section").first(),
          name: "before-after-table-on-merge-cards",
        });
        writeFileSync(test.info().outputPath("hero.json"), JSON.stringify(hero));
      }
    } finally {
      await launched.close();
    }
  }
});
