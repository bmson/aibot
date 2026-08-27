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

/// The transcript's live scroll offset, deliberately held in a reference type
/// rather than in `@State`. Jump to latest needs the offset the instant it is
/// pressed, but storing a value that changes on every scrolled frame in view
/// state would re-evaluate the whole conversation at display rate.
///
/// The value is kept in content space — distance from the top of the content,
/// zero at rest against the crown clearance — because `ScrollPosition` offsets
/// the content insets itself, while `ScrollGeometry.contentOffset` does not.
private final class TranscriptScrollTracker {
    var contentPosition: CGFloat = 0
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
    // The directory labels need the same legibility as the content cards.
    // Scaling from subheadline keeps the two-column sheet readable before it
    // switches to the dedicated extra-large accessibility layout.
    @ScaledMetric(relativeTo: .subheadline) private var menuTileFontSize = 16.0
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
    // A direct "Jump to latest" owns the scroll position until it has had a
    // chance to supersede an automatic scroll that may already be in flight.
    @State private var latestJumpRequest = 0
    // Unpositioned by default so normal finger scrolling remains authoritative.
    // Jump to latest writes an explicit edge only for that owner action.
    @State private var transcriptScrollPosition = ScrollPosition()
    @State private var transcriptScroll = TranscriptScrollTracker()
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
    // `ComposerTextInput` owns a UIKit responder rather than a SwiftUI view
    // carrying `.focused`. A FocusState without that SwiftUI association is
    // reconciled back to its default on a body update, which resigns the text
    // view after each typed character. Keep this as ordinary view state and
    // let the UIKit delegate report real responder changes instead.
    @State private var composerFocused = false

    // The menu is a short, two-column directory rather than a tiny icon grid.
    // Its reveal follows the actual rows below so it still tracks the finger
    // when Dynamic Type gives each destination more breathing room.
    private var menuRevealHeight: CGFloat {
        26 + 4 + 11 + menuActionsHeight
    }

    private var menuActionsHeight: CGFloat {
        if usesExtraLargeAccessibilityMenu {
            return menuButtonHeight + 10 + menuAutonomyHeight
        }
        // Four navigation rows, two quiet group dividers, then the autonomy
        // setting at the bottom of the sheet.
        return (4 * menuButtonHeight) + 26 + 10 + menuAutonomyHeight
    }

    private var menuButtonHeight: CGFloat {
        if usesExtraLargeAccessibilityMenu { return 92 }
        return dynamicTypeSize.isAccessibilitySize ? 76 : 64
    }

