import { describe, expect, it } from "vitest";
import { sshConnectionWords } from "./sshConnection";

/**
 * After the five-minute fallback Devices says out of reach on the right, and
 * a computer that never connected keeps "connecting using SSH…" on its line
 * while the retries slow (INF-49); one that connected before says reconnecting.
 */
describe("a computer's SSH line after connecting timed out", () => {
  const mini = { name: "Mac mini", user: "sam", onThisMac: false };
  it("keeps connecting for one never seen, and says reconnecting for one that was", () => {
    expect(sshConnectionWords.detail({ state: "reconnecting" }, mini)).toBe(
      "connecting using SSH…",
    );
    expect(sshConnectionWords.detail({ state: "reconnecting" }, { ...mini, seenAt: 1 })).toBe(
      "reconnecting using SSH…",
    );
  });
});
