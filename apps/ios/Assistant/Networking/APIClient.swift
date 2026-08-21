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

    var errorDescription: String? {
        switch self {
        case .invalidServerURL: "Enter a valid Assistant server URL."
        case .invalidResponse: "The server returned an unreadable response."
        case .unauthorized: "The access key was not accepted by this Assistant server."
        case let .server(_, message): message
        }
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

    func workspace() async throws -> WorkspaceResponse {
        try await get("api/mobile/v1/workspace")
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
            throw APIError.invalidResponse
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
