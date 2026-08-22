import SwiftUI
import UIKit

enum PullMenuMotion {
    /// A projected flick still needs enough real travel to read as a swipe.
    /// This keeps a tiny, quick probe from inheriting an exaggerated UIKit
    /// prediction and crossing a detent the finger never approached.
    static let minimumFlickTravel: CGFloat = 32
    static let maximumFlickDuration: TimeInterval = 0.2
    /// Do not decide an axis from the first few noisy touch samples. Real
    /// fingers often move 2–6pt sideways before settling into a vertical
    /// swipe, especially when starting on the composer.
    static let verticalIntentDistance: CGFloat = 10
    static let horizontalLockDistance: CGFloat = 12
    static let axisDominance: CGFloat = 1.15

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

    /// Uses momentum only for an unmistakable flick. Slow or shallow drags
    /// release where the finger actually stopped, which makes both menu
    /// detents feel stable instead of prediction-driven.
    static func releaseDistance(
        actualDistance: CGFloat,
        projectedDistance: CGFloat,
        gestureDuration: TimeInterval?
    ) -> CGFloat {
        guard projectedDistance > actualDistance,
              actualDistance >= minimumFlickTravel,
              gestureDuration.map({ $0 <= maximumFlickDuration }) ?? true
        else { return actualDistance }

        return projectedDistance
    }

    /// Keeps a horizontal accessibility-menu swipe from tugging the sheet.
    /// A diagonal only becomes dismissal once downward travel is dominant.
    static func hasClosingIntent(translationX: CGFloat, translationY: CGFloat) -> Bool {
        translationY >= verticalIntentDistance
            && translationY >= abs(translationX) * axisDominance
    }

    /// The composer is both a text control and the opening grab region. Only
    /// a clearly upward drag should hand that touch to the sheet; horizontal
    /// cursor movement and ambiguous diagonals stay with the text field.
    static func hasOpeningIntent(translationX: CGFloat, translationY: CGFloat) -> Bool {
        -translationY >= verticalIntentDistance
            && -translationY >= abs(translationX) * axisDominance
    }

