/**
 * How many frames a gesture waits for its frame to hold focus: a click
 * focuses the frame and posts its message at once, and the two reach the
 * shell separately, so the focus may arrive a frame or two after the words.
 */
export const GESTURE_FOCUS_FRAMES = 6;
