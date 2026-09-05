import XCTest
import SwiftUI
@testable import Assistant

/// Locks in the block parser's behavior on the shapes LLM replies actually
/// take — nested bullets, mixed lists, fenced code, and tables — so a
/// regression in the chat bubble's markdown is caught by a test instead of a
/// blank screenshot.
final class AssistantMarkdownTests: XCTestCase {
    @MainActor
    func testCurrentAnswerHeaderSnapshots() throws {
        for (name, scheme, size, width) in [
            ("light", ColorScheme.light, DynamicTypeSize.large, CGFloat(390)),
            ("dark", .dark, .large, 390),
            ("narrow", .light, .large, 320),
            ("accessible", .light, .accessibility3, 390)
        ] {
            let view = MessageBubble(
                message: .optimistic(role: .assistant, text: "Here are two places to stop along the way. Check the opening hours before leaving."),
                userPrompt: "Can you find a place somewhere along the way?",
                isCurrentAnswer: true, isStreaming: false, openApprovals: {},
                runForReal: nil, retry: nil, decideApproval: nil
            )
            .padding(16).frame(width: width).background(AssistantTheme.stage)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 3
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertEqual(image.size.width, width)
            XCTAssertGreaterThan(image.size.height, 100)
            if !size.isAccessibilitySize {
                // A rounded header background leaves paper-colored wedges
                // above the divider. Both ends must instead match its center.
                let cgImage = try XCTUnwrap(image.cgImage)
                let data = try XCTUnwrap(cgImage.dataProvider?.data)
                let bytes = try XCTUnwrap(CFDataGetBytePtr(data))
                let pixelSize = cgImage.bitsPerPixel / 8
                let y = Int((16 + AssistantTheme.conversationCornerRadius * 1.55 - 4) * renderer.scale)
                func pixel(_ x: CGFloat) -> [UInt8] {
                    let offset = y * cgImage.bytesPerRow + Int(x * renderer.scale) * pixelSize
                    return Array(UnsafeBufferPointer(start: bytes + offset, count: pixelSize))
                }
                // Allow tiny rasterization/shadow differences, not the much
                // lighter paper wedge produced by a separate rounded shape.
                for x in [CGFloat(20), width - 20] {
                    let difference = zip(pixel(x), pixel(width / 2))
                        .map { abs(Int($0.0) - Int($0.1)) }.max() ?? 0
                    XCTAssertLessThanOrEqual(difference, 2, "Header must have square bottom corners")
                }
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "current-answer-header-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    func testSpreadsheetPasteKeepsFirstRowAndMissingValues() {
        let source = "Family birthdays\n\nAda\tApril 20, 1918\tMonkey\n\t\t\nBaby\t\tHorse"
        let blocks = AssistantMarkdown.blocks(in: source)
        XCTAssertEqual(blocks.first, .paragraph("Family birthdays"))
        XCTAssertEqual(blocks.last, .table(headers: [], rows: [
            ["Ada", "April 20, 1918", "Monkey"], ["", "", ""], ["Baby", "", "Horse"]
        ]))
    }

    func testTabDetectionLeavesCodeAndSingleTabLineAlone() {
        XCTAssertEqual(AssistantMarkdown.blocks(in: "Name\tValue"), [.paragraph("Name\tValue")])
        XCTAssertEqual(AssistantMarkdown.blocks(in: "```\nA\tB\nC\tD\n```"), [.code(language: nil, text: "A\tB\nC\tD")])
        let blocks = AssistantMarkdown.blocks(in: "A\tB\nC\tD\nNot\ta\tmatching row")
        XCTAssertEqual(blocks.last, .paragraph("Not\ta\tmatching row"))
    }

    @MainActor
    func testCompactCalendarSnapshots() throws {
        let data = Data(#"{"id":"m1","role":"assistant","parts":[{"type":"data-card","data":{"kind":"calendar-event","id":"e1","title":"Google Phone Interview","time":"2:00 PM–2:30 PM","start":"2014-05-05T14:00:00-07:00","calendars":["Personal"]}},{"type":"data-card","data":{"kind":"calendar-event","id":"e2","title":"Twitter Phone Interview","time":"3:00 PM–4:00 PM","start":"2014-05-19T15:00:00-07:00","calendars":["Personal"]}}]}"#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        for scheme in [ColorScheme.light, .dark] {
            let view = MessageBubble(message: message, userPrompt: nil, isCurrentAnswer: false,
                isStreaming: false, openApprovals: {}, runForReal: nil, retry: nil, decideApproval: nil)
                .padding(16).frame(width: 390).background(AssistantTheme.stage)
                .environment(\.colorScheme, scheme)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertGreaterThan(image.size.height, 150)
            XCTAssertLessThan(image.size.height, 330)
            let attachment = XCTAttachment(image: image)
            attachment.name = "compact-calendar-\(scheme)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testUserFormattingSnapshots() throws {
        let source = "Family birthdays\n\nAda\tApril 20, 1918\tMetal Monkey\nAlexandra\tNovember 21, 2020\tMetal Rat\nBaby\t\tFire Horse\n\nOur order\n- [ ] Bean & Cheese\n- [ ] Mushroom"
        for (name, scheme, size) in [
            ("light", ColorScheme.light, DynamicTypeSize.large),
            ("dark", .dark, .large),
            ("accessible", .light, .accessibility3)
        ] {
            let view = MessageBubble(message: .optimistic(role: .user, text: source), userPrompt: nil,
                isCurrentAnswer: false, isStreaming: false, openApprovals: {},
                runForReal: nil, retry: nil, decideApproval: nil)
                .padding(16).frame(width: 390).background(AssistantTheme.stage)
                .environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertGreaterThan(image.size.height, 200)
            let attachment = XCTAttachment(image: image)
            attachment.name = "user-table-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }
    /// Reuses the two generated prompt runs without bundling private QA output
    /// into the app. XCTest keeps the native renders as reviewable attachments.
    @MainActor
    func testReadabilityCorpusSnapshots() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let corpusDirectory = repository.appendingPathComponent(".artifacts/chat-readability")
        guard FileManager.default.fileExists(atPath: corpusDirectory.appendingPathComponent("baseline-responses.json").path) else {
            throw XCTSkip("Generate the optional readability corpus before running visual QA")
        }
        struct Corpus: Decodable {
            struct Response: Decodable {
                let index: Int
                let prompt: String
                let response: String
            }
            let responses: [Response]
        }
        for run in ["baseline", "reframed"] {
            let data = try Data(contentsOf: corpusDirectory.appendingPathComponent("\(run)-responses.json"))
            let corpus = try JSONDecoder().decode(Corpus.self, from: data)
            XCTAssertEqual(corpus.responses.count, 30)
            for item in corpus.responses {
                let view = MessageBubble(
                    message: .optimistic(role: .assistant, text: item.response),
                    userPrompt: item.prompt,
                    isCurrentAnswer: true,
                    isStreaming: false,
                    openApprovals: {}, runForReal: nil, retry: nil, decideApproval: nil
                )
                .padding(16)
                .frame(width: 390)
                .background(AssistantTheme.stage)
                .environment(\.colorScheme, .light)
                let renderer = ImageRenderer(content: view)
                renderer.scale = 2
                renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
                let image = try XCTUnwrap(renderer.uiImage, "Could not render \(run) \(item.index)")
                XCTAssertGreaterThan(image.size.height, 70)
                let attachment = XCTAttachment(image: image)
                attachment.name = "\(run)-\(String(format: "%02d", item.index))-native"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    func testParsesNestedUnorderedList() {
        let source = """
        - Flights from KEF, direct
          - Depart Oct 12
          - Around $420
        - Stay near Alfama
        """
        let blocks = AssistantMarkdown.blocks(in: source)
        guard case let .list(nodes) = blocks.first, blocks.count == 1 else {
            return XCTFail("expected a single list block, got \(blocks)")
        }
        XCTAssertEqual(nodes.count, 2)
        XCTAssertEqual(nodes[0].text, "Flights from KEF, direct")
        XCTAssertEqual(nodes[0].children.map(\.text), ["Depart Oct 12", "Around $420"])
        XCTAssertEqual(nodes[1].text, "Stay near Alfama")
        XCTAssertTrue(nodes[1].children.isEmpty)
    }

    func testParsesMixedListMarkersAndTasks() {
        let source = """
        1. First step
        2. Second step
        - [x] Done thing
        - [ ] Todo thing
        """
        let blocks = AssistantMarkdown.blocks(in: source)
        guard case let .list(nodes) = blocks.first else {
            return XCTFail("expected a list block, got \(blocks)")
        }
        XCTAssertEqual(nodes.count, 4)
        XCTAssertEqual(nodes[0].marker, .number(1))
        XCTAssertEqual(nodes[2].marker, .task(isComplete: true))
        XCTAssertEqual(nodes[3].marker, .task(isComplete: false))
    }

    func testParsesFencedCodeBlockWithLanguage() {
        let source = """
        Intro.

        ```ts
        const a = 1;
        const b = 2;
        ```
        """
        let blocks = AssistantMarkdown.blocks(in: source)
        guard case let .code(language, text) = blocks.last else {
            return XCTFail("expected a code block, got \(blocks)")
        }
        XCTAssertEqual(language, "ts")
        XCTAssertEqual(text, "const a = 1;\nconst b = 2;")
    }

    func testParsesMermaidFenceAsARecognizableDiagramBlock() {
        let source = """
        ```mermaid
        graph LR
          A --> B
        ```
        """
        guard case let .code(language, text) = AssistantMarkdown.blocks(in: source).first else {
            return XCTFail("expected a diagram code block")
        }
        XCTAssertEqual(language, "mermaid")
        XCTAssertEqual(text, "graph LR\n  A --> B")
    }

    func testParsesTableHeadersAndRows() {
        let source = """
        | Item | Estimate |
        | --- | --- |
        | Flights | $420 |
        | Stay | $680 |
        """
        let blocks = AssistantMarkdown.blocks(in: source)
        guard case let .table(headers, rows) = blocks.first else {
            return XCTFail("expected a table block, got \(blocks)")
        }
        XCTAssertEqual(headers, ["Item", "Estimate"])
        XCTAssertEqual(rows, [["Flights", "$420"], ["Stay", "$680"]])
    }

    func testPromotesStandaloneBoldQuotationToCallout() {
        let source = "**“Clarity is kindness.”**"
        let blocks = AssistantMarkdown.blocks(in: source)
        XCTAssertEqual(blocks, [.quote(source)])
        XCTAssertTrue(AssistantMarkdown.isStandaloneBoldQuote(source))
    }

    func testLeavesOrdinaryBoldParagraphAsParagraph() {
        let source = "**Important:** keep the copy short."
        XCTAssertEqual(AssistantMarkdown.blocks(in: source), [.paragraph(source)])
        XCTAssertFalse(AssistantMarkdown.isStandaloneBoldQuote(source))
    }

    func testShortBoldListLabelBecomesSectionHeading() {
        let blocks = AssistantMarkdown.blocks(in: "**Risks**\n\n- Delay")
        XCTAssertEqual(blocks.first, .heading(level: 2, text: "Risks"))
        let sentence = AssistantMarkdown.blocks(in: "**Keep it simple.**\n\n- Next")
        XCTAssertEqual(sentence.first, .paragraph("**Keep it simple.**"))
    }

    func testDisplayArithmeticKeepsCurrencyAndFormatsOperators() {
        let blocks = AssistantMarkdown.blocks(in: "$$\nA = P \\times (1 + r)^t\n$$")
        XCTAssertEqual(blocks, [.equation("A = P \\times (1 + r)^t")])
        XCTAssertEqual(AssistantMarkdown.readableEquation("A = P \\times (1 + r)^t"), "A = P × (1 + r)ᵗ")
        XCTAssertEqual(AssistantMarkdown.readableInlineVariables("$A$ is $1,000, not $1,050"), "A is $1,000, not $1,050")
        XCTAssertEqual(AssistantMarkdown.readableInlineVariables("`const x = $A$` then $A$"), "`const x = $A$` then A")
    }

    func testCurrencyIsNotInterpretedAsMarkdownMath() {
        let source = "Budget: $1,000; forecast: $1,050."
        let rendered = AssistantMarkdown.inlineAttributed(source)
        XCTAssertEqual(String(rendered.characters), source)
    }

    func testTablePadsShortRowsToHeaderWidth() {
        let source = """
        | A | B | C |
        | --- | --- | --- |
        | 1 | 2 |
        """
        guard case let .table(_, rows) = AssistantMarkdown.blocks(in: source).first else {
            return XCTFail("expected a table block")
        }
        XCTAssertEqual(rows[0], ["1", "2", ""])
    }

    func testOrphanedIndentDegradesToSibling() {
        // A deeper-indented first line has no parent to attach to; it must not
        // be dropped (partially streamed lists hit this mid-render).
        let source = "  - lone child"
        guard case let .list(nodes) = AssistantMarkdown.blocks(in: source).first else {
            return XCTFail("expected a list block")
        }
        XCTAssertEqual(nodes.map(\.text), ["lone child"])
    }

    func testParagraphKeepsSoftLineBreaks() {
        // The chat convention: one found item per line must survive as lines,
        // not fold into a run-on paragraph.
        let source = """
        Found 3 receipts:
        Amazon — $45.99, yesterday
        Delta — flight confirmation
        """
        let blocks = AssistantMarkdown.blocks(in: source)
        guard case let .paragraph(text) = blocks.first, blocks.count == 1 else {
            return XCTFail("expected a single paragraph, got \(blocks)")
        }
        XCTAssertEqual(
            text,
            "Found 3 receipts:\nAmazon — $45.99, yesterday\nDelta — flight confirmation"
        )
        // The bubble renders through AttributedString(markdown:), which folds
        // soft breaks into spaces — the view's hard-break conversion is what
        // must keep the newline real.
        let rendered = try? AttributedString(markdown: AssistantMarkdown.preservingSoftBreaks(text))
        XCTAssertNotNil(rendered)
        let plain = rendered.map { String($0.characters) } ?? ""
        XCTAssertTrue(plain.contains("receipts:\nAmazon"))
    }

    func testInlineMarkdownForCardDetailsDoesNotExposeDelimiters() {
        let rendered = AssistantMarkdown.inlineAttributed("- 💨 **Wind:** 15 km/h")
        XCTAssertEqual(String(rendered.characters), "- 💨 Wind: 15 km/h")
    }
}
