import Foundation

enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var string: String? {
        if case let .string(value) = self { return value }
        return nil
    }
}

enum ChatRole: String, Codable, Sendable {
    case user
    case assistant
}

struct MessagePart: Codable, Hashable, Sendable {
    let type: String
    var text: String?
    var data: JSONValue?
    var notice: String?
    var approvalId: String?
    var taskId: String?
    var suggestionId: String?
    var shortCode: String?
    var summary: String?
    var status: String?
    var proposedBudgetUsd: Double?
    /// Auto-recall provenance. Optional keeps an older server and all prior
    /// message parts decodable while GraphRAG rolls out.
    var sources: [MessageRecallSource]? = nil
}

struct MessageRecallSource: Codable, Hashable, Sendable {
    let date: String
    let label: String
    let kind: String?
    let hops: Int?

    var isKnowledgeGraph: Bool { kind == "knowledge_graph" }
}

struct ChatMessage: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let role: ChatRole
    var parts: [MessagePart]
    var metadata: [String: JSONValue]?

    var text: String {
        parts.compactMap { $0.type == "text" ? $0.text : nil }.joined()
    }

    /// One entry per chat bubble: a reply split by the assistant's [break]
    /// cue persists as several text parts and streams the same way (a
    /// data-break part starts a new text part). Whitespace-only parts are a
    /// split point's residue — they join into `text` but render as nothing.
    var textBubbles: [String] {
        parts
            .filter { $0.type == "text" }
            .compactMap(\.text)
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    var createdAt: Date? {
        guard let raw = metadata?["createdAt"]?.string else { return nil }
        return ISO8601DateFormatter.assistant.date(from: raw)
    }

    var quickReplies: [String] {
        for part in parts.reversed() where part.type == "data-chips" {
            guard case let .object(object) = part.data,
                  case let .array(labels)? = object["labels"] else { continue }
            return labels.compactMap(\.string).prefix(4).map { String($0.prefix(60)) }
        }
        return []
    }

    var face: CompanionFace? {
        for part in parts.reversed() where part.type == "data-face" {
            guard case let .object(object) = part.data,
                  let raw = object["state"]?.string,
                  let face = CompanionFace(rawValue: raw) else { continue }
            return face
        }
        return nil
    }

    var mood: CompanionMood? {
        for part in parts.reversed() where part.type == "data-theme" {
            guard case let .object(object) = part.data,
                  let raw = object["name"]?.string,
                  let mood = CompanionMood(rawValue: raw) else { continue }
            return mood
        }
        return nil
    }

    var recallSources: [MessageRecallSource] {
        parts.first(where: { $0.type == "recall" })?.sources ?? []
    }

    var decisionParts: [MessagePart] {
        parts.filter { ["approval", "budget-request"].contains($0.type) }
    }

    /// Runtime decision prose and the structured card say the same thing.
    /// Keep one visual object in the transcript: the card, whose live status
    /// can change after the message itself was persisted.
    var visibleTextBubbles: [String] {
        decisionParts.isEmpty ? textBubbles : []
    }

    var noticeKind: ChatNoticeKind? {
        parts.lazy
            .filter { $0.type == "notice" }
            .compactMap { $0.notice.flatMap(ChatNoticeKind.init(rawValue:)) }
            .first
    }

    /// The tool-less chat path's honesty guard marked this reply: it claimed
    /// work that never ran. Live the marker is a `data-off-course` stream
    /// part; the persisted message carries a `notice` part with the same
    /// meaning. Kept out of ChatNoticeKind on purpose — an off-course reply
    /// keeps its text and ADDS the card, it is not replaced by one.
    var isOffCourse: Bool {
        parts.contains { part in
            part.type == "data-off-course" || (part.type == "notice" && part.notice == "off-course")
        }
    }

    var hasPendingDecision: Bool {
        decisionParts.contains { part in
            part.status == nil || part.status == "pending" || part.status == "snoozed"
        }
    }

    static func optimistic(role: ChatRole, text: String, id: String = "local-\(UUID().uuidString)") -> Self {
        .init(id: id, role: role, parts: [.init(type: "text", text: text)])
    }
}

