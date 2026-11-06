import { expect, test } from "vitest";
import { renderReply } from "../../../src/core/axi/browserCommands";
import { BROWSER_COMMAND } from "../../../src/core/browser/commandWords";
import { SYNC_CAP_MS } from "../../../src/core/jobs/jobManager";
import { renderWake } from "../../../src/core/orchestrator/wakes";
import { backgroundJobReceipt } from "../../../src/core/pi/bashWords";
import { frameServedInput } from "../../../src/shared/servedFrame";
import { browser } from "../browserScript";
import type { ScenarioAnswer } from "../mockProvider";
import { SAVED_SITE_VISIT, savedSiteVisit } from "./savedSiteVisit";

/**
 * INF-1689: the failed sign-in journey reported `running: open` instead of
 * reading the kept page. Replay that reply through the scenario's request
 * interface, including BUSY and a shell exit, without a clock or Electron.
 * The existing journey owns the real club page and permission lifecycle.
 */
for (const completion of ["direct", "kept", "shell", "kept shell"] as const) {
  test(`the saved-site scenario reports the page after a ${completion} answer, opening once`, () => {
    const answerer = savedSiteVisit();
    const url = "http://127.0.0.1:5555/?visit=first-task";
    const messages: { role: string; content: unknown }[] = [
      { role: "user", content: `${SAVED_SITE_VISIT}${url}` },
    ];
    let last: ScenarioAnswer | undefined;
    const commands: string[] = [];
    const next = () => {
      const body = JSON.stringify({ messages });
      last = answerer({
        body,
        isFirstmate: false,
        wantsStream: true,
        latestUserTail: body,
        hasToolResults: messages.length > 1,
        anthropicMessages: true,
        port: 0,
      });
      return last;
    };
    // The journey's Pi seat sends Anthropic tool-use/result messages.
    const result = (text: string) => {
      if (!last || !("calls" in last)) throw new Error("Expected a tool call");
      expect(last.calls).toHaveLength(1);
      const call = last.calls[0];
      if (!call) throw new Error("Missing tool call");
      if (call.name === "bash") commands.push(call.args.command);
      const id = `tool-${messages.length}`;
      messages.push(
        {
          role: "assistant",
          content: [{ type: "tool_use", id, name: call.name, input: call.args }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
      );
    };
    const kept = completion.startsWith("kept");
    const shell = completion.endsWith("shell");
    expect(next()).toEqual({ calls: [browser("open", url)] });
    if (kept) {
      // The actual running reply seen in PR #659's failed journey, from its owner.
      result(`exit 0\n${renderReply("open", { kind: "running", command: "open" }, [])}`);
      expect(next()).toEqual({ calls: [browser()] });
      result(
        "exit 1\nerror: Your earlier open is still running in the browser, so this command was not run\ncode: BUSY\n",
      );
      expect(next()).toEqual({ calls: [browser()] });
    }
    // The same disposable club and signed-in reading as task-browser-sign-ins.
    const page = {
      text: "Club",
      page: {
        title: "",
        url,
        refs: "g1",
        controls: 0,
        errors: 0,
        did: "Opened the page.",
      },
      body: 'outline: lines 1-2 of 2\nheading "Club" (level 1)\ntext "Signed in as Sam"',
    };
    const reading = renderReply("browser", { kind: "answer", answer: page }, []);
    const output = kept
      ? renderReply("browser", { kind: "earlier", command: "open", answer: page }, [], true)
      : reading;
    if (shell) {
      const jobId = "saved-site-open";
      result(backgroundJobReceipt(jobId));
      // No report and no repeated open while the shell's result is pending.
      expect(next()).toEqual({ text: "The browser command is still running." });
      messages.push({
        role: "user",
        content: frameServedInput([
          {
            kind: "wake",
            origin: "agent",
            body: renderWake({
              facts: {
                kind: "job-exit",
                to: "crewmate",
                jobId,
                command: commands.at(-1) ?? "",
                exitCode: 0,
                durationMs: SYNC_CAP_MS + 1,
                tail: output,
              },
            }),
          },
        ]).text,
      });
    } else result(`exit 0\n${output}`);
    // Browser helpers read quoted facts as words, leaving the outline intact.
    expect(next()).toEqual({
      calls: [{ name: "report", args: { text: reading.replace(JSON.stringify(url), url) } }],
    });
    expect(commands).toHaveLength(kept ? 3 : 1);
    expect(commands.slice(1)).toEqual(kept ? [BROWSER_COMMAND, BROWSER_COMMAND] : []);
    result("Reported.");
    expect(next()).toEqual({ text: "Reported the club page." });
  });
}
