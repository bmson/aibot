import XCTest
@testable import Assistant

/// Locks in the block parser's behavior on the shapes LLM replies actually
/// take — nested bullets, mixed lists, fenced code, and tables — so a
/// regression in the chat bubble's markdown is caught by a test instead of a
/// blank screenshot.
final class AssistantMarkdownTests: XCTestCase {
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
}
