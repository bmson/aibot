import Foundation

struct APIConfiguration: Equatable, Sendable {
    let baseURL: URL
    let token: String
}

enum APIError: LocalizedError {
    case invalidServerURL
    case invalidResponse
    case unauthorized
    case server(status: Int, message: String)
    case decoding(model: String, detail: String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL: "Enter a valid Assistant server URL."
        case .invalidResponse: "The server returned an unreadable response."
        case .unauthorized: "The access key was not accepted by this Assistant server."
        case let .server(_, message): message
        case let .decoding(model, detail): "Could not read the \(model) response: \(detail)."
        }
    }

    /// Name the field that failed rather than collapsing every mismatch into
    /// "unreadable response" — a decode failure against a server that answered
    /// 200 is otherwise indistinguishable from a network problem.
    static func decodeFailure(_ error: Error, as type: Any.Type) -> APIError {
        let model = String(describing: type)
        guard let decodingError = error as? DecodingError else {
            return .decoding(model: model, detail: error.localizedDescription)
        }
        func at(_ context: DecodingError.Context) -> String {
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            return path.isEmpty ? "the top level" : "'\(path)'"
        }
        let detail: String = switch decodingError {
        case let .keyNotFound(key, context): "'\(key.stringValue)' is missing at \(at(context))"
        case let .typeMismatch(_, context): "unexpected type at \(at(context))"
        case let .valueNotFound(_, context): "an expected value was null at \(at(context))"
        case let .dataCorrupted(context): "malformed data at \(at(context))"
        @unknown default: "an unrecognized decoding failure"
        }
        return .decoding(model: model, detail: detail)
    }
}

struct APIClient: Sendable {
    let configuration: APIConfiguration
    private let session: URLSession

    init(configuration: APIConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    func bootstrap() async throws -> BootstrapResponse {
        try await get("api/mobile/v1/bootstrap")
    }

    func overview() async throws -> OverviewResponse {
        try await get("api/mobile/v1/overview")
    }

    func activity(archived: Bool) async throws -> ActivityList {
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/activity"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [.init(name: "archived", value: archived ? "true" : "false")]
        guard let url = components?.url else { throw APIError.invalidServerURL }
        return try await perform(makeRequest(url: url), as: ActivityList.self)
    }

    func updateActivity(id: String, action: String, budgetUsdLimit: Double? = nil) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/activity/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(
            ActivityActionBody(action: action, budgetUsdLimit: budgetUsdLimit)
        )
        _ = try await perform(request, as: OkPayload.self)
    }

    func archiveOldActivity() async throws {
        try await postCollectionAction(path: "activity", action: "archive-old")
    }

