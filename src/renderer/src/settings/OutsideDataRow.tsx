import {
  type KeptOutsideData,
  type OutsideDataDeleted,
  SAVED_OUTSIDE_DATA_WORDS,
} from "@shared/savedOutsideData";
import { useRef, useState } from "react";
import { Button } from "../design";
import { SettingRow } from "./settingRows";

/**
 * The delete for the words from outside, in Settings → Integrations' Data
 * section (INF-952, INF-1094; docs/task-retention.md, "Words from outside"):
 * every saved conversation, on this computer and on the computers that run
 * its work, keeps a note where the Gmail and Calendar content was, and every
 * other word stays. Armed on the first press and run on the second, as Purge
 * is. Absent where this build keeps none.
 */
export function OutsideDataRow({ kept }: { kept: readonly KeptOutsideData[] }) {
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const inFlight = useRef(false);
  if (kept.length === 0) return null;
  const words = SAVED_OUTSIDE_DATA_WORDS;

  const remove = () => {
    if (inFlight.current) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    inFlight.current = true;
    setDeleting(true);
    setNote(null);
    void window.infinitary.retention
      .deleteOutside()
      .then((done: OutsideDataDeleted) => setNote(words.done(done)))
      .catch((caught) => setNote(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => {
        inFlight.current = false;
        setDeleting(false);
        setArmed(false);
      });
  };

  return (
    <SettingRow
      id="delete-outside-data"
      title={words.title(kept)}
      description={note ?? words.description(kept)}
      control={
        <Button
          variant={armed ? "danger" : "ghost"}
          size="sm"
          onClick={remove}
          pending={deleting}
          pendingLabel={words.pending}
        >
          {armed ? words.confirm : words.delete}
        </Button>
      }
    />
  );
}
