import {
  FORGE_CLI_WORDS,
  type ForgeCliSignInResult,
  forgeCliOffer,
  forgeCliProblemText,
} from "@shared/forges";
import { useState } from "react";
import { Button } from "../design";
import { useHereAs } from "../devices/useFirstMatePlace";

/**
 * The one line under a GitHub sign-in (`docs/forge.md`, "GitHub CLI's
 * sign-in"), drawn only where GitHub CLI is on this computer: for a person
 * whose organization blocks apps like Infinitary, use the sign-in GitHub
 * CLI already holds. Nothing asks GitHub CLI until the click; what went
 * wrong reads in the status line.
 */
export function GitHubCliLine({
  address,
  onDone,
  where,
  ask,
}: {
  address: string;
  onDone?: () => void;
  /** A computer that runs work whose own GitHub CLI is asked ("on Mac mini"); this computer otherwise. */
  where?: string;
  /** Asks that computer instead of this one. */
  ask?: () => Promise<ForgeCliSignInResult>;
}) {
  const here = useHereAs();
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState("");
  const use = async () => {
    if (asking) return;
    setAsking(true);
    setProblem("");
    try {
      const result = await (ask ? ask() : window.infinitary.forges.signInWithCli(address));
      if (result.ok) onDone?.();
      else setProblem(forgeCliProblemText(result.problem, result.host, where));
    } catch {
      setProblem(FORGE_CLI_WORDS.failed);
    } finally {
      setAsking(false);
    }
  };
  return (
    <div className="fm-forges-cli" data-forge-cli={address}>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        {here(where ? forgeCliOffer(where) : FORGE_CLI_WORDS.offer)}
      </div>
      <div className="fm-forges-aside-actions">
        <Button
          variant="secondary"
          size="sm"
          pending={asking}
          pendingLabel={FORGE_CLI_WORDS.checking}
          onClick={() => void use()}
        >
          {FORGE_CLI_WORDS.use}
        </Button>
      </div>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-forge-cli-problem=""
        style={{ display: "block", fontSize: "var(--text-sm)", color: "var(--danger)" }}
      >
        {here(problem)}
      </span>
    </div>
  );
}
