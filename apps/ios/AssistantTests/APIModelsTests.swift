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

    func testMoodStaysDefaultRegardlessOfThemeCues() {
        let themed = ChatMessage(
            id: "themed",
            role: .assistant,
            parts: [.init(type: "data-theme", data: .object(["name": .string("cool_sky")]))]
        )
        let plain = { (index: Int) in
            ChatMessage.optimistic(role: .assistant, text: "Working", id: "a\(index)")
        }

        let atEdge = [themed] + (0..<(CompanionMood.lookback - 1)).map(plain)
        XCTAssertEqual(CompanionMood.latest(in: atEdge), .default)

        let asLastMessage = [themed]
        XCTAssertEqual(CompanionMood.latest(in: asLastMessage), .default)
    }

    func testMoodIgnoresThemeCuesMixedWithOwnerMessages() {
        let themed = ChatMessage(
            id: "themed",
            role: .assistant,
            parts: [.init(type: "data-theme", data: .object(["name": .string("soft_rose")]))]
        )
        let owner = (0..<40).map { ChatMessage.optimistic(role: .user, text: "Thanks", id: "u\($0)") }

        XCTAssertEqual(CompanionMood.latest(in: [themed] + owner), .default)
        XCTAssertEqual(CompanionMood.latest(in: []), .default)
    }

    func testOptimisticMessageUsesLocalIdentity() {
        let message = ChatMessage.optimistic(role: .user, text: "Hello")
        XCTAssertTrue(message.id.hasPrefix("local-"))
        XCTAssertEqual(message.text, "Hello")
    }

    func testKnowledgeGraphRecallProvenanceDecodesFromMessageParts() throws {
        let data = """
        {"id":"reply-1","role":"assistant","parts":[
          {"type":"text","text":"Here is the answer."},
          {"type":"recall","sources":[{"date":"2026-08-24","label":"Works at Acme","kind":"knowledge_graph","hops":2}]}
        ]}
        """.data(using: .utf8)!
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(message.recallSources.count, 1)
        XCTAssertTrue(message.recallSources[0].isKnowledgeGraph)
        XCTAssertEqual(message.recallSources[0].hops, 2)
    }

    func testResponseCardsUseStructuredPartsBeforeTextFallback() {
        let card = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("calendar"),
                "title": .string("Today"),
                "subtitle": .string("Thursday, August 23"),
                "items": .array([
                    .object([
                        "time": .string("9:30 AM"),
                        "title": .string("Design review"),
                        "detail": .string("Studio"),
                    ]),
                ]),
            ])
        )

        guard case let .agenda(title, subtitle, items)? = MessageResponseCard(part: card) else {
            return XCTFail("Expected a structured agenda card")
        }
        XCTAssertEqual(title, "Today")
        XCTAssertEqual(subtitle, "Thursday, August 23")
        XCTAssertEqual(items.first?.time, "9:30 AM")
        XCTAssertEqual(items.first?.title, "Design review")
    }

    func testCalendarEventCardCarriesOnlyStructuredDetails() {
        let card = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("calendar-event"), "id": .string("event-1"),
                "start": .string("2026-08-24T14:00:00-07:00"),
                "time": .string("2:00 PM–3:00 PM"), "title": .string("Design review"),
                "location": .string("Studio"), "attendees": .array([.string("Ana")]),
                "calendars": .array([.string("Work")]),
                "calendarLink": .object(["url": .string("https://calendar.google.com/event?eid=event-1")]),
                "meetingLink": .object(["url": .string("https://zoom.us/j/12345")]),
            ])
        )
        guard case let .event(id, start, time, title, location, attendees, calendars, calendarLink, meetingLink)? = MessageResponseCard(part: card) else {
            return XCTFail("Expected a structured event card")
        }
        XCTAssertEqual(id, "event-1")
        XCTAssertEqual(start, "2026-08-24T14:00:00-07:00")
        XCTAssertEqual(time, "2:00 PM–3:00 PM")
        XCTAssertEqual(title, "Design review")
        XCTAssertEqual(location, "Studio")
        XCTAssertEqual(attendees, ["Ana"])
        XCTAssertEqual(calendars, ["Work"])
        XCTAssertEqual(calendarLink, "https://calendar.google.com/event?eid=event-1")
        XCTAssertEqual(meetingLink, "https://zoom.us/j/12345")
    }

    func testOtherStructuredCardsDecodeCompleteToolBackedData() {
        let reminder = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("reminder"), "id": .string("reminder-1"),
                "title": .string("**Review** launch plan"), "schedule": .string("0 9 * * 1"),
                "nextFires": .string("2026-08-31T16:00:00.000Z"), "enabled": .bool(true),
            ])
        )
        guard case let .reminder(id, title, schedule, _, enabled)? = MessageResponseCard(part: reminder) else {
            return XCTFail("Expected a reminder card")
        }
        XCTAssertEqual(id, "reminder-1")
        XCTAssertEqual(title, "**Review** launch plan")
        XCTAssertEqual(schedule, "0 9 * * 1")
        XCTAssertTrue(enabled)

        let emails = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("email-results"), "id": .string("email-1"),
                "query": .string("launch"), "mailbox": .string("owner@example.com"),
                "complete": .bool(false), "matchingMessagesEstimate": .number(3),
                "messages": .array([
                    .object([
                        "id": .string("message-1"), "sender": .string("Ada"),
                        "subject": .string("**Launch** update"), "date": .string("today"),
                        "snippet": .string("Everything is ready."),
                    ]),
                ]),
            ])
        )
        guard case let .emails(_, _, query, mailbox, complete, estimate, messages)? = MessageResponseCard(part: emails) else {
            return XCTFail("Expected an email results card")
        }
        XCTAssertEqual(query, "launch")
        XCTAssertEqual(mailbox, "owner@example.com")
        XCTAssertFalse(complete)
        XCTAssertEqual(estimate, 3)
        XCTAssertEqual(messages.first?.subject, "**Launch** update")

        let documents = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("document-results"), "query": .string("launch"),
                "passages": .array([
                    .object([
                        "id": .string("passage-1"), "document": .string("Launch brief"),
                        "source": .string("upload"), "snippet": .string("**Ready** to ship."),
                        "similarity": .number(0.98),
                    ]),
                ]),
            ])
        )
        guard case let .documents(_, _, _, passages)? = MessageResponseCard(part: documents) else {
            return XCTFail("Expected a document results card")
        }
        XCTAssertEqual(passages.first?.document, "Launch brief")
        XCTAssertEqual(passages.first?.similarity, 0.98)

        let drive = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("drive-results"),
                "files": .array([
                    .object([
                        "id": .string("file-1"), "name": .string("Launch deck"),
                        "mimeType": .string("application/pdf"), "size": .string("2048"),
                        "url": .string("https://drive.example.com/launch"),
                    ]),
                ]),
            ])
        )
        guard case let .drive(_, _, _, files)? = MessageResponseCard(part: drive) else {
            return XCTFail("Expected a Drive results card")
        }
        XCTAssertEqual(files.first?.name, "Launch deck")
        XCTAssertEqual(files.first?.url, "https://drive.example.com/launch")

        let resource = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("resource"), "id": .string("doc-1"),
                "resourceType": .string("document"), "title": .string("**Launch** recap"),
                "subtitle": .string("Google Doc created"),
                "details": .array([.object(["label": .string("Shared with"), "value": .string("owner@example.com")])]),
                "link": .object(["label": .string("Open document"), "url": .string("https://docs.example.com/recap")]),
            ])
        )
        guard case let .resource(_, resourceType, title, _, details, linkLabel, linkURL)? = MessageResponseCard(part: resource) else {
            return XCTFail("Expected a resource card")
        }
        XCTAssertEqual(resourceType, "document")
        XCTAssertEqual(title, "**Launch** recap")
        XCTAssertEqual(details.first?.value, "owner@example.com")
        XCTAssertEqual(linkLabel, "Open document")
        XCTAssertEqual(linkURL, "https://docs.example.com/recap")

        let status = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("status"), "title": .string("Email draft ready"),
                "detail": .string("**Launch** recap"), "symbol": .string("envelope.badge.fill"),
                "details": .array([.object(["label": .string("To"), "value": .string("ada@example.com")])]),
            ])
        )
        guard case let .status(_, statusTitle, detail, symbol, statusDetails)? = MessageResponseCard(part: status) else {
            return XCTFail("Expected a status card")
        }
        XCTAssertEqual(statusTitle, "Email draft ready")
        XCTAssertEqual(detail, "**Launch** recap")
        XCTAssertEqual(symbol, "envelope.badge.fill")
        XCTAssertEqual(statusDetails.first?.value, "ada@example.com")
    }

    func testResponseCardsInferWeatherAndDurationOnlyFromStrongSignals() {
        let weather = MessageResponseCard.inferred(
            from: "The weather is sunny and 18°C now. Wind stays light this afternoon."
        )
        guard case let .weather(_, temperature, condition, _)? = weather.first else {
            return XCTFail("Expected a weather card")
        }
        XCTAssertEqual(temperature, "18°C")
        XCTAssertEqual(condition, "Sunny")

        let estimate = MessageResponseCard.inferred(
            from: "This will take about 45 minutes if the source material is ready."
        )
        guard case let .duration(_, duration, _, _)? = estimate.first else {
            return XCTFail("Expected a duration card")
        }
        XCTAssertEqual(duration, "45 minutes")
        XCTAssertTrue(MessageResponseCard.inferred(from: "The answer has 45 lines.").isEmpty)
    }

    func testWeatherCardInferenceUsesMarkdownConditionsInsteadOfRainChance() {
        let weather = MessageResponseCard.inferred(
            from: """
            Here's the weather:
            - 🌡️ **Temperature:** 19°C (66°F)
            - ⛅ **Conditions:** Partly cloudy
            - 💨 **Wind:** 15 km/h (9 mph)
            - 🌧️ **Rain chance:** 0%
            """
        )
        guard case let .weather(_, temperature, condition, details)? = weather.first else {
            return XCTFail("Expected a weather card")
        }
        XCTAssertEqual(temperature, "19°C (66°F)")
        XCTAssertEqual(condition, "Partly cloudy")
        XCTAssertEqual(details.map(\.label), ["Wind", "Rain chance"])
        XCTAssertEqual(details.first?.value, "15 km/h (9 mph)")
    }

    func testWeatherCardInferenceKeepsWeatherMetricsWithoutProvenance() {
        let weather = MessageResponseCard.inferred(
            from: """
            Here's the current weather for San Francisco, CA as of 3:48 PM PDT:
            - **Temperature:** 19°C (66°F)
            - **Conditions:** Partly cloudy
            - **Wind:** 15 km/h (9 mph)
            - **Humidity:** 68%
            - **Rain chance:** 0% (dry all day)
            - **Dew point:** 13°C
            **Today’s range:** 17–20°C (63–68°F). Mild with a light breeze.
            (Source: OpenWeatherMap, refreshed at 3:48 PM.)
            """
        )
        guard case let .weather(location, temperature, _, details)? = weather.first else {
            return XCTFail("Expected a weather card")
        }
        XCTAssertEqual(location, "San Francisco, CA")
        XCTAssertEqual(temperature, "19°C (66°F)")
        XCTAssertEqual(details.map(\.label), ["Today", "Wind", "Humidity", "Rain chance", "Updated", "Dew point"])
        XCTAssertEqual(details[0].value, "17–20°C (63–68°F). Mild with a light breeze.")
        XCTAssertEqual(details[2].value, "68%")
        XCTAssertEqual(details[4].value, "3:48 PM PDT")
        XCTAssertEqual(details[5].value, "13°C")
    }

    func testIdentifierFormattingDoesNotExposeImplementationPunctuation() {
        XCTAssertEqual("web.fetch".sentenceCaseIdentifier, "Web Fetch")
        XCTAssertEqual("adhoc".sentenceCaseIdentifier, "Ad hoc")
        XCTAssertEqual("waiting_approval".sentenceCaseIdentifier, "Waiting for approval")
    }

    func testDecodesActivityParityFlags() throws {
        let data = #"{"id":"1","type":"scheduled","status":"running","title":"Refresh","progress":"Working","trust":"owner","spentUsd":"0","budgetUsdLimit":"1","updatedAt":"2026-01-01T00:00:00Z","archivedAt":null,"hasPendingApproval":false,"hasActiveAutonomy":true,"stuckWaiting":true}"#.data(using: .utf8)!
        let item = try JSONDecoder().decode(ActivityItem.self, from: data)

        XCTAssertEqual(item.hasActiveAutonomy, true)
        XCTAssertEqual(item.stuckWaiting, true)
    }

    func testCapabilityStatusDistinguishesUnavailableFromMissingSetup() throws {
        let unavailableData = #"{"id":"google","title":"Google Workspace","summary":"Workspace tools","enabled":true,"ready":false,"status":"unavailable","detail":"agent readiness unavailable"}"#.data(using: .utf8)!
        let unavailable = try JSONDecoder().decode(WorkspaceCapability.self, from: unavailableData)
        XCTAssertEqual(unavailable.statusTitle, "Status unavailable")

        let legacyData = #"{"id":"google","title":"Google Workspace","summary":"Workspace tools","enabled":true,"ready":false,"detail":"missing Google OAuth credentials"}"#.data(using: .utf8)!
        let legacy = try JSONDecoder().decode(WorkspaceCapability.self, from: legacyData)
        XCTAssertEqual(legacy.statusTitle, "Setup needed")
    }

    func testActivityTitlesKeepHumanLanguageAndFormatMachineIdentifiers() {
        let generatedTitle = activityItem(title: "document-processing")
        let humanTitle = activityItem(title: "Review the travel plan")
        let missingTitle = activityItem(title: nil, type: "ambient-refresh")

        XCTAssertEqual(generatedTitle.displayTitle, "Document Processing")
        XCTAssertEqual(humanTitle.displayTitle, "Review the travel plan")
        XCTAssertEqual(missingTitle.displayTitle, "Ambient Refresh")
    }

    func testGoalTitlesHideAutomationRunIdentifiers() {
        let generated = goalRecord(title: "gate-test-1787275766328-0.08720229193630735")
        let human = goalRecord(title: "Find a senior product role")
        let machine = goalRecord(title: "quarterly-review")

        XCTAssertEqual(generated.displayTitle, "Gate Test")
        XCTAssertEqual(human.displayTitle, "Find a senior product role")
        XCTAssertEqual(machine.displayTitle, "Quarterly Review")
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

    func testLiveActivityContentKeepsPromptPrivateAndExpiresQuickly() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let content = LiveActivityManager.content(
            thought: .thinking,
            detail: "Private calendar and travel details",
            pendingCount: 0,
            now: now
        )

        XCTAssertEqual(content.state.detail, "Preparing a response")
        XCTAssertEqual(content.staleDate, now.addingTimeInterval(60))
        XCTAssertEqual(content.relevanceScore, 0.65)
    }

    func testOnlyOwnerDecisionsAreEligibleForTheSystemIsland() {
        XCTAssertFalse(LiveActivityManager.shouldPresentSystemActivity(for: .thinking, pendingCount: 0))
        XCTAssertFalse(LiveActivityManager.shouldPresentSystemActivity(for: .backgroundWork, pendingCount: 0))
        XCTAssertFalse(LiveActivityManager.shouldPresentSystemActivity(for: .finished, pendingCount: 0))
        XCTAssertFalse(LiveActivityManager.shouldPresentSystemActivity(for: .needsYou, pendingCount: 0))
        XCTAssertTrue(LiveActivityManager.shouldPresentSystemActivity(for: .needsYou, pendingCount: 1))
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

    func testActivityCrownAttachesAcrossDynamicIslandSafeAreas() {
        XCTAssertEqual(
            ActivityCrown.islandTopInset(safeAreaTopInset: 59),
            10,
            accuracy: 0.001
        )
        XCTAssertEqual(
            ActivityCrown.islandTopInset(safeAreaTopInset: 62),
            13,
            accuracy: 0.001
        )
        XCTAssertEqual(
            ActivityCrown.islandTopInset(safeAreaTopInset: 47),
            14,
            accuracy: 0.001
        )
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
        // A turn the owner stopped should not tell them to open the app they
        // stopped it from, even though it shares the failed tone.
        XCTAssertEqual(
            LiveActivityManager.safeDetail(for: .stoppedByYou, proposed: "Anything private"),
            "You stopped this turn"
        )
        XCTAssertEqual(
            LiveActivityManager.safeDetail(for: .stopped, proposed: "Anything private"),
            "Open Assistant for details"
        )
    }

    func testToolProgressNeverPublishesATerminalTurnState() {
        // A single finished tool call is not a finished turn. Publishing its own
        // tone made the activity surfaces claim the whole turn was done — and
        // fire a success haptic — after every successful step.
        for status in ["succeeded", "failed", "denied", "awaiting_approval", "running"] {
            let activity = ToolActivity(toolName: "web.search", status: status, step: 2)
            XCTAssertEqual(
                activity.inProgressThought.tone,
                .working,
                "Tool status \(status) should read as progress, not an outcome"
            )
            XCTAssertEqual(activity.inProgressThought.label, activity.displayLabel)
        }

        // The per-step accessor keeps reporting the tool's own outcome.
        XCTAssertEqual(
            ToolActivity(toolName: "web.search", status: "succeeded", step: 2).thought.tone,
            .done
        )
    }

    func testPullMenuMotionCoversBoundaryReversalFlingAndAccessibilityCases() {
        // The regular menu is 236pt tall; its opening action must stay short
        // even though its two rows make the sheet visually substantial.
        let standardHeight: CGFloat = 236
        let accessibilityHeight: CGFloat = 360

        XCTAssertEqual(
            PullMenuMotion.openingCommitmentDistance(revealHeight: standardHeight),
            59,
            accuracy: 0.001
        )
        XCTAssertEqual(
            PullMenuMotion.openingCommitmentDistance(revealHeight: accessibilityHeight),
            60,
            accuracy: 0.001
        )
        XCTAssertEqual(PullMenuMotion.openingCommitmentDistance(revealHeight: 0), 0)
        XCTAssertEqual(PullMenuMotion.closingCommitmentDistance(revealHeight: standardHeight), 51.92, accuracy: 0.001)
        XCTAssertEqual(PullMenuMotion.closingCommitmentDistance(revealHeight: accessibilityHeight), 56, accuracy: 0.001)

        // Upward, downward, and over-extended drags all follow one clamped
        // path. That is what prevents a reversing slow pull from snap-back.
        XCTAssertEqual(
            PullMenuMotion.openingDistance(translationY: -34, revealHeight: standardHeight),
            34
        )
        XCTAssertEqual(
            PullMenuMotion.openingDistance(translationY: 18, revealHeight: standardHeight),
            0
        )
        XCTAssertEqual(
            PullMenuMotion.openingDistance(translationY: -900, revealHeight: standardHeight),
            standardHeight
        )
        XCTAssertEqual(
            PullMenuMotion.closingDistance(translationY: 34, revealHeight: standardHeight),
            34
        )
        XCTAssertEqual(
            PullMenuMotion.closingDistance(translationY: -18, revealHeight: standardHeight),
            0
        )
        XCTAssertEqual(
            PullMenuMotion.closingDistance(translationY: 900, revealHeight: standardHeight),
            standardHeight
        )

        // A quick flick can commit, but only in the direction of the menu;
        // a prediction pointing the other way cannot make a menu open/close.
        XCTAssertEqual(
            PullMenuMotion.projectedOpeningDistance(
                translationY: -18,
                predictedEndTranslationY: -75,
                revealHeight: standardHeight
            ),
            75
        )
        XCTAssertEqual(
            PullMenuMotion.projectedOpeningDistance(
                translationY: 18,
                predictedEndTranslationY: 60,
                revealHeight: standardHeight
            ),
            0
        )
        XCTAssertEqual(
            PullMenuMotion.projectedClosingDistance(
                translationY: 18,
                predictedEndTranslationY: 75,
                revealHeight: standardHeight
            ),
            75
        )
        XCTAssertEqual(
            PullMenuMotion.projectedClosingDistance(
                translationY: -18,
                predictedEndTranslationY: -60,
                revealHeight: standardHeight
            ),
            0
        )

        // UIKit's predicted end can be surprisingly large for a tiny probe.
        // Momentum is accepted only after enough physical travel, and a slow
        // release always lands where the finger actually stopped.
        XCTAssertEqual(
            PullMenuMotion.releaseDistance(
                actualDistance: 24,
                projectedDistance: 90,
                gestureDuration: 0.08
            ),
            24
        )
        XCTAssertEqual(
            PullMenuMotion.releaseDistance(
                actualDistance: 36,
                projectedDistance: 90,
                gestureDuration: 0.35
            ),
            36
        )
        XCTAssertEqual(
            PullMenuMotion.releaseDistance(
                actualDistance: 36,
                projectedDistance: 90,
                gestureDuration: 0.1
            ),
            90
        )

        // Both directions reject sideways and ambiguous diagonals. Opening
        // shares its grab region with the composer, while closing coexists
        // with the horizontally scrolling extra-large menu.
        XCTAssertTrue(PullMenuMotion.hasOpeningIntent(translationX: 8, translationY: -40))
        XCTAssertFalse(PullMenuMotion.hasOpeningIntent(translationX: 40, translationY: -8))
        XCTAssertFalse(PullMenuMotion.hasOpeningIntent(translationX: 20, translationY: -20))
        XCTAssertFalse(PullMenuMotion.hasOpeningIntent(translationX: 4, translationY: 40))
        XCTAssertTrue(PullMenuMotion.hasClosingIntent(translationX: 8, translationY: 40))
        XCTAssertFalse(PullMenuMotion.hasClosingIntent(translationX: 40, translationY: 8))
        XCTAssertFalse(PullMenuMotion.hasClosingIntent(translationX: 20, translationY: 20))
        XCTAssertFalse(PullMenuMotion.hasClosingIntent(translationX: 4, translationY: -40))

        // Early diagonal jitter remains undecided instead of permanently
        // stealing the gesture from the direction the finger settles into.
        XCTAssertFalse(PullMenuMotion.hasOpeningIntent(translationX: 12, translationY: -11))
        XCTAssertFalse(PullMenuMotion.hasHorizontalIntent(translationX: 12, translationY: -11))
        XCTAssertTrue(PullMenuMotion.hasOpeningIntent(translationX: 12, translationY: -30))
        XCTAssertFalse(PullMenuMotion.hasHorizontalIntent(translationX: 12, translationY: -30))

        // Tiny probes do not claim either axis, while deliberate horizontal
        // swipes keep cursor movement and accessibility strips undisturbed.
        XCTAssertFalse(PullMenuMotion.hasOpeningIntent(translationX: 3, translationY: -9))
        XCTAssertFalse(PullMenuMotion.hasClosingIntent(translationX: 3, translationY: 9))
        XCTAssertFalse(PullMenuMotion.hasHorizontalIntent(translationX: 11, translationY: 1))
        XCTAssertTrue(PullMenuMotion.hasHorizontalIntent(translationX: 18, translationY: 4))

        XCTAssertFalse(
            PullMenuMotion.holdsOpeningDetent(
                revealDistance: 58,
                revealHeight: standardHeight,
                detentHeld: false
            )
        )
        XCTAssertTrue(
            PullMenuMotion.holdsOpeningDetent(
                revealDistance: 59,
                revealHeight: standardHeight,
                detentHeld: false
            )
        )
        XCTAssertTrue(
            PullMenuMotion.holdsOpeningDetent(
                revealDistance: 48,
                revealHeight: standardHeight,
                detentHeld: true
            )
        )
        XCTAssertFalse(
            PullMenuMotion.holdsOpeningDetent(
                revealDistance: 47,
                revealHeight: standardHeight,
                detentHeld: true
            )
        )

        // Once an opened menu's close detent has fired at roughly 64pt, a
        // release stays closed. A shallow downward probe springs back open.
        XCTAssertFalse(
            PullMenuMotion.closesOnRelease(
                dragDistance: 63,
                revealHeight: standardHeight,
                detentHeld: true
            )
        )
        XCTAssertTrue(
            PullMenuMotion.closesOnRelease(
                dragDistance: 64,
                revealHeight: standardHeight,
                detentHeld: true
            )
        )
        XCTAssertFalse(
            PullMenuMotion.closesOnRelease(
                dragDistance: 39,
                revealHeight: standardHeight,
                detentHeld: false
            )
        )
        XCTAssertTrue(
            PullMenuMotion.closesOnRelease(
                dragDistance: 40,
                revealHeight: standardHeight,
                detentHeld: false
            )
        )
    }

    func testWorkspaceCostBreakdownsAcceptPostgresAggregateCounts() throws {
        // PostgreSQL count(*) may reach an older mobile API deployment as a
        // JSON string, while the current endpoint normalizes it to a number.
        // The phone must load Workspace in either case.
        let stringCount = #"[{"source":"tool","usd":"0.012","count":"3"}]"#.data(using: .utf8)!
        let numericCount = #"[{"model":"gpt-5","usd":"0.024","count":4}]"#.data(using: .utf8)!

        let bySource = try JSONDecoder().decode([WorkspaceCostBreakdown].self, from: stringCount)
        let byModel = try JSONDecoder().decode([WorkspaceModelBreakdown].self, from: numericCount)

        XCTAssertEqual(bySource[0].count, 3)
        XCTAssertEqual(byModel[0].count, 4)
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
                .capabilities,
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
                .list([
                    .init(marker: .bullet, text: "Leave early", children: []),
                    .init(marker: .bullet, text: "Keep a flexible fare", children: []),
                ]),
                .list([
                    .init(marker: .task(isComplete: true), text: "Compare dates", children: []),
                    .init(marker: .task(isComplete: false), text: "Book the flight", children: []),
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

    private func goalRecord(title: String) -> GoalRecord {
        .init(
            id: "goal",
            title: title,
            description: "",
            status: "active",
            priority: 0,
            progress: "",
            nextAction: "",
            targetDate: nil,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            archivedAt: nil,
            mirrorToPrimary: false,
            autonomy: true,
            taintedOrigin: false
        )
    }
}
