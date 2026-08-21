import SwiftUI
import UIKit

enum PullMenuMotion {
    static func unit(_ value: CGFloat) -> CGFloat {
        min(max(value, 0), 1)
    }

    static func smoothStep(_ value: CGFloat) -> CGFloat {
        let progress = unit(value)
        return progress * progress * (3 - (2 * progress))
    }

    static func springInitialVelocity(
        releaseVelocity: CGFloat,
        currentDistance: CGFloat,
        targetDistance: CGFloat,
        minimumTravel: CGFloat = 24
    ) -> Double {
        let remainingTravel = max(abs(targetDistance - currentDistance), minimumTravel)
        return Double(min(max(releaseVelocity, 0) / remainingTravel, 1))
    }

    static func openingCommitmentDistance(revealHeight: CGFloat) -> CGFloat {
        min(max(revealHeight, 0) * 0.58, 150)
    }

    static func closingCommitmentDistance(revealHeight: CGFloat) -> CGFloat {
        max(revealHeight, 0) * 0.3
    }

    static func commitsToOpen(revealDistance: CGFloat, revealHeight: CGFloat) -> Bool {
        revealDistance >= openingCommitmentDistance(revealHeight: revealHeight)
    }

    static func commitsToClose(dragDistance: CGFloat, revealHeight: CGFloat) -> Bool {
        dragDistance >= closingCommitmentDistance(revealHeight: revealHeight)
    }
}

enum TranscriptEdgeMotion {
    static func unit(_ value: Double) -> Double {
        min(max(value, 0), 1)
    }

    /// Keeps the conversation steady through the center, then accelerates
    /// gently as a bubble approaches either clipped edge.
    static func progress(for phaseValue: Double) -> Double {
        let value = unit(abs(phaseValue))
        return value * value * (3 - (2 * value))
    }

    static func opacity(
        for phaseValue: Double,
        reduceTransparency: Bool
    ) -> Double {
        let terminalOpacity = reduceTransparency ? 0.62 : 0.26
        return 1 - ((1 - terminalOpacity) * progress(for: phaseValue))
    }

    static func horizontalScale(for phaseValue: Double) -> CGFloat {
        CGFloat(1 - (0.025 * progress(for: phaseValue)))
    }

    static func verticalScale(for phaseValue: Double) -> CGFloat {
        // Let the shader supply the curvature. A modest compression keeps the
        // material soft instead of collapsing like a rigid sheet.
        CGFloat(1 - (0.28 * progress(for: phaseValue)))
    }

    static func rotation(for phaseValue: Double) -> Double {
        let direction = phaseValue < 0 ? -1.0 : 1.0
        return direction * 26 * progress(for: phaseValue)
    }

    static func counterRotation(for phaseValue: Double) -> Double {
        let direction = phaseValue < 0 ? -1.0 : 1.0
        return -direction * 6 * progress(for: phaseValue)
    }

    static func blurRadius(for phaseValue: Double) -> CGFloat {
        CGFloat(2.8 * progress(for: phaseValue))
    }

    static func edgeTranslation(for phaseValue: Double) -> CGFloat {
        let direction: CGFloat = phaseValue < 0 ? 1 : -1
        return direction * CGFloat(8 * progress(for: phaseValue))
    }

    static func lateralTranslation(for phaseValue: Double) -> CGFloat {
        let direction: CGFloat = phaseValue < 0 ? -1 : 1
        return direction * CGFloat(4 * progress(for: phaseValue))
    }
}

