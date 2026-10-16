import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { startDemo } from "./demo";
import { demoEncoder, runEncoder } from "./demoEncoder";
import { windowShot } from "./pictures";
import { pressKey } from "./windowKeys";

/** Decode actual output pixels, not just the media header or manifest. */
async function pixels(file: string, crop?: string): Promise<Buffer> {
  const raw = join(scratchDir("infinitary-demo-pixels-"), "frame.rgb");
  runEncoder(await demoEncoder(), [
    "-i",
    file,
    ...(crop ? ["-vf", crop] : []),
    "-frames:v",
    "1",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    raw,
  ]);
  return readFile(raw);
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("a still view held past the old recorder's keyframe interval shows no one-frame flash", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const demo = await startDemo({ withMockProvider: true, size: { width: 1280, height: 800 } });
  const { page } = demo.launched;
  try {
    // Covers the window with a dark gradient and glow: the kind of view a
    // starved keyframe or a low bit rate turns grey and blocky.
    await page.evaluate(() => {
      const scene = document.createElement("div");
      scene.id = "still-scene";
      scene.style.cssText =
        "position:fixed;inset:0;z-index:99999;background:radial-gradient(circle at 50% 40%,rgb(70,60,120),rgb(10,12,24) 60%,rgb(2,2,6))";
      document.body.append(scene);
    });
    // Long enough to cross Playwright's WebM keyframe (every 5.12 s) twice.
    await demo.record("A still view", "window", () => page.waitForTimeout(11_500));
    const files = await demo.finish({
      dir: testInfo.outputPath("demo"),
      name: "still",
      format: "mp4",
    });
    const stats = join(scratchDir("infinitary-demo-luma-"), "luma.txt");
    runEncoder(await demoEncoder(), [
      ...["-i", files.recording],
      ...["-vf", `signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${stats}`],
      ...["-f", "null", "-"],
    ]);
    const luma = [...(await readFile(stats, "utf8")).matchAll(/YAVG=([\d.]+)/g)].map((match) =>
      Number(match[1]),
    );
    expect(luma.length).toBeGreaterThan(24 * 10);
    // Nothing moves, so no frame's average brightness may jump from the one before it.
    const jumps = luma.slice(1).map((value, at) => Math.abs(value - (luma[at] ?? value)));
    expect(Math.max(...jumps)).toBeLessThan(0.05);
  } finally {
    await demo.launched.close();
  }
});

for (const format of ["mp4", "gif"] as const) {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
  test(`a fresh-launch ${format} demo keeps the drawn start view and paced keyboard states`, async ({}, testInfo) => {
    test.setTimeout(180_000);
    const demo = await startDemo({ withMockProvider: true, size: { width: 1280, height: 800 } });
    const { page } = demo.launched;
    try {
      // A recorder fixture, not a product layout assertion: distinctive corners,
      // a reveal, and key-driven states let the encoded files prove what was captured.
      await page.evaluate(() => {
        const scene = document.createElement("div");
        scene.id = "recorder-scene";
        scene.tabIndex = 0;
        scene.style.cssText =
          "position:fixed;left:40px;top:40px;width:640px;height:320px;z-index:99999;background:rgb(200,40,60)";
        const corner = document.createElement("div");
        corner.style.cssText =
          "position:absolute;right:0;bottom:0;width:80px;height:80px;background:rgb(40,180,80)";
        scene.append(corner);
        scene.addEventListener("keydown", () => {
          scene.dataset.state = scene.dataset.state === "one" ? "two" : "one";
          scene.style.background =
            scene.dataset.state === "one" ? "rgb(40,80,200)" : "rgb(220,180,40)";
        });
        document.body.append(scene);
        scene.animate([{ transform: "scale(0.5)" }, { transform: "scale(1)" }], { duration: 180 });
      });
      const scene = page.locator("#recorder-scene");
      const reference = testInfo.outputPath("demo", "start-reference.png");
      await demo.record("Two paced keyboard states after launch", scene, async () => {
        await windowShot(page, reference);
        await demo.step(async () => {
          await pressKey(scene, "ArrowRight");
          await expect(scene).toHaveAttribute("data-state", "one");
        });
        await demo.step(async () => {
          await pressKey(scene, "ArrowRight");
          await expect(scene).toHaveAttribute("data-state", "two");
        });
      });
      const files = await demo.finish({
        dir: testInfo.outputPath("demo"),
        name: `fresh-${format}`,
        format,
      });
      const image = await pixels(files.poster);
      const baseline = await pixels(reference, "crop=640:320:40:40");
      const sample = (x: number, y: number) => [
        ...image.subarray((y * files.width + x) * 3, (y * files.width + x) * 3 + 3),
      ];
      // Chromium's display profile and encoding can shift channels; these
      // distinctive colors still separate a drawn fixture from a blank or partial view.
      const near = (actual: number[], expected: number[]) =>
        expected.every((channel, i) => Math.abs((actual[i] ?? 0) - channel) < 12);
      for (const [x, y] of [
        [20, 20],
        [files.width - 20, files.height - 20],
      ] as const) {
        const at = (y * files.width + x) * 3;
        expect(near(sample(x, y), [...baseline.subarray(at, at + 3)])).toBe(true);
      }
      // The recording itself must contain both intermediate results, not just a valid poster.
      const frames = join(scratchDir("infinitary-demo-states-"), "states.rgb");
      runEncoder(await demoEncoder(), [
        "-i",
        files.recording,
        "-vf",
        "crop=2:2:20:20,scale=1:1,format=rgb24",
        "-f",
        "rawvideo",
        frames,
      ]);
      const states = await readFile(frames);
      for (const expected of [
        [40, 80, 200],
        [220, 180, 40],
      ]) {
        let count = 0;
        for (let at = 0; at < states.length; at += 3) {
          if (expected.every((channel, i) => Math.abs((states[at + i] ?? 0) - channel) < 35))
            count++;
        }
        // Half a second deliberately displayed: several encoded frames in either format.
        expect(count).toBeGreaterThanOrEqual(3);
      }
      expect(JSON.parse(await readFile(files.manifest, "utf8"))).toMatchObject({
        poster: { frame: "start", source: "recording" },
      });
    } finally {
      await demo.launched.close();
    }
  });
}
