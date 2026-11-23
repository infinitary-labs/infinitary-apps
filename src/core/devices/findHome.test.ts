import { describe, expect, it } from "vitest";
import { ANNOUNCE_SERVICE } from "./announce";
import type { DnsSdRun } from "./dnsSd";
import { ANNOUNCED_HOMES_MAX, announcedWithAvahi, announcedWithDnsSd } from "./findHome";

/**
 * INF-4207 piece 1: a device that reaches its home at no address it keeps
 * listens for the home's announcement and answers where each computer
 * announcing Infinitary can be reached (docs/devices.md, "Finding the home
 * again"). Against a stand-in for dns-sd or avahi-browse in memory, printing
 * the lines those tools print; never the system's own.
 */

function standIn(lines: (args: readonly string[]) => readonly string[]) {
  const asked: string[][] = [];
  const run: DnsSdRun = (args, heard) => {
    asked.push([...args]);
    queueMicrotask(() => {
      for (const line of lines(args)) heard.line(line);
      heard.ended(true);
    });
    return { stop: () => {} };
  };
  return { run, asked };
}

describe("hearing where a home announces itself", () => {
  it("asks dns-sd for each announced name and answers where each can be reached", async () => {
    const { run, asked } = standIn((args) => {
      if (args.includes("-B"))
        return [
          "Browsing for _infinitary._tcp.local.",
          "Timestamp     A/R    Flags  if Domain               Service Type         Instance Name",
          "19:24:47.007  Add        3  14 local.               _infinitary._tcp.    Kun’s MacBook Pro",
          "19:24:47.007  Add        2   4 local.               _infinitary._tcp.    Kun’s MacBook Pro",
          "19:24:47.007  Add        2  14 local.               _infinitary._tcp.    studio",
        ];
      if (args.includes("Kun’s MacBook Pro"))
        return [
          "Lookup Kun’s MacBook Pro._infinitary._tcp.local.",
          "19:24:47.112  Kun’s\\032MacBook\\032Pro._infinitary._tcp.local. can be reached at Kuns-MacBook-Pro.local.:47623 (interface 14)",
          "19:24:47.113  Kun’s\\032MacBook\\032Pro._infinitary._tcp.local. can be reached at Kuns-MacBook-Pro.local.:47623 (interface 4)",
        ];
      return [
        "19:24:47.120  studio._infinitary._tcp.local. can be reached at studio.local.:51000 (interface 14)",
      ];
    });
    await expect(announcedWithDnsSd(run)).resolves.toEqual([
      "Kuns-MacBook-Pro.local:47623",
      "studio.local:51000",
    ]);
    expect(asked[0]).toEqual(["-t", "3", "-B", ANNOUNCE_SERVICE, "local."]);
    expect(asked.slice(1)).toEqual(
      expect.arrayContaining([
        ["-t", "3", "-L", "Kun’s MacBook Pro", ANNOUNCE_SERVICE, "local."],
        ["-t", "3", "-L", "studio", ANNOUNCE_SERVICE, "local."],
      ]),
    );
  });

  it("answers nothing when macOS does not let it look, or nothing announces", async () => {
    const denied = standIn(() => ["19:24:47.007  Error code -65570"]);
    await expect(announcedWithDnsSd(denied.run)).resolves.toEqual([]);
    expect(denied.asked).toHaveLength(1);
    const quiet = standIn(() => ["Browsing for _infinitary._tcp.local."]);
    await expect(announcedWithDnsSd(quiet.run)).resolves.toEqual([]);
  });

  it("looks up a bounded number of announced names, a few at a time, however many a network announces", async () => {
    // Review of INF-4207 piece 1: anyone on the network may announce many names.
    const many = Array.from({ length: ANNOUNCED_HOMES_MAX + 20 }, (_, n) => `mac-${n}`);
    let running = 0;
    let most = 0;
    const asked: string[][] = [];
    const run: DnsSdRun = (args, heard) => {
      asked.push([...args]);
      running += 1;
      most = Math.max(most, running);
      setTimeout(() => {
        if (args.includes("-B"))
          for (const name of many)
            heard.line(
              `19:24:47.007  Add        2  14 local.               _infinitary._tcp.    ${name}`,
            );
        else
          heard.line(
            `19:24:47.120  ${args[3]}._infinitary._tcp.local. can be reached at ${args[3]}.local.:47623 (interface 14)`,
          );
        running -= 1;
        heard.ended(true);
      }, 1);
      return { stop: () => {} };
    };
    const found = await announcedWithDnsSd(run);
    expect(asked.filter((args) => args.includes("-L"))).toHaveLength(ANNOUNCED_HOMES_MAX);
    expect(most).toBeLessThanOrEqual(4);
    expect(found).toHaveLength(ANNOUNCED_HOMES_MAX);
  });

  it("reads Avahi's resolved lines for Infinitary's service alone", async () => {
    const { run, asked } = standIn(() => [
      "+;eth0;IPv4;studio;_infinitary._tcp;local",
      "=;eth0;IPv4;studio;_infinitary._tcp;local;studio.local;192.168.1.20;47623;",
      "=;eth0;IPv6;studio;_infinitary._tcp;local;studio.local;fd00::20;47623;",
      "=;eth0;IPv4;studio;_ssh._tcp;local;studio.local;192.168.1.20;22;",
    ]);
    await expect(announcedWithAvahi(run)).resolves.toEqual([
      "192.168.1.20:47623",
      "[fd00::20]:47623",
    ]);
    expect(asked).toEqual([
      ["--parsable", "--resolve", "--terminate", "--no-db-lookup", ANNOUNCE_SERVICE],
    ]);
  });
});
