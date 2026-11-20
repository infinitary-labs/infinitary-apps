// The phone check's hinge helper (INF-4241 piece 8, the captain's "Keep a small helper of our own in the project that
// opens the hinge through the undocumented interface"). scripts/phone-hinge.ts builds it for the iOS simulator and runs
// it inside a simulated iPhone Duo with `simctl spawn`:
//
//   phone-hinge sweep <from> <to> <seconds>   move the hinge from one angle to another, 0 closed and 180 flat
//   phone-hinge angle                          print the hinge angle CoreMotion reports, in degrees
//   phone-hinge turn <orientation>             turn the device: portrait, pud, landscape-left or landscape-right
//   phone-hinge key <name>                     press a key once, as an attached keyboard does: tab, return or escape
//
// Apple has no command that moves the simulated hinge. Xcode's Device Hub moves it by posting a vendor-defined HID event
// (usage page 0xFF61, usage 0x5B) whose data is a binary-serialized dictionary naming the hinge slider and its angle;
// the simulator's location daemon turns it into the hinge angle UIKit and CoreMotion report. Device Hub's orientation
// picker posts the same event naming its own control, which turns the device; unlike XCUIDevice's orientation, it turns
// the open Duo's inner screen too. This helper posts the same events, and reads the angle back from CoreMotion's private angle manager, the source UIKit's hinge reads. Both are
// undocumented and can change with Xcode; a failure here names itself and the phone check fails the part.
//
// INF-5183: XCTest's typeKey gives its key a keyboard bound to one display, and while the Duo is open the simulator's
// event router finds that key no destination, so the app never receives it. An attached keyboard names no display, and
// its key goes to whichever app holds keyboard focus. `key` posts that keyboard event, usage page 7, down then up.

#import <Foundation/Foundation.h>
#import <mach/mach_time.h>

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;

extern IOHIDEventSystemClientRef IOHIDEventSystemClientCreateWithType(CFAllocatorRef, int type, CFDictionaryRef);
extern void IOHIDEventSystemClientDispatchEvent(IOHIDEventSystemClientRef, IOHIDEventRef);
extern CFDataRef IOCFSerialize(CFTypeRef, CFOptionFlags);
extern IOHIDEventRef IOHIDEventCreateVendorDefinedEvent(CFAllocatorRef, uint64_t time, uint32_t page, uint32_t usage,
    uint32_t version, const uint8_t *data, CFIndex length, uint32_t options);
extern IOHIDEventRef IOHIDEventCreateKeyboardEvent(CFAllocatorRef, uint64_t time, uint32_t page, uint32_t usage, Boolean down,
    uint32_t options);

static const int kSimpleClient = 4;
static const CFOptionFlags kBinarySerialization = 1;
static const uint32_t kDeviceStatePage = 0xFF61, kDeviceStateUsage = 0x5B;
static const uint32_t kKeyboardPage = 0x07;
// How long a key stays down, in microseconds: long enough to read as one press, far short of a key repeat.
static const useconds_t kKeyHeld = 40000;
// Steps a second while sweeping. The iOS 27.1 simulator stops switching screens after the hinge jumps straight between
// closed and open, so the hinge always moves through the angles between, as Device Hub's slider does.
static const double kStepsPerSecond = 60;

// Device Hub's provider name differs between CoreSimulator versions; each event carries an absolute angle, so the
// simulator takes the one under its own name and the other changes nothing.
static void post(IOHIDEventSystemClientRef client, NSString *source, NSString *type, id value) {
    for (NSString *provider in @[ @"com.apple.Virtualization.VirtualMachines", @"com.apple.Virtualization" ]) {
        NSDictionary *state = @{ @"provider": provider, @"source": source, @"type": type, @"value": value };
        NSData *data = CFBridgingRelease(IOCFSerialize((__bridge CFTypeRef)state, kBinarySerialization));
        IOHIDEventRef event = IOHIDEventCreateVendorDefinedEvent(NULL, mach_absolute_time(), kDeviceStatePage, kDeviceStateUsage,
                                                                 0, data.bytes, (CFIndex)data.length, 0);
        IOHIDEventSystemClientDispatchEvent(client, event);
        CFRelease(event);
    }
}

