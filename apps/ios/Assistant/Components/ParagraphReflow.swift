import Foundation

/// Render-time reflow of overlong prose paragraphs.
///
/// A reply line longer than about four phone lines reads as a block of text.
/// Splitting it at sentence boundaries changes only whitespace, so doing it at
/// render time leaves the persisted text — and every `[break]` offset into it —
/// exactly as the server wrote it.
///
/// This is a port of `apps/web/lib/paragraph-reflow.ts`. Both are checked
/// against `apps/web/lib/paragraph-reflow.fixtures.json`, so the two clients
/// split a reply at the same places. Lengths are UTF-16 counts to match
/// JavaScript's `String.length`.
enum ParagraphReflow {
    static let minimumLength = 420
    private static let chunkTarget = 240
    private static let chunkSentences = 3
    private static let tailMinimum = 80

    private static let structuredLine = #"^(?:\s|[-*+]\s|\d+[.)]\s|\||>|#{1,6}\s|\$\$|<|\[\^)"#
    private static let fence = #"^\s*(?:```|~~~)"#
    private static let sentenceStart = #"^\s+["'“‘(*\[]?[A-Z0-9]"#
    private static let trailingWord = #"([A-Za-z.]+)$"#
    private static let abbreviations: Set<String> = [
        "e.g", "i.e", "etc", "vs", "dr", "mr", "mrs", "ms", "st", "no", "u.s",
        "approx", "a.m", "p.m", "inc", "ltd", "jr", "sr", "fig",
    ]

    /// The same markdown with every overlong prose line split into short
    /// paragraphs. Code fences, display math, and structured lines pass
    /// through untouched. Idempotent.
    static func reflow(_ markdown: String) -> String {
        guard markdown.utf16.count >= minimumLength else { return markdown }
        var fenced = false
        var math = false
        var structure = false
        return markdown.components(separatedBy: "\n").map { line -> String in
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                structure = false
                return line
            }
            if matches(fence, line) {
                fenced.toggle()
                return line
            }
            if fenced { return line }
            if matches(#"^\s*\$\$"#, line) {
                if !matches(#"^\s*\$\$.*\S.*\$\$\s*$"#, line) { math.toggle() }
                return line
            }
            if math { return line }
            if matches(structuredLine, line) { structure = true }
            return structure ? line : reflowLine(line)
        }.joined(separator: "\n")
    }

    private static func reflowLine(_ line: String) -> String {
        guard line.utf16.count >= minimumLength else { return line }
        let characters = Array(line)
        let cuts = sentenceBreaks(characters)
        guard !cuts.isEmpty else { return line }

        var sentences: [String] = []
        var start = 0
        for cut in cuts {
            sentences.append(String(characters[start..<cut]).trimmingCharacters(in: .whitespaces))
            start = cut
        }
        sentences.append(String(characters[start...]).trimmingCharacters(in: .whitespaces))

        var chunks: [String] = []
        var current: [String] = []
        for sentence in sentences where !sentence.isEmpty {
            current.append(sentence)
            let text = current.joined(separator: " ")
            if text.utf16.count >= chunkTarget || current.count >= chunkSentences {
                chunks.append(text)
                current = []
            }
        }
        if !current.isEmpty {
            let tail = current.joined(separator: " ")
            if !chunks.isEmpty, tail.utf16.count < tailMinimum {
                chunks[chunks.count - 1] += " \(tail)"
            } else {
                chunks.append(tail)
            }
        }
        return chunks.count > 1 ? chunks.joined(separator: "\n\n") : line
    }

    /// Character offsets just past each safe sentence end: outside links,
    /// parentheses, inline code, and bold; followed by whitespace and a
    /// capital, digit, or opening mark; not an abbreviation or an initial.
    private static func sentenceBreaks(_ characters: [Character]) -> [Int] {
        var breaks: [Int] = []
        var brackets = 0
        var parens = 0
        var code = false
        var bold = false
        var index = 0
        while index < characters.count {
            defer { index += 1 }
            let character = characters[index]
            if character == "`" {
                code.toggle()
                continue
            }
            if code { continue }
            if character == "*", index + 1 < characters.count, characters[index + 1] == "*" {
                bold.toggle()
                index += 1
                continue
            }
            switch character {
            case "[": brackets += 1
            case "]": brackets = max(0, brackets - 1)
            case "(": parens += 1
            case ")": parens = max(0, parens - 1)
            default: break
            }
            if brackets > 0 || parens > 0 || bold { continue }
            guard character == "." || character == "!" || character == "?" else { continue }

            var end = index + 1
            while end < characters.count, "\"'”’)".contains(characters[end]) { end += 1 }
            guard matches(sentenceStart, String(characters[end...])) else { continue }
            if character == "." {
                let prefix = String(characters[..<index])
                let word = firstCapture(trailingWord, prefix) ?? ""
                if abbreviations.contains(word.lowercased()) { continue }
                if word.count == 1, word.first?.isLetter == true { continue }
            }
            breaks.append(end)
        }
        return breaks
    }

    private static func matches(_ pattern: String, _ text: String) -> Bool {
        guard let expression = NSRegularExpression.cached(pattern) else { return false }
        return expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func firstCapture(_ pattern: String, _ text: String) -> String? {
        guard let expression = NSRegularExpression.cached(pattern),
              let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }
}