    private var menuAutonomyHeight: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 58 : 50
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
                // green window backing show through its rounded corners.
                .background(stageBackdrop.ignoresSafeArea(.container))
                .clipShape(
                    RoundedRectangle(
                        cornerRadius: menuSheetCornerRadius * menuSurfaceProgress,
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
            // present, the stage above respects its safe area and pockets of
            // this backing show around the keyboard's rounded corners — keep
            // it the conversation's green so those pockets read as the stage
            // continuing, not a gray seam.
            AssistantTheme.stage(for: colorScheme)
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
        .onChange(of: model.restorableDraft) { _, restorable in
            // A failed send hands its text back — the composer shows the words
            // again instead of the owner retyping them.
            guard restorable != nil, let failed = model.restoreFailedDraft() else { return }
            draft = failed
        }
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
            AssistantTheme.stage(for: colorScheme)

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
                    // The composer is an overlay, so reserve its measured
                    // height only after the final message. This preserves the
                    // underlay while scrolling but lets the last card clear
                    // the input at the transcript's bottom edge.
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
            // A live transcript belongs at its newest edge. The briefing
            // cards are a dashboard, though, so their first card should be
            // the opening view rather than the prompt launcher at the end.
            .defaultScrollAnchor(
                model.messages.isEmpty ? .top : (pinsTranscriptToBottom ? .bottom : nil)
            )
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
            // Recorded outside view state on purpose — see
            // `TranscriptScrollTracker`. Jump to latest reads it to stop an
            // in-flight scroll exactly where the transcript currently sits.
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top
            } action: { _, position in
                transcriptScroll.contentPosition = position
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
            // Keep the transcript edge-to-edge and place the translucent
            // composer above it. Cards should remain scrollable beneath the
            // input instead of ending at an artificial bottom inset.
            .overlay(alignment: .bottom) {
                composer
                    // An overlay receives the scroll view's full height as a
                    // proposal. Keep the composer intrinsic before measuring
                    // it; otherwise that proposal can turn the end spacer
                    // into a whole blank transcript screen.
                    .fixedSize(horizontal: false, vertical: true)
                    .safeAreaPadding(.bottom)
                    .offset(y: menuPullActive ? menuPullComposerOffset : 0)
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
                        jumpToLatest(using: proxy)
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

    /// The correction above exists for the few points UIKit snaps the
    /// transcript when it cancels the pan at pull start — never for the much
    /// larger geometry drift of the keyboard leaving mid-pull. Unbounded,
    /// that excursion pushed the input below the fold or off the clipped
    /// sheet entirely and stretched the bubble-to-input gap.
    private var menuPullComposerOffset: CGFloat {
        min(max(menuPullTranscriptCompensation, -20), 20)
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
            userPrompt: model.messages[..<index].reversed().first(where: { $0.role == .user })?.text,
            isStreaming: message.id.hasPrefix("stream-") && model.isSending,
            openApprovals: { model.present(.approvals) },
            runForReal: model.isSending ? nil : { text in model.send(text, force: true) },
            retry: model.isSending ? nil : { text in model.send(text) },
            decideApproval: { id, decision in await model.decideApproval(id: id, decision: decision) }
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

    /// Corner radius the lifted conversation sheet rounds to at full reveal.
    private var menuSheetCornerRadius: CGFloat { 34 }

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
        let handleProgress = menuElementProgress(after: 0.08)
        let handleVisibility = menuVisibilityProgress(after: 0.08)
        let handleUnfurl = organicProgress(handleProgress)

        return VStack(spacing: 11) {
            // The handle advertises that this sheet can be dragged closed.
            // Its recognizer lives on the shared chat/menu container, so the
            // same downward swipe works from a destination or the chat sheet.
            // Its 10pt threshold leaves ordinary taps untouched.
            Capsule()
                .fill(AssistantTheme.ink(for: colorScheme).opacity(colorScheme == .dark ? 0.3 : 0.15))
                .frame(width: 42, height: 4)
                .scaleEffect(
                    x: reduceMotion ? 1 : 0.34 + (0.66 * handleUnfurl),
                    y: reduceMotion ? 1 : 1.7 - (0.7 * handleUnfurl),
                    anchor: .center
                )
                .opacity(handleVisibility)

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
            // The edge-to-edge conversation travels the reveal plus the
            // device's bottom inset, but this frame starts at the safe area —
            // without bleeding upward by the same inset (plus the sheet's
            // corner radius), the window backing showed through the band's
            // top strip and painted the sheet's rounded corners a wrong gray
            // instead of the menu's canvas.
            .padding(.top, -(deviceBottomSafeAreaInset + menuSheetCornerRadius))
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
            VStack(spacing: 10) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        pullMenuActionButtons
                    }
                    .scrollTargetLayout()
                }
                .contentMargins(.horizontal, 1, for: .scrollContent)
                .scrollTargetBehavior(.viewAligned)
                .scrollClipDisabled()

                menuAutonomyToggle
            }
        } else {
            VStack(spacing: 0) {
                pullMenuRow {
                    pullMenuButton("Chat", icon: "bubble.left", isSelected: true, index: 0) {
                        closePullMenu()
                    }
                    pullMenuButton("Activity", icon: "waveform.path.ecg", index: 1) {
                        openRoute(.activity)
                    }
                }
                pullMenuRow {
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
                }

                pullMenuDivider

                pullMenuRow {
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
                }
                pullMenuRow {
                    pullMenuButton("Capabilities", icon: "puzzlepiece.extension", index: 6) {
                        openRoute(.capabilities)
                    }
                    pullMenuButton("More", icon: "ellipsis", index: 7) {
                        openRoute(.settings)
                    }
                }

                pullMenuDivider
                menuAutonomyToggle
            }
        }
    }

