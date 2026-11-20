/* The native half of the approved INF-2228 launch receipt. No argv or environment
 * leaves this process tree. A shell asynchronous payload would inherit ignored
 * SIGINT; fork/exec preserves the caller's dispositions instead. No new group. */
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t payload;
static void forward(int sig) {
  int saved = errno;
  if (payload > 0) kill((pid_t)payload, sig);
  errno = saved;
}

int main(int argc, char **argv) {
  /* supervisor RECEIPT_SCRIPT HOLD PROGRAM [ARG...] */
  if (argc < 4) return 2;
  int signals[] = { SIGINT, SIGTERM, SIGHUP, SIGQUIT };
  sigset_t blocked, old;
  sigemptyset(&blocked);
  for (unsigned i = 0; i < sizeof(signals) / sizeof(signals[0]); i++)
    sigaddset(&blocked, signals[i]);
  if (sigprocmask(SIG_BLOCK, &blocked, &old) < 0) return 1;
  pid_t child = fork();
  if (child < 0) { perror("launch"); return 1; }
  if (child == 0) {
    sigprocmask(SIG_SETMASK, &old, NULL);
    execvp(argv[3], argv + 3);
    int failed = errno;
    perror(argv[3]);
    _exit(failed == ENOENT ? 127 : 126);
  }
  payload = child;
  struct sigaction action = {0};
  action.sa_handler = forward;
  sigemptyset(&action.sa_mask);
  for (unsigned i = 0; i < sizeof(signals) / sizeof(signals[0]); i++)
    sigaction(signals[i], &action, NULL);
  sigprocmask(SIG_SETMASK, &old, NULL);

  pid_t reporter = fork();
  if (reporter == 0) {
    for (unsigned i = 0; i < sizeof(signals) / sizeof(signals[0]); i++)
      signal(signals[i], SIG_DFL);
    /* Bookkeeping never owns the caller's streams and must not keep them open. */
    FILE *null = fopen("/dev/null", "r+");
    if (!null) _exit(1);
    for (int fd = 0; fd < 3; fd++) dup2(fileno(null), fd);
    char leader[32], pid[32];
    snprintf(leader, sizeof(leader), "%ld", (long)getppid());
    snprintf(pid, sizeof(pid), "%ld", (long)child);
    execl("/bin/bash", "bash", argv[1], "_receipt", argv[2], leader, pid, (char *)NULL);
    _exit(1);
  }
  /* Keep the payload's PID unreusable until receipt pursuit has stopped. A
   * zombie is explicitly refused by the host's live-process receipt check. */
  siginfo_t ended = {0};
  while (waitid(P_PID, (id_t)child, &ended, WEXITED | WNOWAIT) < 0) {
    if (errno == EINTR) continue;
    break;
  }
  payload = 0;
  if (reporter > 0) {
    kill(reporter, SIGTERM);
    while (waitpid(reporter, NULL, 0) < 0 && errno == EINTR) {}
  }
  int status;
  while (waitpid(child, &status, 0) < 0) {
    if (errno == EINTR) continue;
    status = 1 << 8;
    break;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) {
    int sig = WTERMSIG(status);
    signal(sig, SIG_DFL);
    sigset_t one;
    sigemptyset(&one);
    sigaddset(&one, sig);
    sigprocmask(SIG_UNBLOCK, &one, NULL);
    raise(sig);
    return 128 + sig;
  }
  return 1;
}
