import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAxiArguments, runTaskAxiCli, type TaskAxiCli } from "./cli";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
});

function fixture() {
  const connect = vi.fn(async () => ({ page: "Example" }));
  const run = vi.fn(async (args, context) => ({
    title: context.page,
    address: "https://example.com/",
    refs: 0,
    errors: 0,
    args,
    help: ["infinitary-browser-axi snapshot --full"],
  }));
  const tool: TaskAxiCli<{ page: string }> = {
    name: "infinitary-browser-axi",
    description: "This task's browser",
    version: "1.0.0",
    connect,
    home: async (context) => ({
      title: context.page,
      refs: 0,
      help: ["infinitary-browser-axi open <url>"],
    }),
    commands: {
      snapshot: {
        usage: "snapshot [--from n] [--full]",
        description: "Read the page",
        flags: { "--from": "value", "--full": "switch" },
        run,
      },
    },
  };
  async function invoke(argv: string[]) {
    process.exitCode = 0;
    let text = "";
    await runTaskAxiCli(tool, argv, {
      write: (chunk) => {
        text += chunk;
      },
    });
    return { text, exitCode: process.exitCode };
  }
  return { run, connect, invoke };
}

describe("the isolated task AXI runtime", () => {
  it("shows content first at home and uses the SDK's compact output", async () => {
    const { invoke, connect } = fixture();
    const answer = await invoke([]);
    expect(answer.exitCode).toBe(0);
    expect(answer.text).toContain("title: Example");
    expect(answer.text).toContain("help[1]: infinitary-browser-axi open <url>");
    expect(connect).toHaveBeenCalledOnce();
  });

  it.for([["--help"], ["snapshot", "--help"], ["-v"]])(
    "serves %j without opening a connection",
    async (argv) => {
      const { invoke, connect } = fixture();
      expect((await invoke(argv)).exitCode).toBe(0);
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it.for([
    ["snapshot", "--unknown"],
    ["snapshot", "--from"],
    ["snapshot", "--full", "--full"],
    ["toString"],
    ["__proto__"],
    ["setup", "hooks"],
    ["update"],
    ["update", "--check"],
    ["update", "--help"],
  ])("refuses %j on stdout without connecting or running a command", async (argv) => {
    const { invoke, connect, run } = fixture();
    const answer = await invoke(argv);
    expect(answer.exitCode).toBe(2);
    expect(answer.text).toContain("error:");
    expect(connect).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("lists valid flags when a flag is unknown", async () => {
    const { invoke } = fixture();
    expect((await invoke(["snapshot", "--bad"])).text).toContain(
      "Valid flags: --help, --from, --full",
    );
  });

  it("reports channel failures as SDK operational errors", async () => {
    const { connect, invoke } = fixture();
    connect.mockRejectedValueOnce(
      new Error("The captain holds this browser; wait for returned control"),
    );
    const answer = await invoke([]);
    expect(answer.exitCode).toBe(1);
    expect(answer.text).toContain("The captain holds this browser");
  });

  it("does not advertise an updater or hooks in global help", async () => {
    const { invoke } = fixture();
    const answer = await invoke(["--help"]);
    expect(answer.text).toContain("snapshot");
    expect(answer.text).not.toContain("update");
    expect(answer.text).not.toContain("hooks");
  });

  it("dispatches literal --help after the separator as content", async () => {
    const { invoke, run } = fixture();
    const answer = await invoke(["snapshot", "--", "--help"]);
    expect(answer.exitCode).toBe(0);
    expect(run).toHaveBeenCalledWith({ positional: ["--help"], flags: {} }, { page: "Example" });
  });

  it("accepts literal flags as content after the separator", () => {
    expect(parseAxiArguments(["--", "--full", "-text"])).toEqual({
      positional: ["--full", "-text"],
      flags: {},
    });
  });
});
