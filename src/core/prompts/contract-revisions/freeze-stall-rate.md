# The freeze summary carries the run's stall rate

INF-2971's audit found the app's main thread stopping about three times a minute while the `freeze-recorded` wake reached the first mate with one stall each time, the first of each start, which it judged too short to look into; the captain chose to start its fix.
The `freeze-recorded` wake now owns one more fact: how many stalls this run has had since the app started, over how many minutes, about how many a minute, their time in all and any that never finished, with the longest stall as the example whose call path, timing and identity it names as before.
The host sends that summary at the recorder's first periodic reading after a stall, still once per installed version; a wake queued before this change keeps its old words.
The wake adds about 60 tokens per freeze notice and no fixed context.
