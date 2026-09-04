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
    /// Semantic geometry keeps the conversation's signature silhouette while
    /// letting utility cards and nested panels recede behind it.
    static let heroCornerRadius: CGFloat = 27
    static let conversationCornerRadius: CGFloat = Self.heroCornerRadius
    static let cardCornerRadius: CGFloat = 22
    static let panelCornerRadius: CGFloat = 18
    static let controlCornerRadius: CGFloat = 12
    /// Chat bubbles remain part of the conversation surface, rather than a
    /// utility list item.
    static let chatCardCornerRadius: CGFloat = Self.heroCornerRadius
    static let responseCardMinHeight: CGFloat = 56
    static let compactGutter: CGFloat = 16
    static let cardStackSpacing: CGFloat = 12
    static let canvas = Color(hex: 0xEEF5F0)
    static let canvasDark = Color(hex: 0x101712)
    static let raised = Color.white
    static let raisedDark = Color(hex: 0x1B2820)
    // The chat dashboard is intentionally a little warmer and lighter than
    // the utility cards used elsewhere. On the dark-green stage these read as
    // sheets of paper with room to scan, echoing the menu sheet without
    // turning every dashboard section into a floating tile.
    static let dashboardPaper = Color(hex: 0xFAFBF9)
    static let dashboardPaperDark = Color(hex: 0x23342A)
    static let sunken = Color(hex: 0xE3EDE6)
    static let sunkenDark = Color(hex: 0x152019)
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
    // Count pills signal work that needs attention, not a decorative tag.
    // This stays one alert red in both appearances for instant recognition.
    static let notificationBadge = Color(hex: 0xC9362C)
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

    static func dashboardPaper(for scheme: ColorScheme) -> Color {
        scheme == .dark ? dashboardPaperDark : dashboardPaper
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

    static func stage(for scheme: ColorScheme) -> Color {
        scheme == .dark ? stageDark : stage
    }

    /// The chat's accent, tinted by the companion's color mood.
    ///
    /// A `[theme:]` cue re-tints the accent and leaves the stage alone, which is
    /// what the web client has always done (`globals.css`, "Companion chat
    /// themes"). The stage used to carry the mood here instead, so one cue
    /// repainted the whole conversation background — a swing with no visible
    /// cause, since the cue tag never reaches the reader.
    ///
    /// Deliberately does not vary by color scheme: the stage is dark in both, so
    /// one light tint reads on either — the same reasoning as
    /// `stageWarningSurface`. The three mood tints are the web values verbatim;
    /// the resting tint stays this app's own `0xB9ECCF` rather than web's
    /// `#9fe7c0`, so the default look is unchanged.
    static func chatAccent(mood: CompanionMood = .default) -> Color {
        switch mood {
        case .warmAmber: Color(hex: 0xFCD390)
        case .softRose: Color(hex: 0xF7BCD2)
        case .coolSky: Color(hex: 0xA5DAF6)
        case .default: Color(hex: 0xB9ECCF)
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
    /// Shared shell for pages revealed from the pull-up directory. Keeping the
    /// canvas, navigation treatment, tint, and scrolling behavior here prevents
    /// submenu pages from slowly becoming a collection of unrelated mini-apps.
    func assistantSubmenuChrome() -> some View {
        modifier(AssistantSubmenuChrome())
    }

    /// The normal content-card spec: 16pt padding, 22pt radius, deliberate
    /// minimum optical height, and a hairline stroke. Warning cards (memory
    /// review, approvals) pass a surface and stroke tint so they keep the same
    /// geometry instead of hand-rolling a near-copy.
    func assistantCard(
        in scheme: ColorScheme,
        surface: Color? = nil,
        strokeTint: Color? = nil
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)

        return self
            .padding(.horizontal, AssistantTheme.compactGutter)
            .padding(.vertical, 16)
            .frame(minHeight: AssistantTheme.responseCardMinHeight)
            .background(surface ?? AssistantTheme.raised(for: scheme), in: shape)
            .overlay {
                shape
                    .stroke(
                        strokeTint?.opacity(0.28) ?? Color.primary.opacity(scheme == .dark ? 0.16 : 0.07),
                        lineWidth: 1
                    )
            }
    }

    /// The recessed companion to `assistantCard`, for summary and info
    /// panels. A recessed panel is intentionally quieter and tighter than a
    /// content card so nested summaries do not compete with the page's main
    /// action.
    func assistantPanel(in scheme: ColorScheme) -> some View {
        self
            .padding(14)
            .background(
                AssistantTheme.sunken(for: scheme).opacity(0.72),
                in: RoundedRectangle(cornerRadius: AssistantTheme.panelCornerRadius, style: .continuous)
            )
    }
}

/// Wraps compact controls instead of forcing them into a clipped horizontal row.
struct AssistantFlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let metrics = Self.metrics(
            sizes: sizes,
            availableWidth: proposal.width ?? .greatestFiniteMagnitude,
            spacing: spacing
        )
        return CGSize(width: proposal.width ?? metrics.size.width, height: metrics.size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let metrics = Self.metrics(sizes: sizes, availableWidth: bounds.width, spacing: spacing)
        for (index, subview) in subviews.enumerated() {
            let origin = metrics.origins[index]
            subview.place(
                at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y),
                anchor: .topLeading,
                proposal: ProposedViewSize(sizes[index])
            )
        }
    }

    struct Metrics {
        let size: CGSize
        let origins: [CGPoint]
    }

    static func metrics(sizes: [CGSize], availableWidth: CGFloat, spacing: CGFloat) -> Metrics {
        var origins: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var contentWidth: CGFloat = 0

        for size in sizes {
            let proposedX = x == 0 ? 0 : x + spacing
            if x > 0, proposedX + size.width > availableWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            } else {
                x = proposedX
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width
            rowHeight = max(rowHeight, size.height)
            contentWidth = max(contentWidth, x)
        }
        return Metrics(size: CGSize(width: contentWidth, height: y + rowHeight), origins: origins)
    }
}

