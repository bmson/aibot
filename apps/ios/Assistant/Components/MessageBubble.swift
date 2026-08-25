import SwiftUI
import UIKit
#if canImport(FoundationModels)
import FoundationModels
#endif

struct MessageBubble: View {
    let message: ChatMessage
    let isStreaming: Bool
    let openApprovals: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @ScaledMetric(relativeTo: .body) private var messageFontSize = 14.0
    @ScaledMetric(relativeTo: .body) private var bubbleHorizontalInset: CGFloat = 20
    @ScaledMetric(relativeTo: .body) private var bubbleVerticalInset: CGFloat = 15
    @State private var localOrientation: String?

    var body: some View {
        VStack(alignment: message.role == .assistant ? .leading : .trailing, spacing: 8) {
            if !message.text.isEmpty && !usesPrimaryCards {
                HStack {
                    if message.role == .user { Spacer(minLength: 40) }
                    messageText
                    if message.role == .assistant { Spacer(minLength: 40) }
                }
                if message.role == .assistant, !message.recallSources.isEmpty {
                    recallNote
                }
            } else if isStreaming {
                HStack {
                    thinkingIndicator
                    Spacer(minLength: 40)
                }
            }

            ForEach(decisionParts.indices, id: \.self) { index in
                let part = decisionParts[index]
                Button(action: openApprovals) {
                    decisionCard(part)
                }
                .buttonStyle(AssistantTactileButtonStyle(reduceMotion: reduceMotion, pressedScale: 0.985))
            }

            if message.role == .assistant, !responseCards.isEmpty {
                if let localOrientation {
                    Text(localOrientation)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AssistantTheme.stageStrong.opacity(0.9))
                        .padding(.horizontal, 6)
                }
                RichResponseCards(cards: responseCards)
            }
        }
        .task(id: message.id) {
            guard usesPrimaryCards, responseCards.count > 1 else { return }
            localOrientation = await PresentationCompanion.orientation(for: responseCards)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var messageText: some View {
        if message.role == .assistant {
            AssistantMarkdownView(
                source: message.text,
                baseFontSize: messageFontSize,
                ink: AssistantTheme.bubblePaperInk(for: colorScheme),
                mutedInk: AssistantTheme.inkMuted(for: colorScheme),
                codeSurface: AssistantTheme.sunken(for: colorScheme),
                accent: AssistantTheme.accent(for: colorScheme)
            )
                .textSelection(.enabled)
                .padding(.horizontal, resolvedBubbleHorizontalInset)
                .padding(.vertical, resolvedBubbleVerticalInset)
                .background(
                    AssistantTheme.bubblePaper(for: colorScheme),
                    in: RoundedRectangle(
                        cornerRadius: AssistantTheme.conversationCornerRadius,
                        style: .continuous
                    )
                )
                .overlay {
                    RoundedRectangle(
                        cornerRadius: AssistantTheme.conversationCornerRadius,
                        style: .continuous
                    )
                    .strokeBorder(
                        .white.opacity(
                            colorSchemeContrast == .increased
                                ? (colorScheme == .dark ? 0.34 : 0.86)
                                : (colorScheme == .dark ? 0.14 : 0.6)
                        ),
                        lineWidth: colorSchemeContrast == .increased ? 1.05 : 0.7
                    )
                }
                .shadow(
                    color: AssistantTheme.stageDepth.opacity(colorScheme == .dark ? 0.24 : 0.1),
                    radius: 11,
                    y: 5
                )
                .contextMenu {
                    Button {
                        UIPasteboard.general.string = message.text
                    } label: {
                        Label("Copy reply", systemImage: "doc.on.doc")
                    }
                }
        } else {
            Text(message.text)
                .font(.system(size: messageFontSize, weight: .regular))
                .tracking(-0.08)
                .foregroundStyle(
                    AssistantTheme.stageStrong.opacity(colorSchemeContrast == .increased ? 1 : 0.9)
                )
                .lineSpacing(2.5)
                .padding(.horizontal, resolvedBubbleHorizontalInset)
                .padding(.vertical, resolvedBubbleVerticalInset)
                .background(
                    .white.opacity(colorScheme == .dark ? 0.08 : 0.045),
                    in: RoundedRectangle(
                        cornerRadius: AssistantTheme.conversationCornerRadius,
                        style: .continuous
                    )
                )
                .overlay {
                    RoundedRectangle(
                        cornerRadius: AssistantTheme.conversationCornerRadius,
                        style: .continuous
                    )
                        .strokeBorder(
                            .white.opacity(colorSchemeContrast == .increased ? 0.48 : 0.22),
                            lineWidth: colorSchemeContrast == .increased ? 1.1 : 0.8
                        )
                }
                .contextMenu {
                    Button {
                        UIPasteboard.general.string = message.text
                    } label: {
                        Label("Copy message", systemImage: "doc.on.doc")
                    }
                }
        }
    }

    @ViewBuilder
    private var thinkingIndicator: some View {
        let dot = AssistantTheme.bubblePaperInk(for: colorScheme)
        let content = HStack(spacing: 5) {
            if reduceMotion {
                ForEach(0..<3, id: \.self) { _ in
                    Circle().fill(dot.opacity(0.46)).frame(width: 5, height: 5)
                }
            } else {
                PhaseAnimator([0, 1, 2]) { phase in
                    HStack(spacing: 5) {
                        ForEach(0..<3, id: \.self) { index in
                            Circle()
                                .fill(dot.opacity(index == phase ? 0.86 : 0.28))
                                .frame(width: 5, height: 5)
                                .offset(y: index == phase ? -1.5 : 0)
                        }
                    }
                } animation: { _ in
                    .easeInOut(duration: 0.42)
                }
            }
        }
        .frame(height: 18)
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .background(
            AssistantTheme.bubblePaper(for: colorScheme),
            in: Capsule()
        )
        .overlay {
            Capsule().strokeBorder(.white.opacity(colorScheme == .dark ? 0.08 : 0.58), lineWidth: 0.7)
        }
        .shadow(color: AssistantTheme.stageDepth.opacity(0.1), radius: 8, y: 3)

        content
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Assistant is thinking")
    }

    private var resolvedBubbleHorizontalInset: CGFloat {
        min(bubbleHorizontalInset, 28)
    }

    private var recallNote: some View {
        let sources = message.recallSources
        let graphCount = sources.filter(\.isKnowledgeGraph).count
        let title: String
        if graphCount == 0 {
            title = "Drawing on earlier chats"
        } else if graphCount == sources.count {
            title = "Drawing on knowledge graph"
        } else {
            title = "Drawing on graph and earlier chats"
        }
        return HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: graphCount > 0 ? "point.3.connected.trianglepath.dotted" : "clock.arrow.circlepath")
                .font(.caption2.weight(.semibold))
            Text(title)
                .font(.caption2.weight(.semibold))
            Text(sources.prefix(2).map(\.label).joined(separator: " · "))
                .font(.caption2)
                .lineLimit(1)
        }
        .foregroundStyle(AssistantTheme.stageStrong.opacity(0.72))
        .padding(.horizontal, 5)
        .accessibilityLabel("\(title): \(sources.map(\.label).joined(separator: ", "))")
    }

    private var resolvedBubbleVerticalInset: CGFloat {
        min(bubbleVerticalInset, 22)
    }

    private var decisionParts: [MessagePart] {
        message.parts.filter { ["approval", "budget-request"].contains($0.type) }
    }

    private var responseCards: [MessageResponseCard] {
        let explicit = message.parts.compactMap(MessageResponseCard.init(part:))
        return explicit.isEmpty ? MessageResponseCard.inferred(from: message.text) : explicit
    }

    private var usesPrimaryCards: Bool {
        // The local fallback intentionally has the same ownership as a server
        // card. Once a reply has a card-shaped presentation, showing the
        // source prose as a bubble as well creates a duplicate answer.
        message.role == .assistant && !responseCards.isEmpty
    }

    private func decisionCard(_ part: MessagePart) -> some View {
        let isApproval = part.type == "approval"
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: isApproval ? "checkmark.shield.fill" : "creditcard.trianglebadge.exclamationmark")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 38, height: 38)
                    .background(AssistantTheme.warning(for: colorScheme).opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(isApproval ? "Approval needed" : "Budget decision")
                        .font(.caption.weight(.bold))
                        .textCase(.uppercase)
                        .tracking(0.65)
                    Text(isApproval ? "The assistant is parked until you decide." : "The assistant needs more room to continue.")
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.warningInk(for: colorScheme).opacity(0.76))
                }
                Spacer(minLength: 4)
                if let code = part.shortCode, !code.isEmpty {
                    Text(code)
                        .font(.caption.monospaced().weight(.bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(AssistantTheme.warning(for: colorScheme).opacity(0.12), in: Capsule())
                }
            }

            Text(part.summary ?? "Review this action before the assistant continues.")
                .font(.subheadline.weight(.semibold))
                .multilineTextAlignment(.leading)
                .lineLimit(4)

            HStack(spacing: 8) {
                Text("Review decision")
                    .font(.caption.weight(.semibold))
                Spacer()
                Image(systemName: "arrow.right")
                    .font(.caption.weight(.bold))
            }
            .padding(.top, 1)
            .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
        }
        .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            AssistantTheme.warningSurface(for: colorScheme),
            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(
                    AssistantTheme.warning(for: colorScheme)
                        .opacity(colorSchemeContrast == .increased ? 0.58 : 0.3),
                    lineWidth: colorSchemeContrast == .increased ? 1.2 : 1
                )
        }
    }
}

