import ActivityKit
import Foundation

/// Where a followed flight's push token goes, and where an unfollow is sent.
/// Set once at the root; nil in previews and tests, where nothing is sent.
struct FlightFollowRegistrar {
    let follow: @MainActor (FlightFollowBody) async -> Void
    let unfollow: @MainActor (String) async -> Void
}

/// Flights followed on the Lock Screen: one activity per flight, started from
/// its card. The activity is requested with a push token, which goes to the
/// server so it can keep the flight current while the app is closed
/// (modules/flights/follow.ts). While the app runs, every read of the flight —
/// the card's own polling, and a sweep whenever the app comes forward — also
/// updates it directly.
///
/// Separate from `LiveActivityManager`, whose single activity is the approval
/// prompt. A flight the owner asked to follow is theirs to dismiss, and
/// dismissing it stops the server's pushes too.
@MainActor
final class FlightActivityManager {
    static let shared = FlightActivityManager()

    var registrar: FlightFollowRegistrar?
    private var observers: [String: Task<Void, Never>] = [:]

    private init() {}

    var available: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    func isFollowing(_ flightId: String) -> Bool {
        activity(for: flightId) != nil
    }

    /// Starts following, or brings an existing activity up to date.
    @discardableResult
    func follow(_ flight: FlightSnapshot, until: Date? = nil) async -> Bool {
        guard available else { return false }
        if activity(for: flight.id) != nil {
            await update(flight)
            return true
        }
        let state = flight.activityState()
        guard !state.isOver else { return false }
        do {
            let activity = try Activity<FlightActivityAttributes>.request(
                attributes: flight.activityAttributes,
                content: content(state),
                pushType: .token
            )
            observe(activity, until: until)
            return true
        } catch {
            return false
        }
    }

    func stopFollowing(_ flightId: String) async {
        guard let activity = activity(for: flightId) else { return }
        await activity.end(activity.content, dismissalPolicy: .immediate)
        await registrar?.unfollow(flightId)
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

    /// Read every followed flight once, when the app comes forward, and pick
    /// the push tokens back up for activities started before this launch.
    func refreshAll(using fetch: @MainActor (String) async -> LiveFlightPayload?) async {
        for activity in Activity<FlightActivityAttributes>.activities
        where activity.activityState == .active {
            observe(activity, until: nil)
            guard let flight = await fetch(activity.attributes.flightId)?.snapshot else { continue }
            await update(flight)
        }
    }

    /// Hands each push token ActivityKit issues (and re-issues) to the server,
    /// and tells it to stop once the owner ends the activity.
    private func observe(_ activity: Activity<FlightActivityAttributes>, until: Date?) {
        guard observers[activity.id] == nil else { return }
        let attributes = activity.attributes
        let untilText = until.map { $0.formatted(.iso8601) }
        observers[activity.id] = Task { [weak self] in
            await withTaskGroup(of: Void.self) { group in
                group.addTask { @MainActor in
                    for await token in activity.pushTokenUpdates {
                        guard !Task.isCancelled else { return }
                        await self?.registrar?.follow(FlightFollowBody(
                            flightId: attributes.flightId,
                            ident: attributes.ident,
                            pushToken: Self.hex(token),
                            until: untilText
                        ))
                    }
                }
                group.addTask { @MainActor in
                    for await state in activity.activityStateUpdates {
                        guard state == .dismissed || state == .ended else { continue }
                        await self?.registrar?.unfollow(attributes.flightId)
                        self?.observers[activity.id]?.cancel()
                        self?.observers[activity.id] = nil
                        return
                    }
                }
            }
        }
    }

    nonisolated static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    private func activity(for flightId: String) -> Activity<FlightActivityAttributes>? {
        Activity<FlightActivityAttributes>.activities.first {
            $0.attributes.flightId == flightId && $0.activityState == .active
        }
    }

    private func content(
        _ state: FlightActivityAttributes.ContentState
    ) -> ActivityContent<FlightActivityAttributes.ContentState> {
        // Stale a while after the moment it counts toward, so an activity
        // nothing could refresh says so instead of looking current.
        let stale = (state.nextMoment ?? .now).addingTimeInterval(30 * 60)
        return ActivityContent(
            state: state,
            staleDate: max(stale, .now.addingTimeInterval(15 * 60)),
            relevanceScore: state.isTrouble ? 1 : 0.7
        )
    }
}
