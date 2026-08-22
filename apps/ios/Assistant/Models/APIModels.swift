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
    var approvalId: String?
    var taskId: String?
    var suggestionId: String?
    var shortCode: String?
    var summary: String?
    var status: String?
    var proposedBudgetUsd: Double?
}

struct ChatMessage: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let role: ChatRole
    var parts: [MessagePart]
    var metadata: [String: JSONValue]?

    var text: String {
        parts.compactMap { $0.type == "text" ? $0.text : nil }.joined()
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

    static func optimistic(role: ChatRole, text: String, id: String = "local-\(UUID().uuidString)") -> Self {
        .init(id: id, role: role, parts: [.init(type: "text", text: text)])
    }
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
    let settings: WorkspaceSettings
    let costs: WorkspaceCosts
    let anomalies: [WorkspaceAnomaly]
    let improvements: [WorkspaceImprovement]
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
    let health: MemoryHealth
    let facts: [WorkspaceMemoryFact]
    let awaitingReview: [WorkspaceMemoryFact]
    let peopleCount: Int
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
}

struct WorkspaceModelBreakdown: Codable, Identifiable, Sendable {
    var id: String { model }
    let model: String
    let usd: String?
    let count: Int
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

struct ChatUpdates: Codable, Sendable {
    let taskStatus: String?
    let messages: [ChatMessage]
    let refreshed: [ChatMessage]
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
