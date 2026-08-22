import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    // The launch screen belongs to the automatic connect at startup, not to a
    // connect the owner just triggered from the Connection form.
    @State private var hasPresentedConnection = false

    var body: some View {
        GeometryReader { geometry in
            rootContent(safeAreaTopInset: geometry.safeAreaInsets.top)
        }
    }

    private func rootContent(safeAreaTopInset: CGFloat) -> some View {
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
                    NavigationStack {
                        ChatView(safeAreaTopInset: safeAreaTopInset)
                            .navigationDestination(item: $model.presentedRoute) { route in
                                destination(for: route, safeAreaTopInset: safeAreaTopInset)
                            }
                    }
                        .transition(.opacity)
                }
            }

            if model.bootstrap != nil && model.presentedRoute == nil {
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
                // Share the physical Island's top edge. The rounded active
                // surface surrounds the camera; idle leaves the pill alone.
                .padding(.top, islandTopInset)
                .zIndex(100)
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
        .task {
            if model.hasSavedConnection && model.bootstrap == nil { await model.connect() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, model.bootstrap != nil {
                Task {
                    await NotificationManager.shared.refreshAuthorizationStatus()
                    await model.refreshAll()
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
        safeAreaTopInset: CGFloat
    ) -> some View {
        Group {
            switch route {
            case .chat: ChatView(safeAreaTopInset: safeAreaTopInset)
            case .chats: WorkspaceView(area: .chats)
            case .activity: ActivityView()
            case .goals: GoalsView()
            case .approvals: ApprovalsView()
            case .memory: WorkspaceView(area: .memory)
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
                CompanionCapsule(presence: .working, face: .focused, name: "Assistant")
                    .scaleEffect(dynamicTypeSize.isAccessibilitySize ? 1 : 1.25)
                Text("Waking your assistant")
                    .font(.headline)
                ProgressView().tint(AssistantTheme.accent(for: colorScheme))
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Waking your assistant")
        }
    }
}