    /// Locks out a horizontal control only after the sideways movement is
    /// both substantial and clearly dominant. Until then the gesture remains
    /// undecided, allowing an initially wobbly finger to become a valid pull.
    static func hasHorizontalIntent(translationX: CGFloat, translationY: CGFloat) -> Bool {
        abs(translationX) >= horizontalLockDistance
            && abs(translationX) >= abs(translationY) * axisDominance
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
    let safeAreaTopInset: CGFloat

    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @ScaledMetric(relativeTo: .body) private var composerFontSize = 16.0
    // The menu tiles were the one surface in the app on absolute point sizes,
    // so they stayed put through every Dynamic Type step below accessibility.
    @ScaledMetric(relativeTo: .caption2) private var menuTileFontSize = 11.0
    @ScaledMetric(relativeTo: .caption2) private var menuBadgeFontSize = 9.0
    @State private var draft = ""
    @State private var isAtBottom = true
    // Opening requires the actual bottom edge. `isAtBottom` deliberately has
    // a wider 64pt tolerance for unread-state UI and is too permissive for
    // deciding whether an upward transcript drag means scroll or menu.
    @State private var isAtMenuOpeningEdge = true
    @State private var hasUnseenMessages = false
    @State private var composerHeight: CGFloat = 0
    @State private var scrollRequest = 0
    // Unpositioned by default so normal finger scrolling remains authoritative.
    // Jump to latest writes an explicit edge only for that owner action.
    @State private var transcriptScrollPosition = ScrollPosition()
    @State private var hasPositionedInitialConversation = false
    @State private var menuPullDistance: CGFloat = 0
    @State private var menuCloseDragDistance: CGFloat = 0
    @State private var menuPullActive = false
    @State private var menuOpenGestureStartedAt: Date?
    @State private var menuOpenGestureIsHorizontal = false
    @State private var menuCloseGestureStartedAt: Date?
    @State private var menuCloseGestureIsHorizontal = false
    @State private var menuPullTranscriptCompensation: CGFloat = 0
    @State private var menuOpen = false
    @State private var menuDetentReached = false
    @State private var menuDetentFeedback = 0
    @State private var menuAutonomyFeedback = 0
    @State private var transcriptScrollPhase: ScrollPhase = .idle
    @State private var sendFeedback = 0
    @State private var jumpFeedback = 0
    @FocusState private var composerFocused: Bool

    // The menu holds a fixed two-row grid of eight destinations (three rows at
    // accessibility sizes, one horizontal strip at extra-large). Derive its
    // reveal from those physical pieces so the sheet stays attached to the
    // finger even when the header needs more room for enlarged type.
    private var menuRevealHeight: CGFloat {
        26 + 4 + 11 + menuHeaderHeight + 11 + menuActionsHeight
    }

    private var menuHeaderHeight: CGFloat {
        if usesExtraLargeAccessibilityMenu { return 150 }
        return dynamicTypeSize.isAccessibilitySize ? 64 : 40
    }

    private var menuActionsHeight: CGFloat {
        if usesExtraLargeAccessibilityMenu { return menuButtonHeight }
        let rowCount: CGFloat = dynamicTypeSize.isAccessibilitySize ? 3 : 2
        return (rowCount * menuButtonHeight) + ((rowCount - 1) * 8)
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
                // Keep the stage edge-to-edge inside the currently available
                // chat region. Respecting the keyboard safe area lets the
                // neutral window backing show through its rounded corners.
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
                // At the largest accessibility sizes the destination row is
                // horizontally scrollable, so the lifted conversation owns
                // one of the dedicated vertical-close regions instead of a
                // recognizer spanning that strip.
                .simultaneousGesture(
                    pullMenuCloseGesture,
                    including: menuOpen && usesExtraLargeAccessibilityMenu ? .all : .none
                )

            if !menuOpen {
                pullMenuOpenGestureTarget
            }
        }
        .background {
            // This remains behind every app surface. When the keyboard is
            // present, the stage above respects its safe area and exposes this
            // neutral backing only around the keyboard's rounded corners.
            AssistantTheme.keyboardBackdrop(for: colorScheme)
                .ignoresSafeArea()
        }
        // The conversation surface is visually above the revealed submenu.
        // Once open, observe its vertical dismissal drag across both surfaces
        // without stealing the horizontal swipe used by the extra-large
        // accessibility menu. The 10pt threshold leaves tile taps untouched;
        // disabling it while closed avoids the transcript's opening pull.
        .simultaneousGesture(
            pullMenuCloseGesture,
            including: menuOpen && !usesExtraLargeAccessibilityMenu ? .all : .none
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
        .sensoryFeedback(.selection, trigger: menuAutonomyFeedback)
        .sensoryFeedback(.impact(weight: .light), trigger: sendFeedback)
        .sensoryFeedback(.selection, trigger: jumpFeedback)
        .onChange(of: model.presentedRoute) { _, route in
            // Menu tiles already close themselves before navigating. This
            // catches routes presented from notifications, deep links, or the
            // activity crown so Back never reveals a stale open sheet.
            if route != nil, menuOpen || menuPullActive {
                closePullMenu()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase != .active else { return }
            settleInterruptedMenuGesture()
        }
    }

    private var errorBannerTopInset: CGFloat {
        guard model.activityThought != nil else { return 4 }
        return ActivityCrown.safeAreaOverhang(
            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
            safeAreaTopInset: safeAreaTopInset
        ) + 8
    }

    private var crownContentClearanceHeight: CGFloat {
        ActivityCrown.screenClearanceHeight(
            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
            isExpanded: model.activityThought != nil,
            islandTopInset: ActivityCrown.islandTopInset(
                safeAreaTopInset: safeAreaTopInset
            )
        )
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
            .scrollPosition($transcriptScrollPosition)
            // Reserve real layout room for the crown at the start of the
            // conversation. Unlike the removed clear mask, this cannot slice
            // through a message bubble or its text.
            .contentMargins(
                .top,
                crownContentClearanceHeight + 8,
                for: .scrollContent
            )
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
            .onScrollGeometryChange(for: Bool.self) { geometry in
                let contentFits = geometry.contentSize.height <= geometry.containerSize.height + 1
                return contentFits || geometry.visibleRect.maxY >= geometry.contentSize.height - 2
            } action: { _, atOpeningEdge in
                isAtMenuOpeningEdge = atOpeningEdge
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
            // The crown already covers its own footprint. A full-width clear
            // band here cut straight through visible message bubbles, so keep
            // the transcript opaque at the top and soften only its lower edge.
            .mask {
                VStack(spacing: 0) {
                    Color.black

                    LinearGradient(
                        stops: [
                            .init(color: .black, location: 0),
                            .init(color: .black.opacity(0.9), location: 0.72),
                            .init(color: .black.opacity(0.72), location: 1),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(height: 52)
                }
            }
            .animation(
                reduceMotion ? nil : .easeInOut(duration: 0.22),
                value: model.activityThought != nil
            )
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
                        jumpToLatestImmediately(using: proxy)
                    }
                    .padding(.bottom, composerHeight + 20)
                    .transition(.opacity)
                }
            }
            .allowsHitTesting(!menuOpen)
            // Match the visual modal state for assistive navigation: the
            // transcript remains mounted behind the lifted sheet, but it
            // should not compete with the eight revealed destinations.
            .accessibilityHidden(menuOpen)
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
        // Read the pull in the window coordinate space. The composer travels
        // with the conversation surface while this gesture is active; global
        // coordinates keep that movement from feeding back into the finger's
        // translation and make slow pulls track as cleanly as quick swipes.
        DragGesture(minimumDistance: minimumDistance, coordinateSpace: .global)
            .onChanged { value in
                guard !menuOpen else { return }

                if !menuPullActive {
                    if menuOpenGestureIsHorizontal { return }
                    if PullMenuMotion.hasHorizontalIntent(
                        translationX: value.translation.width,
                        translationY: value.translation.height
                    ) {
                        // Lock an unmistakably horizontal gesture before the
                        // sheet begins moving. This protects cursor placement
                        // in the composer from becoming an accidental reveal.
                        menuOpenGestureIsHorizontal = true
                        return
                    }
                    guard PullMenuMotion.hasOpeningIntent(
                        translationX: value.translation.width,
                        translationY: value.translation.height
                    ) else { return }
                }

                let pullDistance = PullMenuMotion.openingDistance(
                    translationY: value.translation.height,
                    revealHeight: menuRevealHeight
                )
                // A pull can begin only at the latest message, but once it
                // starts it remains latched even as the ScrollView reports a
                // transient non-bottom geometry during its rubber-band.
                guard menuPullActive
                    || ((!requiresTranscriptBottom || isAtMenuOpeningEdge) && pullDistance > 0)
                else { return }

                if menuOpenGestureStartedAt == nil {
                    menuOpenGestureStartedAt = value.time
                }

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
                defer {
                    menuOpenGestureStartedAt = nil
                    menuOpenGestureIsHorizontal = false
                }
                guard !menuOpen else { return }
                guard !menuOpenGestureIsHorizontal else { return }

                let actualPull = PullMenuMotion.openingDistance(
                    translationY: value.translation.height,
                    revealHeight: menuRevealHeight
                )
                let projectedPull = PullMenuMotion.projectedOpeningDistance(
                    translationY: value.translation.height,
                    predictedEndTranslationY: value.predictedEndTranslation.height,
                    revealHeight: menuRevealHeight
                )
                let releasePull = PullMenuMotion.releaseDistance(
                    actualDistance: actualPull,
                    projectedDistance: projectedPull,
                    gestureDuration: menuOpenGestureStartedAt.map {
                        max(0, value.time.timeIntervalSince($0))
                    }
                )
                let usesProjection = releasePull > actualPull
                let projectedX = abs(value.predictedEndTranslation.width) > abs(value.translation.width)
                    ? value.predictedEndTranslation.width
                    : value.translation.width
                let projectedY = min(
                    value.translation.height,
                    value.predictedEndTranslation.height
                )
                guard menuPullActive || PullMenuMotion.hasOpeningIntent(
                    translationX: usesProjection ? projectedX : value.translation.width,
                    translationY: usesProjection ? projectedY : value.translation.height
                ) else { return }
                // A fast swipe may cross the commitment distance between the
                // recognizer's last change sample and its end sample. Do not
                // require a prior live-pull update for that decisive release.
                guard menuPullActive
                    || ((!requiresTranscriptBottom || isAtMenuOpeningEdge) && releasePull > 0)
                else { return }
                if !menuPullActive {
                    composerFocused = false
                }
                finishPullMenu(releasedAt: releasePull)
            }
    }

    /// The target deliberately sits beside—not inside—the moving conversation
    /// surface. Otherwise the target is offset under the finger while a drag
    /// is being sampled, which can make a slow pull re-anchor and flicker.
    private var pullMenuOpenGestureTarget: some View {
        // A nearly transparent fill remains a concrete hit-test surface on
        // device; `Color.clear` can be discarded by UIKit's hit-testing bridge.
        Color.black.opacity(0.001)
            .contentShape(Rectangle())
            .frame(maxWidth: .infinity)
            .frame(height: 96)
            // Take precedence over the ScrollView's pan recognizer. The
            // gesture is attached before the padding so the composer remains
            // fully interactive below this fixed pull zone.
            .highPriorityGesture(pullMenuOpenGesture(requiresTranscriptBottom: true))
            .padding(.bottom, composerHeight + 8)
            // When the reader is even slightly above the true bottom, touches
            // in this region belong to transcript scrolling. Keep the target
            // alive after a pull begins so geometry changes cannot cancel it.
            .allowsHitTesting(menuPullActive || (isAtMenuOpeningEdge && !userIsDraggingTranscript))
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

            pullMenuHeader
            .frame(height: menuHeaderHeight)
            .simultaneousGesture(
                pullMenuCloseGesture,
                including: menuOpen && usesExtraLargeAccessibilityMenu ? .all : .none
            )
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
    private var pullMenuHeader: some View {
        if usesExtraLargeAccessibilityMenu {
            VStack(alignment: .leading, spacing: 12) {
                pullMenuTitle
                menuAutonomyToggle
                    .fixedSize(horizontal: true, vertical: false)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            HStack(spacing: 12) {
                pullMenuTitle
                Spacer()
                menuAutonomyToggle
            }
        }
    }

    private var pullMenuTitle: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("Menu")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            Text("Swipe down to close")
                .font(.caption2)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
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
            model.nextMessageAutonomous.toggle()
            menuAutonomyFeedback += 1
        } label: {
            Label(
                model.nextMessageAutonomous ? "Auto on" : "Auto next",
                systemImage: model.nextMessageAutonomous ? "bolt.shield.fill" : "bolt.shield"
            )
            .font(.caption.weight(.semibold))
            .foregroundStyle(
                model.nextMessageAutonomous ? Color.white : AssistantTheme.ink(for: colorScheme)
            )
            .lineLimit(1)
            .padding(.horizontal, 10)
            .frame(
                height: usesExtraLargeAccessibilityMenu
                    ? 58
                    : (dynamicTypeSize.isAccessibilitySize ? 44 : 34)
            )
            .background(
                model.nextMessageAutonomous
                    // Adaptive accent is deliberately pale in dark mode for
                    // icons and links; as a solid fill it loses contrast with
                    // this white label. The deep brand green is the control
                    // fill in both appearances.
                    ? AssistantTheme.accent
                    : AssistantTheme.sunken(for: colorScheme).opacity(0.72),
                in: Capsule()
            )
            .overlay {
                Capsule().strokeBorder(
                    model.nextMessageAutonomous
                        ? Color.white.opacity(0.16)
                        : Color.primary.opacity(colorScheme == .dark ? 0.13 : 0.07),
                    lineWidth: 0.7
                )
            }
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
        .accessibilityLabel(model.nextMessageAutonomous ? "Turn autonomous work off" : "Turn autonomous work on")
        .accessibilityValue(model.nextMessageAutonomous ? "On" : "Off")
        .accessibilityHint("Applies to the next message only")
        .accessibilityAddTraits(model.nextMessageAutonomous ? .isSelected : [])
        .accessibilityRemoveTraits(model.nextMessageAutonomous ? [] : .isSelected)
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
                                    .background(
                                        // This is a solid fill behind 9pt
                                        // white type, so use the deep warning
                                        // ink rather than the adaptive golden
                                        // foreground token.
                                        AssistantTheme.warningInk,
                                        in: Capsule()
                                    )
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

        if #available(iOS 26.0, *), !reduceTransparency {
            content()
                .background(
                    isSelected ? AssistantTheme.accent : Color.clear,
                    in: shape
                )
                .glassEffect(
                    .regular
                        .tint(
                            isSelected
                                ? AssistantTheme.accent.opacity(0.22)
                                : .white.opacity(0.055)
                        )
                        .interactive(),
                    in: shape
                )
        } else {
            content()
                .background(
                    isSelected
                        ? AssistantTheme.accent
                        : AssistantTheme.raised(for: colorScheme).opacity(
                            reduceTransparency ? 1 : 0.5
                        ),
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
                if menuCloseGestureIsHorizontal {
                    menuCloseDragDistance = 0
                    updateMenuDetent(reached: true)
                    return
                }
                if PullMenuMotion.hasHorizontalIntent(
                    translationX: value.translation.width,
                    translationY: value.translation.height
                ) {
                    // Lock the axis from the first unambiguous sample. The
                    // predicted end occasionally bends a horizontal strip
                    // swipe downward; it must never retroactively become a
                    // sheet dismissal.
                    menuCloseGestureIsHorizontal = true
                    menuCloseDragDistance = 0
                    updateMenuDetent(reached: true)
                    return
                }
                guard PullMenuMotion.hasClosingIntent(
                    translationX: value.translation.width,
                    translationY: value.translation.height
                ) else {
                    menuCloseDragDistance = 0
                    updateMenuDetent(reached: true)
                    return
                }
                if menuCloseGestureStartedAt == nil {
                    menuCloseGestureStartedAt = value.time
                }
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
                defer {
                    menuCloseGestureStartedAt = nil
                    menuCloseGestureIsHorizontal = false
                }
                guard menuOpen else { return }
                guard !menuCloseGestureIsHorizontal else {
                    setPullMenu(open: true)
                    return
                }
                let actualDistance = PullMenuMotion.closingDistance(
                    translationY: value.translation.height,
                    revealHeight: menuRevealHeight
                )
                let projectedDistance = PullMenuMotion.projectedClosingDistance(
                    translationY: value.translation.height,
                    predictedEndTranslationY: value.predictedEndTranslation.height,
                    revealHeight: menuRevealHeight
                )
                let releaseDistance = PullMenuMotion.releaseDistance(
                    actualDistance: actualDistance,
                    projectedDistance: projectedDistance,
                    gestureDuration: menuCloseGestureStartedAt.map {
                        max(0, value.time.timeIntervalSince($0))
                    }
                )
                let usesProjection = releaseDistance > actualDistance
                let projectedX = abs(value.predictedEndTranslation.width) > abs(value.translation.width)
                    ? value.predictedEndTranslation.width
                    : value.translation.width
                let projectedY = max(
                    value.translation.height,
                    value.predictedEndTranslation.height
                )
                guard PullMenuMotion.hasClosingIntent(
                    translationX: usesProjection ? projectedX : value.translation.width,
                    translationY: usesProjection ? projectedY : value.translation.height
                ) else {
                    setPullMenu(open: true)
                    return
                }
                // Released against the same edge the detent last reported, so
                // the haptic the finger felt and the outcome always agree.
                setPullMenu(
                    open: !PullMenuMotion.closesOnRelease(
                        dragDistance: releaseDistance,
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
            duration: open ? 0.44 : 0.34,
            bounce: open ? 0.08 : 0.02
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

    /// SwiftUI may not deliver `onEnded` when the app resigns active (Control
    /// Center, an incoming call, or backgrounding). Resolve the partial pull
    /// to its current detent and clear every axis lock so the next touch never
    /// inherits stale gesture state.
    private func settleInterruptedMenuGesture() {
        if menuPullActive {
            finishPullMenu(releasedAt: menuPullDistance)
        } else if menuCloseDragDistance > 0 {
            setPullMenu(
                open: !PullMenuMotion.closesOnRelease(
                    dragDistance: menuCloseDragDistance,
                    revealHeight: menuRevealHeight,
                    detentHeld: menuDetentReached
                )
            )
        }

        menuOpenGestureStartedAt = nil
        menuOpenGestureIsHorizontal = false
        menuCloseGestureStartedAt = nil
        menuCloseGestureIsHorizontal = false
    }

    private func openPullMenu() {
        composerFocused = false
        setPullMenu(open: true)
    }

    private func closePullMenu() {
        setPullMenu(open: false)
    }

    private func openRoute(_ route: AssistantRoute) {
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
            sendPreset(prompt)
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
            if model.nextMessageAutonomous && !menuOpen {
                autonomousNotice
                    .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
            }

            if !model.latestQuickReplies.isEmpty && !composerFocused && !model.isSending {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.latestQuickReplies, id: \.self) { reply in
                            Button {
                                sendPreset(reply)
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
                // The input itself is the bottom-edge grab region. Keeping
                // this recognizer off the outer composer lets the quick-reply
                // strip retain its native horizontal scroll gesture. Observe
                // the pull simultaneously so a stationary first touch still
                // reaches the TextField and focuses it immediately.
                .simultaneousGesture(
                    pullMenuOpenGesture(
                        requiresTranscriptBottom: false,
                        minimumDistance: 8
                    )
                )
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
        }
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.18),
            value: model.nextMessageAutonomous
        )
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: composerFocused)
        // The quick-reply strip is gated on this too, so without it the
        // composer changed height in a hard step at the start and end of every
        // turn.
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: model.isSending)
    }

    private var autonomousNotice: some View {
        HStack(spacing: 8) {
            Image(systemName: "bolt.shield.fill")
                .font(.caption.weight(.semibold))
            Text("Auto mode for the next message")
                .font(.caption.weight(.medium))
            Spacer(minLength: 8)
            Button {
                model.nextMessageAutonomous = false
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
                    // Match the visible capsule instead of leaving its 8pt
                    // top and bottom padding as dead zones. The simultaneous
                    // tap keeps native cursor placement intact while making
                    // first-touch focus explicit.
                    .contentShape(Rectangle().inset(by: -8))
                    .simultaneousGesture(
                        TapGesture().onEnded {
                            composerFocused = true
                        }
                    )
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

    /// Shared resting tint for controls floating over the conversation stage.
    /// Keeping this as one value prevents Jump to latest from drifting darker
    /// than the composer when either glass treatment is adjusted.
    private var conversationControlGlassTintOpacity: Double { 0.04 }
    private var conversationControlBackgroundOpacity: Double { 0.85 }

    @ViewBuilder
    private func composerInputSurface<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        let shape = RoundedRectangle(
            cornerRadius: AssistantTheme.conversationCornerRadius,
            style: .continuous
        )

        if reduceTransparency {
            content()
                .background(
                    AssistantTheme.stage(for: colorScheme, mood: model.latestMood),
                    in: shape
                )
                .overlay {
                    shape.strokeBorder(
                        composerTextColor.opacity(composerFocused ? 0.32 : 0.2),
                        lineWidth: 1
                    )
                }
        } else if #available(iOS 26.0, *) {
            content()
                .background {
                    shape.fill(
                        AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                            // Keep the input visually grounded in the green
                            // conversation stage; the liquid glass remains
                            // above it, while 85% of the surface remains the
                            // darker green conversation stage.
                            .opacity(conversationControlBackgroundOpacity)
                    )
                }
                // Not .interactive(): the glass would expand slightly on
                // touch, which read as a duplicated, offset input outline
                // over the field's own edge. Focus already lifts the field
                // via the shadow and tint below.
                .glassEffect(
                    Glass.clear
                        .tint(
                            AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                                .opacity(
                                    composerFocused
                                        ? 0.065
                                        : conversationControlGlassTintOpacity
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
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        // Return can still reach the field while a response is streaming.
        // Preserve the owner's draft instead of clearing text that AppModel
        // will correctly refuse to send during an active turn.
        guard !text.isEmpty, !model.isSending else { return }
        draft = ""
        sendPreparedMessage(text, keepsComposerFocused: true)
    }

    private func sendPreset(_ rawText: String) {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !model.isSending else { return }
        sendPreparedMessage(text, keepsComposerFocused: false)
    }

    private func sendPreparedMessage(_ text: String, keepsComposerFocused: Bool) {
        sendFeedback += 1
        composerFocused = keepsComposerFocused
        requestScrollToBottom()
        model.send(text)
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
        if reduceTransparency {
            jumpToLatestLabel
                .foregroundStyle(AssistantTheme.stageStrong)
                .background(
                    AssistantTheme.stage(for: colorScheme, mood: model.latestMood),
                    in: Capsule()
                )
                .overlay {
                    Capsule().strokeBorder(
                        .white.opacity(colorSchemeContrast == .increased ? 0.5 : 0.28),
                        lineWidth: colorSchemeContrast == .increased ? 1.1 : 0.8
                    )
                }
                .shadow(color: Color(hex: 0x0C2D1B, alpha: 0.11), radius: 11, y: 5)
        } else if #available(iOS 26.0, *) {
            jumpToLatestLabel
                .foregroundStyle(AssistantTheme.stageStrong)
                .background {
                    Capsule().fill(
                        AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                            .opacity(conversationControlBackgroundOpacity)
                    )
                }
                .glassEffect(
                    Glass.regular
                        .tint(
                            AssistantTheme.stage(for: colorScheme, mood: model.latestMood)
                                .opacity(conversationControlGlassTintOpacity)
                        )
                        .interactive(),
                    in: Capsule()
                )
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

    /// A direct owner action is stronger than automatic transcript motion.
    /// Updating ScrollPosition cancels the ScrollView's active deceleration;
    /// the reader call targets the explicit spacer in the same non-animated
    /// transaction so the result is complete before the tap returns.
    private func jumpToLatestImmediately(using proxy: ScrollViewProxy) {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            transcriptScrollPosition.scrollTo(edge: .bottom)
            proxy.scrollTo("bottom", anchor: .bottom)
            isAtBottom = true
            hasUnseenMessages = false
        }
        // Edge positions are intentionally stable across later content-size
        // changes. Release it after this immediate command so streaming text
        // does not become permanently pinned to the bottom.
        DispatchQueue.main.async {
            transcriptScrollPosition = ScrollPosition()
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
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content
                .background(AssistantTheme.companionHousing, in: Capsule())
                .overlay {
                    Capsule().strokeBorder(.white.opacity(0.24), lineWidth: 0.8)
                }
        } else if #available(iOS 26.0, *) {
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