/// The chat transport can send a `data-card` part when the result already has
/// shape. A conservative text fallback covers existing servers while keeping
/// unrelated prose as prose. Both paths share the same visual system below.
enum MessageResponseCard: Identifiable {
    struct AgendaItem: Identifiable {
        let time: String
        let title: String
        let detail: String
        var id: String { "\(time)-\(title)" }
    }

    struct WeatherDetail: Identifiable {
        let label: String
        let value: String
        var id: String { label.lowercased() }
    }

    struct Detail: Identifiable {
        let label: String
        let value: String
        var id: String { label.lowercased() }
    }

    struct EmailResult: Identifiable {
        let id: String
        let sender: String
        let recipient: String
        let subject: String
        let date: String
        let snippet: String
    }

    struct DocumentPassage: Identifiable {
        let id: String
        let document: String
        let source: String
        let snippet: String
        let similarity: Double?
    }

    struct DriveFile: Identifiable {
        let id: String
        let name: String
        let mimeType: String
        let modifiedTime: String
        let size: String
        let url: String
    }

    case agenda(title: String, subtitle: String, items: [AgendaItem])
    case event(id: String, time: String, title: String, location: String, attendees: [String], calendars: [String], linkLabel: String?, linkURL: String?)
    case weather(location: String, temperature: String, condition: String, details: [WeatherDetail])
    case duration(title: String, duration: String, detail: String?, confidence: String?)
    case reminder(id: String, title: String, schedule: String, nextFires: String, enabled: Bool)
    case emails(id: String, title: String, query: String, mailbox: String, complete: Bool, matchingMessagesEstimate: Int?, messages: [EmailResult])
    case documents(id: String, title: String, query: String, passages: [DocumentPassage])
    case drive(id: String, title: String, query: String, files: [DriveFile])
    case resource(id: String, resourceType: String, title: String, subtitle: String, details: [Detail], linkLabel: String?, linkURL: String?)
    case status(id: String, title: String, detail: String, symbol: String, details: [Detail])

    var id: String {
        switch self {
        case let .agenda(title, _, _): "agenda-\(title)"
        case let .event(id, _, _, _, _, _, _, _): id
        case let .weather(location, temperature, _, _): "weather-\(location)-\(temperature)"
        case let .duration(title, duration, _, _): "duration-\(title)-\(duration)"
        case let .reminder(id, _, _, _, _): id
        case let .emails(id, _, _, _, _, _, _): id
        case let .documents(id, _, _, _): id
        case let .drive(id, _, _, _): id
        case let .resource(id, _, _, _, _, _, _): id
        case let .status(id, _, _, _, _): id
        }
    }

    init?(part: MessagePart) {
        guard part.type == "data-card", case let .object(data)? = part.data,
              let kind = data["kind"]?.string else { return nil }
        switch kind {
        case "calendar-event":
            guard let title = data["title"]?.string, let time = data["time"]?.string else { return nil }
            let attendees = data["attendees"]?.arrayStrings ?? []
            let calendars = data["calendars"]?.arrayStrings ?? []
            let link = data["link"]?.objectValue
            self = .event(
                id: data["id"]?.string ?? "calendar-\(title)-\(time)", time: time, title: title,
                location: data["location"]?.string ?? "", attendees: attendees, calendars: calendars,
                linkLabel: link?["label"]?.string, linkURL: link?["url"]?.string
            )
        case "calendar", "agenda":
            let items: [AgendaItem] = {
                guard case let .array(values)? = data["items"] else { return [] }
                return values.compactMap { value in
                    guard case let .object(item) = value,
                          let time = item["time"]?.string,
                          let title = item["title"]?.string else { return nil }
                    return .init(time: time, title: title, detail: item["detail"]?.string ?? "")
                }
            }()
            guard !items.isEmpty else { return nil }
            self = .agenda(
                title: data["title"]?.string ?? "Today",
                subtitle: data["subtitle"]?.string ?? "Your schedule",
                items: Array(items.prefix(6))
            )
        case "weather":
            guard let temperature = data["temperature"]?.string,
                  let condition = data["condition"]?.string else { return nil }
            let details = Self.weatherDetails(from: data)
            self = .weather(
                location: data["location"]?.string ?? "Right now",
                temperature: temperature,
                condition: condition,
                details: details
            )
        case "duration", "time-estimate":
            guard let duration = data["duration"]?.string else { return nil }
            self = .duration(
                title: data["title"]?.string ?? "Time estimate",
                duration: duration,
                detail: data["detail"]?.string,
                confidence: data["confidence"]?.string
            )
        case "reminder":
            guard let title = data["title"]?.string else { return nil }
            self = .reminder(
                id: data["id"]?.string ?? "reminder-\(title)",
                title: title,
                schedule: data["schedule"]?.string ?? "",
                nextFires: data["nextFires"]?.string ?? "",
                enabled: data["enabled"]?.boolValue ?? true
            )
        case "email-results":
            let messages: [EmailResult] = {
                guard case let .array(values)? = data["messages"] else { return [] }
                return values.enumerated().compactMap { index, value in
                    guard case let .object(message) = value else { return nil }
                    return .init(
                        id: message["id"]?.string ?? "email-\(index)",
                        sender: message["sender"]?.string ?? "",
                        recipient: message["recipient"]?.string ?? "",
                        subject: message["subject"]?.string ?? "No subject",
                        date: message["date"]?.string ?? "",
                        snippet: message["snippet"]?.string ?? ""
                    )
                }
            }()
            self = .emails(
                id: data["id"]?.string ?? "email-results",
                title: data["title"]?.string ?? "Email results",
                query: data["query"]?.string ?? "",
                mailbox: data["mailbox"]?.string ?? "",
                complete: data["complete"]?.boolValue ?? true,
                matchingMessagesEstimate: data["matchingMessagesEstimate"]?.integerValue,
                messages: messages
            )
        case "document-results":
            let passages: [DocumentPassage] = {
                guard case let .array(values)? = data["passages"] else { return [] }
                return values.enumerated().compactMap { index, value in
                    guard case let .object(passage) = value else { return nil }
                    return .init(
                        id: passage["id"]?.string ?? "passage-\(index)",
                        document: passage["document"]?.string ?? "Untitled document",
                        source: passage["source"]?.string ?? "",
                        snippet: passage["snippet"]?.string ?? "",
                        similarity: passage["similarity"]?.numberValue
                    )
                }
            }()
            self = .documents(
                id: data["id"]?.string ?? "document-results",
                title: data["title"]?.string ?? "Document matches",
                query: data["query"]?.string ?? "",
                passages: passages
            )
        case "drive-results":
            let files: [DriveFile] = {
                guard case let .array(values)? = data["files"] else { return [] }
                return values.enumerated().compactMap { index, value in
                    guard case let .object(file) = value else { return nil }
                    return .init(
                        id: file["id"]?.string ?? "file-\(index)",
                        name: file["name"]?.string ?? "Untitled file",
                        mimeType: file["mimeType"]?.string ?? "",
                        modifiedTime: file["modifiedTime"]?.string ?? "",
                        size: file["size"]?.string ?? "",
                        url: file["url"]?.string ?? ""
                    )
                }
            }()
            self = .drive(
                id: data["id"]?.string ?? "drive-results",
                title: data["title"]?.string ?? "Drive files",
                query: data["query"]?.string ?? "",
                files: files
            )
        case "resource":
            guard let title = data["title"]?.string else { return nil }
            let link = data["link"]?.objectValue
            self = .resource(
                id: data["id"]?.string ?? "resource-\(title)",
                resourceType: data["resourceType"]?.string ?? "resource",
                title: title,
                subtitle: data["subtitle"]?.string ?? "Ready",
                details: Self.details(from: data),
                linkLabel: link?["label"]?.string,
                linkURL: link?["url"]?.string
            )
        case "status":
            guard let title = data["title"]?.string else { return nil }
            self = .status(
                id: data["id"]?.string ?? "status-\(title)",
                title: title,
                detail: data["detail"]?.string ?? "",
                symbol: data["symbol"]?.string ?? "checkmark.circle.fill",
                details: Self.details(from: data)
            )
        default:
            return nil
        }
    }

