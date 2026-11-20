# The freeze summary covers a whole version

The captain asked that the once-per-version freeze summary cover every freeze that version had, and chose on INF-3044's plan to send it when the app first starts on the next version, listing every location with its count and time, most time first.
The `freeze-recorded` wake now owns that summary: the ended version, its runs and minutes awake, how many times the main thread stopped, about how many a minute, their time and processor time in all, any that never finished, every captured location most time first with its count, time, processor time, longest, first and last seen and uncertain marks, and the longest stall's identity and capture timing.
The host no longer sends the summary while a version runs; a wake saved before this change keeps its old words.
The wake's fixed words grow by about 90 tokens, and each location adds about 50, spilling to a file past the message limit; the fixed context does not change.
