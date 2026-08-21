import XCTest
@testable import Assistant

final class APIModelsTests: XCTestCase {
    func testDecodesCompanionCuesAndQuickReplies() throws {
        let data = #"{"id":"1","role":"assistant","parts":[{"type":"text","text":"Ready."},{"type":"data-face","data":{"state":"warm_smile"}},{"type":"data-theme","data":{"name":"cool_sky"}},{"type":"data-chips","data":{"labels":["Show me","Continue"]}}]}"#.data(using: .utf8)!
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(message.text, "Ready.")
        XCTAssertEqual(message.face, .warmSmile)
        XCTAssertEqual(message.mood, .coolSky)
        XCTAssertEqual(message.quickReplies, ["Show me", "Continue"])
    }

    func testOptimisticMessageUsesLocalIdentity() {
        let message = ChatMessage.optimistic(role: .user, text: "Hello")
        XCTAssertTrue(message.id.hasPrefix("local-"))
        XCTAssertEqual(message.text, "Hello")
    }

    func testIdentifierFormattingDoesNotExposeImplementationPunctuation() {
        XCTAssertEqual("web.fetch".sentenceCaseIdentifier, "Web Fetch")
        XCTAssertEqual("adhoc".sentenceCaseIdentifier, "Ad hoc")
        XCTAssertEqual("waiting_approval".sentenceCaseIdentifier, "Waiting for approval")
    }

    func testActivityTitlesKeepHumanLanguageAndFormatMachineIdentifiers() {
        let generatedTitle = activityItem(title: "document-processing")
        let humanTitle = activityItem(title: "Review the travel plan")
        let missingTitle = activityItem(title: nil, type: "ambient-refresh")

        XCTAssertEqual(generatedTitle.displayTitle, "Document Processing")
        XCTAssertEqual(humanTitle.displayTitle, "Review the travel plan")
        XCTAssertEqual(missingTitle.displayTitle, "Ambient Refresh")
    }

    func testActivityProgressRemovesKnownTechnicalPrefixesWithoutRewritingDetails() {
        let documentTask = activityItem(
            title: "document-processing",
            progress: "documents.process skipped because the documents module is disabled"
        )
        let ambientTask = activityItem(
            title: "ambient-refresh",
            progress: "ambient: no fresh location — snapshot cleared"
        )
        let humanTask = activityItem(title: "Travel plan", progress: "Three options are ready to compare")

        XCTAssertEqual(
            documentTask.displayProgress,
            "Document processing skipped because the documents module is disabled"
        )
        XCTAssertEqual(ambientTask.displayProgress, "Background update: no fresh location — snapshot cleared")
        XCTAssertEqual(humanTask.displayProgress, "Three options are ready to compare")
    }

    func testActivityBudgetSummaryUsesGlanceableCurrencyPrecision() {
        let task = activityItem(
            title: "Background refresh",
            spentUsd: "0.000083",
            budgetUsdLimit: "0.1000"
        )

        XCTAssertEqual(task.budgetSummary, "$0.00008 of $0.10")
    }

    func testLiveActivityContentKeepsPromptPrivateAndBecomesStale() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let content = LiveActivityManager.content(
            thought: .thinking,
            detail: "Private calendar and travel details",
            pendingCount: 0,
            now: now
        )