    static func inferred(from text: String) -> [Self] {
        let lower = text.lowercased()
        if let agenda = inferredAgenda(text, lower: lower) { return [agenda] }
        if let weather = inferredWeather(text, lower: lower) { return [weather] }
        if let duration = inferredDuration(text, lower: lower) { return [duration] }
        return []
    }

    private static func inferredAgenda(_ text: String, lower: String) -> Self? {
        guard ["calendar", "agenda", "schedule", "today"].contains(where: lower.contains) else { return nil }
        let pattern = #"(?m)^\s*(?:[-•*]|\d+\.)?\s*(\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)?(?:\s*[–-]\s*\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)?)?)\s*(?:[—–:-]\s*|\s{2,})(.{3,90})$"#
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        let items = expression.matches(in: text, range: range).compactMap { match -> AgendaItem? in
            guard let timeRange = Range(match.range(at: 1), in: text),
                  let titleRange = Range(match.range(at: 2), in: text) else { return nil }
            let rawTitle = String(text[titleRange]).trimmingCharacters(in: .whitespacesAndNewlines)
            let components = rawTitle.split(separator: "·", maxSplits: 1).map(String.init)
            return .init(
                time: String(text[timeRange]).uppercased(),
                title: components[0],
                detail: components.count > 1 ? components[1] : ""
            )
        }
        guard !items.isEmpty else { return nil }
        return .agenda(title: lower.contains("today") ? "Today" : "Your schedule", subtitle: "What is lined up", items: Array(items.prefix(6)))
    }

    private static func inferredWeather(_ text: String, lower: String) -> Self? {
        let weatherTerms = ["weather", "forecast", "sunny", "cloudy", "rain", "snow", "wind", "humidity"]
        guard weatherTerms.contains(where: lower.contains) else { return nil }
        let temperaturePattern = #"(?<!\d)(-?\d{1,3})\s*°?\s*([FC])\b"#
        guard let expression = try? NSRegularExpression(pattern: temperaturePattern, options: [.caseInsensitive]),
              let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let value = Range(match.range(at: 1), in: text),
              let unit = Range(match.range(at: 2), in: text) else { return nil }
        let temperature = weatherField(named: "temperature", in: text)
            ?? "\(text[value])°\(text[unit].uppercased())"
        let condition = weatherField(named: "conditions", in: text)
            ?? ["rain", "snow", "cloud", "sun", "wind", "fog", "storm"]
                .first(where: lower.contains)
                .map { $0 == "sun" ? "Sunny" : $0.capitalized }
            ?? "Current conditions"
        return .weather(
            location: weatherLocation(in: text) ?? "Right now",
            temperature: temperature,
            condition: condition,
            details: weatherDetails(in: text)
        )
    }

    /// Keep every weather metric the reply provides in the structured surface.
    /// The primary temperature and current condition already have dedicated
    /// visual positions, so the list begins with the day's range and secondary
    /// measurements instead of repeating those two fields.
    private static func weatherDetails(in text: String) -> [WeatherDetail] {
        let fields: [(label: String, names: [String])] = [
            ("Today", ["today's range", "today’s range"]),
            ("Wind", ["wind"]),
            ("Humidity", ["humidity"]),
            ("Rain chance", ["rain chance", "precipitation chance"]),
            ("Feels like", ["feels like"]),
            ("Visibility", ["visibility"]),
            ("UV index", ["uv index", "uv"]),
            ("Pressure", ["pressure"]),
            ("Updated", ["as of"]),
            ("Source", ["source"]),
        ]
        let knownDetails: [WeatherDetail] = fields.compactMap { field in
            guard let value = field.names.lazy.compactMap({ weatherField(named: $0, in: text) }).first else {
                return nil
            }
            return WeatherDetail(label: field.label, value: value)
        }
        return knownDetails + markdownWeatherDetails(
            in: text,
            excluding: Set(knownDetails.map { $0.label.lowercased() })
                .union(fields.flatMap(\.names).map { $0.lowercased() })
                .union(["temperature", "conditions"])
        )
    }

    /// New cards carry an explicit list of weather metrics. Older server
    /// cards remain useful by promoting their range and one legacy detail.
    private static func weatherDetails(from data: [String: JSONValue]) -> [WeatherDetail] {
        if case let .array(values)? = data["details"] {
            let details = values.compactMap { value -> WeatherDetail? in
                guard case let .object(detail) = value,
                      let label = detail["label"]?.string,
                      let value = detail["value"]?.string,
                      !label.isEmpty, !value.isEmpty else { return nil }
                return .init(label: label, value: value)
            }
            if !details.isEmpty { return details }
        }

        var details: [WeatherDetail] = []
        if let low = data["low"]?.string, let high = data["high"]?.string {
            details.append(.init(label: "Today", value: "\(low)–\(high)"))
        }
        if let detail = data["detail"]?.string, !detail.isEmpty {
            details.append(.init(label: "Details", value: detail))
        }
        return details
    }

    private static func details(from data: [String: JSONValue]) -> [Detail] {
        guard case let .array(values)? = data["details"] else { return [] }
        return values.compactMap { value in
            guard case let .object(detail) = value,
                  let label = detail["label"]?.string,
                  let value = detail["value"]?.string,
                  !label.isEmpty, !value.isEmpty else { return nil }
            return .init(label: label, value: value)
        }
    }