    func createGoal(_ goal: GoalMutation) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/goals"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(goal)
        _ = try await perform(request, as: GoalCreateReceipt.self)
    }

    func goals(archived: Bool) async throws -> GoalsDashboard {
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/goals"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [.init(name: "archived", value: archived ? "true" : "false")]
        guard let url = components?.url else { throw APIError.invalidServerURL }
        return try await perform(makeRequest(url: url), as: GoalsDashboard.self)
    }

    func updateGoal(id: String, goal: GoalMutation) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/goals/\(id)")
        )
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(goal)
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateGoal(id: String, action: String, status: String? = nil, enabled: Bool? = nil) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/goals/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(
            GoalActionBody(action: action, status: status, enabled: enabled)
        )
        _ = try await perform(request, as: OkPayload.self)
    }

    func archiveInactiveGoals() async throws {
        try await postCollectionAction(path: "goals", action: "archive-inactive")
    }

    func createChat() async throws -> ChatCreateReceipt {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/chats"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": "create"])
        return try await perform(request, as: ChatCreateReceipt.self)
    }

    func archiveInactiveChats() async throws {
        try await postCollectionAction(path: "chats", action: "archive-inactive")
    }

    func conversation(id: String) async throws -> ConversationView {
        try await get("api/mobile/v1/chats/\(id)")
    }

    func updateChat(id: String, action: String, modelId: String? = nil) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/chats/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(ChatActionBody(action: action, modelId: modelId))
        _ = try await perform(request, as: OkPayload.self)
    }

    func workspace() async throws -> WorkspaceResponse {
        try await get("api/mobile/v1/workspace")
    }

    func uploadDocument(data: Data, name: String, title: String, mime: String) async throws {
        let boundary = "AssistantBoundary-\(UUID().uuidString)"
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"title\"\r\n\r\n")
        append("\(title)\r\n")
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\n")
        append("Content-Type: \(mime)\r\n\r\n")
        body.append(data)
        append("\r\n--\(boundary)--\r\n")

        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/documents")
        )
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "content-type")
        request.httpBody = body
        _ = try await perform(request, as: OkPayload.self)
    }

    func deleteDocument(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/documents/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    func uploadImport(
        data: Data,
        name: String,
        source: String,
        voice: Bool,
        register: String
    ) async throws {
        let boundary = "AssistantImportBoundary-\(UUID().uuidString)"
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }
        for (field, value) in [
            ("source", source),
            ("voice", voice ? "1" : "0"),
            ("register", register),
        ] {
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"\(field)\"\r\n\r\n")
            append("\(value)\r\n")
        }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\n")
        append("Content-Type: text/plain\r\n\r\n")
        body.append(data)
        append("\r\n--\(boundary)--\r\n")

        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/imports")
        )
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "content-type")
        request.httpBody = body
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateImport(
        action: String,
        source: String,
        verdict: String? = nil,
        workspacePath: String? = nil
    ) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/imports"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(
            ImportActionBody(
                action: action,
                source: source,
                verdict: verdict,
                workspacePath: workspacePath
            )
        )
        _ = try await perform(request, as: OkPayload.self)
    }

    func createSkill(_ skill: SkillMutation) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/skills"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(skill)
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateSkill(id: String, skill: SkillMutation) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/skills/\(id)")
        )
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(skill)
        _ = try await perform(request, as: OkPayload.self)
    }

    func setSkillDeprecated(id: String, deprecated: Bool) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/skills/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["deprecated": deprecated])
        _ = try await perform(request, as: OkPayload.self)
    }

    func deleteSkill(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/skills/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateCostLimits(_ limits: CostLimitsMutation) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/costs"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(limits)
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateAnomaly(id: String, action: String) async throws {
        try await postWorkspaceAction(path: "anomalies/\(id)", action: action)
    }

    func updateImprovement(id: String, action: String) async throws {
        try await postWorkspaceAction(path: "improvements/\(id)", action: action)
    }

    func updateSettings(_ settings: AgentSettingsMutation) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/settings"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(settings)
        _ = try await perform(request, as: OkPayload.self)
    }

    func setScheduleEnabled(id: String, enabled: Bool) async throws {
        try await setEnabled(path: "settings/schedules/\(id)", enabled: enabled)
    }

    func setPolicyEnabled(id: String, enabled: Bool) async throws {
        try await setEnabled(path: "settings/policies/\(id)", enabled: enabled)
    }

    func deletePolicy(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/settings/policies/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    func mcpConnections() async throws -> McpConnectionsResponse {
        try await get("api/mobile/v1/mcp")
    }

    func createMcpConnection(name: String, endpoint: String, bearerToken: String?) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/mcp"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body = ["name": name, "endpoint": endpoint]
        if let bearerToken, !bearerToken.isEmpty { body["bearerToken"] = bearerToken }
        request.httpBody = try JSONEncoder().encode(body)
        _ = try await perform(request, as: EmptyPayload.self)
    }

    func updateMcpConnection(id: String, action: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/mcp/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": action])
        _ = try await perform(request, as: EmptyPayload.self)
    }

    func deleteMcpConnection(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/mcp/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    func createMemory(_ memory: MemoryMutation) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/memory"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(memory)
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateMemory(id: String, content: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/\(id)")
        )
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["content": content])
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateMemory(id: String, action: String, prominence: String? = nil) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body: [String: String] = ["action": action]
        if let prominence { body["prominence"] = prominence }
        request.httpBody = try JSONEncoder().encode(body)
        _ = try await perform(request, as: OkPayload.self)
    }

    func updateMemoryProfile(action: String) async throws {
        try await postWorkspaceAction(path: "memory/profile", action: action)
    }

    func createPerson(_ person: PersonMutation) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/people")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(person)
        _ = try await perform(request, as: PersonCreateReceipt.self)
    }

    func updatePerson(id: String, person: PersonMutation) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/people/\(id)")
        )
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(person)
        _ = try await perform(request, as: OkPayload.self)
    }

    func deletePerson(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/people/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    func personProfile(id: String) async throws -> PersonProfileResponse {
        try await get("api/mobile/v1/memory/people/\(id)")
    }

    func addOccasion(personId: String, occasion: OccasionMutation) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(
                path: "api/mobile/v1/memory/people/\(personId)/occasions"
            )
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(occasion)
        _ = try await perform(request, as: OkPayload.self)
    }

    func reviewOccasion(id: String, verdict: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/occasions/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["verdict": verdict])
        _ = try await perform(request, as: OkPayload.self)
    }

    func deleteOccasion(id: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/occasions/\(id)")
        )
        request.httpMethod = "DELETE"
        _ = try await perform(request, as: OkPayload.self)
    }

    func mergePerson(id: String, targetId: String) async throws {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/memory/people/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(
            PersonMergeBody(action: "merge", targetId: targetId)
        )
        _ = try await perform(request, as: OkPayload.self)
    }

    func updates(conversationId: String, taskId: String?, cursor: String?) async throws -> ChatUpdates {
        var components = URLComponents(
            url: configuration.baseURL.appending(path: "api/mobile/v1/chat/status"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            .init(name: "conversationId", value: conversationId),
            taskId.map { .init(name: "taskId", value: $0) },
            cursor.map { .init(name: "cursor", value: $0) }
        ].compactMap { $0 }
        guard let url = components?.url else { throw APIError.invalidServerURL }
        return try await perform(makeRequest(url: url), as: ChatUpdates.self)
    }

    func decideApproval(id: String, decision: String) async throws -> ApprovalResult {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/approvals/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["decision": decision])
        return try await perform(request, as: ApprovalResult.self)
    }

    func approveAndRemember(id: String) async throws -> ApprovalResult {
        try await approvalAction(id: id, body: ApprovalActionBody(action: "remember", payload: nil))
    }

    func editAndApprove(id: String, payload: JSONValue) async throws -> ApprovalResult {
        try await approvalAction(id: id, body: ApprovalActionBody(action: "edit", payload: payload))
    }

    /// Fire-and-forget ambient ping; callers use `try?` — a failed post only
    /// means the next foreground refresh carries the position.
    func postLocationPing(_ ping: LocationPingBody) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/location"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(ping)
        _ = try await perform(request, as: OkPayload.self)
    }

    /// Fire-and-forget APNs token registration; the next app launch retries,
    /// so a failed post only delays proactive pushes until then.
    func postDeviceToken(_ body: DeviceTokenBody) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/devices"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        _ = try await perform(request, as: OkPayload.self)
    }

    /// Foreground "wake" signal; the server dedupes its own reactions to it.
    func postForegroundActivity() async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/activity/foreground"))
        request.httpMethod = "POST"
        _ = try await perform(request, as: OkPayload.self)
    }

    func sendMessage(
        conversationId: String,
        text: String,
        autonomous: Bool,
        onDelta: @escaping @Sendable (String) async -> Void,
        onCue: @escaping @Sendable (MessagePart) async -> Void
    ) async throws -> SendReceipt {
        let url = configuration.baseURL.appending(path: "api/mobile/v1/chat")
        var request = makeRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let body = ChatRequest(
            conversationId: conversationId,
            autonomous: autonomous,
            messages: [.init(
                id: UUID().uuidString,
                role: "user",
                parts: [.init(type: "text", text: text)]
            )]
        )
        request.httpBody = try JSONEncoder().encode(body)

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        try await validate(http, data: nil)
        let taskId = http.value(forHTTPHeaderField: "x-async-task")
        let cursor = http.value(forHTTPHeaderField: "x-message-cursor")
        let responseConversation = http.value(forHTTPHeaderField: "x-conversation-id") ?? conversationId

        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if payload == "[DONE]" { break }
            guard let data = payload.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = object["type"] as? String else { continue }
            if type == "text-delta", taskId == nil, let delta = object["delta"] as? String {
                await onDelta(delta)
            } else if type.hasPrefix("data-") {
                let value = object["data"].map(JSONValue.init(any:)) ?? .null
                await onCue(.init(type: type, data: value))
            }
        }
        return .init(taskId: taskId, cursor: cursor, conversationId: responseConversation)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await perform(makeRequest(url: configuration.baseURL.appending(path: path)), as: T.self)
    }

    private func postWorkspaceAction(path: String, action: String) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/\(path)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": action])
        _ = try await perform(request, as: OkPayload.self)
    }

    private func postCollectionAction(path: String, action: String) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/\(path)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["action": action])
        _ = try await perform(request, as: OkPayload.self)
    }

    private func setEnabled(path: String, enabled: Bool) async throws {
        var request = makeRequest(url: configuration.baseURL.appending(path: "api/mobile/v1/\(path)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["enabled": enabled])
        _ = try await perform(request, as: OkPayload.self)
    }

    private func approvalAction(id: String, body: ApprovalActionBody) async throws -> ApprovalResult {
        var request = makeRequest(
            url: configuration.baseURL.appending(path: "api/mobile/v1/approvals/\(id)")
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await perform(request, as: ApprovalResult.self)
    }

    private func makeRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if !configuration.token.isEmpty {
            request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "authorization")
        }
        return request
    }

    private func perform<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        try await validate(http, data: data)
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIError.decodeFailure(error, as: type)
        }
    }

    private func validate(_ response: HTTPURLResponse, data: Data?) async throws {
        guard !(200..<300).contains(response.statusCode) else { return }
        if response.statusCode == 401 { throw APIError.unauthorized }
        let message: String
        if let data,
           let body = try? JSONDecoder().decode(ErrorBody.self, from: data) {
            message = body.error
        } else {
            message = HTTPURLResponse.localizedString(forStatusCode: response.statusCode)
        }
        throw APIError.server(status: response.statusCode, message: message)
    }
}

