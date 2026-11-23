// The docs site for docs.getinfinitary.com (docs/docs-site.md).
// It builds to plain files in dist/ and asks no other host for anything.
import { createHash } from "node:crypto";
import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import starlight from "@astrojs/starlight";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import {
  catalogRedirects,
  SITE_ORIGIN,
  SOURCE_LANGUAGE,
  starlightLocales,
  translationsOf,
  wordsOf,
} from "./languages.ts";
import { sentenceLines } from "./sentence-lines.mjs";

// The app's own icon, read from the design system rather than copied into this folder.
const APP_ICON = new URL("../.claude/skills/infinitary-design/assets/app-icon.svg", import.meta.url);

/** Puts the app's icon at /favicon.svg in the built site. */
function appIcon() {
  return {
    name: "infinitary-app-icon",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        await copyFile(APP_ICON, new URL("favicon.svg", dir));
      },
    },
  };
}

// What Cloudflare's asset server sends on its own: a browser asks again each time.
const PAGE_CACHE = "public, max-age=0, must-revalidate";

/** Every built HTML file under dir. */
async function htmlFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Writes dist/_headers, the security headers Cloudflare's asset server sends
 * with every file (docs/docs-site.md, "Publishing"). The pages' own inline
 * scripts (Starlight's theme and sidebar) are allowed by their hashes, read
 * from the built pages, so no other script can run; search runs WebAssembly
 * from the site's own files.
 *
 * Every page, the not-found page included, says no-transform, so Cloudflare's
 * edge passes it on as built: without it, the zone's Web Analytics adds its
 * script to each page a browser asks for. No-transform also stops Cloudflare
 * compressing the answer, so the folders of files the build writes beside
 * the pages detach it and keep their compression.
 */
function securityHeaders() {
  return {
    name: "infinitary-security-headers",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        const hashes = new Set();
        for (const file of await htmlFiles(fileURLToPath(dir))) {
          const html = await readFile(file, "utf8");
          for (const [, body] of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
            hashes.add(`'sha256-${createHash("sha256").update(body).digest("base64")}'`);
          }
        }
        const policy = [
          "default-src 'none'",
          `script-src 'self' 'wasm-unsafe-eval' ${[...hashes].sort().join(" ")}`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "font-src 'self' data:",
          "connect-src 'self'",
          "manifest-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
          "object-src 'none'",
        ].join("; ");
        const headers = [
          "/*",
          `  Content-Security-Policy: ${policy}`,
          "  Strict-Transport-Security: max-age=31536000",
          "  X-Content-Type-Options: nosniff",
          "  X-Frame-Options: DENY",
          "  Referrer-Policy: strict-origin-when-cross-origin",
          "  Cross-Origin-Opener-Policy: same-origin",
          "  Cross-Origin-Resource-Policy: same-origin",
          "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          `  Cache-Control: ${PAGE_CACHE}, no-transform`,
          "",
          "# Astro fingerprints every file under /_astro/, so a changed file gets a new name.",
          "/_astro/*",
          "  ! Cache-Control",
          "  Cache-Control: public, max-age=31536000, immutable",
          "",
          "# The search index, rebuilt with every page.",
          "/pagefind/*",
          "  ! Cache-Control",
          `  Cache-Control: ${PAGE_CACHE}`,
          "",
        ].join("\n");
        await writeFile(new URL("_headers", dir), headers);
      },
    },
  };
}

/**
 * Writes dist/_redirects (docs/docs-site.md, "Languages"): each catalog
 * language that has not shipped sends its addresses to the same English page.
 */
function languageRedirects() {
  return {
    name: "infinitary-language-redirects",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        await writeFile(new URL("_redirects", dir), `${catalogRedirects().join("\n")}\n`);
      },
    },
  };
}

/**
 * Names the English page as each sitemap entry's x-default alternate, as
 * every page's head does (docs/docs-site.md, "Languages"): Starlight's
 * sitemap names only the languages themselves. Starlight adds its sitemap
 * while setting up, so this adds itself after it to run once it is written.
 */
