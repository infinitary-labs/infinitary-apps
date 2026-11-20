import { describe, expect, it } from "vitest";
import type { DnsSdRun } from "./dnsSd";
import { announcedWithDnsSd } from "./findHome";
import { readBrowseLine } from "./nearby";
import { dnsSdLine, instanceLabel, windowsLookAsk } from "./windowsDnsSd";

/**
 * A Windows PC finding a home through Windows' own network browsing
 * (docs/devices.md, "Finding the home again"; INF-4260 piece 9): what its
 * PowerShell prints, said as dns-sd says it, so the readers a Mac uses read
 * it unchanged.
 */

describe("Windows network browsing, said as dns-sd", () => {
  it("asks for what dns-sd's own arguments name", () => {
    expect(windowsLookAsk(["-t", "3", "-B", "_infinitary._tcp", "local."])).toEqual({
      look: "browse",
      type: "_infinitary._tcp",
      seconds: 3,
    });
    expect(
      windowsLookAsk(["-t", "3", "-L", "Kun.s Mac mini", "_infinitary._tcp", "local."]),
    ).toEqual({
      look: "resolve",
      instance: "Kun\\.s Mac mini._infinitary._tcp.local",
      seconds: 3,
    });
    expect(windowsLookAsk(["-t", "3", "-B", "; Remove-Item C:\\", "local."])).toBeNull();
  });

  it("reads a name back from DNS-SD's escapes", () => {
    expect(instanceLabel("Kun\\.s Mac mini._infinitary._tcp.local")).toBe("Kun.s Mac mini");
    expect(instanceLabel("Sam\\226\\128\\153s MacBook._ssh._tcp.local")).toBe("Sam\u2019s MacBook");
    expect(instanceLabel("Sam\u2019s MacBook._ssh._tcp.local")).toBe("Sam\u2019s MacBook");
    expect(instanceLabel("")).toBeNull();
  });

  it("finds a home a Mac announced, through the readers a Mac uses", async () => {
    const said = {
      browse: ["add\t12\tKun's Mac mini._infinitary._tcp.local", "add\t12\tbroken"],
      resolve: ["reached\t12\t47623\tkuns-mac-mini.local.\t192.168.1.20"],
    };
    const run: DnsSdRun = (args, heard) => {
      const ask = windowsLookAsk(args);
      if (ask)
        for (const line of said[ask.look]) for (const out of dnsSdLine(ask, line)) heard.line(out);
      heard.ended(true);
      return { stop: () => {} };
    };
    const browse = { look: "browse", type: "_infinitary._tcp", seconds: 3 } as const;
    expect(said.browse.flatMap((line) => dnsSdLine(browse, line)).map(readBrowseLine)).toEqual([
      { kind: "add", name: "Kun's Mac mini", interfaceIndex: 12 },
    ]);
    expect(await announcedWithDnsSd(run)).toEqual([
      "kuns-mac-mini.local:47623",
      "192.168.1.20:47623",
    ]);
  });

  it("says a call Windows refused as dns-sd says its own", () => {
    const ask = { look: "browse", type: "_ssh._tcp", seconds: 3 } as const;
    expect(dnsSdLine(ask, "failed\t1460")).toEqual(["DNSService call failed 1460"]);
    // Windows answers 1223 to every look this app cancels once its seconds are up, as a PC did.
    expect(dnsSdLine(ask, "failed\t1223")).toEqual([]);
    expect(dnsSdLine(ask, "rmv\t12\tKun's Mac mini._ssh._tcp.local").map(readBrowseLine)).toEqual([
      { kind: "remove", name: "Kun's Mac mini", interfaceIndex: 12 },
    ]);
  });
});
