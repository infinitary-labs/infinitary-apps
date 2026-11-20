/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/forge/providers/bitbucket/
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for Bitbucket Cloud's REST API (`/2.0`), over real HTTP
 * so the app runs its real token sign-in and project listing against it.
 * The app finds it through `INFINITARY_BITBUCKET_API_URL`, which only an
 * unpackaged app reads; no real account is ever asked.
 *
 * It answers the way Bitbucket does (docs/e2e-contracts.md, "Keep
 * fixtures truthful"): the account for the one token it accepts and a
 * 401 for any other, Bitbucket's answer to a revoked token; the account's workspaces; each workspace's repositories,
 * newest first, paged by an absolute `next` link on the same API; and one
 * repository by `workspace/name`, with a 404 for any other.
 */
export const BITBUCKET_STUB_KEY = "ATATT3xFfGF0hermetic_sign-in-key=0A1B2C3D";
/** The token the person makes after revoking the first one. */
export const BITBUCKET_STUB_NEW_KEY = "ATATT3xFfGF0hermetic_second-key=4E5F6A7B";
export const BITBUCKET_STUB_LOGIN = "octo";
/** The project the journey clones, in the second workspace's second page. */
export const BITBUCKET_STUB_PROJECT = "field-team/field-notes";

const WORKSPACES = ["octo", "field-team", "archive"];
/** An old workspace with more pages than Add project's listing reads. */
const ARCHIVE_PAGES = 12;
/**
 * The archive's oldest repository, on its last page: the listing stops
 * before it, so the journey adds it by its link.
 */
export const BITBUCKET_STUB_UNLISTED = `archive/old-${ARCHIVE_PAGES}`;
/** Each workspace's repositories, newest first, as Bitbucket lists them. */
const REPOSITORIES: Record<string, { name: string; updated: string; isPrivate: boolean }[][]> = {
  octo: [[{ name: "dotfiles", updated: "2026-11-12T09:30:00.000000+00:00", isPrivate: false }]],
  "field-team": [
    [{ name: "survey-app", updated: "2026-11-14T16:05:00.000000+00:00", isPrivate: true }],
    [{ name: "field-notes", updated: "2026-11-10T11:20:00.000000+00:00", isPrivate: true }],
  ],
  archive: Array.from({ length: ARCHIVE_PAGES }, (_, index) => [
    {
      name: `old-${index + 1}`,
      // Newest first, as Bitbucket sorts by `-updated_on`: one day older per page.
      updated: `2025-10-${String(ARCHIVE_PAGES + 10 - index).padStart(2, "0")}T08:00:00.000000+00:00`,
      isPrivate: true,
    },
  ]),
};

export async function startBitbucketStub() {
  const requests: string[] = [];
  let base = "";
  let accepted = BITBUCKET_STUB_KEY;
  const repository = (
    workspace: string,
    row: { name: string; updated: string; isPrivate: boolean },
  ) => ({
    type: "repository",
    full_name: `${workspace}/${row.name}`,
    name: row.name,
    is_private: row.isPrivate,
    updated_on: row.updated,
    links: {
      html: { href: `https://bitbucket.org/${workspace}/${row.name}` },
      clone: [
        {
          name: "https",
          href: `https://${BITBUCKET_STUB_LOGIN}@bitbucket.org/${workspace}/${row.name}.git`,
        },
        { name: "ssh", href: `git@bitbucket.org:${workspace}/${row.name}.git` },
      ],
    },
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${accepted}`) {
      send(401, {
        type: "error",
        error: { message: "Token is invalid, expired, or not supported for this endpoint." },
      });
      return;
    }
    const path = url.pathname.replace(/^\/2\.0/, "");
    const page = Number(url.searchParams.get("page") ?? "1");
    if (method === "GET" && path === "/user") {
      send(200, {
        type: "user",
        display_name: "Octo Cat",
        nickname: BITBUCKET_STUB_LOGIN,
        account_id: "557058:00000000-0000-0000-0000-000000000000",
        uuid: "{00000000-0000-0000-0000-000000000001}",
      });
      return;
    }
    if (method === "GET" && path === "/user/workspaces") {
      send(200, {
        pagelen: 100,
        page: 1,
        size: WORKSPACES.length,
        values: WORKSPACES.map((slug) => ({
          type: "workspace_access",
          workspace: { type: "workspace", slug, name: slug },
        })),
      });
      return;
    }
    const listing = /^\/repositories\/([^/]+)$/.exec(path);
    if (method === "GET" && listing) {
      const pages = REPOSITORIES[decodeURIComponent(listing[1] ?? "")];
      if (!pages) {
        send(404, { type: "error", error: { message: "No workspace with identifier" } });
        return;
      }
      const workspace = decodeURIComponent(listing[1] ?? "");
      const rows = pages[page - 1] ?? [];
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      send(200, {
        pagelen: 100,
        page,
        values: rows.map((row) => repository(workspace, row)),
        ...(page < pages.length ? { next: `${base}${path}${next.search}` } : {}),
      });
      return;
    }
    const one = /^\/repositories\/([^/]+)\/([^/]+)$/.exec(path);
    if (method === "GET" && one) {
      const workspace = decodeURIComponent(one[1] ?? "");
      const row = (REPOSITORIES[workspace] ?? [])
        .flat()
        .find((entry) => entry.name === decodeURIComponent(one[2] ?? ""));
      if (row) send(200, repository(workspace, row));
      else send(404, { type: "error", error: { message: "Repository not found" } });
      return;
    }
    send(404, { type: "error", error: { message: "Resource not found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/2.0`;
  return {
    env: { INFINITARY_BITBUCKET_API_URL: base },
    /** Every request, `METHOD /path` (query dropped). */
    requests: () => [...requests],
    /** The person revoked the first token and made a new one: only that one is accepted now. */
    revokeFirstKey: () => {
      accepted = BITBUCKET_STUB_NEW_KEY;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
