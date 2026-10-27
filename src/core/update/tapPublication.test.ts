import { describe, expect, it } from "vitest";
import { declaredStepOnly } from "../../../tests/helpers/olderCask";
import { compareSemver } from "./semver";
import {
  advanceUpdateTargets,
  alphaActivationProblem,
  BUNDLE_ID,
  CHANNEL_CAVEATS,
  caskArtifact,
  caskPathFor,
  caskVersion,
  formatUpdateTargets,
  LAST_UNPROTECTED_STABLE,
  MARKER_HOME_PATH,
  type Publication,
  renderCask,
  republishCasks,
  TAP,
  TapPublicationRefusal,
  tapFilesFor,
} from "./tapPublication";
import {
  buildUpdateTarget,
  FIRSTMATE_TAP,
  parseUpdateTargets,
  type UpdateTarget,
  type UpdateTargets,
  updateChannelMarkerSchema,
} from "./updateChannels";

const NOTICE =
  "Infinitary is in private alpha: a pre-release build for a small group of early users, provided as is. Feedback is welcome.";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const COMMIT = "c".repeat(40);
const OTHER_COMMIT = "d".repeat(40);

function publication(
  channel: Publication["channel"],
  version: string,
  overrides: Partial<Publication> = {},
): Publication {
  return {
    channel,
    version,
    assetName: `Infinitary-${version}-universal.zip`,
    sha256: SHA_A,
    sourceCommit: COMMIT,
    ...overrides,
  };
}

function download(tag: string, version: string): string {
  return `https://github.com/infinitary-labs/homebrew-tap/releases/download/${tag}/Infinitary-${version}-universal.zip`;
}

/** What Homebrew reads from a rendered cask: the stanzas the tests care about. */
function readCask(cask: string) {
  const version = /^ {2}version "([^"]+)"$/m.exec(cask)?.[1] ?? "";
  const url = (/^ {2}url "([^"]+)"$/m.exec(cask)?.[1] ?? "").split("#{version}").join(version);
  const write = /write_file "([^"]+)",\n\s+("(?:[^"\\]|\\.)*"),\n\s+base: :home/.exec(cask);
  return {
    token: /^cask "([^"]+)" do$/m.exec(cask)?.[1],
    version,
    sha256: /^ {2}sha256 "([^"]+)"$/m.exec(cask)?.[1],
    url,
    conflicts: /^ {2}conflicts_with cask: "([^"]+)"$/m.exec(cask)?.[1],
    quit: /^ {2}uninstall quit: "([^"]+)"$/m.exec(cask)?.[1],
    markerPath: write?.[1],
    marker: write
      ? updateChannelMarkerSchema.parse(JSON.parse(JSON.parse(write[2] as string)))
      : null,
    caveats: (/caveats <<~EOS\n([\s\S]*?)\n {2}EOS/.exec(cask)?.[1] ?? "")
      .split("\n")
      .map((line) => line.replace(/^ {4}/, "")),
  };
}

