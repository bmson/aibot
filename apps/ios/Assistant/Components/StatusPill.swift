import SwiftUI

struct StatusPill: View {
    let status: String

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol)
                .symbolEffect(
                    .pulse,
                    options: reduceMotion ? .nonRepeating : .repeating,
                    isActive: status == "running"
                )
                .accessibilityHidden(true)
            Text(label)
        }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(color.opacity(0.12), in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Status: \(label)")
    }

    private var label: String { status.sentenceCaseIdentifier }

    private var symbol: String {
        switch status {
        case "running": "arrow.triangle.2.circlepath"
        case "done", "approved", "ready": "checkmark"
        case "failed", "denied", "cancelled": "xmark"
        case "waiting_approval", "waiting_budget", "needs_attention": "hand.raised.fill"
        case "sleeping", "waiting_event": "clock"
        default: "circle.fill"
        }
    }

    private var color: Color {
        switch status {
        case "done", "approved", "ready": AssistantTheme.accent(for: colorScheme)
        case "failed", "denied", "cancelled": .red
        case "waiting_approval", "waiting_budget", "needs_attention": .orange
        default: .secondary
        }
    }
}
