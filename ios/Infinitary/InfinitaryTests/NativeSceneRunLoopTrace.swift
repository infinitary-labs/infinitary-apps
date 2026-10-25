import CoreFoundation
import Foundation

/// INF-1066 / INF-1143: retain real main-run-loop progress beside display callbacks when warmup stalls.
/// This observes the existing wait; it adds no prerequisite, timer, retry or changed deadline.
final class NativeSceneRunLoopTrace: @unchecked Sendable {
    struct Entry: Sendable {
        let uptime: Double
        let event: String
        let mainThread: Bool
    }
    private let lock = NSLock()
    private var entries: [Entry] = []
    private var observer: CFRunLoopObserver?

    @MainActor init() {
        record("warmup-start")
        let activities: CFRunLoopActivity = [.afterWaiting, .beforeSources, .beforeWaiting]
        observer = CFRunLoopObserverCreateWithHandler(nil, activities.rawValue, true, 0) { [weak self] _, activity in
            let event: String
            switch activity {
            case .afterWaiting: event = "after-waiting"
            case .beforeSources: event = "before-sources"
            case .beforeWaiting: event = "before-waiting"
            default: return
            }
            self?.record(event)
        }
        if let observer { CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes) }
    }

    @MainActor func finish() -> [Entry] {
        if let observer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
        observer = nil
        record("warmup-end")
        return lock.withLock { entries }
    }

    private func record(_ event: String) {
        let entry = Entry(uptime: ProcessInfo.processInfo.systemUptime, event: event, mainThread: Thread.isMainThread)
        lock.withLock { entries.append(entry) }
    }
}
