import { spawn } from "node:child_process";
import { hostEnv } from "../hostEnv";
import { encodedCommand, windowsPowerShell } from "../storage/ownerOnly";
import type { DnsSdRun } from "./dnsSd";

/**
 * How a Windows PC listens for computers on its network (docs/devices.md,
 * "Finding the home again" and "Macs nearby"): Windows' own network
 * browsing, the `DnsServiceBrowse` and `DnsServiceResolve` calls its DNS
 * client service answers since Windows 10 (1809), in place of macOS's
 * dns-sd and Linux's Avahi. Windows has no program that browses from the
 * command line, so Windows' own PowerShell makes the calls, as it announces
 * a Windows home (`./windowsAnnounce.ts`). It only listens: it sends nothing
 * to any address it hears.
 *
 * It answers dns-sd's own `-B` and `-L` and prints what it heard as dns-sd
 * does, so the same readers (`readBrowseLine`, `readReachedLine`,
 * `readResolveLine`) read a Windows PC's look and a Mac's alike.
 */

/** What the PowerShell is asked: browse a service type, or resolve one name of it, for some seconds. */
export type WindowsLookAsk =
  | { look: "browse"; type: string; seconds: number }
  | { look: "resolve"; instance: string; seconds: number };

/** The ask a dns-sd argument list names: `-t <seconds> -B <type> local.` or `-t <seconds> -L <name> <type> local.` */
export function windowsLookAsk(args: readonly string[]): WindowsLookAsk | null {
  const at = args.indexOf("-t");
  const seconds = at >= 0 ? Number(args[at + 1]) : 5;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) return null;
  const browse = args.indexOf("-B");
  if (browse >= 0) {
    const type = args[browse + 1];
    return type && SERVICE_TYPE.test(type) ? { look: "browse", type, seconds } : null;
  }
  const resolve = args.indexOf("-L");
  if (resolve >= 0) {
    const name = args[resolve + 1];
    const type = args[resolve + 2];
    if (!name || !type || !SERVICE_TYPE.test(type)) return null;
    return { look: "resolve", instance: `${escapeLabel(name)}.${type}.local`, seconds };
  }
  return null;
}

/** A service type such as `_ssh._tcp`: the only kind dns-sd is asked for here. */
const SERVICE_TYPE = /^_[a-z0-9-]{1,15}\._(?:tcp|udp)$/;

/** One name as one DNS label: its dots and backslashes escaped, as DNS-SD writes them. */
function escapeLabel(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/\./g, "\\.");
}

/**
 * The instance's own name from a full one Windows gives, such as
 * `Kun\.s Mac._ssh._tcp.local` for `Kun.s Mac`: its first label, with
 * DNS-SD's escapes (`\.`, `\\`, and `\DDD` for one byte of its UTF-8, such
 * as `\226\128\153` for a curly apostrophe) read back.
 */
export function instanceLabel(full: string): string | null {
  const bytes: number[] = [];
  const text = new TextEncoder();
  for (let at = 0; at < full.length; at += 1) {
    const char = full[at] ?? "";
    if (char === ".")
      return bytes.length > 0 ? new TextDecoder().decode(new Uint8Array(bytes)) : null;
    if (char !== "\\") {
      // A whole character, the second half of a surrogate pair with it.
      const whole = String.fromCodePoint(full.codePointAt(at) ?? 0);
      bytes.push(...text.encode(whole));
      at += whole.length - 1;
      continue;
    }
    const digits = /^\d{3}/.exec(full.slice(at + 1))?.[0];
    if (digits && Number(digits) < 256) {
      bytes.push(Number(digits));
      at += 3;
    } else if (at + 1 < full.length) {
      bytes.push(...text.encode(full[at + 1]));
      at += 1;
    }
  }
  return null;
}

/** What a browse or resolve answers once this look cancels it. */
const ERROR_CANCELLED = 1223;

/** The time dns-sd puts before each line; its readers only check the shape. */
const STAMP = "00:00:00.000";

/**
 * One line the PowerShell printed, said as dns-sd says it, or null for
 * anything else. It prints tab-separated fields:
 *
 * - `add <interface> <full name>` or `rmv ...`: a name heard, or gone.
 * - `reached <interface> <port> <host> [<address> ...]`: where the name asked can be reached.
 * - `failed <code>`: a call Windows refused.
 */
