import { describe, expect, it } from "vitest";
import { phoneDecision } from "../scripts/affected-phone";
import { phoneWebContentStartup } from "./helpers/phoneWebContent";

// INF-1888: real readings from phone run 40952227386, attempt 2, iPhone cards.
// WebKit's own launch duration exceeded the failed body wait's 200-second cap.
// Keep only the startup records needed by this reader, not the run's private paths.
const request =
  '2026-10-29 23:21:25.922 I  Infinitary[6999:83b1] [com.apple.runningboard:general] Sending launch request: <RBSLaunchRequest| extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):6999)>[uuid:8329BFBE-882D-40B5-9D62-52CD90954252]; "(null)">';
const launched =
  "2026-10-29 23:24:48.649 F  Infinitary[6999:81f3] [com.apple.WebKit:Process] WebContent process (0x1260b00c0) took 202.786854 seconds to launch";
const child =
  "2026-10-29 23:24:48.585 Df com.apple.WebKit.WebContent[7049:9387] [com.apple.extensionkit:default] Extension `com.apple.WebKit.WebContent` of type: `libXPCService` launched.";
const forwarded =
  "2026-10-29 23:24:50.131 Df Infinitary[6999:81f3] [com.apple.WebKit:Process] WebContent[7049] WebProcess::platformInitializeWebProcess";

const report = (...lines: string[]) => {
  const startup = phoneWebContentStartup();
  for (const line of lines) startup.receive(line);
  return startup.report();
};

describe("phone failures name the simulator's WebContent startup evidence (INF-1888)", () => {
  it("selects the phone gate when its startup reader changes", () => {
    expect(phoneDecision(["tests/helpers/phoneWebContent.ts"]).run).toBe(true);
  });

  it("reports Apple's measured delay and request beside the original witnesses", () => {
    const output = report(request, child, launched, forwarded);
    expect(output).toContain(
      "Simulator WebContent startup: WebKit reported 202.786854 seconds to launch at 2026-10-29 23:24:48.649 for Infinitary PID 6999.",
    );
    expect(output).toContain(
      "Simulator WebContent launch requested at 2026-10-29 23:21:25.922 by Infinitary PID 6999",
    );
    expect(output).toContain(request);
    expect(output).toContain(launched);
    expect(output).not.toContain(child);
    expect(output).not.toContain(forwarded);
    expect(output).toContain("The check remains failed; no retry or longer wait was added.");
    expect(output).toContain("an earlier launch alone does not explain a later card failure");
  });

  it("keeps a late kept-log reading once, in timestamp order, after a live stream missed it", () => {
    // The live log heard the completion only; log show then supplies both.
    const output = report(launched, request, launched);
    expect(output).toBe(report(request, launched));
    expect(output.split(launched)).toHaveLength(2);
  });

  it("reports a missing completion as unknown, never as proof the process is still pending", () => {
    const output = report(request);
    expect(output).toContain(request);
    expect(output).not.toContain("WebKit reported");
    expect(output).toContain(
      "A request without a captured completion is unknown, not proof the process never started.",
    );
  });

  it("does not mistake child or forwarded activity for the app's measured startup", () => {
    const output = report(child, forwarded);
    expect(output).toContain(
      "No app-owned WebContent launch readings were captured; startup is unknown.",
    );
    expect(output).not.toContain("Apple's launch readings:");
  });

  it("does not invent a request when only Apple's completion survived", () => {
    const output = report(launched);
    expect(output).toContain(launched);
    expect(output).not.toContain("launch requested at");
  });

  it("keeps absent or changed log formats unknown rather than guessing a cause", () => {
    expect(report()).toContain("startup is unknown");
    expect(report(launched.replace("Infinitary[", "Photos["))).toContain("startup is unknown");
    expect(report(request.replace("((null):6999)", "((null):7049)"))).toContain(
      "startup is unknown",
    );
    expect(report(launched.replace("seconds to launch", "seconds to initialize"))).toContain(
      "startup is unknown",
    );
    expect(report(request, launched)).toContain(
      "These readings do not establish CPU load, concurrent simulators or a runtime defect as the cause.",
    );
  });
});
