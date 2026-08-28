import Foundation

/// Pure timing policy for mobile chat refreshes. Keeping backoff separate from
/// AppModel makes the user-visible state owner smaller and lets tests lock down
/// network behavior without constructing an API client or a SwiftUI view.
enum PollingPolicy {
    /// Fast enough to make a just-started reply feel live; once a task has
    /// taken longer, favour battery and server headroom over sub-second polls.
    static func replyIntervalMilliseconds(attempt: Int, hasTaskID: Bool) -> Int64 {
        if !hasTaskID {
            switch attempt {
            case 0...7: return 650
            case 8...23: return 1_500
            default: return 2_500
            }
        }
        switch attempt {
        case 0...3: return 1_500
        case 4...19: return 3_000
        default: return 5_000
        }
    }

    /// Idle polling backs off after quiet refreshes and resets immediately on
    /// any server change. It is only used while the scene is active.
    static func idleIntervalSeconds(unchangedPolls: Int) -> Double {
        switch unchangedPolls {
        case 0...2: return 12
        case 3...5: return 24
        case 6...9: return 48
        default: return 90
        }
    }
}