enum ChatNoticeKind: String, Codable, Sendable {
    case responseContract = "response-contract"
    case parked
    case needsAttention = "needs-attention"
    case turnFailed = "turn-failed"
}

enum CompanionFace: String, Codable, Sendable {
    case neutral
    case warmSmile = "warm_smile"
    case happySquint = "happy_squint"
    case curiousBlink = "curious_blink"
    case thoughtfulTilt = "thoughtful_tilt"
    case wideExcited = "wide_excited"
    case gentleNod = "gentle_nod"
    case focused
}

enum CompanionMood: String, Codable, Sendable {
    case `default`
    case warmAmber = "warm_amber"
    case softRose = "soft_rose"
    case coolSky = "cool_sky"

    /// How many recent assistant messages a theme cue reaches forward over.
    /// Mirrors THEME_LOOKBACK in packages/core/src/chat-cues.ts.
    static let lookback = 8

    /// The chat's color mood — pinned to `.default`. The owner asked to keep
    /// the mood color unchanged permanently, so this ignores any `[theme:]`
    /// cue in the log (the dashboard persona no longer emits them, but older
    /// messages can still carry one). Mirrors the web client's
    /// `latestTheme(log)` (see apps/web/lib/chat-cues.ts), and lives here
    /// rather than on AppModel so it is reachable from tests.
    static func latest(in _: [ChatMessage]) -> CompanionMood {
        .default
    }
}

enum AssistantPresence: String, Codable, Sendable {
    case idle
    case working
    case attention
}

struct AgentIdentity: Codable, Sendable {
    let id: String
    let name: String
    let avatarUrl: String?
}

struct DashboardStatus: Codable, Sendable {
    let pendingApprovals: Int
    let needsAttention: Int
    let presence: AssistantPresence
}

struct MemoryHealth: Codable, Sendable {
    let totalUsable: Int
    let notYetOrganized: Int
    let awaitingReview: Int
    let ownerConfirmed: Int
    let lastOrganizedAt: String?
}

struct ShellStatus: Codable, Sendable {
    let dashboard: DashboardStatus
    let memoryHealth: MemoryHealth
}

struct ConversationRecord: Codable, Sendable {
    let id: String
    let title: String?
    let modelOverride: String?
    let archivedAt: String?
    let isPrimary: Bool
}

struct ModelOption: Codable, Identifiable, Sendable {
    let id: String
    let label: String
}

struct AsyncTurn: Codable, Sendable {
    let taskId: String
    let cursor: String
}

struct ConversationView: Codable, Sendable {
    let conversation: ConversationRecord
    let agentName: String
    let agentTimezone: String
    let messages: [ChatMessage]
    let models: [ModelOption]
    let goalTitle: String?
    let canArchive: Bool
    let cursor: String?
    let asyncTurn: AsyncTurn?
}

struct BootstrapResponse: Codable, Sendable {
    let generatedAt: String
    let identity: AgentIdentity
    let shell: ShellStatus
    let conversation: ConversationView
}

struct ActivityItem: Codable, Identifiable, Sendable {
    let id: String
    let type: String
    let status: String
    let title: String?
    let progress: String
    let trust: String
    let spentUsd: String
    let budgetUsdLimit: String
    let updatedAt: String
    let archivedAt: String?
    let hasPendingApproval: Bool
    let hasActiveAutonomy: Bool?
    let stuckWaiting: Bool?

    init(
        id: String,
        type: String,
        status: String,
        title: String?,
        progress: String,
        trust: String,
        spentUsd: String,
        budgetUsdLimit: String,
        updatedAt: String,
        archivedAt: String?,
        hasPendingApproval: Bool,
        hasActiveAutonomy: Bool? = nil,
        stuckWaiting: Bool? = nil
    ) {
        self.id = id
        self.type = type
        self.status = status
        self.title = title
        self.progress = progress
        self.trust = trust
        self.spentUsd = spentUsd
        self.budgetUsdLimit = budgetUsdLimit
        self.updatedAt = updatedAt
        self.archivedAt = archivedAt
        self.hasPendingApproval = hasPendingApproval
        self.hasActiveAutonomy = hasActiveAutonomy
        self.stuckWaiting = stuckWaiting
    }