describe("the channel casks", () => {
  const stable = renderCask(
    "stable",
    { version: "0.1.25", sha256: SHA_A, downloadUrl: download("infinitary-v0.1.25", "0.1.25") },
    NOTICE,
  );
  const alpha = renderCask(
    "alpha",
    {
      version: "0.1.26-alpha.43",
      sha256: SHA_B,
      downloadUrl: download("infinitary-alpha-v0.1.26-alpha.43", "0.1.26-alpha.43"),
    },
    NOTICE,
  );

  it("names each channel's cask and makes the two conflict", () => {
    expect(readCask(stable)).toMatchObject({
      token: "infinitary",
      version: "0.1.25",
      sha256: SHA_A,
      url: download("infinitary-v0.1.25", "0.1.25"),
      conflicts: "infinitary@alpha",
    });
    expect(readCask(alpha)).toMatchObject({
      token: "infinitary@alpha",
      version: "0.1.26-alpha.43",
      sha256: SHA_B,
      url: download("infinitary-alpha-v0.1.26-alpha.43", "0.1.26-alpha.43"),
      conflicts: "infinitary",
    });
    // Homebrew's audit wants the version interpolated into the URL.
    expect(stable).toContain(
      'url "https://github.com/infinitary-labs/homebrew-tap/releases/download/infinitary-v#{version}/Infinitary-#{version}-universal.zip"',
    );
    expect(caskPathFor("stable")).toBe("Casks/infinitary.rb");
    expect(caskPathFor("alpha")).toBe("Casks/infinitary@alpha.rb");
  });

  it("installs the same app, quits it before replacing it, and zaps only on request", () => {
    for (const cask of [stable, alpha]) {
      expect(cask).toContain('app "Infinitary.app"');
      expect(readCask(cask).quit).toBe(BUNDLE_ID);
      expect(cask).toContain('"~/Library/Application Support/infinitary",');
      expect(cask).not.toContain("infinitary-dev");
      // INF-643 captain-approved replacement: the real Homebrew consumer test executes
      // both hooks and verifies that the ownership receipt leaves quarantine and app bytes intact.
    }
  });

  it("writes its own channel's marker into the release data root after every install", () => {
    expect(MARKER_HOME_PATH).toBe("Library/Application Support/infinitary/update-channel.json");
    expect(readCask(stable)).toMatchObject({
      markerPath: MARKER_HOME_PATH,
      marker: { schemaVersion: 1, channel: "stable" },
    });
    expect(readCask(alpha)).toMatchObject({
      markerPath: MARKER_HOME_PATH,
      marker: { schemaVersion: 1, channel: "alpha" },
    });
    // Modern Homebrew uses declared steps with the home base; the real
    // consumer journey also exercises the legacy branch on older versions.
    expect(stable).toContain("postflight_steps do");
    expect(stable).not.toMatch(/^ {2}postflight do$/m);
  });

  it("writes alpha even when the alpha cask carries the stable artifact", () => {
    const handed = renderCask(
      "alpha",
      {
        version: "0.1.25",
        sha256: SHA_A,
        downloadUrl: download("infinitary-v0.1.25", "0.1.25"),
      },
      NOTICE,
    );
    expect(readCask(handed)).toMatchObject({
      token: "infinitary@alpha",
      version: "0.1.25",
      url: download("infinitary-v0.1.25", "0.1.25"),
      marker: { schemaVersion: 1, channel: "alpha" },
    });
  });

  it("carries the alpha notice, then its channel's paragraph, never suggesting --zap to switch", () => {
    for (const [cask, channel] of [
      [stable, "stable"],
      [alpha, "alpha"],
    ] as const) {
      const caveats = readCask(cask).caveats;
      const blank = caveats.indexOf("");
      expect(caveats.slice(0, blank).join(" ")).toBe(NOTICE);
      expect(caveats.slice(blank + 1)).toEqual(CHANNEL_CAVEATS[channel]);
      expect(caveats.filter((line) => line.startsWith("  brew ")).join("\n")).not.toContain(
        "--zap",
      );
    }
    expect(readCask(alpha).caveats).toContain(
      "  brew install --cask infinitary-labs/tap/infinitary",
    );
    expect(readCask(stable).caveats).toContain(
      "  brew install --cask infinitary-labs/tap/infinitary@alpha",
    );
  });

  it("refuses a version the channel does not carry, a malformed checksum and any other download", () => {
    const refused =
      (channel: "stable" | "alpha", version: string, downloadUrl: string, sha256 = SHA_A) =>
      () =>
        renderCask(channel, { version, sha256, downloadUrl }, NOTICE);
    const alphaUrl = download("infinitary-alpha-v0.1.26-alpha.43", "0.1.26-alpha.43");
    // Stable never carries an alpha version.
    expect(refused("stable", "0.1.26-alpha.43", alphaUrl)).toThrow(/not a stable version/);
    // Neither channel carries anything but X.Y.Z or X.Y.Z-alpha.N.
    for (const version of [
      "v0.1.25",
      "0.1",
      "0.1.25-beta.1",
      "0.1.25-alpha",
      "0.1.25-alpha.01",
      "0.1.25+b1",
    ]) {
      for (const channel of ["stable", "alpha"] as const) {
        expect(refused(channel, version, download(`infinitary-v${version}`, version))).toThrow(
          TapPublicationRefusal,
        );
      }
    }
    for (const sha256 of ["abc123", SHA_A.toUpperCase(), `${SHA_A}0`, "g".repeat(64)]) {
      expect(refused("stable", "0.1.25", download("infinitary-v0.1.25", "0.1.25"), sha256)).toThrow(
        /sha256/,
      );
    }
    for (const url of [
      // The private product repository.
      "https://github.com/infinitary-labs/infinitary/releases/download/v0.1.25/Infinitary-0.1.25-universal.zip",
      // A foreign host, even with the tap's path.
      "https://example.com/infinitary-labs/homebrew-tap/releases/download/infinitary-v0.1.25/Infinitary-0.1.25-universal.zip",
      "http://github.com/infinitary-labs/homebrew-tap/releases/download/infinitary-v0.1.25/Infinitary-0.1.25-universal.zip",
      // The tap, but not this app's release of this version.
      "https://github.com/infinitary-labs/homebrew-tap/archive/infinitary-v0.1.25.zip",
      download("v0.1.25", "0.1.25"),
      download("other-tool-v0.1.25", "0.1.25"),
      download("infinitary-v0.1.24", "0.1.25"),
      // A stable version under the alpha prefix.
      download("infinitary-alpha-v0.1.25", "0.1.25"),
      // Not a zip asset, or a path that leaves the release.
      "https://github.com/infinitary-labs/homebrew-tap/releases/download/infinitary-v0.1.25/Infinitary-0.1.25-universal.dmg",
      "https://github.com/infinitary-labs/homebrew-tap/releases/download/infinitary-v0.1.25/../other/x.zip",
    ]) {
      expect(refused("stable", "0.1.25", url), url).toThrow(/public release asset/);
      expect(refused("alpha", "0.1.25", url), url).toThrow(/public release asset/);
    }
    // An alpha version under the stable prefix.
    expect(
      refused(
        "alpha",
        "0.1.26-alpha.43",
        download("infinitary-v0.1.26-alpha.43", "0.1.26-alpha.43"),
      ),
    ).toThrow(/public release asset/);
  });
});

