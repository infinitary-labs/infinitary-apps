import { useEffect, useState } from "react";

const FOLLOW_EVERY_MS = 5_000;

type FollowAnswer = Awaited<ReturnType<Window["infinitary"]["devices"]["followAdded"]>>;

export type FollowAddedStatus = {
  afterAdd: "waits" | "keeps" | "stays" | "unknown";
  joins: boolean | null;
  pastes: boolean | null;
  outside: boolean;
};

/** Ask the shell while the welcome is up, even before a route is chosen (docs/view.md). */
export function useFollowAdded(can: boolean, untouched: boolean): FollowAddedStatus {
  const [answer, setAnswer] = useState<FollowAnswer | null>(null);
  useEffect(() => {
    if (!can) {
      setAnswer(null);
      return;
    }
    let live = true;
    // A command ending or being replaced can also change which joins the shell allows.
    const ask = () => {
      void window.infinitary.devices.followAdded().then(
        (said) => {
          if (live) setAnswer(said);
        },
        // An unreadable answer leaves joining unknown, never allowed.
        () => {
          if (live) setAnswer(null);
        },
      );
    };
    ask();
    const every = setInterval(ask, FOLLOW_EVERY_MS);
    return () => {
      live = false;
      clearInterval(every);
    };
  }, [can]);
  // Only a command started outside the window gets the "stays" line.
  // Until both join routes are available, a starting or absent owned command carries no promise.
  const afterAdd = !answer
    ? "unknown"
    : answer.outside
      ? "stays"
      : !answer.pastes || !answer.joins
        ? "unknown"
        : untouched && answer.follows
          ? "waits"
          : "keeps";
  return {
    afterAdd,
    joins: answer?.joins ?? null,
    pastes: answer?.pastes ?? null,
    outside: answer?.outside === true,
  };
}
