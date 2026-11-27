// The phone check's Face ID helper (INF-7013). scripts/phone-simulator.ts builds it for the iOS simulator, and the gate
// runs it inside a simulator with `simctl spawn` before a part when the simulator's Face ID interface is not running.
//
// iOS gives a Face ID request five seconds to show its prompt. A request that finds the interface's process not running
// starts that process inside the five seconds, and on a busy phone Mac the start alone took up to ten, so the part's
// request failed with LocalAuthentication's error -1000. The helper asks for Face ID as an app does, or for the passcode
// on a simulator with no face enrolled, which starts the interface the way an app's request does. Once the interface has
// started the gate stops the helper with SIGTERM, and the helper cancels its request, which takes its prompt away. The
// interface stays running, suspended between prompts, and the part's requests use it.
//
// `simctl launch` can start the interface too, as an app with a screen of its own, but the interface closes a screen it
// did not ask for and the iPad's SpringBoard then ends it within seconds. A request starts it with no screen of its own.
//
// It prints one line, how its request was answered, and exits.

#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <signal.h>

int main(void) {
  @autoreleasepool {
    LAContext *context = [LAContext new];
    // SIGTERM cancels the request instead of ending the process, so its prompt goes before the helper does.
    signal(SIGTERM, SIG_IGN);
    dispatch_source_t stop = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(stop, ^{
      [context invalidate];
    });
    dispatch_resume(stop);
    [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
            localizedReason:@"The phone check starts Face ID before a part"
                      reply:^(BOOL success, NSError *error) {
      // LocalAuthentication's own words for a failure are in its debug description; its localized one says only
      // "Authentication failure." for a request whose prompt never came.
      NSString *said = error.userInfo[NSDebugDescriptionErrorKey] ?: error.localizedDescription;
      if (success) printf("answered: allowed\n");
      else printf("answered: %s %ld, %s\n", error.domain.UTF8String, (long)error.code, said.UTF8String);
      fflush(stdout);
      exit(0);
    }];
    dispatch_main();
  }
}
