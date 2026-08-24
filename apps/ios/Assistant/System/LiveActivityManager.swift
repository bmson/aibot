import ActivityKit
import Foundation

@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private var current: Activity<AssistantActivityAttributes>?
    private var stateObservationTask: Task<Void, Never>?

    private init() {}

    func ensure(
        agentName: String,
        thought: AssistantThought,
        detail: String,
        pendingCount: Int = 0
    ) async {
        // The system Island belongs to urgent, owner-actionable work only.
        // Generic progress is shown by the in-app crown and must never keep a
        // wide/timed Live Activity alive over the system clock.
        guard Self.shouldPresentSystemActivity(for: thought) else {
            await dismiss()
            return
        }
        if current == nil { await start(agentName: agentName, thought: thought, detail: detail) }
        guard let current else { return }
        await current.update(Self.content(thought: thought, detail: detail, pendingCount: pendingCount, now: .now))
    }

    func start(agentName: String, thought: AssistantThought, detail: String) async {
        guard Self.shouldPresentSystemActivity(for: thought) else {
            await dismiss()
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        await endAllImmediately()
        let content = Self.content(thought: thought, detail: detail, pendingCount: 0, now: .now)

        do {
            let activity = try Activity<AssistantActivityAttributes>.request(
                attributes: AssistantActivityAttributes(agentName: agentName, startedAt: .now),
                content: content,
                pushType: nil
            )
            current = activity
            observeState(of: activity)
        } catch {
            current = nil
        }
    }

    func update(thought: AssistantThought, detail: String) async {
        guard Self.shouldPresentSystemActivity(for: thought) else {
            await dismiss()
            return
        }
        guard let current else { return }
        await current.update(Self.content(thought: thought, detail: detail, pendingCount: 0, now: .now))
    }

    func needsAttention(agentName: String, detail: String, pendingCount: Int) async {
        await ensure(agentName: agentName, thought: .needsYou, detail: detail, pendingCount: pendingCount)
    }

    func finish(
        thought: AssistantThought,
        detail: String,
        succeeded _: Bool
    ) async {
        guard let current else { return }
        let content = Self.content(
            thought: thought,
            detail: detail,
            pendingCount: 0,
            now: .now
        )
        await current.end(content, dismissalPolicy: .immediate)
        self.current = nil
        stateObservationTask?.cancel()
    }

    func dismiss() async {
        await endAllImmediately()
    }

    nonisolated static func content(
        thought: AssistantThought,
        detail: String,
        pendingCount: Int,
        now: Date
    ) -> ActivityContent<AssistantActivityAttributes.ContentState> {
        let state = AssistantActivityAttributes.ContentState(
            thought: thought,
            detail: safeDetail(for: thought, proposed: detail),
            pendingCount: pendingCount,
            updatedAt: now
        )
        return ActivityContent(
            state: state,
            staleDate: staleDate(for: thought, now: now),
            relevanceScore: relevanceScore(for: thought)
        )
    }

    private func observeState(of activity: Activity<AssistantActivityAttributes>) {
        stateObservationTask?.cancel()
        stateObservationTask = Task { [weak self] in
            for await state in activity.activityStateUpdates {
                guard !Task.isCancelled else { return }
                if state == .ended || state == .dismissed {
                    guard let self, self.current?.id == activity.id else { return }
                    self.current = nil
                    return
                }
            }
        }
    }

    private func endAllImmediately() async {
        stateObservationTask?.cancel()
        for activity in Activity<AssistantActivityAttributes>.activities {
            await activity.end(activity.content, dismissalPolicy: .immediate)
        }
        current = nil
    }

    nonisolated private static func staleDate(for thought: AssistantThought, now: Date) -> Date? {
        switch thought.tone {
        case .thinking, .working:
            now.addingTimeInterval(60)
        case .waiting, .done, .failed:
            nil
        }
    }

    nonisolated static func shouldPresentSystemActivity(for thought: AssistantThought) -> Bool {
        thought.tone == .waiting
    }

    nonisolated private static func relevanceScore(for thought: AssistantThought) -> Double {
        switch thought.tone {
        case .waiting: 1
        case .failed: 0.9
        case .working: 0.75
        case .thinking: 0.65
        case .done: 0.45
        }
    }

    /// A concise, non-sensitive activity description that is safe to show in
    /// both the system Live Activity and the in-app activity crown.
    nonisolated static func safeDetail(for thought: AssistantThought, proposed detail: String) -> String {
        switch thought.tone {
        case .thinking:
            return "Preparing a response"
        case .waiting:
            return "A decision is ready to review"
        case .done:
            return "Your result is ready"
        case .failed:
            if thought == .stoppedByYou { return "You stopped this turn" }
            return "Open Assistant for details"
        case .working:
            if detail.range(of: #"^Step \d+$"#, options: .regularExpression) != nil {
                return detail
            }
            if thought == .replying { return "Writing a response" }
            if thought == .backgroundWork { return "Continuing in the background" }
            return "Working on your request"
        }
    }

}
