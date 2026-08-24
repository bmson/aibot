import ActivityKit
import SwiftUI
import WidgetKit

@main
struct AssistantActivityWidgetBundle: WidgetBundle {
    var body: some Widget {
        AssistantActivityWidget()
    }
}

struct AssistantActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AssistantActivityAttributes.self) { context in
            lockScreenView(context)
                .activityBackgroundTint(Color(red: 0.035, green: 0.085, blue: 0.060))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(deepLink(for: context.state))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    phaseGlyph(context.state.thought.tone)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.thought.label)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .contentTransition(.opacity)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    phaseSymbol(.waiting)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text(context.state.detail)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.white.opacity(0.72))
                            .lineLimit(2)

                        if context.state.thought.tone == .waiting {
                            HStack(spacing: 5) {
                                Image(systemName: "arrow.up.forward.app.fill")
                                Text(waitingSummary(for: context.state))
                                    .contentTransition(.numericText())
                            }
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(tint(for: .waiting))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .animation(.smooth(duration: 0.38), value: context.state)
                }
            } compactLeading: {
                compactPhaseSymbol(context.state.thought.tone)
            } compactTrailing: {
                // No timer or trailing label: preserving room around the
                // system clock matters more than a redundant decision count.
                EmptyView()
            } minimal: {
                compactPhaseSymbol(context.state.thought.tone)
            }
            // Use the system's native black Dynamic Island surface. Applying
            // custom region backgrounds causes iOS to composite them as glass,
            // so the chat color can show through the expanded activity.
            .keylineTint(.black)
            .widgetURL(deepLink(for: context.state))
        }
    }

    private func lockScreenView(_ context: ActivityViewContext<AssistantActivityAttributes>) -> some View {
        // Two columns, no trailing timer: the lock screen already timestamps
        // the activity, and the elapsed counter squeezed the text column into
        // a narrow gutter.
        HStack(spacing: 12) {
            Image(systemName: phaseSymbolName(for: context.state.thought.tone))
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(tint(for: context.state.thought.tone))
                .frame(width: 38, height: 38)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 13))
                .contentTransition(.symbolEffect(.replace))

            VStack(alignment: .leading, spacing: 3) {
                Text(context.state.thought.label)
                    .font(.headline)
                    .foregroundStyle(.white)
                Text(context.state.detail)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.white.opacity(0.7))
                    .lineLimit(2)

                if context.state.thought.tone == .waiting {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.up.forward.app.fill")
                        Text(waitingSummary(for: context.state))
                            .contentTransition(.numericText())
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(tint(for: .waiting))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(16)
        .animation(.smooth(duration: 0.38), value: context.state)
    }

    /// Compact island slots and the minimal presentation have no room for a
    /// spinner — an indeterminate circle reads as a dot with no meaning — so
    /// they always get the phase's symbol. The expanded region, which pairs
    /// the glyph with a text label, keeps its spinner.
    private func compactPhaseSymbol(_ tone: AssistantActivityTone) -> some View {
        Image(systemName: phaseSymbolName(for: tone))
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(tint(for: tone))
            .contentTransition(.symbolEffect(.replace))
    }

    @ViewBuilder
    private func phaseGlyph(_ tone: AssistantActivityTone) -> some View {
        // Simple SF Symbols only — the earlier paired-capsule "eyes" read as
        // noise at Dynamic Island sizes.
        if tone == .working || tone == .thinking {
            ProgressView()
                .controlSize(.mini)
                .tint(tint(for: tone))
        } else {
            Image(systemName: phaseSymbolName(for: tone))
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(tint(for: tone))
                .contentTransition(.symbolEffect(.replace))
        }
    }

    private func phaseSymbolName(for tone: AssistantActivityTone) -> String {
        switch tone {
        case .thinking:
            "sparkles"
        case .working:
            // An ellipsis read as three meaningless dots on the lock screen.
            "bolt.fill"
        case .waiting:
            "hand.raised.fill"
        case .done:
            "checkmark"
        case .failed:
            "exclamationmark"
        }
    }

    @ViewBuilder
    private func phaseSymbol(_ tone: AssistantActivityTone) -> some View {
        phaseGlyph(tone)
    }

    private func tint(for tone: AssistantActivityTone) -> Color {
        switch tone {
        case .thinking: Color.white.opacity(0.72)
        case .working: Color(red: 0.44, green: 0.80, blue: 0.61)
        case .waiting: Color(red: 0.95, green: 0.71, blue: 0.36)
        case .done: Color(red: 0.44, green: 0.80, blue: 0.61)
        case .failed: Color(red: 0.94, green: 0.40, blue: 0.36)
        }
    }

    private func waitingSummary(for state: AssistantActivityAttributes.ContentState) -> String {
        state.pendingCount > 1 ? "\(state.pendingCount) decisions waiting" : "Decision waiting"
    }

    private func deepLink(for state: AssistantActivityAttributes.ContentState) -> URL? {
        URL(string: state.thought.tone == .waiting ? "assistant://approvals" : "assistant://chat")
    }
}