    var displayTitle: String {
        let candidate = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !candidate.isEmpty else { return type.sentenceCaseIdentifier }
        return candidate.isMachineIdentifier ? candidate.sentenceCaseIdentifier : candidate
    }

    var displayProgress: String {
        Self.progressPrefixes.reduce(progress) { result, replacement in
            result.replacingOccurrences(of: replacement.technical, with: replacement.human)
        }
    }

    var budgetSummary: String {
        "\(Self.displayUSD(spentUsd)) of \(Self.displayUSD(budgetUsdLimit))"
    }

    private static let progressPrefixes: [(technical: String, human: String)] = [
        ("documents.process", "Document processing"),
        ("documents.extract", "Document extraction"),
        ("ambient:", "Background update:"),
        ("dream:", "Reflection:"),
        ("self-improve:", "Improvement review:"),
        ("self-maintain:", "Maintenance:"),
    ]

    private static func displayUSD(_ raw: String) -> String {
        let locale = Locale(identifier: "en_US_POSIX")
        guard let value = Decimal(string: raw, locale: locale) else { return "$\(raw)" }

        let needsFinePrecision = value > 0 && value < 0.01
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = false
        formatter.minimumFractionDigits = needsFinePrecision ? 5 : 2
        formatter.maximumFractionDigits = needsFinePrecision ? 5 : 2
        let rendered = formatter.string(from: NSDecimalNumber(decimal: value)) ?? raw
        return "$\(rendered)"
    }
}

struct ActivityList: Codable, Sendable {
    let items: [ActivityItem]
    let archivedCount: Int
}

struct GoalRecord: Codable, Identifiable, Sendable {
    let id: String
    let title: String
    let description: String
    let status: String
    let priority: Int
    let progress: String
    let nextAction: String
    let targetDate: String?
    let createdAt: String
    let updatedAt: String
    let archivedAt: String?
    let mirrorToPrimary: Bool
    let autonomy: Bool
    let taintedOrigin: Bool

    /// Human-facing goal title. Test and automation-created goals can arrive
    /// with a timestamp/run id appended to a machine identifier; that suffix
    /// is useful to the server but turns into four lines of noise on a phone.
    var displayTitle: String {
        let candidate = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty else { return "Untitled goal" }

        let withoutRunIdentifier = candidate.replacingOccurrences(
            of: #"-\d{10,}(?:-\d+(?:\.\d+)?)?$"#,
            with: "",
            options: .regularExpression
        )
        let resolved = withoutRunIdentifier.isEmpty ? candidate : withoutRunIdentifier
        return resolved.isMachineIdentifier ? resolved.sentenceCaseIdentifier : resolved
    }
}

struct GoalAutomation: Codable, Sendable {
    let enabled: Bool
    let nextRunAt: String?
}

struct GoalDashboardItem: Codable, Identifiable, Sendable {
    var id: String { goal.id }
    let goal: GoalRecord
    let conversationId: String?
    let workActive: Bool
    let automation: GoalAutomation?
    let cadenceLabel: String
    let blockedQuestion: String
    let stalled: Bool
}

struct GoalsDashboard: Codable, Sendable {
    let items: [GoalDashboardItem]
    let archivedCount: Int
}

struct ApprovalRecord: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let shortCode: String
    let summary: String
    let payload: JSONValue
    let resolutionPayload: JSONValue?
    let status: String
    let requestedAt: String
    let resolvedAt: String?
    let resolvedVia: String?
    let expiresAt: String
}

struct PendingApproval: Codable, Identifiable, Sendable {
    var id: String { approval.id }
    let approval: ApprovalRecord
    let taskType: String
    let taskTrust: String
    let toolName: String
    let decision: JSONValue
}

