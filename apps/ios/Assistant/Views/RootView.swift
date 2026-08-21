import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if model.isLoading && model.bootstrap == nil {
                launchView
                    .transition(.opacity)
            } else if model.bootstrap == nil {
                ConnectionView(isOnboarding: true)
                    .transition(.opacity)
            } else {
                NavigationStack { ChatView() }
                    .transition(.opacity)
            }
        }
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
        .sheet(item: $model.presentedRoute) { route in
            destination(for: route)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
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
        .overlay(alignment: .top) {
            if model.bootstrap != nil {
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
                    .offset(y: -ActivityCrown.foregroundLift)
                    .zIndex(100)
            }
        }
    }

    @ViewBuilder
    private func destination(for route: AssistantRoute) -> some View {
        NavigationStack {
            Group {
                switch route {
                case .chat: ChatView()
                case .chats: WorkspaceView(area: .chats)
                case .activity: ActivityView()
                case .goals: GoalsView()
                case .approvals: ApprovalsView()
                case .memory: WorkspaceView(area: .memory)
                case .documents: WorkspaceView(area: .documents)
                case .skills: WorkspaceView(area: .skills)
                case .settings: MoreView()
                case .costs: WorkspaceView(area: .costs)
                case .anomalies: WorkspaceView(area: .anomalies)
                case .improvements: WorkspaceView(area: .improvements)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        model.returnToChat()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                }
            }
        }
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
