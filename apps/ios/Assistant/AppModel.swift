import Foundation
import SwiftUI
import UIKit

enum AssistantRoute: String, Hashable, Identifiable, CaseIterable {
    case chat
    case chats
    case activity
    case goals
    case approvals
    case cards
    case memory
    case documents
    case skills
    case capabilities
    case settings
    case costs
    case anomalies
    case improvements

    var id: Self { self }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var presentedRoute: AssistantRoute?
    @Published private(set) var bootstrap: BootstrapResponse?
    @Published private(set) var overview: OverviewResponse?
    @Published private(set) var archivedActivity: ActivityList?
    @Published private(set) var archivedGoals: GoalsDashboard?
    @Published private(set) var workspace: WorkspaceResponse?
    @Published private(set) var memoryReviewCount = 0
    @Published private(set) var mcpConnections: [McpConnection] = []
    @Published private(set) var savedCards: [SavedCardRecord] = []
    @Published private(set) var activeConversation: ConversationView?
    @Published private(set) var personProfiles: [String: PersonProfileResponse] = [:]
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isSending = false
    @Published private(set) var toolActivity: [ToolActivity] = []
    @Published private(set) var activityThought: AssistantThought?
    @Published private(set) var activityDetail: String?
    @Published var errorMessage: String?
    /// Text of a turn that failed to send, handed back to the composer so the
    /// words are never lost to a network or server failure. ChatView consumes it.
    @Published private(set) var restorableDraft: String?
    @Published var showingConnection = false
    /// One-shot intent shared by every user-facing way to send a message,
    /// including quick replies and document shortcuts.
    @Published var nextMessageAutonomous = false
    @Published private(set) var hasSavedConnection: Bool

    private(set) var serverURL: String
    private var client: APIClient?
    private var cursor: String?
    /// Sequence for the rendered log. A merge can only add or replace by id —
    /// where a message belongs is decided here, once per id.
    private var logOrder = ChatLogOrder()
    private var pollTask: Task<Void, Never>?
    private var idleTask: Task<Void, Never>?
    /// Idle polling is an in-app freshness affordance, never background work.
    /// Scene transitions cancel it so the OS can suspend the app cleanly and
    /// we do not wake the server while the owner cannot see a response.
    private var isSceneActive = true
    private var thoughtClearTask: Task<Void, Never>?
    private var lastNotifiedTaskState: String?

    private let defaults = UserDefaults.standard
    private let serverKey = "assistant.server-url"
    private let configuredKey = "assistant.connection-configured"
    /// More → Assistant context owns this toggle; the model only reads it.
    static let shareLocationKey = "assistant.share-location"
    /// The background-arrival toggle; LocationManager owns the monitoring.
    static let shareLocationBackgroundKey = "assistant.share-location-background"
    /// One-time notification ask after a successful pairing (APNs opt-in).
    private let pushPromptedKey = "assistant.push-prompted"
    private var lastLocationPostAt: Date?
    private var lastForegroundReportAt: Date?

    init() {
        serverURL = defaults.string(forKey: serverKey) ?? "http://localhost:3000"
        hasSavedConnection = defaults.bool(forKey: configuredKey)
        if let configuration = try? Self.configuration(urlString: serverURL, token: KeychainStore.readToken()) {
            client = APIClient(configuration: configuration)
        }
        // RootView's `.task` starts the automatic connect after the first
        // render. Without seeding this, that render fell through to the
        // Connection form, whose appearance latched `hasPresentedConnection`
        // and barred the launch screen for the whole round-trip — a saved
        // pairing saw the login page before landing on the conversation.
        isLoading = hasSavedConnection && client != nil
        // Approve/Deny straight from a notification. The handler goes through
        // the same client call as the in-app buttons, then refreshes so the
        // badge and the Approvals sheet agree with the server.
        NotificationManager.shared.approvalDecisionHandler = { [weak self] approvalId, decision in
            guard let self else { return }
            _ = await self.decideApproval(id: approvalId, decision: decision)
        }
        // APNs token upload for proactive pushes. A rotation re-fires this;
        // a failure is retried on the next launch's registration callback.
        NotificationManager.shared.deviceTokenHandler = { [weak self] token in
            guard let client = self?.client else { throw APIError.invalidResponse }
            try await client.postDeviceToken(DeviceTokenBody(token: token))
        }
        // Background arrival pings (significant-change wakes). Best-effort —
        // the server's arrival gate decides whether a nudge is warranted.
        LocationManager.shared.backgroundHandler = { [weak self] location, label in
            guard let client = self?.client else { return }
            try? await client.postLocationPing(LocationPingBody(
                lat: location.coordinate.latitude,
                lng: location.coordinate.longitude,
                label: label,
                accuracyM: location.horizontalAccuracy >= 0
                    ? Int(location.horizontalAccuracy.rounded())
                    : nil,
                capturedAt: ISO8601DateFormatter().string(from: location.timestamp),
                timeZone: TimeZone.current.identifier,
                source: "ios-app-background"
            ))
        }
    }

    deinit {
        pollTask?.cancel()
        idleTask?.cancel()
        thoughtClearTask?.cancel()
    }

