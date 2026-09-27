import ActivityKit
import SwiftUI

/// Reads a flight again from the live endpoint. Injected at the root, like
/// `liveScoreboard`, so a card deep in the transcript needs no plumbing.
typealias LiveFlightFetch = @MainActor (String) async -> LiveFlightPayload?

private struct LiveFlightFetchKey: EnvironmentKey {
    static let defaultValue: LiveFlightFetch? = nil
}

extension EnvironmentValues {
    var liveFlight: LiveFlightFetch? {
        get { self[LiveFlightFetchKey.self] }
        set { self[LiveFlightFetchKey.self] = newValue }
    }
}

/// Keeps a live generated card current while it is on screen: reads its
/// flight again at the pace the server set, swaps the new spec in place, and
/// hands each read to a Lock Screen activity following the same flight.
/// Stops by itself once the server stops sending `live` — the flight is at
/// the gate, or cancelled.
struct LiveGeneratedCardHost<Content: View>: View {
    let card: MessageResponseCard.GeneratedCard
    @ViewBuilder let content: (MessageResponseCard.GeneratedCard) -> Content

    @State private var current: MessageResponseCard.GeneratedCard?
    @State private var lastRead: Date?
    @State private var onScreen = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.liveFlight) private var fetchLive

    private var shown: MessageResponseCard.GeneratedCard { current ?? card }
    private var polling: Bool {
        (shown.live?.isCurrent ?? false) && fetchLive != nil && onScreen && scenePhase == .active
    }

    var body: some View {
        content(shown)
            .onScrollVisibilityChange(threshold: 0.2) { onScreen = $0 }
            .onAppear { onScreen = true }
            .onDisappear { onScreen = false }
            .task(id: polling) {
                guard polling else { return }
                while !Task.isCancelled {
                    let pace = TimeInterval(shown.live?.pollSeconds ?? 300)
                    // A card scrolled back to after a while reads at once;
                    // one that was just drawn waits its turn.
                    let since = lastRead.map { Date.now.timeIntervalSince($0) } ?? .infinity
                    if since < pace {
                        try? await Task.sleep(for: .seconds(pace - since))
                    }
                    guard !Task.isCancelled, polling, let fetchLive, let id = shown.live?.id else { return }
                    lastRead = .now
                    guard let payload = await fetchLive(id) else { continue }
                    if let refreshed = Self.card(from: payload, replacing: shown) { current = refreshed }
                    if let flight = payload.snapshot { await FlightActivityManager.shared.update(flight) }
                }
            }
    }

    /// The fresh spec, parsed the way every generated card is, keeping this
    /// card's identity and the trail of steps that built it.
    static func card(
        from payload: LiveFlightPayload,
        replacing old: MessageResponseCard.GeneratedCard
    ) -> MessageResponseCard.GeneratedCard? {
        var data: [String: JSONValue] = [
            "kind": .string("generated-card"),
            "id": .string(old.id),
            "grounding": .string("evidence"),
            "spec": payload.spec,
        ]
        if let live = payload.live { data["live"] = live }
        if let fetchedAt = payload.fetchedAt { data["updatedAt"] = .string(fetchedAt) }
        guard case var .generated(card)? = MessageResponseCard(part: .init(type: "data-card", data: .object(data)))
        else { return nil }
        card.steps = old.steps
        return card
    }
}

/// "Follow on Lock Screen": the flight's times, gate and countdown in a Live
/// Activity and the Dynamic Island. Tapping again stops following.
struct FollowFlightControl: View {
    let flight: FlightSnapshot
    @State private var following = false
    @State private var working = false
    @State private var unavailable = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                guard !working else { return }
                working = true
                Task {
                    if following {
                        await FlightActivityManager.shared.stopFollowing(flight.id)
                        following = false
                    } else {
                        following = await FlightActivityManager.shared.follow(flight)
                        unavailable = !following
                    }
                    working = false
                }
            } label: {
                Label(
                    following ? "Following on Lock Screen" : "Follow on Lock Screen",
                    systemImage: following ? "checkmark.circle.fill" : "lock.iphone"
                )
                .fixedSize(horizontal: true, vertical: false)
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(AssistantActionButtonStyle(kind: following ? .neutral : .secondary))
            .disabled(working)
            .accessibilityHint(following
                ? "Stops showing this flight on the Lock Screen."
                : "Shows this flight's times, gate and countdown on the Lock Screen and in the Dynamic Island.")
            if unavailable {
                Text("Live Activities are off for Assistant. Turn them on in Settings to follow a flight.")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { following = FlightActivityManager.shared.isFollowing(flight.id) }
    }
}

/// Where a live card's freshness row would be: live while the server still
/// wants it read, and when it was last read either way.
struct LiveCardStamp: View {
    let updatedAt: String?
    let live: Bool
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 6) {
            if live {
                Circle().fill(AssistantTheme.accent(for: colorScheme)).frame(width: 6, height: 6)
            }
            Text(label)
                .font(.caption.weight(.semibold))
                .monospacedDigit()
        }
        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
        .accessibilityElement(children: .combine)
    }

    private var label: String {
        let stamp = updatedAt.flatMap(ISO8601DateFormatter.flexible)
            .map { " · \($0.formatted(date: .omitted, time: .shortened))" } ?? ""
        return live ? "Live\(stamp)" : "Final\(stamp)"
    }
}
