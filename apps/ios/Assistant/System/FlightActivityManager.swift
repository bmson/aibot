import ActivityKit
import Foundation

/// Flights followed on the Lock Screen: one activity per flight, started from
/// its card and kept current with every read of that flight — the card's live
/// polling while it is on screen, and a sweep each time the app comes forward.
///
/// Separate from `LiveActivityManager`, whose single activity is the approval
/// prompt. A flight the owner asked to follow is theirs to dismiss.
@MainActor
final class FlightActivityManager {
    static let shared = FlightActivityManager()

    private init() {}

    var available: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    func isFollowing(_ flightId: String) -> Bool {
        activity(for: flightId) != nil
    }

    /// Starts following, or brings an existing activity up to date.
    @discardableResult
    func follow(_ flight: FlightSnapshot) async -> Bool {
        guard available else { return false }
        if activity(for: flight.id) != nil {
            await update(flight)
            return true
        }
        let state = flight.activityState()
        guard !state.isOver else { return false }
        do {
            _ = try Activity<FlightActivityAttributes>.request(
                attributes: flight.activityAttributes,
                content: content(state),
                pushType: nil
            )
            return true
        } catch {
            return false
        }
    }

    func stopFollowing(_ flightId: String) async {
        guard let activity = activity(for: flightId) else { return }
        await activity.end(activity.content, dismissalPolicy: .immediate)
    }

    /// A fresh read of a followed flight. Unfollowed flights are ignored; a
    /// flight at the gate or cancelled ends its activity, left on the Lock
    /// Screen for a while so the last state can still be read.
    func update(_ flight: FlightSnapshot) async {
        guard let activity = activity(for: flight.id) else { return }
        let state = flight.activityState()
        if state.isOver {
            await activity.end(content(state), dismissalPolicy: .after(.now.addingTimeInterval(60 * 60)))
        } else {
            await activity.update(content(state))
        }
    }

    /// Read every followed flight once, when the app comes forward.
    func refreshAll(using fetch: @MainActor (String) async -> LiveFlightPayload?) async {
        for activity in Activity<FlightActivityAttributes>.activities
        where activity.activityState == .active {
            guard let flight = await fetch(activity.attributes.flightId)?.snapshot else { continue }
            await update(flight)
        }
    }

    private func activity(for flightId: String) -> Activity<FlightActivityAttributes>? {
        Activity<FlightActivityAttributes>.activities.first {
            $0.attributes.flightId == flightId && $0.activityState == .active
        }
    }

    private func content(
        _ state: FlightActivityAttributes.ContentState
    ) -> ActivityContent<FlightActivityAttributes.ContentState> {
        // Stale a while after the moment it counts toward, so an activity the
        // app could not refresh says so instead of looking current.
        let stale = (state.nextMoment ?? .now).addingTimeInterval(30 * 60)
        return ActivityContent(
            state: state,
            staleDate: max(stale, .now.addingTimeInterval(15 * 60)),
            relevanceScore: state.isTrouble ? 1 : 0.7
        )
    }
}