    private static func weatherLocation(in text: String) -> String? {
        let pattern = #"(?i)\bweather\s+for\s+(.+?)(?:\s+as\s+of\b|[\r\n:])"#
        guard let expression = try? NSRegularExpression(pattern: pattern),
              let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let locationRange = Range(match.range(at: 1), in: text) else { return nil }
        let location = String(text[locationRange])
            .replacingOccurrences(of: "**", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return location.isEmpty ? nil : location
    }

    /// Preserves less-common metrics such as cloud cover or dew point without
    /// requiring the app to be updated for every weather provider field.
    private static func markdownWeatherDetails(in text: String, excluding labels: Set<String>) -> [WeatherDetail] {
        var details: [WeatherDetail] = []
        for line in text.components(separatedBy: .newlines) where line.contains("**") {
            guard let colon = line.firstIndex(of: ":"),
                  let firstLetter = line[..<colon].firstIndex(where: { $0.isLetter }) else { continue }
            let label = String(line[firstLetter..<colon])
                .replacingOccurrences(of: "**", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = label.lowercased()
            let value = String(line[line.index(after: colon)...])
                .replacingOccurrences(of: "**", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !label.isEmpty, !value.isEmpty, !labels.contains(normalized) else { continue }
            details.append(.init(label: label, value: value))
        }
        return details
    }

    /// Finds a labeled Markdown field in a conventional assistant response,
    /// such as `- **Conditions:** Partly cloudy`. The detail itself stays in
    /// Markdown so the card renderer can preserve its inline emphasis.
    private static func weatherField(named name: String, in text: String) -> String? {
        if name == "as of" {
            let timestampPattern = #"(?i)\bas\s+of\s+(\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)(?:\s+[A-Z]{2,5})?)"#
            guard let expression = try? NSRegularExpression(pattern: timestampPattern),
                  let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
                  let valueRange = Range(match.range(at: 1), in: text) else { return nil }
            return String(text[valueRange]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let pattern = #"(?im)\b\*{0,2}"# + NSRegularExpression.escapedPattern(for: name) + #"\*{0,2}\s*:\s*([^\r\n]+)"#
        guard let expression = try? NSRegularExpression(pattern: pattern),
              let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let valueRange = Range(match.range(at: 1), in: text) else { return nil }
        var value = String(text[valueRange])
            .replacingOccurrences(of: "**", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if name == "source" {
            value = value.trimmingCharacters(in: CharacterSet(charactersIn: "() "))
        }
        return value.isEmpty ? nil : value
    }

    private static func inferredDuration(_ text: String, lower: String) -> Self? {
        guard ["take", "takes", "estimate", "estimated", "roughly", "about"].contains(where: lower.contains) else { return nil }
        let pattern = #"\b(?:about|around|roughly|approximately|estimated?\s*(?:at|time)?\s*(?:of)?|take[s]?\s*)?\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?)\b"#
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let number = Range(match.range(at: 1), in: text),
              let unit = Range(match.range(at: 2), in: text) else { return nil }
        return .duration(
            title: "Time estimate",
            duration: "\(text[number]) \(text[unit])",
            detail: "A practical planning estimate from this response.",
            confidence: nil
        )
    }
}

private struct RichResponseCards: View {
    private struct EventRow: Identifiable {
        let id: String
        let time: String
        let title: String
        let location: String
        let attendees: [String]
        let calendar: String
        let linkURL: String?
    }

    let cards: [MessageResponseCard]

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    /// Calendar responses arrive as individual, durable data cards. Present
    /// consecutive events as one paper schedule so a weekly answer scans like
    /// an itinerary instead of a column of unrelated tiles.
    private var eventRows: [EventRow] {
        cards.compactMap { card in
            guard case let .event(id, time, title, location, attendees, calendars, _, linkURL) = card else {
                return nil
            }
            return .init(
                id: id,
                time: time,
                title: title,
                location: location,
                attendees: attendees,
                calendar: calendars.first ?? "",
                linkURL: linkURL
            )
        }
    }

    private var nonEventCards: [MessageResponseCard] {
        cards.filter { card in
            if case .event = card { return false }
            return true
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !eventRows.isEmpty {
                eventListCard(eventRows)
            }
            ForEach(nonEventCards) { card in
                switch card {
                case let .agenda(title, subtitle, items):
                    agendaCard(title: title, subtitle: subtitle, items: items)
                case .event:
                    EmptyView()
                case let .weather(location, temperature, condition, details):
                    weatherCard(location: location, temperature: temperature, condition: condition, details: details)
                case let .duration(title, duration, detail, confidence):
                    durationCard(title: title, duration: duration, detail: detail, confidence: confidence)
                case let .reminder(_, title, schedule, nextFires, enabled):
                    reminderCard(title: title, schedule: schedule, nextFires: nextFires, enabled: enabled)
                case let .emails(_, title, query, mailbox, complete, estimate, messages):
                    emailResultsCard(title: title, query: query, mailbox: mailbox, complete: complete, estimate: estimate, messages: messages)
                case let .documents(_, title, query, passages):
                    documentResultsCard(title: title, query: query, passages: passages)
                case let .drive(_, title, query, files):
                    driveResultsCard(title: title, query: query, files: files)
                case let .resource(_, resourceType, title, subtitle, details, linkLabel, linkURL):
                    resourceCard(resourceType: resourceType, title: title, subtitle: subtitle, details: details, linkLabel: linkLabel, linkURL: linkURL)
                case let .status(_, title, detail, symbol, details):
                    statusCard(title: title, detail: detail, symbol: symbol, details: details)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private func eventListCard(_ events: [EventRow]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(event.time)
                            .font(.subheadline.monospacedDigit().weight(.semibold))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        Spacer(minLength: 12)
                        if !event.calendar.isEmpty {
                            Text(event.calendar)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
                                .lineLimit(1)
                        }
                    }
                    Text(AssistantMarkdown.inlineAttributed(event.title))
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        let detail = [event.location, event.attendees.isEmpty ? "" : event.attendees.joined(separator: ", ")]
                            .filter { !$0.isEmpty }
                            .joined(separator: " · ")
                        if !detail.isEmpty {
                            Text(AssistantMarkdown.inlineAttributed(detail))
                                .font(.subheadline)
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 6)
                        if let linkURL = event.linkURL, let url = URL(string: linkURL) {
                            Link(destination: url) {
                                Image(systemName: "arrow.up.right")
                                    .font(.title3.weight(.medium))
                                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            }
                            .accessibilityLabel("Open \(event.title)")
                        }
                    }
                }
                .padding(.vertical, index == 0 ? 0 : 21)
                if index < events.count - 1 {
                    Divider()
                        .overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                        .padding(.top, 21)
                }
            }
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 24)
    }

    private func agendaCard(title: String, subtitle: String, items: [MessageResponseCard.AgendaItem]) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(AssistantMarkdown.inlineAttributed(title))
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    Text(AssistantMarkdown.inlineAttributed(subtitle))
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
                Spacer()
                Text("\(items.count) \(items.count == 1 ? "event" : "events")")
                    .font(.caption.monospacedDigit().weight(.medium))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
            }

            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    HStack(alignment: .top, spacing: 12) {
                        Text(item.time)
                            .font(.subheadline.monospacedDigit().weight(.semibold))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            .frame(width: usesAccessibilityLayout ? 90 : 80, alignment: .leading)

                        VStack(alignment: .leading, spacing: 3) {
                            Text(AssistantMarkdown.inlineAttributed(item.title))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                .fixedSize(horizontal: false, vertical: true)
                            if !item.detail.isEmpty {
                                Text(AssistantMarkdown.inlineAttributed(item.detail))
                                    .font(.subheadline)
                                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.bottom, index < items.count - 1 ? 18 : 0)
                }
            }
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 24)
    }

    private func weatherCard(
        location: String,
        temperature: String,
        condition: String,
        details: [MessageResponseCard.WeatherDetail]
    ) -> some View {
        VStack(alignment: .leading, spacing: 17) {
            Text(AssistantMarkdown.inlineAttributed(location))
                .font(.subheadline)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            HStack(alignment: .center, spacing: 15) {
                Text(temperature)
                    .font(.system(size: 47, weight: .regular, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    .minimumScaleFactor(0.76)
                Text(AssistantMarkdown.inlineAttributed(condition))
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Image(systemName: weatherSymbol(condition))
                    .font(.system(size: 29, weight: .medium))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                    .frame(width: 58, height: 58)
                    .background(AssistantTheme.sunken(for: colorScheme), in: Circle())
            }
            if !details.isEmpty {
                Divider().overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                LazyVGrid(
                    columns: usesAccessibilityLayout
                        ? [GridItem(.flexible())]
                        : [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12), GridItem(.flexible())],
                    alignment: .leading,
                    spacing: 12
                ) {
                    ForEach(details) { detail in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(detail.label)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                            Text(AssistantMarkdown.inlineAttributed(detail.value))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 24)
    }

    private func durationCard(title: String, duration: String, detail: String?, confidence: String?) -> some View {
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: "timer")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .frame(width: 44, height: 44)
                .background(AssistantTheme.accent(for: colorScheme).opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(title.uppercased())
                    .font(.caption2.weight(.bold))
                    .tracking(0.7)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                Text(duration)
                    .font(.title3.monospacedDigit().weight(.semibold))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            if let confidence, !confidence.isEmpty {
                Text(confidence)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
            }
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 20)
    }

    private func reminderCard(title: String, schedule: String, nextFires: String, enabled: Bool) -> some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: enabled ? "bell.badge.fill" : "bell.slash.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .frame(width: 42, height: 42)
                .background(AssistantTheme.accent(for: colorScheme).opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            VStack(alignment: .leading, spacing: 5) {
                Text(enabled ? "REMINDER" : "REMINDER PAUSED")
                    .font(.caption2.weight(.bold))
                    .tracking(0.7)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                Text(AssistantMarkdown.inlineAttributed(title))
                    .font(.headline)
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                if !nextFires.isEmpty {
                    Label(cardDate(nextFires), systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
                if !schedule.isEmpty {
                    Text(schedule)
                        .font(.caption.monospaced())
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
            }
            Spacer(minLength: 0)
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 20)
    }

    private func emailResultsCard(
        title: String,
        query: String,
        mailbox: String,
        complete: Bool,
        estimate: Int?,
        messages: [MessageResponseCard.EmailResult]
    ) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            resultHeader(
                title: title,
                subtitle: query.isEmpty ? mailbox : query,
                countLabel: emailCountLabel(messages: messages, estimate: estimate, complete: complete)
            )
            if messages.isEmpty {
                Text("No matching messages.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(AssistantMarkdown.inlineAttributed(message.sender.isEmpty ? message.recipient : message.sender))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                    .lineLimit(1)
                                Spacer(minLength: 4)
                                if !message.date.isEmpty {
                                    Text(cardDate(message.date))
                                        .font(.caption2)
                                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                        .lineLimit(1)
                                }
                            }
                            Text(AssistantMarkdown.inlineAttributed(message.subject))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                .fixedSize(horizontal: false, vertical: true)
                            if !message.snippet.isEmpty {
                                Text(AssistantMarkdown.inlineAttributed(message.snippet))
                                    .font(.caption)
                                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(.vertical, index == 0 ? 0 : 12)
                        if index < messages.count - 1 {
                            Divider().overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                        }
                    }
                }
            }
        }
        .resultCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast)
    }

    private func documentResultsCard(
        title: String,
        query: String,
        passages: [MessageResponseCard.DocumentPassage]
    ) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            resultHeader(title: title, subtitle: query, countLabel: "\(passages.count) \(passages.count == 1 ? "match" : "matches")")
            if passages.isEmpty {
                Text("No matching passages.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(passages.enumerated()), id: \.element.id) { index, passage in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(AssistantMarkdown.inlineAttributed(passage.document))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 6)
                                if let similarity = passage.similarity {
                                    Text("\(Int((similarity * 100).rounded()))% match")
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                }
                            }
                            if !passage.source.isEmpty {
                                Text(AssistantMarkdown.inlineAttributed(passage.source))
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            }
                            if !passage.snippet.isEmpty {
                                Text(AssistantMarkdown.inlineAttributed(passage.snippet))
                                    .font(.caption)
                                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(.vertical, index == 0 ? 0 : 12)
                        if index < passages.count - 1 {
                            Divider().overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                        }
                    }
                }
            }
        }
        .resultCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast)
    }

    private func driveResultsCard(
        title: String,
        query: String,
        files: [MessageResponseCard.DriveFile]
    ) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            resultHeader(title: title, subtitle: query, countLabel: "\(files.count) \(files.count == 1 ? "file" : "files")")
            if files.isEmpty {
                Text("No matching files.")
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(files.enumerated()), id: \.element.id) { index, file in
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: fileSymbol(file.mimeType))
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: 4) {
                                if let url = URL(string: file.url) {
                                    Link(destination: url) {
                                        Text(AssistantMarkdown.inlineAttributed(file.name))
                                            .font(.subheadline.weight(.semibold))
                                    }
                                } else {
                                    Text(AssistantMarkdown.inlineAttributed(file.name))
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                                }
                                let metadata = [file.mimeType, file.size, file.modifiedTime.isEmpty ? "" : cardDate(file.modifiedTime)]
                                    .filter { !$0.isEmpty }
                                    .joined(separator: " · ")
                                if !metadata.isEmpty {
                                    Text(metadata)
                                        .font(.caption)
                                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, index == 0 ? 0 : 12)
                        if index < files.count - 1 {
                            Divider().overlay(AssistantTheme.inkMuted(for: colorScheme).opacity(0.16))
                        }
                    }
                }
            }
        }
        .resultCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast)
    }

    private func resourceCard(
        resourceType: String,
        title: String,
        subtitle: String,
        details: [MessageResponseCard.Detail],
        linkLabel: String?,
        linkURL: String?
    ) -> some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: resourceSymbol(resourceType))
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .frame(width: 42, height: 42)
                .background(AssistantTheme.accent(for: colorScheme).opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            VStack(alignment: .leading, spacing: 5) {
                Text(subtitle.uppercased())
                    .font(.caption2.weight(.bold))
                    .tracking(0.7)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                Text(AssistantMarkdown.inlineAttributed(title))
                    .font(.headline)
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
                detailRows(details)
                if let linkURL, let url = URL(string: linkURL) {
                    Link(linkLabel ?? "Open", destination: url)
                        .font(.caption.weight(.semibold))
                }
            }
            Spacer(minLength: 0)
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 20)
    }

    private func statusCard(
        title: String,
        detail: String,
        symbol: String,
        details: [MessageResponseCard.Detail]
    ) -> some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .frame(width: 42, height: 42)
                .background(AssistantTheme.accent(for: colorScheme).opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            VStack(alignment: .leading, spacing: 5) {
                Text("COMPLETE")
                    .font(.caption2.weight(.bold))
                    .tracking(0.7)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                Text(AssistantMarkdown.inlineAttributed(title))
                    .font(.headline)
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                if !detail.isEmpty {
                    Text(AssistantMarkdown.inlineAttributed(detail))
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
                detailRows(details)
            }
            Spacer(minLength: 0)
        }
        .responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 20)
    }

    @ViewBuilder
    private func detailRows(_ details: [MessageResponseCard.Detail]) -> some View {
        if !details.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(details) { detail in
                    Text("\(detail.label): ")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    + Text(AssistantMarkdown.inlineAttributed(detail.value))
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                }
            }
        }
    }

    private func resultHeader(title: String, subtitle: String, countLabel: String) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title.uppercased())
                    .font(.caption2.weight(.bold))
                    .tracking(0.8)
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                if !subtitle.isEmpty {
                    Text(AssistantMarkdown.inlineAttributed(subtitle))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            Text(countLabel)
                .font(.caption.monospacedDigit().weight(.semibold))
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
        }
    }

    private func emailCountLabel(messages: [MessageResponseCard.EmailResult], estimate: Int?, complete: Bool) -> String {
        if !complete { return "Partial · \(estimate ?? messages.count)" }
        return "\(messages.count) \(messages.count == 1 ? "email" : "emails")"
    }

    private func cardDate(_ value: String) -> String {
        let formatter = ISO8601DateFormatter()
        let fractionalFormatter = ISO8601DateFormatter()
        fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: value) ?? fractionalFormatter.date(from: value) else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func resourceSymbol(_ resourceType: String) -> String {
        switch resourceType {
        case "document": "doc.text.fill"
        case "spreadsheet": "tablecells.fill"
        default: "doc.fill"
        }
    }

    private func fileSymbol(_ mimeType: String) -> String {
        let lower = mimeType.lowercased()
        if lower.contains("pdf") { return "doc.richtext.fill" }
        if lower.contains("sheet") || lower.contains("spreadsheet") { return "tablecells.fill" }
        if lower.contains("presentation") || lower.contains("slide") { return "rectangle.on.rectangle.angled" }
        if lower.contains("image") { return "photo.fill" }
        return "doc.fill"
    }

    private func weatherSymbol(_ condition: String) -> String {
        let lower = condition.lowercased()
        if lower.contains("rain") || lower.contains("storm") { return "cloud.rain.fill" }
        if lower.contains("snow") { return "cloud.snow.fill" }
        if lower.contains("cloud") { return "cloud.fill" }
        if lower.contains("wind") { return "wind" }
        return "sun.max.fill"
    }
}