private struct AssistantSubmenuChrome: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    func body(content: Content) -> some View {
        content
            .scrollBounceBehavior(.basedOnSize)
            .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
            .tint(AssistantTheme.accent(for: colorScheme))
            .navigationBarTitleDisplayMode(usesAccessibilityLayout ? .inline : .large)
            .toolbarBackground(AssistantTheme.canvas(for: colorScheme), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }
}

/// The tinted rounded-square glyph at the head of cards. Exactly two sizes:
/// `.card` (40pt) for card headers, `.inline` (32pt) for compact callouts —
/// this motif previously existed in eight size/radius/font combinations.
struct AssistantGlyph: View {
    enum Variant {
        case card
        case inline
    }

    let systemName: String
    let tint: Color
    var variant: Variant = .card
    /// Document and chat rows sit the glyph on a neutral sunken tile rather
    /// than a tint wash.
    var sunkenBackground = false

    @Environment(\.colorScheme) private var colorScheme

    private var side: CGFloat { variant == .card ? 40 : 32 }

    var body: some View {
        Image(systemName: systemName)
            .font(variant == .card ? Font.system(size: 17, weight: .semibold) : Font.subheadline.weight(.semibold))
            .foregroundStyle(tint)
            .frame(width: side, height: side)
            .background(
                sunkenBackground ? AssistantTheme.sunken(for: colorScheme) : tint.opacity(0.12),
                in: RoundedRectangle(cornerRadius: variant == .card ? 12 : 10, style: .continuous)
            )
    }
}

/// One empty-state treatment for every page: centered on the canvas at a
/// fixed minimum height. Pages previously picked their own top padding or
/// wrapped the state in a raised card, so "nothing here" looked different on
/// each screen.
struct AssistantEmptyState: View {
    let title: String
    let systemImage: String
    let description: String?

    init(_ title: String, systemImage: String, description: String? = nil) {
        self.title = title
        self.systemImage = systemImage
        self.description = description
    }

    var body: some View {
        ContentUnavailableView(
            title,
            systemImage: systemImage,
            description: description.map { Text($0) }
        )
        .frame(maxWidth: .infinity, minHeight: 190)
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

enum AssistantActionButtonKind {
    case primary
    case secondary
    case destructive
}

/// The action language for assistant submenu pages. These controls use the
/// same recessed paper and rounded geometry as the cards they sit inside,
/// while keeping every target at least 44 points tall.
struct AssistantActionButtonStyle: ButtonStyle {
    let kind: AssistantActionButtonKind
    var compact = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)

        configuration.label
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, compact ? 0 : 14)
            .frame(minWidth: compact ? 44 : nil, minHeight: 44)
            .foregroundStyle(foregroundColor)
            .background(backgroundColor, in: shape)
            .overlay {
                shape.stroke(strokeColor, lineWidth: 1)
            }
            .contentShape(shape)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.975 : 1)
            .brightness(configuration.isPressed ? -0.025 : 0)
            .opacity(isEnabled ? (configuration.isPressed ? 0.9 : 1) : 0.48)
            .animation(
                reduceMotion ? nil : .spring(response: 0.22, dampingFraction: 0.82),
                value: configuration.isPressed
            )
    }

    private var foregroundColor: Color {
        switch kind {
        case .primary:
            colorScheme == .dark ? AssistantTheme.stageDepth : .white
        case .secondary:
            AssistantTheme.accent(for: colorScheme)
        case .destructive:
            AssistantTheme.errorInk(for: colorScheme)
        }
    }

    private var backgroundColor: Color {
        switch kind {
        case .primary:
            AssistantTheme.accent(for: colorScheme)
        case .secondary:
            AssistantTheme.sunken(for: colorScheme)
        case .destructive:
            AssistantTheme.errorSurface(for: colorScheme)
        }
    }

    private var strokeColor: Color {
        switch kind {
        case .primary:
            Color.primary.opacity(colorScheme == .dark ? 0.16 : 0.08)
        case .secondary:
            AssistantTheme.accent(for: colorScheme).opacity(0.22)
        case .destructive:
            AssistantTheme.errorInk(for: colorScheme).opacity(0.22)
        }
    }
}
