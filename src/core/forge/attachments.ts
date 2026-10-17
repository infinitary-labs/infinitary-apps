import { ForgeWriteError } from "./forge";

/** Destination facts read from the host, never inferred from a URL or a private-looking name. */
export type AttachmentDestination = {
  host: string;
  projectId: number;
  fullName: string;
  visibility: "public" | "private" | "internal";
};

export type AttachmentMediaType = "image/png" | "image/jpeg" | "image/webp" | "video/mp4";

/** The exact validated upload copy. Source names and paths never reach the host. */
export type UploadAttachment = {
  bytes: Uint8Array;
  sha256: string;
  mediaType: AttachmentMediaType;
};

/** No generic retry can safely replay a POST once its outcome is uncertain. */
export class AttachmentUploadError extends ForgeWriteError {
  constructor(
    outcome: "failed" | "uncertain",
    failure: ConstructorParameters<typeof ForgeWriteError>[1],
    message: string,
  ) {
    super(outcome, failure, message);
    this.name = "AttachmentUploadError";
  }
}

/** Optional native attachments, never a JSON-gateway escape hatch. */
export interface ForgeAttachments {
  destination(): Promise<AttachmentDestination>;
  upload(expected: AttachmentDestination, attachment: UploadAttachment): Promise<{ url: string }>;
}

export function sameAttachmentDestination(
  left: AttachmentDestination,
  right: AttachmentDestination,
): boolean {
  return (
    left.host === right.host &&
    left.projectId === right.projectId &&
    left.fullName === right.fullName &&
    left.visibility === right.visibility
  );
}