static IOHIDEventSystemClientRef client(void) {
    IOHIDEventSystemClientRef made = IOHIDEventSystemClientCreateWithType(NULL, kSimpleClient, NULL);
    if (!made) fprintf(stderr, "phone-hinge: the simulator's HID event system gave no client\n");
    return made;
}

// The event system delivers on its own queue; leaving at once can drop the last event.
static int finish(IOHIDEventSystemClientRef client) {
    usleep(100000);
    CFRelease(client);
    return 0;
}

static int sweep(double from, double to, double seconds) {
    IOHIDEventSystemClientRef hid = client();
    if (!hid) return 1;
    int steps = MAX(1, (int)(seconds * kStepsPerSecond));
    for (int step = 1; step <= steps; step++) {
        double t = (double)step / steps;
        post(hid, @"hinge-slider-control", @"range", @(from + (to - from) * t * t * (3 - 2 * t)));
        if (step < steps) usleep((useconds_t)(1e6 / kStepsPerSecond));
    }
    return finish(hid);
}

static int turn(const char *orientation) {
    NSString *value = @(orientation);
    if (![@[ @"portrait", @"pud", @"landscape-left", @"landscape-right" ] containsObject:value]) {
        fprintf(stderr, "phone-hinge: no orientation %s\n", orientation);
        return 64;
    }
    IOHIDEventSystemClientRef hid = client();
    if (!hid) return 1;
    post(hid, @"orientation-picker-control", @"enum", value);
    return finish(hid);
}

static int key(const char *name) {
    NSNumber *usage = @{ @"tab": @0x2B, @"return": @0x28, @"escape": @0x29 }[@(name)];
    if (!usage) {
        fprintf(stderr, "phone-hinge: no key %s\n", name);
        return 64;
    }
    IOHIDEventSystemClientRef hid = client();
    if (!hid) return 1;
    for (int down = 1; down >= 0; down--) {
        IOHIDEventRef event = IOHIDEventCreateKeyboardEvent(NULL, mach_absolute_time(), kKeyboardPage, usage.unsignedIntValue,
                                                            down == 1, 0);
        IOHIDEventSystemClientDispatchEvent(hid, event);
        CFRelease(event);
        if (down) usleep(kKeyHeld);
    }
    return finish(hid);
}

@interface CMAngle : NSObject
- (float)angleDegrees;
@end

@interface CMAngleManager : NSObject
+ (BOOL)isAvailable;
- (void)startAngleUpdatesToQueue:(NSOperationQueue *)queue handler:(void (^)(CMAngle *angle))handler;
- (void)stopAngleUpdates;
@end

// CoreMotion answers with the current angle as soon as updates start; two seconds without one is a failure.
static int angle(void) {
    Class manager = NSClassFromString(@"CMAngleManager");
    if (!manager || ![manager isAvailable]) {
        fprintf(stderr, "phone-hinge: this simulator reports no hinge\n");
        return 1;
    }
    CMAngleManager *angles = [[manager alloc] init];
    __block BOOL printed = NO;
    [angles startAngleUpdatesToQueue:[NSOperationQueue new] handler:^(CMAngle *reading) {
        if (printed) return;
        printed = YES;
        printf("%.1f\n", [reading angleDegrees]);
        fflush(stdout);
        CFRunLoopStop(CFRunLoopGetMain());
    }];
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 2, false);
    [angles stopAngleUpdates];
    if (!printed) fprintf(stderr, "phone-hinge: CoreMotion sent no hinge angle within 2 seconds\n");
    return printed ? 0 : 1;
}

static double degrees(const char *value) { return fmin(fmax(atof(value), 0), 180); }

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc == 5 && strcmp(argv[1], "sweep") == 0) return sweep(degrees(argv[2]), degrees(argv[3]), fmax(atof(argv[4]), 0));
        if (argc == 2 && strcmp(argv[1], "angle") == 0) return angle();
        if (argc == 3 && strcmp(argv[1], "turn") == 0) return turn(argv[2]);
        if (argc == 3 && strcmp(argv[1], "key") == 0) return key(argv[2]);
        fprintf(stderr, "usage: phone-hinge sweep <from> <to> <seconds>\n       phone-hinge angle\n       phone-hinge turn <orientation>\n"
                        "       phone-hinge key <tab|return|escape>\n");
        return 64;
    }
}