private extension View {
    func responseCardSurface(
        colorScheme: ColorScheme,
        colorSchemeContrast: ColorSchemeContrast,
        inset: CGFloat
    ) -> some View {
        padding(inset)
            .background(AssistantTheme.raised(for: colorScheme), in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .stroke(
                        AssistantTheme.ink(for: colorScheme).opacity(colorSchemeContrast == .increased ? 0.22 : 0.09),
                        lineWidth: 1
                    )
            }
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.16 : 0.07), radius: 14, y: 5)
    }

    func resultCardSurface(colorScheme: ColorScheme, colorSchemeContrast: ColorSchemeContrast) -> some View {
        responseCardSurface(colorScheme: colorScheme, colorSchemeContrast: colorSchemeContrast, inset: 24)
    }
}

private extension JSONValue {
    var objectValue: [String: JSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }

    var arrayStrings: [String]? {
        guard case let .array(value) = self else { return nil }
        return value.compactMap(\.string)
    }

    var boolValue: Bool? {
        guard case let .bool(value) = self else { return nil }
        return value
    }

    var numberValue: Double? {
        guard case let .number(value) = self else { return nil }
        return value
    }

    var integerValue: Int? {
        guard let numberValue, numberValue.rounded() == numberValue else { return nil }
        return Int(numberValue)
    }
}

