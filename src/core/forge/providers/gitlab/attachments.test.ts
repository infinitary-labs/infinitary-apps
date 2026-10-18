import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { movingBoxBytes } from "../../../../../tests/helpers/mp4Fixture";
import { type AttachmentDestination, AttachmentUploadError } from "../../attachments";
import {
  GITLAB_PRIVATE_MEDIA_REFUSAL,
  GitLabAttachments,
  gitlabAttachmentUrl,
} from "./attachments";

// INF-223 / accepted INF-132: GitLab's own multipart uploads to the confirmed
// nested project; a private project's media must require sign-in; no fallback or blind replay.
const API = "https://gitlab.com/api/v4";
const SECRET = "66dbcd21ec5d24ed6ea225176098d52b";
const project = {
  id: 81234567,
  path_with_namespace: "infinitary-labs/infinitary-test/infinitary-evidence-test-private",
  visibility: "private",
  enforce_auth_checks_on_uploads: true,
  permissions: { project_access: null, group_access: { access_level: 50 } },
};
const destination: AttachmentDestination = {
  host: "gitlab.com",
  projectId: project.id,
  fullName: project.path_with_namespace,
  visibility: "private",
};
const receipt = {
  id: 5,
  alt: "recording",
  url: `/uploads/${SECRET}/recording.mp4`,
  full_path: `/-/project/${project.id}/uploads/${SECRET}/recording.mp4`,
  markdown: `![recording](/uploads/${SECRET}/recording.mp4)`,
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
  options: {
    token?: string | null;
    response?: () => Promise<Response>;
    project?: Record<string, unknown>;
  } = {},
) {
  const fetcher = vi.fn<typeof fetch>(
    options.response ?? (async () => Response.json(receipt, { status: 201 })),
  );
  const readProject = vi.fn(async () => ({ ...project, ...options.project }));
  // The client's own read of the key after a 401: here GitLab no longer answers for it.
  const unauthorized = vi.fn(async (): Promise<"sign-in" | "permission"> => "sign-in");
  return {
    fetcher,
    readProject,
    unauthorized,
    client: new GitLabAttachments({
      fullName: project.path_with_namespace,
      apiBaseUrl: API,
      token: async () =>
        options.token === null ? undefined : (options.token ?? "glpat-test-only"),
      readProject,
      fetch: fetcher,
      unauthorized,
    }),
  };
}

