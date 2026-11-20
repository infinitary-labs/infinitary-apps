import { firewallWords } from "@shared/devices";
import { describe, expect, it } from "vitest";
import {
  type FirewallRun,
  readWindowsFirewall,
  rulePortsTake,
  windowsFirewallKeepsOut,
} from "./firewall";

/**
 * Windows Defender Firewall on a Windows home (docs/devices.md, "A home's
 * firewall"; INF-4260 piece 9): Windows asks its person when the app first
 * listens and writes a rule from the answer, so a PC whose person did not
 * let it in keeps every other computer out, and the home says how to fix it.
 */

const PORT = 47623;
const PROGRAM = "C:\\Users\\Kun Chen\\AppData\\Local\\Programs\\Infinitary\\Infinitary.exe";

/** What the policy reading prints on a PC on a private network, as PowerShell's JSON writes it. */
function printed(rules: object[], profile: object = {}): string {
  return JSON.stringify({
    profiles: { bit: 2, enabled: true, blockAll: false, defaultBlock: true, ...profile },
    rules: rules.length === 1 ? rules[0] : rules,
  });
}

/** The rules Windows writes when its person cancels its question on a private network: TCP and UDP, blocking. */
const DECLINED = { app: true, ports: "*", allow: false, profiles: 2 };
/** The rule Windows writes when its person lets the app in on private networks. */
const LET_IN = { app: true, ports: "*", allow: true, profiles: 2 };

function look(output: string, ok = true) {
  const run: FirewallRun = async () => ({ ok, output });
  return windowsFirewallKeepsOut(PORT, PROGRAM, run);
}

describe("Windows Defender Firewall on a Windows home", () => {
  it("says nothing once its person let the app in", async () => {
    expect(await look(printed([LET_IN]))).toBeNull();
    expect(
      await look(printed([{ app: false, ports: "47000-48000", allow: true, profiles: 7 }])),
    ).toBeNull();
    expect(await look(printed([], { enabled: false }))).toBeNull();
  });

  it("says devices are kept out where nothing lets them in, and adds the rule that does", async () => {
    const found = await look(printed([]));
    expect(found).toEqual({
      name: "windows",
      port: PORT,
      program: PROGRAM,
      profiles: ["private"],
      blockRule: false,
      blockAll: false,
    });
    expect(found && firewallWords(found).way).toBe(
      `New-NetFirewallRule -DisplayName 'Infinitary' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Program '${PROGRAM}' -Profile Private`,
    );
  });

  it("removes the rule Windows wrote when its person declined, which wins over any that allows", async () => {
    const found = await look(printed([DECLINED, LET_IN]));
    expect(found).toMatchObject({ profiles: ["private"], blockRule: true, blockAll: false });
    expect(found && firewallWords(found).way).toBe(
      `Get-NetFirewallApplicationFilter -Program '${PROGRAM}' | Get-NetFirewallRule | Where-Object Action -eq Block | Remove-NetFirewallRule; New-NetFirewallRule -DisplayName 'Infinitary' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Program '${PROGRAM}' -Profile Private`,
    );
  });

  it("lets rules apply first where the profile blocks every incoming connection", async () => {
    const found = await look(printed([LET_IN], { blockAll: true }));
    expect(found).toMatchObject({ profiles: ["private"], blockRule: false, blockAll: true });
    expect(found && firewallWords(found).way).toMatch(
      /^Set-NetFirewallProfile -Profile Private -AllowInboundRules True; New-NetFirewallRule /,
    );
  });

  it("never warns of a firewall it could not read", async () => {
    expect(await look("", false)).toBeNull();
    expect(await look('Exception calling "FirewallEnabled"')).toBeNull();
    expect(readWindowsFirewall("{}")).toEqual({ profiles: [], rules: [] });
  });

  it("reads a rule's ports as Windows writes them", () => {
    expect(rulePortsTake("*", PORT)).toBe(true);
    expect(rulePortsTake("47623", PORT)).toBe(true);
    expect(rulePortsTake("5000,47000-48000", PORT)).toBe(true);
    expect(rulePortsTake("3389", PORT)).toBe(false);
  });
});
