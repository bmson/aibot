import ActivityKit
import SwiftUI
import WidgetKit

/// A followed flight on the Lock Screen and in the Dynamic Island: the route,
/// both times on their airports' clocks, the gate, and a countdown to the next
/// thing that happens — pushback, then landing. Countdowns are system timers,
/// so they keep ticking between updates.
struct FlightActivityWidget: Widget {
    private static let background = Color(red: 0.035, green: 0.085, blue: 0.060)
    private static let mint = Color(red: 0.44, green: 0.80, blue: 0.61)
    private static let amber = Color(red: 0.95, green: 0.71, blue: 0.36)
    private static let red = Color(red: 0.94, green: 0.40, blue: 0.36)

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: FlightActivityAttributes.self) { context in
            lockScreen(context)
                .activityBackgroundTint(Self.background)
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "assistant://chat"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    endpoint(code: context.attributes.originCode, clock: context.state.departureClock, alignment: .leading)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    endpoint(code: context.attributes.destinationCode, clock: context.state.arrivalClock, alignment: .trailing)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 2) {
                        Text(context.attributes.ident)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.72))
                        Text(context.state.statusText)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(statusTint(context.state))
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 8) {
                        route(context.state)
                        HStack {
                            gateLine(context.state)
                            Spacer(minLength: 8)
                            countdown(context.state)
                        }
                        .font(.caption.weight(.medium))
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                HStack(spacing: 4) {
                    Image(systemName: "airplane")
                        .foregroundStyle(statusTint(context.state))
                    Text(context.attributes.ident)
                        .font(.caption2.weight(.semibold))
                }
            } compactTrailing: {
                compactValue(context.state)
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(statusTint(context.state))
            } minimal: {
                Image(systemName: "airplane")
                    .foregroundStyle(statusTint(context.state))
            }
            .keylineTint(Self.mint)
        }
    }

    // MARK: - Lock Screen

    private func lockScreen(_ context: ActivityViewContext<FlightActivityAttributes>) -> some View {
        let state = context.state
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Label(context.attributes.ident, systemImage: "airplane")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                Spacer(minLength: 8)
                Text(state.statusText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(statusTint(state))
                    .lineLimit(1)
            }
            HStack(alignment: .bottom) {
                endpoint(
                    code: context.attributes.originCode,
                    city: context.attributes.originCity,
                    clock: state.departureClock,
                    alignment: .leading
                )
                Spacer(minLength: 8)
                endpoint(
                    code: context.attributes.destinationCode,
                    city: context.attributes.destinationCity,
                    clock: state.arrivalClock,
                    alignment: .trailing
                )
            }
            route(state)
            HStack {
                gateLine(state)
                Spacer(minLength: 8)
                countdown(state)
            }
            .font(.caption.weight(.medium))
        }
        .padding(16)
    }

    private func endpoint(
        code: String,
        city: String? = nil,
        clock: String,
        alignment: HorizontalAlignment
    ) -> some View {
        VStack(alignment: alignment, spacing: 1) {
            Text(code)
                .font(.title2.weight(.bold))
                .foregroundStyle(.white)
            Text(clock)
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(.white.opacity(0.8))
            if let city, !city.isEmpty {
                Text(city)
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.55))
                    .lineLimit(1)
            }
        }
    }

    /// The route as a line with the plane on it: at the start before takeoff,
    /// where the provider puts it in the air, at the end once down.
    private func route(_ state: FlightActivityAttributes.ContentState) -> some View {
        let fraction: Double = switch state.phase {
        case "en_route": state.progress ?? 0.5
        case "landed", "arrived": 1
        default: 0
        }
        return GeometryReader { proxy in
            let x = 8 + (proxy.size.width - 16) * fraction
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.18)).frame(height: 3)
                Capsule().fill(Self.mint).frame(width: max(x, 3), height: 3)
                Image(systemName: "airplane")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white)
                    .position(x: x, y: proxy.size.height / 2)
            }
            .frame(maxHeight: .infinity)
        }
        .frame(height: 16)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func gateLine(_ state: FlightActivityAttributes.ContentState) -> some View {
        let parts: [String] = state.isAirborne || state.isOver
            ? [state.arrivalGate.isEmpty ? "" : "Gate \(state.arrivalGate)",
               state.baggage.isEmpty ? "" : "Bags \(state.baggage)"]
            : [state.terminal.isEmpty ? "" : "Terminal \(state.terminal)",
               state.gate.isEmpty ? "" : "Gate \(state.gate)"]
        let text = parts.filter { !$0.isEmpty }.joined(separator: " · ")
        Text(text.isEmpty ? "Gate not yet assigned" : text)
            .foregroundStyle(.white.opacity(text.isEmpty ? 0.55 : 0.9))
            .lineLimit(1)
    }

    @ViewBuilder
    private func countdown(_ state: FlightActivityAttributes.ContentState) -> some View {
        if let moment = state.nextMoment, moment > .now, !state.isOver {
            HStack(spacing: 4) {
                Text(state.isAirborne ? "Lands in" : "Departs in")
                    .foregroundStyle(.white.opacity(0.6))
                countdownText(to: moment)
                    .monospacedDigit()
                    .foregroundStyle(.white)
            }
        } else {
            Text(state.statusText)
                .foregroundStyle(.white.opacity(0.6))
        }
    }

    @ViewBuilder
    private func compactValue(_ state: FlightActivityAttributes.ContentState) -> some View {
        if !state.isAirborne, !state.gate.isEmpty, !state.isOver {
            Text(state.gate)
        } else if let moment = state.nextMoment, moment > .now, !state.isOver {
            countdownText(to: moment)
                .frame(maxWidth: 56)
        } else {
            Text(state.isOver ? "Done" : "—")
        }
    }

    /// A ticking timer inside the last hour; "2 hr, 14 min" before that, which
    /// the system also keeps current. A bare timer reads "124:29:55" days out.
    @ViewBuilder
    private func countdownText(to moment: Date) -> some View {
        if moment.timeIntervalSinceNow <= 60 * 60 {
            Text(timerInterval: Date.now...moment, countsDown: true)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 64, alignment: .trailing)
        } else {
            // A relative date takes all the width it is offered in a widget;
            // aligning it trailing keeps it against the edge, clear of the gate.
            Text(moment, style: .relative)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }

    private func statusTint(_ state: FlightActivityAttributes.ContentState) -> Color {
        if state.phase == "cancelled" || state.phase == "diverted" { return Self.red }
        return state.isTrouble ? Self.amber : Self.mint
    }
}