private struct ErrorBody: Decodable { let error: String }

private struct OkPayload: Decodable { let ok: Bool }
private struct EmptyPayload: Decodable {}

private struct ActivityActionBody: Encodable {
    let action: String
    let budgetUsdLimit: Double?
}

private struct GoalActionBody: Encodable {
    let action: String
    let status: String?
    let enabled: Bool?
}

private struct ChatActionBody: Encodable {
    let action: String
    let modelId: String?
}

private struct ApprovalActionBody: Encodable {
    let action: String
    let payload: JSONValue?
}

private struct ImportActionBody: Encodable {
    let action: String
    let source: String
    let verdict: String?
    let workspacePath: String?
}

/// Matches the server's LocationPingSchema (packages/core/src/memory/location.ts).
struct LocationPingBody: Encodable {
    let lat: Double
    let lng: Double
    let label: String
    let accuracyM: Int?
    let capturedAt: String
    let timeZone: String
    let source: String
}

/// Matches the server's DeviceTokenRegistrationSchema
/// (packages/core/src/push/devices.ts). Development-signed builds mint sandbox
/// tokens; TestFlight/App Store builds mint production ones.
struct DeviceTokenBody: Encodable {
    let token: String
    let platform: String = "ios"
    let environment: String = {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }()
}

struct GoalMutation: Encodable, Sendable {
    let title: String
    let description: String
    let priority: Int
    let targetDate: String?
    let progress: String
    let nextAction: String
    let mirrorToPrimary: Bool
}