export function dnsSdLine(ask: WindowsLookAsk, said: string): string[] {
  const fields = said.trim().split("\t");
  const [what, ...rest] = fields;
  if (what === "failed") {
    const code = Number(rest[0]);
    // ERROR_CANCELLED is the look's own stop once its seconds are up, as
    // dns-sd's -t ends quietly: never a call Windows refused.
    if (code === ERROR_CANCELLED) return [];
    return Number.isInteger(code) ? [`DNSService call failed ${code}`] : [];
  }
  if ((what === "add" || what === "rmv") && ask.look === "browse") {
    const [index, full] = rest;
    const name = full ? instanceLabel(full) : null;
    if (!name || !/^\d+$/.test(index ?? "")) return [];
    const event = what === "add" ? "Add" : "Rmv";
    return [`${STAMP}  ${event}        2 ${index} local. ${ask.type}. ${name}`];
  }
  if (what === "reached" && ask.look === "resolve") {
    const [index, port, host, ...addresses] = rest;
    if (!/^\d+$/.test(index ?? "") || !/^\d+$/.test(port ?? "")) return [];
    const at = (where: string) =>
      `${ask.instance}. can be reached at ${where}:${port} (interface ${index})`;
    return [
      ...(host && /^[A-Za-z0-9.-]+$/.test(host) ? [at(`${host.replace(/\.$/, "")}.`)] : []),
      ...addresses.filter((address) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)).map(at),
    ];
  }
  return [];
}

/**
 * The C# PowerShell compiles: browse a type, printing each name heard or
 * gone, or resolve one name, printing where it can be reached, then stop
 * once its seconds are up. `DNS_REQUEST_PENDING` (9506) is each call's
 * answer when it was taken.
 */