function sitemapDefault() {
  const after = {
    name: "infinitary-sitemap-default",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        const english = `hreflang="${SOURCE_LANGUAGE}" href="`;
        for (const name of await readdir(dir)) {
          if (!/^sitemap-\d+\.xml$/.test(name)) continue;
          const file = new URL(name, dir);
          const xml = (await readFile(file, "utf8")).replace(/<url>[\s\S]*?<\/url>/g, (entry) => {
            const at = entry.indexOf(english);
            if (at === -1 || entry.includes('hreflang="x-default"')) return entry;
            const href = entry.slice(at + english.length, entry.indexOf('"', at + english.length));
            return entry.replace("</url>", `<xhtml:link rel="alternate" hreflang="x-default" href="${href}"/></url>`);
          });
          await writeFile(file, xml);
        }
      },
    },
  };
  return {
    name: "infinitary-sitemap-default-setup",
    hooks: { "astro:config:setup": ({ updateConfig }) => updateConfig({ integrations: [after] }) },
  };
}

/**
 * Lets a heading name its own id (`## المتطلبات {#requirements}`), so a
 * translated page keeps the English page's heading ids and every link to a
 * heading works the same in every language (docs/docs-site.md, "Languages").
 */
function headingIds() {
  return {
    name: "infinitary-heading-ids",
    hooks: {
      "astro:config:setup": ({ config }) => {
        config.markdown.processor.options.features.headingAttributes = true;
      },
    },
  };
}

/**
 * Joins a Chinese or Japanese paragraph's sentence lines with nothing between
 * them, where a browser would draw each line break as a space; every other
 * language keeps its space (docs/docs-site.md, "Translated pages").
 */
function joinedSentenceLines() {
  return {
    name: "infinitary-sentence-lines",
    hooks: {
      "astro:config:setup": ({ config }) => {
        config.markdown.processor.options.mdastPlugins.push(sentenceLines);
      },
    },
  };
}

/** A sidebar group's or link's label in English and in each language whose words file has it. */
const label = (key) => ({ label: wordsOf(SOURCE_LANGUAGE)[key], translations: translationsOf(key) });

export default defineConfig({
  site: SITE_ORIGIN,
  integrations: [
    starlight({
      title: "Infinitary",
      // English at the root, each shipped language under its tag in lowercase.
      defaultLocale: "root",
      locales: starlightLocales(),
      description: "How to use Infinitary, your own AI studio.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/infinitary.css"],
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
        FallbackContentNotice: "./src/components/FallbackContentNotice.astro",
      },
      social: [{ icon: "discord", label: "Discord", href: "https://discord.gg/Wsy2NpnZDu" }],
      // The sidebar lists only pages that exist.
      sidebar: [
        {
          ...label("sidebar.start"),
          items: [
            { ...label("sidebar.home"), link: "/" },
            { slug: "install" },
            { slug: "first-launch" },
            { slug: "your-first-task" },
            { slug: "what-you-can-ask-for" },
          ],
        },
        {
          ...label("sidebar.using"),
          items: [
            { slug: "the-first-mate" },
            { slug: "knowledge" },
            { slug: "runbooks" },
            { slug: "secrets" },
            { slug: "tasks-and-crewmates" },
            { slug: "the-crews-browser" },
            { slug: "cards-and-decisions" },
            { slug: "projects" },
            { slug: "integrations" },
            { slug: "subscriptions-and-quota" },
            { slug: "keyboard" },
            { slug: "automation" },
            { slug: "panels" },
            { slug: "your-other-computers" },
            { slug: "a-computer-with-no-screen" },
            { slug: "iphone-and-ipad" },
          ],
        },
        {
          ...label("sidebar.reference"),
          items: [
            { slug: "settings" },
            { slug: "update-and-remove" },
            { slug: "what-leaves-your-computer" },
            { slug: "whats-new" },
            { slug: "glossary" },
            { slug: "troubleshooting" },
            { slug: "get-help" },
          ],
        },
      ],
    }),
    headingIds(),
    joinedSentenceLines(),
    appIcon(),
    securityHeaders(),
    languageRedirects(),
    sitemapDefault(),
  ],
});