/// A best-effort local copy pass. It receives only the already-renderable card
/// labels and disappears on any device/model failure; it cannot affect facts.
private enum PresentationCompanion {
    static func orientation(for cards: [MessageResponseCard]) async -> String? {
        let source = cards.map { card in
            switch card {
            case let .event(_, time, title, location, _, _, _, _): "Event: \(time), \(title), \(location)"
            case let .weather(location, temperature, condition, details):
                "Weather: \(location), \(condition), \(temperature), \(details.map { "\($0.label): \($0.value)" }.joined(separator: ", "))"
            case let .duration(title, duration, detail, _): "Estimate: \(title), \(duration), \(detail ?? "")"
            case let .agenda(title, subtitle, items): "Agenda: \(title), \(subtitle), \(items.map(\.title).joined(separator: ", "))"
            case let .reminder(_, title, schedule, nextFires, enabled): "Reminder: \(title), \(schedule), \(nextFires), \(enabled ? "active" : "paused")"
            case let .emails(_, title, query, _, _, _, messages): "Email results: \(title), \(query), \(messages.map(\.subject).joined(separator: ", "))"
            case let .documents(_, title, query, passages): "Document matches: \(title), \(query), \(passages.map(\.document).joined(separator: ", "))"
            case let .drive(_, title, query, files): "Drive files: \(title), \(query), \(files.map(\.name).joined(separator: ", "))"
            case let .resource(_, _, title, subtitle, details, _, _): "Resource: \(subtitle), \(title), \(details.map { "\($0.label): \($0.value)" }.joined(separator: ", "))"
            case let .status(_, title, detail, _, details): "Status: \(title), \(detail), \(details.map { "\($0.label): \($0.value)" }.joined(separator: ", "))"
            }
        }.joined(separator: "\n")
        guard source.count <= 1_200 else { return nil }
        #if canImport(FoundationModels)
        guard #available(iOS 26, *), SystemLanguageModel.default.availability == .available else { return nil }
        do {
            let session = LanguageModelSession(instructions: "Write one calm planning sentence of at most 120 characters. Use only the supplied facts. Do not add names, numbers, dates, recommendations, links, or claims about actions.")
            let response = try await session.respond(to: source)
            return validated(response.content, source: source)
        } catch {
            return nil
        }
        #else
        return nil
        #endif
    }

    private static func validated(_ candidate: String, source: String) -> String? {
        let text = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 120, !text.contains("\n") else { return nil }
        // Numbers are high-risk in a planning line: every one must be literally
        // present in the evidence-derived card text.
        let numbers = text.split { !$0.isNumber }.filter { !$0.isEmpty }
        guard numbers.allSatisfy({ source.contains($0) }) else { return nil }
        return text
    }
}