const LOOK_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class InfinitaryLook {
  [StructLayout(LayoutKind.Sequential)]
  struct Request {
    public uint Version;
    public uint InterfaceIndex;
    public IntPtr QueryName;
    public IntPtr Callback;
    public IntPtr Context;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct Instance {
    public IntPtr InstanceName;
    public IntPtr HostName;
    public IntPtr Ip4;
    public IntPtr Ip6;
    public ushort Port;
    public ushort Priority;
    public ushort Weight;
    public uint PropertyCount;
    public IntPtr Keys;
    public IntPtr Values;
    public uint InterfaceIndex;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct Record {
    public IntPtr Next;
    public IntPtr Name;
    public ushort Type;
    public ushort DataLength;
    public uint Flags;
    public uint Ttl;
    public uint Reserved;
    public IntPtr NameHost;
  }

  [UnmanagedFunctionPointer(CallingConvention.Winapi)]
  delegate void Browsed(uint status, IntPtr context, IntPtr record);
  [UnmanagedFunctionPointer(CallingConvention.Winapi)]
  delegate void Resolved(uint status, IntPtr context, IntPtr instance);

  [DllImport("dnsapi.dll")]
  static extern uint DnsServiceBrowse(IntPtr request, IntPtr cancel);
  [DllImport("dnsapi.dll")]
  static extern uint DnsServiceBrowseCancel(IntPtr cancel);
  [DllImport("dnsapi.dll")]
  static extern uint DnsServiceResolve(IntPtr request, IntPtr cancel);
  [DllImport("dnsapi.dll")]
  static extern uint DnsServiceResolveCancel(IntPtr cancel);
  [DllImport("dnsapi.dll")]
  static extern void DnsServiceFreeInstance(IntPtr instance);
  [DllImport("dnsapi.dll")]
  static extern void DnsRecordListFree(IntPtr list, int freeType);

  static readonly object said = new object();
  static readonly ManualResetEvent answered = new ManualResetEvent(false);
  static Browsed heldBrowse;
  static Resolved heldResolve;

  static void Say(string line) {
    lock (said) { Console.Out.WriteLine(line); Console.Out.Flush(); }
  }

  static void OnBrowsed(uint status, IntPtr context, IntPtr list) {
    if (status != 0) { Say("failed\t" + status); }
    for (IntPtr at = list; at != IntPtr.Zero; ) {
      Record record = (Record)Marshal.PtrToStructure(at, typeof(Record));
      if (record.Type == 12 && record.NameHost != IntPtr.Zero) {
        string name = Marshal.PtrToStringUni(record.NameHost);
        Say((record.Ttl == 0 ? "rmv" : "add") + "\t0\t" + name);
      }
      at = record.Next;
    }
    if (list != IntPtr.Zero) DnsRecordListFree(list, 1);
  }

  static void OnResolved(uint status, IntPtr context, IntPtr found) {
    if (status != 0) Say("failed\t" + status);
    if (found != IntPtr.Zero) {
      Instance instance = (Instance)Marshal.PtrToStructure(found, typeof(Instance));
      string host = instance.HostName == IntPtr.Zero ? "" : Marshal.PtrToStringUni(instance.HostName);
      string line = "reached\t" + instance.InterfaceIndex + "\t" + instance.Port + "\t" + host;
      if (instance.Ip4 != IntPtr.Zero) {
        line += "\t" + Marshal.ReadByte(instance.Ip4, 0) + "." + Marshal.ReadByte(instance.Ip4, 1) + "." + Marshal.ReadByte(instance.Ip4, 2) + "." + Marshal.ReadByte(instance.Ip4, 3);
      }
      Say(line);
      DnsServiceFreeInstance(found);
    }
    answered.Set();
  }

  static IntPtr Ask(string name, Delegate callback) {
    Request request = new Request();
    request.Version = 1;
    request.QueryName = Marshal.StringToHGlobalUni(name);
    request.Callback = Marshal.GetFunctionPointerForDelegate(callback);
    IntPtr pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Request)));
    Marshal.StructureToPtr(request, pointer, false);
    return pointer;
  }

  public static int Browse(string type, int seconds) {
    heldBrowse = new Browsed(OnBrowsed);
    IntPtr request = Ask(type + ".local", heldBrowse);
    IntPtr cancel = Marshal.AllocHGlobal(IntPtr.Size);
    Marshal.WriteIntPtr(cancel, IntPtr.Zero);
    uint taken = DnsServiceBrowse(request, cancel);
    if (taken != 9506) { Say("failed\t" + taken); return 3; }
    Thread.Sleep(seconds * 1000);
    DnsServiceBrowseCancel(cancel);
    Thread.Sleep(200);
    GC.KeepAlive(heldBrowse);
    return 0;
  }

  public static int Resolve(string instance, int seconds) {
    heldResolve = new Resolved(OnResolved);
    IntPtr request = Ask(instance, heldResolve);
    IntPtr cancel = Marshal.AllocHGlobal(IntPtr.Size);
    Marshal.WriteIntPtr(cancel, IntPtr.Zero);
    uint taken = DnsServiceResolve(request, cancel);
    if (taken != 9506) { Say("failed\t" + taken); return 3; }
    if (!answered.WaitOne(seconds * 1000)) {
      DnsServiceResolveCancel(cancel);
      Thread.Sleep(200);
    }
    GC.KeepAlive(heldResolve);
    return 0;
  }
}
`;

/**
 * The PowerShell around it: what to look for comes in `INFINITARY_LOOK`,
 * never quoted into the script, and it prints in UTF-8, as the app reads it.
 */
export const LOOK_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
Add-Type -TypeDefinition @'
${LOOK_SOURCE}
'@
$ask = $env:INFINITARY_LOOK | ConvertFrom-Json
if ($ask.look -eq 'browse') { exit [InfinitaryLook]::Browse($ask.type, [int]$ask.seconds) }
exit [InfinitaryLook]::Resolve($ask.instance, [int]$ask.seconds)
`;

/**
 * Windows' own network browsing as a dns-sd run: each `-B` or `-L` asked
 * starts Windows PowerShell with `LOOK_SCRIPT`, and each line it prints is
 * handed on in dns-sd's words. An ask dns-sd's readers never make ends at
 * once, unfinished.
 */
export function runWindowsDnsSd(env: NodeJS.ProcessEnv = process.env): DnsSdRun {
  return (args, heard) => {
    let ended = false;
    const end = (finished: boolean) => {
      if (ended) return;
      ended = true;
      heard.ended(finished);
    };
    const ask = windowsLookAsk(args);
    if (!ask) {
      queueMicrotask(() => end(false));
      return { stop: () => end(false) };
    }
    const child = spawn(
      windowsPowerShell(env),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedCommand(LOOK_SCRIPT),
      ],
      {
        env: { ...hostEnv(), INFINITARY_LOOK: JSON.stringify(ask) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let rest = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (ended) return;
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) for (const said of dnsSdLine(ask, line)) heard.line(said);
    });
    child.stderr.resume();
    child.on("error", () => end(false));
    child.on("close", (code) => end(code === 0));
    return {
      stop: () => {
        ended = true;
        if (child.exitCode === null && child.signalCode === null) child.kill();
      },
    };
  };
}