struct ResolvedApproval: Codable, Identifiable, Sendable {
    var id: String { approval.id }
    let approval: ApprovalRecord
    let taskType: String
}

struct ApprovalInbox: Codable, Sendable {
    let pending: [PendingApproval]
    let resolved: [ResolvedApproval]
}

struct DocumentRecord: Codable, Identifiable, Sendable {
    let id: String
    let title: String
    let mime: String
    let source: String
    let trust: String
    let status: String
    let extractor: String
    let chunkCount: Int
    let charCount: Int
    let bytes: Int
    let error: String?
    let createdAt: String
}

struct DocumentStats: Codable, Sendable {
    let total: Int
    let ready: Int
    let pending: Int
    let chunks: Int
}

struct DocumentsOverview: Codable, Sendable {
    let documents: [DocumentRecord]
    let stats: DocumentStats
    let primaryConversationId: String
}

struct OverviewResponse: Codable, Sendable {
    let generatedAt: String
    let activity: ActivityList
    let goals: GoalsDashboard
    let approvals: ApprovalInbox
    let documents: DocumentsOverview
}

struct WorkspaceResponse: Codable, Sendable {
    let generatedAt: String
    let chats: WorkspaceChats
    let memory: WorkspaceMemory
    let skills: [WorkspaceSkill]
    // Optional so a newer app remains usable while an older server is still
    // rolling out the capabilities projection.
    let capabilities: [WorkspaceCapability]?
    let settings: WorkspaceSettings
    let costs: WorkspaceCosts
    let anomalies: [WorkspaceAnomaly]
    let improvements: [WorkspaceImprovement]
    let imports: WorkspaceImports?
}

struct WorkspaceImports: Codable, Sendable {
    let sources: [WorkspaceImportSource]
    let unstartedFiles: [WorkspaceImportFile]
}

struct WorkspaceImportSource: Codable, Identifiable, Sendable {
    var id: String { source }
    let source: String
    let workspacePath: String
    let kind: String
    let status: String
    let itemsTotal: Int?
    let itemsProcessed: Int
    let memoriesSaved: Int
    let quarantinedNow: Int
    let taskId: String?
    let error: String?
    let updatedAt: String
}

struct WorkspaceImportFile: Codable, Identifiable, Sendable {
    var id: String { name }
    let name: String
    let dir: Bool
}

struct WorkspaceCapability: Codable, Identifiable, Sendable {
    let id: String
    let title: String
    let summary: String
    let enabled: Bool
    let ready: Bool
    let status: String?
    let detail: String

    var statusTitle: String {
        switch status {
        case "off": return "Off"
        case "ready": return "Ready"
        case "setup_needed": return "Setup needed"
        case "unavailable": return "Status unavailable"
        default:
            if !enabled { return "Off" }
            return ready ? "Ready" : "Setup needed"
        }
    }

    var icon: String {
        switch id {
        case "browser": "safari"
        case "code": "terminal"
        case "documents": "doc.text.magnifyingglass"
        case "google": "square.grid.2x2"
        case "reminders": "bell.badge"
        case "search": "magnifyingglass"
        case "sms": "message"
        case "watches": "eye"
        default: "puzzlepiece.extension"
        }
    }
}

struct WorkspaceChats: Codable, Sendable {
    let current: [WorkspaceChat]
    let archived: [WorkspaceChat]
}

struct WorkspaceChat: Codable, Identifiable, Sendable {
    let id: String
    let title: String?
    let isPrimary: Bool
    let updatedAt: String
    let active: Bool

    var displayTitle: String {
        let candidate = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return candidate.isEmpty || candidate == "Untitled" ? "New conversation" : candidate
    }
}

struct WorkspaceMemory: Codable, Sendable {
    let ownerName: String?
    /// The owner contact is the subject for facts created from the iPhone.
    /// Optional keeps an app paired to an older server usable until it refreshes.
    let ownerContactId: String?
    let health: MemoryHealth
    let facts: [WorkspaceMemoryFact]
    let awaitingReview: [WorkspaceMemoryFact]
    let peopleCount: Int
    let people: [WorkspacePerson]?
    let card: WorkspaceMemoryCard?
    let voiceStats: WorkspaceVoiceStats?
    let latestOrganizer: WorkspaceMemoryOrganizer?
}

