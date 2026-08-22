import SwiftUI

/// Foreground counterpart to the system Live Activity. Active work surrounds
/// the camera with one native-style black surface; idle leaves the hardware
/// Dynamic Island untouched.
struct ActivityCrown: View {
    let thought: AssistantThought?
    let detail: String?
    let agentName: String
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: action) {
            crownContent
        }
        .buttonStyle(ActivityCrownButtonStyle(reduceMotion: reduceMotion))
        .disabled(thought == nil)
        .allowsHitTesting(thought != nil)
        .accessibilityIdentifier("assistant.activity-crown")
        .accessibilityElement(children: .ignore)
        .accessibilityHidden(thought == nil)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(thought?.tone == .waiting ? "Opens approvals" : "Opens activity")
        .accessibilitySortPriority(thought?.tone == .waiting ? 100 : 10)
        .sensoryFeedback(trigger: thought?.tone) { _, newTone in
            switch newTone {
            case .waiting: .warning
            case .done: .success
            case .failed: .error
            default: nil
            }
        }
    }

    private var crownContent: some View {
        ZStack(alignment: .bottom) {
            if let thought {
                Group {
                    if usesAccessibilityLayout {
                        VStack(alignment: .leading, spacing: 9) {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                glyph(for: thought)
                                    .frame(width: 28, height: 28)
                                crownLabel(for: thought)
                            }

                            crownDetail
                        }
                    } else {
                        HStack(spacing: 9) {
                            glyph(for: thought)
                                .frame(width: 24, height: 24)
                                .background(crownTone.opacity(0.13), in: Circle())

                            VStack(alignment: .leading, spacing: 1) {
                                crownLabel(for: thought)
                                crownDetail
                            }
                        }
                    }
                }
                .foregroundStyle(.white)
                .padding(.horizontal, usesAccessibilityLayout ? 20 : 16)
                .padding(.top, usesAccessibilityLayout ? 13 : 0)
                .padding(.bottom, usesAccessibilityLayout ? 16 : 11)
                .transition(
                    reduceMotion
                        ? .opacity
                        : .move(edge: .bottom).combined(with: .opacity)
                )
            }
        }
        .frame(
            width: expandedWidth,
            alignment: .bottom
        )
        .frame(
            minHeight: thought == nil ? Self.collapsedHeight : expandedMinimumHeight,
            alignment: .bottom
        )
        .background { crownBackground }
        .overlay {
            if thought != nil {
                RoundedRectangle(cornerRadius: expandedCornerRadius, style: .continuous)
                    .stroke(crownRim, lineWidth: 0.65)
            }
        }
        .shadow(color: .black.opacity(thought == nil ? 0 : 0.18), radius: 10, y: 5)
        .animation(
            reduceMotion ? .easeOut(duration: 0.16) : .spring(response: 0.42, dampingFraction: 0.82),
            value: thought
        )
        .animation(
            reduceMotion ? .easeOut(duration: 0.16) : .spring(response: 0.42, dampingFraction: 0.82),
            value: detail
        )
    }

    private func crownLabel(for thought: AssistantThought) -> some View {
        Text(thought.label)
            .font(.caption.weight(.medium))
            .tracking(-0.08)
            .lineLimit(usesAccessibilityLayout ? 2 : 1)
            .minimumScaleFactor(usesAccessibilityLayout ? 1 : 0.82)
            .fixedSize(horizontal: false, vertical: usesAccessibilityLayout)
            .contentTransition(.opacity)
    }

    @ViewBuilder
    private var crownDetail: some View {
        if let detail {
            Text(detail)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.white.opacity(0.68))
                .lineLimit(usesAccessibilityLayout ? 3 : 1)
                .minimumScaleFactor(usesAccessibilityLayout ? 1 : 0.78)
                .fixedSize(horizontal: false, vertical: usesAccessibilityLayout)
                .contentTransition(.opacity)
        }
    }

    @ViewBuilder
    private func glyph(for thought: AssistantThought) -> some View {
        switch thought.tone {
        case .thinking:
            Image(systemName: "sparkles")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white.opacity(0.76))
                .symbolEffect(.pulse, options: reduceMotion ? .nonRepeating : .repeating)
        case .working:
            ProgressView()
                .controlSize(.mini)
                .tint(.white.opacity(0.76))
        case .waiting:
            Image(systemName: "hand.raised.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color(hex: 0xFCD34D))
        case .done:
            Image(systemName: "checkmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Color(hex: 0x6EE7B7))
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color(hex: 0xFCA5A5))
        }
    }

    private var expandedWidth: CGFloat {
        guard let thought else { return Self.collapsedWidth }
        if usesAccessibilityLayout {
            return Self.accessibilityExpandedWidth
        }
        let estimatedCharacterWidth: CGFloat = 6.4
        let longestLine = max(thought.label.count, detail?.count ?? 0)
        let measuredLabel = CGFloat(longestLine) * estimatedCharacterWidth + 54
        return min(
            228,
            max(176, measuredLabel)
        )
    }

    private var expandedMinimumHeight: CGFloat {
        usesAccessibilityLayout
            ? (detail == nil ? 104 : Self.accessibilityExpandedHeight)
            : Self.standardExpandedHeight
    }

    // Geometry the crown is built from. These are shared so a sibling overlay
    // can work out how much of the screen the crown occupies without
    // duplicating the numbers.
    static let collapsedHeight: CGFloat = 37
    static let collapsedWidth: CGFloat = 126
    /// The physical top edge of the Dynamic Island in the app's full-screen
    /// coordinate space.
    static let islandTopInset: CGFloat = 14
    static let standardExpandedHeight: CGFloat = 76
    static let accessibilityExpandedHeight: CGFloat = 188
    static let accessibilityExpandedWidth: CGFloat = 342

    private var expandedCornerRadius: CGFloat {
        usesAccessibilityLayout ? 28 : 24
    }

    /// The active surface surrounds the camera just like the native expanded
    /// Dynamic Island. Idle draws nothing, leaving only the hardware pill.
    private var crownBackground: some View {
        RoundedRectangle(
            cornerRadius: thought == nil ? 19 : expandedCornerRadius,
            style: .continuous
        )
        .fill(.black)
        .opacity(thought == nil ? 0 : 1)
    }

    private var crownRim: Color {
        guard thought != nil else { return .clear }
        return .white.opacity(0.055)
    }

    private var crownTone: Color {
        switch thought?.tone {
        case .thinking: Color(hex: 0x6D8FE5)
        case .working: Color(hex: 0x5CCF91)
        case .waiting: Color(hex: 0xF5C96A)
        case .done: Color(hex: 0x6EE7B7)
        case .failed: Color(hex: 0xFCA5A5)
        case nil: .clear
        }
    }

    private var usesAccessibilityLayout: Bool {
        dynamicTypeSize.isAccessibilitySize
    }

    private var accessibilityLabel: String {
        guard let thought else { return "" }
        return [agentName, thought.label, detail]
            .compactMap { $0 }
            .joined(separator: ": ")
    }

    /// How far the expanded crown hangs below the top of the app's safe area —
    /// what a top-aligned overlay inside the chat has to clear to avoid being
    /// drawn underneath it. Uses the smallest cutout inset the crown is drawn
    /// for, so the clearance errs generous on taller devices.
    static func safeAreaOverhang(isAccessibilitySize: Bool) -> CGFloat {
        let height = isAccessibilitySize
            ? accessibilityExpandedHeight
            : standardExpandedHeight
        return max(0, islandTopInset + height - smallestCutoutInset)
    }

    /// Top safe-area inset of the shallowest cutout device this runs on.
    private static let smallestCutoutInset: CGFloat = 47
}

private struct ActivityCrownButtonStyle: ButtonStyle {
    let reduceMotion: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.965 : 1)
            .opacity(configuration.isPressed ? 0.88 : 1)
            .animation(
                reduceMotion ? nil : .spring(response: 0.22, dampingFraction: 0.78),
                value: configuration.isPressed
            )
    }
}
