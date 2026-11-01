import { describe, expect, it } from "vitest";
import { phoneGuestJourneyFinished, phoneGuestLaunches } from "./helpers/phoneGuestLaunches";

// INF-1936, approved observer correction: real readings from run 41118788839,
// artifact 13008847316. The healthy creation arrived at row 25, its request at 81;
// the later delayed request/creation/response are rows 3276, 3283 and 3566.
// These are minimal parser fixtures, not a simulator or sampler stand-in.
const healthyCreation =
  "2026-10-30 19:59:13.453 Df runningboardd[5854:5d53] [com.apple.runningboard:job] Creating and launching job for: extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7003)>[uuid:B931253F-56DC-47A0-8A61-91551565C96C]";
const healthyRequest =
  '2026-10-30 19:59:13.444 I  Infinitary[7003:7b5a] [com.apple.runningboard:general] Sending launch request: <RBSLaunchRequest| extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7003)>[uuid:B931253F-56DC-47A0-8A61-91551565C96C]; "(null)">';
const healthyResponse =
  "2026-10-30 19:59:13.488 I  runningboardd[5854:5d53] [com.apple.runningboard:process] Process: [extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7003)>[uuid:B931253F-56DC-47A0-8A61-91551565C96C]:7068] with pid: 7068; launch assertion: 5854-7003-924";
const delayedRequest =
  '2026-10-30 20:01:14.206 I  Infinitary[7003:892c] [com.apple.runningboard:general] Sending launch request: <RBSLaunchRequest| extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7003)>[uuid:20B620ED-ACC2-49EE-A192-1E91AF3E4085]; "(null)">';
const delayedCreation =
  "2026-10-30 20:01:14.208 Df runningboardd[5854:8930] [com.apple.runningboard:job] Creating and launching job for: extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7003)>[uuid:20B620ED-ACC2-49EE-A192-1E91AF3E4085]";
const delayedResponse =
  "2026-10-30 20:03:39.375 I  runningboardd[5854:8930] [com.apple.runningboard:process] Process: [extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7003)>[uuid:20B620ED-ACC2-49EE-A192-1E91AF3E4085]:7402] with pid: 7402; launch assertion: 5854-7003-1188";
const queuedRequest =
  '2026-10-30 20:01:20.725 I  Infinitary[7003:78fa] [com.apple.runningboard:general] Sending launch request: <RBSLaunchRequest| extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7003)>[uuid:D0FC68E7-36F3-4754-98D2-27DF12ED95C7]; "(null)">';
const otherResponse =
  "2026-10-30 19:59:17.050 I  runningboardd[5855:579b] [com.apple.runningboard:process] Process: [extension<com.apple.WebKit.WebContent[config:6E69CA09-34E3-3493-B8FC-B5021E1ACB71]((null):7021)>[uuid:997A5479-AA31-4FB0-B074-18D2FA31D4A9]:7096] with pid: 7096; launch assertion: 5855-7021-963";
const failed = "Test Case '-[InfinitaryUITests.PhoneJourney testCards]' failed (353.667 seconds).";
const nonterminal =
  '/Users/admin/fm-actions-runner/_work/infinitary/infinitary/Application Support/firstmate/ios/Infinitary/InfinitaryUITests/PhoneJourney.swift:978: error: -[InfinitaryUITests.PhoneJourney testCards] : XCTAssertEqual failed: ("XCTWaiterResult(rawValue: 2)") is not equal to ("XCTWaiterResult(rawValue: 1)") - The shown card body was never revealed';
const passed = "Test Case '-[InfinitaryUITests.PhoneJourney testCards]' passed (679.147 seconds).";

const manager = Number(/runningboardd\[(\d+):/.exec(healthyCreation)![1]);

describe("INF-1936: preserve the capture through the delayed launch response", () => {
  it("remembers an early creation witness without spending capture on a healthy launch", () => {
    const reader = phoneGuestLaunches(manager);
    expect(reader.receive(healthyCreation)?.completed).toBeUndefined();
    const request = reader.receive(healthyRequest);
    expect(request?.launch.creation?.nativeLine).toBe(healthyCreation);
    expect(request?.completed).toBeUndefined();
    expect(reader.receive(healthyResponse)?.completed?.delayed).toBe(false);
  });

  it("stays available for a later delayed launch, through creation and queued requests", () => {
    const reader = phoneGuestLaunches(manager);
    for (const line of [
      healthyCreation,
      healthyRequest,
      healthyResponse,
      delayedRequest,
      delayedCreation,
      queuedRequest,
    ])
      expect(reader.receive(line)?.completed?.delayed).not.toBe(true);
    const response = reader.receive(delayedResponse);
    expect(response?.launch.request?.nativeLine).toBe(delayedRequest);
    expect(response?.launch.creation?.nativeLine).toBe(delayedCreation);
    expect(response?.completed).toEqual({
      delayed: true,
      elapsedMs: Date.parse(delayedResponse.slice(0, 23)) - Date.parse(delayedRequest.slice(0, 23)),
    });
    // A repeated reading cannot request a second capture stop.
    expect(reader.receive(delayedResponse)?.completed).toBeUndefined();
    expect(reader.receive(delayedRequest)?.completed).toBeUndefined();
  });

  it("matches an early response only to its own request", () => {
    const reader = phoneGuestLaunches(manager);
    expect(reader.receive(delayedResponse)?.completed).toBeUndefined();
    expect(reader.receive(queuedRequest)?.completed).toBeUndefined();
    expect(reader.receive(delayedCreation)?.completed).toBeUndefined();
    expect(reader.receive(delayedRequest)?.completed?.delayed).toBe(true);
  });

  it("accepts responses only from the preflight's manager", () => {
    const otherManager = Number(/runningboardd\[(\d+):/.exec(otherResponse)![1]);
    const reader = phoneGuestLaunches(otherManager);
    expect(reader.receive(delayedRequest)?.completed).toBeUndefined();
    expect(reader.receive(delayedCreation)).toBeUndefined();
    expect(reader.receive(delayedResponse)).toBeUndefined();
  });

  it("stops on the native cards result, not the earlier assertion output", () => {
    expect(phoneGuestJourneyFinished(nonterminal)).toBe(false);
    expect(phoneGuestJourneyFinished(failed)).toBe(true);
    expect(phoneGuestJourneyFinished(passed)).toBe(true);
  });
});