struct ChatView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var composerFontSize = 16.0
    @State private var draft = ""
    @State private var autonomous = false
    @State private var isAtBottom = true
    @State private var hasUnseenMessages = false
    @State private var composerHeight: CGFloat = 0
    @State private var scrollRequest = 0
    @State private var hasPositionedInitialConversation = false
    @State private var menuPullDistance: CGFloat = 0
    @State private var menuCloseDragDistance: CGFloat = 0
    @State private var menuPullReleaseVelocity: CGFloat = 0
    @State private var menuPullActive = false
    @State private var menuOpen = false
    @State private var menuDetentReached = false
    @State private var menuDetentFeedback = 0
    @State private var menuActionFeedback = 0
    @State private var transcriptScrollPhase: ScrollPhase = .idle
    @State private var sendFeedback = 0
    @State private var jumpFeedback = 0
    @FocusState private var composerFocused: Bool

    private var menuRevealHeight: CGFloat {
        if usesExtraLargeAccessibilityMenu { return 304 }
        return dynamicTypeSize.isAccessibilitySize ? 410 : 312
    }

    private var menuButtonHeight: CGFloat {
        if usesExtraLargeAccessibilityMenu { return 112 }
        return dynamicTypeSize.isAccessibilitySize ? 76 : 68
    }

    private var usesExtraLargeAccessibilityMenu: Bool {
        dynamicTypeSize >= .accessibility4
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            pullMenu

            conversationSurface
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(stageBackdrop.ignoresSafeArea(.container))
                .clipShape(
                    RoundedRectangle(
                        cornerRadius: 34 * menuSurfaceProgress,
                        style: .continuous
                    )
                )
                .shadow(
                    color: .black.opacity(0.17 * menuSurfaceProgress),
                    radius: 28 * menuSurfaceProgress,
                    y: 14 * menuSurfaceProgress
                )
                .offset(y: -conversationRevealDistance)
                .ignoresSafeArea(.container)
                .simultaneousGesture(menuPullTrackingGesture)
                .allowsHitTesting(!menuOpen)
        }
        .background(
            stageBackdrop.ignoresSafeArea(.container)
        )
        .toolbar(.hidden, for: .navigationBar)
        .overlay(alignment: .top) {
            if let error = model.errorMessage {
                errorBanner(error)
                    .padding(.horizontal, 12)
                    .padding(.top, 4)
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .move(edge: .top).combined(with: .opacity)
                    )
            }
        }
        .sensoryFeedback(.selection, trigger: menuDetentFeedback)
        .sensoryFeedback(.selection, trigger: menuActionFeedback)
        .sensoryFeedback(.impact(weight: .light), trigger: sendFeedback)
        .sensoryFeedback(.selection, trigger: jumpFeedback)
    }

    private var stageBackdrop: some View {
        ZStack {
            AssistantTheme.stage(for: colorScheme, mood: model.latestMood)

            LinearGradient(
                stops: [
                    .init(color: .white.opacity(colorScheme == .dark ? 0.035 : 0.07), location: 0),
                    .init(color: .clear, location: 0.38),
                    .init(color: AssistantTheme.stageDepth.opacity(colorScheme == .dark ? 0.16 : 0.1), location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            RadialGradient(
                colors: [
                    .white.opacity(colorScheme == .dark ? 0.035 : 0.075),
                    .clear,
                ],
                center: UnitPoint(x: 0.5, y: 0.04),
                startRadius: 0,
                endRadius: 260
            )
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.5), value: model.latestMood)
    }

    private var conversationSurface: some View {
        let motionIsReduced = reduceMotion

        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if model.messages.isEmpty {
                        emptyConversation
                    } else {
                        ForEach(Array(model.messages.enumerated()), id: \.element.id) { index, message in
                            messageRow(message, at: index, motionIsReduced: motionIsReduced)
                        }
                    }
                    Color.clear
                        .frame(height: composerHeight + 18)
                        .id("bottom")
                }
                .padding(.horizontal, 16)
            }
            .ignoresSafeArea(.container, edges: [.top, .bottom])
            .scrollClipDisabled()
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                let contentFits = geometry.contentSize.height <= geometry.containerSize.height + 1
                return contentFits || geometry.visibleRect.maxY >= geometry.contentSize.height - 64
            } action: { _, atBottom in
                isAtBottom = atBottom
                if atBottom {
                    hasUnseenMessages = false
                }
            }
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                menuRevealDistance(for: geometry)
            } action: { _, revealDistance in
                guard !menuOpen, transcriptScrollPhase == .interacting else { return }
                if revealDistance > 0.5 {
                    if !menuPullActive {
                        menuPullActive = true
                        composerFocused = false
                    }
                    menuPullDistance = revealDistance
                    updateMenuDetent(
                        reached: PullMenuMotion.commitsToOpen(
                            revealDistance: revealDistance,
                            revealHeight: menuRevealHeight
                        )
                    )
                } else if menuPullActive {
                    menuPullDistance = 0
                    updateMenuDetent(reached: false)
                }
            }
            .onScrollPhaseChange { oldPhase, newPhase, context in
                transcriptScrollPhase = newPhase
                if oldPhase == .interacting, newPhase != .interacting, menuPullActive {
                    finishPullMenu(releasedAt: menuRevealDistance(for: context.geometry))
                }
            }
            .mask {
                LinearGradient(
                    stops: [
                        .init(color: .black.opacity(0.32), location: 0),
                        .init(color: .black.opacity(0.5), location: 0.045),
                        .init(color: .black.opacity(0.74), location: 0.105),
                        .init(color: .black.opacity(0.94), location: 0.165),
                        .init(color: .black, location: 0.21),
                        .init(color: .black, location: 0.92),
                        .init(color: .black.opacity(0.96), location: 0.98),
                        .init(color: .black.opacity(0.86), location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
            .overlay(alignment: .top) {
                topTranscriptVeil
            }
            .onAppear {
                positionInitialConversationIfNeeded(using: proxy)
            }
            .onChange(of: model.messages) { _, _ in
                if model.messages.isEmpty {
                    hasPositionedInitialConversation = false
                } else if !hasPositionedInitialConversation {
                    positionInitialConversationIfNeeded(using: proxy)
                } else if isAtBottom {
                    scrollToBottom(using: proxy)
                } else {
                    hasUnseenMessages = true
                }
            }
            .onChange(of: scrollRequest) { _, _ in
                scrollToBottom(using: proxy)
            }
            .onChange(of: composerHeight) { previousHeight, _ in
                if isAtBottom || previousHeight == 0 {
                    scrollToBottom(using: proxy)
                }
            }
            .overlay(alignment: .bottom) {
                composer
                    .safeAreaPadding(.bottom)
                    .onGeometryChange(for: CGFloat.self) { geometry in
                        geometry.size.height
                    } action: { height in
                        composerHeight = height
                    }
            }
            .overlay(alignment: .bottom) {
                if showsJumpToLatest {
                    jumpToLatestButton {
                        jumpFeedback += 1
                        scrollToBottom(using: proxy)
                    }
                    .padding(.bottom, composerHeight + 20)
                    .transition(.opacity)
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: showsJumpToLatest)
        }
    }

    private var menuRevealProgress: CGFloat {
        min(max(visibleMenuRevealDistance / menuRevealHeight, 0), 1)
    }

    nonisolated private static func transcriptEdgeEffect<Content: VisualEffect>(
        _ content: Content,
        phase: ScrollTransitionPhase,
        motionIsReduced: Bool,
        reduceTransparency: Bool
    ) -> some VisualEffect {
        let phaseValue = phase.value
        let edgeAnchor: UnitPoint = phaseValue < 0 ? .top : .bottom
        let horizontalScale = motionIsReduced
            ? CGFloat(1)
            : TranscriptEdgeMotion.horizontalScale(for: phaseValue)
        let verticalScale = motionIsReduced
            ? CGFloat(1)
            : TranscriptEdgeMotion.verticalScale(for: phaseValue)
        let angle = motionIsReduced ? 0 : TranscriptEdgeMotion.rotation(for: phaseValue)
        let counterAngle = motionIsReduced
            ? 0
            : TranscriptEdgeMotion.counterRotation(for: phaseValue)
        let translation = motionIsReduced
            ? CGFloat(0)
            : TranscriptEdgeMotion.edgeTranslation(for: phaseValue)
        let lateralTranslation = motionIsReduced
            ? CGFloat(0)
            : TranscriptEdgeMotion.lateralTranslation(for: phaseValue)
        let blur = motionIsReduced || reduceTransparency
            ? CGFloat(0)
            : TranscriptEdgeMotion.blurRadius(for: phaseValue)
        let hingeAxisY: CGFloat = phaseValue < 0 ? -0.17 : 0.17

        return content
            .distortionEffect(
                ShaderLibrary.default.fabricFold(
                    .float(phaseValue),
                    .boundingRect
                ),
                maxSampleOffset: CGSize(width: 12, height: 18),
                isEnabled: !motionIsReduced
            )
            .colorEffect(
                ShaderLibrary.default.fabricFoldShade(
                    .float(phaseValue),
                    .boundingRect
                ),
                isEnabled: !motionIsReduced && !reduceTransparency
            )
            .opacity(
                TranscriptEdgeMotion.opacity(
                    for: phaseValue,
                    reduceTransparency: reduceTransparency
                )
            )
            .scaleEffect(x: horizontalScale, y: verticalScale, anchor: edgeAnchor)
            .rotation3DEffect(
                .degrees(angle),
                axis: (x: 1, y: hingeAxisY, z: 0.06),
                anchor: edgeAnchor,
                perspective: 0.64
            )
            .rotation3DEffect(
                .degrees(counterAngle),
                axis: (x: 0, y: 1, z: 0),
                anchor: edgeAnchor,
                perspective: 0.64
            )
            .offset(x: lateralTranslation, y: translation)
            .blur(radius: blur)
    }

    private func messageRow(
        _ message: ChatMessage,
        at index: Int,
        motionIsReduced: Bool
    ) -> some View {
        let reducesTransparency = reduceTransparency

        return MessageBubble(
            message: message,
            isStreaming: message.id.hasPrefix("stream-") && model.isSending,
            openApprovals: { model.present(.approvals) }
        )
        .padding(.top, startsRun(at: index) ? 22 : 7)
        .scrollTransition(.interactive, axis: .vertical) { content, phase in
            Self.transcriptEdgeEffect(
                content,
                phase: phase,
                motionIsReduced: motionIsReduced,
                reduceTransparency: reducesTransparency
            )
        }
        .transition(
            motionIsReduced
                ? .opacity
                : .asymmetric(
                    insertion: .opacity
                        .combined(with: .scale(scale: 0.986, anchor: .bottom))
                        .combined(with: .offset(y: 10)),
                    removal: .opacity
                )
        )
        .id(message.id)
    }

    private var visibleMenuRevealDistance: CGFloat {
        max(0, menuPullDistance - menuCloseDragDistance)
    }

    private var conversationRevealDistance: CGFloat {
        // The chat surface and menu meet on the same bottom plane. Moving the
        // conversation by an extra safe-area inset left a visible air gap, so
        // the screen looked like a separate sheet rather than something being
        // peeled away from the controls beneath it.
        visibleMenuRevealDistance
    }

    private var bottomSafeAreaInset: CGFloat {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .safeAreaInsets.bottom ?? 0
    }

    private var menuSurfaceProgress: CGFloat {
        PullMenuMotion.smoothStep(menuRevealProgress)
    }

    private func organicProgress(_ value: CGFloat) -> CGFloat {
        let progress = min(max(value, 0), 1)
        let remaining = 1 - progress
        return 1 - (remaining * remaining * remaining)
    }

    private func menuElementProgress(after start: CGFloat) -> CGFloat {
        guard start < 1 else { return menuRevealProgress >= 1 ? 1 : 0 }
        return min(max((menuRevealProgress - start) / (1 - start), 0), 1)
    }

    private func menuVisibilityProgress(after start: CGFloat) -> CGFloat {
        let progress = menuElementProgress(after: start)
        return progress * progress * (3 - (2 * progress))
    }

    private func menuRevealDistance(for geometry: ScrollGeometry) -> CGFloat {
        let minimumOffset = -geometry.contentInsets.top
        let contentBottomOffset = geometry.contentSize.height
            - geometry.containerSize.height
            + geometry.contentInsets.bottom
        let restingBottomOffset = max(minimumOffset, contentBottomOffset)
        let nativeOverscroll = max(0, geometry.contentOffset.y - restingBottomOffset)
        return min(nativeOverscroll * 1.55, menuRevealHeight)
    }

    private func finishPullMenu(releasedAt releaseDistance: CGFloat) {
        let releaseVelocity = menuPullReleaseVelocity
        let momentumDistance = min(
            releaseVelocity * 0.055,
            menuRevealHeight * 0.28
        )
        let projectedDistance = releaseDistance + momentumDistance
        let finalDistance = max(menuPullDistance, projectedDistance)
        setPullMenu(
            open: PullMenuMotion.commitsToOpen(
                revealDistance: finalDistance,
                revealHeight: menuRevealHeight
            ),
            releaseVelocity: releaseVelocity
        )
    }

    private var menuPullTrackingGesture: some Gesture {
        DragGesture(minimumDistance: 2, coordinateSpace: .local)
            .onChanged { value in
                guard !menuOpen else { return }
                menuPullReleaseVelocity = max(0, -value.velocity.height)
            }
    }

    private var pullMenu: some View {
        let headerProgress = menuElementProgress(after: 0.08)
        let headerVisibility = menuVisibilityProgress(after: 0.08)
        let headerUnfurl = organicProgress(headerProgress)

        return VStack(spacing: 11) {
            Capsule()
                .fill(AssistantTheme.ink(for: colorScheme).opacity(colorScheme == .dark ? 0.3 : 0.15))
                .frame(width: 42, height: 4)
                .scaleEffect(
                    x: reduceMotion ? 1 : 0.34 + (0.66 * headerUnfurl),
                    y: reduceMotion ? 1 : 1.7 - (0.7 * headerUnfurl),
                    anchor: .center
                )
                .opacity(headerVisibility)

            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(usesExtraLargeAccessibilityMenu ? "Workspace" : "Assistant workspace")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    Text(usesExtraLargeAccessibilityMenu ? "Pull down" : "Everything in one place")
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }

                Spacer()

                menuAutonomyToggle
                menuCloseButton
            }
            .opacity(headerVisibility)
            .offset(y: (1 - headerUnfurl) * 12)
            .scaleEffect(
                x: 1,
                y: reduceMotion ? 1 : 0.88 + (0.12 * headerUnfurl),
                anchor: .bottom
            )

            pullMenuActions
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .frame(height: menuRevealHeight, alignment: .top)
        .background(alignment: .bottom) {
            ZStack {
                AssistantTheme.canvas(for: colorScheme)
                LinearGradient(
                    colors: [
                        AssistantTheme.raised(for: colorScheme).opacity(colorScheme == .dark ? 0.38 : 0.72),
                        AssistantTheme.canvas(for: colorScheme).opacity(0.96),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
            .frame(height: menuRevealHeight + 48 + bottomSafeAreaInset)
            .offset(y: bottomSafeAreaInset)
        }
        .allowsHitTesting(menuOpen)
        .accessibilityHidden(!menuOpen)
        .accessibilityAction(named: "Close menu") {
            closePullMenu()
        }
        .simultaneousGesture(pullMenuCloseGesture)
    }

    @ViewBuilder
    private var pullMenuActions: some View {
        if usesExtraLargeAccessibilityMenu {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    pullMenuActionButtons
                }
                .scrollTargetLayout()
            }
            .contentMargins(.horizontal, 1, for: .scrollContent)
            .scrollTargetBehavior(.viewAligned)
            .scrollClipDisabled()
        } else if dynamicTypeSize.isAccessibilitySize {
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3),
                spacing: 8
            ) {
                pullMenuActionButtons
            }
        } else {
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4),
                spacing: 8
            ) {
                pullMenuActionButtons
            }
        }
    }

    @ViewBuilder
    private var pullMenuActionButtons: some View {
        pullMenuButton("Chat", icon: "bubble.left", isSelected: true, index: 0) {
            closePullMenu()
        }
        pullMenuButton("Chats", icon: "bubble.left.and.bubble.right", index: 1) {
            openRoute(.chats)
        }
        pullMenuButton("Activity", icon: "waveform.path.ecg", index: 2) {
            openRoute(.activity)
        }
        pullMenuButton("Goals", icon: "scope", index: 3) {
            openRoute(.goals)
        }
        pullMenuButton(
            "Approvals",
            icon: "checkmark.shield",
            badge: model.pendingApprovalCount,
            index: 4
        ) {
            openRoute(.approvals)
        }
        pullMenuButton(
            "Memory",
            icon: "brain.head.profile",
            badge: model.memoryReviewCount,
            index: 5
        ) {
            openRoute(.memory)
        }
        pullMenuButton("Documents", icon: "doc.text", index: 6) {
            openRoute(.documents)
        }
        pullMenuButton("Skills", icon: "lightbulb", index: 7) {
            openRoute(.skills)
        }
        pullMenuButton("Costs", icon: "dollarsign.circle", index: 8) {
            openRoute(.costs)
        }
        pullMenuButton("Anomalies", icon: "exclamationmark.triangle", index: 9) {
            openRoute(.anomalies)
        }
        pullMenuButton("Improvements", icon: "arrow.triangle.2.circlepath", index: 10) {
            openRoute(.improvements)
        }
        pullMenuButton("Settings", icon: "slider.horizontal.3", index: 11) {
            openRoute(.settings)
        }
    }

    private var menuAutonomyToggle: some View {
        Button {
            autonomous.toggle()
            menuActionFeedback += 1
        } label: {
            Label(
                autonomous ? "Auto on" : "Auto",
                systemImage: autonomous ? "bolt.shield.fill" : "bolt.shield"
            )
            .font(.caption.weight(.semibold))
            .foregroundStyle(
                autonomous ? Color.white : AssistantTheme.inkMuted(for: colorScheme)
            )
            .lineLimit(1)
            .padding(.horizontal, 10)
            .frame(height: 34)
            .background(
                autonomous
                    ? AssistantTheme.accent(for: colorScheme)
                    : AssistantTheme.sunken(for: colorScheme).opacity(0.72),
                in: Capsule()
            )
        }
        .buttonStyle(
            AssistantTactileButtonStyle(
                reduceMotion: reduceMotion,
                pressedScale: 0.975
            )
        )
        .accessibilityLabel(autonomous ? "Turn autonomous work off" : "Turn autonomous work on")
        .accessibilityValue(autonomous ? "On" : "Off")
    }

    @ViewBuilder
    private var menuCloseButton: some View {
        Button {
            closePullMenu()
        } label: {
            ZStack {
                if #available(iOS 26.0, *) {
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .frame(width: 34, height: 34)
                        .glassEffect(
                            .regular.tint(.white.opacity(0.12)).interactive(),
                            in: Circle()
                        )
                } else {
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .frame(width: 34, height: 34)
                        .background(AssistantTheme.sunken(for: colorScheme), in: Circle())
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(
            AssistantTactileButtonStyle(
                reduceMotion: reduceMotion,
                pressedScale: 0.975
            )
        )
        .accessibilityLabel("Close menu")
        .accessibilityIdentifier("assistant.chat.menu.close")
    }

    private func pullMenuButton(
        _ title: String,
        icon: String,
        badge: Int = 0,
        isSelected: Bool = false,
        index: Int,
        action: @escaping () -> Void
    ) -> some View {
        let progress = menuElementProgress(after: 0.18 + (CGFloat(index) * 0.045))
        let visibility = menuVisibilityProgress(after: 0.18 + (CGFloat(index) * 0.045))
        let unfurl = organicProgress(progress)
        let direction: Double = index.isMultiple(of: 2) ? -1 : 1

        return Button(action: action) {
            pullMenuButtonSurface(isSelected: isSelected) {
                VStack(spacing: 5) {
                    Image(systemName: icon)
                        .font(
                            usesExtraLargeAccessibilityMenu
                                ? .title3.weight(.semibold)
                                : .subheadline.weight(.semibold)
                        )
                        .frame(height: usesExtraLargeAccessibilityMenu ? 30 : 18)
                        .overlay(alignment: .topTrailing) {
                            if badge > 0 {
                                Text("\(badge)")
                                    .font(.system(size: 8, weight: .bold, design: .rounded))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 4)
                                    .frame(minWidth: 14, minHeight: 14)
                                    .background(Color.orange, in: Capsule())
                                    .offset(x: 9, y: -7)
                            }
                        }
                    Text(title)
                        .font(
                            usesExtraLargeAccessibilityMenu
                                ? .caption.weight(.semibold)
                                : .system(size: 10, weight: .semibold, design: .rounded)
                        )
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .minimumScaleFactor(
                            usesExtraLargeAccessibilityMenu
                                ? 0.9
                                : (dynamicTypeSize.isAccessibilitySize ? 1 : 0.88)
                        )
                        .frame(height: usesExtraLargeAccessibilityMenu ? nil : 22)
                }
                .foregroundStyle(
                    isSelected ? Color.white : AssistantTheme.ink(for: colorScheme)
                )
                .frame(maxWidth: .infinity)
                .frame(height: menuButtonHeight)
            }
        }
        .buttonStyle(
            AssistantTactileButtonStyle(
                reduceMotion: reduceMotion,
                pressedScale: 0.975
            )
        )
        .frame(width: usesExtraLargeAccessibilityMenu ? 220 : nil)
        .opacity(visibility)
        .offset(y: (1 - unfurl) * 24)
        .scaleEffect(
            x: reduceMotion ? 1 : 0.9 + (0.1 * unfurl),
            y: reduceMotion ? 1 : 0.68 + (0.32 * unfurl),
            anchor: .bottom
        )
        .rotationEffect(
            reduceMotion
                ? .zero
                : .degrees(direction * Double(1 - unfurl) * 1.1),
            anchor: .bottom
        )
        .accessibilityLabel(title)
        .accessibilityValue(isSelected ? "On" : "")
        .accessibilityIdentifier(
            "assistant.chat.menu.\(title.lowercased().replacingOccurrences(of: " ", with: "-"))"
        )
    }

    @ViewBuilder
    private func pullMenuButtonSurface<Content: View>(
        isSelected: Bool,
        @ViewBuilder content: () -> Content
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)

        if #available(iOS 26.0, *) {
            content()
                .glassEffect(
                    .regular
                        .tint(
                            isSelected
                                ? AssistantTheme.accent(for: colorScheme).opacity(0.78)
                                : .white.opacity(0.11)
                        )
                        .interactive(),
                    in: shape
                )
        } else {
            content()
                .background(
                    isSelected
                        ? AssistantTheme.accent(for: colorScheme)
                        : AssistantTheme.raised(for: colorScheme),
                    in: shape
                )
                .overlay {
                    shape.strokeBorder(.primary.opacity(isSelected ? 0 : 0.07), lineWidth: 1)
                }
        }
    }

    private var pullMenuCloseGesture: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                guard menuOpen else { return }
                let dragDistance = min(max(value.translation.height, 0), menuRevealHeight)
                menuCloseDragDistance = dragDistance
                updateMenuDetent(
                    reached: !PullMenuMotion.commitsToClose(
                        dragDistance: dragDistance,
                        revealHeight: menuRevealHeight
                    )
                )
            }
            .onEnded { value in
                guard menuOpen else { return }
                let projectedDistance = max(
                    value.translation.height,
                    value.predictedEndTranslation.height
                )
                if PullMenuMotion.commitsToClose(
                    dragDistance: projectedDistance,
                    revealHeight: menuRevealHeight
                ) {
                    setPullMenu(
                        open: false,
                        releaseVelocity: max(0, value.velocity.height)
                    )
                } else {
                    setPullMenu(
                        open: true,
                        releaseVelocity: max(0, value.velocity.height)
                    )
                }
            }
    }

    private func menuTransitionAnimation(
        open: Bool,
        releaseVelocity: CGFloat = 0,
        currentDistance: CGFloat
    ) -> Animation? {
        guard !reduceMotion else { return nil }
        let targetDistance = open ? menuRevealHeight : 0
        let normalizedVelocity = PullMenuMotion.springInitialVelocity(
            releaseVelocity: releaseVelocity,
            currentDistance: currentDistance,
            targetDistance: targetDistance
        )
        return .interpolatingSpring(
            duration: open ? 0.5 : 0.4,
            bounce: open ? 0.13 : 0.035,
            initialVelocity: normalizedVelocity
        )
    }

    private func setPullMenu(open: Bool, releaseVelocity: CGFloat = 0) {
        let currentRevealDistance = visibleMenuRevealDistance

        if menuDetentReached != open {
            menuDetentReached = open
            menuDetentFeedback += 1
        }

        var normalizationTransaction = Transaction(animation: nil)
        normalizationTransaction.disablesAnimations = true
        withTransaction(normalizationTransaction) {
            menuPullDistance = currentRevealDistance
            menuCloseDragDistance = 0
        }

        menuOpen = open
        withAnimation(
            menuTransitionAnimation(
                open: open,
                releaseVelocity: releaseVelocity,
                currentDistance: currentRevealDistance
            )
        ) {
            menuPullActive = false
            menuPullDistance = open ? menuRevealHeight : 0
        }
        menuPullReleaseVelocity = 0
    }

    private func updateMenuDetent(reached: Bool) {
        guard menuDetentReached != reached else { return }
        menuDetentReached = reached
        menuDetentFeedback += 1
    }

    private func openPullMenu() {
        composerFocused = false
        setPullMenu(open: true)
    }

    private func closePullMenu() {
        setPullMenu(open: false)
    }

    private func openRoute(_ route: AssistantRoute) {
        menuActionFeedback += 1
        composerFocused = false
        menuOpen = false
        menuPullDistance = 0
        menuCloseDragDistance = 0
        menuDetentReached = false
        model.present(route)
    }

    private var emptyConversation: some View {
        VStack(spacing: 22) {
            Spacer(minLength: 70)
            VStack(spacing: 8) {
                Image(systemName: "sparkle")
                    .font(.system(size: 26, weight: .light))
                    .foregroundStyle(.white)
                Text("What should we move forward?")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white)
                Text("Start with an outcome. \(model.agentName) can research, plan, draft, schedule, and keep following up when the work takes time.")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.white.opacity(0.68))
                    .frame(maxWidth: 320)
            }
            VStack(spacing: 0) {
                starter("Clear the inbox", prompt: "Summarize my unread email", icon: "tray")
                Divider().overlay(.white.opacity(0.12))
                starter("Review the week", prompt: "What’s on my calendar this week?", icon: "calendar")
                Divider().overlay(.white.opacity(0.12))
                starter("Plan a trip", prompt: "Draft a plan for my next trip", icon: "map")
            }
            .padding(.horizontal, 4)
            .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 18))
            .overlay { RoundedRectangle(cornerRadius: 18).stroke(.white.opacity(0.12)) }
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity)
    }

    private var topTranscriptVeil: some View {
        // The edge treatment is deliberately pigment-only. A material veil
        // caught the crown and created a bright, floating glow behind the
        // Dynamic Island; the scroll mask and per-row edge motion already
        // provide the required fade and blur.
        LinearGradient(
            colors: [
                AssistantTheme.stageDepth.opacity(reduceTransparency ? 0.2 : 0.12),
                AssistantTheme.stageDepth.opacity(reduceTransparency ? 0.07 : 0.025),
                .clear,
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(height: 118)
        .offset(y: -30)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func starter(_ text: String, prompt: String, icon: String) -> some View {
        Button {
            sendFeedback += 1
            requestScrollToBottom()
            model.send(prompt)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.subheadline).frame(width: 22)
                Text(text).font(.subheadline.weight(.medium))
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.48))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .padding(.horizontal, 14)
        }
        .buttonStyle(AssistantTactileButtonStyle(reduceMotion: reduceMotion, pressedScale: 0.985))
        .disabled(model.isSending)
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if autonomous {
                autonomousNotice
                    .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
            }

            if !model.latestQuickReplies.isEmpty && !composerFocused && !model.isSending {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.latestQuickReplies, id: \.self) { reply in
                            Button {
                                sendFeedback += 1
                                requestScrollToBottom()
                                model.send(reply)
                            } label: {
                                Text(reply)
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(AssistantTheme.stageStrong)
                                    .padding(.horizontal, 14)
                                    .frame(height: 36)
                                    .modifier(QuickReplySurface())
                                    .padding(.vertical, 4)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(
                                AssistantTactileButtonStyle(
                                    reduceMotion: reduceMotion,
                                    pressedScale: 0.97
                                )
                            )
                            .accessibilityHint("Sends this suggested reply")
                        }
                    }
                }
                .scrollClipDisabled()
                .transition(.opacity)
            }

            composerInput
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .background {
            LinearGradient(
                colors: [
                    .clear,
                    AssistantTheme.stage(for: colorScheme, mood: model.latestMood).opacity(0.06),
                    AssistantTheme.stage(for: colorScheme, mood: model.latestMood).opacity(0.24),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(.container)
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: autonomous)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: composerFocused)
    }

    private var autonomousNotice: some View {
        HStack(spacing: 8) {
            Image(systemName: "bolt.shield.fill")
                .font(.caption.weight(.semibold))
            Text("Auto mode for the next message")
                .font(.caption.weight(.medium))
            Spacer(minLength: 8)
            Button {
                autonomous = false
            } label: {
                ZStack {
                    Image(systemName: "xmark")
                        .font(.caption2.weight(.bold))
                        .frame(width: 26, height: 26)
                        .background(.white.opacity(0.18), in: Circle())
                }
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Turn off auto mode")
        }
        .foregroundStyle(Color(hex: 0x5C3A0E))
        .padding(.leading, 12)
        .padding(.trailing, 7)
        .padding(.vertical, 7)
        .background(Color(hex: 0xFFE9B7).opacity(0.94), in: Capsule())
        .overlay {
            Capsule().strokeBorder(.white.opacity(0.32), lineWidth: 0.7)
        }
        .shadow(color: AssistantTheme.stageDepth.opacity(0.1), radius: 9, y: 4)
    }

    private var composerInput: some View {
        composerInputSurface {
            HStack(alignment: .bottom, spacing: 8) {
                TextField(
                    "",
                    text: $draft,
                    prompt: Text(composerPrompt).foregroundStyle(composerPlaceholderColor),
                    axis: .vertical
                )
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .font(.system(size: composerFontSize, weight: .regular))
                    .tracking(-0.12)
                    .lineSpacing(2)
                    .foregroundStyle(composerTextColor)
                    .tint(composerCursorColor)
                    .textInputAutocapitalization(.sentences)
                    .focused($composerFocused)
                    .submitLabel(.send)
                    .onSubmit(sendDraft)
                    .padding(.leading, 6)
                    .padding(.vertical, 10)
                    .frame(minHeight: 44, alignment: .leading)
                    .accessibilityHint("Pull past the latest message to open the menu.")
                    .accessibilityAction(named: "Open menu") {
                        openPullMenu()
                    }
                    .accessibilityIdentifier("assistant.chat.composer")

                Button(action: sendDraft) {
                    ZStack {
                        if model.isSending {
                            ComposerWorkingIndicator(color: composerTextColor)
                                .transition(.scale(scale: 0.72).combined(with: .opacity))
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 16, weight: .bold))
                                .transition(.scale(scale: 0.72).combined(with: .opacity))
                        }
                    }
                    .foregroundStyle(
                        !canSend
                            ? composerPlaceholderColor
                            : AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                    )
                    .frame(width: 44, height: 44)
                    .background(
                        AssistantTheme.raised(for: colorScheme).opacity(
                            model.isSending
                                ? 0.56
                                : (!canSend ? 0.12 : 0.68)
                        ),
                        in: Circle()
                    )
                    .overlay {
                        Circle().strokeBorder(
                            composerTextColor.opacity(model.isSending ? 0.25 : (canSend ? 0.3 : 0.1)),
                            lineWidth: 0.7
                        )
                    }
                    .scaleEffect(model.isSending || canSend ? 1 : 0.92)
                    .shadow(
                        color: AssistantTheme.stageDepth.opacity(
                            model.isSending ? 0.08 : (canSend ? 0.16 : 0)
                        ),
                        radius: 7,
                        y: 3
                    )
                }
                .buttonStyle(.plain)
                .disabled(!canSend || model.isSending)
                .accessibilityLabel(model.isSending ? "Assistant is working" : "Send message")
                .accessibilityIdentifier("assistant.chat.send")
                .accessibilityHint(
                    model.isSending
                        ? "You can continue drafting while the assistant works"
                        : "Sends the current message"
                )
                .animation(
                    reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.76),
                    value: canSend
                )
                .animation(
                    reduceMotion ? nil : .easeOut(duration: 0.18),
                    value: model.isSending
                )
            }
            .padding(.leading, 10)
            .padding(.trailing, 8)
            .padding(.vertical, 8)
            .frame(minHeight: 60)
        }
        .overlay {
            RoundedRectangle(
                cornerRadius: AssistantTheme.conversationCornerRadius,
                style: .continuous
            )
            .strokeBorder(
                composerTextColor.opacity(
                    colorSchemeContrast == .increased
                        ? (composerFocused ? 0.54 : 0.38)
                        : (composerFocused ? 0.28 : 0.16)
                ),
                lineWidth: colorSchemeContrast == .increased ? 1.1 : 0.8
            )
        }
        .overlay(alignment: .top) {
            Capsule()
                .fill(.white.opacity(reduceTransparency ? 0.16 : 0.1))
                .frame(height: 0.8)
                .padding(.horizontal, 28)
                .padding(.top, 1)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        .shadow(
            color: Color(hex: 0x0C2D1B, alpha: composerFocused ? 0.15 : 0.1),
            radius: composerFocused ? 18 : 13,
            y: composerFocused ? 8 : 5
        )
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.18),
            value: composerFocused
        )
    }

    private var composerTextColor: Color {
        // Typed words sit directly over the translucent stage, so use the
        // warm white already present in the conversation instead of the
        // app's dark canvas ink. It stays soft, but remains readable over
        // every animated stage color.
        AssistantTheme.stageStrong.opacity(
            colorSchemeContrast == .increased ? 1 : 0.96
        )
    }

    private var composerPrompt: String {
        model.isSending ? "Working — you can keep typing" : "Ask anything…"
    }

    private var composerPlaceholderColor: Color {
        // Keep the prompt deliberately quieter than entered text without
        // letting it sink into the green glass.
        AssistantTheme.stageStrong.opacity(
            colorSchemeContrast == .increased
                ? 0.9
                : (composerFocused ? 0.78 : 0.68)
        )
    }

    private var composerCursorColor: Color {
        colorSchemeContrast == .increased
            ? AssistantTheme.stageStrong
            : Color(hex: 0xB9ECCF)
    }

    @ViewBuilder
    private func composerInputSurface<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        let shape = RoundedRectangle(
            cornerRadius: AssistantTheme.conversationCornerRadius,
            style: .continuous
        )

        if #available(iOS 26.0, *) {
            let glass: Glass = reduceTransparency ? .regular : .clear

            content()
                .background {
                    shape.fill(
                        LinearGradient(
                            colors: [
                                .white.opacity(
                                    reduceTransparency
                                        ? 0.1
                                        : (composerFocused ? 0.055 : 0.025)
                                ),
                                AssistantTheme.stageDepth.opacity(
                                    reduceTransparency ? 0.08 : 0.025
                                ),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                }
                .glassEffect(
                    glass
                        .tint(
                            AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                                .opacity(
                                    reduceTransparency
                                        ? 0.66
                                        : (composerFocused ? 0.34 : 0.25)
                                )
                        )
                        .interactive(),
                    in: shape
                )
        } else {
            content()
                .background {
                    ZStack {
                        shape.fill(.ultraThinMaterial)
                        shape.fill(
                            AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                                .opacity(composerFocused ? 0.49 : 0.4)
                        )
                        shape.fill(
                            LinearGradient(
                                colors: [.white.opacity(0.075), .white.opacity(0.012)],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                    }
                }
                .overlay {
                    shape.strokeBorder(
                        composerTextColor.opacity(composerFocused ? 0.26 : 0.15),
                        lineWidth: 1
                    )
                }
        }
    }

    private func sendDraft() {
        let text = draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        draft = ""
        sendFeedback += 1
        composerFocused = true
        requestScrollToBottom()
        model.send(text, autonomous: autonomous)
        autonomous = false
    }

    private var showsJumpToLatest: Bool {
        !isAtBottom
            && !model.messages.isEmpty
            && model.errorMessage == nil
    }

    private func jumpToLatestButton(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            jumpToLatestSurface
                .padding(.vertical, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("assistant.chat.jump-to-latest")
        .accessibilityLabel("Jump to latest message")
        .accessibilityHint(
            hasUnseenMessages
                ? "New messages are available"
                : "Scrolls to the bottom of the conversation"
        )
    }

    @ViewBuilder
    private var jumpToLatestSurface: some View {
        if #available(iOS 26.0, *) {
            let glass: Glass = reduceTransparency ? .regular : .clear

            jumpToLatestLabel
                .foregroundStyle(AssistantTheme.stageStrong)
                .background {
                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [.white.opacity(0.08), .white.opacity(0.018)],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                }
                .glassEffect(
                    glass
                        .tint(
                            AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                                .opacity(reduceTransparency ? 0.82 : 0.52)
                        )
                        .interactive(),
                    in: Capsule()
                )
                .overlay {
                    Capsule().strokeBorder(
                        .white.opacity(colorSchemeContrast == .increased ? 0.44 : 0.22),
                        lineWidth: colorSchemeContrast == .increased ? 1.1 : 0.8
                    )
                }
                .shadow(color: Color(hex: 0x0C2D1B, alpha: 0.11), radius: 11, y: 5)
        } else {
            jumpToLatestLabel
                .foregroundStyle(AssistantTheme.stageStrong)
                .background {
                    Capsule()
                        .fill(.ultraThinMaterial)
                        .overlay {
                            Capsule().fill(
                                AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                                    .opacity(0.6)
                            )
                        }
                }
                .overlay {
                    Capsule()
                        .strokeBorder(
                            .white.opacity(colorSchemeContrast == .increased ? 0.44 : 0.22),
                            lineWidth: colorSchemeContrast == .increased ? 1.1 : 0.8
                        )
                }
                .shadow(color: Color(hex: 0x0C2D1B, alpha: 0.11), radius: 11, y: 5)
        }
    }

    private var jumpToLatestLabel: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.down")
                .font(.system(size: 12, weight: .bold))
            Text("Jump to latest")
            if hasUnseenMessages {
                Circle()
                    .fill(AssistantTheme.stageStrong.opacity(0.9))
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
            }
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 13)
        .frame(height: 36)
    }

    private func requestScrollToBottom() {
        if menuOpen {
            closePullMenu()
        }
        scrollRequest += 1
        hasUnseenMessages = false
    }

    private func positionInitialConversationIfNeeded(using proxy: ScrollViewProxy) {
        guard !model.messages.isEmpty, !hasPositionedInitialConversation else { return }
        hasPositionedInitialConversation = true
        DispatchQueue.main.async {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }

    private func scrollToBottom(using proxy: ScrollViewProxy) {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.26, extraBounce: 0)) {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isSending
    }

    private func startsRun(at index: Int) -> Bool {
        index == 0 || model.messages[index - 1].role != model.messages[index].role
    }

    private func errorBanner(_ text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .accessibilityHidden(true)
            Text(text)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button {
                model.dismissError()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(AssistantTactileButtonStyle(reduceMotion: reduceMotion))
            .accessibilityLabel("Dismiss error")
        }
        .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .padding(.vertical, 4)
        .background(
            AssistantTheme.errorSurface(for: colorScheme),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(
                    Color.red.opacity(colorSchemeContrast == .increased ? 0.48 : 0.18),
                    lineWidth: colorSchemeContrast == .increased ? 1.1 : 0.7
                )
        }
        .shadow(
            color: .black.opacity(colorScheme == .dark ? 0.22 : 0.1),
            radius: 12,
            y: 4
        )
    }
}

private struct QuickReplySurface: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .glassEffect(
                    .regular.tint(.white.opacity(0.075)).interactive(),
                    in: Capsule()
                )
        } else {
            content
                .background(.ultraThinMaterial, in: Capsule())
                .overlay {
                    Capsule().strokeBorder(.white.opacity(0.2), lineWidth: 0.7)
                }
        }
    }
}

private struct ComposerWorkingIndicator: View {
    let color: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var rotating = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(color.opacity(0.15), lineWidth: 1.6)

            Circle()
                .trim(from: 0.08, to: 0.68)
                .stroke(
                    color.opacity(0.88),
                    style: StrokeStyle(lineWidth: 1.8, lineCap: .round)
                )
                .rotationEffect(.degrees(rotating ? 360 : 0))

            Circle()
                .fill(color)
                .frame(width: 3.5, height: 3.5)
                .offset(y: -9)
                .rotationEffect(.degrees(rotating ? 360 : 0))
        }
        .frame(width: 21, height: 21)
        .task(id: reduceMotion) {
            rotating = false
            guard !reduceMotion else { return }
            withAnimation(.linear(duration: 1.05).repeatForever(autoreverses: false)) {
                rotating = true
            }
        }
        .accessibilityHidden(true)
    }
}
