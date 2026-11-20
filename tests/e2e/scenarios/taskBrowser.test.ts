import { expect, test } from "vitest";
import recorded from "../../fixtures/task-browser-local-refusal.json";
import { MOCK_BROWSER_REPORT_PREFIX, TASK_BROWSER_PROMPT_MARKER, taskBrowser } from "./taskBrowser";

/**
 * INF-1765, established by INF-1764's recorded Claude request replay:
 * the local-server refusal arrived with fill and reload, not open.
 * Replay the captured state/refusal excerpts at the scenario's report
 * boundary; the existing journeys own browser actions and security.
 * Only the disposable port is normalized in the captured fixture.
 */

for (const indices of [[0], [1, 4], [4], [6], []]) {
  test(`the local-page scenario reads the refused host from replies [${indices}] without assuming it`, () => {
    const answers = recorded.answers.map((text, index) =>
      indices.includes(index) ? `${recorded.refusal}\n${text}` : text,
    );
    const body = JSON.stringify({
      messages: [
        { role: "user", content: `${TASK_BROWSER_PROMPT_MARKER}${recorded.siteUrl} as Sam` },
        ...answers.map((text, index) => ({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `browser-${index}`, content: text }],
        })),
      ],
    });
    const answer = taskBrowser()({
      body,
      isFirstmate: false,
      wantsStream: true,
      latestUserTail: body,
      hasToolResults: true,
      anthropicMessages: true,
      port: 0,
    });
    if (!answer || !("calls" in answer)) throw new Error("Expected a report");
    expect(answer.calls).toHaveLength(1);
    const call = answer.calls[0];
    expect(call?.name).toBe("report");
    if (call?.name !== "report") throw new Error("Expected the report call");
    const text = call.args.text;
    expect(text).toContain(MOCK_BROWSER_REPORT_PREFIX);
    // The unchanged journey assertion: the refused host, not merely a
    // copied refusal in the appended browser transcript, is in the report.
    if (indices.length) expect(text).toContain(`${recorded.host} on this Mac.`);
    else expect(text).not.toContain(`${recorded.host} on this Mac.`);
  });
}
