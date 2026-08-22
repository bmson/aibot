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

    /// Converts an upward drag into a stable, bounded menu reveal. Keeping
    /// this independent from the scroll view makes a reversing finger return
    /// along the same path rather than letting UIKit's rubber-band add motion.
    static func openingDistance(translationY: CGFloat, revealHeight: CGFloat) -> CGFloat {
        min(max(-translationY, 0), max(revealHeight, 0))
    }

    static func projectedOpeningDistance(
        translationY: CGFloat,
        predictedEndTranslationY: CGFloat,
        revealHeight: CGFloat
    ) -> CGFloat {
        openingDistance(
            translationY: min(translationY, predictedEndTranslationY),
            revealHeight: revealHeight
        )
    }

    static func closingDistance(translationY: CGFloat, revealHeight: CGFloat) -> CGFloat {
        min(max(translationY, 0), max(revealHeight, 0))
    }

    static func projectedClosingDistance(
        translationY: CGFloat,
        predictedEndTranslationY: CGFloat,
        revealHeight: CGFloat
    ) -> CGFloat {
        closingDistance(
            translationY: max(translationY, predictedEndTranslationY),
            revealHeight: revealHeight
        )
    }

    static func openingCommitmentDistance(revealHeight: CGFloat) -> CGFloat {
        // Keep the committed pull short and physical rather than scaling it
        // with the whole menu. The normal menu is tall because it holds two
        // rows of destinations, but requiring a third of it made slow drags
        // travel more than 80pt before opening. Accessibility layouts should
        // not need an even longer pull either.
        guard revealHeight > 0 else { return 0 }
        return min(max(revealHeight * 0.25, 48), 60)
    }

    static func closingCommitmentDistance(revealHeight: CGFloat) -> CGFloat {
        guard revealHeight > 0 else { return 0 }
        return min(max(revealHeight * 0.22, 44), 56)
    }

    static func commitsToOpen(revealDistance: CGFloat, revealHeight: CGFloat) -> Bool {
        revealDistance >= openingCommitmentDistance(revealHeight: revealHeight)
    }

    /// Slack around the closing detent, so a drag hovering at the threshold
    /// does not toggle the haptic every point.
    static let detentHysteresis: CGFloat = 12

    /// Retains the opening detent within a small release band. This ensures a
    /// finger that felt the open haptic does not unexpectedly snap closed when
    /// it lifts a few points short of the bare threshold.
    static func holdsOpeningDetent(
        revealDistance: CGFloat,
        revealHeight: CGFloat,
        detentHeld: Bool
    ) -> Bool {
        let threshold = openingCommitmentDistance(revealHeight: revealHeight)
        return detentHeld
            ? revealDistance > threshold - detentHysteresis
            : revealDistance >= threshold
    }

    /// Whether a release at this distance closes the menu.
    ///
    /// Both the live detent and the release decision go through here so they
    /// cannot disagree. They used to: the detent applied the hysteresis and the
    /// release compared against the bare threshold, so a drag that stopped
    /// anywhere in the upper half of the band reported "stays open" and then
    /// closed anyway.
    static func closesOnRelease(
        dragDistance: CGFloat,
        revealHeight: CGFloat,
        detentHeld: Bool
    ) -> Bool {
        let threshold = closingCommitmentDistance(revealHeight: revealHeight)
        return detentHeld
            ? dragDistance >= threshold + detentHysteresis
            : dragDistance > threshold - detentHysteresis
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
    // The menu tiles were the one surface in the app on absolute point sizes,
    // so they stayed put through every Dynamic Type step below accessibility.
    @ScaledMetric(relativeTo: .caption2) private var menuTileFontSize = 11.0
    @ScaledMetric(relativeTo: .caption2) private var menuBadgeFontSize = 9.0
    @State private var draft = ""
    @State private var autonomous = false
    @State private var isAtBottom = true
    @State private var hasUnseenMessages = false
    @State private var composerHeight: CGFloat = 0
    @State private var scrollRequest = 0
    @State private var hasPositionedInitialConversation = false
    @State private var menuPullDistance: CGFloat = 0
    @State private var menuCloseDragDistance: CGFloat = 0
    @State private var menuPullActive = false
    @State private var menuPullTranscriptCompensation: CGFloat = 0
    @State private var menuOpen = false
    @State private var menuDetentReached = false
    @State private var menuDetentFeedback = 0
    @State private var menuActionFeedback = 0
    @State private var transcriptScrollPhase: ScrollPhase = .idle
    @State private var sendFeedback = 0
    @State private var jumpFeedback = 0
    @FocusState private var composerFocused: Bool

    // The menu holds a fixed two-row grid of eight destinations (three rows at
    // accessibility sizes, one horizontal strip at extra-large), so the reveal
    // height is exact rather than a guess: padding + grip + header + rows.
    private var menuRevealHeight: CGFloat {
        if usesExtraLargeAccessibilityMenu { return 208 }
        return dynamicTypeSize.isAccessibilitySize ? 336 : 236
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
                // Bleed under the keyboard as well — otherwise the window's
                // white shows around the keyboard's rounded corners.
                .background(stageBackdrop.ignoresSafeArea(.container).ignoresSafeArea(.keyboard))
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
                // Tap-outside-to-dismiss: the shifted surface stays visible
                // above the open menu, and the standard sheet affordance is
                // that tapping it closes the menu. The catcher lives outside
                // the ScrollView so it stays interactive while the transcript
                // itself is not.
                .overlay {
                    if menuOpen {
                        // The overlay does not follow the surface's .offset — it
                        // covers the full unshifted frame — so without the bottom
                        // padding it would invisibly cover the open menu and
                        // swallow every tap meant for the menu buttons. Keep
                        // the content shape and gesture *inside* that padding:
                        // applying either after it makes the transparent inset
                        // tappable too, so a destination tap only closes the
                        // menu instead of opening its route.
                        Color.black.opacity(0.001)
                            .contentShape(Rectangle())
                            .onTapGesture { closePullMenu() }
                            .accessibilityLabel("Close menu")
                            .accessibilityAddTraits(.isButton)
                            .padding(.bottom, conversationRevealDistance)
                    }
                }

            if !menuOpen {
                pullMenuOpenGestureTarget
            }
        }
        .background(
            stageBackdrop.ignoresSafeArea(.container).ignoresSafeArea(.keyboard)
        )
        // The conversation surface is visually above the revealed submenu.
        // Once it is open, the sheet's vertical dismissal drag takes priority
        // across both surfaces. Its 10pt threshold means ordinary tile taps
        // still reach their buttons. Leaving it inactive while closed avoids
        // competing with the ScrollView's opening pull.
        .highPriorityGesture(
            pullMenuCloseGesture,
            including: menuOpen ? .all : .none
        )
        .toolbar(.hidden, for: .navigationBar)
        .overlay(alignment: .top) {
            if let error = model.errorMessage {
                errorBanner(error)
                    .padding(.horizontal, 12)
                    // Clear the activity crown, which RootView draws over this
                    // overlay at a higher zIndex — expanded, it reached about
                    // 23pt into the banner, and covered it outright at
                    // accessibility sizes.
                    .padding(.top, errorBannerTopInset)
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .move(edge: .top).combined(with: .opacity)
                    )
            }
        }
        .animation(
            reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.86),
            value: model.errorMessage
        )
        .sensoryFeedback(.selection, trigger: menuDetentFeedback)
        .sensoryFeedback(.selection, trigger: menuActionFeedback)
        .sensoryFeedback(.impact(weight: .light), trigger: sendFeedback)
        .sensoryFeedback(.selection, trigger: jumpFeedback)
    }

    private var errorBannerTopInset: CGFloat {
        guard model.activityThought != nil else { return 4 }
        return ActivityCrown.safeAreaOverhang(
            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize
        ) + 8
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
                // Keyed to the identity list rather than the messages
                // themselves: without an animation transaction the row
                // transitions above never played at all, but animating on the
                // full array would re-animate the bubble's geometry on every
                // streamed token.
                .animation(
                    reduceMotion ? nil : .snappy(duration: 0.3, extraBounce: 0.02),
                    value: model.messages.map(\.id)
                )
            }
            .ignoresSafeArea(.container, edges: [.top, .bottom])
            .scrollClipDisabled()
            .scrollIndicators(.hidden)
            // A live scroll view under an active menu pull can still pan a
            // fraction independently of the composer. That compresses the
            // latest-message spacer during a slow pull, making the input look
            // attached to the bubble. Freeze it from the first pull point,
            // not only after the sheet has committed open.
            .scrollDisabled(menuOpen || menuPullActive)
            .scrollDismissesKeyboard(.interactively)
            // Pin to the bottom only when the reader is at rest and nothing
            // is streaming: the anchor fights a finger on the transcript, and
            // while a reply streams in it force-scrolls the view down with
            // every token instead of letting the text grow below the fold.
            .defaultScrollAnchor(pinsTranscriptToBottom ? .bottom : nil)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                let contentFits = geometry.contentSize.height <= geometry.containerSize.height + 1
                return contentFits || geometry.visibleRect.maxY >= geometry.contentSize.height - 64
            } action: { _, atBottom in
                isAtBottom = atBottom
                if atBottom {
                    hasUnseenMessages = false
                }
            }
            // A ScrollView may adjust its content offset while its pan is
            // being cancelled. Mirror that exact adjustment on the composer
            // during a menu pull so its clearance from the latest bubble is
            // invariant instead of briefly compressing or expanding.
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                guard menuPullActive else { return 0 }
                return transcriptContentDisplacement(for: geometry)
            } action: { _, displacement in
                guard menuPullActive else { return }
                var transaction = Transaction(animation: nil)
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    menuPullTranscriptCompensation = displacement
                }
            }
            .onScrollPhaseChange { _, newPhase, _ in
                transcriptScrollPhase = newPhase
            }
            // Keep the transcript fully legible at the top. The mask only
            // softens its lower edge where content approaches the composer;
            // per-row scroll transitions dimmed whole bubbles and were
            // removed for exactly that reason.
            .mask {
                LinearGradient(
                    stops: [
                        .init(color: .black, location: 0),
                        .init(color: .black, location: 0.94),
                        .init(color: .black.opacity(0.9), location: 0.985),
                        .init(color: .black.opacity(0.72), location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
            .onAppear {
                positionInitialConversationIfNeeded(using: proxy)
            }
            .onChange(of: model.messages) { oldMessages, newMessages in
                if newMessages.isEmpty {
                    hasPositionedInitialConversation = false
                } else if !hasPositionedInitialConversation {
                    positionInitialConversationIfNeeded(using: proxy)
                } else if isAtBottom {
                    // While a finger is on the transcript the gesture owns the
                    // scroll position — re-anchoring here would fight the drag.
                    guard !userIsDraggingTranscript else { return }
                    let isStreamingUpdate = newMessages.count == oldMessages.count
                        && newMessages.last?.id.hasPrefix("stream-") == true
                    // Streaming text must not scroll the view: the bubble grows
                    // below the fold and Jump to latest takes the reader down.
                    // Only brand-new messages get the animated reveal.
                    if !isStreamingUpdate {
                        scrollToBottom(using: proxy)
                    }
                } else {
                    hasUnseenMessages = true
                }
            }
            .onChange(of: scrollRequest) { _, _ in
                scrollToBottom(using: proxy)
            }
            .onChange(of: model.latestQuickReplies) { _, replies in
                // Suggestions only render while the composer is unfocused, and
                // sendDraft deliberately keeps the keyboard up — so a reply's
                // quick replies were never reachable without dismissing it by
                // hand. Yield focus when one actually arrives, unless the
                // reader has already started typing a follow-up.
                guard !replies.isEmpty, !model.isSending, draft.isEmpty else { return }
                composerFocused = false
            }
            .onChange(of: composerHeight) { previousHeight, _ in
                // Only the first measurement needs help landing on the latest
                // message. Ongoing changes — the keyboard animating in, the
                // field growing — are followed automatically by the bottom
                // scroll anchor inside the keyboard's own animation; an
                // explicit scroll here stepped the transcript in jumps.
                guard previousHeight == 0 else { return }
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .overlay(alignment: .bottom) {
                composer
                    .safeAreaPadding(.bottom)
                    .offset(y: menuPullActive ? menuPullTranscriptCompensation : 0)
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
            .allowsHitTesting(!menuOpen)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: showsJumpToLatest)
        }
    }

    private var menuRevealProgress: CGFloat {
        min(max(visibleMenuRevealDistance / menuRevealHeight, 0), 1)
    }

    /// The content's position relative to its resting bottom anchor. Applying
    /// this to the composer during a pull keeps the message/input gap fixed if
    /// UIKit briefly repositions the ScrollView while its pan is disabled.
    private func transcriptContentDisplacement(for geometry: ScrollGeometry) -> CGFloat {
        let minimumOffset = -geometry.contentInsets.top
        let contentBottomOffset = geometry.contentSize.height
            - geometry.containerSize.height
            + geometry.contentInsets.bottom
        let restingBottomOffset = max(minimumOffset, contentBottomOffset)
        return restingBottomOffset - geometry.contentOffset.y
    }

    private func messageRow(
        _ message: ChatMessage,
        at index: Int,
        motionIsReduced: Bool
    ) -> some View {
        // No per-row edge effects: a scroll transition applies opacity and
        // blur to the whole row, so a message taller than the viewport would
        // dim even though most of it is on screen. The ScrollView mask fades
        // pixels at the clipped edges instead, which works for any height.
        MessageBubble(
            message: message,
            isStreaming: message.id.hasPrefix("stream-") && model.isSending,
            openApprovals: { model.present(.approvals) }
        )
        .padding(.top, startsRun(at: index) ? 22 : 7)
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
        // The menu frame is bottom-aligned to the container safe area while
        // its background bleeds under the home indicator. The conversation is
        // edge-to-edge, so it has to travel the same physical distance: the
        // reveal plus the device's bottom inset. Scale the inset with the live
        // drag so both surfaces remain attached for the entire gesture.
        visibleMenuRevealDistance + (deviceBottomSafeAreaInset * menuRevealProgress)
    }

    private var deviceBottomSafeAreaInset: CGFloat {
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

    private func finishPullMenu(releasedAt releaseDistance: CGFloat) {
        setPullMenu(
            open: PullMenuMotion.holdsOpeningDetent(
                revealDistance: releaseDistance,
                revealHeight: menuRevealHeight,
                detentHeld: menuDetentReached
            )
        )
    }

    private func pullMenuOpenGesture(
        requiresTranscriptBottom: Bool,
        minimumDistance: CGFloat = 0
    ) -> some Gesture {
        // Claim the pan at its first point so ScrollView cannot begin its own
        // rubber-band before the pull becomes active. A zero translation is
        // still ignored below, so ordinary taps remain ordinary taps.
        DragGesture(minimumDistance: minimumDistance)
            .onChanged { value in
                guard !menuOpen else { return }

                let pullDistance = PullMenuMotion.openingDistance(
                    translationY: value.translation.height,
                    revealHeight: menuRevealHeight
                )
                // A pull can begin only at the latest message, but once it
                // starts it remains latched even as the ScrollView reports a
                // transient non-bottom geometry during its rubber-band.
                guard menuPullActive
                    || ((!requiresTranscriptBottom || isAtBottom) && pullDistance > 0)
                else { return }

                if !menuPullActive {
                    menuPullActive = true
                    composerFocused = false
                    var transaction = Transaction(animation: nil)
                    transaction.disablesAnimations = true
                    withTransaction(transaction) {
                        menuPullTranscriptCompensation = 0
                    }
                }

                menuPullDistance = pullDistance

                // Hysteresis around the detent: a slow drag hovering at the
                // threshold otherwise toggles the haptic every point.
                let detentReached = PullMenuMotion.holdsOpeningDetent(
                    revealDistance: pullDistance,
                    revealHeight: menuRevealHeight,
                    detentHeld: menuDetentReached
                )
                updateMenuDetent(reached: detentReached)
            }
            .onEnded { value in
                guard menuPullActive else { return }

                let projectedPull = PullMenuMotion.projectedOpeningDistance(
                    translationY: value.translation.height,
                    predictedEndTranslationY: value.predictedEndTranslation.height,
                    revealHeight: menuRevealHeight
                )
                finishPullMenu(releasedAt: projectedPull)
            }
    }

    /// The target deliberately sits beside—not inside—the moving conversation
    /// surface. Otherwise the target is offset under the finger while a drag
    /// is being sampled, which can make a slow pull re-anchor and flicker.
    private var pullMenuOpenGestureTarget: some View {
        Color.clear
            .contentShape(Rectangle())
            .frame(maxWidth: .infinity)
            .frame(height: 132)
            // Take precedence over the ScrollView's pan recognizer. The
            // gesture is attached before the padding so the composer remains
            // fully interactive below this fixed pull zone.
            .highPriorityGesture(pullMenuOpenGesture(requiresTranscriptBottom: true))
            .padding(.bottom, composerHeight + 8)
            .accessibilityHidden(true)
    }

    private var pullMenu: some View {
        let headerProgress = menuElementProgress(after: 0.08)
        let headerVisibility = menuVisibilityProgress(after: 0.08)
        let headerUnfurl = organicProgress(headerProgress)

        return VStack(spacing: 11) {
            // The handle advertises that this sheet can be dragged closed.
            // Its recognizer lives on the shared chat/menu container, so the
            // same downward swipe works from a tile, its header, or the chat
            // sheet. Its 10pt threshold leaves ordinary taps untouched.
            Capsule()
                .fill(AssistantTheme.ink(for: colorScheme).opacity(colorScheme == .dark ? 0.3 : 0.15))
                .frame(width: 42, height: 4)
                .scaleEffect(
                    x: reduceMotion ? 1 : 0.34 + (0.66 * headerUnfurl),
                    y: reduceMotion ? 1 : 1.7 - (0.7 * headerUnfurl),
                    anchor: .center
                )
                .opacity(headerVisibility)

            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Menu")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    Text("Swipe down to close")
                        .font(.caption2)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
                .accessibilityElement(children: .combine)

                Spacer()
                menuAutonomyToggle
            }
            .frame(height: 40)
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
        .padding(.top, 26)
        .frame(height: menuRevealHeight, alignment: .top)
        .background {
            // Bleed into the bottom safe area: the menu is bottom-aligned
            // inside the safe area, so without this the stage color shows
            // through as a strip under the menu by the home indicator.
            ZStack {
                // Keep the submenu's familiar neutral-gray canvas. The green
                // conversation stage remains behind this half-opacity glass,
                // rather than becoming the submenu's own color.
                AssistantTheme.canvas(for: colorScheme)
                LinearGradient(
                    colors: [
                        AssistantTheme.raised(for: colorScheme).opacity(colorScheme == .dark ? 0.19 : 0.36),
                        AssistantTheme.canvas(for: colorScheme).opacity(0.48),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
            .ignoresSafeArea(.container, edges: .bottom)
            .allowsHitTesting(false)
        }
        // Hit-testing follows the open flag, which stays true for the whole
        // close drag and flips false the moment the close animation starts —
        // so the composer is reachable as soon as the menu begins to dismiss.
        // Gating on the reveal progress instead cancelled the active close
        // gesture mid-drag once the menu was halfway shut.
        .allowsHitTesting(menuOpen)
        .accessibilityHidden(!menuOpen)
        .accessibilityAction(named: "Close menu") {
            closePullMenu()
        }
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

    // Eight primary destinations, two rows of four. The lower-traffic areas
    // (Documents, Skills, Costs, Anomalies, Improvements) live under More, which
    // keeps every label here a single scannable word and the grid symmetric.
    @ViewBuilder
    private var pullMenuActionButtons: some View {
        pullMenuButton("Chat", icon: "bubble.left", isSelected: true, index: 0) {
            closePullMenu()
        }
        pullMenuButton("Activity", icon: "waveform.path.ecg", index: 1) {
            openRoute(.activity)
        }
        pullMenuButton("Goals", icon: "scope", index: 2) {
            openRoute(.goals)
        }
        pullMenuButton(
            "Approvals",
            icon: "checkmark.shield",
            badge: model.pendingApprovalCount,
            index: 3
        ) {
            openRoute(.approvals)
        }
        pullMenuButton("Chats", icon: "bubble.left.and.bubble.right", index: 4) {
            openRoute(.chats)
        }
        pullMenuButton(
            "Memory",
            icon: "brain.head.profile",
            badge: model.memoryReviewCount,
            index: 5
        ) {
            openRoute(.memory)
        }
        pullMenuButton("Capabilities", icon: "puzzlepiece.extension", index: 6) {
            openRoute(.capabilities)
        }
        pullMenuButton("More", icon: "ellipsis", index: 7) {
            openRoute(.settings)
        }
    }

    private var menuAutonomyToggle: some View {
        Button {
            autonomous.toggle()
            menuActionFeedback += 1
        } label: {
            Label(
                autonomous ? "Auto on" : "Auto next",
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
            // Takes the target to 44pt without growing the capsule, which the
            // menu's fixed reveal height has no room for.
            .contentShape(Rectangle().inset(by: -5))
        }
        .buttonStyle(
            AssistantTactileButtonStyle(
                reduceMotion: reduceMotion,
                pressedScale: 0.975
            )
        )
        .accessibilityLabel(autonomous ? "Turn autonomous work off" : "Turn autonomous work on")
        .accessibilityValue(autonomous ? "On" : "Off")
        .accessibilityHint("Applies to the next message only")
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
                                Text(badge > 99 ? "99+" : "\(badge)")
                                    .font(.system(size: menuBadgeFontSize, weight: .bold, design: .rounded))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 4)
                                    .frame(minWidth: 14, minHeight: 14)
                                    .background(Color.orange, in: Capsule())
                                    .offset(x: 10, y: -8)
                                    .accessibilityHidden(true)
                            }
                        }
                    Text(title)
                        .font(
                            usesExtraLargeAccessibilityMenu
                                ? .caption.weight(.semibold)
                                : .system(size: menuTileFontSize, weight: .semibold, design: .rounded)
                        )
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .foregroundStyle(
                    isSelected ? Color.white : AssistantTheme.ink(for: colorScheme)
                )
                .frame(maxWidth: .infinity)
                .frame(height: menuButtonHeight)
                .overlay(alignment: .topTrailing) {
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(8)
                            .accessibilityHidden(true)
                    }
                }
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
        .accessibilityValue(
            badge > 0
                ? "\(badge) pending"
                : (isSelected ? "Selected" : "")
        )
        .accessibilityIdentifier(
            "assistant.chat.menu.\(title.lowercased().replacingOccurrences(of: " ", with: "-"))"
        )
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityRemoveTraits(isSelected ? [] : .isSelected)
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
                                ? AssistantTheme.accent(for: colorScheme).opacity(0.39)
                                : .white.opacity(0.055)
                        )
                        .interactive(),
                    in: shape
                )
        } else {
            content()
                .background(
                    isSelected
                        ? AssistantTheme.accent(for: colorScheme).opacity(0.5)
                        : AssistantTheme.raised(for: colorScheme).opacity(0.5),
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
                let dragDistance = PullMenuMotion.closingDistance(
                    translationY: value.translation.height,
                    revealHeight: menuRevealHeight
                )
                menuCloseDragDistance = dragDistance
                // Same hysteresis as the opening detent, mirrored.
                let willClose = PullMenuMotion.closesOnRelease(
                    dragDistance: dragDistance,
                    revealHeight: menuRevealHeight,
                    detentHeld: menuDetentReached
                )
                updateMenuDetent(reached: !willClose)
            }
            .onEnded { value in
                guard menuOpen else { return }
                let projectedDistance = PullMenuMotion.projectedClosingDistance(
                    translationY: value.translation.height,
                    predictedEndTranslationY: value.predictedEndTranslation.height,
                    revealHeight: menuRevealHeight
                )
                // Released against the same edge the detent last reported, so
                // the haptic the finger felt and the outcome always agree.
                setPullMenu(
                    open: !PullMenuMotion.closesOnRelease(
                        dragDistance: projectedDistance,
                        revealHeight: menuRevealHeight,
                        detentHeld: menuDetentReached
                    )
                )
            }
    }

    private func menuTransitionAnimation(
        open: Bool
    ) -> Animation? {
        guard !reduceMotion else { return nil }
        return .interpolatingSpring(
            duration: open ? 0.5 : 0.4,
            bounce: open ? 0.13 : 0.035
        )
    }

    private func setPullMenu(open: Bool) {
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
            menuPullTranscriptCompensation = 0
        }

        menuOpen = open
        withAnimation(menuTransitionAnimation(open: open)) {
            menuPullActive = false
            menuPullDistance = open ? menuRevealHeight : 0
        }
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
        // Through setPullMenu rather than assigning the state directly, so
        // picking a destination springs shut the way tapping Chat does instead
        // of teleporting under the presenting sheet.
        setPullMenu(open: false)
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
            menuPullTab

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
                .opacity(0.5)
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
                    AssistantTheme.stage(for: colorScheme, mood: model.latestMood).opacity(0.03),
                    AssistantTheme.stage(for: colorScheme, mood: model.latestMood).opacity(0.12),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(.container)
            .ignoresSafeArea(.keyboard)
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: autonomous)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: composerFocused)
        // The quick-reply strip is gated on this too, so without it the
        // composer changed height in a hard step at the start and end of every
        // turn.
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: model.isSending)
    }

    private var menuPullTab: some View {
        Button {
            openPullMenu()
        } label: {
            ZStack {
                Color.clear
                HStack(spacing: 6) {
                    Image(systemName: "chevron.up")
                        .font(.system(size: 9, weight: .bold))
                    Text("Menu")
                        .font(.caption2.weight(.semibold))
                }
                .foregroundStyle(AssistantTheme.stageStrong.opacity(0.86))
                .padding(.horizontal, 11)
                .frame(height: 28)
                .background(.black.opacity(colorScheme == .dark ? 0.2 : 0.13), in: Capsule())
                .overlay {
                    Capsule().strokeBorder(.white.opacity(0.16), lineWidth: 0.7)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(
            AssistantTactileButtonStyle(
                reduceMotion: reduceMotion,
                pressedScale: 0.97
            )
        )
        // Tapping is the discoverable shortcut; dragging upward from the same
        // visible tab preserves the physical pull interaction.
        .highPriorityGesture(
            pullMenuOpenGesture(
                requiresTranscriptBottom: false,
                minimumDistance: 8
            )
        )
        .accessibilityLabel("Open menu")
        .accessibilityHint("Tap or swipe up to show destinations")
        .accessibilityIdentifier("assistant.chat.menu-handle")
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
        .foregroundStyle(AssistantTheme.stageWarningInk)
        .padding(.leading, 12)
        .padding(.trailing, 7)
        .padding(.vertical, 7)
        .background(AssistantTheme.stageWarningSurface.opacity(0.94), in: Capsule())
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

                Button {
                    if model.isSending {
                        model.cancelSend()
                    } else {
                        sendDraft()
                    }
                } label: {
                    ZStack {
                        if model.isSending {
                            // A spinner in a button's position reads as a
                            // progress indicator, not a control. The square
                            // inside the arc says the turn can be stopped.
                            ComposerWorkingIndicator(color: composerTextColor)
                                .overlay {
                                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                                        .fill(composerTextColor)
                                        .frame(width: 8, height: 8)
                                }
                                .transition(.scale(scale: 0.72).combined(with: .opacity))
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 16, weight: .bold))
                                .transition(.scale(scale: 0.72).combined(with: .opacity))
                        }
                    }
                    .foregroundStyle(
                        !canSend && !model.isSending
                            ? composerPlaceholderColor
                            : AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                    )
                    .frame(width: 44, height: 44)
                    .background(
                        AssistantTheme.raised(for: colorScheme).opacity(
                            model.isSending
                                ? 0.28
                                : (!canSend ? 0.06 : 0.34)
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
                .disabled(!canSend && !model.isSending)
                .accessibilityLabel(model.isSending ? "Stop the assistant" : "Send message")
                .accessibilityIdentifier("assistant.chat.send")
                .accessibilityHint(
                    model.isSending
                        ? "Stops this turn and keeps what has arrived so far"
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
        // No manual stroke or top highlight on top of the glass: the glass
        // rim already draws the edge, and a static outline layered over the
        // touch-reactive glass is what produced the visible double outline.
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
        AssistantTheme.stageStrong
    }

    private var composerPrompt: String {
        // Short enough to survive the narrowest phones without truncating.
        model.isSending ? "Working — keep typing" : "Ask anything…"
    }

    private var composerPlaceholderColor: Color {
        Color.white
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
                        AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                            // Keep the input visually grounded in the green
                            // conversation stage; the liquid glass remains
                            // above it, while 85% of the surface remains the
                            // darker green conversation stage.
                            .opacity(0.85)
                    )
                }
                // Not .interactive(): the glass would expand slightly on
                // touch, which read as a duplicated, offset input outline
                // over the field's own edge. Focus already lifts the field
                // via the shadow and tint below.
                .glassEffect(
                    glass
                        .tint(
                            AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                                .opacity(
                                    reduceTransparency
                                        ? 0.42
                                        : (composerFocused ? 0.065 : 0.04)
                                )
                        ),
                    in: shape
                )
        } else {
            content()
                .background {
                    ZStack {
                        shape.fill(.ultraThinMaterial)
                        shape.fill(
                            AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                                .opacity(0.85)
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
                .frame(minWidth: 44, minHeight: 44)
                .padding(.vertical, 6)
                .padding(.horizontal, 4)
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
                            AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                                .opacity(0.85)
                        )
                }
                .glassEffect(
                    glass
                        .tint(
                            AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                                .opacity(reduceTransparency ? 0.46 : 0.1)
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
                                    .opacity(0.85)
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

    private var userIsDraggingTranscript: Bool {
        transcriptScrollPhase == .interacting || transcriptScrollPhase == .tracking
    }

    private var pinsTranscriptToBottom: Bool {
        !userIsDraggingTranscript && !menuPullActive && !model.isSending
    }

    private func scrollToBottom(using proxy: ScrollViewProxy) {
        if transcriptScrollPhase == .idle {
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.26, extraBounce: 0)) {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        } else {
            // An animated scrollTo issued while the transcript still has
            // momentum is deferred until the movement settles, so the button
            // felt unresponsive mid-fling. Snap immediately instead — that
            // interrupts the momentum and lands on the latest message.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
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

    var body: some View {
        // TimelineView keeps the motion smooth even while the transcript
        // re-renders on every streamed token — an animation started in .task
        // stuttered or stalled under that churn. The arc breathes in length
        // while it rotates, which reads calmer than the old rigid comet.
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: reduceMotion)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            let rotation = (time / 1.3).truncatingRemainder(dividingBy: 1) * 360
            let breath = 0.5 - (0.5 * cos(2 * Double.pi * (time / 1.7).truncatingRemainder(dividingBy: 1)))
            let arcLength = 0.14 + (0.58 * breath)

            ZStack {
                Circle()
                    .stroke(color.opacity(0.18), lineWidth: 2)
                Circle()
                    .trim(from: 0, to: arcLength)
                    .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(rotation))
            }
        }
        .frame(width: 20, height: 20)
        .accessibilityHidden(true)
    }
}