    var agentName: String { bootstrap?.identity.name ?? "Assistant" }
    var presence: AssistantPresence {
        if isSending { return .working }
        return bootstrap?.shell.dashboard.presence ?? .idle
    }
    var pendingApprovalCount: Int {
        overview?.approvals.pending.count ?? bootstrap?.shell.dashboard.pendingApprovals ?? 0
    }
    var needsAttentionCount: Int { bootstrap?.shell.dashboard.needsAttention ?? 0 }
    var conversationId: String? {
        activeConversation?.conversation.id ?? bootstrap?.conversation.conversation.id
    }
    var latestMood: CompanionMood { CompanionMood.latest(in: messages) }
    var latestQuickReplies: [String] {
        messages.reversed().first(where: { $0.role == .assistant })?.quickReplies ?? []
    }

    func present(_ route: AssistantRoute) {
        if route == .chat {
            returnToChat()
        } else {
            presentedRoute = route
        }
    }

    func returnToChat() {
        presentedRoute = nil
    }

    func knowledge(query: String = "", kind: String = "", page: Int = 1) async -> KnowledgeOverview? {
        guard let client else { return nil }
        do { return try await client.knowledge(query: query, kind: kind, page: page) }
        catch { errorMessage = error.localizedDescription; return nil }
    }

    func knowledgeItem(id: String) async -> KnowledgeOverview? {
        guard let client else { return nil }
        do { return try await client.knowledgeItem(id: id) }
        catch { errorMessage = error.localizedDescription; return nil }
    }

    func knowledgeReview() async -> KnowledgeReviewInbox? {
        guard let client else { return nil }
        do { return try await client.knowledgeReview() }
        catch { errorMessage = error.localizedDescription; return nil }
    }

    func knowledgeCleanup() async -> KnowledgeCleanupResponse? {
        guard let client else { return nil }
        do { return try await client.knowledgeCleanup() }
        catch { errorMessage = error.localizedDescription; return nil }
    }

    func resolveKnowledgeCleanup(action: String, memoryId: String? = nil) async -> Bool {
        guard let client else { return false }
        do { try await client.resolveKnowledgeCleanup(action: action, memoryId: memoryId); return true }
        catch { errorMessage = error.localizedDescription; return false }
    }

    func knowledgeSourceImpact(id: String) async -> KnowledgeSourceImpact? {
        guard let client else { return nil }
        do { return try await client.knowledgeSourceImpact(id: id) }
        catch { errorMessage = error.localizedDescription; return nil }
    }

    func forgetKnowledgeSource(id: String) async -> Bool {
        guard let client else { return false }
        do { try await client.forgetKnowledgeSource(id: id); return true }
        catch { errorMessage = error.localizedDescription; return false }
    }

    func createKnowledgeConnection(_ mutation: KnowledgeConnectionMutation) async -> Bool {
        guard let client else { return false }
        do { try await client.createKnowledgeConnection(mutation); return true }
        catch { errorMessage = error.localizedDescription; return false }
    }

    func reviewKnowledgeRelation(id: String, approve: Bool) async -> Bool {
        guard let client else { return false }
        do { try await client.reviewKnowledgeRelation(id: id, approve: approve); return true }
        catch { errorMessage = error.localizedDescription; return false }
    }

    func correctKnowledgeRelation(id: String, mutation: KnowledgeConnectionMutation) async -> Bool {
        guard let client else { return false }
        do { try await client.correctKnowledgeRelation(id: id, mutation: mutation); return true }
        catch { errorMessage = error.localizedDescription; return false }
    }

    func updateKnowledgeItem(id: String, action: String, value: String) async -> Bool {
        guard let client else { return false }
        do { try await client.updateKnowledgeItem(id: id, action: action, value: value); return true }
        catch { errorMessage = error.localizedDescription; return false }
    }

    func mergeKnowledgeItem(id: String, targetId: String) async -> Bool {
        guard let client else { return false }
        do { try await client.mergeKnowledgeItem(id: id, targetId: targetId); return true }
        catch { errorMessage = error.localizedDescription; return false }
    }

    func connect() async {
        guard let client else {
            showingConnection = true
            return
        }
        isLoading = true
        errorMessage = nil
        do {
            // Bootstrap alone decides whether the pairing is usable: it carries
            // the identity and the conversation the app opens onto, and it is
            // what `bootstrap != nil` gates entry on. Overview is supplementary
            // — approvals, activity, goals — and fetching both in one
            // `try await` meant a single failing dashboard query rejected an
            // otherwise valid connection outright.
            apply(try await client.bootstrap())
            hasSavedConnection = true
            defaults.set(true, forKey: configuredKey)

            do {
                overview = try await client.overview()
            } catch {
                // Non-fatal: the app is connected and usable, the dashboard
                // sections are just empty. Surfacing it keeps the failure
                // visible instead of presenting stale counts as current.
                errorMessage = error.localizedDescription
            }

            await reconcileBaselineActivity()
            await syncNotificationBadge()
            if isSceneActive { startIdlePolling() }
            await shareLocationIfEnabled(force: true)

            // Proactive outreach needs a way to reach the phone: ask for
            // notification permission once, right after a pairing succeeds,
            // and register with APNs whenever permission exists.
            let notifications = NotificationManager.shared
            if notifications.authorizationStatus == .notDetermined,
               !defaults.bool(forKey: pushPromptedKey) {
                defaults.set(true, forKey: pushPromptedKey)
                await notifications.requestAuthorization()
            }
            await notifications.registerForRemoteNotificationsIfAuthorized()
            await reportForegroundActivity()
        } catch {
            errorMessage = error.localizedDescription
            if bootstrap == nil { showingConnection = true }
        }
        isLoading = false
    }

