import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CdpPipe } from "./cdpPipe";

// Chrome's pipe hands its messages over in whatever pieces the operating
// system reads: a picture's answer arrives across many reads, and a burst of
// events can share one. The pipe must put each message back whole.
function connected() {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const sent: string[] = [];
  toChrome.on("data", (chunk: Buffer) => sent.push(chunk.toString("utf8")));
  return { pipe: new CdpPipe(toChrome, fromChrome), fromChrome, sent };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("Chrome's private pipe", () => {
  it("frames each command with a zero byte and puts answers and events back together however they are read", async () => {
    const { pipe, fromChrome, sent } = connected();
    const events: string[] = [];
    pipe.on((method, _params, sessionId) => events.push(`${method}@${sessionId}`));
    const answer = pipe.send("Page.captureScreenshot", { format: "png" }, "S1");
    await tick();
    expect(sent.join("")).toBe(
      `${JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" }, sessionId: "S1" })}\0`,
    );
    const whole = `${JSON.stringify({ id: 1, result: { data: "iVBORw0KGgo".repeat(2000) }, sessionId: "S1" })}\0`;
    const burst = `${JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" })}\0${JSON.stringify({ method: "Target.targetDestroyed", params: { targetId: "T" } })}\0`;
    fromChrome.write(whole.slice(0, 7));
    fromChrome.write(whole.slice(7, 9000));
    fromChrome.write(whole.slice(9000) + burst);
    expect(await answer).toEqual({ data: "iVBORw0KGgo".repeat(2000) });
    await tick();
    expect(events).toEqual(["Page.loadEventFired@S1", "Target.targetDestroyed@undefined"]);
  });

  it("fails a refused command with Chrome's reason, and every waiting one once Chrome is gone", async () => {
    const { pipe, fromChrome } = connected();
    const refused = pipe.send("Browser.getWindowForTarget", { targetId: "gone" });
    const waiting = pipe.send("Browser.getVersion");
    fromChrome.write(
      `${JSON.stringify({ id: 1, error: { code: -32000, message: "No target with given id" } })}\0`,
    );
    await expect(refused).rejects.toThrow("No target with given id");
    fromChrome.end();
    fromChrome.destroy();
    await expect(waiting).rejects.toThrow("Chrome is gone");
    await expect(pipe.send("Browser.getVersion")).rejects.toThrow("Chrome is gone");
  });
});
