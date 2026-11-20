import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cardPictureUrl } from "@shared/cardPictures";
import type { Card } from "@shared/cards";
import type { ChangePresentation } from "@shared/changePresentation";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { describe, expect, it } from "vitest";
import story from "../../../tests/fixtures/card-revisions/inf-1595-story.json";
import { projectFontBytes } from "../../../tests/helpers/fontFixture";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { tieredPresentationCardBody } from "../forge/presentationTiers";
import { verifyCardImages } from "../pi/cardImages";
import { resolveRevisionTargets, revisionLinks } from "./cardNavigation";

const card = (body: string, extra: Partial<Card> = {}): Card => ({
  id: "c",
  lifecycleId: "life",
  offerId: "v",
  title: "Review",
  body,
  actions: [],
  author: "firstmate",
  status: "ready",
  meta: "",
  priority: 1,
  createdAt: 1,
  ...extra,
});
const steady = "<h2>Context</h2><p>One</p><p>Two</p><p>Three</p><p>Four</p>";
const links = (a: string, b: string) => revisionLinks(card(a), card(b))!;
describe("revision destinations", () => {
  it("groups changes by heading in document order independently of the seen baseline", () => {
    const a = `${steady}<h2>Sign-in</h2><p>Old</p><h2>Checks</h2><p>Before</p>`;
    const b = a.replace("Old", "Connected");
    const c = b.replace("Before", "Checked");
    expect(links(a, b).targets.map((t) => t.label)).toEqual(["Sign-in"]);
    expect(links(b, c).targets.map((t) => t.label)).toEqual(["Checks"]);
    expect(links(a, c).targets.map((t) => t.label)).toEqual(["Sign-in", "Checks"]);
  });
  it("includes headings, title and choices without pretending removed content has a target", () => {
    const a = card(`${steady}<h2>Old</h2><p>Keep</p>`);
    const b = card(`${steady}<h2>New</h2><p>Keep</p>`, {
      title: "New title",
      actions: [{ id: "go", label: "Go" }],
    });
    expect(revisionLinks(a, b)?.targets.map((t) => [t.label, t.region])).toEqual([
      ["Title", "title"],
      ["New", "body"],
      ["Buttons", "buttons"],
    ]);
    expect(links(`${steady}<p>Gone</p>`, steady)).toMatchObject({ targets: [], removed: 1 });
  });
  it("numbers unheaded changes and repeated headings, and bounds rewrite and preview precision", () => {
    expect(
      links("<p>Keep</p><p>Keep too</p>", "<p>Keep</p><p>Keep too</p><p>New</p>").targets[0]?.label,
    ).toBe("Change 1");
    expect(
      links(steady, `${steady}<h2>Checks</h2><p>A</p><h2>Checks</h2><p>B</p>`).targets.map(
        (t) => t.label,
      ),
    ).toEqual(["Checks 1", "Checks 2"]);
    expect(links("<p>A</p>", "<p>B</p><p>C</p><p>D</p>").targets[0]?.label).toBe("Whole card");
    expect(links(steady, `${steady}<style>p{color:red}</style>`).targets[0]?.label).toBe(
      "Preview updated",
    );
    expect(links(steady, `${steady}${"<p>Same</p>".repeat(513)}`).targets).toHaveLength(1);
  });
  it("names the sections of a card whose lines were reworded, never Whole card (INF-1623)", () => {
    // INF-1595's story revisions 2 and 3: one new bullet under What changed
    // answered the captain, and thirteen lines were reworded from delete to
    // retire, so the line read Whole card and 13 parts removed.
    const risk = Object.fromEntries(
      RISK_DIMENSIONS.map((dimension) => [dimension, { level: "low", why: "Fixture." }]),
    ) as RiskDeclaration;
    const body = (revision: (typeof story.revisions)[number]) =>
      tieredPresentationCardBody({
        version: 2,
        taskId: "81a74948",
        revision: 1,
        destination: { host: "github.com", projectId: 1, fullName: "o/r", visibility: "private" },
        base: "a".repeat(40),
        head: "a".repeat(40),
        views: [],
        risk,
        requiredActions: [],
        projectText: "",
        assets: [],
        pictures: [],
        ...revision,
      } as ChangePresentation);
    const [before, after] = story.revisions.map(body) as [string, string];
    const result = links(before, after);
    expect(result.targets.map((target) => target.label)).toEqual([
      "What changed",
      "Before and after",
      "Checked",
    ]);
    expect(result.removed).toBe(0);
  });
  it("prefers a surviving original part then the same area's heading, never a missing or ambiguous area", () => {
    const a = card(`${steady}<h2>Checks</h2><p>Old</p>`);
    const b = card(a.body.replace("Old", "New"));
    const targets = revisionLinks(a, b)!.targets;
    const c = card(`<p>Intro</p>${b.body}`);
    expect(resolveRevisionTargets(targets, [b, c])[0]?.start).toBe(c.body.indexOf("<p>New"));
    const d = card(c.body.replace("New", "Latest"));
    expect(resolveRevisionTargets(targets, [b, c, d])[0]?.start).toBe(d.body.indexOf("<h2>Checks"));
    expect(resolveRevisionTargets(targets, [b, card(steady), d])).toEqual([]);
    expect(resolveRevisionTargets(targets, [b, card(d.body.replace("Checks", "Renamed"))])).toEqual(
      [],
    );
    expect(
      resolveRevisionTargets(targets, [b, card(`${d.body}<h2>Checks</h2><p>Again</p>`)]),
    ).toEqual([]);
  });
  it("carries a unique stable area id through a rename but refuses duplicates", () => {
    const a = card(`${steady}<h2 id='checks'>Old heading</h2><p>Old</p>`);
    const b = card(a.body.replace("<p>Old", "<p>New"));
    const targets = revisionLinks(a, b)!.targets;
    const c = card(b.body.replace("Old heading", "New heading"));
    expect(resolveRevisionTargets(targets, [b, c])).toHaveLength(1);
    expect(
      resolveRevisionTargets(targets, [b, card(`${c.body}<h2 id='checks'>Other</h2>`)]),
    ).toEqual([]);
  });
  it("compares verified picture bytes, not random copy names", () => {
    const media = (id: string, sha: string) =>
      card(`${steady}<h2>Picture</h2><img src='${cardPictureUrl(id, "png")}' alt='Result'>`, {
        pictures: [
          { id, sha256: sha.repeat(64), alt: "Result", width: 100, height: 100, group: 0 },
        ],
      });
    const a = media(`task-${"a".repeat(32)}`, "a"),
      b = media(`task-${"b".repeat(32)}`, "a"),
      c = media(`task-${"c".repeat(32)}`, "b");
    expect(revisionLinks(a, b)?.targets).toEqual([]);
    expect(revisionLinks(b, c)?.targets.map((t) => t.label)).toEqual(["Picture"]);
  });
  it("keeps large unchanged bodies quiet and counts a removal without a fabricated target", () => {
    const large = Array.from({ length: 513 }, (_, i) => `<p>Part ${i}</p>`).join("");
    expect(links(large, large).targets).toEqual([]);
    const result = links(`${steady}<p>Removed</p>`, steady);
    expect(result.targets).toEqual([]);
    expect(result.removed).toBe(1);
  });
  it("names unheaded edits, actual chrome changes, and interactive fallbacks", () => {
    expect(
      links("<p>One</p><p>Two</p><p>Three</p>", "<p>One</p><p>Edited</p><p>Three</p>").targets[0]
        ?.label,
    ).toBe("Change 1");
    const a = card(steady),
      b = card(steady, {
        title: "New title",
        actions: [{ id: "go", label: "Continue", default: true }],
      });
    expect(revisionLinks(a, b)?.targets.map((t) => t.region)).toEqual(["title", "buttons"]);
    const preview = card(`${steady}<script>document.body.dataset.state='one'</script>`);
    const updated = card(preview.body.replace("'one'", "'two'"));
    const targets = revisionLinks(preview, updated)?.targets ?? [];
    expect(targets.map((t) => t.label)).toEqual(["Preview updated"]);
    expect(resolveRevisionTargets(targets, [updated, card(steady)])).toEqual([]);
    expect(
      links(
        `<style>p{color:red}</style><div>${steady}</div>`,
        `<style>p{color:red}</style><div><p>Four</p><p>Three</p><p>Two</p><p>One</p><h2>Context</h2></div>`,
      ).targets,
    ).toEqual([]);
  });
  it("falls back to normalized copy names when a saved picture predates digests", () => {
    const image = (id: string, verified: boolean) =>
      card(`${steady}<img src='${cardPictureUrl(id, "png")}'>`, {
        pictures: [
          {
            id,
            ...(verified ? { sha256: "a".repeat(64) } : {}),
            alt: "",
            width: 10,
            height: 10,
            group: 0,
          },
        ],
      });
    expect(
      revisionLinks(image(`task-${"a".repeat(32)}`, false), image(`task-${"b".repeat(32)}`, true))
        ?.targets,
    ).toEqual([]);
  });
});

// INF-145's review: every emit kept a font preview's font under a fresh name,
// so a revision that changed only its title or buttons read as "Preview updated".
describe("a font preview's revisions", () => {
  it("marks only the title when only the title changed, as the host writes both versions", async () => {
    const base = scratchDir("fm-card-navigation-fonts-");
    const worktree = join(base, "worktree");
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "face.woff2"), projectFontBytes());
    const root = {
      worktree,
      dir: join(base, "crewmates", "t1", "cards"),
      taskId: "t1",
      typefaceProbe: async (typefaces: readonly unknown[]) =>
        typefaces.map(() => ({ ok: true as const })),
    };
    const written =
      '<p>The balance screen.</p><style>@font-face{font-family:"Wallet";src:url("face.woff2")}.b{font-family:"Wallet"}</style><p class="b">$42.50</p>';
    const first = await verifyCardImages(written, root);
    const second = await verifyCardImages(written, root);
    const targets = revisionLinks(
      card(first.body),
      card(second.body, { offerId: "w", title: "Review, renamed" }),
    )?.targets;
    expect(targets?.map((target) => target.label)).toEqual(["Title"]);
  });
});
