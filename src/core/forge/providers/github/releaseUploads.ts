import { GITHUB_COM, isGitHubEnterpriseCloud } from "@shared/forge";
import { notSignedInText } from "@shared/forges";
import {
  type ApiProject,
  type ApiRoute,
  type ForgeApiResponse,
  parseApiRequest,
  type ReleaseUpload,
} from "../../api";
import { ForgeError } from "../../forge";
import { RELEASE_UPLOAD_TIMEOUT_MS } from "../../releaseFile";

const API_VERSION = "2022-11-28";
const RELEASE_ASSET = /^releases\/\d+\/assets$/;

/**
 * Where a release file goes (`docs/forge.md`, "Release files"): github.com's
 * `uploads.github.com`, a GitHub Enterprise Cloud host's `uploads.<name>.ghe.com`,
 * or a GitHub Enterprise Server's `/api/uploads`. An unpackaged API stand-in
 * is not this address; the forge sends the file to the stand-in instead.
 */
export function githubUploadOrigin(host: string): string {
  if (host === GITHUB_COM) return "https://uploads.github.com";
  if (isGitHubEnterpriseCloud(host)) return `https://uploads.${host}`;
  return `https://${host}/api/uploads`;
}

export type GitHubReleaseUploadEnv = {
  base: string;
  place: string;
  host: string | null;
  fetch: typeof fetch;
  token: () => Promise<string | undefined>;
  apiProject: () => ApiProject | null;
  /** The API base of this host as GitHub itself serves it, which a stand-in's base differs from. */
  canonicalBase: () => string;
  readAnswer: (response: Response) => Promise<ForgeApiResponse>;
};

/** Where a release file may go on this host, and the streaming of it (`docs/forge.md`, "Release files"). */
export class GitHubReleaseUploads {
  constructor(private readonly env: GitHubReleaseUploadEnv) {}

  /**
   * The release's own upload address, or a relative assets path, accepted
   * only on this host's upload origin. A stand-in's origin is the API base
   * the test pointed here, never uploads.github.com.
   */
  releaseUploadRoute(raw: string, filename: string): ApiRoute {
    const relative = this.releaseAssetPath(raw, filename);
    const route = parseApiRequest("POST", relative, this.env.apiProject(), 0);
    const rest = route.rest
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/")
      .replace(/\/+$/, "");
    if (!RELEASE_ASSET.test(rest)) {
      throw new ForgeError(
        "refused",
        "A release file goes to the release's upload address, /repos/{owner}/{repo}/releases/{id}/assets, not this path.",
      );
    }
    return route;
  }

  private releaseAssetPath(raw: string, filename: string): string {
    const relative = /^https?:\/\//i.test(raw) ? this.uploadPath(raw) : raw;
    const queryAt = relative.indexOf("?");
    const base = queryAt === -1 ? relative : relative.slice(0, queryAt);
    const params = new URLSearchParams(queryAt === -1 ? "" : relative.slice(queryAt + 1));
    if (!params.get("name")) params.set("name", filename);
    const kept = new URLSearchParams();
    const name = params.get("name");
    const label = params.get("label");
    if (name) kept.set("name", name);
    if (label) kept.set("label", label);
    const query = kept.toString();
    return query ? `${base}?${query}` : base;
  }

  private uploadPath(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ForgeError("refused", "The upload address could not be read.");
    }
    if (url.username || url.password || url.origin !== new URL(this.uploadOrigin()).origin) {
      throw new ForgeError(
        "refused",
        "A release file is accepted only on GitHub's upload address.",
      );
    }
    if (/[{}]|%7[Bb]|%7[Dd]/.test(`${url.pathname}${url.search}`)) {
      throw new ForgeError(
        "refused",
        "Replace {?name,label} in the release's upload address with ?name= and the file's name.",
      );
    }
    const prefix = this.uploadPrefix();
    if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      throw new ForgeError(
        "refused",
        "A release file is accepted only on GitHub's upload address.",
      );
    }
    const pathname = prefix ? url.pathname.slice(prefix.length) || "/" : url.pathname;
    if (!pathname.startsWith("/")) {
      throw new ForgeError(
        "refused",
        "A release file is accepted only on GitHub's upload address.",
      );
    }
    return `${pathname}${url.search}`;
  }

  /** The path under the upload origin, such as `/api/uploads` on GitHub Enterprise Server. */
  private uploadPrefix(): string {
    const pathname = new URL(this.uploadOrigin()).pathname.replace(/\/+$/, "");
    return pathname === "" || pathname === "/" ? "" : pathname;
  }

  /** github.com's upload host, or the stand-in when this forge was pointed at one. */
  uploadOrigin(): string {
    const canonical = this.env.canonicalBase();
    if (this.env.base !== canonical) return this.env.base;
    return githubUploadOrigin(this.env.host ?? GITHUB_COM);
  }

  /** Stream the file to the upload origin. Redirects are never followed; the answer stays bounded. */
  async uploadRelease(route: ApiRoute, file: ReleaseUpload): Promise<ForgeApiResponse> {
    const token = await this.env.token();
    if (!token) {
      throw new ForgeError("sign-in", notSignedInText(this.env.place, this.env.host ?? GITHUB_COM));
    }
    const origin = this.uploadOrigin().replace(/\/+$/, "");
    const url = `${origin}${route.path}`;
    if (new URL(url).origin !== new URL(origin).origin) {
      throw new ForgeError(
        "refused",
        "A release file is accepted only on GitHub's upload address.",
        true,
      );
    }
    let response: Response;
    try {
      response = await this.env.fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "Content-Type": file.contentType,
          "Content-Length": String(file.size),
        },
        // Node's fetch reads a stream and requires duplex; the DOM types name neither.
        body: file.stream,
        duplex: "half",
        signal: AbortSignal.timeout(RELEASE_UPLOAD_TIMEOUT_MS),
      } as unknown as RequestInit);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new ForgeError("transient", `could not reach ${this.env.place}: ${message}`);
    }
    return this.env.readAnswer(response);
  }
}