struct SkillMutation: Encodable, Sendable {
    let name: String
    let preconditions: String
    let steps: String
    let gotchas: String
}

struct CostLimitsMutation: Encodable, Sendable {
    let taskDefault: String
    let daily: String
    let monthly: String
}

struct AgentSettingsMutation: Encodable, Sendable {
    let timezone: String
    let locale: String
    let signature: String
}

struct MemoryMutation: Encodable, Sendable {
    let content: String
    let domain: String
    let importance: Int
    let pinned: Bool
    let subjectContactId: String
}

struct PersonMutation: Encodable, Sendable {
    let name: String
    let relationship: String
    let aliases: String
}

struct OccasionMutation: Encodable, Sendable {
    let kind: String
    let label: String
    let month: String
    let day: String
    let year: String
    let leadDays: String
    let notes: String
}

private struct PersonMergeBody: Encodable {
    let action: String
    let targetId: String
}

private struct PersonCreateReceipt: Decodable {
    let contactId: String?
}

private struct GoalCreateReceipt: Decodable {
    let conversationId: String
    let taskId: String
    let messageCursor: String
}

struct ChatCreateReceipt: Decodable, Sendable {
    let conversationId: String
}

private struct ChatRequest: Encodable {
    let conversationId: String
    let autonomous: Bool
    let messages: [RequestMessage]
}

private struct RequestMessage: Encodable {
    let id: String
    let role: String
    let parts: [RequestPart]
}

private struct RequestPart: Encodable {
    let type: String
    let text: String
}

private extension JSONValue {
    init(any value: Any) {
        switch value {
        case let value as String: self = .string(value)
        case let value as Bool: self = .bool(value)
        case let value as NSNumber: self = .number(value.doubleValue)
        case let value as [String: Any]: self = .object(value.mapValues(JSONValue.init(any:)))
        case let value as [Any]: self = .array(value.map(JSONValue.init(any:)))
        default: self = .null
        }
    }
}
