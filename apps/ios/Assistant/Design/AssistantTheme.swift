import SwiftUI

/// The app's appearance override. The app used to follow the iPhone's
/// appearance silently, so a scheduled system change flipped the
/// conversation between light and dark with no visible cause.
enum AssistantAppearance: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    static let defaultsKey = "assistant.appearance"

    var id: Self { self }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

enum AssistantTheme {
    static let conversationCornerRadius: CGFloat = 27
    static let canvas = Color(hex: 0xEEF5F0)
    static let canvasDark = Color(hex: 0x121A15)
    static let raised = Color.white
    static let raisedDark = Color(hex: 0x19241D)
    static let sunken = Color(hex: 0xE3EDE6)
    static let sunkenDark = Color(hex: 0x243129)
    static let ink = Color(hex: 0x15201A)
    static let inkDark = Color(hex: 0xEDF6F0)
    static let inkMuted = Color(hex: 0x5E7266)
    static let inkMutedDark = Color(hex: 0xA9BAAF)
    static let accent = Color(hex: 0x217A4B)
    static let accentLight = Color(hex: 0x6FCB9C)
    // Foreground semantic colors clear small-text contrast on the light card
    // surfaces; their brighter companions are reserved for dark appearance.
    static let success = Color(hex: 0x147A49)
    static let successDark = Color(hex: 0x6EE7B7)
    static let stage = Color(hex: 0x2B8253)
    static let stageDark = Color(hex: 0x1B3626)
    static let stageStrong = Color(hex: 0xF4FAF5)
    static let bubblePaper = Color(hex: 0xF5FAF6)
    // A paper surface needs to read as a distinct object on the dark green
    // stage. The old value was nearly iso-luminant with `stageDark`, so reply
    // bubbles disappeared even though their outlines remained visible.
    static let bubblePaperDark = Color(hex: 0x293D31)
    static let bubblePaperInk = Color(hex: 0x15201A)
    static let bubblePaperInkDark = Color(hex: 0xEDF6F0)
    static let companionHousing = Color(hex: 0x131D17)
    static let warning = Color(hex: 0x9D5A0A)
    static let warningDark = Color(hex: 0xF0B45A)
    static let warningSurface = Color(hex: 0xFFF7E7)
    static let warningSurfaceDark = Color(hex: 0x362A18)
    static let warningInk = Color(hex: 0x5C3A0E)
    static let warningInkDark = Color(hex: 0xFFE1A8)
    static let errorSurface = Color(hex: 0xFFF0EE)
    static let errorSurfaceDark = Color(hex: 0x3A211F)
    static let errorInk = Color(hex: 0x7A201B)
    static let errorInkDark = Color(hex: 0xFFD7D2)
    static let stageDepth = Color(hex: 0x0C2D1B)
    /// Warning pair for surfaces that sit on the conversation stage rather
    /// than the canvas. The stage is dark in both color schemes, so this pair
    /// deliberately does not vary — unlike `warningSurface(for:)`.
    static let stageWarningSurface = Color(hex: 0xFFE9B7)
    static let stageWarningInk = Color(hex: 0x5C3A0E)

    static func canvas(for scheme: ColorScheme) -> Color {
        scheme == .dark ? canvasDark : canvas
    }

    static func raised(for scheme: ColorScheme) -> Color {
        scheme == .dark ? raisedDark : raised
    }

    static func sunken(for scheme: ColorScheme) -> Color {
        scheme == .dark ? sunkenDark : sunken
    }

    static func ink(for scheme: ColorScheme) -> Color {
        scheme == .dark ? inkDark : ink
    }

    static func inkMuted(for scheme: ColorScheme) -> Color {
        scheme == .dark ? inkMutedDark : inkMuted
    }

    static func accent(for scheme: ColorScheme) -> Color {
        scheme == .dark ? accentLight : accent
    }

    static func success(for scheme: ColorScheme) -> Color {
        scheme == .dark ? successDark : success
    }

    static func warning(for scheme: ColorScheme) -> Color {
        scheme == .dark ? warningDark : warning
    }

    static func bubblePaper(for scheme: ColorScheme) -> Color {
        scheme == .dark ? bubblePaperDark : bubblePaper
    }

    static func bubblePaperInk(for scheme: ColorScheme) -> Color {
        scheme == .dark ? bubblePaperInkDark : bubblePaperInk
    }

    static func warningSurface(for scheme: ColorScheme) -> Color {
        scheme == .dark ? warningSurfaceDark : warningSurface
    }

    static func warningInk(for scheme: ColorScheme) -> Color {
        scheme == .dark ? warningInkDark : warningInk
    }

    static func errorSurface(for scheme: ColorScheme) -> Color {
        scheme == .dark ? errorSurfaceDark : errorSurface
    }

    static func errorInk(for scheme: ColorScheme) -> Color {
        scheme == .dark ? errorInkDark : errorInk
    }

    static func stage(for scheme: ColorScheme, mood: CompanionMood = .default) -> Color {
        switch (scheme, mood) {
        case (.light, .warmAmber): Color(hex: 0x8A6337)
        case (.dark, .warmAmber): Color(hex: 0x45331F)
        case (.light, .softRose): Color(hex: 0x8A5A62)
        case (.dark, .softRose): Color(hex: 0x442A30)
        case (.light, .coolSky): Color(hex: 0x397786)
        case (.dark, .coolSky): Color(hex: 0x203C44)
        case (.dark, _): stageDark
        default: stage
        }
    }
}

extension Color {
    init(hex: UInt, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255,
            opacity: alpha
        )
    }
}

extension View {
    func assistantCard(in scheme: ColorScheme) -> some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)

        return self
            .padding(16)
            .background(AssistantTheme.raised(for: scheme), in: shape)
            .overlay {
                shape
                    .stroke(.primary.opacity(scheme == .dark ? 0.12 : 0.07), lineWidth: 1)
            }
    }
}

struct AssistantTactileButtonStyle: ButtonStyle {
    let reduceMotion: Bool
    var pressedScale: CGFloat = 0.98

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? pressedScale : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .brightness(configuration.isPressed ? -0.018 : 0)
            .animation(
                reduceMotion ? nil : .spring(response: 0.22, dampingFraction: 0.8),
                value: configuration.isPressed
            )
    }
}