describe("the update targets writer", () => {
  function advance(current: UpdateTargets | undefined, next: Publication) {
    // The writer reads the tap's file as JSON, exactly as the tap stores it.
    const stored = current === undefined ? undefined : JSON.parse(formatUpdateTargets(current));
    return advanceUpdateTargets(stored, next);
  }

  it("hands the first stable to both channels", () => {
    const { targets, changed } = advance(undefined, publication("stable", "0.1.25"));
    const target = buildUpdateTarget(publication("stable", "0.1.25"));
    expect(changed).toEqual(["stable", "alpha"]);
    expect(targets).toEqual({ schemaVersion: 1, targets: { stable: target, alpha: target } });
  });

  it("moves only alpha for an alpha publication", () => {
    const first = advance(undefined, publication("stable", "0.1.25")).targets;
    const { targets, changed, notes } = advance(first, publication("alpha", "0.1.26-alpha.43"));
    expect(changed).toEqual(["alpha"]);
    expect(targets.targets.stable).toEqual(first.targets.stable);
    expect(targets.targets.alpha?.version).toBe("0.1.26-alpha.43");
    expect(targets.targets.alpha?.releaseUrl).toBe(
      "https://github.com/infinitary-labs/homebrew-tap/releases/tag/infinitary-alpha-v0.1.26-alpha.43",
    );
    expect(notes).toEqual(["alpha moves to 0.1.26-alpha.43", "stable stays at 0.1.25"]);
  });

  it("hands a newer stable to alpha, and keeps a newer alpha", () => {
    const withAlpha = advance(
      advance(undefined, publication("stable", "0.1.25")).targets,
      publication("alpha", "0.1.26-alpha.43"),
    ).targets;
    // 0.1.26 is newer than every 0.1.26-alpha.N: both channels move to it.
    const handed = advance(withAlpha, publication("stable", "0.1.26"));
    expect(handed.changed).toEqual(["stable", "alpha"]);
    expect(handed.targets.targets.alpha).toEqual(handed.targets.targets.stable);
    // A stable that finishes after a newer alpha moves stable alone.
    const newerAlpha = advance(handed.targets, publication("alpha", "0.1.28-alpha.50")).targets;
    const late = advance(newerAlpha, publication("stable", "0.1.27"));
    expect(late.changed).toEqual(["stable"]);
    expect(late.targets.targets.stable?.version).toBe("0.1.27");
    expect(late.targets.targets.alpha?.version).toBe("0.1.28-alpha.50");
    expect(late.notes).toContain("alpha keeps 0.1.28-alpha.50, newer than stable 0.1.27");
  });

  it("changes nothing when the identical artifact is published again", () => {
    const first = advance(undefined, publication("stable", "0.1.25")).targets;
    const again = advance(first, publication("stable", "0.1.25"));
    expect(again.changed).toEqual([]);
    expect(again.targets).toEqual(first);
    const withAlpha = advance(first, publication("alpha", "0.1.26-alpha.43")).targets;
    expect(advance(withAlpha, publication("alpha", "0.1.26-alpha.43")).changed).toEqual([]);
  });

  it("refuses to move a channel backwards", () => {
    const withAlpha = advance(
      advance(undefined, publication("stable", "0.1.26")).targets,
      publication("alpha", "0.1.27-alpha.43"),
    ).targets;
    // A late, older alpha.
    expect(() => advance(withAlpha, publication("alpha", "0.1.27-alpha.42"))).toThrow(
      /alpha already carries 0.1.27-alpha.43, newer than 0.1.27-alpha.42/,
    );
    // An alpha behind stable, which alpha already carries or has passed.
    expect(() => advance(withAlpha, publication("alpha", "0.1.26-alpha.9"))).toThrow(
      /stable 0.1.26 is newer than alpha 0.1.26-alpha.9/,
    );
    // A late, older stable.
    expect(() => advance(withAlpha, publication("stable", "0.1.25"))).toThrow(
      /stable already carries 0.1.26, newer than 0.1.25/,
    );
  });

  it("refuses a published version with other bytes or another source", () => {
    const first = advance(undefined, publication("stable", "0.1.25")).targets;
    for (const conflicting of [
      publication("stable", "0.1.25", { sha256: SHA_B }),
      publication("stable", "0.1.25", { sourceCommit: OTHER_COMMIT }),
      publication("stable", "0.1.25", { assetName: "Infinitary-universal.zip" }),
    ]) {
      expect(() => advance(first, conflicting)).toThrow(/a published version's bytes never change/);
    }
    // Alpha's record of a handed stable version is held to the same bytes.
    const alphaOnly: UpdateTargets = {
      schemaVersion: 1,
      targets: { alpha: buildUpdateTarget(publication("stable", "0.1.25")) },
    };
    expect(() => advance(alphaOnly, publication("stable", "0.1.25", { sha256: SHA_B }))).toThrow(
      /alpha already carries 0.1.25 with a different artifact/,
    );
  });

  it("refuses a publication that is not its channel's artifact", () => {
    expect(() => advance(undefined, publication("alpha", "0.1.25"))).toThrow(
      /stable reaches alpha only through a stable publication/,
    );
    expect(() => advance(undefined, publication("stable", "0.1.26-alpha.1"))).toThrow(
      /a stable publication carries a stable version/,
    );
    for (const version of ["v0.1.25", "0.1.25-rc.1", "0.1.25-alpha", "0.1.25+b1", ""]) {
      expect(() => advance(undefined, publication("stable", version))).toThrow(
        TapPublicationRefusal,
      );
      expect(() => advance(undefined, publication("alpha", version))).toThrow(
        TapPublicationRefusal,
      );
    }
    expect(() => advance(undefined, publication("stable", "0.1.25", { sha256: "abc" }))).toThrow(
      /sha256/,
    );
    expect(() =>
      advance(undefined, publication("stable", "0.1.25", { sourceCommit: "c".repeat(7) })),
    ).toThrow(/source commit/);
    expect(() =>
      advance(undefined, publication("stable", "0.1.25", { assetName: "../evil.zip" })),
    ).toThrow(/public release asset/);
  });

  it("refuses to overwrite a current file the reader would not accept", () => {
    const target = buildUpdateTarget(publication("stable", "0.1.25"));
    for (const current of [
      null,
      "not json",
      { schemaVersion: 2, targets: {} },
      { schemaVersion: 1, targets: { beta: target } },
      {
        schemaVersion: 1,
        targets: { stable: { ...target, downloadUrl: "https://example.com/x.zip" } },
      },
    ]) {
      expect(() => advanceUpdateTargets(current, publication("stable", "0.1.26"))).toThrow(
        /infinitary-updates.json is invalid/,
      );
    }
  });

  it("keeps every channel moving forwards with alpha never behind stable, whatever order publications finish in", () => {
    const publications = [
      publication("stable", "0.1.25"),
      publication("alpha", "0.1.26-alpha.40"),
      publication("alpha", "0.1.26-alpha.41"),
      publication("stable", "0.1.26"),
      publication("alpha", "0.1.27-alpha.44"),
      publication("alpha", "0.1.28-alpha.45"),
      publication("stable", "0.1.27"),
      publication("stable", "0.2.0"),
    ];
    // Many arrival orders of a fixed set, shuffled reproducibly; a refused
    // publication changes nothing.
    let state = 7;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    for (let round = 0; round < 50; round += 1) {
      const order = [...publications];
      for (let index = order.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [order[index], order[swap]] = [order[swap] as Publication, order[index] as Publication];
      }
      let targets: UpdateTargets | undefined;
      for (const next of order) {
        let result: ReturnType<typeof advance> | null = null;
        try {
          result = advance(targets, next);
        } catch (caught) {
          expect(caught).toBeInstanceOf(TapPublicationRefusal);
        }
        if (!result) continue;
        for (const channel of ["stable", "alpha"] as const) {
          const before = targets?.targets[channel]?.version;
          const after = result.targets.targets[channel]?.version;
          if (before && after) expect(compareSemver(after, before)).toBeGreaterThanOrEqual(0);
        }
        const { stable, alpha } = result.targets.targets;
        if (stable && alpha)
          expect(compareSemver(alpha.version, stable.version)).toBeGreaterThanOrEqual(0);
        expect(parseUpdateTargets(result.targets)).toEqual(result.targets);
        targets = result.targets;
      }
    }
  });
});

describe("the tap files of one publication", () => {
  it("writes the targets file and the cask of every channel that moved, carrying exactly its target", () => {
    const first = tapFilesFor(undefined, publication("stable", "0.1.25"), NOTICE);
    expect(Object.keys(first.files).sort()).toEqual([
      "Casks/infinitary.rb",
      "Casks/infinitary@alpha.rb",
      "infinitary-updates.json",
    ]);
    const targets = parseUpdateTargets(JSON.parse(first.files["infinitary-updates.json"] ?? ""));
    expect(targets).toEqual(first.targets);
    for (const channel of ["stable", "alpha"] as const) {
      const cask = readCask(first.files[caskPathFor(channel)] ?? "");
      const target = first.targets.targets[channel];
      expect(cask).toMatchObject({
        version: target?.version,
        sha256: target?.sha256,
        url: target?.downloadUrl,
        marker: { schemaVersion: 1, channel },
      });
    }

    const alpha = tapFilesFor(first.targets, publication("alpha", "0.1.26-alpha.43"), NOTICE);
    expect(Object.keys(alpha.files).sort()).toEqual([
      "Casks/infinitary@alpha.rb",
      "infinitary-updates.json",
    ]);
    expect(readCask(alpha.files["Casks/infinitary@alpha.rb"] ?? "").version).toBe(
      "0.1.26-alpha.43",
    );

    // An identical retry writes nothing at all.
    expect(
      tapFilesFor(alpha.targets, publication("alpha", "0.1.26-alpha.43"), NOTICE).files,
    ).toEqual({});
  });

  // INF-42: Infinitary's tap carries no stable cask from its first alpha
  // (rename step 12) until its first stable (step 14), so until then no
  // caveat may tell a person to uninstall the alpha for a stable cask.
  it("names in every cask's caveats only a cask the tap carries, and the other channel once it does", () => {
    const tap: Record<string, string> = {};
    let current: unknown;
    for (const next of [
      publication("alpha", "0.4.2-alpha.2"),
      publication("alpha", "0.4.3-alpha.5"),
      // Promoted from the first alpha while the newer alpha keeps its target.
      publication("stable", "0.4.2"),
      publication("alpha", "0.4.4-alpha.9"),
      publication("stable", "0.4.4"),
    ]) {
      const written = tapFilesFor(current, next, NOTICE);
      Object.assign(tap, written.files);
      current = JSON.parse(tap[TAP.targetsFile] ?? "");
      const targets = parseUpdateTargets(current)?.targets;
      for (const channel of ["stable", "alpha"] as const) {
        // A cask written though its target stayed says why in the summary.
        const rewritten = `${channel} cask rewritten at ${targets?.[channel]?.version} so its caveats name the stable cask`;
        expect(written.notes.includes(rewritten), `${next.version}: ${channel}`).toBe(
          caskPathFor(channel) in written.files && !written.changed.includes(channel),
        );
        const cask = tap[caskPathFor(channel)];
        expect(cask === undefined, `${next.version}: ${channel}`).toBe(!targets?.[channel]);
        if (cask === undefined) continue;
        // A cask rewritten for its caveats still installs exactly its target.
        expect(readCask(cask)).toMatchObject({
          version: targets?.[channel]?.version,
          sha256: targets?.[channel]?.sha256,
          url: targets?.[channel]?.downloadUrl,
        });
        const other = channel === "stable" ? "alpha" : "stable";
        const commands = readCask(cask).caveats.filter((line) => line.startsWith("  brew "));
        expect(commands, `${next.version}: ${channel}`).toEqual(
          tap[caskPathFor(other)] === undefined
            ? []
            : [
                `  brew uninstall --cask ${TAP.caskTokens[channel]}`,
                `  brew install --cask ${TAP.tap}/${TAP.caskTokens[other]}`,
              ],
        );
      }
    }
  });
});

describe("the transition from the single stable cask", () => {
  it("reads the version a cask installs", () => {
    const cask = renderCask(
      "stable",
      {
        version: "0.1.24",
        sha256: SHA_A,
        downloadUrl: download("infinitary-v0.1.24", "0.1.24"),
      },
      NOTICE,
    );
    expect(caskVersion(cask)).toBe("0.1.24");
    expect(caskVersion('cask "other-tool" do\nend\n')).toBeNull();
  });

  it("never moves behind the stable cask a tap without a targets file already carries", () => {
    const legacy = { legacyStableVersion: "0.1.24" };
    expect(() => advanceUpdateTargets(undefined, publication("stable", "0.1.23"), legacy)).toThrow(
      /the tap's stable cask already carries 0.1.24, newer than 0.1.23/,
    );
    expect(() =>
      advanceUpdateTargets(undefined, publication("alpha", "0.1.24-alpha.9"), legacy),
    ).toThrow(/already carries 0.1.24, newer than 0.1.24-alpha.9/);
    // The same version, or a newer one, publishes; both channels when stable.
    expect(
      advanceUpdateTargets(undefined, publication("stable", "0.1.24"), legacy).changed,
    ).toEqual(["stable", "alpha"]);
    expect(
      advanceUpdateTargets(undefined, publication("stable", "0.1.25"), legacy).changed,
    ).toEqual(["stable", "alpha"]);
    // Once the targets file exists, it alone is the record.
    const current = JSON.parse(
      formatUpdateTargets(advanceUpdateTargets(undefined, publication("stable", "0.1.25")).targets),
    );
    expect(() => advanceUpdateTargets(current, publication("stable", "0.1.24"), legacy)).toThrow(
      /stable already carries 0.1.25, newer than 0.1.24/,
    );
  });
});

describe("republishing the casks", () => {
  /** The targets file a tap stores after these publications, as JSON. */
  const tapAfter = (...publications: Publication[]): unknown => {
    let current: unknown;
    for (const next of publications) {
      current = JSON.parse(formatUpdateTargets(advanceUpdateTargets(current, next).targets));
    }
    return current;
  };
  /** Each channel's cask for its target, as `write` turns this generator's rendering. */
  const casksFor = (current: unknown, write: (cask: string) => string = (cask) => cask) => {
    const casks: Partial<Record<"stable" | "alpha", string>> = {};
    const targets = parseUpdateTargets(current)?.targets;
    for (const channel of ["stable", "alpha"] as const) {
      const target = targets?.[channel];
      if (target) {
        casks[channel] = write(
          renderCask(channel, target, NOTICE, TAP, targets?.stable !== undefined),
        );
      }
    }
    return casks;
  };

  it("writes each channel's cask again at exactly its target, and never the targets file", () => {
    const current = tapAfter(
      publication("stable", "0.1.25"),
      publication("alpha", "0.1.26-alpha.43"),
    );
    const older = casksFor(current, declaredStepOnly);
    const result = republishCasks(current, older, NOTICE);
    expect(result.changed).toEqual(["stable", "alpha"]);
    expect(result.notes).toEqual([
      "stable cask republished at 0.1.25",
      "alpha cask republished at 0.1.26-alpha.43",
    ]);
    expect(Object.keys(result.files).sort()).toEqual([
      "Casks/infinitary.rb",
      "Casks/infinitary@alpha.rb",
    ]);
    for (const channel of ["stable", "alpha"] as const) {
      const target = parseUpdateTargets(current)?.targets[channel];
      const cask = result.files[caskPathFor(channel)] ?? "";
      expect(readCask(cask)).toMatchObject({
        version: target?.version,
        sha256: target?.sha256,
        url: target?.downloadUrl,
        markerPath: MARKER_HOME_PATH,
        marker: { schemaVersion: 1, channel },
      });
      // It installs exactly what the cask it replaces installed.
      expect(caskArtifact(cask)).toEqual(caskArtifact(older[channel] ?? ""));
      expect(cask).toContain("postflight do");
    }

    // Casks that are already current write nothing, so a repeated run is safe.
    expect(republishCasks(current, casksFor(current), NOTICE)).toEqual({
      changed: [],
      notes: [
        "stable cask is already current at 0.1.25",
        "alpha cask is already current at 0.1.26-alpha.43",
      ],
      files: {},
    });
  });

  // INF-42: an alpha cask published while the tap named no stable target,
  // by a generator that always named the stable cask, loses that way back
  // at its next republication.
  it("drops the stable switch from an alpha cask while the tap names no stable target", () => {
    const current = tapAfter(publication("alpha", "0.4.2-alpha.2"));
    const target = parseUpdateTargets(current)?.targets.alpha as UpdateTarget;
    const published = renderCask("alpha", target, NOTICE, TAP, true);
    const result = republishCasks(current, { alpha: published }, NOTICE);
    expect(result.changed).toEqual(["alpha"]);
    const cask = result.files[caskPathFor("alpha")] ?? "";
    expect(caskArtifact(cask)).toEqual(caskArtifact(published));
    expect(readCask(cask).caveats.filter((line) => line.startsWith("  brew "))).toEqual([]);
    expect(readCask(published).caveats).toContain(
      `  brew install --cask ${TAP.tap}/${TAP.caskTokens.stable}`,
    );
  });

  it("carries a reviewed notice to both casks at their targets", () => {
    const current = tapAfter(publication("stable", "0.1.25"));
    const notice = "Infinitary is in private alpha. A changed notice reaches both casks.";
    const result = republishCasks(current, casksFor(current), notice);
    expect(result.changed).toEqual(["stable", "alpha"]);
    for (const channel of ["stable", "alpha"] as const) {
      const cask = readCask(result.files[caskPathFor(channel)] ?? "");
      expect(cask.caveats.slice(0, 2)).toEqual([
        "Infinitary is in private alpha. A changed notice reaches both casks.",
        "",
      ]);
      expect(cask.version).toBe("0.1.25");
    }
  });

  it("refuses rather than change what a cask installs, or touch a tap whose targets it cannot read", () => {
    const current = tapAfter(publication("stable", "0.1.25"));
    const casks = casksFor(current);
    const stable = casks.stable ?? "";
    const refused = (stableCask: string, pattern: RegExp) =>
      expect(() => republishCasks(current, { ...casks, stable: stableCask }, NOTICE)).toThrow(
        pattern,
      );
    // Another version, other bytes, another download, or nothing readable.
    refused(
      renderCask(
        "stable",
        {
          version: "0.1.24",
          sha256: SHA_A,
          downloadUrl: download("infinitary-v0.1.24", "0.1.24"),
        },
        NOTICE,
      ),
      /the infinitary cask installs 0\.1\.24 from .*, not stable's target 0\.1\.25; republishing never changes what a cask installs/,
    );
    refused(
      stable.replace(SHA_A, SHA_B),
      new RegExp(`installs 0\\.1\\.25 from .* \\(${SHA_B}\\), not stable's target`),
    );
    refused(
      stable.replace("/releases/download/infinitary-v", "/releases/download/other-tool-v"),
      /installs 0\.1\.25 from .*other-tool-v0\.1\.25.*, not stable's target 0\.1\.25/,
    );
    refused('cask "infinitary" do\nend\n', /installs something unreadable, not stable's target/);

    // A target with no cask, or a cask with no target, is not a tap it knows.
    expect(() => republishCasks(current, { alpha: casks.alpha ?? "" }, NOTICE)).toThrow(
      /names a stable target but carries no infinitary cask/,
    );
    const alphaOnly = tapAfter(publication("alpha", "0.1.25-alpha.3"));
    expect(() => republishCasks(alphaOnly, { ...casksFor(alphaOnly), stable }, NOTICE)).toThrow(
      /carries the infinitary cask but names no stable target/,
    );
    expect(republishCasks(alphaOnly, casksFor(alphaOnly), NOTICE).notes).toEqual([
      "stable has no target and no cask",
      "alpha cask is already current at 0.1.25-alpha.3",
    ]);

    expect(() => republishCasks(undefined, casks, NOTICE)).toThrow(
      /the tap has no infinitary-updates.json; only a publication writes the first one/,
    );
    expect(() =>
      republishCasks({ schemaVersion: 1, targets: { beta: {} } }, casks, NOTICE),
    ).toThrow(TapPublicationRefusal);
  });
});

describe("activating the alpha channel", () => {
  const targetsAfter = (...publications: Publication[]) => {
    let current: unknown;
    for (const next of publications) {
      current = JSON.parse(formatUpdateTargets(advanceUpdateTargets(current, next).targets));
    }
    return current;
  };

  it("refuses a live alpha until a protected stable is stable's target", () => {
    expect(LAST_UNPROTECTED_STABLE).toBe("0.1.24");
    expect(alphaActivationProblem(undefined)).toMatch(
      /no infinitary-updates.json yet; a protected stable \(newer than 0.1.24\) has to be published first/,
    );
    // A targets file with no stable target, or one whose stable predates the guard.
    expect(alphaActivationProblem(targetsAfter(publication("alpha", "0.1.25-alpha.3")))).toMatch(
      /names no stable target/,
    );
    expect(alphaActivationProblem(targetsAfter(publication("stable", "0.1.24")))).toMatch(
      /stable's target 0.1.24 predates the saved-data guard/,
    );
    expect(alphaActivationProblem({ schemaVersion: 1, targets: { beta: {} } })).toMatch(/invalid/);
    // The bootstrap stable activates it, and later publications keep it so.
    expect(alphaActivationProblem(targetsAfter(publication("stable", "0.1.25")))).toBeNull();
    expect(
      alphaActivationProblem(
        targetsAfter(publication("stable", "0.1.25"), publication("alpha", "0.1.26-alpha.43")),
      ),
    ).toBeNull();
  });

  // Infinitary's own tap starts empty after Firstmate 3000's stables (the
  // Infinitary rename, FI3-1780 steps 7 and 12): the record of past releases
  // names the protected stable every stable the tap will carry numbers above.
  it("lets Infinitary's first alpha publish when the archived stable is protected", () => {
    expect(alphaActivationProblem(undefined, { archivedStable: "0.4.1" })).toBeNull();
    expect(
      alphaActivationProblem(targetsAfter(publication("alpha", "0.4.2-alpha.1")), {
        archivedStable: "0.4.1",
      }),
    ).toBeNull();
    expect(alphaActivationProblem(undefined, { archivedStable: "0.1.24" })).toMatch(
      /no infinitary-updates.json yet/,
    );
  });
});

// The old-cask switch (FI3-1780 step 10, FI3-1729): Firstmate 3000's casks,
// under their own tokens on their own tap, install Infinitary for the people
// who installed Firstmate 3000, and their marker says so, so Infinitary's
// update notice keeps naming the command those people use.
describe("Firstmate 3000's casks after the old-cask switch", () => {
  const oldDownload = (tag: string, version: string) =>
    `https://github.com/kunchenguid/homebrew-tap/releases/download/${tag}/Infinitary-${version}-universal.zip`;
  const switched = renderCask(
    "alpha",
    {
      version: "0.4.2-alpha.3",
      sha256: SHA_A,
      downloadUrl: oldDownload("firstmate-3000-alpha-v0.4.2-alpha.3", "0.4.2-alpha.3"),
    },
    NOTICE,
    FIRSTMATE_TAP,
  );

  it("installs Infinitary under the old token and says it came through the old cask", () => {
    expect(readCask(switched)).toMatchObject({
      token: "firstmate-3000@alpha",
      version: "0.4.2-alpha.3",
      conflicts: "firstmate-3000",
      quit: BUNDLE_ID,
      markerPath: MARKER_HOME_PATH,
      marker: { schemaVersion: 1, channel: "alpha", cameThroughOldCask: true },
    });
    expect(switched).toContain('app "Infinitary.app"');
    expect(caskPathFor("alpha", FIRSTMATE_TAP)).toBe("Casks/firstmate-3000@alpha.rb");
    expect(readCask(switched).caveats).toContain(
      "  brew install --cask kunchenguid/tap/firstmate-3000",
    );
  });

  it("refuses a download from Infinitary's own tap under the old cask", () => {
    expect(() =>
      renderCask(
        "alpha",
        {
          version: "0.4.2-alpha.3",
          sha256: SHA_A,
          downloadUrl: download("infinitary-alpha-v0.4.2-alpha.3", "0.4.2-alpha.3"),
        },
        NOTICE,
        FIRSTMATE_TAP,
      ),
    ).toThrow(TapPublicationRefusal);
  });

  it("moves the old update file forward with releases an installed Firstmate 3000 accepts", () => {
    const current = {
      schemaVersion: 1,
      targets: {
        stable: buildUpdateTarget(
          {
            version: "0.4.1",
            assetName: "Firstmate-3000-0.4.1-universal.zip",
            sha256: SHA_B,
            sourceCommit: OTHER_COMMIT,
          },
          FIRSTMATE_TAP,
        ),
      },
    };
    const result = tapFilesFor(current, publication("stable", "0.4.2"), NOTICE, {
      tap: FIRSTMATE_TAP,
    });
    expect(Object.keys(result.files).sort()).toEqual([
      "Casks/firstmate-3000.rb",
      "Casks/firstmate-3000@alpha.rb",
      "firstmate-3000-updates.json",
    ]);
    const written = parseUpdateTargets(
      JSON.parse(result.files["firstmate-3000-updates.json"] ?? ""),
      FIRSTMATE_TAP,
    );
    expect(written?.targets.stable).toEqual({
      version: "0.4.2",
      releaseUrl: "https://github.com/kunchenguid/homebrew-tap/releases/tag/firstmate-3000-v0.4.2",
      downloadUrl: oldDownload("firstmate-3000-v0.4.2", "0.4.2"),
      sha256: SHA_A,
      sourceCommit: COMMIT,
    });
    // Infinitary's own reader refuses that file: it names the old tap's releases.
    expect(
      parseUpdateTargets(JSON.parse(result.files["firstmate-3000-updates.json"] ?? "")),
    ).toBeNull();
  });
});
