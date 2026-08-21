import SwiftUI

struct CompanionCapsule: View {
    let presence: AssistantPresence
    let face: CompanionFace
    let name: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .caption2) private var capsuleHeight: CGFloat = 30
    @State private var blinking = false

    var body: some View {
        HStack(spacing: 8) {
            faceView(blink: blinking)
            if presence != .idle {
                Text(presence == .working ? "Working" : "Needs you")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.84))
                    .transition(.opacity.combined(with: .move(edge: .leading)))
            }
        }
        .padding(.horizontal, presence == .idle ? 13 : 12)
        .frame(minHeight: max(30, capsuleHeight))
        .background(AssistantTheme.companionHousing, in: Capsule())
        .overlay(alignment: .top) {
            Capsule().fill(.white.opacity(0.08)).frame(height: 1).padding(.horizontal, 8)
        }
        .animation(reduceMotion ? nil : .spring(response: 0.36, dampingFraction: 0.8), value: presence)
        .task(id: reduceMotion) {
            guard !reduceMotion else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3.8))
                withAnimation(.easeInOut(duration: 0.1)) { blinking = true }
                try? await Task.sleep(for: .milliseconds(130))
                withAnimation(.easeInOut(duration: 0.1)) { blinking = false }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name) is \(presenceLabel)")
    }

    private func faceView(blink: Bool) -> some View {
        HStack(spacing: face == .wideExcited ? 7 : 6) {
            eye(blink: blink)
            eye(blink: blink || face == .curiousBlink)
        }
        .rotationEffect(face == .thoughtfulTilt ? .degrees(-8) : .zero)
        .offset(y: face == .gentleNod ? 1 : 0)
    }

    private func eye(blink: Bool) -> some View {
        let squint = blink || face == .happySquint || face == .warmSmile
        return Capsule()
            .fill(presence == .attention ? Color(hex: 0xF2B65D) : Color(hex: 0xE7F2EA))
            .frame(
                width: face == .wideExcited ? 6.5 : 5.5,
                height: squint ? 2 : (face == .focused ? 5.5 : 7)
            )
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.12), value: squint)
    }

    private var presenceLabel: String {
        switch presence {
        case .idle: "ready"
        case .working: "working"
        case .attention: "waiting for you"
        }
    }
}
