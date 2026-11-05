import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhoneWebProcess } from "./helpers/phoneStacks";
import { capturePhoneWebStacks, phoneWebLaunchObservationMs } from "./helpers/phoneWebStacks";
import { scratchDir } from "./helpers/scratchDirs";

// INF-1936: original PR #735 attempt 1 readings, including the delayed launch's
// actual RunningBoard reply, and PR #719's separate post-launch rendering fault.
const request =
  '2026-10-30 04:36:02.556 I  Infinitary[7000:a48e] [com.apple.runningboard:general] Sending launch request: <RBSLaunchRequest| extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7000)>[uuid:59C03712-C46D-44D5-B58C-B5C6C1E14E27]; "(null)">';
const reply =
  "2026-10-30 04:40:07.108 I  runningboardd[5883:b7c0] [com.apple.runningboard:process] Process: [extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7000)>[uuid:59C03712-C46D-44D5-B58C-B5C6C1E14E27]:7859] with pid: 7859; launch assertion: 5883-7000-1410";
const render =
  "2026-10-30 08:25:02.998 Df Infinitary[6999:81bc] [com.apple.WebKit:RemoteLayerBuffers] WebContent[7047] [renderingBackend=19] RemoteRenderingBackendProxy::didBecomeUnresponsive";

// Run 41091833322: both running-state forms were present even when the exact
// PID reply was not. Keep the actual readings, including the PID-less calculation.
const runningRequest =
  '2026-10-30 16:50:14.451 I  Infinitary[7109:99a0] [com.apple.runningboard:general] Sending launch request: <RBSLaunchRequest| extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7109)>[uuid:AE810B58-C290-4A72-8B2D-C7620AF83789]; "(null)">';
const receivedState =
  "2026-10-30 16:50:14.571 Df SpringBoard[5881:939c] [com.apple.runningboard:monitor] Received state update for 7441 (extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7109)>[uuid:AE810B58-C290-4A72-8B2D-C7620AF83789], running-active-NotVisible";
const calculatedState =
  "2026-10-30 16:50:14.985 Df runningboardd[5889:9869] [com.apple.runningboard:monitor] Calculated state for extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7109)>[uuid:AE810B58-C290-4A72-8B2D-C7620AF83789]: running-active (role: UserInteractiveFocal) (endowments: {(";
// PR #736's fault and the two simulators' independent GPU ownership readings.
const gpu =
  "2026-10-30 16:41:30.164 Df SpringBoard[5873:7703] [com.apple.runningboard:monitor] Received state update for 7063 (extension<com.apple.WebKit.GPU[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):6940)>[uuid:A1429C68-F17C-4F34-9EB1-2138A4ABFE77], running-active-NotVisible";
const otherGpu =
  "2026-10-30 16:41:31.293 Df SpringBoard[5870:76e9] [com.apple.runningboard:monitor] Received state update for 7068 (extension<com.apple.WebKit.GPU[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):6941)>[uuid:3D483338-70B0-436D-B52D-2BB09A2AC773], running-active-NotVisible";
const gpuFault =
  "2026-10-30 16:41:49.681 Df Infinitary[6940:7ca2] [com.apple.WebKit:RemoteLayerBuffers] WebContent[7061] [renderingBackend=19] RemoteRenderingBackendProxy::didBecomeUnresponsive";

const fixture = (
  capture = vi.fn(async (_app: number, _destination: string, _extensions: PhoneWebProcess[]) => {}),
) => {
  const evidence = scratchDir("phone-web-stacks-");
  return { evidence, capture, reader: capturePhoneWebStacks({ evidence, capture }) };
};
afterEach(() => vi.useRealTimers());