struct WorkspacePerson: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let aliases: [String]
    let relationship: String
    let trust: String
    let factCount: Int
}

struct PersonProfileResponse: Codable, Sendable {
    let contact: PersonProfileContact
    let occasions: [PersonOccasion]
    let mergeOptions: [PersonMergeOption]
}

struct PersonProfileContact: Codable, Sendable {
    let id: String
    let name: String
    let aliases: [String]
    let relationship: String
    let trust: String
}

struct PersonOccasion: Codable, Identifiable, Sendable {
    let id: String
    let kind: String
    let label: String
    let month: Int
    let day: Int
    let year: Int?
    let notes: String
    let quarantined: Bool
}

struct PersonMergeOption: Codable, Identifiable, Sendable {
    let id: String
    let label: String
}

struct WorkspaceMemoryCard: Codable, Sendable {
    let content: String
    let compiledAt: String
}

struct WorkspaceVoiceStats: Codable, Sendable {
    let total: Int
    let auto: Int
    let uploaded: Int
}

struct WorkspaceMemoryOrganizer: Codable, Sendable {
    let id: String
    let status: String
    let progress: String
    let updatedAt: String
}

struct WorkspaceMemoryFact: Codable, Identifiable, Sendable {
    let id: String
    let content: String
    let kind: String
    let domain: String?
    let ownerConfirmed: Bool
    let pinned: Bool
    let importance: Int
    let createdAt: String
}

struct WorkspaceSkill: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let preconditions: String
    let steps: String
    let gotchas: String
    let ownerAuthored: Bool
    let deprecated: Bool
    let useCount: Int
    let successCount: Int
    let failureCount: Int
    let updatedAt: String
}

struct WorkspaceSettings: Codable, Sendable {
    let agent: WorkspaceAgentSettings
    let schedules: [WorkspaceSchedule]
    let policies: [WorkspacePolicy]
    let goalAutomationCount: Int
}

struct WorkspaceAgentSettings: Codable, Sendable {
    let name: String
    let timezone: String
    let locale: String
    let signature: String
}

struct WorkspaceSchedule: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    /// Human wording from the server's own label dictionary; nil for names it
    /// doesn't know, in which case the UI sentence-cases the identifier.
    let label: String?
    let cron: String
    let enabled: Bool
    let nextRunAt: String?
    let lastRunAt: String?

    var displayName: String { label ?? name.sentenceCaseIdentifier }
}

struct WorkspacePolicy: Codable, Identifiable, Sendable {
    let id: String
    let toolName: String
    let templateKey: String
    /// Human wording from the server's own label dictionary; nil for keys it
    /// doesn't know, in which case the UI sentence-cases the identifier.
    let label: String?
    let effect: String
    let enabled: Bool
    let createdVia: String

    var displayName: String { label ?? templateKey.sentenceCaseIdentifier }
}

struct WorkspaceCosts: Codable, Sendable {
    let dailySpentUsd: Double
    let monthlySpentUsd: Double
    let heldUsd: Double
    let dailyLimitUsd: Double?
    let monthlyLimitUsd: Double?
    let taskDefaultLimit: String?
    let parkedTasks: Int
    let bySource: [WorkspaceCostBreakdown]
    let byModel: [WorkspaceModelBreakdown]
    let held: [WorkspaceHeldCost]
    let topTasks: [WorkspaceCostTask]
    let recent: [WorkspaceCostEvent]
}

struct WorkspaceCostBreakdown: Codable, Identifiable, Sendable {
    var id: String { source }
    let source: String
    let usd: String?
    let count: Int

    private enum CodingKeys: String, CodingKey {
        case source
        case usd
        case count
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        source = try container.decode(String.self, forKey: .source)
        usd = try container.decodeIfPresent(String.self, forKey: .usd)
        count = try container.decodeIntegerOrPostgresCount(forKey: .count)
    }
}