        XCTAssertEqual(content.state.detail, "Preparing a response")
        XCTAssertEqual(content.staleDate, now.addingTimeInterval(15 * 60))
        XCTAssertEqual(content.relevanceScore, 0.65)
    }

    func testAttentionActivityIsGlanceableAndPrioritized() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let content = LiveActivityManager.content(
            thought: .needsYou,
            detail: "Approve access to a private account",
            pendingCount: 2,
            now: now
        )

        XCTAssertEqual(content.state.detail, "A decision is ready to review")
        XCTAssertEqual(content.state.pendingCount, 2)
        XCTAssertNil(content.staleDate)
        XCTAssertEqual(content.relevanceScore, 1)
    }

    func testActivityDetailIsSafeForBothSystemAndInAppStatusSurfaces() {
        XCTAssertEqual(
            LiveActivityManager.safeDetail(
                for: .thinking,
                proposed: "Private calendar and travel details"
            ),
            "Preparing a response"
        )
        XCTAssertEqual(
            LiveActivityManager.safeDetail(for: .backgroundWork, proposed: "Anything private"),
            "Continuing in the background"
        )
        XCTAssertEqual(
            LiveActivityManager.safeDetail(for: .needsYou, proposed: "Approve a private account"),
            "A decision is ready to review"
        )
    }

    func testPullMenuSpringVelocityAlwaysContinuesTowardDestination() {
        let openingVelocity = PullMenuMotion.springInitialVelocity(
            releaseVelocity: 240,
            currentDistance: 100,
            targetDistance: 184
        )
        let closingVelocity = PullMenuMotion.springInitialVelocity(
            releaseVelocity: 240,
            currentDistance: 84,
            targetDistance: 0
        )

        XCTAssertGreaterThan(openingVelocity, 0)
        XCTAssertGreaterThan(closingVelocity, 0)
        XCTAssertLessThanOrEqual(openingVelocity, 1)
        XCTAssertLessThanOrEqual(closingVelocity, 1)
    }

    func testPullMenuCommitmentDetentsMatchReleaseDecisions() {
        let standardHeight: CGFloat = 184
        let accessibilityHeight: CGFloat = 320

        XCTAssertEqual(
            PullMenuMotion.openingCommitmentDistance(revealHeight: standardHeight),
            106.72,
            accuracy: 0.001
        )
        XCTAssertEqual(
            PullMenuMotion.openingCommitmentDistance(revealHeight: accessibilityHeight),
            150,
            accuracy: 0.001
        )
        XCTAssertFalse(
            PullMenuMotion.commitsToOpen(revealDistance: 106, revealHeight: standardHeight)
        )
        XCTAssertTrue(
            PullMenuMotion.commitsToOpen(revealDistance: 107, revealHeight: standardHeight)
        )
        XCTAssertFalse(
            PullMenuMotion.commitsToClose(dragDistance: 55, revealHeight: standardHeight)
        )
        XCTAssertTrue(
            PullMenuMotion.commitsToClose(dragDistance: 56, revealHeight: standardHeight)
        )
    }

    func testTranscriptEdgeMotionPreservesSoftFabricMotionTowardBothEdges() {
        XCTAssertEqual(TranscriptEdgeMotion.progress(for: 0), 0, accuracy: 0.001)
        XCTAssertEqual(TranscriptEdgeMotion.opacity(for: 0, reduceTransparency: false), 1, accuracy: 0.001)
        XCTAssertLessThan(
            TranscriptEdgeMotion.opacity(for: 0.7, reduceTransparency: false),
            0.5
        )
        XCTAssertEqual(
            TranscriptEdgeMotion.opacity(for: 1, reduceTransparency: false),
            0.26,
            accuracy: 0.001
        )
        XCTAssertEqual(
            TranscriptEdgeMotion.opacity(for: 1, reduceTransparency: true),
            0.62,
            accuracy: 0.001
        )
        XCTAssertLessThan(TranscriptEdgeMotion.rotation(for: -1), 0)
        XCTAssertGreaterThan(TranscriptEdgeMotion.rotation(for: 1), 0)
        XCTAssertEqual(TranscriptEdgeMotion.rotation(for: 1), 26, accuracy: 0.001)
        XCTAssertLessThan(TranscriptEdgeMotion.counterRotation(for: 1), 0)
        XCTAssertGreaterThan(TranscriptEdgeMotion.counterRotation(for: -1), 0)
        XCTAssertEqual(TranscriptEdgeMotion.verticalScale(for: 1), 0.72, accuracy: 0.001)
        XCTAssertEqual(TranscriptEdgeMotion.horizontalScale(for: 1), 0.975, accuracy: 0.001)
        XCTAssertGreaterThan(TranscriptEdgeMotion.edgeTranslation(for: -1), 0)
        XCTAssertLessThan(TranscriptEdgeMotion.edgeTranslation(for: 1), 0)
        XCTAssertLessThan(TranscriptEdgeMotion.lateralTranslation(for: -1), 0)
        XCTAssertGreaterThan(TranscriptEdgeMotion.lateralTranslation(for: 1), 0)
    }

    func testNativeRouteCatalogMatchesTheCompleteWorkspaceMenu() {
        XCTAssertEqual(
            Set(AssistantRoute.allCases),
            Set([
                .chat,
                .chats,
                .activity,
                .goals,
                .approvals,
                .memory,
                .documents,
                .skills,
                .settings,
                .costs,
                .anomalies,
                .improvements,
            ])
        )
    }

    func testMarkdownPresentationSeparatesRichResponseBlocks() {
        let blocks = AssistantMarkdown.blocks(in: """
        ## Trip brief

        Your **best option** is below.

        - Leave early
        - Keep a flexible fare

        - [x] Compare dates
        - [ ] Book the flight

        > Prices can change quickly.

        | Route | Duration |
        | --- | ---: |
        | SFO → LHR | 10h 20m |

        ---
        """)

        XCTAssertEqual(
            blocks,
            [
                .heading(level: 2, text: "Trip brief"),
                .paragraph("Your **best option** is below."),
                .unorderedList(["Leave early", "Keep a flexible fare"]),
                .taskList([
                    .init(isComplete: true, text: "Compare dates"),
                    .init(isComplete: false, text: "Book the flight"),
                ]),
                .quote("Prices can change quickly."),
                .table(
                    headers: ["Route", "Duration"],
                    rows: [["SFO → LHR", "10h 20m"]]
                ),
                .divider,
            ]
        )
    }

    func testMarkdownPresentationKeepsAnUnclosedStreamedCodeFenceAsCode() {
        let blocks = AssistantMarkdown.blocks(in: """
        ```swift
        let state = "streaming"
        """)

        XCTAssertEqual(
            blocks,
            [.code(language: "swift", text: "let state = \"streaming\"")]
        )
    }

    private func activityItem(
        title: String?,
        type: String = "scheduled",
        progress: String = "",
        spentUsd: String = "0",
        budgetUsdLimit: String = "1"
    ) -> ActivityItem {
        .init(
            id: "activity",
            type: type,
            status: "done",
            title: title,
            progress: progress,
            trust: "owner",
            spentUsd: spentUsd,
            budgetUsdLimit: budgetUsdLimit,
            updatedAt: "2026-01-01T00:00:00Z",
            archivedAt: nil,
            hasPendingApproval: false
        )
    }
}