    private func pullMenuRow<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(spacing: 8) {
            content()
        }
    }

    private var pullMenuDivider: some View {
        Divider()
            .overlay(AssistantTheme.ink(for: colorScheme).opacity(colorScheme == .dark ? 0.14 : 0.09))
            .padding(.vertical, 6)
    }

    // Eight primary destinations. The lower-traffic areas (Documents, Skills,
    // Costs, Anomalies, Improvements) live under More, keeping this directory
    // focused on the routes people revisit during a conversation.
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
            HStack(spacing: 12) {
                Text("Auto next")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                Spacer(minLength: 12)
                Capsule()
                    .fill(
                        model.nextMessageAutonomous
                            ? AssistantTheme.accent
                            : AssistantTheme.sunken(for: colorScheme)
                    )
                    .frame(width: 50, height: 30)
                    .overlay(alignment: model.nextMessageAutonomous ? .trailing : .leading) {
                        Circle()
                            .fill(AssistantTheme.dashboardPaper(for: colorScheme))
                            .frame(width: 24, height: 24)
                            .padding(3)
                            .shadow(color: .black.opacity(0.1), radius: 2, y: 1)
                    }
            }
            .frame(maxWidth: .infinity, minHeight: menuAutonomyHeight, alignment: .leading)
            .contentShape(Rectangle())
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
        // Opacity only: the tiles used to also rise 24pt while fading in,
        // which — uncovered progressively by the lifting sheet — read as the
        // items stretching. The staggered fade keeps the cascade on its own.
        let visibility = menuVisibilityProgress(after: 0.18 + (CGFloat(index) * 0.045))

        return Button(action: action) {
            pullMenuButtonSurface(isSelected: isSelected) {
                HStack(spacing: 12) {
                    Image(systemName: icon)
                        .font(
                            usesExtraLargeAccessibilityMenu
                                ? .headline.weight(.semibold)
                                : .subheadline.weight(.semibold)
                        )
                        // A fixed square slot preserves the same breathing
                        // room around every SF Symbol, including asymmetric
                        // marks such as `ellipsis` and `scope`.
                        .frame(width: 32, height: 32)
                    Text(title)
                        .font(
                            usesExtraLargeAccessibilityMenu
                                ? .subheadline.weight(.semibold)
                                : .system(size: menuTileFontSize, weight: .semibold, design: .rounded)
                        )
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Spacer(minLength: 0)
                    if badge > 0 {
                        Text(badge > 99 ? "99+" : "\(badge)")
                            .font(.system(size: menuBadgeFontSize, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .frame(minWidth: 24, minHeight: 22)
                            .background(AssistantTheme.notificationBadge, in: Capsule())
                            .accessibilityHidden(true)
                    }
                }
                .foregroundStyle(
                    isSelected ? AssistantTheme.accent(for: colorScheme) : AssistantTheme.ink(for: colorScheme)
                )
                .padding(.horizontal, 12)
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
        let shape = RoundedRectangle(cornerRadius: 17, style: .continuous)
        // This is just one ink wash over the menu canvas: enough to group the
        // current destination, without introducing a second green surface.
        let selectedFill = AssistantTheme.ink(for: colorScheme)
            .opacity(colorScheme == .dark ? 0.14 : 0.055)

        content()
            // The current item is slightly grayer than the paper-like sheet;
            // its green icon and label remain the unmistakable active cue.
            .background(
                isSelected ? selectedFill : Color.clear,
                in: shape
            )
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
        ChatDashboard(
            agentName: model.agentName,
            overview: model.overview,
            pendingApprovalCount: model.pendingApprovalCount,
            needsAttentionCount: model.needsAttentionCount,
            isSending: model.isSending,
            onRoute: openRoute,
            onPrompt: sendPreset
        )
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if !model.latestQuickReplies.isEmpty && !composerFocused && !model.isSending {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.latestQuickReplies, id: \.self) { reply in
                            Button {
                                sendPreset(reply)
                            } label: {
                                Text(reply)
                                    .font(.footnote.weight(.medium))
                                    // Suggestions are offered text, not
                                    // active input. Keep their copy at the
                                    // same neutral 50% white as the prompt
                                    // without dimming the glass surface too.
                                    .foregroundStyle(Color.white.opacity(0.5))
                                    .padding(.horizontal, 14)
                                    .frame(height: 36)
                                    .modifier(
                                        QuickReplySurface(
                                            backgroundOpacity: conversationControlBackgroundOpacity,
                                            glassTintOpacity: conversationControlGlassTintOpacity
                                        )
                                    )
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
                // The input owns the upward pull that reveals navigation.
                // A clearly downward swipe while it is focused means the
                // opposite: get the keyboard out of the way. Keep this
                // simultaneous so typing, cursor placement, and the pull do
                // not lose their native gesture handling.
                .simultaneousGesture(composerKeyboardDismissGesture)
        }
        // The caret and the ready send button are the only surfaces a [theme:]
        // cue moves, so the mood glides here rather than behind the transcript.
        // 0.6s matches the web client's scoped --accent transition.
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.6), value: model.latestMood)
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .background {
            LinearGradient(
                colors: [
                    .clear,
                    AssistantTheme.stage(for: colorScheme).opacity(0.03),
                    AssistantTheme.stage(for: colorScheme).opacity(0.12),
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

    private var composerKeyboardDismissGesture: some Gesture {
        DragGesture(minimumDistance: PullMenuMotion.verticalIntentDistance)
            .onChanged { value in
                guard composerFocused,
                      PullMenuMotion.hasClosingIntent(
                        translationX: value.translation.width,
                        translationY: value.translation.height
                      )
                else { return }

                composerFocused = false
            }
    }

    private var composerInput: some View {
        composerInputSurface {
            HStack(alignment: .bottom, spacing: 8) {
                if model.nextMessageAutonomous {
                    // Auto mode lives inside the field as a leading affordance
                    // — the pill above the composer read as a separate banner
                    // detached from the message it affects. Tap to cancel.
                    Button {
                        model.nextMessageAutonomous = false
                    } label: {
                        Image(systemName: "bolt.shield.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(AssistantTheme.stageWarningInk)
                            .frame(width: 30, height: 30)
                            .background(AssistantTheme.stageWarningSurface.opacity(0.94), in: Circle())
                            .overlay {
                                Circle().strokeBorder(.white.opacity(0.32), lineWidth: 0.7)
                            }
                    }
                    .buttonStyle(.plain)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
                    .padding(.leading, 6)
                    .accessibilityLabel("Auto mode for the next message")
                    .accessibilityHint("Sensitive steps still ask, and budget caps still apply. Activating turns auto mode off.")
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                }

                ComposerTextInput(
                    text: $draft,
                    isFocused: Binding(
                        get: { composerFocused },
                        set: { composerFocused = $0 }
                    ),
                    prompt: composerPrompt,
                    fontSize: composerFontSize,
                    textColor: .white,
                    placeholderColor: UIColor(composerPlaceholderColor),
                    cursorColor: UIColor(composerCursorColor),
                    completionColor: UIColor.white.withAlphaComponent(0.5),
                    onSubmit: sendDraft
                )
                    .padding(.leading, 6)
                    .padding(.vertical, 10)
                    .frame(minHeight: 44, alignment: .leading)
                    .layoutPriority(1)
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
                        model.isSending
                            ? AssistantTheme.stageDepth
                            : (canSend ? AssistantTheme.accent : composerPlaceholderColor)
                    )
                    .frame(width: 44, height: 44)
                    .background(
                        // Readiness is a state change, not a dimmed copy: with
                        // nothing to send the button sits back in the well; a
                        // typed draft lifts it to the solid fill that reads as
                        // the one bright object on the stage. Its arrow takes
                        // the brand green so the white circle stays connected
                        // to the rest of the conversation controls.
                        (canSend && !model.isSending ? sendReadyFill : AssistantTheme.raised(for: colorScheme))
                            .opacity(model.isSending ? 0.28 : (!canSend ? 0.06 : 1)),
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
        // Auxiliary composer marks (the stop affordance and its rim) use the
        // warm conversation white. The editable text itself is true white so
        // its app-owned inline completion can read at an exact 50% opacity.
        AssistantTheme.stageStrong
    }

    private var composerPrompt: String {
        // Short enough to survive the narrowest phones without truncating.
        model.isSending ? "Working — keep typing" : "Ask anything…"
    }

    private var composerPlaceholderColor: Color {
        // The hint belongs to the translucent stage, so it uses neutral white
        // rather than the muted ink reserved for paper cards.
        Color.white.opacity(0.5)
    }

    /// The ready send button's fill — the one bright object on the stage. With
    /// no cue active this stays the warm white it has always been.
    private var sendReadyFill: Color {
        model.latestMood == .default
            ? AssistantTheme.stageStrong
            : AssistantTheme.chatAccent(mood: model.latestMood)
    }

    private var composerCursorColor: Color {
        colorSchemeContrast == .increased
            ? AssistantTheme.stageStrong
            : AssistantTheme.chatAccent(mood: model.latestMood)
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
                    AssistantTheme.stage(for: colorScheme),
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
                        AssistantTheme.stage(for: colorScheme)
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
                            AssistantTheme.stage(for: colorScheme)
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
                            AssistantTheme.stage(for: colorScheme)
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
        // Visibility tracks the scroll position only. Gating on
        // `errorMessage` let any transient failure — including a non-fatal
        // overview refresh — hide the button for as long as the unrelated
        // banner stayed up, which is why it was sometimes missing.
        !isAtBottom
            && !model.messages.isEmpty
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
                    AssistantTheme.stage(for: colorScheme),
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
                        AssistantTheme.stage(for: colorScheme)
                            .opacity(conversationControlBackgroundOpacity)
                    )
                }
                .glassEffect(
                    // Glass.clear, matching the composer: .regular laid a
                    // milky material over the 0.85 stage fill and read as a
                    // solid green pill next to the input's liquid glass.
                    Glass.clear
                        .tint(
                            AssistantTheme.stage(for: colorScheme)
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
                                AssistantTheme.stage(for: colorScheme)
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
            // momentum is deferred until the movement settles, which reads as
            // a stalled transcript. Snap immediately instead — that interrupts
            // the momentum and lands on the latest message. A pressed Jump to
            // latest wants the same takeover with its motion kept, so it goes
            // through `jumpToLatest(using:)` rather than this automatic path.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
    }

    /// A direct owner action outranks any transcript motion already under way.
    /// A momentum fling, a reveal animation for a newly arrived message, an
    /// earlier jump still playing out — the press takes all of them over rather
    /// than queueing behind them, then animates down to the newest message.
    ///
    /// The takeover is two commands in two run loops on purpose. Landing on the
    /// offset the transcript currently occupies, with animations off, resolves
    /// whatever scroll is in flight on the spot; the animated command that
    /// follows then starts from rest and owns the trip to the bottom. Issued in
    /// one pass, SwiftUI would coalesce them and the older motion would keep
    /// running — which is exactly what made the button feel dead mid-scroll.
    private func jumpToLatest(using proxy: ScrollViewProxy) {
        latestJumpRequest &+= 1
        let request = latestJumpRequest
        hasUnseenMessages = false
        stopTranscriptScroll()

        DispatchQueue.main.async {
            // A subsequent press owns the destination, never a stale tap.
            guard request == latestJumpRequest else { return }
            animateTranscriptToLatest(using: proxy) {
                // Edge positions stay active as content changes. Release the
                // override once the reader has landed, so later streaming text
                // does not permanently pin the transcript to its bottom.
                guard request == latestJumpRequest else { return }
                transcriptScrollPosition = ScrollPosition()
            }
        }
    }

    /// Ends an in-flight scroll by committing the transcript to where it
    /// already is. An unanimated point assignment cancels both a SwiftUI scroll
    /// animation and any UIScrollView deceleration underneath it.
    private func stopTranscriptScroll() {
        guard transcriptScrollPhase != .idle else { return }
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            transcriptScrollPosition.scrollTo(y: transcriptScroll.contentPosition)
        }
    }

    private func animateTranscriptToLatest(
        using proxy: ScrollViewProxy,
        completion: @escaping () -> Void
    ) {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.3, extraBounce: 0)) {
            transcriptScrollPosition.scrollTo(edge: .bottom)
            proxy.scrollTo("bottom", anchor: .bottom)
        } completion: {
            completion()
        }
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isSending
    }

    private func startsRun(at index: Int) -> Bool {
        index == 0 || model.messages[index - 1].role != model.messages[index].role
    }

}

/// A small UIKit bridge gives the composer ownership of the inline-completion
/// layer. Apple's stock prediction glyph is always system gray; rendering our
/// own suffix lets it retain the same white-at-50% treatment as the prompt.
private struct ComposerTextInput: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool

    let prompt: String
    let fontSize: CGFloat
    let textColor: UIColor
    let placeholderColor: UIColor
    let cursorColor: UIColor
    let completionColor: UIColor
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> InlineCompletionTextView {
        let textView = InlineCompletionTextView()
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.isOpaque = false
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.autocapitalizationType = .sentences
        textView.autocorrectionType = .yes
        textView.spellCheckingType = .yes
        textView.returnKeyType = .send
        textView.enablesReturnKeyAutomatically = false
        textView.isScrollEnabled = false
        textView.inlinePredictionType = .no
        textView.accessibilityIdentifier = "assistant.chat.composer"
        applyConfiguration(to: textView)
        return textView
    }

    func updateUIView(_ textView: InlineCompletionTextView, context: Context) {
        context.coordinator.parent = self
        applyConfiguration(to: textView)

        if textView.text != text {
            textView.text = text
            textView.refreshInlineCompletion()
        }

        if isFocused, !textView.isFirstResponder, textView.window != nil {
            textView.becomeFirstResponder()
        } else if !isFocused, textView.isFirstResponder {
            textView.resignFirstResponder()
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView textView: InlineCompletionTextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }

        let fittingSize = textView.sizeThatFits(
            CGSize(width: width, height: .greatestFiniteMagnitude)
        )
        let lineHeight = textView.font?.lineHeight ?? UIFont.systemFont(ofSize: fontSize).lineHeight
        let maximumHeight = (lineHeight * 6) + textView.textContainerInset.top + textView.textContainerInset.bottom
        let height = min(max(fittingSize.height, lineHeight), maximumHeight)
        textView.isScrollEnabled = fittingSize.height > maximumHeight
        return CGSize(width: width, height: ceil(height))
    }

    private func applyConfiguration(to textView: InlineCompletionTextView) {
        let font = UIFont.systemFont(ofSize: fontSize, weight: .regular)
        textView.font = font
        textView.textColor = textColor
        textView.tintColor = cursorColor
        textView.placeholderText = prompt
        textView.placeholderColor = placeholderColor
        textView.completionColor = completionColor
        textView.accessibilityLabel = prompt
        textView.refreshInlineCompletion()
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextInput

        init(parent: ComposerTextInput) {
            self.parent = parent
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.isFocused = true
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            parent.isFocused = false
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            (textView as? InlineCompletionTextView)?.refreshInlineCompletion()
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            (textView as? InlineCompletionTextView)?.refreshInlineCompletion()
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText replacement: String
        ) -> Bool {
            guard replacement == "\n" else { return true }
            parent.onSubmit()
            return false
        }
    }
}

private final class InlineCompletionTextView: UITextView {
    var placeholderText = "" {
        didSet { placeholderLabel.text = placeholderText }
    }
    var placeholderColor: UIColor = .secondaryLabel {
        didSet { placeholderLabel.textColor = placeholderColor }
    }
    var completionColor: UIColor = UIColor.white.withAlphaComponent(0.5) {
        didSet { completionLabel.textColor = completionColor }
    }

    private let placeholderLabel = UILabel()
    private let completionLabel = UILabel()
    private let checker = UITextChecker()

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)

        placeholderLabel.numberOfLines = 1
        placeholderLabel.lineBreakMode = .byTruncatingTail
        placeholderLabel.isAccessibilityElement = false
        addSubview(placeholderLabel)

        completionLabel.numberOfLines = 1
        completionLabel.isAccessibilityElement = false
        completionLabel.isUserInteractionEnabled = false
        addSubview(completionLabel)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override var text: String! {
        didSet {
            placeholderLabel.isHidden = !text.isEmpty
            refreshInlineCompletion()
        }
    }

    override var font: UIFont? {
        didSet {
            placeholderLabel.font = font
            completionLabel.font = font
            setNeedsLayout()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        let inset = textContainerInset
        let leading = inset.left + textContainer.lineFragmentPadding
        placeholderLabel.frame = CGRect(
            x: leading,
            y: inset.top,
            width: max(0, bounds.width - leading - inset.right - textContainer.lineFragmentPadding),
            height: font?.lineHeight ?? 0
        )
        refreshInlineCompletion()
    }

    func refreshInlineCompletion() {
        placeholderLabel.isHidden = !text.isEmpty

        guard let suffix = suggestedCompletionSuffix(), !suffix.isEmpty else {
            completionLabel.isHidden = true
            return
        }

        let endOfText = endOfDocument
        let caret = caretRect(for: endOfText)
        guard caret != .zero else {
            completionLabel.isHidden = true
            return
        }

        completionLabel.text = suffix
        completionLabel.sizeToFit()
        let availableWidth = bounds.maxX - textContainerInset.right - caret.maxX
        guard completionLabel.bounds.width <= availableWidth else {
            completionLabel.isHidden = true
            return
        }

        completionLabel.frame.origin = CGPoint(
            x: caret.maxX,
            y: caret.midY - (completionLabel.bounds.height / 2)
        )
        completionLabel.isHidden = false
    }

    private func suggestedCompletionSuffix() -> String? {
        let currentText = text ?? ""
        let length = (currentText as NSString).length
        guard selectedRange.length == 0, selectedRange.location == length, length > 1 else {
            return nil
        }

        let source = currentText as NSString
        let wordCharacters = CharacterSet.letters.union(.decimalDigits)
        var start = length
        while start > 0 {
            guard let scalar = UnicodeScalar(source.character(at: start - 1)), wordCharacters.contains(scalar)
            else { break }
            start -= 1
        }

        let partialRange = NSRange(location: start, length: length - start)
        guard partialRange.length >= 2 else { return nil }

        let partial = source.substring(with: partialRange)
        let keyboardLanguage = (textInputMode?.primaryLanguage ?? Locale.current.identifier)
            .replacingOccurrences(of: "-", with: "_")
        let language = UITextChecker.availableLanguages.contains(keyboardLanguage)
            ? keyboardLanguage
            : (UITextChecker.availableLanguages.first(where: { $0.hasPrefix("en") }) ?? "en_US")
        let completions = checker.completions(
            forPartialWordRange: partialRange,
            in: currentText,
            language: language
        ) ?? []

        guard let completion = completions.first(where: {
            $0.range(of: partial, options: [.anchored, .caseInsensitive]) != nil
                && $0.count > partial.count
        }), let prefixRange = completion.range(
            of: partial,
            options: [.anchored, .caseInsensitive]
        )
        else { return nil }

        return String(completion[prefixRange.upperBound...])
    }
}

private struct QuickReplySurface: ViewModifier {
    let backgroundOpacity: Double
    let glassTintOpacity: Double

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast

    @ViewBuilder
    func body(content: Content) -> some View {
        let shape = Capsule()
        let stage = AssistantTheme.stage(for: colorScheme)
        let rimOpacity = colorSchemeContrast == .increased ? 0.5 : 0.28
        let rimWidth = colorSchemeContrast == .increased ? 1.1 : 0.8

        if reduceTransparency {
            content
                .background(stage, in: shape)
                .overlay {
                    shape.strokeBorder(.white.opacity(rimOpacity), lineWidth: rimWidth)
                }
                .shadow(color: Color(hex: 0x0C2D1B, alpha: 0.11), radius: 11, y: 5)
        } else if #available(iOS 26.0, *) {
            content
                // Match Jump to latest exactly: each suggestion sits on the
                // same stage-backed Liquid Glass, so moving paper cards never
                // make it read as an unanchored, fading label.
                .background(stage.opacity(backgroundOpacity), in: shape)
                .glassEffect(
                    Glass.clear
                        .tint(stage.opacity(glassTintOpacity))
                        .interactive(),
                    in: shape
                )
                .shadow(color: Color(hex: 0x0C2D1B, alpha: 0.11), radius: 11, y: 5)
        } else {
            content
                .background {
                    shape
                        .fill(.ultraThinMaterial)
                        .overlay {
                            shape.fill(stage.opacity(backgroundOpacity))
                        }
                }
                .overlay {
                    shape.strokeBorder(.white.opacity(rimOpacity), lineWidth: rimWidth)
                }
                .shadow(color: Color(hex: 0x0C2D1B, alpha: 0.11), radius: 11, y: 5)
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
