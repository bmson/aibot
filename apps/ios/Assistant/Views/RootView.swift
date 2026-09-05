import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    // The launch screen belongs to the automatic connect at startup, not to a
    // connect the owner just triggered from the Connection form.
    @State private var hasPresentedConnection = false

    var body: some View {
        GeometryReader { geometry in
            rootContent(
                safeAreaTopInset: geometry.safeAreaInsets.top,
                safeAreaBottomInset: geometry.safeAreaInsets.bottom,
                safeAreaLeadingInset: geometry.safeAreaInsets.leading,
                safeAreaTrailingInset: geometry.safeAreaInsets.trailing,
                isLandscape: geometry.size.width > geometry.size.height
            )
        }
    }

    private func rootContent(
        safeAreaTopInset: CGFloat,
        safeAreaBottomInset: CGFloat,
        safeAreaLeadingInset: CGFloat,
        safeAreaTrailingInset: CGFloat,
        isLandscape: Bool
    ) -> some View {
        let islandTopInset = ActivityCrown.islandTopInset(
            safeAreaTopInset: safeAreaTopInset
        )

        return ZStack(alignment: .top) {
            // Establishes an edge-to-edge coordinate space for the crown.
            Color.clear
                .ignoresSafeArea(.container, edges: .top)
                .allowsHitTesting(false)

            Group {
                if model.isLoading && model.bootstrap == nil && !hasPresentedConnection {
                    launchView
                        .transition(.opacity)
                } else if model.bootstrap == nil {
                    // Deliberately survives `isLoading`: swapping this out for the
                    // launch screen mid-attempt destroyed the form, and the fresh
                    // instance that replaced it ran ConnectionView's `.onAppear` →
                    // `dismissError()`, wiping the failure before it could render.
                    // A failed "Save and connect" looked like nothing happening.
                    ConnectionView(isOnboarding: true)
                        .transition(.opacity)
                        .onAppear { hasPresentedConnection = true }
                } else {
                    NavigationStack(path: $model.navigationPath) {
                        ChatView(
                            safeAreaTopInset: safeAreaTopInset,
                            safeAreaBottomInset: safeAreaBottomInset,
                            safeAreaLeadingInset: safeAreaLeadingInset,
                            safeAreaTrailingInset: safeAreaTrailingInset
                        )
                            .navigationDestination(for: AssistantDestination.self) { screen in
                                switch screen {
                                case let .route(route):
                                    destination(
                                        for: route,
                                        safeAreaTopInset: safeAreaTopInset,
                                        safeAreaBottomInset: safeAreaBottomInset,
                                        safeAreaLeadingInset: safeAreaLeadingInset,
                                        safeAreaTrailingInset: safeAreaTrailingInset
                                    )
                                case let .person(id):
                                    PersonCardScreen(personId: id)
                                }
                            }
                    }
                        .transition(.opacity)
                }
            }

            if model.bootstrap != nil && model.navigationPath.isEmpty {
                ActivityCrown(
                    thought: model.activityThought,
                    detail: model.activityDetail,
                    agentName: model.agentName,
                    action: {
                        model.present(
                            model.activityThought?.tone == .waiting ? .approvals : .activity
                        )
                    }
                )
                // Portrait is the supported iPhone presentation. The compact
                // size-class branch remains defensive for previews/iPad and
                // attaches the crown to the hardware Island edge.
                .modifier(
                    ActivityCrownPlacement(
                        isLandscape: isLandscape,
                        islandTopInset: islandTopInset,
                        safeAreaLeadingInset: safeAreaLeadingInset,
                        safeAreaTrailingInset: safeAreaTrailingInset
                    )
                )
                .zIndex(100)
            }

            // Global error surface: an overlay inside ChatView never drew
            // above pushed destinations, so a failed approve/deny on the
            // Approvals page produced an error haptic with no message. The
            // banner belongs to the root, above whatever route is showing.
            // Gated on bootstrap so the onboarding Connection form keeps its
            // own inline error instead of doubling it.
            if model.bootstrap != nil, let error = model.errorMessage {
                let bannerTopInset = errorBannerTopInset(
                    safeAreaTopInset: safeAreaTopInset,
                    isLandscape: isLandscape
                )

                errorBanner(error)
                    .padding(.horizontal, 12)
                    .padding(.top, bannerTopInset)
                    // A standing banner has to move when the crown opens or
                    // closes beneath it. On the crown's own spring, so the two
                    // travel together rather than the banner snapping to its
                    // new seat a beat after the black surface has grown.
                    .animation(
                        reduceMotion ? nil : .spring(response: 0.42, dampingFraction: 0.82),
                        value: bannerTopInset
                    )
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .move(edge: .top).combined(with: .opacity)
                    )
                    .zIndex(99)
            }
        }
        // This is intentionally on the outer stack, not merely the clear
        // background. Otherwise the overlay begins below the notch's safe
        // area, leaving the visible green gap shown above the notification.
        .ignoresSafeArea(.container, edges: .top)
        // The assistant is an edge-to-edge workspace. Its own activity crown
        // handles the top interaction space, so the clock, signal, and battery
        // status bar would only compete with the app's chrome.
        .statusBarHidden(true)
        .animation(
            .easeOut(duration: reduceMotion ? 0.12 : 0.24),
            value: model.isLoading
        )
        .animation(
            .easeOut(duration: reduceMotion ? 0.12 : 0.24),
            value: model.bootstrap != nil
        )
        .animation(
            reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.86),
            value: model.errorMessage
        )
        .task {
            model.scenePhaseDidChange(scenePhase)
            if model.hasSavedConnection && model.bootstrap == nil { await model.connect() }
        }
        .onChange(of: scenePhase) { _, phase in
            model.scenePhaseDidChange(phase)
            if phase == .active, model.bootstrap != nil {
                Task {
                    await NotificationManager.shared.refreshAuthorizationStatus()
                    await NotificationManager.shared.registerForRemoteNotificationsIfAuthorized()
                    await model.refreshAll()
                    await model.reportForegroundActivity()
                    await model.shareLocationIfEnabled()
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { model.bootstrap != nil && model.showingConnection },
            set: { model.showingConnection = $0 }
        )) {
            NavigationStack {
                ConnectionView(isOnboarding: false, showsDoneButton: true)
            }
        }
        .onOpenURL { url in
            guard url.scheme == "assistant" else { return }
#if DEBUG
            if url.host == "live-preview" {
                model.previewActivitySequence()
                return
            }
            if url.host == "notification-preview" {
                Task { await NotificationManager.shared.schedulePreview() }
                return
            }
#endif
            if let route = AssistantRoute(rawValue: url.host ?? "") {
                model.present(route)
            } else {
                model.returnToChat()
            }
        }
        .onReceive(NotificationManager.shared.$pendingRoute.compactMap { $0 }) { route in
            model.present(route)
            NotificationManager.shared.consumePendingRoute()
        }
    }

    @ViewBuilder
    private func destination(
        for route: AssistantRoute,
        safeAreaTopInset: CGFloat,
        safeAreaBottomInset: CGFloat,
        safeAreaLeadingInset: CGFloat,
        safeAreaTrailingInset: CGFloat
    ) -> some View {
        Group {
            switch route {
            case .chat:
                ChatView(
                    safeAreaTopInset: safeAreaTopInset,
                    safeAreaBottomInset: safeAreaBottomInset,
                    safeAreaLeadingInset: safeAreaLeadingInset,
                    safeAreaTrailingInset: safeAreaTrailingInset
                )
            case .chats: WorkspaceView(area: .chats)
            case .activity: ActivityView()
            case .goals: GoalsView()
            case .approvals: ApprovalsView()
            case .cards: CardsView()
            case .memory: MemoryView()
            case .people: PeopleView()
            case .documents: WorkspaceView(area: .documents)
            case .skills: WorkspaceView(area: .skills)
            case .capabilities: WorkspaceView(area: .capabilities)
            case .settings: MoreView()
            case .costs: WorkspaceView(area: .costs)
            case .anomalies: WorkspaceView(area: .anomalies)
            case .improvements: WorkspaceView(area: .improvements)
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .tint(AssistantTheme.accent(for: colorScheme))
    }

    private func errorBannerTopInset(
        safeAreaTopInset: CGFloat,
        isLandscape: Bool
    ) -> CGFloat {
        if model.presentedRoute != nil {
            // The banner is a root overlay, so it must sit below the visible
            // route title instead of covering it. Horizontal routes have a
            // shorter navigation bar clearance than the portrait treatment.
            return safeAreaTopInset + (isLandscape ? 68 : 48)
        }
        if isLandscape {
            // The crown occupies a side rail in horizontal mode, so the
            // chat error can live in the top margin without competing for the
            // same vertical pixels.
            return safeAreaTopInset + 12
        }
        // The banner hangs in the root stack, which ignores the top safe area,
        // so this is measured from the physical top edge — and both states have
        // something to clear there. Expanded, it is the crown's own surface.
        // Idle, it is the hardware Dynamic Island: the crown paints nothing, but
        // the pill does not go away, and the flat 4pt this used to return put
        // the warning glyph and the first words of every error behind it.
        return ActivityCrown.overlayTopInset(
            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
            isExpanded: model.activityThought != nil,
            safeAreaTopInset: safeAreaTopInset
        )
    }

    private func errorBanner(_ text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .accessibilityHidden(true)
            Text(text)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            // Only transport failures carry a retry. A server that answered on
            // the merits would just answer the same way again.
            if let retry = model.errorRetry {
                Button {
                    // Dismiss first: a second failure then animates in as a new
                    // banner rather than silently replacing identical text.
                    model.dismissError()
                    Task { @MainActor in await retry() }
                } label: {
                    Text("Retry")
                        .font(.footnote.weight(.semibold))
                        .padding(.horizontal, 10)
                        .frame(height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(AssistantTactileButtonStyle(reduceMotion: reduceMotion))
                .accessibilityLabel("Retry")
            }
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

    private var launchView: some View {
        ZStack {
            AssistantTheme.canvas(for: colorScheme).ignoresSafeArea()

            RadialGradient(
                colors: [
                    AssistantTheme.accent(for: colorScheme).opacity(colorScheme == .dark ? 0.13 : 0.08),
                    .clear,
                ],
                center: .center,
                startRadius: 0,
                endRadius: 220
            )
            .ignoresSafeArea()

            VStack(spacing: 18) {
                Text("Waking your assistant")
                    .font(.headline)
                ProgressView().tint(AssistantTheme.accent(for: colorScheme))
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Waking your assistant")
        }
    }
}

private struct ActivityCrownPlacement: ViewModifier {
    let isLandscape: Bool
    let islandTopInset: CGFloat
    let safeAreaLeadingInset: CGFloat
    let safeAreaTrailingInset: CGFloat

    func body(content: Content) -> some View {
        if isLandscape {
            let islandOnLeadingEdge = safeAreaLeadingInset > safeAreaTrailingInset
            HStack(spacing: 0) {
                if islandOnLeadingEdge {
                    content
                    Spacer(minLength: 0)
                } else {
                    Spacer(minLength: 0)
                    content
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            .padding(.leading, islandOnLeadingEdge ? max(12, safeAreaLeadingInset - 4) : 12)
            .padding(.trailing, islandOnLeadingEdge ? 12 : max(12, safeAreaTrailingInset - 4))
            .padding(.vertical, 12)
        } else {
            content
                .padding(.top, islandTopInset)
        }
    }
}

struct CardsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if model.savedCards.isEmpty {
                    ContentUnavailableView(
                        "No active cards",
                        systemImage: "rectangle.stack",
                        description: Text("Ask about a booking, event, delivery, or score—or let the assistant notice one from connected mail.")
                    )
                    .frame(minHeight: 320)
                } else {
                    ForEach(model.savedCards) { card in
                        if let parsed = MessageResponseCard(part: card.messagePart) {
                            VStack(alignment: .leading, spacing: 0) {
                                RichResponseCards(cards: [parsed])
                                Divider()
                                    .padding(.horizontal, 16)
                                    .overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.12))
                                Button("Dismiss", systemImage: "archivebox") {
                                    Task { _ = await model.dismissCard(card) }
                                }
                                .font(.caption.weight(.medium))
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                .frame(maxWidth: .infinity, alignment: .trailing)
                                .padding(.horizontal, 16)
                                .frame(minHeight: 44)
                                .buttonStyle(.plain)
                            }
                            .background(
                                AssistantTheme.raised(for: colorScheme),
                                in: RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)
                            )
                            .overlay {
                                RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)
                                    .strokeBorder(AssistantTheme.ink(for: colorScheme).opacity(0.09), lineWidth: 0.8)
                            }
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: isLandscape ? 760 : .infinity, alignment: .leading)
        }
        .navigationTitle("Cards")
        .assistantSubmenuChrome()
        .refreshable { await model.refreshCards() }
        .task { await model.refreshCards() }
    }

    private var isLandscape: Bool { verticalSizeClass == .compact }
}