/// A lightweight GFM-inspired block parser. Keeping this local avoids a dependency while
/// making partially streamed replies render gracefully as they arrive.
enum AssistantMarkdown {
    /// Compact structured cards can still include a short Markdown label from
    /// a legacy/plain-text reply. Parse that inline fragment instead of
    /// exposing delimiter characters such as `**` in the card.
    static func inlineAttributed(_ source: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: source, options: options))
            ?? AttributedString(source)
    }

    enum Block: Hashable {
        case heading(level: Int, text: String)
        case paragraph(String)
        /// Bullets, numbered items, and task checkboxes in one tree — LLM
        /// output nests and mixes them freely, so the renderer recurses
        /// rather than committing to a flat list of a single kind.
        case list([ListNode])
        case quote(String)
        case code(language: String?, text: String)
        case divider
        case table(headers: [String], rows: [[String]])
    }

    enum ListMarker: Hashable {
        case bullet
        case number(Int)
        case task(isComplete: Bool)
    }

    /// AttributedString folds CommonMark soft breaks into spaces, but a chat
    /// reply means a single line break literally — one found email per line
    /// must not collapse into a block. Convert to GFM hard breaks, which do
    /// survive the conversion as real newlines.
    static func preservingSoftBreaks(_ source: String) -> String {
        source.replacingOccurrences(of: "\n", with: "\\\n")
    }

    struct ListNode: Hashable {
        let marker: ListMarker
        let text: String
        let children: [ListNode]
    }

    /// One raw parsed list line: its indent depth, marker, and text.
    private struct RawListItem {
        let indent: Int
        let marker: ListMarker
        let text: String
    }

    static func blocks(in source: String) -> [Block] {
        let lines = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
        var result: [Block] = []
        var index = 0

        while index < lines.count {
            let line = lines[index]

            if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                index += 1
                continue
            }

            if isCodeFence(line) {
                let language = codeFenceLanguage(in: line)
                index += 1
                var codeLines: [String] = []

                while index < lines.count, !isCodeFence(lines[index]) {
                    codeLines.append(lines[index])
                    index += 1
                }

                if index < lines.count {
                    index += 1
                }

                let code = codeLines.joined(separator: "\n")
                result.append(.code(language: language, text: code))
                continue
            }

            if let heading = heading(in: line) {
                result.append(.heading(level: heading.level, text: heading.text))
                index += 1
                continue
            }

            if index + 1 < lines.count,
               isSetextUnderline(lines[index + 1]),
               !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let level = lines[index + 1].trimmingCharacters(in: .whitespaces).first == "=" ? 1 : 2
                result.append(.heading(level: level, text: line.trimmingCharacters(in: .whitespaces)))
                index += 2
                continue
            }

            if isDivider(line) {
                result.append(.divider)
                index += 1
                continue
            }

            if let table = table(at: index, in: lines) {
                result.append(.table(headers: table.headers, rows: table.rows))
                index = table.endIndex
                continue
            }

            if quoteLineContent(line) != nil {
                var quoteLines: [String] = []
                while index < lines.count, let content = quoteLineContent(lines[index]) {
                    quoteLines.append(content)
                    index += 1
                }
                result.append(.quote(quoteLines.joined(separator: "\n")))
                continue
            }

            if listItem(in: line) != nil {
                var rawItems: [RawListItem] = []
                while index < lines.count, let item = listItem(in: lines[index]) {
                    rawItems.append(item)
                    index += 1
                }
                var cursor = 0
                result.append(.list(parseListLevel(rawItems, index: &cursor, indent: rawItems.first?.indent ?? 0)))
                continue
            }

            var paragraphLines: [String] = []
            while index < lines.count,
                  !lines[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !startsBlock(at: index, in: lines) {
                paragraphLines.append(lines[index].trimmingCharacters(in: .whitespaces))
                index += 1
            }

            if paragraphLines.isEmpty {
                // Avoid an infinite loop for a malformed, unsupported construct.
                paragraphLines.append(line.trimmingCharacters(in: .whitespaces))
                index += 1
            }
            // Chat convention, not strict GFM: a single line break in a reply
            // is a real break, kept as "\n" here and rendered as one via
            // preservingSoftBreaks at the view. Folding to a space collapsed
            // structured answers — one found email per line — into a block.
            result.append(.paragraph(paragraphLines.joined(separator: "\n")))
        }

        return result
    }

    private static func startsBlock(at index: Int, in lines: [String]) -> Bool {
        let line = lines[index]
        return isCodeFence(line)
            || heading(in: line) != nil
            || isDivider(line)
            || quoteLineContent(line) != nil
            || listItem(in: line) != nil
            || table(at: index, in: lines) != nil
    }

    private static func isCodeFence(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix("```")
    }

    private static func codeFenceLanguage(in line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard isCodeFence(trimmed) else { return nil }
        let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
        return language.isEmpty ? nil : language
    }

    private static func heading(in line: String) -> (level: Int, text: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let hashes = trimmed.prefix { $0 == "#" }
        guard !hashes.isEmpty, hashes.count <= 6 else { return nil }
        let remainder = trimmed.dropFirst(hashes.count)
        guard remainder.first?.isWhitespace == true else { return nil }
        let text = remainder.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        return (hashes.count, text)
    }

    private static func isSetextUnderline(_ line: String) -> Bool {
        let compact = line.filter { !$0.isWhitespace }
        guard compact.count >= 3, let first = compact.first, first == "=" || first == "-" else {
            return false
        }
        return compact.allSatisfy { $0 == first }
    }

    private static func isDivider(_ line: String) -> Bool {
        let compact = line.filter { !$0.isWhitespace }
        guard compact.count >= 3, let first = compact.first, ["-", "*", "_"].contains(first) else {
            return false
        }
        return compact.allSatisfy { $0 == first }
    }

    private static func quoteLineContent(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.first == ">" else { return nil }
        return String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)
    }

    /// Leading indent in columns (a tab counts as four) so nesting survives
    /// the common LLM convention of two- or four-space child bullets.
    private static func leadingIndent(of line: String) -> Int {
        var columns = 0
        for character in line {
            if character == " " { columns += 1 }
            else if character == "\t" { columns += 4 }
            else { break }
        }
        return columns
    }

    /// Parses any list line — bullet, numbered, or task — into a raw item,
    /// or nil when the line is not a list item at all.
    private static func listItem(in line: String) -> RawListItem? {
        let indent = leadingIndent(of: line)
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        if let marker = trimmed.first, ["-", "*", "+"].contains(marker) {
            let remainder = trimmed.dropFirst()
            guard remainder.first?.isWhitespace == true else { return nil }
            let text = remainder.trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else { return nil }
            // GFM task syntax rides on the bullet marker: "- [ ] …" / "- [x] …".
            let lowercased = text.lowercased()
            if lowercased.hasPrefix("[ ] ") || lowercased.hasPrefix("[x] ") {
                let taskText = String(text.dropFirst(4)).trimmingCharacters(in: .whitespaces)
                guard !taskText.isEmpty else { return nil }
                return RawListItem(
                    indent: indent,
                    marker: .task(isComplete: lowercased.hasPrefix("[x] ")),
                    text: taskText
                )
            }
            return RawListItem(indent: indent, marker: .bullet, text: text)
        }

        let digits = trimmed.prefix { $0.isNumber }
        guard !digits.isEmpty,
              let ordinal = Int(digits),
              trimmed.dropFirst(digits.count).first == "." else { return nil }
        let remainder = trimmed.dropFirst(digits.count + 1)
        guard remainder.first?.isWhitespace == true else { return nil }
        let text = remainder.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        return RawListItem(indent: indent, marker: .number(ordinal), text: text)
    }

    /// Folds the flat indent-ordered items into a tree. Anything indented
    /// deeper than the current level attaches to the previous node; a line
    /// indented with no parent above it degrades to a sibling rather than
    /// being dropped, which keeps partially streamed lists renderable.
    private static func parseListLevel(
        _ items: [RawListItem],
        index: inout Int,
        indent: Int
    ) -> [ListNode] {
        var nodes: [ListNode] = []
        while index < items.count {
            let item = items[index]
            if item.indent < indent { break }
            if item.indent > indent {
                guard let last = nodes.last else {
                    index += 1
                    nodes.append(ListNode(marker: item.marker, text: item.text, children: []))
                    continue
                }
                let children = parseListLevel(items, index: &index, indent: item.indent)
                nodes[nodes.count - 1] = ListNode(
                    marker: last.marker,
                    text: last.text,
                    children: last.children + children
                )
                continue
            }
            index += 1
            nodes.append(ListNode(marker: item.marker, text: item.text, children: []))
        }
        return nodes
    }

    private static func table(at index: Int, in lines: [String]) -> (headers: [String], rows: [[String]], endIndex: Int)? {
        guard index + 1 < lines.count,
              let headers = tableCells(in: lines[index]),
              headers.count > 1,
              isTableSeparator(lines[index + 1], columnCount: headers.count) else { return nil }

        var rows: [[String]] = []
        var rowIndex = index + 2
        while rowIndex < lines.count, let cells = tableCells(in: lines[rowIndex]) {
            var row = Array(cells.prefix(headers.count))
            if row.count < headers.count {
                row.append(contentsOf: Array(repeating: "", count: headers.count - row.count))
            }
            rows.append(row)
            rowIndex += 1
        }
        return (headers, rows, rowIndex)
    }

    private static func tableCells(in line: String) -> [String]? {
        guard line.contains("|") else { return nil }
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.first == "|" { trimmed.removeFirst() }
        if trimmed.last == "|" { trimmed.removeLast() }
        return trimmed
            .split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func isTableSeparator(_ line: String, columnCount: Int) -> Bool {
        guard let cells = tableCells(in: line), cells.count == columnCount else { return false }
        return cells.allSatisfy { cell in
            let compact = cell.filter { !$0.isWhitespace }
            guard compact.count >= 3 else { return false }
            return compact.allSatisfy { $0 == "-" || $0 == ":" }
        }
    }
}

