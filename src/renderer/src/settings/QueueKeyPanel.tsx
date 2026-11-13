import { forgePlace } from "@shared/forge";
import { formatDate } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import type { QueueCredential, RepoView } from "@shared/repos";
import { useEffect, useState } from "react";
import { Button } from "../design";
import { QUEUE_KEY_WORDS } from "./projectsWords";
import { SettingError } from "./settingRows";

/**
 * The key the shipped queue writes with on a host that keeps one in the
 * project's CI settings (GitLab; docs/forge.md, "The shipped queue on
 * GitLab"), under "Where changes go": whether it is there and until when,
 * and one button that makes it with the person's own sign-in. A host whose
 * queue needs none answers null, and nothing shows.
 */
export function QueueKeyPanel({ repo }: { repo: Pick<RepoView, "id" | "host"> }) {
  const [credential, setCredential] = useState<QueueCredential | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState(false);
  useEffect(() => {
    let live = true;
    void window.infinitary.repos
      .queueCredential(repo.id)
      .then((read) => live && setCredential(read))
      .catch(() => live && setCredential(null));
    return () => {
      live = false;
    };
  }, [repo.id]);
  if (!credential) return null;
  const place =
    (repo.host && forgePlace({ kind: repo.host.kind, host: repo.host.name })) ?? "GitLab";
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      setCredential(await window.infinitary.repos.createQueueCredential(repo.id));
      setMade(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label={QUEUE_KEY_WORDS.title}
      data-queue-key={credential.state}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: "var(--space-2)",
        paddingBottom: "var(--space-3)",
        fontSize: "var(--text-xs)",
        color: "var(--fg-2)",
      }}
    >
      <div role="status">
        {credential.state === "ready"
          ? QUEUE_KEY_WORDS.ready(
              endsOn(credential.expiresAt) ?? m.settingsProjectsQueueKeyEndsUnknown(),
            )
          : credential.state === "unreadable"
            ? QUEUE_KEY_WORDS.unreadable(place)
            : QUEUE_KEY_WORDS.missing(place)}
      </div>
      <Button
        variant={credential.state === "missing" ? "primary" : "secondary"}
        size="sm"
        disabled={busy}
        pending={busy}
        onClick={() => void make()}
      >
        {credential.state === "ready" ? QUEUE_KEY_WORDS.remake : QUEUE_KEY_WORDS.make}
      </Button>
      {made && <div role="status">{QUEUE_KEY_WORDS.made}</div>}
      <SettingError error={error} surface="queue-key" />
    </section>
  );
}

/** The day the key ends, as a person reads a date; GitLab names it `2027-11-06`. */
function endsOn(expiresAt: string | undefined): string | null {
  const day = expiresAt ? new Date(`${expiresAt.slice(0, 10)}T00:00:00`) : null;
  return day && !Number.isNaN(day.getTime())
    ? formatDate(day, { year: "numeric", month: "long", day: "numeric" })
    : null;
}
