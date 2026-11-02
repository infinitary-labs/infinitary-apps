import { createHash } from "node:crypto";
import { notSignedInText } from "@shared/forges";
import { z } from "zod";
import {
  type AttachmentDestination,
  type AttachmentUnauthorized,
  AttachmentUploadError,
  type ForgeAttachments,
  sameAttachmentDestination,
  type UploadAttachment,
} from "../../attachments";
import { ForgeError } from "../../forge";

const UPLOAD_BASE = "https://uploads.github.com";
const RESPONSE_LIMIT = 16 * 1024;
const TIMEOUT_MS = 60_000;
/** Stay below GitHub's documented 10 MB video allowance, including on a free plan. */
export const GITHUB_VIDEO_BYTES = 9_999_999;
const IMAGE_BYTES = 8 * 1024 * 1024;
const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
} as const;

const repositorySchema = z.object({
  id: z.number().int().positive().safe(),
  full_name: z.string().min(1),
  private: z.boolean(),
  visibility: z.enum(["private", "public", "internal"]),
  permissions: z.object({
    push: z.boolean().optional(),
    maintain: z.boolean().optional(),
    admin: z.boolean().optional(),
  }),
});

/** Only the documented user-attachment shape; never returned markup or a signed storage address. */
export function githubAttachmentUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  )
    ? value
    : undefined;
}

/** One identity/audience reader for stories and their optional native uploads. */
export function githubStoryDestination(
  value: unknown,
  fullName: string,
  host: string,
): AttachmentDestination {
  const result = repositorySchema.safeParse(value);
  if (!result.success)
    throw new ForgeError(
      "refused",
      "GitHub did not confirm the attachment destination and audience.",
    );
  const repo = result.data;
  if (
    repo.full_name.toLowerCase() !== fullName.toLowerCase() ||
    (repo.visibility === "public" && repo.private) ||
    (repo.visibility === "private" && !repo.private)
  )
    throw new ForgeError(
      "refused",
      "The attachment destination or audience changed. Prepare the story again.",
    );
  if (!(repo.permissions.push || repo.permissions.maintain || repo.permissions.admin))
    throw new ForgeError(
      "permission",
      "Uploading evidence needs write access to this GitHub project.",
    );
  return {
    host,
    projectId: repo.id,
    fullName: repo.full_name,
    visibility: repo.visibility,
  };
}

/** Native uploads using only the app's supplied sign-in. No redirect, token fallback or retry. */
export class GitHubAttachments implements ForgeAttachments {
  constructor(
    private readonly options: {
      fullName: string;
      token: () => Promise<string | undefined>;
      /** The owning forge's redirect-refusing, bounded repository read. */
      readRepository: () => Promise<unknown>;
      /** The owning forge's upload origin; its unpackaged API override keeps tests local. */
      uploadBaseUrl?: string;
      fetch?: typeof fetch;
      /** The owning forge's check of a 401: whether GitHub still answers for the key. */
      unauthorized: AttachmentUnauthorized;
    },
  ) {}

  async destination(): Promise<AttachmentDestination> {
    return githubStoryDestination(
      await this.options.readRepository(),
      this.options.fullName,
      "github.com",
    );
  }

  async upload(
    expected: AttachmentDestination,
    attachment: UploadAttachment,
  ): Promise<{ url: string }> {
    // Copy before the first await so a caller cannot replace bytes after validation.
    const bytes = new Uint8Array(attachment.bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const extension = EXTENSIONS[attachment.mediaType];
    const limit = attachment.mediaType === "video/mp4" ? GITHUB_VIDEO_BYTES : IMAGE_BYTES;
    if (!extension || !bytes.length || bytes.length > limit || digest !== attachment.sha256)
      throw new AttachmentUploadError(
        "failed",
        "refused",
        "The upload copy has changed, is too large, or has an unsupported format.",
      );
    let token: string | undefined;
    let current: AttachmentDestination;
    try {
      token = await this.options.token();
      if (!token)
        throw new AttachmentUploadError(
          "failed",
          "sign-in",
          notSignedInText("GitHub", "github.com"),
        );
      // GitHub's client and no-mistakes refuse App-user and installation keys for this route.
      // Do not inspect another store or substitute another kind of sign-in.
      if (!/^(gho_|ghp_|github_pat_)/.test(token))
        throw new AttachmentUploadError(
          "failed",
          "permission",
          "GitHub's native attachment route does not support this kind of sign-in. No file was sent.",
        );
      current = await this.destination();
      if (!sameAttachmentDestination(expected, current))
        throw new AttachmentUploadError(
          "failed",
          "refused",
          "The attachment destination or audience changed. No file was sent.",
        );
    } catch (error) {
      if (error instanceof AttachmentUploadError) throw error;
      throw new AttachmentUploadError(
        "failed",
        error instanceof ForgeError ? error.failure : "transient",
        "GitHub access could not be checked before uploading. No file was sent.",
      );
    }
    const base = (this.options.uploadBaseUrl ?? UPLOAD_BASE).replace(/\/+$/, "");
    const url = new URL(`${base}/user-attachments/assets`);
    // GitHub shows this name above its player. Identity belongs to the receipt's digest,
    // not the display name; never expose a source path or a long hash in that header.
    url.searchParams.set(
      "name",
      `${attachment.mediaType === "video/mp4" ? "recording" : "picture"}.${extension}`,
    );
    url.searchParams.set("content_type", attachment.mediaType);
    url.searchParams.set("repository_id", String(current.projectId));
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/octet-stream",
        },
        body: bytes,
      });
    } catch {
      // Even a timeout can follow a successful write. Do not expose fetch errors or credentials.
      throw uncertain();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const rejected = [400, 401, 403, 404, 413, 415, 422, 429].includes(response.status);
      if (!rejected) throw uncertain();
      throw new AttachmentUploadError(
        "failed",
        response.status === 401
          ? await this.options.unauthorized().catch(() => "sign-in" as const)
          : response.status === 403
            ? "permission"
            : "refused",
        `GitHub refused the evidence upload (${response.status}). No pull request was opened; there is no fallback.`,
      );
    }
    try {
      const reader = response.body?.getReader();
      if (!reader) throw uncertain();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > RESPONSE_LIMIT) {
          await reader.cancel();
          throw uncertain();
        }
        chunks.push(next.value);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const returned = z.object({ url: z.unknown() }).parse(parsed);
      const confirmed = githubAttachmentUrl(returned.url);
      if (!confirmed) throw uncertain();
      return { url: confirmed };
    } catch {
      throw uncertain();
    }
  }
}

function uncertain(): AttachmentUploadError {
  return new AttachmentUploadError(
    "uncertain",
    "refused",
    "GitHub may have kept the attachment, but no confirmed receipt returned. It will not be sent again automatically; the possible orphan needs reconciliation before a deliberate new attempt.",
  );
}
