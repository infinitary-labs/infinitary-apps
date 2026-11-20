/** Captain-approved GitHub read threshold: 30 seconds per attempt, one retry. */
export const GITHUB_READ_ATTEMPT_MS = 30_000;

/**
 * Bound the whole crewmate read, including its trip to the home computer.
 * Only reads use this wrapper; writes and artifact transfers keep their owners.
 * Race cancellation as well as forwarding it: a lost callback may ignore its signal.
 */
export async function githubRead<T>(
  run: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const stop = new AbortController();
    const linked = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(linked.reason);
          linked.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(() => stop.abort(), GITHUB_READ_ATTEMPT_MS);
        }),
        (async () => {
          linked.throwIfAborted();
          return run(linked);
        })(),
      ]);
    } catch {
      signal?.throwIfAborted();
      if (attempt === 1)
        throw new Error(
          "The GitHub read had no answer after two attempts, each allowing 30 seconds. The request or its answer may have been lost. Nothing was changed; ask for the read again if you still need it.",
        );
    } finally {
      clearTimeout(timer);
      if (onAbort) linked.removeEventListener("abort", onAbort);
      stop.abort();
    }
  }
  throw new Error("The GitHub read did not answer.");
}