    /// The "woke up" signal the server's wake-up brief listens for. Throttled
    /// so rapid background/foreground flips stay one cheap POST; the real
    /// dedupe (once per morning) lives server-side.
    func reportForegroundActivity() async {
        guard bootstrap != nil else { return }
        if let last = lastForegroundReportAt, Date().timeIntervalSince(last) < 30 * 60 { return }
        lastForegroundReportAt = Date()
        try? await client?.postForegroundActivity()
    }

    /// Sends the phone's current position (and clock zone) to the owner's own
    /// server for the ambient prompt line. Entirely owner-gated in More →
    /// Assistant context, off by default, and throttled so foregrounding the
    /// app refreshes context without turning the radio into a tracker.
    func shareLocationIfEnabled(force: Bool = false) async {
        guard defaults.bool(forKey: Self.shareLocationKey), let client else { return }
        if !force,
           let last = lastLocationPostAt,
           Date().timeIntervalSince(last) < 15 * 60 { return }
        guard let place = await LocationManager.shared.captureCurrentPlace() else { return }
        let ping = LocationPingBody(
            lat: place.location.coordinate.latitude,
            lng: place.location.coordinate.longitude,
            label: place.label,
            accuracyM: place.location.horizontalAccuracy >= 0
                ? Int(place.location.horizontalAccuracy.rounded())
                : nil,
            capturedAt: ISO8601DateFormatter().string(from: place.location.timestamp),
            timeZone: TimeZone.current.identifier,
            source: "ios-app"
        )
        do {
            try await client.postLocationPing(ping)
            lastLocationPostAt = Date()
        } catch {
            // Fire-and-forget: the next foreground refresh carries it.
        }
    }

