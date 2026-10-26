import type { GithubWriteInput } from "../../src/core/forge/api";
import { MERGE_CONTINUED_LEAD, WRITE_ANSWERED_LEAD } from "../../src/core/orchestrator/wakes";
import { savedDeliveryReader } from "../../src/core/storage/taskDeliveryFields";
import type { WriteAsk } from "../../src/shared/writeAsk";
import { readSavedData } from "./savedData";

export const API_WRITE_GUARD_MARKER = "check the merge API guard";

/** Concrete raw writes a scripted crewmate tries; each refusal is named. */
export function mergeWriteCases(kind: "github" | "gitlab", project: string): GithubWriteInput[] {
  const sha = "4fc9140d92b3a9d25937dec0ff4f9754fdc8c8e4";
  const cases: GithubWriteInput[] = [];
  const add = (method: GithubWriteInput["method"], path: string, body?: unknown) => {
    cases.push({
      method,
      path: `${project}${path}`,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  if (kind === "github") {
    add("PUT", "/pulls/55/merge", { sha });
    add("PUT", "/pulls/55/update-branch", { expected_head_sha: sha });
    add("PUT", "/pulls/55/merge-async", { sha, bypass_rules: true });
    add("POST", "/merges", { base: "main", head: sha });
    add("POST", "/merge-upstream", { branch: "main" });
    add("PATCH", "/git/refs/heads/main", { sha, force: true });
    add("DELETE", "/git/refs/heads/main");
    add("POST", "/git/refs", { ref: "refs/heads/main", sha });
    add("POST", "/branches/main/rename", { new_name: "old-main" });
    add("POST", "/branches/topic/rename", { new_name: "main" });
    add("PUT", "/contents/note.txt", { message: "move default", content: "eA==" });
    add("PUT", "/contents/note.txt?branch=topic", { message: "move default", content: "eA==" });
    add("PATCH", "", { default_branch: "topic" });
  } else {
    add("PUT", "/merge_requests/55/merge", { sha });
    add("DELETE", "/repository/branches/main");
    add("POST", "/repository/commits", {
      branch: "main",
      commit_message: "move default",
      actions: [],
    });
    add("PUT", "/repository/files/note.txt", {
      branch: "main",
      content: "x",
      commit_message: "move default",
    });
    add("DELETE", "/repository/files/note.txt?branch=main&commit_message=delete");
    add("PUT", "", { default_branch: "topic" });
  }
  return cases;
}

/** A scripted crewmate prepares a merge past the branch rules, then asks for it on a card. */
/** The check that failed on the release pull request, which the merge skips. */
export const SKIP_RULES_FAILED_CHECK = "PR must be raised via no-mistakes";
export const SKIP_RULES_MERGE_MARKER = "prepare the release merge past the rules";
export const SKIP_RULES_CARD_TITLE = "Merge the release past its rules";
/** The release pull request the task adopted, and the version the crewmate read. */
export const SKIP_RULES_PULL = {
  number: 500,
  branch: "release-please--branches--main",
  title: "chore(main): release 0.4.0",
  headSha: "31b7187af3ffc29b3fa917286f5c18747ecdea47",
} as const;
/** What the crewmate hears once the captain's click merged it. */
export const SKIP_RULES_MERGED_WAKE = `${MERGE_CONTINUED_LEAD} #${SKIP_RULES_PULL.number}`;

/**
 * A scripted crewmate on a project kept on this computer reads past the old
 * read list through the github.com sign-in: the person's notifications, a
 * repository listing and its next page by repository id, then GraphQL.
 */
export const READS_ANYWHERE_MARKER = "read the notifications and every page of website";
/** The repository whose listing GitHub pages by repository id. */
export const PAGED_REPOSITORY = { fullName: "octo/website", id: 77 } as const;

/**
 * A scripted crewmate's write that asks the captain (FI3-1571 piece 4): it
 * makes the write, puts the kept ask on a card beside its own Not now, and
 * once the captain's click sent it, asks again with the same id.
 */
export const WRITE_ASK_MARKER = "ask before writing";
/** The same, spawned as a task that only answers, in its project. */
export const WRITE_ASK_ANSWER_MARKER = "answer, then ask before writing";
export const WRITE_ASK_CARD_TITLE = "Send this write for me?";
/** What the crewmate hears once the captain's click sent it. */
export const WRITE_ASK_SENT_WAKE = WRITE_ANSWERED_LEAD;

/** The write each kind of ask makes, by the words in its task's title. */
export function writeAskCall(title: string): GithubWriteInput {
  if (title.includes("publish notebook")) {
    return {
      method: "POST",
      path: "/user/repos",
      body: JSON.stringify({ name: "notebook", private: true }),
    };
  }
  if (title.includes(WRITE_ASK_ANSWER_MARKER)) {
    return {
      method: "POST",
      path: "/repos/octo/meterlab/issues",
      body: JSON.stringify({ title: "The meter idles on a cold start" }),
    };
  }
  return {
    method: "POST",
    path: "/repos/octo/website/issues",
    body: JSON.stringify({ title: "Link the new meter docs", body: "The docs moved." }),
  };
}

/**
 * The writes a task keeps for the captain's click, as the app saved them:
 * its delivery composed by the delivery records' own reader, since the
 * asks live on its permission record (docs/task-record.md).
 */
export function savedWriteAsks(userDataDir: string, taskId: string): WriteAsk[] {
  const delivery = readSavedData(userDataDir, (db) => {
    const row = db
      .prepare("SELECT delivery_json AS delivery FROM tasks WHERE id = ?")
      .get(taskId) as { delivery: string | null } | undefined;
    return savedDeliveryReader(db)(taskId, row?.delivery ?? null);
  });
  return (JSON.parse(delivery ?? "{}") as { writeAsks?: WriteAsk[] }).writeAsks ?? [];
}
