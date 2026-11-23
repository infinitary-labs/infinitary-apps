// Infinitary's own executables on a Mac (docs/run.md, "Opened while it
// runs"): scripts/place-mac-app-launcher.mjs compiles this file for both
// chips and puts it in the app twice at packaging - in place of Electron's
// main executable, Contents/MacOS/<name>, and beside it as
// Contents/MacOS/<name> Background, the file every start that shows no
// window runs from.
//
// Each starts the app exactly as Electron's own main executable does - the
// standard streams steadied, Node.js alone only where the run-as-Node fuse
// allows it, and otherwise the whole start handed to Electron Framework -
// after one choice of file. macOS hands a click on Infinitary in the Dock,
// Finder or Spotlight, and `open -a`, to a running copy that lives at the
// app's bundle or runs the app's main executable. A start that never shows a
// window (`<app> run`, `<app> work ...` and the short commands beside them,
// src/main/index.ts) therefore moves to the background file before Electron
// starts, as the same process with the same words, and tells macOS it lives
// at that file. A click while only the background run is up then starts the
// window, even when that run is too busy or stuck to answer it. A start that
// shows a window and reaches the background file moves to the main
// executable the same way, so each copy always runs from its own file.
//
// The background file keeps the app's identity: it carries the app's bundle
// id in an Info.plist of its own, so its signature names the app as the main
// executable's does, with the same Keychain grants and permissions; it reads
// the app's own Info.plist before Electron starts; and the app's code reads
// the main executable as its own program (src/main/appExecutable.ts). Where
// the move to the background file fails, the start goes on where it is, and
// the run's own answer to a click (src/main/runReopen.ts) still opens the
// window; where the background file cannot take the app's info, it hands the
// start back to the main executable, which keeps it there.

#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

// The background file's name beside the main executable's, as the packaging
// step names it (MAC_BACKGROUND_SUFFIX in scripts/place-mac-app-launcher.mjs)
// and the app's code reads it (src/main/appExecutable.ts).
#define BACKGROUND_SUFFIX " Background"

// The first word of each start that shows no window, as src/main/index.ts
// reads it: the work mode (src/main/workCommand.ts), the run
// (src/main/runCommand.ts), and the commands that answer and end
// (src/main/runStatus.ts, src/main/linkCommand.ts, src/main/startAtBoot.ts).
static const char *const WINDOWLESS_WORDS[] = {
    "work", "run", "status", "link", "start-at-boot", "help",
};

// Set by the background file on a windowless start it hands back to the main
// executable, which then keeps the start rather than move it to the
// background file again. Each start reads it and clears it before anything
// else, so nothing the start runs later inherits it.
#define HANDED_BACK "INFINITARY_LAUNCHER_HANDED_BACK"

// As Electron's FixStdioStreams: a stream started closed reads and writes
// /dev/null, so no file the app opens later takes its number.
static void steady_standard_streams(void) {
  struct stat st;
  if (fstat(STDIN_FILENO, &st) < 0 && errno == EBADF) (void)freopen("/dev/null", "r", stdin);
  if (fstat(STDOUT_FILENO, &st) < 0 && errno == EBADF) (void)freopen("/dev/null", "w", stdout);
  if (fstat(STDERR_FILENO, &st) < 0 && errno == EBADF) (void)freopen("/dev/null", "w", stderr);
}

// Whether the first word past Chromium's own switches is one of a windowless
// start's, as commandWords (src/main/workCommand.ts) reads a packaged app's.
static bool shows_no_window(int argc, char *argv[]) {
  int index = 1;
  while (index < argc && strncmp(argv[index], "--", 2) == 0) index += 1;
  if (index >= argc) return false;
  for (size_t word = 0; word < sizeof WINDOWLESS_WORDS / sizeof *WINDOWLESS_WORDS; word += 1)
    if (strcmp(argv[index], WINDOWLESS_WORDS[word]) == 0) return true;
  return false;
}

static bool own_file(char out[PATH_MAX]) {
  char started[PATH_MAX];
  uint32_t size = sizeof started;
  return _NSGetExecutablePath(started, &size) == 0 && realpath(started, out) != NULL;
}

// Runs `file` in this process with the same words and environment. It
// returns only when macOS refused, and the start then goes on where it is.
static void move_to(const char *file, char *argv[]) {
  execv(file, argv);
  fprintf(stderr, "Infinitary: could not start from %s: %s\n", file, strerror(errno));
}

