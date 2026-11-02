import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import { buildLoadSupervisor } from "./scripts/build-load-supervisor";
import { frameLibPlugin } from "./scripts/frame-lib";
import { contractChangeFiles } from "./src/core/connection/contractChanges";
import { contractRevisionFiles } from "./src/core/prompts/contractVersion";
import { PRODUCTION_CSP } from "./src/shared/csp";

/**
 * Injects the section 4 CSP as a meta fallback into the built index.html.
 * Build-only: the dev server gets its (HMR-tolerant) policy via
 * onHeadersReceived in main, and a meta here would override it.
 */
function cspMetaPlugin(): Plugin {
  return {
    name: "fm-csp-meta",
    apply: "build",
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: PRODUCTION_CSP },
            injectTo: "head-prepend",
          },
        ],
      };
    },
  };
}

export default defineConfig({
  main: {
    // Bake the Umami telemetry target into the packaged main bundle (baby-menu
    // pattern, decision D-12). CI release builds set INFINITARY_UMAMI_HOST /
    // INFINITARY_UMAMI_WEBSITE_ID (repository variables, not secrets; the
    // older FM3000_ names still read); when unset these resolve to "" so
    // telemetry stays a no-op. Each key is the exact expression
    // src/core/telemetry.ts reads, which is all a define replaces.
    define: {
      "process.env.INFINITARY_BUILD_UMAMI_HOST": JSON.stringify(
        process.env.INFINITARY_UMAMI_HOST || process.env.FM3000_UMAMI_HOST || "",
      ),
      "process.env.INFINITARY_BUILD_UMAMI_WEBSITE_ID": JSON.stringify(
        process.env.INFINITARY_UMAMI_WEBSITE_ID || process.env.FM3000_UMAMI_WEBSITE_ID || "",
      ),
      // The contract revisions, listed once: the packaged app has no source
      // folder to count (src/core/prompts/contractVersion.ts).
      __FM_CONTRACT_REVISIONS__: JSON.stringify(
        contractRevisionFiles(resolve(__dirname, "src/core/prompts/contract-revisions")),
      ),
      // The contract's changes by name, listed once for the same reason
      // (src/core/connection/contractChanges.ts).
      __INF_CONTRACT_CHANGES__: JSON.stringify(
        contractChangeFiles(resolve(__dirname, "src/shared/contract-changes")),
      ),
    },
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          // Its own entry: it runs in a utility process, never in main
          // (src/main/host/keychainUnlockHelper.ts).
          keychainUnlockHelper: resolve(__dirname, "src/main/host/keychainUnlockHelper.ts"),
          // The query process behind the `sql` read, also a utility process:
          // a runaway statement is stopped by killing it (src/core/sql/).
          sqlProcess: resolve(__dirname, "src/core/sql/sqlProcess.ts"),
          // The voice helper, a utility process that holds the Whisper model
          // (src/main/voice/voiceHelper.ts, docs/architecture.md section 8).
          voiceHelper: resolve(__dirname, "src/main/voice/voiceHelperEntry.ts"),
          // The process that runs one task command, also a utility process:
          // axi-sdk-js writes process.exitCode (src/core/axi/axiProcess.ts).
          axiProcess: resolve(__dirname, "src/core/axi/axiProcess.ts"),
          // The process that runs one program's script (src/core/program/).
          programProcess: resolve(__dirname, "src/core/program/programProcess.ts"),
          // The process that runs one panel's background module (src/core/panels/).
          panelProcess: resolve(__dirname, "src/core/panels/panelProcess.ts"),
        },
      },
    },
    resolve: {
      alias: {
        "@core": resolve(__dirname, "src/core"),
        "@shared": resolve(__dirname, "src/shared"),
        // transformers.js imports sharp for image work, which the voice
        // helper never does; the stand-in keeps sharp's native build out.
        sharp: resolve(__dirname, "src/main/voice/noSharp.ts"),
      },
    },
    // The frame realm's lib (scripts/frame-lib.ts): built before main, into
    // out/frame-lib, with every file's pin baked into main.
    plugins: [
      { name: "load-supervisor", buildStart: buildLoadSupervisor },
      frameLibPlugin(__dirname, resolve(__dirname, "out/frame-lib")),
    ],
  },
  preload: {
    build: {
      outDir: "out/preload",
      // The preload runs sandboxed, where require() only resolves electron
      // itself - every npm dependency (zod for the contract validation) must
      // be bundled in rather than externalized.
      externalizeDeps: { exclude: ["zod"] },
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    // Pinned dev port so firstmate-3000 doesn't collide with sibling
    // electron-vite apps (hi-bit 5173, baby-menu 5273, short-pipe 5373,
    // openbud 5473). strictPort fails loudly instead of silently loading the
    // wrong app's renderer.
    server: {
      port: 5573,
      strictPort: true,
    },
    build: {
      outDir: "out/renderer",
      // Keep the audio capture worklet a real emitted file rather than an
      // inlined data: URL: audioWorklet.addModule() must load it from
      // 'self', and a data: URL is blocked by the packaged renderer's
      // script-src CSP (hi-bit's verified gotcha).
      assetsInlineLimit: (filePath: string) =>
        filePath.includes("captureWorklet") ? false : undefined,
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
        // The two specifiers a personal panel imports, under Infinitary's
        // names and Firstmate 3000's. The extension host serves them as host
        // modules at runtime (src/shared/plugins/uiModule.ts); in this build
        // they resolve to the same modules directly, so the fixture
        // extensions compile and the e2e can mount them.
        "@infinitary/ui": resolve(__dirname, "src/renderer/src/design/index.ts"),
        "@infinitary/contracts": resolve(__dirname, "src/shared/plugins/personalPanel.ts"),
        "@firstmate/ui": resolve(__dirname, "src/renderer/src/design/index.ts"),
        "@firstmate/contracts": resolve(__dirname, "src/shared/plugins/personalPanel.ts"),
      },
    },
    plugins: [react(), cspMetaPlugin()],
  },
});
