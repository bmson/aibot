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
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    var body: some View {
        Button(action: action) {
            if isLandscape {
                landscapeCrownContent
            } else {
                crownContent
            }
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

    /// Defensive compact-size-class fallback for previews and iPad. The iPhone
    /// product is portrait-only, where the primary crown treatment remains
    /// above the conversation stage.
    private var landscapeCrownContent: some View {
        HStack(spacing: 9) {
            if let thought {
                glyph(for: thought)
                    .frame(width: 24, height: 24)
                    .background(crownTone.opacity(0.13), in: Circle())
                VStack(alignment: .leading, spacing: 1) {
                    crownLabel(for: thought)
                    crownDetail
                }
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(width: landscapeExpandedWidth, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(.black)
        }
        .overlay {
            if thought != nil {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(crownRim, lineWidth: 0.65)
            }
        }
        .shadow(color: .black.opacity(thought == nil ? 0 : 0.18), radius: 10, y: 5)
        .animation(
            reduceMotion ? .easeOut(duration: 0.16) : .spring(response: 0.42, dampingFraction: 0.82),
            value: thought
        )
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

    private var landscapeExpandedWidth: CGFloat {
        guard thought != nil else { return Self.collapsedWidth }
        let estimatedCharacterWidth: CGFloat = 6.1
        let longestLine = max(thought?.label.count ?? 0, detail?.count ?? 0)
        return min(196, max(154, CGFloat(longestLine) * estimatedCharacterWidth + 48))
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
    /// Resolves the physical Island's top edge from the device's safe area.
    /// Dynamic Island phones keep 48pt between that edge and the safe-area
    /// boundary. Pulling the crown one additional point upward prevents a
    /// scaled or antialiased frame from exposing a hairline of stage color.
    static func islandTopInset(safeAreaTopInset: CGFloat) -> CGFloat {
        guard safeAreaTopInset >= dynamicIslandSafeAreaThreshold else {
            return legacyIslandTopInset
        }

        return max(
            0,
            safeAreaTopInset - dynamicIslandSafeAreaClearance - attachmentOverlap
        )
    }

    private static let dynamicIslandSafeAreaThreshold: CGFloat = 55
    private static let dynamicIslandSafeAreaClearance: CGFloat = 48
    private static let attachmentOverlap: CGFloat = 1
    private static let legacyIslandTopInset: CGFloat = 14
    static let standardExpandedHeight: CGFloat = 76
    static let accessibilityExpandedHeight: CGFloat = 188
    static let accessibilityExpandedWidth: CGFloat = 342

    static func screenClearanceHeight(
        isAccessibilitySize: Bool,
        isExpanded: Bool,
        islandTopInset: CGFloat
    ) -> CGFloat {
        let height: CGFloat
        if !isExpanded {
            height = collapsedHeight
        } else if isAccessibilitySize {
            height = accessibilityExpandedHeight
        } else {
            height = standardExpandedHeight
        }
        return islandTopInset + height
    }

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

    private var isLandscape: Bool { verticalSizeClass == .compact }

    private var accessibilityLabel: String {
        guard let thought else { return "" }
        return [agentName, thought.label, detail]
            .compactMap { $0 }
            .joined(separator: ": ")
    }

    /// The breathing room between the Island's lower edge and anything placed
    /// clear of it.
    static let overlayClearanceGap: CGFloat = 8

    /// Where a top-aligned surface has to start so nothing at the top of the
    /// screen draws over it — measured from the physical top edge, which is the
    /// origin every surface that clears the Island already works in: both
    /// `RootView`'s stack and the transcript ignore the top safe area.
    ///
    /// Idle is not a special case with a smaller number. The crown paints
    /// nothing then, but the hardware pill is still there and is exactly what
    /// has to be cleared, so the collapsed geometry stands in for it.
    ///
    /// This replaced a `safeAreaOverhang` measured from the safe-area boundary
    /// instead. That is the right origin for an overlay inside the chat, where
    /// the error banner used to live — but the banner has since moved up to the
    /// root, and reading a safe-area-relative number in a stack that ignores the
    /// safe area put it roughly one top inset too high: underneath the Island.
    static func overlayTopInset(
        isAccessibilitySize: Bool,
        isExpanded: Bool,
        safeAreaTopInset: CGFloat
    ) -> CGFloat {
        screenClearanceHeight(
            isAccessibilitySize: isAccessibilitySize,
            isExpanded: isExpanded,
            islandTopInset: islandTopInset(safeAreaTopInset: safeAreaTopInset)
        ) + overlayClearanceGap
    }
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
