// The checks a published docs site must pass over plain HTTP (docs/docs-site.md,
// "Publishing"). check-live.mjs runs them against the live site after each
// publish, then opens every page in a browser; a publish whose checks fail is
// not a published site, whatever the upload said.

/** Headers every answer carries, from the build's dist/_headers, each with what its value must say. */
export const REQUIRED_HEADERS = Object.freeze({
  "content-security-policy": /default-src 'none'.*frame-ancestors 'none'/,
  "strict-transport-security": /max-age=\d+/,
  "x-content-type-options": /^nosniff$/,
  "x-frame-options": /^DENY$/,
  "referrer-policy": /^strict-origin-when-cross-origin$/,
  "cross-origin-opener-policy": /^same-origin$/,
  "cross-origin-resource-policy": /^same-origin$/,
});

const check = (name, ok, detail = "") => ({ name, ok: Boolean(ok), detail });

function headerChecks(label, response) {
  const wrong = Object.entries(REQUIRED_HEADERS)
    .filter(([name, pattern]) => !pattern.test(response.headers.get(name) ?? ""))
    .map(([name]) => name);
  return [
    check(`${label}: security headers`, wrong.length === 0, wrong.length ? `missing or wrong: ${wrong.join(", ")}` : ""),
    check(`${label}: no cookie`, !response.headers.get("set-cookie")),
    // Without it, Cloudflare's edge changes a page on its way, adding Web Analytics' script.
    check(`${label}: says no-transform`, /(^|,)\s*no-transform\s*(,|$)/.test(response.headers.get("cache-control") ?? "")),
  ];
}

/** Where served first differs from built, and what the answer holds from there, for a failed check's detail. */
function difference(served, built) {
  let at = 0;
  while (at < served.length && at < built.length && served[at] === built[at]) at++;
  const from = Math.max(0, served.lastIndexOf("<", at));
  const excerpt = served.slice(from, from + 100).replace(/\s+/g, " ");
  return `${served.length} characters served, ${built.length} built; from character ${from} the answer holds: ${excerpt || "nothing"}`;
}

/** The pages checked, each with the file in dist/ it must arrive as. */
export const BUILT_FILES = Object.freeze({ home: "index.html", inner: "install/index.html", notFound: "404.html" });

/** The pages checked in a shipped language other than English, by its address segment, each with its built file. */
export function languageFiles(segment) {
  return { [`${segment}:home`]: `${segment}/index.html`, [`${segment}:inner`]: `${segment}/install/index.html` };
}

/**
 * Checks the site at origin and answers one result per check, never throwing
 * for a failed one. built holds each of BUILT_FILES' pages as the build wrote
 * it, keyed like BUILT_FILES, so a page changed on its way to a browser fails.
 * fetchImpl is the global fetch, or a stand-in in tests.
 *
 * languages names each shipped language's address segment other than
 * English's, whose home and inner pages are checked the same way, keyed in
 * built as languageFiles names them; unshipped names a catalog language that
 * has not shipped, whose addresses must move to the same English page
 * (docs/docs-site.md, "Languages").
 */
export async function checkLive(origin, { built, fetchImpl = fetch, languages = [], unshipped }) {
  const base = new URL(origin).origin;
  // Browsers name text/html, and Cloudflare's edge changes a page only for a request that does.
  const get = (url) => fetchImpl(url, { redirect: "manual", headers: { accept: "text/html" } });
  const asBuilt = (label, html, key) =>
    check(`${label}: exactly as built`, html === built[key], html === built[key] ? "" : difference(html, built[key]));
  const results = [];

  for (const [label, path, key] of [
    ["home page", "/", "home"],
    ["inner page", "/install/", "inner"],
    ...languages.flatMap((segment) => [
      [`${segment} home page`, `/${segment}/`, `${segment}:home`],
      [`${segment} inner page`, `/${segment}/install/`, `${segment}:inner`],
    ]),
  ]) {
    const response = await get(`${base}${path}`);
    const html = await response.text();
    results.push(check(`${label}: answers 200`, response.status === 200, `${response.status}`));
    results.push(check(`${label}: HTML`, (response.headers.get("content-type") ?? "").startsWith("text/html")));
    results.push(check(`${label}: the site's own page`, /<title>[^<]*\| Infinitary<\/title>/.test(html)));
    results.push(asBuilt(label, html, key));
    results.push(...headerChecks(label, response));
  }

  const missing = await get(`${base}/no-such-page-${Date.now().toString(36)}/`);
  const missingHtml = await missing.text();
  results.push(check("unknown address: answers 404", missing.status === 404, `${missing.status}`));
  results.push(check("unknown address: the site's own not-found page", /<title>404 \| Infinitary<\/title>/.test(missingHtml)));
  results.push(asBuilt("unknown address", missingHtml, "notFound"));
  results.push(...headerChecks("unknown address", missing));

  if (unshipped) {
    const moved = await get(`${base}/${unshipped}/install/`);
    const location = new URL(moved.headers.get("location") ?? "/nowhere", base).pathname;
    results.push(
      check(
        `${unshipped}, not shipped yet: moves to the English page`,
        moved.status === 302 && location === "/install/",
        `${moved.status} -> ${location}`,
      ),
    );
  }

  // Cloudflare moves the zone's plain http addresses to https; a local copy serves plain http itself.
  if (base.startsWith("https://")) {
    const plain = await get(`${base.replace(/^https:/, "http:")}/install/?ref=check`);
    const location = plain.headers.get("location") ?? "";
    results.push(
      check(
        "plain http: moves to https",
        [301, 308].includes(plain.status) && location === `${base}/install/?ref=check`,
        `${plain.status} -> ${location}`,
      ),
    );
  }

  return results;
}
