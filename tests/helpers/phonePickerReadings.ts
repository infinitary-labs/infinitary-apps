import { phoneLogMilliseconds } from "./phoneKeyboard";

// INF-1477: the iPhone's second photo tap, from a real phone run's compact log. Its lift reached the photo picker late,
// and the picker logged its context menu line as it handled the lift.
export const photosPicker =
  "/System/Library/ExtensionKit/Extensions/PhotosPicker.appex/PhotosPicker";
export const pickerHeld = {
  processImagePath: photosPicker,
  timestamp: "2026-10-27 11:06:59.624000+0000",
  eventMessage: "performAllAnimations for animator: <_UIContextMenuAnimator: 0x1162914d0>",
};
// When testmanagerd began synthesizing that photo tap.
export const photoTapBegan = phoneLogMilliseconds("2026-10-27 11:06:57.803000+0000");
