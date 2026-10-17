import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { movingBoxBytes } from "../../../../../tests/helpers/mp4Fixture";
import { type AttachmentDestination, AttachmentUploadError } from "../../attachments";
import { GitHubAttachments, githubAttachmentUrl } from "./attachments";

// INF-92 / accepted INF-132: native, scoped uploads; no fallback or blind replay.
const receipt = "https://github.com/user-attachments/assets/846dced7-16ad-44c0-b6f5-f0e5581165b2";
const repository = {
  id: 1422452335,
  full_name: "kunchenguid/infinitary-evidence-test-public",
  private: false,
  visibility: "public",
  permissions: { push: true },
};
const destination: AttachmentDestination = {
  host: "github.com",
  projectId: repository.id,
  fullName: repository.full_name,
  visibility: "public",
};
function attachment() {
  const bytes = movingBoxBytes();
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mediaType: "video/mp4" as const,
  };
}
function arrange(
  options: { token?: string; response?: () => Promise<Response>; repo?: unknown } = {},
) {
  const fetcher = vi.fn<typeof fetch>(
    options.response ?? (async () => Response.json({ url: receipt })),
  );
  const readRepository = vi.fn(async () => options.repo ?? repository);
  const rejected = vi.fn();
  return {
    fetcher,
    readRepository,
    rejected,
    client: new GitHubAttachments({
      fullName: repository.full_name,
      token: async () => options.token ?? "gho_test-only",
      readRepository,
      fetch: fetcher,
      onSignInRejected: rejected,
    }),
  };
}

describe("GitHub native evidence", () => {
  // INF-155: GitHub displays the upload name as the recording's visible header.
  it("sends verified recording bytes with numeric project identity and a short readable name", async () => {
    const { client, fetcher } = arrange();
    const file = attachment();
    expect(await client.destination()).toEqual(destination);
    expect(await client.upload(destination, file)).toEqual({ url: receipt });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0];
    if (!call) throw new Error("The upload was not sent");
    const [address, request] = call;
    const url = new URL(String(address));
    expect(url.origin + url.pathname).toBe("https://uploads.github.com/user-attachments/assets");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      repository_id: String(repository.id),
      content_type: file.mediaType,
      name: "recording.mp4",
    });
    expect(request).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/octet-stream" },
    });
    expect(Buffer.from(request?.body as Uint8Array).equals(file.bytes)).toBe(true);
  });

  it("records an access-read failure before sending as failed, never as an uncertain upload", async () => {
    const { client, readRepository, fetcher } = arrange();
    readRepository.mockRejectedValueOnce(new Error("The repository read lost its connection"));
    await expect(client.upload(destination, attachment())).rejects.toMatchObject({
      outcome: "failed",
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.upload(destination, attachment())).resolves.toEqual({ url: receipt });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["ghu_test-only", "ghs_test-only", "unknown-kind"])(
    "refuses unsupported sign-in %s before sending",
    async (token) => {
      const { client, fetcher } = arrange({ token });
      await expect(client.upload(destination, attachment())).rejects.toMatchObject({
        outcome: "failed",
        failure: "permission",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...repository, permissions: { push: false } },
    { ...repository, id: repository.id + 1 },
    { ...repository, private: true, visibility: "private" },
    { ...repository, full_name: "someone-else/infinitary-evidence-test-public" },
    { ...repository, visibility: undefined },
  ])("refuses unproven, transferred or changed-audience destinations", async (repo) => {
    const { client, fetcher } = arrange({ repo });
    await expect(client.upload(destination, attachment())).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses changed bytes and recordings above the free-plan limit before sending", async () => {
    const { client, fetcher } = arrange();
    await expect(
      client.upload(destination, { ...attachment(), sha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ outcome: "failed" });
    const bytes = new Uint8Array(10_000_000);
    await expect(
      client.upload(destination, {
        ...attachment(),
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    ).rejects.toMatchObject({ outcome: "failed" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 413, 422, 429])(
    "reports a confirmed refusal %s without retrying or exposing its body",
    async (status) => {
      const { client, fetcher, rejected } = arrange({
        response: async () => new Response("private response", { status }),
      });
      await expect(client.upload(destination, attachment())).rejects.toMatchObject({
        outcome: "failed",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(rejected).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    },
  );

  it.each([
    async () => {
      throw new Error("a transport error with a credential");
    },
    async () => new Response("gateway error", { status: 502 }),
    async () =>
      new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } }),
    async () => new Response("not JSON"),
    async () => Response.json({ url: `${receipt}?token=secret` }),
    async () => Response.json({ url: "https://elsewhere.example/file" }),
    async () => Response.json({ url: "x".repeat(20_000) }),
  ])("holds an ambiguous upload instead of guessing or retrying", async (response) => {
    const { client, fetcher } = arrange({ response });
    const error = await client.upload(destination, attachment()).catch((caught) => caught);
    expect(error).toBeInstanceOf(AttachmentUploadError);
    expect(error.outcome).toBe("uncertain");
    expect(error.message).not.toContain("credential");
    expect(error.message).not.toContain("secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts only an unsigned native receipt, never credentials, HTML, redirects or arbitrary paths", () => {
    expect(githubAttachmentUrl(receipt)).toBe(receipt);
    for (const url of [
      `${receipt}#fragment`,
      `${receipt}?signature=value`,
      `${receipt}/extra`,
      receipt.replace("https:", "http:"),
      receipt.replace("github.com", "github.com.evil.example"),
      receipt.replace("github.com", "name:password@github.com"),
      receipt.replace("github.com", "github.com:444"),
      `<img src="${receipt}">`,
    ])
      expect(githubAttachmentUrl(url)).toBeUndefined();
  });
});

// INF-169 F10: Enterprise Cloud internal media stays signed-in, not public.
it.each([true, false])(
  "accepts internal visibility with the app sign-in (private flag %s)",
  async (privateFlag) => {
    const at = arrange({ repo: { ...repository, private: privateFlag, visibility: "internal" } });
    const internal = await at.client.destination();
    expect(internal.visibility).toBe("internal");
    await at.client.upload(internal, attachment());
    expect(at.fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer gho_test-only",
    });
    at.readRepository.mockResolvedValue({ ...repository, private: true, visibility: "private" });
    await expect(at.client.upload(internal, attachment())).rejects.toThrow(/changed/);
    expect(at.fetcher).toHaveBeenCalledTimes(1);
  },
);