private struct AssistantMarkdownView: View {
    let source: String
    let baseFontSize: CGFloat
    let ink: Color
    let mutedInk: Color
    let codeSurface: Color
    let accent: Color

    private var blocks: [AssistantMarkdown.Block] {
        AssistantMarkdown.blocks(in: source)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func blockView(_ block: AssistantMarkdown.Block) -> some View {
        switch block {
        case let .heading(level, text):
            markdownText(text)
                .font(headingFont(for: level))
                .tracking(level <= 2 ? -0.22 : -0.12)
                .lineSpacing(1)
                .padding(.top, level <= 2 ? 2 : 0)
                .accessibilityAddTraits(.isHeader)

        case let .paragraph(text):
            markdownText(text)

        case let .list(nodes):
            listNodesView(nodes)
            .accessibilityElement(children: .contain)

        case let .quote(text):
            HStack(alignment: .top, spacing: 10) {
                Capsule()
                    .fill(accent.opacity(0.48))
                    .frame(width: 3)
                    .padding(.vertical, 1)
                markdownText(text)
                    .foregroundStyle(mutedInk)
                    .italic()
            }
            .padding(.vertical, 4)
            .padding(.leading, 1)

        case let .code(language, text):
            VStack(alignment: .leading, spacing: language == nil ? 0 : 8) {
                if let language, !language.isEmpty {
                    Text(language.uppercased())
                        .font(.system(size: max(9, baseFontSize * 0.67), weight: .semibold, design: .rounded))
                        .tracking(0.7)
                        .foregroundStyle(mutedInk)
                        .accessibilityHidden(true)
                }
                // The transcript is a LazyVStack, which proposes zero height
                // to children while it measures — a horizontal ScrollView
                // whose content is `fixedSize(horizontal: true)` then
                // collapses to nothing and the code body renders blank. Code
                // wraps to the bubble instead: on a phone, wrapping is more
                // readable than a sideways pan, and the text stays selectable.
                Text(text.isEmpty ? " " : text)
                    .font(.system(size: max(11, baseFontSize * 0.84), design: .monospaced))
                    .foregroundStyle(ink)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    // Without an explicit vertical fix the LazyVStack measures
                    // the block at two lines and tail-truncates the rest.
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 12)
                    .background(codeSurface.opacity(0.82), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(ink.opacity(0.075), lineWidth: 0.75)
                    }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(language.map { "\($0) code block" } ?? "Code block")

        case .divider:
            Capsule()
                .fill(ink.opacity(0.13))
                .frame(height: 1)
                .padding(.vertical, 5)
                .accessibilityHidden(true)

        case let .table(headers, rows):
            // A horizontally scrolling grid collapses to zero height inside the
            // transcript's LazyVStack (its width is indeterminate while the
            // stack measures), so the table rendered blank. On a phone a table
            // is far more readable as one card per row — header: value pairs —
            // which wraps naturally and needs no sideways pan.
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { rowIndex, row in
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(zip(headers, row).enumerated()), id: \.offset) { _, pair in
                            let (header, cell) = pair
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(header)
                                    .font(.system(size: baseFontSize * 0.8, weight: .semibold))
                                    .foregroundStyle(mutedInk)
                                    .frame(width: 88, alignment: .trailing)
                                markdownText(cell.isEmpty ? "—" : cell, inline: true)
                                    .font(.system(size: baseFontSize * 0.92))
                            }
                        }
                    }
                    .padding(.horizontal, 13)
                    .padding(.vertical, 10)
                    if rowIndex < rows.count - 1 {
                        Rectangle()
                            .fill(ink.opacity(0.08))
                            .frame(height: 0.75)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(codeSurface.opacity(0.56), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(ink.opacity(0.09), lineWidth: 0.75)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Table with \(headers.count) columns and \(rows.count) rows")
        }
    }

    private func markdownText(_ source: String, strikethrough: Bool = false, inline: Bool = false) -> some View {
        // Table cells use inline-only interpretation: a block-level construct
        // inside a cell (a heading marker, a hard break) would otherwise tear
        // the row layout apart.
        let withBreaks = inline ? source : AssistantMarkdown.preservingSoftBreaks(source)
        let attributed = (try? AttributedString(
            markdown: withBreaks,
            options: .init(
                interpretedSyntax: inline ? .inlineOnlyPreservingWhitespace : .full
            )
        )) ?? AttributedString(source)

        return Text(attributed)
            .font(.system(size: baseFontSize, weight: .regular))
            .tracking(-0.08)
            .foregroundStyle(ink)
            .lineSpacing(2.5)
            .strikethrough(strikethrough, color: mutedInk.opacity(0.65))
            .fixedSize(horizontal: false, vertical: true)
    }

    // Recursion lives in a named child view: a `some View` function that
    // returns itself cannot be inferred by the compiler (the opaque type
    // would be defined in terms of itself), so the nesting is expressed as a
    // concrete `NestedList` whose body recurses instead.
    private func listNodesView(_ nodes: [AssistantMarkdown.ListNode]) -> some View {
        NestedList(nodes: nodes) { node in AnyView(listNodeRow(node)) }
    }

    private struct NestedList: View {
        let nodes: [AssistantMarkdown.ListNode]
        let row: (AssistantMarkdown.ListNode) -> AnyView

        var body: some View {
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(nodes.enumerated()), id: \.offset) { _, node in
                    VStack(alignment: .leading, spacing: 7) {
                        row(node)
                        if !node.children.isEmpty {
                            NestedList(nodes: node.children, row: row)
                                .padding(.leading, 18)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func listNodeRow(_ node: AssistantMarkdown.ListNode) -> some View {
        switch node.marker {
        case .bullet:
            listRow(marker: "•", text: node.text, markerColor: accent)
        case let .number(ordinal):
            listRow(marker: "\(ordinal).", text: node.text, markerColor: mutedInk)
        case let .task(isComplete):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: isComplete ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: baseFontSize * 0.94, weight: .medium))
                    .foregroundStyle(isComplete ? accent : mutedInk.opacity(0.75))
                    .accessibilityHidden(true)
                markdownText(node.text, strikethrough: isComplete)
                    .opacity(isComplete ? 0.72 : 1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(isComplete ? "Completed" : "Not completed"): \(plainText(node.text))")
        }
    }

    private func listRow(marker: String, text: String, markerColor: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(marker)
                .font(.system(size: baseFontSize * 0.9, weight: .semibold))
                .foregroundStyle(markerColor)
                .frame(minWidth: marker.count > 1 ? 17 : 10, alignment: .trailing)
                .accessibilityHidden(true)
            markdownText(text)
        }
    }

    private func headingFont(for level: Int) -> Font {
        switch level {
        case 1:
            .system(size: baseFontSize * 1.32, weight: .semibold, design: .rounded)
        case 2:
            .system(size: baseFontSize * 1.18, weight: .semibold, design: .rounded)
        default:
            .system(size: baseFontSize * 1.06, weight: .semibold)
        }
    }

    private func plainText(_ markdown: String) -> String {
        guard let attributed = try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .full)
        ) else {
            return markdown
        }
        return String(attributed.characters)
    }
}
