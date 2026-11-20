import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { hostEnv } from "../hostEnv";
import { encodedCommand, windowsPowerShell } from "../storage/ownerOnly";
import { ANNOUNCE_SERVICE } from "./announce";
import type { DnsSdRun } from "./dnsSd";

/**
 * How a Windows home announces itself to a phone (docs/devices.md,
 * "Announcing to a phone"): Windows' own network announcement, the
 * `DnsServiceRegister` call its DNS client service answers since Windows 10
 * (1809), in place of macOS's dns-sd and Linux's Avahi. Windows has no
 * program that announces from the command line, so Windows' own PowerShell
 * makes the call and holds it: it reads this app's pipe until the pipe
 * closes - when the run is stopped, or when the app is gone, however it
 * went - and then takes the announcement back, so a quit or a crash leaves
 * none behind. It carries no key and no secret, as on a Mac.
 */

/** What the announcing PowerShell is asked: the name and the port, read from its environment. */
export function windowsAnnounceArgs(name: string, port: number): string[] {
  return [name, String(port)];
}

/**
 * The service instance's name in DNS-SD's form: dots and backslashes in the
 * computer's own name are escaped, so the name stays one label.
 */
export function windowsServiceName(name: string): string {
  return `${name.replace(/\\/g, "\\\\").replace(/\./g, "\\.")}.${ANNOUNCE_SERVICE}.local`;
}

/**
 * The C# PowerShell compiles: register, say so on its output, wait for the
 * pipe to close, take it back. `DNS_REQUEST_PENDING` (9506) is the call's
 * answer when it was taken; the completion's status 0 is the announcement
 * made. A failure ends the run with a code, so the announcement starts again
 * later, as a Mac's does when mDNSResponder restarts.
 */
const ANNOUNCE_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class InfinitaryAnnouncement {
  [StructLayout(LayoutKind.Sequential)]
  struct RegisterRequest {
    public uint Version;
    public uint InterfaceIndex;
    public IntPtr ServiceInstance;
    public IntPtr Completion;
    public IntPtr Context;
    public IntPtr Credentials;
    public int UnicastEnabled;
  }

  [UnmanagedFunctionPointer(CallingConvention.Winapi)]
  delegate void Completed(uint status, IntPtr context, IntPtr instance);

  [DllImport("dnsapi.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr DnsServiceConstructInstance(string serviceName, string hostName, IntPtr ip4, IntPtr ip6, ushort port, ushort priority, ushort weight, uint propertiesCount, IntPtr keys, IntPtr values);
  [DllImport("dnsapi.dll")]
  static extern uint DnsServiceRegister(IntPtr request, IntPtr cancel);
  [DllImport("dnsapi.dll")]
  static extern uint DnsServiceDeRegister(IntPtr request, IntPtr cancel);
  [DllImport("dnsapi.dll")]
  static extern void DnsServiceFreeInstance(IntPtr instance);

  static Completed held;
  static int lastStatus = -1;
  static readonly ManualResetEvent answered = new ManualResetEvent(false);

  static void OnCompleted(uint status, IntPtr context, IntPtr instance) {
    lastStatus = (int)status;
    if (instance != IntPtr.Zero) DnsServiceFreeInstance(instance);
    answered.Set();
  }

  public static int Run(string serviceName, string hostName, ushort port) {
    held = new Completed(OnCompleted);
    IntPtr instance = DnsServiceConstructInstance(serviceName, hostName, IntPtr.Zero, IntPtr.Zero, port, 0, 0, 0, IntPtr.Zero, IntPtr.Zero);
    if (instance == IntPtr.Zero) { Console.Out.WriteLine("refused: no instance"); return 2; }
    RegisterRequest request = new RegisterRequest();
    request.Version = 1;
    request.ServiceInstance = instance;
    request.Completion = Marshal.GetFunctionPointerForDelegate(held);
    IntPtr pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RegisterRequest)));
    Marshal.StructureToPtr(request, pointer, false);
    uint taken = DnsServiceRegister(pointer, IntPtr.Zero);
    if (taken != 9506) { Console.Out.WriteLine("refused: " + taken); return 3; }
    answered.WaitOne();
    if (lastStatus != 0) { Console.Out.WriteLine("refused: " + lastStatus); return 4; }
    Console.Out.WriteLine("announced: " + serviceName + " at " + hostName + ":" + port);
    Console.Out.Flush();
    // Held until this app's pipe closes.
    Console.In.ReadToEnd();
    answered.Reset();
    if (DnsServiceDeRegister(pointer, IntPtr.Zero) == 9506) answered.WaitOne(5000);
    DnsServiceFreeInstance(instance);
    Marshal.FreeHGlobal(pointer);
    GC.KeepAlive(held);
    return 0;
  }
}
`;

/**
 * The PowerShell around it: the name and port come in `INFINITARY_ANNOUNCE`,
 * never quoted into the script, and it prints in UTF-8, as the app reads it.
 */
export const ANNOUNCE_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
Add-Type -TypeDefinition @'
${ANNOUNCE_SOURCE}
'@
$ask = $env:INFINITARY_ANNOUNCE | ConvertFrom-Json
exit [InfinitaryAnnouncement]::Run($ask.service, $ask.host, [uint16]$ask.port)
`;

/** How long a stopped run has to take its announcement back before it is ended. */
const TAKE_BACK_WAIT_MS = 5_000;

/**
 * Announces with Windows' own call, held by this app's pipe: `args` is
 * `windowsAnnounceArgs(name, port)`. Each line it prints is handed on; it
 * ends `finished` only when it took the announcement back cleanly.
 */
export function runWindowsAnnouncement(env: NodeJS.ProcessEnv = process.env): DnsSdRun {
  return (args, heard) => {
    let ended = false;
    const end = (finished: boolean) => {
      if (ended) return;
      ended = true;
      heard.ended(finished);
    };
    const [name = "", port = "0"] = args;
    const ask = {
      service: windowsServiceName(name),
      // The full host name: COMPUTERNAME is the old network name, cut to 15 letters.
      host: `${hostname() || env.COMPUTERNAME || "localhost"}.local`,
      port: Number(port),
    };
    const child = spawn(
      windowsPowerShell(env),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedCommand(ANNOUNCE_SCRIPT),
      ],
      {
        env: { ...hostEnv(), INFINITARY_ANNOUNCE: JSON.stringify(ask) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        if (ended) return;
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop() ?? "";
        for (const line of lines) heard.line(line);
      });
    }
    child.stdin.on("error", () => {});
    child.on("error", () => end(false));
    child.on("close", (code) => end(code === 0));
    return {
      stop: () => {
        ended = true;
        // Closing the pipe is the stop: PowerShell takes the announcement back and ends.
        child.stdin.end();
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        }, TAKE_BACK_WAIT_MS);
        timer.unref?.();
        child.on("close", () => clearTimeout(timer));
      },
    };
  };
}