describe("GitLab native evidence", () => {
  it("sends verified bytes once as GitLab's multipart file to the confirmed numeric project", async () => {
    const { client, fetcher } = arrange();
    const file = attachment();
    expect(await client.destination()).toEqual(destination);
    expect(await client.upload(destination, file)).toEqual({ url: receipt.url });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [address, request] = fetcher.mock.calls[0] ?? [];
    expect(String(address)).toBe(`${API}/projects/${project.id}/uploads`);
    expect(request).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: { Authorization: "Bearer glpat-test-only" },
    });
    const form = request?.body;
    if (!(form instanceof FormData)) throw new Error("GitLab takes a multipart form");
    const sent = form.get("file");
    if (!(sent instanceof File)) throw new Error("The form names no file");
    expect(sent.name).toBe("recording.mp4");
    expect(sent.type).toBe("video/mp4");
    expect(Buffer.from(await sent.arrayBuffer()).equals(Buffer.from(file.bytes))).toBe(true);
    expect([...form.keys()]).toEqual(["file"]);
  });

  it.each([
    ["off", false],
    ["absent", undefined],
    ["unreadable", null],
  ])(
    "refuses a private project's upload while its media protection reads %s, sending nothing",
    async (_reading, value) => {
      const { client, fetcher } = arrange({ project: { enforce_auth_checks_on_uploads: value } });
      // Reading the destination does not refuse: a story with no media still publishes.
      expect(await client.destination()).toEqual(destination);
      const refused = await client.upload(destination, attachment()).catch((error) => error);
      expect(refused).toBeInstanceOf(AttachmentUploadError);
      expect(refused).toMatchObject({ outcome: "failed", message: GITLAB_PRIVATE_MEDIA_REFUSAL });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("refuses an internal project's upload without media protection, and lets a public one send", async () => {
    const internal = arrange({
      project: { visibility: "internal", enforce_auth_checks_on_uploads: false },
    });
    const at = { ...destination, visibility: "internal" as const };
    await expect(internal.client.upload(at, attachment())).rejects.toMatchObject({
      outcome: "failed",
      message: GITLAB_PRIVATE_MEDIA_REFUSAL,
    });
    expect(internal.fetcher).not.toHaveBeenCalled();
    const open = arrange({
      project: { visibility: "public", enforce_auth_checks_on_uploads: false },
    });
    await open.client.upload({ ...destination, visibility: "public" }, attachment());
    expect(open.fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses before sending when the project's identity, audience or the key's role changed", async () => {
    for (const changed of [
      { visibility: "public" },
      { id: project.id + 1 },
      { path_with_namespace: "infinitary-labs/infinitary-evidence-test-private" },
      { permissions: { project_access: { access_level: 20 }, group_access: null } },
    ]) {
      const { client, fetcher } = arrange({ project: changed });
      await expect(client.upload(destination, attachment())).rejects.toMatchObject({
        outcome: "failed",
      });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("records a read that failed before sending as failed, never as an uncertain upload", async () => {
    const { client, readProject, fetcher } = arrange();
    readProject.mockRejectedValueOnce(new Error("The project read lost its connection"));
    await expect(client.upload(destination, attachment())).rejects.toMatchObject({
      outcome: "failed",
    });
    const signedOut = arrange({ token: null });
    await expect(signedOut.client.upload(destination, attachment())).rejects.toMatchObject({
      outcome: "failed",
      failure: "sign-in",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(signedOut.fetcher).not.toHaveBeenCalled();
  });

  it("refuses bytes that no longer match the inspected digest", async () => {
    const { client, fetcher } = arrange();
    const file = attachment();
    await expect(
      client.upload(destination, { ...file, sha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ outcome: "failed" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["another project", { full_path: `/-/project/42/uploads/${SECRET}/recording.mp4` }],
    ["another file name", { url: `/uploads/${SECRET}/dk.mp4` }],
    ["an absolute address", { url: `https://gitlab.com/uploads/${SECRET}/recording.mp4` }],
    ["markup alone", { url: undefined, full_path: undefined }],
  ])("keeps an answer that names %s as uncertain, never a receipt", async (_case, changed) => {
    const { client } = arrange({
      response: async () => Response.json({ ...receipt, ...changed }, { status: 201 }),
    });
    await expect(client.upload(destination, attachment())).rejects.toMatchObject({
      outcome: "uncertain",
    });
  });

  it("accepts the older answer that names the project's own nested path", async () => {
    const { client } = arrange({
      response: async () =>
        Response.json(
          {
            ...receipt,
            full_path: `/${project.path_with_namespace}/uploads/${SECRET}/recording.mp4`,
          },
          { status: 201 },
        ),
    });
    expect(await client.upload(destination, attachment())).toEqual({ url: receipt.url });
  });

  it("tells a refusal GitLab answered from a lost or unreadable answer", async () => {
    const lost = arrange({ response: async () => Promise.reject(new Error("socket hang up")) });
    await expect(lost.client.upload(destination, attachment())).rejects.toMatchObject({
      outcome: "uncertain",
    });
    const failing = arrange({
      response: async () => Response.json({ message: "500 Internal" }, { status: 500 }),
    });
    await expect(failing.client.upload(destination, attachment())).rejects.toMatchObject({
      outcome: "uncertain",
    });
    const forbidden = arrange({
      response: async () => Response.json({ message: "403 Forbidden" }, { status: 403 }),
    });
    await expect(forbidden.client.upload(destination, attachment())).rejects.toMatchObject({
      outcome: "failed",
      failure: "permission",
    });
    const signedOut = arrange({
      response: async () => Response.json({ message: "401 Unauthorized" }, { status: 401 }),
    });
    await expect(signedOut.client.upload(destination, attachment())).rejects.toMatchObject({
      outcome: "failed",
      failure: "sign-in",
    });
    expect(signedOut.unauthorized).toHaveBeenCalledTimes(1);
    expect(forbidden.unauthorized).not.toHaveBeenCalled();
    // INF-290 F5: a key GitLab still answers for makes the upload's 401 a permission.
    const stillAnswered = arrange({
      response: async () => Response.json({ message: "401 Unauthorized" }, { status: 401 }),
    });
    stillAnswered.unauthorized.mockResolvedValueOnce("permission");
    await expect(stillAnswered.client.upload(destination, attachment())).rejects.toMatchObject({
      outcome: "failed",
      failure: "permission",
    });
  });

  it("accepts only GitLab's project-relative upload reference", () => {
    expect(gitlabAttachmentUrl(`/uploads/${SECRET}/picture.webp`)).toBe(
      `/uploads/${SECRET}/picture.webp`,
    );
    for (const value of [
      `/uploads/${SECRET}/../picture.webp`,
      `/uploads/${SECRET.slice(1)}/picture.webp`,
      `//uploads/${SECRET}/picture.webp`,
      `/uploads/${SECRET}/picture.svg`,
      `https://github.com/user-attachments/assets/846dced7-16ad-44c0-b6f5-f0e5581165b2`,
    ])
      expect(gitlabAttachmentUrl(value)).toBeUndefined();
  });
});
