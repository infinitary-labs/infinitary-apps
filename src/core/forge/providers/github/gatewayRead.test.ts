import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../../../tests/helpers/database";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { GithubGatewayService } from "../../../orchestrator/githubGateway";
import { GITHUB_READ_TOOL } from "../../../pi/forgeTools";
import { bindTool } from "../../../session/tools";
import { seedTask } from "../../../tasks/seedTask";
import { TaskService } from "../../../tasks/taskService";
import { RepoRegistry } from "../../../workspace/repoRegistry";
import { GitHubForge } from "./githubForge";

// Finding D: a lost crewmate read retries once; a definite refusal does not.
// Use the real HTTP reader, gateway policy, task record and common bound tool.
const databases: ReturnType<typeof freshDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function reader(fetcher: typeof fetch) {
  const db = freshDatabase();
  databases.push(db);
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, { id: "read-repository", title: "Read the repository", status: "idle" });
  const forge = new GitHubForge(
    { kind: "github", host: "github.com", dir: "" },
    {
      token: async () => "gho_fixture_owned_by_app",
      fetch: fetcher,
    },
  );
  const service = new GithubGatewayService({
    tasks,
    repos: new RepoRegistry(db, join(scratchDir("gateway-read-"), "fleet")),
    forgeFor: () => forge,
    accountForge: () => forge,
    readChecks: async () => "",
    now: Date.now,
  });
  const tool = bindTool(GITHUB_READ_TOOL, {
    onGithubRead: (input) => service.readForCrew("read-repository", input),
  });
  if (!tool) throw new Error("The read callback was not bound.");
  return tool;
}

const INPUT = { path: "/repos/octocat/Hello-World" };
// Repository identity from GitHub's documented REST example.
const BODY = { id: 1296269, full_name: "octocat/Hello-World" };

describe("the crewmate's gateway retry", () => {
  it("retries a lost HTTP read through the gateway, then returns the host's complete answer", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(Response.json(BODY));
    const output = await reader(fetcher).run(INPUT);
    expect(JSON.parse(output.text)).toMatchObject({ status: 200, body: BODY });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries an answer whose connection breaks while reading the body", async () => {
    const interrupted = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'));
        },
        pull(controller) {
          controller.error(new TypeError("terminated"));
        },
      }),
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValueOnce(Response.json(BODY));
    const output = await reader(fetcher).run(INPUT);
    expect(JSON.parse(output.text)).toMatchObject({ status: 200, body: BODY });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("ends two transport failures with an explicit lost-read answer", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(reader(fetcher).run(INPUT)).rejects.toThrow("may have been lost");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps GitHub's rate-limit facts without retrying or waiting for the reset", async () => {
    // The GitHub REST rate-limit refusal and headers, not a timeout inference.
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { message: "API rate limit exceeded" },
          { status: 429, headers: { "x-ratelimit-remaining": "0", "retry-after": "60" } },
        ),
      );
    const output = await reader(fetcher).run(INPUT);
    expect(JSON.parse(output.text)).toMatchObject({
      status: 429,
      retryAfterSeconds: 60,
      rateLimit: { remaining: 0 },
      body: { message: "API rate limit exceeded" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