describe("capture the missing live simulator stacks without retrying the journey (INF-1936)", () => {
  it("captures a still-pending launch once, even if the stream repeats it", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const receivedAt = new Date().toISOString();
    f.reader.receive(request);
    f.reader.receive(request);
    expect(f.capture).not.toHaveBeenCalled();
    // Advance exactly the observation window: a unit worker is shared, so another
    // file's timer can sit on the faked clock and running every timer would move
    // "now" past the moment the capture was triggered.
    await vi.advanceTimersByTimeAsync(phoneWebLaunchObservationMs);
    const triggeredAt = new Date().toISOString();
    f.reader.receive(request);
    await vi.runAllTimersAsync();
    await f.reader.close();
    expect(f.capture).toHaveBeenCalledExactlyOnceWith(7000, join(f.evidence, "web-launch"), []);
    const status = readFileSync(join(f.evidence, "web-launch-capture.log"), "utf8");
    expect(status).toContain(request);
    // INF-1941's late capture could not distinguish log delivery from a blocked lookup.
    expect(status).toContain(`Log received at ${receivedAt}\nCapture triggered at ${triggeredAt}`);
    expect(triggeredAt).not.toBe(receivedAt);
  });

  it("cancels sampling when the same launch has a PID before the observation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.reader.receive(request);
    f.reader.receive(reply);
    await vi.runAllTimersAsync();
    await f.reader.close();
    expect(f.capture).not.toHaveBeenCalled();
  });

  it("captures a rendering fault independently of a launch observation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.reader.receive(request);
    await vi.runAllTimersAsync();
    f.reader.receive(render);
    f.reader.receive(render);
    await f.reader.close();
    expect(f.capture.mock.calls).toEqual([
      [7000, join(f.evidence, "web-launch"), []],
      [
        6999,
        join(f.evidence, "web-render"),
        [{ app: 6999, pid: 7047, kind: "WebContent", observedAt: render.slice(0, 23) }],
      ],
    ]);
  });

  it.each([receivedState, calculatedState])(
    "preserves the launch capture after a running-state witness: %s",
    async (state) => {
      vi.useFakeTimers();
      const f = fixture();
      f.reader.receive(runningRequest);
      f.reader.receive(state);
      await vi.runAllTimersAsync();
      expect(f.capture).not.toHaveBeenCalled();
      // A later genuine pending request still gets its capture.
      f.reader.receive(request);
      await vi.runAllTimersAsync();
      await f.reader.close();
      expect(f.capture).toHaveBeenCalledExactlyOnceWith(7000, join(f.evidence, "web-launch"), []);
    },
  );

  it("retains a running witness when the request arrives later or repeats", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.reader.receive(receivedState);
    f.reader.receive(runningRequest);
    f.reader.receive(runningRequest);
    await vi.runAllTimersAsync();
    await f.reader.close();
    expect(f.capture).not.toHaveBeenCalled();
  });

  it("does not let another request's running witness cancel a pending launch", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.reader.receive(request);
    f.reader.receive(receivedState);
    await vi.runAllTimersAsync();
    await f.reader.close();
    expect(f.capture).toHaveBeenCalledExactlyOnceWith(7000, join(f.evidence, "web-launch"), []);
  });

  it("passes the fault's WebContent and only its app's witnessed GPU to the owner check", async () => {
    const f = fixture();
    f.reader.receive(gpu);
    f.reader.receive(otherGpu);
    f.reader.receive(gpuFault);
    f.reader.receive(gpuFault);
    await f.reader.close();
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(f.capture.mock.calls[0]).toEqual([
      6940,
      join(f.evidence, "web-render"),
      [
        { app: 6940, pid: 7061, kind: "WebContent", observedAt: gpuFault.slice(0, 23) },
        {
          app: 6940,
          pid: 7063,
          kind: "GPU",
          observedAt: gpu.slice(0, 23),
          request: "A1429C68-F17C-4F34-9EB1-2138A4ABFE77",
        },
      ],
    ]);
  });

  it("joins a capture and cancels pending work before the simulator is removed", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = fixture(vi.fn(async () => running));
    f.reader.receive(render);
    f.reader.receive(request);
    let closed = false;
    const closing = f.reader.close().then(() => {
      closed = true;
    });
    await vi.runAllTimersAsync();
    expect(closed).toBe(false);
    expect(f.capture).toHaveBeenCalledTimes(1);
    finish();
    await closing;
    f.reader.receive(render);
    f.reader.receive(request);
    await vi.runAllTimersAsync();
    expect(f.capture).toHaveBeenCalledTimes(1);
  });

  it("keeps a capture failure as evidence, not a replacement test failure", async () => {
    const f = fixture(
      vi.fn(async () => {
        throw new Error("The process exited");
      }),
    );
    f.reader.receive(render);
    await expect(f.reader.close()).resolves.toBeUndefined();
    expect(readFileSync(join(f.evidence, "web-render-capture.log"), "utf8")).toContain(
      "The process exited",
    );
    expect(f.capture).toHaveBeenCalledTimes(1);
  });
});