struct WorkspaceModelBreakdown: Codable, Identifiable, Sendable {
    var id: String { model }
    let model: String
    let usd: String?
    let count: Int

    private enum CodingKeys: String, CodingKey {
        case model
        case usd
        case count
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        model = try container.decode(String.self, forKey: .model)
        usd = try container.decodeIfPresent(String.self, forKey: .usd)
        count = try container.decodeIntegerOrPostgresCount(forKey: .count)
    }
}

struct WorkspaceHeldCost: Codable, Identifiable, Sendable {
    let id: String
    let source: String
    let description: String
    let estimatedUsd: String
}

struct WorkspaceCostTask: Codable, Identifiable, Sendable {
    var id: String { taskId ?? "\(type)-\(progress)" }
    let taskId: String?
    let usd: String?
    let type: String
    let progress: String
}

struct WorkspaceCostEvent: Codable, Identifiable, Sendable {
    let id: String
    let createdAt: String
    let source: String
    let description: String
    let usd: String
}

struct WorkspaceAnomaly: Codable, Identifiable, Sendable {
    let id: String
    let kind: String
    let toolName: String
    let detail: String
    let observed: Int
    let expected: Int
    let citationCount: Int
    let hasPolicy: Bool
    let createdAt: String
}

struct WorkspaceImprovement: Codable, Identifiable, Sendable {
    let id: String
    let kind: String
    let title: String
    let rationale: String
    let suggestion: String
    let evidenceCount: Int
    let applyable: Bool
    let createdAt: String
}

struct McpConnectionsResponse: Codable, Sendable {
    let connections: [McpConnection]
}

struct McpConnection: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let endpoint: String
    let status: String
    let enabled: Bool
    let hasBearerToken: Bool
    let serverName: String?
    let serverVersion: String?
    let instructions: String?
    let tools: [McpConnectionTool]
    let lastCheckedAt: String?
    let lastError: String?

    var displayServerName: String { serverName?.isEmpty == false ? serverName! : name }

    var statusLabel: String {
        switch status {
        case "ready": "Ready"
        case "checking": "Checking"
        case "authorization_required": "Authorization needed"
        case "disabled": "Paused"
        default: "Needs attention"
        }
    }

    var statusIcon: String {
        switch status {
        case "ready": "checkmark.seal.fill"
        case "checking": "arrow.triangle.2.circlepath"
        case "authorization_required": "lock.trianglebadge.exclamationmark"
        case "disabled": "pause.circle.fill"
        default: "exclamationmark.triangle.fill"
        }
    }
}

struct McpConnectionTool: Codable, Identifiable, Sendable {
    var id: String { name }
    let name: String
    let description: String
    let inputSchema: JSONValue
}

private extension KeyedDecodingContainer {
    /// PostgreSQL drivers often serialize aggregate `count(*)` columns as
    /// strings, while the mobile API's current contract sends an integer. The
    /// app accepts both so an updated client remains compatible with a server
    /// that has not yet deployed the contract normalization.
    func decodeIntegerOrPostgresCount(forKey key: Key) throws -> Int {
        if let integer = try? decode(Int.self, forKey: key) {
            return integer
        }

        let string = try decode(String.self, forKey: key)
        guard let integer = Int(string) else {
            throw DecodingError.typeMismatch(
                Int.self,
                .init(
                    codingPath: codingPath + [key],
                    debugDescription: "Expected an integer or a PostgreSQL count string."
                )
            )
        }
        return integer
    }
}

struct ChatUpdates: Codable, Sendable {
    let taskStatus: String?
    let messages: [ChatMessage]
    let refreshed: [ChatMessage]
    /// Ids of rows an earlier poll delivered that a row in this payload
    /// replaces (a crash-retry re-emitting a task state, a prose mirror
    /// superseded by its structured card). Optional so a stale server build
    /// cannot break decoding of every update.
    let superseded: [String]?
    let nextCursor: String?
    let hasMore: Bool
    let activity: [ToolActivity]
}

