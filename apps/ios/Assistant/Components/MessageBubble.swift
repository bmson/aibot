import SwiftUI
import UIKit

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

    var body: some View {
        VStack(alignment: message.role == .assistant ? .leading : .trailing, spacing: 8) {
            if !message.text.isEmpty {
                HStack {
                    if message.role == .user { Spacer(minLength: 40) }
                    messageText
                    if message.role == .assistant { Spacer(minLength: 40) }
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
                    HStack(spacing: 12) {
                        Image(systemName: "shield.lefthalf.filled")
                            .font(.title3)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(part.type == "approval" ? "Approval requested" : "Decision needed")
                                .font(.caption.weight(.semibold))
                                .textCase(.uppercase)
                                .tracking(0.5)
                            Text(part.summary ?? "Review this action before the assistant continues.")
                                .font(.subheadline)
                                .multilineTextAlignment(.leading)
                                .lineLimit(3)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
                    .padding(14)
                    .background(
                        AssistantTheme.warningSurface(for: colorScheme),
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(
                                Color.orange.opacity(colorSchemeContrast == .increased ? 0.58 : 0.3),
                                lineWidth: colorSchemeContrast == .increased ? 1.2 : 1
                            )
                    }
                }
                .buttonStyle(AssistantTactileButtonStyle(reduceMotion: reduceMotion, pressedScale: 0.985))
            }
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
                .overlay(alignment: .bottomTrailing) {
                    if isStreaming {
                        ZStack {
                            Circle()
                                .fill(AssistantTheme.accent(for: colorScheme).opacity(0.16))
                                .frame(width: 15, height: 15)
                            Circle()
                                .fill(AssistantTheme.accent(for: colorScheme))
                                .frame(width: 5, height: 5)
                                .symbolEffect(
                                    .pulse,
                                    options: reduceMotion ? .nonRepeating : .repeating
                                )
                        }
                        .padding(7)
                        .accessibilityHidden(true)
                    }
                }
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

    private var resolvedBubbleVerticalInset: CGFloat {
        min(bubbleVerticalInset, 22)
    }

    private var decisionParts: [MessagePart] {
        message.parts.filter { ["approval", "budget-request"].contains($0.type) }
    }
}

/// A lightweight GFM-inspired block parser. Keeping this local avoids a dependency while
/// making partially streamed replies render gracefully as they arrive.
enum AssistantMarkdown {
    enum Block: Hashable {
        case heading(level: Int, text: String)
        case paragraph(String)
        case unorderedList([String])
        case orderedList([ListItem])
        case taskList([TaskItem])
        case quote(String)
        case code(language: String?, text: String)
        case divider
        case table(headers: [String], rows: [[String]])
    }

    struct ListItem: Hashable {
        let ordinal: Int
        let text: String
    }

    struct TaskItem: Hashable {
        let isComplete: Bool
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

            if taskItem(in: line) != nil {
                var tasks: [TaskItem] = []
                while index < lines.count, let task = taskItem(in: lines[index]) {
                    tasks.append(task)
                    index += 1
                }
                result.append(.taskList(tasks))
                continue
            }

            if unorderedListItem(in: line) != nil {
                var items: [String] = []
                while index < lines.count, let item = unorderedListItem(in: lines[index]) {
                    items.append(item)
                    index += 1
                }
                result.append(.unorderedList(items))
                continue
            }

            if orderedListItem(in: line) != nil {
                var items: [ListItem] = []
                while index < lines.count, let item = orderedListItem(in: lines[index]) {
                    items.append(item)
                    index += 1
                }
                result.append(.orderedList(items))
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
            result.append(.paragraph(paragraphLines.joined(separator: " ")))
        }

        return result
    }

    private static func startsBlock(at index: Int, in lines: [String]) -> Bool {
        let line = lines[index]
        return isCodeFence(line)
            || heading(in: line) != nil
            || isDivider(line)
            || quoteLineContent(line) != nil
            || taskItem(in: line) != nil
            || unorderedListItem(in: line) != nil
            || orderedListItem(in: line) != nil
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

    private static func unorderedListItem(in line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let marker = trimmed.first, ["-", "*", "+"].contains(marker) else { return nil }
        let remainder = trimmed.dropFirst()
        guard remainder.first?.isWhitespace == true else { return nil }
        let text = remainder.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : text
    }

    private static func orderedListItem(in line: String) -> ListItem? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let digits = trimmed.prefix { $0.isNumber }
        guard !digits.isEmpty,
              let ordinal = Int(digits),
              trimmed.dropFirst(digits.count).first == "." else { return nil }
        let remainder = trimmed.dropFirst(digits.count + 1)
        guard remainder.first?.isWhitespace == true else { return nil }
        let text = remainder.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : ListItem(ordinal: ordinal, text: text)
    }

    private static func taskItem(in line: String) -> TaskItem? {
        guard let item = unorderedListItem(in: line) else { return nil }
        let lowercased = item.lowercased()
        guard lowercased.hasPrefix("[ ] ") || lowercased.hasPrefix("[x] ") else { return nil }
        let text = String(item.dropFirst(4)).trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        return TaskItem(isComplete: lowercased.hasPrefix("[x] "), text: text)
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

        case let .unorderedList(items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    listRow(marker: "•", text: item, markerColor: accent)
                }
            }

        case let .orderedList(items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    listRow(marker: "\(item.ordinal).", text: item.text, markerColor: mutedInk)
                }
            }

        case let .taskList(items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: item.isComplete ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: baseFontSize * 0.94, weight: .medium))
                            .foregroundStyle(item.isComplete ? accent : mutedInk.opacity(0.75))
                            .accessibilityHidden(true)
                        markdownText(item.text, strikethrough: item.isComplete)
                            .opacity(item.isComplete ? 0.72 : 1)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(item.isComplete ? "Completed" : "Not completed"): \(plainText(item.text))")
                }
            }

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
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(text.isEmpty ? " " : text)
                        .font(.system(size: max(11, baseFontSize * 0.84), design: .monospaced))
                        .foregroundStyle(ink)
                        .lineSpacing(3)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 12)
                }
                .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
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
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    tableRow(headers, isHeader: true)
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        tableRow(row, isHeader: false)
                    }
                }
                .background(codeSurface.opacity(0.56), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(ink.opacity(0.09), lineWidth: 0.75)
                }
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Table with \(headers.count) columns and \(rows.count) rows")
        }
    }

    private func markdownText(_ source: String, strikethrough: Bool = false) -> some View {
        let attributed = (try? AttributedString(
            markdown: source,
            options: .init(interpretedSyntax: .full)
        )) ?? AttributedString(source)

        return Text(attributed)
            .font(.system(size: baseFontSize, weight: .regular))
            .tracking(-0.08)
            .foregroundStyle(ink)
            .lineSpacing(2.5)
            .strikethrough(strikethrough, color: mutedInk.opacity(0.65))
            .fixedSize(horizontal: false, vertical: true)
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

    private func tableRow(_ cells: [String], isHeader: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                markdownText(cell.isEmpty ? "—" : cell)
                    .font(.system(size: baseFontSize * 0.9, weight: isHeader ? .semibold : .regular))
                    .foregroundStyle(isHeader ? ink : mutedInk)
                    .frame(minWidth: 120, maxWidth: 210, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .overlay(alignment: .trailing) {
                        if index < cells.count - 1 {
                            Rectangle()
                                .fill(ink.opacity(0.08))
                                .frame(width: 0.75)
                        }
                    }
            }
        }
        .background(isHeader ? ink.opacity(0.045) : .clear)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(ink.opacity(0.075))
                .frame(height: 0.75)
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
