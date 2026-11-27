import { cutText } from "@shared/textCut";
import { ForgeAllowanceSpent, ForgeBaseMoved, ForgeError } from "../../forge";

export function failureOf(
  response: Response,
  method: string,
  path: string,
  text: string,
): ForgeError {
  let said = "";
  try {
    const answer = JSON.parse(text) as { message?: string; errors?: unknown };
    said = answer.message ?? "";
    // GitHub's 400 for a header it refuses (such as an API version it does
    // not support) says only "Bad Request" and gives its reason in `errors`.
    if (/^Bad Request$/i.test(said) && typeof answer.errors === "string" && answer.errors)
      said = `${said}: ${cutText(answer.errors, 300)}`;
  } catch {
    said = cutText(text, 200);
  }
  const what = `GitHub answered ${response.status} to ${method} ${path.split("?")[0]}${said ? `: ${said}` : ""}`;
  if (response.status === 401) return new ForgeError("sign-in", what);
  if (response.status === 403 || response.status === 429) {
    const spent = response.headers.get("x-ratelimit-remaining") === "0";
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (spent && Number.isFinite(reset) && reset > 0)
      return new ForgeAllowanceSpent(reset * 1000, `${what} (the hourly allowance is spent)`);
    if (response.status === 403)
      return new ForgeError("permission", spent ? `${what} (the hourly allowance is spent)` : what);
  }
  if (response.status === 404) return new ForgeError("not-found", what);
  // GitHub refuses a merge when the main branch moved while it merged: the
  // pull request may still merge once GitHub has read it again.
  if (
    response.status === 405 &&
    method === "PUT" &&
    /\/pulls\/\d+\/merge(?:-async)?(\?|$)/.test(path) &&
    /^Base branch was modified\b/i.test(said)
  )
    return new ForgeBaseMoved(what);
  // Any 5xx is the host's own failure, not a verdict on what was asked: a
  // read retries it quietly, and a write's outcome stays unknown (INF-2675
  // finding 7: a 500 on a commit's statuses ended two check watches).
  if (response.status >= 500) return new ForgeError("transient", what);
  return new ForgeError("refused", what);
}