struct ToolActivity: Codable, Sendable {
    let toolName: String
    let status: String
    let step: Int

    var thought: AssistantThought {
        let tone: AssistantActivityTone = switch status {
        case "failed", "denied": .failed
        case "awaiting_approval": .waiting
        case "succeeded": .done
        default: .working
        }
        return .init(label: displayLabel, tone: tone)
    }

    /// The same step, described as progress rather than as an outcome.
    ///
    /// `thought` reports a single tool's own tone, which is right for a
    /// per-step readout but wrong for the activity surfaces: `.done`,
    /// `.failed`, and `.waiting` are terminal states owned by the turn. Letting
    /// one finished tool call publish `.done` made the crown claim the whole
    /// turn was over — green checkmark, "Your result is ready", and a success
    /// haptic — after every successful step of a turn still in flight.
    var inProgressThought: AssistantThought {
        .init(label: displayLabel, tone: .working)
    }

    var displayLabel: String {
        Self.labels[toolName] ?? toolName
            .replacingOccurrences(of: ".", with: " ")
            .sentenceCaseIdentifier
    }

    private static let labels: [String: String] = [
        "web.fetch": "Reading a web page",
        "web.search": "Searching the web",
        "memory.recall": "Recalling memory",
        "memory.save": "Saving a note to memory",
        "contacts.lookup": "Looking up a contact",
        "conversations.search": "Searching past chats",
        "goals.update_progress": "Updating goal progress",
        "mission.update": "Updating ongoing work",
        "task.schedule": "Scheduling follow-up work",
        "owner.notify": "Leaving you a note",
        "code.execute": "Running code",
        "documents.search": "Searching documents",
        "browser.plan": "Planning a browser task",
        "browser.execute": "Running a browser task",
        "gmail.send": "Sending an email",
        "gmail.create_draft": "Drafting an email",
        "gmail.search": "Searching email",
        "gmail.modify": "Tidying email",
        "calendar.create_event": "Creating a calendar event",
        "calendar.update_event": "Updating a calendar event",
        "calendar.search_events": "Checking the calendar",
        "calendar.list_events": "Checking the calendar",
        "docs.create": "Creating a document",
        "docs.append": "Updating a document",
        "docs.get": "Reading a document",
        "docs.share": "Sharing a document",
        "sheets.create": "Creating a spreadsheet",
        "sheets.append_rows": "Updating a spreadsheet",
        "sheets.write_rows": "Updating a spreadsheet",
        "sheets.get_rows": "Reading a spreadsheet",
        "slides.create": "Creating a presentation",
        "slides.append": "Updating a presentation",
        "drive.search": "Searching Drive",
        "drive.read": "Reading a Drive file",
        "drive.ingest": "Filing a Drive document",
        "sms.send": "Sending a text",
    ]
}

struct ApprovalResult: Codable, Sendable {
    let ok: Bool
    let taskId: String
    let toolCallId: String
    let approvalId: String
}

struct SendReceipt: Sendable {
    let taskId: String?
    let cursor: String?
    let conversationId: String
}

extension ISO8601DateFormatter {
    static let assistant: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

extension String {
    var assistantDate: Date? { ISO8601DateFormatter.assistant.date(from: self) }

    var sentenceCaseIdentifier: String {
        switch self.lowercased() {
        case "adhoc":
            return "Ad hoc"
        case "waiting_approval":
            return "Waiting for approval"
        case "waiting_budget":
            return "Waiting for budget"
        case "waiting_event":
            return "Waiting for an event"
        case "needs_attention":
            return "Needs attention"
        default:
            break
        }

        return replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: ".", with: " ")
            .capitalized
    }

    var isMachineIdentifier: Bool {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains(where: \.isWhitespace) else { return false }
        return trimmed.contains("_")
            || trimmed.contains("-")
            || trimmed.contains(".")
            || trimmed == trimmed.lowercased()
    }
}
