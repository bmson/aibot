import Foundation
import SwiftUI
import UIKit

enum AssistantRoute: String, Hashable, Identifiable, CaseIterable {
    case chat
    case chats
    case activity
    case goals
    case approvals
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
    @Published private(set) var workspace: WorkspaceResponse?
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isSending = false
    @Published private(set) var toolActivity: [ToolActivity] = []
    @Published private(set) var activityThought: AssistantThought?
    @Published private(set) var activityDetail: String?
    @Published var errorMessage: String?
    @Published var showingConnection = false
    /// One-shot intent shared by every user-facing way to send a message,
    /// including quick replies and document shortcuts.
    @Published var nextMessageAutonomous = false
    @Published private(set) var hasSavedConnection: Bool

    private(set) var serverURL: String
    private var client: APIClient?
    private var cursor: String?
    private var pollTask: Task<Void, Never>?
    private var idleTask: Task<Void, Never>?
    private var thoughtClearTask: Task<Void, Never>?
    private var lastNotifiedTaskState: String?

    private let defaults = UserDefaults.standard
    private let serverKey = "assistant.server-url"
    private let configuredKey = "assistant.connection-configured"
    /// More → Assistant context owns this toggle; the model only reads it.
    static let shareLocationKey = "assistant.share-location"
    private var lastLocationPostAt: Date?

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
            guard let self, let client = self.client else { return }
            do {
                _ = try await client.decideApproval(id: approvalId, decision: decision)
                await self.refreshAll()
            } catch {
                self.errorMessage = error.localizedDescription
            }
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
    var memoryReviewCount: Int { bootstrap?.shell.memoryHealth.awaitingReview ?? 0 }
    var needsAttentionCount: Int { bootstrap?.shell.dashboard.needsAttention ?? 0 }
    var conversationId: String? { bootstrap?.conversation.conversation.id }
    var latestFace: CompanionFace {
        messages.reversed().compactMap(\.face).first ?? .neutral
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
            startIdlePolling()
            await shareLocationIfEnabled(force: true)
        } catch {
            errorMessage = error.localizedDescription
            if bootstrap == nil { showingConnection = true }
        }
        isLoading = false
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

    func refreshOverview() async {
        guard let client else { return }
        do { overview = try await client.overview() }
        catch { errorMessage = error.localizedDescription }
    }

    func refreshWorkspace() async {
        guard let client else { return }
        do { workspace = try await client.workspace() }
        catch { errorMessage = error.localizedDescription }
    }

    func send(_ rawText: String, autonomous override: Bool? = nil) {
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
        guard let client else { return false }
        errorMessage = nil
        do {
            _ = try await client.decideApproval(id: item.id, decision: decision)
            await refreshAll()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
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
                succeeded: false,
                retainsSummary: false
            )
        }
        clearThought(after: 2)
    }

    func dismissError() { errorMessage = nil }

    private var isForeground: Bool {
        UIApplication.shared.applicationState == .active
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
                detail: "Review the proposed next step",
                pendingCount: 1
            )
        }
    }
#endif

    private func apply(_ response: BootstrapResponse, preservingLocalMessages: Bool = false) {
        bootstrap = response
        cursor = response.conversation.cursor
        if preservingLocalMessages {
            merge(response.conversation.messages)
        } else {
            messages = response.conversation.messages
        }
        if !isSending, activityThought == nil || activityThought == .backgroundWork || activityThought == .needsYou {
            setActivityThought(baselineThought, proposedDetail: baselineDetail(for: baselineThought))
        }
    }

    private func receive(delta: String, streamID: String) async {
        append(delta: delta, to: streamID)
        await publishThought(.replying, detail: "Writing a response")
    }

    private func append(delta: String, to id: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        if let partIndex = messages[index].parts.firstIndex(where: { $0.type == "text" }) {
            messages[index].parts[partIndex].text = (messages[index].parts[partIndex].text ?? "") + delta
        }
    }

    private func append(cue: MessagePart, to id: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
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
                try? await Task.sleep(for: .milliseconds(taskId == nil ? 650 : 1_500))
            }
            do {
                let updates = try await client.updates(
                    conversationId: conversationId,
                    taskId: taskId,
                    cursor: cursor
                )
                let assistantBefore = messages.filter { !$0.id.hasPrefix("stream-") && $0.role == .assistant }.count
                merge(updates.messages)
                merge(updates.refreshed)
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
            let notificationDelivered = await notifyOnce(
                key: "\(taskId ?? streamID)-\(finalStatus ?? "reply")",
                title: succeeded ? "\(agentName) finished" : "\(agentName) stopped",
                body: succeeded ? "Your result is ready." : "Open the conversation for details.",
                route: .chat
            )
            // Hold the activity open as a receipt only when the owner might not
            // have seen the result. `schedule` returns false whenever the app
            // is active, so keying off it alone meant every turn watched
            // on-screen pinned a stale "Finished" card to the island for
            // fifteen minutes — while the in-app crown cleared it in under two.
            await LiveActivityManager.shared.finish(
                thought: thought,
                detail: detail,
                succeeded: succeeded,
                retainsSummary: !notificationDelivered && !isForeground
            )
            clearThought(after: succeeded ? 1.8 : 4)
        }
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
    }

    private func startIdlePolling() {
        idleTask?.cancel()
        idleTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(12))
                guard let self, !self.isSending,
                      let client = self.client,
                      let conversationId = self.conversationId else { continue }
                if let updates = try? await client.updates(
                    conversationId: conversationId,
                    taskId: nil,
                    cursor: self.cursor
                ) {
                    let assistantBefore = self.messages.filter { $0.role == .assistant }.count
                    self.merge(updates.messages)
                    self.merge(updates.refreshed)
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
                }
            }
        }
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
        switch bootstrap?.shell.dashboard.presence {
        case .working: .backgroundWork
        case .attention: .needsYou
        case .idle, nil: nil
        }
    }

    private func baselineDetail(for thought: AssistantThought?) -> String? {
        switch thought {
        case .backgroundWork:
            "Your assistant is continuing a task."
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
            await LiveActivityManager.shared.ensure(
                agentName: agentName,
                thought: .backgroundWork,
                detail: "Your assistant is continuing a task."
            )
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
