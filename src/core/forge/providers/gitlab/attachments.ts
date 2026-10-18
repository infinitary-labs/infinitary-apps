import { createHash } from "node:crypto";
import { notSignedInText } from "@shared/forges";
import { z } from "zod";
import {
  type AttachmentDestination,
  type AttachmentMediaType,
  type AttachmentUnauthorized,
  AttachmentUploadError,
  type ForgeAttachments,
  sameAttachmentDestination,
  type UploadAttachment,
} from "../../attachments";
import { ForgeError } from "../../forge";

const RESPONSE_LIMIT = 16 * 1024;
const TIMEOUT_MS = 60_000;
/** The staged story's own limits: an image up to 8 MiB, a recording below 10,000,000 bytes. */
const IMAGE_BYTES = 8 * 1024 * 1024;
const VIDEO_BYTES = 9_999_999;
/** GitLab's Developer role, the least that pushes the story's branch. */
const DEVELOPER = 30;
const NAMES: Record<AttachmentMediaType, string> = {
  "image/png": "picture.png",
  "image/jpeg": "picture.jpg",
  "image/webp": "picture.webp",
  "video/mp4": "recording.mp4",
};

/** The short name GitLab keeps and shows; identity belongs to the receipt's digest. */
export function gitlabAttachmentName(mediaType: AttachmentMediaType): string {
  return NAMES[mediaType];
}

/** Only GitLab's project-relative upload reference; never returned markup or another address. */
export function gitlabAttachmentUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^\/uploads\/[0-9a-f]{32}\/(?:recording\.mp4|picture\.(?:png|jpg|webp))$/.test(value)
    ? value
    : undefined;
}

/** What GitLab must say before anything is sent: refused in words, never guessed from a URL. */
export const GITLAB_PRIVATE_MEDIA_REFUSAL =
  'This private GitLab project lets anyone with an upload\'s link open it, because GitLab does not report its "Require authentication to view media files" setting as on. No file was sent and no merge request was opened. A maintainer can turn that setting on under Settings > General > Visibility, project features, permissions; the app never changes it.';

const access = z.object({ access_level: z.number() }).nullable().optional();
const projectSchema = z.object({
  id: z.number().int().positive().safe(),
  path_with_namespace: z.string().min(1),
  visibility: z.enum(["private", "internal", "public"]),
  /** Explicitly true or the upload is refused; absent, null or false never pass. */
  enforce_auth_checks_on_uploads: z.unknown().optional(),
  permissions: z.object({ project_access: access, group_access: access }).nullable().optional(),
});

/**
 * Native gitlab.com uploads (INF-132): multipart `POST /projects/:id/uploads`
 * with the app's own sign-in, to the numeric project the fresh read confirmed.
 * A private or internal project's file is sent only while GitLab reads its
 * media protection as on; production publication never changes that setting.
 * No redirect, fallback or retry.
 */
export class GitLabAttachments implements ForgeAttachments {
  constructor(
    private readonly options: {
      /** The project's whole nested path, `group/subgroup/name`. */
      fullName: string;
      apiBaseUrl: string;
      token: () => Promise<string | undefined>;
      /** The owning forge's redirect-refusing, bounded project read. */
      readProject: () => Promise<unknown>;
      fetch?: typeof fetch;
      /** The owning client's check of a 401, the one it makes for every other route. */
      unauthorized: AttachmentUnauthorized;
    },
  ) {}

  async destination(): Promise<AttachmentDestination> {
    return (await this.read()).destination;
  }

  private async read(): Promise<{ destination: AttachmentDestination; mediaSignedIn: boolean }> {
    const result = projectSchema.safeParse(await this.options.readProject());
    if (!result.success)
      throw new ForgeError(
        "refused",
        "GitLab did not confirm the attachment destination and audience.",
      );
    const project = result.data;
    if (project.path_with_namespace.toLowerCase() !== this.options.fullName.toLowerCase())
      throw new ForgeError(
        "refused",
        "The attachment destination or audience changed. Prepare the story again.",
      );
    const levels = [
      project.permissions?.project_access?.access_level,
      project.permissions?.group_access?.access_level,
    ].filter((level): level is number => typeof level === "number");
    // An inherited role GitLab does not list leaves the decision to GitLab's own answer.
    if (levels.length > 0 && Math.max(...levels) < DEVELOPER)
      throw new ForgeError(
        "permission",
        "Uploading evidence needs at least the Developer role in this GitLab project.",
      );
    return {
      destination: {
        host: "gitlab.com",
        projectId: project.id,
        fullName: project.path_with_namespace,
        visibility: project.visibility,
      },
      mediaSignedIn: project.enforce_auth_checks_on_uploads === true,
    };
  }

  async upload(
    expected: AttachmentDestination,
    attachment: UploadAttachment,
  ): Promise<{ url: string }> {
    // Copy before the first await so a caller cannot replace bytes after validation.
    const bytes = new Uint8Array(attachment.bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const name = NAMES[attachment.mediaType];
    const limit = attachment.mediaType === "video/mp4" ? VIDEO_BYTES : IMAGE_BYTES;
    if (!name || !bytes.length || bytes.length > limit || digest !== attachment.sha256)
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
          notSignedInText("GitLab", "gitlab.com"),
        );
      const read = await this.read();
      current = read.destination;
      if (!sameAttachmentDestination(expected, current))
        throw new AttachmentUploadError(
          "failed",
          "refused",
          "The attachment destination or audience changed. No file was sent.",
        );
      // GitLab serves a private project's upload to anyone with its link unless
      // this protection is on; a guessed default or an unguessable address is not enough.
      if (current.visibility !== "public" && !read.mediaSignedIn)
        throw new AttachmentUploadError("failed", "refused", GITLAB_PRIVATE_MEDIA_REFUSAL);
    } catch (error) {
      if (error instanceof AttachmentUploadError) throw error;
      throw new AttachmentUploadError(
        "failed",
        error instanceof ForgeError ? error.failure : "transient",
        `GitLab access could not be checked before uploading. No file was sent.${error instanceof ForgeError ? ` ${error.message}` : ""}`,
      );
    }
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: attachment.mediaType }), name);
    let response: Response;
    try {
      // The numeric identity the read confirmed, never a path a rename could hand to another project.
      response = await (this.options.fetch ?? fetch)(
        `${this.options.apiBaseUrl}/projects/${current.projectId}/uploads`,
        {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          body: form,
        },
      );
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
        `GitLab refused the evidence upload (${response.status}). No merge request was opened; there is no fallback.`,
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
      const returned = z.object({ url: z.unknown(), full_path: z.unknown() }).parse(parsed);
      const reference = gitlabAttachmentUrl(returned.url);
      const secret = reference?.split("/")[2];
      // The returned reference names this file in this project: the numeric
      // form GitLab answers now, or the project's own path an older answer used.
      const placed = [
        `/-/project/${current.projectId}/uploads/${secret}/${name}`,
        `/${current.fullName}/uploads/${secret}/${name}`.toLowerCase(),
      ];
      if (
        !reference?.endsWith(`/${name}`) ||
        typeof returned.full_path !== "string" ||
        !placed.includes(
          returned.full_path.startsWith("/-/")
            ? returned.full_path
            : returned.full_path.toLowerCase(),
        )
      )
        throw uncertain();
      return { url: reference };
    } catch {
      throw uncertain();
    }
  }
}

function uncertain(): AttachmentUploadError {
  return new AttachmentUploadError(
    "uncertain",
    "refused",
    "GitLab may have kept the attachment, but no confirmed receipt returned. It will not be sent again automatically; the possible orphan needs reconciliation before a deliberate new attempt.",
  );
}