// Gives this copy the app's own info and names `file` as the place macOS
// lists it under, answering whether both took.
//
// The background file carries an Info.plist of its own that holds only the
// app's bundle id, for its signature; macOS reads that list, not the app's,
// as the info of a file that carries one. So the app's own Info.plist is
// read back from the app's folder into the main bundle's info dictionary
// before anything else reads it. The app checks in with macOS once, while
// Electron makes its NSApplication, and that check-in reads the same
// dictionary, where LSBundlePath is the place it names. Set here, before
// Electron starts any thread, it is never read half-written; a dictionary
// macOS made unchangeable refuses the change, and the start moves to the
// main executable.
static bool live_at(const char *file, const char *app) {
  @autoreleasepool {
    CFBundleRef bundle = CFBundleGetMainBundle();
    if (bundle == NULL) return false;
    CFURLRef folder = CFBundleCopyBundleURL(bundle);
    if (folder == NULL) return false;
    NSDictionary *appInfo = CFBridgingRelease(CFBundleCopyInfoDictionaryInDirectory(folder));
    CFRelease(folder);
    NSString *path = [NSString stringWithUTF8String:file];
    NSString *name = [[NSString stringWithUTF8String:app] lastPathComponent];
    id info = (__bridge id)CFBundleGetInfoDictionary(bundle);
    // The app's own list names the main executable beside this file.
    if (path == nil || info == nil || ![appInfo[@"CFBundleExecutable"] isEqual:name]) return false;
    @try {
      [(NSMutableDictionary *)info removeAllObjects];
      [(NSMutableDictionary *)info addEntriesFromDictionary:appInfo];
      [(NSMutableDictionary *)info setObject:path forKey:@"LSBundlePath"];
      return true;
    } @catch (NSException *refused) {
      fprintf(stderr, "Infinitary: starting from the app's main executable instead: %s\n",
              refused.reason.UTF8String ?: "its info could not change");
      return false;
    }
  }
}

// Moves a windowless start to the background file and a window's start to
// the main executable, and has macOS list a windowless one at its own file.
static void run_from_own_file(int argc, char *argv[]) {
  bool handed_back = getenv(HANDED_BACK) != NULL;
  unsetenv(HANDED_BACK);
  char own[PATH_MAX];
  if (!own_file(own)) return;
  bool windowless = shows_no_window(argc, argv);
  size_t length = strlen(own), suffix = strlen(BACKGROUND_SUFFIX);
  if (length <= suffix || strcmp(own + length - suffix, BACKGROUND_SUFFIX) != 0) {
    // The main executable, which keeps a start the background file handed back.
    if (!windowless || handed_back) return;
    char named[PATH_MAX], background[PATH_MAX];
    if (snprintf(named, sizeof named, "%s%s", own, BACKGROUND_SUFFIX) >= (int)sizeof named) return;
    // A background file that is missing, or that leads back here, leaves the
    // start where it is.
    if (realpath(named, background) == NULL || strcmp(background, own) == 0) return;
    move_to(background, argv);
    return;
  }
  // The background file, beside the main executable whose name it ends with.
  char app[PATH_MAX];
  memcpy(app, own, length - suffix);
  app[length - suffix] = '\0';
  if (!windowless) {
    move_to(app, argv);
    return;
  }
  if (live_at(own, app)) return;
  setenv(HANDED_BACK, "1", 1);
  move_to(app, argv);
  unsetenv(HANDED_BACK);
}

int main(int argc, char *argv[]) {
  steady_standard_streams();
  run_from_own_file(argc, argv);

  void *framework = dlopen("@executable_path/../Frameworks/Electron Framework.framework/Electron Framework",
                           RTLD_NOW | RTLD_GLOBAL);
  if (framework == NULL) {
    fprintf(stderr, "Infinitary could not load Electron Framework: %s\n", dlerror());
    return 1;
  }

  bool (*run_as_node_allowed)(void) =
      (bool (*)(void))dlsym(framework, "_ZN8electron5fuses18IsRunAsNodeEnabledEv");
  const char *run_as_node = getenv("ELECTRON_RUN_AS_NODE");
  if (run_as_node_allowed != NULL && run_as_node_allowed() && run_as_node != NULL && run_as_node[0] != '\0') {
    int (*start_node)(int, char **) = (int (*)(int, char **))dlsym(framework, "ElectronInitializeICUandStartNode");
    if (start_node != NULL) return start_node(argc, argv);
  }

  int (*electron_main)(int, char **) = (int (*)(int, char **))dlsym(framework, "ElectronMain");
  if (electron_main == NULL) {
    fprintf(stderr, "Infinitary could not start Electron: %s\n", dlerror());
    return 1;
  }
  return electron_main(argc, argv);
}
