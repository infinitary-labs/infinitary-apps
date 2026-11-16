// The phone check's hinge helper (INF-4241 piece 8, the captain's "Keep a small helper of our own in the project that
// opens the hinge through the undocumented interface"). scripts/phone-hinge.ts builds it for the iOS simulator and runs
// it inside a simulated iPhone Duo with `simctl spawn`:
//
//   phone-hinge sweep <from> <to> <seconds>   move the hinge from one angle to another, 0 closed and 180 flat
//   phone-hinge angle                          print the hinge angle CoreMotion reports, in degrees
//
// Apple has no command that moves the simulated hinge. Xcode's Device Hub moves it by posting a vendor-defined HID event
// (usage page 0xFF61, usage 0x5B) whose data is a binary-serialized dictionary naming the hinge slider and its angle;
// the simulator's location daemon turns it into the hinge angle UIKit and CoreMotion report. This helper posts the same
// event, and reads the angle back from CoreMotion's private angle manager, the source UIKit's hinge reads. Both are
// undocumented and can change with Xcode; a failure here names itself and the phone check fails the part.

#import <Foundation/Foundation.h>
#import <mach/mach_time.h>

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;

extern IOHIDEventSystemClientRef IOHIDEventSystemClientCreateWithType(CFAllocatorRef, int type, CFDictionaryRef);
extern void IOHIDEventSystemClientDispatchEvent(IOHIDEventSystemClientRef, IOHIDEventRef);
extern CFDataRef IOCFSerialize(CFTypeRef, CFOptionFlags);
extern IOHIDEventRef IOHIDEventCreateVendorDefinedEvent(CFAllocatorRef, uint64_t time, uint32_t page, uint32_t usage,
    uint32_t version, const uint8_t *data, CFIndex length, uint32_t options);

static const int kSimpleClient = 4;
static const CFOptionFlags kBinarySerialization = 1;
static const uint32_t kDeviceStatePage = 0xFF61, kDeviceStateUsage = 0x5B;
// Steps a second while sweeping. The iOS 27.1 simulator stops switching screens after the hinge jumps straight between
// closed and open, so the hinge always moves through the angles between, as Device Hub's slider does.
static const double kStepsPerSecond = 60;

// Device Hub's provider name differs between CoreSimulator versions; each event carries an absolute angle, so the
// simulator takes the one under its own name and the other changes nothing.
static void post(IOHIDEventSystemClientRef client, double degrees) {
    for (NSString *provider in @[ @"com.apple.Virtualization.VirtualMachines", @"com.apple.Virtualization" ]) {
        NSDictionary *state = @{ @"provider": provider, @"source": @"hinge-slider-control", @"type": @"range", @"value": @(degrees) };
        NSData *data = CFBridgingRelease(IOCFSerialize((__bridge CFTypeRef)state, kBinarySerialization));
        IOHIDEventRef event = IOHIDEventCreateVendorDefinedEvent(NULL, mach_absolute_time(), kDeviceStatePage, kDeviceStateUsage,
                                                                 0, data.bytes, (CFIndex)data.length, 0);
        IOHIDEventSystemClientDispatchEvent(client, event);
        CFRelease(event);
    }
}

static int sweep(double from, double to, double seconds) {
    IOHIDEventSystemClientRef client = IOHIDEventSystemClientCreateWithType(NULL, kSimpleClient, NULL);
    if (!client) {
        fprintf(stderr, "phone-hinge: the simulator's HID event system gave no client\n");
        return 1;
    }
    int steps = MAX(1, (int)(seconds * kStepsPerSecond));
    for (int step = 1; step <= steps; step++) {
        double t = (double)step / steps;
        post(client, from + (to - from) * t * t * (3 - 2 * t));
        if (step < steps) usleep((useconds_t)(1e6 / kStepsPerSecond));
    }
    // The event system delivers on its own queue; leaving at once can drop the last angle.
    usleep(100000);
    CFRelease(client);
    return 0;
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
        fprintf(stderr, "usage: phone-hinge sweep <from> <to> <seconds>\n       phone-hinge angle\n");
        return 64;
    }
}