    func saveConnection(serverURL: String, token: String) async -> Bool {
        do {
            let configuration = try Self.configuration(urlString: serverURL, token: token)
            // A Keychain refusal must not reject a valid pairing. The token is
            // already held in the APIConfiguration for this session, so the
            // only real consequence is having to enter it again next launch —
            // reported after a successful connect rather than instead of one.
            var keychainWarning: String?
            do {
                try KeychainStore.saveToken(token.trimmingCharacters(in: .whitespacesAndNewlines))
            } catch {
                keychainWarning = "Connected, but this device refused to store the key (\(error.localizedDescription)). You will need to enter it again next launch."
            }
            let normalized = configuration.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            self.serverURL = normalized
            defaults.set(normalized, forKey: serverKey)
            client = APIClient(configuration: configuration)
            await connect()
            if bootstrap != nil {
                showingConnection = false
                if let keychainWarning { errorMessage = keychainWarning }
                return true
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        return false
    }

    func refreshAll() async {
        guard let client else { return }
        do {
            async let boot = client.bootstrap()
            async let overview = client.overview()
            let (loadedBoot, loadedOverview) = try await (boot, overview)
            apply(loadedBoot, preservingLocalMessages: isSending)
            self.overview = loadedOverview
            await reconcileBaselineActivity()
            await syncNotificationBadge()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func scenePhaseDidChange(_ phase: ScenePhase) {
        let isNowActive = phase == .active
        guard isSceneActive != isNowActive else { return }
        isSceneActive = isNowActive
        if isNowActive {
            if bootstrap != nil { startIdlePolling() }
        } else {
            idleTask?.cancel()
            idleTask = nil
        }
    }

    func refreshOverview(reportFailure: Bool = true) async {
        guard let client else { return }
        do {
            overview = try await client.overview()
            await reconcileBaselineActivity()
            await syncNotificationBadge()
        }
        catch where reportFailure { errorMessage = error.localizedDescription }
        catch { }
    }

    func refreshArchivedActivity(reportFailure: Bool = true) async {
        guard let client else { return }
        do { archivedActivity = try await client.activity(archived: true) }
        catch where reportFailure { errorMessage = error.localizedDescription }
        catch { }
    }

    func refreshArchivedGoals(reportFailure: Bool = true) async {
        guard let client else { return }
        do { archivedGoals = try await client.goals(archived: true) }
        catch where reportFailure { errorMessage = error.localizedDescription }
        catch { }
    }

    /// Mutations already have a successful server response. Let their control
    /// return immediately and reconcile secondary dashboards without turning a
    /// slow follow-up GET into a failed user action.
    private func reconcileAfterMutation(
        archivedActivity: Bool = false,
        archivedGoals: Bool = false
    ) {
        Task { [weak self] in
            guard let self else { return }
            async let overviewRefresh: Void = self.refreshOverview(reportFailure: false)
            async let activityRefresh: Void = archivedActivity
                ? self.refreshArchivedActivity(reportFailure: false)
                : ()
            async let goalsRefresh: Void = archivedGoals
                ? self.refreshArchivedGoals(reportFailure: false)
                : ()
            _ = await (overviewRefresh, activityRefresh, goalsRefresh)
        }
    }

    func updateActivity(_ item: ActivityItem, action: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateActivity(id: item.id, action: action)
            reconcileAfterMutation(archivedActivity: true)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateActivity(_ item: ActivityItem, action: String, budgetUsdLimit: Double?) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateActivity(
                id: item.id,
                action: action,
                budgetUsdLimit: budgetUsdLimit
            )
            reconcileAfterMutation()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func archiveOldActivity() async -> Bool {
        guard let client else { return false }
        do {
            try await client.archiveOldActivity()
            reconcileAfterMutation(archivedActivity: true)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func createGoal(_ goal: GoalMutation) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.createGoal(goal)
            reconcileAfterMutation()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateGoal(id: String, goal: GoalMutation) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateGoal(id: id, goal: goal)
            reconcileAfterMutation()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Mobile “delete” matches the web goal UI: archive the goal while
    /// retaining its work conversation and evidence for later restoration.
    func deleteGoal(_ goal: GoalRecord) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateGoal(id: goal.id, action: "delete")
            reconcileAfterMutation(archivedGoals: true)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func restoreGoal(_ goal: GoalRecord) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateGoal(id: goal.id, action: "restore")
            reconcileAfterMutation(archivedGoals: true)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateGoalLifecycle(
        _ goal: GoalRecord,
        action: String,
        status: String? = nil,
        enabled: Bool? = nil
    ) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateGoal(
                id: goal.id,
                action: action,
                status: status,
                enabled: enabled
            )
            reconcileAfterMutation()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func archiveInactiveGoals() async -> Bool {
        guard let client else { return false }
        do {
            try await client.archiveInactiveGoals()
            reconcileAfterMutation(archivedGoals: true)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func openConversation(id: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            setActiveConversation(try await client.conversation(id: id))
            returnToChat()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func createConversation() async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            let created = try await client.createChat()
            return await openConversation(id: created.conversationId)
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func archiveInactiveConversations() async -> Bool {
        guard let client else { return false }
        do {
            try await client.archiveInactiveChats()
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateConversation(_ chat: WorkspaceChat, action: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateChat(id: chat.id, action: action)
            if action == "archive", conversationId == chat.id {
                activeConversation = nil
                await refreshAll()
            }
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func changeConversationModel(_ modelId: String?) async -> Bool {
        guard let client, let conversationId else { return false }
        errorMessage = nil
        do {
            try await client.updateChat(id: conversationId, action: "change-model", modelId: modelId)
            setActiveConversation(try await client.conversation(id: conversationId))
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func refreshWorkspace() async {
        guard let client else { return }
        do {
            let loaded = try await client.workspace()
            workspace = loaded
            applyMemoryHealth(loaded.memory.health)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshCards() async {
        guard let client else { return }
        do {
            savedCards = try await client.cards().cards
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func dismissCard(_ card: SavedCardRecord) async -> Bool {
        guard let client else { return false }
        do {
            try await client.dismissCard(id: card.id)
            savedCards.removeAll { $0.id == card.id }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func uploadDocument(data: Data, name: String, title: String, mime: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.uploadDocument(data: data, name: name, title: title, mime: mime)
            await refreshOverview()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func deleteDocument(_ document: DocumentRecord) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.deleteDocument(id: document.id)
            await refreshOverview()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func uploadImport(
        data: Data,
        name: String,
        source: String = "",
        voice: Bool = false,
        register: String = ""
    ) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.uploadImport(
                data: data,
                name: name,
                source: source,
                voice: voice,
                register: register
            )
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateImport(
        action: String,
        source: String,
        verdict: String? = nil,
        workspacePath: String? = nil
    ) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateImport(
                action: action,
                source: source,
                verdict: verdict,
                workspacePath: workspacePath
            )
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func saveSkill(id: String? = nil, mutation: SkillMutation) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            if let id { try await client.updateSkill(id: id, skill: mutation) }
            else { try await client.createSkill(mutation) }
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func setSkillDeprecated(_ skill: WorkspaceSkill, deprecated: Bool) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.setSkillDeprecated(id: skill.id, deprecated: deprecated)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func deleteSkill(_ skill: WorkspaceSkill) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.deleteSkill(id: skill.id)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateCostLimits(_ limits: CostLimitsMutation) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateCostLimits(limits)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateAnomaly(_ anomaly: WorkspaceAnomaly, action: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateAnomaly(id: anomaly.id, action: action)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateImprovement(_ improvement: WorkspaceImprovement, action: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateImprovement(id: improvement.id, action: action)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateAgentSettings(_ mutation: AgentSettingsMutation) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateSettings(mutation)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func setSchedule(_ schedule: WorkspaceSchedule, enabled: Bool) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.setScheduleEnabled(id: schedule.id, enabled: enabled)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func deleteReminder(_ reminder: WorkspaceReminder) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.deleteReminder(id: reminder.id)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func setPolicy(_ policy: WorkspacePolicy, enabled: Bool) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.setPolicyEnabled(id: policy.id, enabled: enabled)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func deletePolicy(_ policy: WorkspacePolicy) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.deletePolicy(id: policy.id)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func refreshMcpConnections() async {
        guard let client else { return }
        do {
            mcpConnections = try await client.mcpConnections().connections
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func createMcpConnection(name: String, endpoint: String, bearerToken: String?) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.createMcpConnection(name: name, endpoint: endpoint, bearerToken: bearerToken)
            await refreshMcpConnections()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateMcpConnection(id: String, action: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateMcpConnection(id: id, action: action)
            await refreshMcpConnections()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func deleteMcpConnection(id: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.deleteMcpConnection(id: id)
            await refreshMcpConnections()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func createMemory(_ memory: MemoryMutation) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.createMemory(memory)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func correctMemory(id: String, content: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateMemory(id: id, content: content)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateMemory(id: String, action: String, prominence: String? = nil) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateMemory(id: id, action: action, prominence: prominence)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func updateMemoryProfile(action: String) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.updateMemoryProfile(action: action)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func savePerson(id: String? = nil, mutation: PersonMutation) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            if let id { try await client.updatePerson(id: id, person: mutation) }
            else { try await client.createPerson(mutation) }
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func deletePerson(_ person: WorkspacePerson) async -> Bool {
        guard let client else { return false }
        errorMessage = nil
        do {
            try await client.deletePerson(id: person.id)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func loadPersonProfile(id: String) async {
        guard let client else { return }
        do { personProfiles[id] = try await client.personProfile(id: id) }
        catch { errorMessage = error.localizedDescription }
    }

    func addOccasion(personId: String, mutation: OccasionMutation) async -> Bool {
        guard let client else { return false }
        do {
            try await client.addOccasion(personId: personId, occasion: mutation)
            await loadPersonProfile(id: personId)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func reviewOccasion(personId: String, occasion: PersonOccasion, verdict: String) async -> Bool {
        guard let client else { return false }
        do {
            try await client.reviewOccasion(id: occasion.id, verdict: verdict)
            await loadPersonProfile(id: personId)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func deleteOccasion(personId: String, occasion: PersonOccasion) async -> Bool {
        guard let client else { return false }
        do {
            try await client.deleteOccasion(id: occasion.id)
            await loadPersonProfile(id: personId)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func mergePerson(_ person: WorkspacePerson, targetId: String) async -> Bool {
        guard let client else { return false }
        do {
            try await client.mergePerson(id: person.id, targetId: targetId)
            personProfiles.removeValue(forKey: person.id)
            await refreshWorkspace()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func send(_ rawText: String, autonomous override: Bool? = nil, force: Bool = false) {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending,
              let client,
              let conversationId else { return }

        let autonomous = override ?? nextMessageAutonomous
        nextMessageAutonomous = false
        errorMessage = nil
        isSending = true
        lastNotifiedTaskState = nil
        let localUser = ChatMessage.optimistic(role: .user, text: text)
        let streamID = "stream-\(UUID().uuidString)"
        messages.append(localUser)
        messages.append(.optimistic(role: .assistant, text: "", id: streamID))
        // Neither row has a send time yet, so both anchor to the end of the
        // durable log and hold that place until their persisted twins arrive.
        messages = logOrder.ordered(messages)
        setActivityThought(.thinking, proposedDetail: text)
        thoughtClearTask?.cancel()

        pollTask?.cancel()
        pollTask = Task { [weak self] in
            guard let self else { return }
            // `ensure`, not `start`: starting ends every live activity first,
            // so a message sent while background work was already on the island
            // collapsed it and replayed the whole attach animation.
            await LiveActivityManager.shared.ensure(
                agentName: agentName,
                thought: .thinking,
                detail: text
            )
            do {
                let receipt = try await client.sendMessage(
                    conversationId: conversationId,
                    text: text,
                    autonomous: autonomous,
                    force: force,
                    onDelta: { [weak self] delta in
                        guard let self else { return }
                        await self.receive(delta: delta, streamID: streamID)
                    },
                    onCue: { [weak self] part in
                        guard let self else { return }
                        await self.append(cue: part, to: streamID)
                    }
                )
                if receipt.taskId != nil {
                    self.messages.removeAll { $0.id == streamID }
                    await self.publishThought(.startingWork, detail: text)
                }
                if let receiptCursor = receipt.cursor { self.cursor = receiptCursor }
                await self.pollForReply(taskId: receipt.taskId, streamID: streamID)
            } catch is CancellationError {
                return
            } catch {
                // URLSession's byte stream reports a cancelled task as
                // URLError.cancelled rather than CancellationError, so a turn
                // stopped from the composer would otherwise surface as an error
                // banner. cancelSend owns the UI state in that case.
                guard !Task.isCancelled else { return }
                self.messages.removeAll { $0.id == streamID && $0.text.isEmpty }
                // The composer cleared the draft when it sent; a failed turn
                // gives the words back rather than losing them to the failure.
                self.restorableDraft = text
                self.errorMessage = error.localizedDescription
                self.isSending = false
                self.setActivityThought(.stopped, proposedDetail: error.localizedDescription)
                await LiveActivityManager.shared.finish(
                    thought: .stopped,
                    detail: error.localizedDescription,
                    succeeded: false
                )
                self.clearThought(after: 4)
            }
        }
    }

    func decide(_ item: PendingApproval, decision: String) async -> Bool {
        await decideApproval(id: item.id, decision: decision)
    }

    /// Keep the approval inbox responsive as soon as the server accepts a
    /// decision. The original snapshot is restored on failure, so a tap never
    /// makes an approval silently disappear.
    private func optimisticallyResolveApproval(id: String) -> OverviewResponse? {
        guard let current = overview,
              current.approvals.pending.contains(where: { $0.id == id }) else { return nil }
        overview = OverviewResponse(
            generatedAt: current.generatedAt,
            activity: current.activity,
            goals: current.goals,
            approvals: ApprovalInbox(
                pending: current.approvals.pending.filter { $0.id != id },
                resolved: current.approvals.resolved
            ),
            documents: current.documents
        )
        return current
    }

    private func optimisticallySetDecisionStatus(id: String, status: String) {
        for messageIndex in messages.indices {
            for partIndex in messages[messageIndex].parts.indices where messages[messageIndex].parts[partIndex].approvalId == id {
                messages[messageIndex].parts[partIndex].status = status
            }
        }
    }

    private func performApprovalMutation(
        id: String,
        status: String,
        operation: () async throws -> Void
    ) async -> Bool {
        errorMessage = nil
        let previousOverview = optimisticallyResolveApproval(id: id)
        let previousMessages = messages
        optimisticallySetDecisionStatus(id: id, status: status)
        do {
            try await operation()
            reconcileAfterMutation()
            return true
        } catch {
            if let previousOverview { overview = previousOverview }
            messages = previousMessages
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Inline approve/decline from a chat decision card, keyed by the message
    /// part's approvalId rather than a fetched PendingApproval row.
    func decideApproval(id: String, decision: String) async -> Bool {
        guard let client else { return false }
        return await performApprovalMutation(id: id, status: decision) {
            _ = try await client.decideApproval(id: id, decision: decision)
        }
    }

    func approveAndRemember(_ item: PendingApproval) async -> Bool {
        guard let client else { return false }
        return await performApprovalMutation(id: item.id, status: "approved") {
            _ = try await client.approveAndRemember(id: item.id)
        }
    }

    func editAndApprove(_ item: PendingApproval, payload: JSONValue) async -> Bool {
        guard let client else { return false }
        return await performApprovalMutation(id: item.id, status: "approved") {
            _ = try await client.editAndApprove(id: item.id, payload: payload)
        }
    }

    /// Stops the turn in flight, keeping whatever text has already streamed in.
    func cancelSend() {
        guard isSending else { return }
        pollTask?.cancel()
        pollTask = nil
        isSending = false
        toolActivity = []
        messages.removeAll { $0.id.hasPrefix("stream-") && $0.text.isEmpty }
        let detail = "You stopped this turn"
        setActivityThought(.stoppedByYou, proposedDetail: detail)
        Task {
            await LiveActivityManager.shared.finish(
                thought: .stoppedByYou,
                detail: detail,
                succeeded: false
            )
        }
        clearThought(after: 2)
    }

    func dismissError() { errorMessage = nil }

    /// ChatView takes the failed turn's text back into its composer, once.
    func restoreFailedDraft() -> String? {
        let draft = restorableDraft
        restorableDraft = nil
        return draft
    }

#if DEBUG
    func previewActivitySequence() {
        thoughtClearTask?.cancel()
        Task { [weak self] in
            guard let self else { return }
            self.setActivityThought(.thinking, proposedDetail: "Preparing a focused brief")
            await LiveActivityManager.shared.start(
                agentName: self.agentName,
                thought: .thinking,
                detail: "Preparing a focused brief"
            )
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            let working = AssistantThought(label: "Reviewing recent activity", tone: .working)
            self.setActivityThought(working, proposedDetail: "Step 1")
            await LiveActivityManager.shared.update(thought: working, detail: "Step 1")
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self.setActivityThought(.needsYou, proposedDetail: "Review the proposed next step")
            await LiveActivityManager.shared.needsAttention(
                agentName: agentName,
                detail: "Review the proposed next step",
                pendingCount: 1
            )
        }
    }
#endif

    private func apply(_ response: BootstrapResponse, preservingLocalMessages: Bool = false) {
        bootstrap = response
        applyMemoryHealth(response.shell.memoryHealth)
        if activeConversation == nil
            || activeConversation?.conversation.id == response.conversation.conversation.id {
            activeConversation = response.conversation
            cursor = response.conversation.cursor
            if preservingLocalMessages {
                merge(response.conversation.messages)
            } else {
                messages = logOrder.ordered(response.conversation.messages)
            }
        }
        if !isSending, activityThought == nil || activityThought == .backgroundWork || activityThought == .needsYou {
            setActivityThought(baselineThought, proposedDetail: baselineDetail(for: baselineThought))
        }
    }

    /// The badge appears in the chat directory while review mutations refresh
    /// the workspace projection. Keep it synchronized with whichever current
    /// server projection arrived most recently instead of pinning it to the
    /// cold-launch bootstrap response.
    func applyMemoryHealth(_ health: MemoryHealth) {
        memoryReviewCount = max(0, health.awaitingReview)
    }

    private func setActiveConversation(_ conversation: ConversationView) {
        activeConversation = conversation
        cursor = conversation.cursor
        // Another conversation's ids have no sequence to agree with this one's.
        logOrder.reset()
        messages = logOrder.ordered(conversation.messages)
        toolActivity = []
        activityThought = nil
    }

    private func receive(delta: String, streamID: String) async {
        append(delta: delta, to: streamID)
        await publishThought(.replying, detail: "Writing a response")
    }

    private func append(delta: String, to id: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        // The LAST text part is the live bubble: a data-break cue starts a
        // fresh one, and everything after it belongs to the new bubble.
        if let partIndex = messages[index].parts.lastIndex(where: { $0.type == "text" }) {
            messages[index].parts[partIndex].text = (messages[index].parts[partIndex].text ?? "") + delta
        }
    }

    private func append(cue: MessagePart, to id: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        // A bubble boundary, not overlay data: the reply's remaining text
        // belongs to a fresh bubble. Persisted twins arrive already split, so
        // this only mirrors the boundary into the in-flight stream message.
        if cue.type == "data-break" {
            messages[index].parts.append(MessagePart(type: "text", text: ""))
            return
        }
        messages[index].parts.append(cue)
    }

    private func pollForReply(taskId: String?, streamID: String) async {
        guard let client, let conversationId else { return }
        let settled = Set(["done", "failed", "cancelled", "waiting_approval", "waiting_budget", "needs_attention"])
        let attention = Set(["waiting_approval", "waiting_budget", "needs_attention"])
        var grace = 0
        var finalStatus: String?
        for attempt in 0..<360 {
            if Task.isCancelled { return }
            if attempt > 0 {
                try? await Task.sleep(for: .milliseconds(PollingPolicy.replyIntervalMilliseconds(
                    attempt: attempt,
                    hasTaskID: taskId != nil
                )))
            }
            do {
                let updates = try await client.updates(
                    conversationId: conversationId,
                    taskId: taskId,
                    cursor: cursor,
                    refreshIds: unresolvedDecisionMessageIDs
                )
                let assistantBefore = messages.filter { !$0.id.hasPrefix("stream-") && $0.role == .assistant }.count
                merge(updates.messages)
                merge(updates.refreshed)
                removeSuperseded(updates.superseded)
                toolActivity = updates.activity
                if let latestTool = updates.activity.last {
                    await publishThought(
                        latestTool.inProgressThought,
                        detail: "Step \(latestTool.step)"
                    )
                }
                if let nextCursor = updates.nextCursor { cursor = nextCursor }
                let assistantAfter = messages.filter { !$0.id.hasPrefix("stream-") && $0.role == .assistant }.count

                if taskId == nil, assistantAfter > assistantBefore {
                    messages.removeAll { $0.id == streamID }
                    break
                }
                if let status = updates.taskStatus, settled.contains(status) {
                    finalStatus = status
                    grace += 1
                    if assistantAfter > assistantBefore || grace >= 4 { break }
                }
                if updates.hasMore { continue }
            } catch {
                // Same as above: a poll interrupted by cancelSend must not
                // report itself as a failure.
                if Task.isCancelled { return }
                if attempt > 3 {
                    errorMessage = error.localizedDescription
                    break
                }
            }
        }
        toolActivity = []
        isSending = false
        await refreshOverview()

        let reply = messages.reversed().first(where: { $0.role == .assistant && !$0.text.isEmpty })?.text
        if let finalStatus, attention.contains(finalStatus) {
            let pendingApproval = overview?.approvals.pending.first
            let summary = pendingApproval?.approval.summary ?? "Open the assistant to review the next step."
            setActivityThought(.needsYou, proposedDetail: summary)
            await LiveActivityManager.shared.needsAttention(
                agentName: self.agentName,
                detail: summary,
                pendingCount: pendingApprovalCount
            )
            _ = await notifyOnce(
                key: "\(taskId ?? streamID)-\(finalStatus)",
                title: "\(agentName) needs you",
                body: "A decision is ready to review.",
                route: .approvals,
                approvalId: pendingApproval?.id
            )
            await syncNotificationBadge()
        } else {
            let succeeded = finalStatus != "failed" && finalStatus != "cancelled"
            let thought: AssistantThought = succeeded ? .finished : .stopped
            let detail = concise(reply ?? (succeeded ? "Your assistant finished the task." : "Open the conversation for details."))
            setActivityThought(thought, proposedDetail: detail)
            _ = await notifyOnce(
                key: "\(taskId ?? streamID)-\(finalStatus ?? "reply")",
                title: succeeded ? "\(agentName) finished" : "\(agentName) stopped",
                body: succeeded ? "Your result is ready." : "Open the conversation for details.",
                route: .chat
            )
            await LiveActivityManager.shared.finish(
                thought: thought,
                detail: detail,
                succeeded: succeeded
            )
            clearThought(after: succeeded ? 1.8 : 4)
        }
    }

    /// The merge above can only add or replace by id. A state row delivered by
    /// an earlier poll and later replaced by a newer twin (a crash-retry
    /// re-emitting a task's stop notice) sits behind the cursor forever, so
    /// the server names it for removal — applied after every merge, since a
    /// refreshed card can itself be the row being replaced.
    private func removeSuperseded(_ ids: [String]?) {
        guard let ids, !ids.isEmpty else { return }
        let retracted = Set(ids)
        messages.removeAll { retracted.contains($0.id) }
    }

    private func merge(_ incoming: [ChatMessage]) {
        for message in incoming {
            if let index = messages.firstIndex(where: { $0.id == message.id }) {
                messages[index] = message
                continue
            }
            if let localIndex = messages.firstIndex(where: {
                $0.id.hasPrefix("local-") && $0.role == message.role && $0.text == message.text
            }) {
                messages.remove(at: localIndex)
            }
            if message.role == .assistant {
                messages.removeAll {
                    $0.id.hasPrefix("stream-") && ($0.text == message.text || !$0.text.isEmpty)
                }
            }
            messages.append(message)
        }
        messages = logOrder.ordered(messages)
    }

    private func startIdlePolling() {
        idleTask?.cancel()
        idleTask = Task { [weak self] in
            var unchangedPolls = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(PollingPolicy.idleIntervalSeconds(
                    unchangedPolls: unchangedPolls
                )))
                guard let self, self.isSceneActive else { return }
                guard !self.isSending,
                      let client = self.client,
                      let conversationId = self.conversationId else {
                    unchangedPolls += 1
                    continue
                }
                if let updates = try? await client.updates(
                    conversationId: conversationId,
                    taskId: nil,
                    cursor: self.cursor,
                    refreshIds: self.unresolvedDecisionMessageIDs
                ) {
                    let changed = !updates.messages.isEmpty || !updates.refreshed.isEmpty ||
                        !(updates.superseded?.isEmpty ?? true)
                    let assistantBefore = self.messages.filter { $0.role == .assistant }.count
                    self.merge(updates.messages)
                    self.merge(updates.refreshed)
                    self.removeSuperseded(updates.superseded)
                    if let cursor = updates.nextCursor { self.cursor = cursor }
                    let assistantAfter = self.messages.filter { $0.role == .assistant }.count
                    if assistantAfter > assistantBefore,
                       self.messages.contains(where: { $0.role == .assistant && !$0.text.isEmpty }) {
                        await NotificationManager.shared.schedule(
                            title: "\(self.agentName) replied",
                            body: "A new response is ready.",
                            route: .chat
                        )
                    }
                    unchangedPolls = changed ? 0 : unchangedPolls + 1
                } else {
                    unchangedPolls += 1
                }
            }
        }
    }

    /// Decision state lives in approvals/tasks rather than in the persisted
    /// message row. Re-read the newest visible cards during ordinary polling
    /// so a decision made on desktop changes into a receipt on the phone
    /// without requiring a reload.
    private var unresolvedDecisionMessageIDs: [String] {
        messages.reversed()
            .filter(\.hasPendingDecision)
            .prefix(10)
            .map(\.id)
    }

    private func notifyOnce(key: String, title: String, body: String, route: AssistantRoute?, approvalId: String? = nil) async -> Bool {
        guard key != lastNotifiedTaskState else { return false }
        lastNotifiedTaskState = key
        return await NotificationManager.shared.schedule(title: title, body: body, route: route, approvalId: approvalId)
    }

    /// The app icon badge tracks exactly one thing: decisions waiting on the
    /// owner. Anything else (finished work, replies) has a banner or the Live
    /// Activity, so the badge staying specific keeps it meaningful.
    private func syncNotificationBadge() async {
        await NotificationManager.shared.updateBadge(pendingApprovalCount)
    }

    private func publishThought(_ thought: AssistantThought, detail: String) async {
        let safeDetail = LiveActivityManager.safeDetail(for: thought, proposed: detail)
        guard activityThought != thought || activityDetail != safeDetail else { return }
        activityThought = thought
        activityDetail = safeDetail
        await LiveActivityManager.shared.update(thought: thought, detail: detail)
    }

    private func setActivityThought(_ thought: AssistantThought?, proposedDetail: String? = nil) {
        activityThought = thought
        if let thought, let proposedDetail {
            activityDetail = LiveActivityManager.safeDetail(for: thought, proposed: proposedDetail)
        } else {
            activityDetail = nil
        }
    }

    private func clearThought(after seconds: Double) {
        let settledThought = activityThought
        let settledDetail = activityDetail
        thoughtClearTask?.cancel()
        thoughtClearTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self,
                  self.activityThought == settledThought,
                  self.activityDetail == settledDetail else { return }
            self.setActivityThought(
                self.baselineThought,
                proposedDetail: self.baselineDetail(for: self.baselineThought)
            )
        }
    }

    private var baselineThought: AssistantThought? {
        // The overview is refreshed far more often than bootstrap and carries
        // the actual approval rows. Only a real, currently pending owner
        // decision earns the system Island; generic attention stays in the
        // Activity surface so it cannot look like an approval.
        if let overview {
            return overview.approvals.pending.isEmpty ? nil : .needsYou
        }
        return (bootstrap?.shell.dashboard.pendingApprovals ?? 0) > 0 ? .needsYou : nil
    }

    private func baselineDetail(for thought: AssistantThought?) -> String? {
        switch thought {
        case .backgroundWork:
            nil
        case .needsYou:
            "Open the assistant to review the next step."
        default:
            nil
        }
    }

    private func reconcileBaselineActivity() async {
        guard !isSending else { return }
        guard let thought = baselineThought else {
            await LiveActivityManager.shared.dismiss()
            return
        }
        switch thought {
        case .backgroundWork:
            setActivityThought(thought, proposedDetail: "Your assistant is continuing a task.")
            await LiveActivityManager.shared.dismiss()
        case .needsYou:
            let summary = overview?.approvals.pending.first?.approval.summary
                ?? "Open the assistant to review the next step."
            setActivityThought(thought, proposedDetail: summary)
            await LiveActivityManager.shared.ensure(
                agentName: agentName,
                thought: .needsYou,
                detail: summary,
                pendingCount: pendingApprovalCount
            )
        default:
            await LiveActivityManager.shared.dismiss()
        }
    }

    private func concise(_ text: String, limit: Int = 120) -> String {
        let singleLine = text
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard singleLine.count > limit else { return singleLine }
        return String(singleLine.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }

    private static func configuration(urlString: String, token: String) throws -> APIConfiguration {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              components.host != nil else { throw APIError.invalidServerURL }
        components.path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = components.url else { throw APIError.invalidServerURL }
        return .init(baseURL: url, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
