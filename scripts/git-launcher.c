/*
 * Infinitary's git on a crewmate's search path (git integration phase 2,
 * docs/forge.md "The app's own git").
 *
 * The app puts the directory holding this program, built as `git`, first on
 * the search path of every child it starts (src/core/hostEnv.ts), so `git`
 * in a crewmate's shell, and in whatever Claude's client runs, is the app's
 * own git, and every other program the computer has stays visible behind it.
 * INFINITARY_GIT_DIR (or the older FM3000_GIT_DIR) names the app's git
 * tree. That git is built to be told where its parts are: these are the
 * three variables dugite's setupEnvironment gives the app's own git calls on
 * macOS (src/core/workspace/bundledGit.ts; git.test.ts holds the two
 * together).
 *
 * It is a compiled program, not a #! script: macOS 26 keeps a 1 KB kernel
 * buffer for each script started from inside a script-started process, and
 * none for a compiled one (INF-2173). scripts/build-git-launcher.ts builds
 * it, for both Mac chips in one file, when `pnpm install` runs on a Mac.
 */
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

/* The first of two variables that is set and not empty, else "". */
static const char *named(const char *name, const char *older) {
  const char *value = getenv(name);
  if (value && *value) return value;
  value = getenv(older);
  return value ? value : "";
}

static int missing(void) {
  fputs("git: not found\n", stderr);
  return 127;
}

/* Sets `name` to `dir` followed by `tail`; 0 when it would not fit. */
static int setUnder(const char *name, const char *dir, const char *tail) {
  char value[PATH_MAX];
  int length = snprintf(value, sizeof value, "%s%s", dir, tail);
  if (length < 0 || (size_t)length >= sizeof value) return 0;
  return setenv(name, value, 1) == 0;
}

/* The real path of the directory this program is in, or 0. */
static int ownDir(char *out) {
#ifdef __APPLE__
  char self[PATH_MAX];
  uint32_t size = sizeof self;
  if (_NSGetExecutablePath(self, &size) != 0 || !realpath(self, out)) return 0;
#else
  if (!realpath("/proc/self/exe", out)) return 0;
#endif
  char *slash = strrchr(out, '/');
  if (!slash) return 0;
  *slash = '\0';
  return 1;
}

int main(int argc, char **argv) {
  (void)argc;
  const char *dir = named("INFINITARY_GIT_DIR", "FM3000_GIT_DIR");
  if (*dir) {
    char binary[PATH_MAX];
    int length = snprintf(binary, sizeof binary, "%s/bin/git", dir);
    if (length > 0 && (size_t)length < sizeof binary && access(binary, X_OK) == 0) {
      if (!setUnder("GIT_EXEC_PATH", dir, "/libexec/git-core") ||
          !setUnder("GIT_TEMPLATE_DIR", dir, "/share/git-core/templates") ||
          !setUnder("GIT_CONFIG_SYSTEM", dir, "/etc/gitconfig")) {
        return missing();
      }
      argv[0] = binary;
      execv(binary, argv);
      perror("git");
      return 126;
    }
  }

  /* No app git named: step aside for the next git on the search path. */
  if (*named("INFINITARY_GIT_STEPPED_ASIDE", "FM3000_GIT_STEPPED_ASIDE")) return missing();
  setenv("INFINITARY_GIT_STEPPED_ASIDE", "1", 1);
  char here[PATH_MAX];
  if (!ownDir(here)) return missing();
  const char *path = getenv("PATH");
  if (!path) return missing();
  size_t size = strlen(path) + 1;
  char *copy = strdup(path);
  char *rest = malloc(size);
  if (!copy || !rest) return missing();
  size_t used = 0;
  int kept = 0;
  char *cursor = copy;
  for (char *entry = strsep(&cursor, ":"); entry; entry = strsep(&cursor, ":")) {
    char resolved[PATH_MAX];
    if (*entry && realpath(entry, resolved) && strcmp(resolved, here) == 0) continue;
    if (kept++) rest[used++] = ':';
    size_t length = strlen(entry);
    memcpy(rest + used, entry, length);
    used += length;
  }
  rest[used] = '\0';
  free(copy);
  if (!*rest) return missing();
  setenv("PATH", rest, 1);
  free(rest);
  argv[0] = "git";
  execvp("git", argv);
  return missing();
}
