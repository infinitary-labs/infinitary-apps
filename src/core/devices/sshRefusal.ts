import type { RemoteLoginRefusal } from "@shared/remoteLogin";

/**
 * Why SSH itself could not reach or sign in to the other Mac, read from its
 * own words on stderr after it exited `SSH_FAILED`. These are SSH's fixed
 * messages, not a person's words: a changed or unknown host first, since
 * SSH says it failed to verify both; then, once it could not sign in, the
 * agent the person's settings name not answering at all, as `-v` shows
 * whether its socket is gone or left behind: the key it holds is the one
 * SSH could not use, whatever else it tried; then a key the other Mac
 * accepted that could not be used - its agent did not sign with it, as SSH
 * says whatever the agent's reason, or it is locked with a passphrase, as
 * `-v` shows - before a key it refused; then nothing answering Remote
 * Login, and anything else as not reached.
 */
export function sshRefusal(stderr: string): RemoteLoginRefusal {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for \S+ has changed/.test(stderr))
    return "host-changed";
  if (/Host key verification failed|No \S+ host key is known for/.test(stderr))
    return "host-unknown";
  if (/Permission denied|Too many authentication failures/.test(stderr)) {
    if (/ssh_get_authentication_socket: /.test(stderr)) return "agent-not-running";
    if (/signing failed for .* from agent:/.test(stderr)) return "agent-declined";
    return /Server accepts key:/.test(stderr) ? "key-locked" : "key-refused";
  }
  if (/Connection refused/.test(stderr)) return "remote-login-off";
  return "unreachable";
}
