import XCTest
import CoreLocation
@testable import Assistant

enum KnowledgeGraphFixture {
    static let focus = KnowledgeEntity(id: "alex", label: "Alex Morgan", kind: "person", canonicalKey: "alex")
    static func relation(id: String, other: KnowledgeEntity, predicate: String = "knows",
                         inbound: Bool = false, review: String = "confirmed", inRecall: Bool = true) -> KnowledgeRelation {
        let subject = inbound ? other : focus
        let object = inbound ? focus : other
        let sentence = "\(subject.label) \(predicate.replacingOccurrences(of: "_", with: " ")) \(object.label)."
        return KnowledgeRelation(id: id, subject: subject, predicate: predicate, object: object,
            confidence: 1, reviewStatus: review, validFrom: nil, validUntil: nil, inRecall: inRecall,
            source: KnowledgeSource(memoryId: id, content: sentence, createdAt: "2026-09-06",
                ownerConfirmed: review == "confirmed", originTrust: "owner"),
            presentation: KnowledgePresentation(sentence: sentence, label: predicate, accessibleLabel: sentence))
    }
    static var relations: [KnowledgeRelation] {
        let robin = KnowledgeEntity(id: "robin", label: "Robin Morgan", kind: "person", canonicalKey: "robin")
        return [
            relation(id: "studio", other: .init(id: "studio", label: "Northstar Studio", kind: "organization", canonicalKey: "studio"), predicate: "works_at"),
            relation(id: "sf", other: .init(id: "sf", label: "San Francisco", kind: "place", canonicalKey: "sf"), predicate: "lives_in"),
            relation(id: "robin1", other: robin, predicate: "parent_of", inbound: true, review: "unreviewed"),
            relation(id: "robin2", other: robin, predicate: "parent_of", inbound: true, review: "unreviewed"),
            relation(id: "trip", other: .init(id: "trip", label: "Summer road trip", kind: "project", canonicalKey: "trip"), predicate: "planning"),
            relation(id: "event", other: .init(id: "event", label: "Design meetup", kind: "event", canonicalKey: "event"), predicate: "attends", review: "unreviewed")
        ]
    }
}

enum PeopleMapFixture {
    static func relation(_ id: String, name: String, sentence: String, contact: String? = nil,
                         unreviewed: Bool = false) -> PersonRelationSummary {
        .init(id: id, sentence: sentence, otherLabel: name, otherInitials: String(name.prefix(1)),
              otherContactId: contact, span: "", unreviewed: unreviewed)
    }
    static let relations: [PersonRelationSummary] = [
        relation("father", name: "Alex Morgan", sentence: "Alex Morgan is Robin Morgan's father.", contact: "alex"),
        relation("inverse", name: "Alex Morgan", sentence: "Robin Morgan is Alex Morgan's daughter.", contact: "alex"),
        relation("conflict", name: "Alex Morgan", sentence: "Alex Morgan is Robin Morgan's child.", contact: "alex", unreviewed: true),
        relation("mother", name: "Katharine Leigh Innes", sentence: "Katharine Leigh Innes is Robin Morgan's mother.", contact: "kat"),
        relation("sibling", name: "Brynjar Smári Baldvinsson", sentence: "Robin Morgan and Brynjar Smári Baldvinsson are siblings.", contact: "brynjar"),
        relation("custom", name: "Dr. Taylor Lee", sentence: "Dr. Taylor Lee attended a workshop with Robin Morgan.", unreviewed: true),
        relation("sam", name: "Sam Morgan", sentence: "Robin Morgan and Sam Morgan are partners.", contact: "sam")
    ]
    static func card(relations: [PersonRelationSummary] = relations) -> PersonCard {
        .init(id: "robin", name: "Robin Morgan", initials: "RM", relationship: "", group: "other",
              groupLabel: "", trust: "owner", location: nil, birthday: nil, lastContact: nil,
              howWeMet: [], relations: relations, connections: [], events: [], eventsAreRecent: false,
              reminder: nil, factCount: relations.count)
    }
}

final class APIModelsTests: XCTestCase {
    func testPeopleMapKeepsContradictionsUnknownRolesAndExactEvidence() throws {
        let branches = PeopleConnectionBranch.branches(for: PeopleMapFixture.card())
        XCTAssertEqual(branches.count, 5)
        let alex = try XCTUnwrap(branches.first { $0.contactID == "alex" })
        XCTAssertEqual(alex.label, "Child · Father")
        XCTAssertTrue(alex.needsReview)
        XCTAssertEqual(alex.group.relations.map(\.id), ["father", "inverse", "conflict"])
        let unknown = try XCTUnwrap(branches.first { $0.contactID == nil })
        XCTAssertEqual(unknown.label, "Recorded connection")
        XCTAssertEqual(unknown.detail, PeopleMapFixture.relations[5].sentence)
        XCTAssertEqual(unknown.group.representative.sentence, PeopleMapFixture.relations[5].sentence)
        XCTAssertEqual(branches.map(\.id), PeopleConnectionBranch.branches(
            for: PeopleMapFixture.card(relations: PeopleMapFixture.relations.reversed())).map(\.id))
        XCTAssertEqual(branches.flatMap { $0.group.relations }.count, PeopleMapFixture.relations.count)
    }

    func testPeopleMapDoesNotInventSelfLinksOrMergeDistinctPeopleWithSameName() {
        let rows = [
            PeopleMapFixture.relation("self", name: "Robin Morgan", sentence: "Self record", contact: "robin"),
            PeopleMapFixture.relation("one", name: "Alex", sentence: "A recorded mention", contact: "one"),
            PeopleMapFixture.relation("two", name: "Alex", sentence: "Another mention", contact: "two"),
            PeopleMapFixture.relation("unknown", name: "Alex", sentence: "Unlinked mention")
        ]
        let branches = PeopleConnectionBranch.branches(for: PeopleMapFixture.card(relations: rows))
        XCTAssertEqual(branches.count, 3)
        XCTAssertEqual(Set(branches.compactMap(\.contactID)), ["one", "two"])
        XCTAssertTrue(PeopleConnectionBranch.branches(for: PeopleMapFixture.card(relations: [])).isEmpty)
        let historical = PersonRelationSummary(id: "old", sentence: "Alex is Robin Morgan's spouse.",
            otherLabel: "Alex", otherInitials: "A", otherContactId: "alex", span: "2010–2015", unreviewed: false)
        XCTAssertEqual(PeopleConnectionBranch.branches(for: PeopleMapFixture.card(relations: [historical])).first?.detail,
            "2010–2015", "The map must retain the stated relationship period")
    }

    func testPeopleMapTraversalRetracesCyclesWithoutDuplicatingNavigation() {
        XCTAssertEqual(PeopleConnectionBranch.exploring("robin", from: []), ["robin"])
        XCTAssertEqual(PeopleConnectionBranch.exploring("alex", from: ["robin"]), ["robin", "alex"])
        XCTAssertEqual(PeopleConnectionBranch.exploring("robin", from: ["robin", "alex"]), ["robin"])
        XCTAssertEqual(PeopleConnectionBranch.exploring("alex", from: ["robin", "alex"]), ["robin", "alex"])
    }
    func testKnowledgeMapKeepsRealDirectionsAndGroupsEvidenceWithoutInventingLinks() throws {
        let focus = KnowledgeGraphFixture.focus
        let relations = KnowledgeGraphFixture.relations
        let neighbors = KnowledgeGraphNeighbor.neighbors(of: focus, relations: relations)
        XCTAssertEqual(neighbors.count, 5)
        XCTAssertEqual(Set(neighbors.map(\.id)).count, neighbors.count)
        let family = try XCTUnwrap(neighbors.first { $0.id == "robin" })
        XCTAssertTrue(family.hasIncoming(to: focus.id))
        XCTAssertFalse(family.hasOutgoing(from: focus.id))
        XCTAssertEqual(family.connections.count, 1, "Duplicate source evidence shares a single link")
        XCTAssertEqual(family.connections[0].sources.count, 2)
        XCTAssertEqual(family.linkLabel, "Parent of")
        XCTAssertFalse(family.confirmed)
        XCTAssertTrue(neighbors.first?.confirmed == true, "Reviewed links lead the map")
        XCTAssertEqual(neighbors.map(\.id), KnowledgeGraphNeighbor.neighbors(of: focus, relations: relations.reversed()).map(\.id))

        let other = KnowledgeEntity(id: "other", label: "Other", kind: "person", canonicalKey: "other")
        XCTAssertTrue(KnowledgeGraphNeighbor.neighbors(of: other, relations: relations).isEmpty)
        XCTAssertTrue(KnowledgeGraphNeighbor.neighbors(of: focus, relations: []).isEmpty)
        let inactive = KnowledgeGraphFixture.relation(id: "old", other: other, inRecall: false)
        let rejected = KnowledgeGraphFixture.relation(id: "rejected", other: other, review: "rejected")
        let loop = KnowledgeGraphFixture.relation(id: "self", other: focus)
        XCTAssertTrue(KnowledgeGraphNeighbor.neighbors(of: focus, relations: [inactive, rejected, loop]).isEmpty)
    }

    func testLocationFixRejectsCachedInaccurateAndUnconfirmedSamples() {
        let now = Date()
        func fix(age: TimeInterval = 0, accuracy: Double = 30, latitude: Double = 37.77) -> CLLocation {
            CLLocation(coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: -122.42),
                altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: -1,
                timestamp: now.addingTimeInterval(-age))
        }
        XCTAssertTrue(LocationFixPolicy.isUsable(fix(), now: now))
        for sample in [fix(age: 60), fix(age: -60), fix(accuracy: -1), fix(accuracy: 3000), fix(latitude: 100)] {
            XCTAssertFalse(LocationFixPolicy.isUsable(sample, now: now))
        }
        XCTAssertTrue(LocationFixPolicy.confirms(fix(age: 3), with: fix(), now: now))
        XCTAssertFalse(LocationFixPolicy.confirms(fix(), with: fix(), now: now))
        XCTAssertFalse(LocationFixPolicy.confirms(fix(age: 1), with: fix(), now: now))
        XCTAssertFalse(LocationFixPolicy.confirms(fix(age: 20), with: fix(), now: now))
        XCTAssertFalse(LocationFixPolicy.confirms(fix(age: 3), with: fix(latitude: 37.8), now: now))
        XCTAssertFalse(LocationFixPolicy.confirms(fix(age: 3), with: fix(accuracy: 3000), now: now))
    }

    func testSituationPackMissingRouteHasActionableCopy() {
        XCTAssertEqual(
            SituationPackLoadFailure.message(for: APIError.server(status: 404, message: "not found")),
            "Situation packs aren’t available on this server yet. Update the server, then try again.")
        XCTAssertEqual(
            SituationPackLoadFailure.message(for: APIError.unauthorized),
            APIError.unauthorized.localizedDescription)
    }
    func testSituationPackDecodesResponsibilityAndReviewWithoutInventingCompletion() throws {
        let data = Data("""
        {"packs":[{"id":"pack","title":"Soccer weekend","version":3,"archived":false,"updatedAt":"2026-09-06T12:00:00Z",
        "data":{"items":[{"id":"ride","title":"Confirm ride","details":"","lane":"i_owe","dependsOn":["reply"],"source":null,"snapshot":null,"needsReview":true}],"decisions":[{"id":"dinner","option":"Late dinner","outcome":"rejected","reason":"Too late","scope":"situation","confirmed":true}]},"changes":[],"affectedIds":["ride"]}],"sources":[]}
        """.utf8)
        let overview = try JSONDecoder().decode(SituationOverview.self, from: data)
        XCTAssertEqual(overview.packs.first?.data.items.first?.lane, "i_owe")
        XCTAssertEqual(overview.packs.first?.data.items.first?.needsReview, true)
        XCTAssertEqual(overview.packs.first?.data.decisions.first?.scope, "situation")
    }

    func testSituationPreviewCommandPreservesVersionAndSourceIdentity() throws {
        let item = SituationItem(title: "New hotel", source: .init(kind: "card", id: "card-id"))
        let command = SituationCommand(action: "preview", packId: "pack-id", version: 7, item: item)
        let data = try JSONEncoder().encode(command)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["action"] as? String, "preview")
        XCTAssertEqual(json["version"] as? Int, 7)
        XCTAssertNil(json["previewId"])
        let encodedItem = try XCTUnwrap(json["item"] as? [String: Any])
        XCTAssertEqual((encodedItem["source"] as? [String: String])?["id"], "card-id")
    }
    func testApprovalSummaryDecodesApprovedDeniedAndExpiredOutcomes() throws {
        for status in ["approved", "denied", "expired"] {
            let data = Data("""
            {"id":"summary","role":"assistant","parts":[
              {"type":"approval-summary","purpose":"Check a place","approvalCount":1,
               "approvalIds":["a1"],"pendingCount":0,
               "outcomes":[{"id":"a1","summary":"Search the web","status":"\(status)"}]}
            ]}
            """.utf8)
            let message = try JSONDecoder().decode(ChatMessage.self, from: data)
            XCTAssertEqual(message.approvalSummary?.pendingCount, 0)
            XCTAssertEqual(message.approvalSummary?.outcomes.first?.status, status)
            XCTAssertFalse(message.hasPendingDecision)
            XCTAssertTrue(message.visibleTextBubbles.isEmpty)
        }
    }

    func testApprovalSummariesStayInPollingUntilEveryDecisionIsAnswered() throws {
        let legacy = ChatMessage(id: "legacy", role: .assistant,
            parts: [.init(type: "approval-summary", purpose: "Check a place", approvalCount: 2)])
        XCTAssertTrue(legacy.hasPendingDecision)
        XCTAssertEqual(legacy.approvalSummary?.pendingCount, 2)
        let pending = ChatMessage(id: "linked", role: .assistant,
            parts: [.init(type: "approval-summary", purpose: "Check a place", approvalCount: 2,
                approvalIds: ["a1", "a2"], pendingCount: 2,
                outcomes: [.init(id: "a1", summary: "First", status: "pending"),
                    .init(id: "a2", summary: "Second", status: "pending")])])
        let partial = pending.applyingApprovalDecisions(["a1": "approved"])
        XCTAssertEqual(partial.approvalSummary?.pendingCount, 1)
        XCTAssertTrue(partial.hasPendingDecision)
        XCTAssertEqual(partial.applyingApprovalDecisions(["a1": "approved"]), partial,
            "Repeated receipts must not decrement the count twice")
        let settled = partial.applyingApprovalDecisions(["a2": "denied"])
        XCTAssertEqual(settled.approvalSummary?.pendingCount, 0)
        XCTAssertFalse(settled.hasPendingDecision)
        XCTAssertEqual(settled.approvalSummary?.outcomes.map(\.status), ["approved", "denied"])
    }

    func testAcceptedDecisionOverlaysStalePollWithoutChangingOtherApprovalsOrText() {
        let pending = ChatMessage(id: "linked", role: .assistant, parts: [
            .init(type: "text", text: "Original context"),
            .init(type: "approval", approvalId: "a1", status: "pending"),
            .init(type: "approval-summary", purpose: "Check a place", approvalCount: 2,
                approvalIds: ["a1", "a2"]),
        ])
        for status in ["approved", "denied"] {
            let decisions = ["a1": status]
            let settled = pending.applyingApprovalDecisions(decisions)
            XCTAssertEqual(settled.parts[1].status, status)
            XCTAssertEqual(settled.approvalSummary?.pendingCount, 1)
            XCTAssertEqual(settled.text, "Original context")
            XCTAssertEqual(pending.applyingApprovalDecisions(decisions), settled)
        }
        XCTAssertEqual(pending.applyingApprovalDecisions([:]), pending,
            "No acknowledged decision means no change, including after a failed request")
        XCTAssertEqual(pending.applyingApprovalDecisions(["unrelated": "approved"]), pending)
    }

    func testPeopleGroupsInverseFamilyFactsAndKeepsEveryEvidenceRow() throws {
        func relation(_ id: String, _ sentence: String, _ name: String, contact: String? = nil,
            unreviewed: Bool = false, span: String = "") -> PersonRelationSummary {
            .init(id: id, sentence: sentence, otherLabel: name, otherInitials: "AB",
                otherContactId: contact, span: span, unreviewed: unreviewed)
        }
        let rows = [
            relation("1", "Alex is Robin's father.", "Alex"),
            relation("2", "Robin is Alex's daughter.", "Alex"),
            relation("3", "Alex is Robin's is father.", "Alex"),
            relation("4", "Alex visited with Robin.", "Alex", unreviewed: true, span: "Since 2024"),
            relation("5", "Dr. Lee attended Robin.", "Dr. Lee"),
            relation("6", "Robin and Sam are siblings.", "Sam", contact: "sam"),
        ]
        let groups = PersonRelationGroup.group(rows, personName: "Robin")
        XCTAssertEqual(groups.count, 3)
        XCTAssertEqual(groups[0].roles, ["Father"])
        XCTAssertEqual(groups[0].relationshipEvidence.map(\.id), ["1", "2", "3"])
        XCTAssertEqual(groups[0].otherDetails.map(\.id), ["4"])
        XCTAssertTrue(groups[0].otherDetails[0].unreviewed)
        XCTAssertEqual(groups[0].otherDetails[0].span, "Since 2024")
        XCTAssertEqual(groups.flatMap(\.relations).count, rows.count)
        XCTAssertEqual(groups[1].roles, [])
        XCTAssertEqual(groups[2].roles, ["Sibling"])
        XCTAssertEqual(groups[2].representative.otherContactId, "sam")
    }

    func testPeopleGroupingDoesNotGuessRolesOrMergeDistinctContactIDs() {
        let rows = [
            PersonRelationSummary(id: "1", sentence: "Alex is Robin's father.", otherLabel: "Alex",
                otherInitials: "A", otherContactId: "alex1", span: "", unreviewed: true),
            PersonRelationSummary(id: "2", sentence: "Alex is Robin's mother.", otherLabel: "Alex",
                otherInitials: "A", otherContactId: "alex2", span: "", unreviewed: false),
            PersonRelationSummary(id: "3", sentence: "Alex visited Robin's father.", otherLabel: "Alex",
                otherInitials: "A", otherContactId: nil, span: "", unreviewed: false),
        ]
        let groups = PersonRelationGroup.group(rows, personName: "Robin")
        XCTAssertEqual(groups.count, 3)
        XCTAssertEqual(groups.map(\.roles), [["Father"], ["Mother"], []])
        XCTAssertNil(PersonRelationGroup.role(rows[0], personName: "Someone else"))
        XCTAssertTrue(PersonRelationGroup.group([], personName: "Robin").isEmpty)
    }

    func testMenuHeightCountsThePartiallyFilledPeopleAndMoreRow() {
        XCTAssertEqual(PullMenuMotion.menuRowCount(itemCount: 9, columns: 2), 5)
        XCTAssertEqual(PullMenuMotion.menuRowCount(itemCount: 9, columns: 3), 3)
        XCTAssertEqual(PullMenuMotion.menuRowCount(itemCount: 9, columns: 9), 1)
        XCTAssertEqual(PullMenuMotion.menuRowCount(itemCount: 8, columns: 2), 4)
        XCTAssertEqual(PullMenuMotion.menuRowCount(itemCount: 0, columns: 2), 0)
        XCTAssertEqual(PullMenuMotion.menuRowCount(itemCount: 9, columns: 0), 0)
    }

    @MainActor
    func testPeopleAndRelationshipLinksPushAboveDirectoryAndPopInOrder() {
        let model = AppModel()
        model.present(.people)
        model.navigationPath.append(.person(id: "ada"))
        model.navigationPath.append(.person(id: "grace"))
        XCTAssertEqual(model.navigationPath, [.route(.people), .person(id: "ada"), .person(id: "grace")])
        XCTAssertEqual(model.presentedRoute, .people)

        model.navigationPath.removeLast()
        XCTAssertEqual(model.navigationPath.last, .person(id: "ada"))
        model.navigationPath.removeLast()
        XCTAssertEqual(model.navigationPath, [.route(.people)])
        model.navigationPath.removeLast()
        XCTAssertNil(model.presentedRoute)
    }

    @MainActor
    func testChangingRouteAndReturningToChatClearPersonHistory() {
        let model = AppModel()
        model.present(.people)
        model.navigationPath.append(.person(id: "ada"))
        model.present(.approvals)
        XCTAssertEqual(model.navigationPath, [.route(.approvals)])
        model.returnToChat()
        XCTAssertTrue(model.navigationPath.isEmpty)

        model.present(.people)
        model.navigationPath.append(.person(id: "grace"))
        model.present(.chat)
        XCTAssertTrue(model.navigationPath.isEmpty)
        XCTAssertNil(model.presentedRoute)
    }

    @MainActor
    func testMemoryDirectoryShortcutUsesSameNavigationPath() {
        let model = AppModel()
        model.present(.memory)
        model.presentedRoute = .people
        XCTAssertEqual(model.navigationPath, [.route(.people)])
        model.navigationPath.append(.person(id: "ada"))
        model.presentedRoute = nil
        XCTAssertTrue(model.navigationPath.isEmpty)
    }

    func testLookupCardsDoNotReplaceTheirAnswer() throws {
        let data = Data(#"{"id":"m1","role":"assistant","parts":[{"type":"text","text":"These interviews are historical, not current applications."},{"type":"data-card","data":{"kind":"calendar-event","id":"e1","title":"Interview"}}]}"#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertTrue(message.hasSupportingResultCards)
        XCTAssertEqual(message.visibleTextBubbles, ["These interviews are historical, not current applications."])
        XCTAssertFalse(ChatMessage.optimistic(role: .user, text: "Hello").hasSupportingResultCards)
    }
    func testDecodesRetractedMessageWithoutRenderingItsOriginalAsMarkdown() throws {
        let data = #"{"id":"m1","role":"assistant","parts":[{"type":"text","text":"This response was retracted."},{"type":"notice","notice":"retracted","reason":"Unsupported source data.","originalText":"[Fake link](https://example.invalid)","repairId":"repair-v1"}]}"#.data(using: .utf8)!
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(message.noticeKind, .retracted)
        XCTAssertEqual(message.retractionReason, "Unsupported source data.")
        XCTAssertEqual(message.retractedOriginalText, "[Fake link](https://example.invalid)")
    }

    func testKnowledgeCleanupAndImpactDecode() throws {
        let cleanup = try JSONDecoder().decode(
            KnowledgeCleanupResponse.self,
            from: Data(#"{"findings":[{"id":"unreviewed_connection:r1","kind":"unreviewed_connection","title":"Review a new connection","detail":"Ada works at Acme.","memoryId":"m1","relationId":"r1","count":1}]}"#.utf8)
        )
        XCTAssertEqual(cleanup.findings.first?.relationId, "r1")
        let impact = try JSONDecoder().decode(
            KnowledgeSourceImpact.self,
            from: Data(#"{"memoryId":"m1","content":"Ada works at Acme.","connectionCount":1,"orphanedItems":[{"id":"e1","label":"Acme"}]}"#.utf8)
        )
        XCTAssertEqual(impact.connectionCount, 1)
        XCTAssertEqual(impact.orphanedItems.first?.label, "Acme")
    }

    @MainActor
    func testMemoryReviewBadgeFollowsLatestServerProjection() {
        let model = AppModel()
        let health = { (awaitingReview: Int) in
            MemoryHealth(
                totalUsable: 12,
                notYetOrganized: 2,
                awaitingReview: awaitingReview,
                ownerConfirmed: 4,
                lastOrganizedAt: nil
            )
        }

        model.applyMemoryHealth(health(1))
        XCTAssertEqual(model.memoryReviewCount, 1)

        model.applyMemoryHealth(health(0))
        XCTAssertEqual(model.memoryReviewCount, 0)
    }

    func testAssistantFlowLayoutUsesConsistentSpacingAndWrapping() {
        let metrics = AssistantFlowLayout.metrics(
            sizes: [
                CGSize(width: 50, height: 20),
                CGSize(width: 40, height: 30),
                CGSize(width: 30, height: 10),
            ],
            availableWidth: 100,
            spacing: 8
        )

        XCTAssertEqual(
            metrics.origins,
            [CGPoint(x: 0, y: 0), CGPoint(x: 58, y: 0), CGPoint(x: 0, y: 38)]
        )
        XCTAssertEqual(metrics.size, CGSize(width: 98, height: 48))
    }

    func testPollingPolicyBacksOffWithoutMakingFreshRepliesFeelSlow() {
        XCTAssertEqual(PollingPolicy.replyIntervalMilliseconds(attempt: 1, hasTaskID: false), 650)
        XCTAssertEqual(PollingPolicy.replyIntervalMilliseconds(attempt: 8, hasTaskID: false), 1_500)
        XCTAssertEqual(PollingPolicy.replyIntervalMilliseconds(attempt: 24, hasTaskID: false), 2_500)
        XCTAssertEqual(PollingPolicy.replyIntervalMilliseconds(attempt: 4, hasTaskID: true), 3_000)
        XCTAssertEqual(PollingPolicy.replyIntervalMilliseconds(attempt: 20, hasTaskID: true), 5_000)
        XCTAssertEqual(PollingPolicy.idleIntervalSeconds(unchangedPolls: 0), 12)
        XCTAssertEqual(PollingPolicy.idleIntervalSeconds(unchangedPolls: 6), 48)
        XCTAssertEqual(PollingPolicy.idleIntervalSeconds(unchangedPolls: 10), 90)
    }

    func testChatUpdatesDecodesSupersededRetractions() throws {
        let withRetractions = """
        {"taskStatus":null,"messages":[],"refreshed":[],
         "superseded":["old-notice-id"],"nextCursor":null,"hasMore":false,"activity":[]}
        """.data(using: .utf8)!
        let updates = try JSONDecoder().decode(ChatUpdates.self, from: withRetractions)
        XCTAssertEqual(updates.superseded, ["old-notice-id"])

        // A server build from before retractions must still decode.
        let withoutRetractions = """
        {"taskStatus":null,"messages":[],"refreshed":[],
         "nextCursor":null,"hasMore":false,"activity":[]}
        """.data(using: .utf8)!
        let legacy = try JSONDecoder().decode(ChatUpdates.self, from: withoutRetractions)
        XCTAssertNil(legacy.superseded)
    }

    func testDecodesCompanionCuesAndQuickReplies() throws {
        let data = #"{"id":"1","role":"assistant","parts":[{"type":"text","text":"Ready."},{"type":"data-face","data":{"state":"warm_smile"}},{"type":"data-theme","data":{"name":"cool_sky"}},{"type":"data-chips","data":{"labels":["Show me","Continue"]}}]}"#.data(using: .utf8)!
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(message.text, "Ready.")
        XCTAssertEqual(message.face, .warmSmile)
        XCTAssertEqual(message.mood, .coolSky)
        XCTAssertEqual(message.quickReplies, ["Show me", "Continue"])
    }

    func testKnowledgeOverviewDoesNotPromoteAnAutomaticSelection() {
        let address = KnowledgeEntity(
            id: "address", label: "1 Daniel Burnham Court", kind: "place",
            canonicalKey: "place:address")
        let overview = KnowledgeOverview(
            totalEntities: 1, totalRelations: 0, unreviewedRelations: 0,
            entities: [address], matchingEntities: 1, entityPage: 1, entityPages: 1,
            selected: address, relations: [], selectedActiveRelationTotal: 0, duplicates: [])

        XCTAssertNil(overview.entitySelected(by: nil), "Opening or returning to browse must not feature the API default")
        XCTAssertEqual(overview.entitySelected(by: address.id), address)
        XCTAssertNil(overview.entitySelected(by: "another-item"), "A stale response must not show a different item")
    }

    func testRelationshipEditorPreviewPreservesDirection() {
        for (predicate, role) in [("son_of", "son"), ("daughter_of", "daughter"), ("parent_of", "parent")] {
            XCTAssertEqual(
                KnowledgeConnectionEditor.previewSentence(subject: "Alex", predicate: predicate, objectLabel: "Robin"),
                "Alex is Robin’s \(role).")
        }
    }

    func testDecodesKnowledgeRelationshipPresentation() throws {
        let data = """
        {
          "totalEntities":2,"totalRelations":1,"unreviewedRelations":1,
          "entities":[{"id":"baldvin","label":"Baldvin","kind":"person","canonicalKey":"person:baldvin"}],
          "matchingEntities":2,"entityPage":1,"entityPages":1,
          "selected":{"id":"baldvin","label":"Baldvin","kind":"person","canonicalKey":"person:baldvin"},
          "relations":[{
            "id":"edge-1",
            "subject":{"id":"baldvin","label":"Baldvin","kind":"person","canonicalKey":"person:baldvin"},
            "predicate":"daughter_of",
            "object":{"id":"freyja","label":"Freyja_Ruth","kind":"person","canonicalKey":"person:freyja"},
            "confidence":0.92,"reviewStatus":"unreviewed","validFrom":null,"validUntil":null,"inRecall":true,
            "source":{"memoryId":"memory-1","content":"Freyja is Baldvin's daughter.","createdAt":"2026-08-27T00:00:00.000Z","ownerConfirmed":true,"originTrust":"owner"},
            "presentation":{"sentence":"Freyja Ruth is Baldvin's daughter.","label":"Daughter","accessibleLabel":"Freyja Ruth is Baldvin's daughter."}
          }],
          "selectedActiveRelationTotal":1,"duplicates":[]
        }
        """.data(using: .utf8)!

        let overview = try JSONDecoder().decode(KnowledgeOverview.self, from: data)
        XCTAssertEqual(overview.selected?.displayLabel, "Baldvin")
        XCTAssertEqual(overview.relations.first?.object.displayLabel, "Freyja Ruth")
        XCTAssertEqual(overview.relations.first?.presentation.sentence, "Freyja Ruth is Baldvin's daughter.")
        let relation = try XCTUnwrap(overview.relations.first)
        XCTAssertEqual(relation.connectedEntity(to: "baldvin")?.id, "freyja")
        XCTAssertEqual(relation.connectedEntity(to: "freyja")?.id, "baldvin")
        XCTAssertNil(relation.connectedEntity(to: "unrelated"))
        XCTAssertEqual(relation.predicate, "daughter_of", "Exploring must not reverse the underlying fact")
        let duplicate = KnowledgeRelation(id: "edge-2", subject: relation.subject, predicate: relation.predicate,
            object: relation.object, confidence: 0.9, reviewStatus: "confirmed", validFrom: nil, validUntil: nil,
            inRecall: true, source: relation.source, presentation: relation.presentation)
        let groups = KnowledgeConnection.group([relation, duplicate])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.sources.count, 2)
        XCTAssertEqual(groups.first?.confirmed, true)
        XCTAssertEqual(KnowledgeConnection.group([relation]).first?.confirmed, false)
        XCTAssertEqual(KnowledgeConnection.group([duplicate, relation]).first?.id, groups.first?.id)
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

    private func persisted(
        _ id: String,
        _ role: ChatRole,
        _ text: String,
        at sentAt: String
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            role: role,
            parts: [.init(type: "text", text: text)],
            metadata: ["createdAt": .string(sentAt)]
        )
    }

    func testChatLogPutsDurableTwinsBackWhereTheyWereAsked() {
        var order = ChatLogOrder()
        // Three turns typed while the assistant worked. Their durable twins
        // arrive later, and a merge can only append them.
        let typed = [
            "Anything on my calendar for tomorrow?",
            "Check all calendars",
            "How will the weather be tomorrow?",
        ].map { ChatMessage.optimistic(role: .user, text: $0) }
        var log = order.ordered(
            [persisted("m0", .assistant, "Morning.", at: "2026-08-27T09:00:00.000Z")] + typed
        )
        XCTAssertEqual(log.map(\.id), ["m0"] + typed.map(\.id))

        // The replies land first — they are what the poll returns.
        log = order.ordered(log + [
            persisted("a1", .assistant, "Two things today.", at: "2026-08-27T09:00:20.000Z"),
            persisted("a2", .assistant, "All three calendars are clear.", at: "2026-08-27T09:00:40.000Z"),
        ])
        XCTAssertEqual(log.map(\.id), ["m0"] + typed.map(\.id) + ["a1", "a2"])

        // Then a refresh returns the durable user rows, appended at the end.
        let durable = [
            persisted("u1", .user, typed[0].text, at: "2026-08-27T09:00:10.000Z"),
            persisted("u2", .user, typed[1].text, at: "2026-08-27T09:00:30.000Z"),
            persisted("u3", .user, typed[2].text, at: "2026-08-27T09:00:50.000Z"),
        ]
        log = order.ordered(log.filter { !$0.id.hasPrefix("local-") } + durable)
        // Each question back above the reply that answered it.
        XCTAssertEqual(log.map(\.id), ["m0", "u1", "a1", "u2", "a2", "u3"])
    }

    func testChatLogKeepsAnUnsentTurnAboveTheReplyArrivingUnderIt() {
        var order = ChatLogOrder()
        let question = ChatMessage.optimistic(role: .user, text: "How will the weather be?")
        var log = order.ordered([
            persisted("m0", .user, "Morning.", at: "2026-08-27T09:00:00.000Z"),
            question,
        ])
        XCTAssertEqual(log.map(\.id), ["m0", question.id])

        // A question whose durable twin has not come back yet still sits above
        // the reply answering it: the reply's send time is later than the log
        // the question anchored to, and no device clock is consulted.
        log = order.ordered(log + [
            persisted("a1", .assistant, "Sunny.", at: "2026-08-27T09:00:05.000Z"),
        ])
        XCTAssertEqual(log.map(\.id), ["m0", question.id, "a1"])

        // The live bubble is written last and stays last.
        let streaming = ChatMessage.optimistic(role: .assistant, text: "", id: "stream-1")
        XCTAssertEqual(
            order.ordered(log + [streaming]).map(\.id),
            ["m0", question.id, "a1", "stream-1"]
        )
    }

    func testChatLogOrdersMessagesSharingASendTimeByIdLikeTheServer() {
        var order = ChatLogOrder()
        let log = order.ordered([
            persisted("b", .assistant, "Second", at: "2026-08-27T09:00:00.000Z"),
            persisted("a", .user, "First", at: "2026-08-27T09:00:00.000Z"),
        ])
        XCTAssertEqual(log.map(\.id), ["a", "b"])
    }

    func testDecisionMessageUsesOnlyItsStructuredCardAndTracksResolution() throws {
        let pendingData = """
        {"id":"approval-message","role":"assistant","parts":[
          {"type":"text","text":"This needs your approval before I act: A7"},
          {"type":"approval","approvalId":"approval-1","shortCode":"A7","summary":"Search the web","status":"pending"}
        ]}
        """.data(using: .utf8)!
        let pending = try JSONDecoder().decode(ChatMessage.self, from: pendingData)
        XCTAssertEqual(pending.decisionParts.count, 1)
        XCTAssertTrue(pending.visibleTextBubbles.isEmpty)
        XCTAssertTrue(pending.hasPendingDecision)

        let approvedData = """
        {"id":"approval-message","role":"assistant","parts":[
          {"type":"text","text":"This needs your approval before I act: A7"},
          {"type":"approval","approvalId":"approval-1","shortCode":"A7","summary":"Search the web","status":"approved"}
        ]}
        """.data(using: .utf8)!
        let approved = try JSONDecoder().decode(ChatMessage.self, from: approvedData)
        XCTAssertFalse(approved.hasPendingDecision)
    }

    func testApprovalSummaryUsesItsStructuredCardAndKeepsFallbackTextHidden() throws {
        let data = """
        {"id":"approval-summary-message","role":"assistant","parts":[
          {"type":"text","text":"Approval needed to continue: Find an open cafe nearby"},
          {"type":"approval-summary","purpose":"Find an open cafe nearby","approvalCount":4}
        ]}
        """.data(using: .utf8)!
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)

        XCTAssertEqual(message.approvalSummary?.purpose, "Find an open cafe nearby")
        XCTAssertEqual(message.approvalSummary?.approvalCount, 4)
        XCTAssertTrue(message.visibleTextBubbles.isEmpty)
    }

    func testTranscriptGroupsOnlyConsecutiveApprovedApprovalReceipts() {
        func receipt(_ id: String, status: String = "approved") -> ChatMessage {
            ChatMessage(
                id: id,
                role: .assistant,
                parts: [
                    .init(type: "text", text: "This needs your approval before I act."),
                    .init(type: "approval", approvalId: "approval-\(id)", summary: "Request \(id)", status: status),
                ]
            )
        }

        let user = ChatMessage.optimistic(role: .user, text: "Do the work", id: "user")
        let items = [user, receipt("one"), receipt("two"), receipt("pending", status: "pending"), receipt("three"), receipt("four")]
            .transcriptItems()

        XCTAssertEqual(items.count, 4)
        guard case let .approvedReceiptGroup(firstGroup, firstIndex) = items[1] else {
            return XCTFail("Expected the adjacent approved receipts to be grouped")
        }
        XCTAssertEqual(firstGroup.map(\.id), ["one", "two"])
        XCTAssertEqual(firstIndex, 1)
        guard case let .approvedReceiptGroup(secondGroup, firstIndex) = items[3] else {
            return XCTFail("Expected the later adjacent approved receipts to be grouped")
        }
        XCTAssertEqual(secondGroup.map(\.id), ["three", "four"])
        XCTAssertEqual(firstIndex, 4)
    }

    func testStructuredTaskNoticeDecodesForCardPresentation() throws {
        let data = """
        {"id":"notice-1","role":"assistant","parts":[
          {"type":"text","text":"The task stopped."},
          {"type":"notice","notice":"needs-attention"}
        ]}
        """.data(using: .utf8)!
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(message.noticeKind, .needsAttention)
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

    func testGeneratedCardDecodesVersionedFactsAndSensitiveCodes() {
        let card = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("generated-card"),
                "id": .string("ticket-1"),
                "spec": .object([
                    "version": .number(1),
                    "title": .string("Movie ticket"),
                    "sourceLabel": .string("Cinema email"),
                    "accessibilityLabel": .string("Movie ticket for Dune"),
                    "facts": .array([
                        .object(["id": .string("movie"), "label": .string("Movie"), "value": .string("Dune: Part Two")]),
                        .object(["id": .string("code"), "label": .string("Ticket code"), "value": .string("MV-4829-AX"), "sensitive": .bool(true)]),
                    ]),
                    "blocks": .array([
                        .object(["type": .string("hero"), "titleFact": .string("movie")]),
                        .object(["type": .string("code"), "valueFact": .string("code")]),
                    ]),
                ]),
            ])
        )
        guard case let .generated(generated)? = MessageResponseCard(part: card) else {
            return XCTFail("Expected a generated card")
        }
        XCTAssertEqual(generated.title, "Movie ticket")
        XCTAssertEqual(generated.facts.first?.value, "Dune: Part Two")
        XCTAssertTrue(generated.facts.last?.sensitive == true)
        XCTAssertTrue(generated.steps.isEmpty)
    }

    func testGeneratedCardCarriesTheStepsBehindIt() {
        let card = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("generated-card"),
                "id": .string("hotel-1"),
                "steps": .array([
                    .object([
                        "tool": .string("gmail.search"),
                        "count": .string("1 result"),
                        "detail": .string("from:Katie hotels.com 73535835545212"),
                    ]),
                    .object([
                        "tool": .string("calendar.search_events"),
                        "failed": .bool(true),
                        "error": .string("Calendar timed out"),
                    ]),
                    // A malformed step is dropped, never rendered as a blank row.
                    .object(["count": .string("1 result")]),
                ]),
                "spec": .object([
                    "version": .number(1),
                    "title": .string("Hotel Kabuki"),
                    "sourceLabel": .string("Hotel"),
                    "accessibilityLabel": .string("Hotel Kabuki reservation"),
                    "facts": .array([
                        .object(["id": .string("room"), "label": .string("Room"), "value": .string("King, garden view")]),
                    ]),
                    "blocks": .array([.object(["type": .string("hero"), "titleFact": .string("room")])]),
                ]),
            ])
        )
        guard case let .generated(generated)? = MessageResponseCard(part: card) else {
            return XCTFail("Expected a generated card")
        }
        XCTAssertEqual(generated.steps.count, 2)
        XCTAssertEqual(generated.steps.first?.count, "1 result")
        XCTAssertEqual(generated.steps.first?.detail, "from:Katie hotels.com 73535835545212")
        XCTAssertFalse(generated.steps.first?.failed ?? true)
        XCTAssertTrue(generated.steps.last?.failed ?? false)
        XCTAssertEqual(generated.steps.last?.error, "Calendar timed out")
    }

    func testStepLabelsReadAsCompletedWorkNeverAsToolNames() {
        XCTAssertEqual(ToolStepLabel.past(for: "gmail.search"), "Searched email")
        XCTAssertEqual(ToolStepLabel.past(for: "web.fetch"), "Read a web page")
        // A tool with no phrase of its own is named for what it touched.
        XCTAssertEqual(ToolStepLabel.past(for: "memory.graph_snapshot"), "Checked memory")
        XCTAssertEqual(ToolStepLabel.past(for: "custom_source.do_thing"), "Checked custom source")
    }

    func testNoticePresentationDecodesAdditively() throws {
        let data = #"{"id":"notice-1","role":"assistant","parts":[{"type":"text","text":"full diagnostic text"},{"type":"notice","notice":"needs-attention","presentation":{"version":1,"headline":"Choose locations","summary":"Remote only or specific cities?","facts":[{"label":"Goal","value":"Job search"}],"detailLabel":"Technical details","diagnostics":["web.fetch approval expired"]}}]}"#.data(using: .utf8)!
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertEqual(message.noticePresentation?.headline, "Choose locations")
        XCTAssertEqual(message.noticePresentation?.summary, "Remote only or specific cities?")
        XCTAssertEqual(message.noticePresentation?.facts?.first?.value, "Job search")
        XCTAssertEqual(message.noticePresentation?.diagnostics, ["web.fetch approval expired"])
        XCTAssertEqual(message.text, "full diagnostic text")
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

    func testProactiveAlertCardDecodesGroundedDetails() {
        let part = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("proactive-alert"),
                "id": .string("event-lead-1"),
                "category": .string("event"),
                "urgencyLabel": .string("Starts in 30 min"),
                "title": .string("Annual Physical"),
                "startsAt": .string("2026-09-02T16:00:00.000Z"),
                "details": .array([
                    .object(["label": .string("Location"), "value": .string("One Medical")]),
                ]),
            ])
        )
        guard case let .proactiveAlert(id, category, urgency, title, summary, startsAt, dueAt, details)? = MessageResponseCard(part: part) else {
            return XCTFail("Expected a proactive alert card")
        }
        XCTAssertEqual(id, "event-lead-1")
        XCTAssertEqual(category, "event")
        XCTAssertEqual(urgency, "Starts in 30 min")
        XCTAssertEqual(title, "Annual Physical")
        XCTAssertEqual(summary, "")
        XCTAssertEqual(startsAt, "2026-09-02T16:00:00.000Z")
        XCTAssertEqual(dueAt, "")
        XCTAssertEqual(details.first?.value, "One Medical")
    }

    func testLegacyTextCardsReformatSuppliedCalendarExamplesConservatively() {
        let agendaText = "Tomorrow has five upcoming events: 1) U13B Azul soccer practice from 6:30-8:00 PM at Crocker Amazon fields (outside usual hours). 2) Coffee with Tine at 9:00 AM at Home Coffee Roasters on Clement. 3) Technical interviews with Clay from 1:00-2:00 PM. 4) Kung Fu class at 4:45 PM at Tat Wong Academy on Geary. 5) Freyja's swim lesson at 5:15 PM at La Petite Baleen on Mason."
        guard case let .agenda(title, subtitle, items)? = MessageResponseCard.inferredLegacy(from: agendaText).first else {
            return XCTFail("Expected the numbered calendar paragraph to become an agenda")
        }
        XCTAssertEqual(title, "Tomorrow")
        XCTAssertEqual(subtitle, "5 upcoming events")
        XCTAssertEqual(items.count, 5)
        XCTAssertEqual(items[0].time, "6:30-8:00 PM")
        XCTAssertEqual(items[0].detail, "Crocker Amazon fields (outside usual hours)")
        XCTAssertEqual(items[2].title, "Technical interviews with Clay")

        let alertText = "\"Annual Physical\" starts in 30 minutes at One Medical, 559 Clay St. it is at One Medical, 559 Clay St; family@example.com called it."
        guard case let .proactiveAlert(_, category, urgency, title, summary, _, _, details)? = MessageResponseCard.inferredLegacy(from: alertText).first else {
            return XCTFail("Expected the historical event notice to become an alert")
        }
        XCTAssertEqual(category, "event")
        XCTAssertEqual(urgency, "Starts in 30 min")
        XCTAssertEqual(title, "Annual Physical")
        XCTAssertEqual(summary, "")
        XCTAssertEqual(details.first?.value, "One Medical, 559 Clay St")

        XCTAssertTrue(
            MessageResponseCard.inferredLegacy(
                from: "Try these: 1) Bring water. 2) Leave a little early."
            ).isEmpty
        )
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
        guard case let .status(_, statusTitle, detail, symbol, statusDetails, statusLinkLabel, statusLinkURL)? = MessageResponseCard(part: status) else {
            return XCTFail("Expected a status card")
        }
        XCTAssertEqual(statusTitle, "Email draft ready")
        XCTAssertEqual(detail, "**Launch** recap")
        XCTAssertEqual(symbol, "envelope.badge.fill")
        XCTAssertEqual(statusDetails.first?.value, "ada@example.com")
        XCTAssertNil(statusLinkLabel)
        XCTAssertNil(statusLinkURL)
    }

    func testWorkspaceSettingsDecodesManagedReminders() throws {
        let data = Data(
            #"{"agent":{"name":"Assistant","timezone":"America/Los_Angeles","locale":"en-US","signature":""},"schedules":[],"reminders":[{"id":"reminder-1","text":"Get sunglasses from the car","kind":"once","status":"scheduled","nextRunAt":"2026-09-02T20:00:00.000Z"},{"id":"reminder-2","text":"Take vitamins","kind":"recurring","status":"delivering","nextRunAt":null}],"policies":[],"goalAutomationCount":0}"#.utf8
        )

        let settings = try JSONDecoder().decode(WorkspaceSettings.self, from: data)
        XCTAssertEqual(settings.reminders.map(\.text), ["Get sunglasses from the car", "Take vitamins"])
        XCTAssertFalse(settings.reminders[0].repeats)
        XCTAssertTrue(settings.reminders[1].repeats)
        XCTAssertTrue(settings.reminders[1].isDelivering)

        let legacy = Data(
            #"{"agent":{"name":"Assistant","timezone":"UTC","locale":"en-US","signature":""},"schedules":[],"policies":[],"goalAutomationCount":0}"#.utf8
        )
        XCTAssertEqual(
            try JSONDecoder().decode(WorkspaceSettings.self, from: legacy).reminders.count,
            0
        )
    }

    func testResponseCardsDecodeWebSearchResultsAndAvailability() {
        let search = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("web-search-results"), "id": .string("search-1"),
                "query": .string("best time to visit Lisbon"),
                "results": .array([
                    .object([
                        "id": .string("result-1"), "title": .string("Lisbon travel guide"),
                        "url": .string("https://example.com/lisbon"),
                        "snippet": .string("Late spring is ideal."),
                    ]),
                    .object([
                        "id": .string("result-2"), "title": .string("Dropped without a URL"),
                        "url": .string(""), "snippet": .string("No link."),
                    ]),
                ]),
            ])
        )
        guard case let .search(_, _, query, results)? = MessageResponseCard(part: search) else {
            return XCTFail("Expected a web search results card")
        }
        XCTAssertEqual(query, "best time to visit Lisbon")
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.title, "Lisbon travel guide")
        XCTAssertEqual(results.first?.url, "https://example.com/lisbon")
        XCTAssertEqual(results.first?.snippet, "Late spring is ideal.")

        let availability = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("availability"), "id": .string("availability-1"),
                "timeMin": .string("2026-08-24T09:00:00-07:00"),
                "timeMax": .string("2026-08-24T17:00:00-07:00"),
                "busy": .array([
                    .object([
                        "start": .string("2026-08-24T10:00:00-07:00"),
                        "end": .string("2026-08-24T11:30:00-07:00"),
                        "calendar": .string("Work"),
                    ]),
                    .object(["start": .string(""), "end": .string(""), "calendar": .string("Dropped")]),
                ]),
                "calendarsChecked": .array([.string("Work"), .string("Family")]),
                "complete": .bool(false),
                "note": .string("Some calendars did not return free/busy data."),
            ])
        )
        guard case let .availability(_, timeMin, timeMax, busy, calendarsChecked, complete, note)? =
                MessageResponseCard(part: availability) else {
            return XCTFail("Expected an availability card")
        }
        XCTAssertEqual(timeMin, "2026-08-24T09:00:00-07:00")
        XCTAssertEqual(timeMax, "2026-08-24T17:00:00-07:00")
        XCTAssertEqual(busy.count, 1)
        XCTAssertEqual(busy.first?.calendar, "Work")
        XCTAssertEqual(calendarsChecked, ["Work", "Family"])
        XCTAssertFalse(complete)
        XCTAssertEqual(note, "Some calendars did not return free/busy data.")
    }

    func testResponseCardsDecodeEmailThreadAndSheetRows() {
        let thread = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("email-thread"), "id": .string("thread-1"),
                "subject": .string("Launch recap"), "messageCount": .number(4),
                "messages": .array([
                    .object([
                        "id": .string("m1"), "sender": .string("Ada <ada@example.com>"),
                        "date": .string("Mon, 24 Aug 2026 09:00:00 -0700"),
                        "excerpt": .string("The plan is ready."),
                    ]),
                ]),
            ])
        )
        guard case let .thread(_, subject, messageCount, messages)? = MessageResponseCard(part: thread) else {
            return XCTFail("Expected an email thread card")
        }
        XCTAssertEqual(subject, "Launch recap")
        XCTAssertEqual(messageCount, 4)
        XCTAssertEqual(messages.first?.sender, "Ada <ada@example.com>")
        XCTAssertEqual(messages.first?.excerpt, "The plan is ready.")

        let sheet = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("sheet-rows"), "id": .string("sheet-1"),
                "sheetName": .string("Budget"), "totalRows": .number(42),
                "rows": .array([
                    .array([.string("Item"), .string("Cost")]),
                    .array([.string("Flights"), .number(640)]),
                ]),
                "link": .object(["label": .string("Open spreadsheet"), "url": .string("https://sheets.example.com/budget")]),
            ])
        )
        guard case let .sheetRows(_, sheetName, rows, totalRows, linkURL)? = MessageResponseCard(part: sheet) else {
            return XCTFail("Expected a sheet rows card")
        }
        XCTAssertEqual(sheetName, "Budget")
        XCTAssertEqual(totalRows, 42)
        XCTAssertEqual(rows, [["Item", "Cost"], ["Flights", "640"]])
        XCTAssertEqual(linkURL, "https://sheets.example.com/budget")
    }

    func testStatusCardCarriesItsOpenLinkWhenPresent() {
        let updated = MessagePart(
            type: "data-card",
            data: .object([
                "kind": .string("status"), "id": .string("sheet-written-1"),
                "title": .string("Sheet updated"),
                "detail": .string("3 rows added to Budget."),
                "symbol": .string("tablecells.fill"),
                "link": .object(["label": .string("Open spreadsheet"), "url": .string("https://sheets.example.com/budget")]),
            ])
        )
        guard case let .status(_, _, _, _, _, linkLabel, linkURL)? = MessageResponseCard(part: updated) else {
            return XCTFail("Expected a status card")
        }
        XCTAssertEqual(linkLabel, "Open spreadsheet")
        XCTAssertEqual(linkURL, "https://sheets.example.com/budget")
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

    func testInterviewPrepCardReformatsStructuredInterviewerResearch() {
        let cards = MessageResponseCard.inferred(
            from: """
            ## James Friend
            - **Role:** Software Engineer at Clay ([LinkedIn](https://linkedin.com/in/jamesfriendau))
            - **Background:**
              - Previously at Canva (2022–2024), worked on frontend infrastructure.
              - Focus: React, TypeScript, performance optimization.
            - **Likely interview focus:** System design trade-offs and scaling UI components.

            ## Brandon Goren
            - **Role:** Software Engineer at Clay ([LinkedIn](https://linkedin.com/in/brandon-goren-3830b483))
            - **Background:**
              - Ex-Microsoft (Azure DevOps), ex-Washington University researcher.
              - Specializes in React state management and API design.
            - **Likely interview focus:** React patterns and data-flow architecture.

            ## Clay's Tech Stack
            - Next.js, TypeScript, Tailwind, GraphQL.

            Want me to:
            - Draft tailored prep questions for each interviewer?
            """,
            cardKind: "interview-prep"
        )

        guard case let .interviewPrep(_, people, techStack, nextSteps)? = cards.first else {
            return XCTFail("Expected structured interviewer research to become an interview-prep card")
        }
        XCTAssertEqual(people.map(\.name), ["James Friend", "Brandon Goren"])
        XCTAssertEqual(people[0].background.count, 2)
        XCTAssertEqual(people[1].interviewFocus, "React patterns and data-flow architecture.")
        XCTAssertEqual(techStack, ["Next.js, TypeScript, Tailwind, GraphQL."])
        XCTAssertEqual(nextSteps, ["Draft tailored prep questions for each interviewer?"])
    }

    func testDirectionsPromptDoesNotEnableIncidentalWeatherCardFallback() {
        let directions = "Directions to Palo Alto field"
        let response = """
        Here are directions to Mayfield Soccer Complex.
        **Parking:** Free lot on-site.
        (Weather reminder: Sunny, 22°C (72°F) at match time.)
        """

        XCTAssertFalse(MessageResponseCard.requestLooksLikeWeather(directions))
        XCTAssertTrue(MessageResponseCard.inferred(from: response, cardKind: "weather").isEmpty == false)
        XCTAssertFalse(OnDeviceCardParser.requestAllows(kind: "weather", request: directions))
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

    func testWeatherUnitsCollapsePairsAndConvertToThePreferredUnit() {
        XCTAssertEqual(WeatherUnits.localized("17°C (63°F)", preferFahrenheit: true), "63°F")
        XCTAssertEqual(WeatherUnits.localized("17°C (63°F)", preferFahrenheit: false), "17°C")
        XCTAssertEqual(WeatherUnits.localized("63°F (17°C)", preferFahrenheit: false), "17°C")
        XCTAssertEqual(WeatherUnits.localized("17–20°C (63–68°F)", preferFahrenheit: true), "63–68°F")
        XCTAssertEqual(WeatherUnits.localized("18°C", preferFahrenheit: true), "64°F")
        XCTAssertEqual(WeatherUnits.localized("98°F", preferFahrenheit: false), "37°C")
        XCTAssertEqual(WeatherUnits.localized("17–19°C", preferFahrenheit: true), "63–66°F")
        XCTAssertEqual(WeatherUnits.localized("17ºC", preferFahrenheit: false), "17°C")
        XCTAssertEqual(
            WeatherUnits.localized("overcast, wind 18 km/h", preferFahrenheit: true),
            "overcast, wind 18 km/h"
        )
    }

    func testWeatherInferenceDealsEachForecastDayItsOwnCard() {
        let cards = MessageResponseCard.inferred(
            from: """
            Here's the weather for Palo Alto this weekend:
            - **Saturday:** Sunny, 16–23°C
            - **Sunday:** Partly cloudy, 14–21°C, 20% chance of rain
            """
        )
        XCTAssertEqual(cards.count, 2)
        guard case let .weather(location, satTemperature, satCondition, satDetails) = cards[0],
              case let .weather(_, sunTemperature, sunCondition, sunDetails) = cards[1] else {
            return XCTFail("Expected one weather card per forecast day")
        }
        // Each card stamps its own day, so the headline keeps the place alone.
        XCTAssertEqual(location, "Palo Alto")
        XCTAssertEqual(satTemperature, "16–23°C")
        XCTAssertEqual(satCondition, "Sunny")
        XCTAssertEqual(satDetails.first?.label, "Day")
        XCTAssertEqual(satDetails.first?.value, "Saturday")
        XCTAssertEqual(sunTemperature, "14–21°C")
        XCTAssertEqual(sunCondition, "Partly Cloudy")
        XCTAssertEqual(sunDetails.first?.value, "Sunday")
        XCTAssertNotEqual(cards[0].id, cards[1].id)
    }

    func testWeatherInferenceSplitsDayHeadingsIntoOneCardPerDay() {
        let cards = MessageResponseCard.inferred(
            from: """
            Here's the **weekend weather forecast for Palo Alto** (where your Saturday match is scheduled):

            **Saturday (August 29)**
            - 🌤 **12:00 PM (match time):**
              - **22°C (72°F)**, partly cloudy
              - **Wind:** 10 km/h (6 mph) — gentle breeze
              - **Rain chance: 0%**

            **Sunday (August 30)**
            - ☀️ **11:50 AM (match time):**
              - **23°C (73°F)**, sunny
              - **Wind:** 12 km/h (7 mph)
              - **Rain chance: 0%**

            **Perfect soccer conditions!** No rain, mild temps, and light wind.

            *(Source: OpenWeatherMap, Palo Alto microclimate, refreshed at 5:47 PM PDT.)*
            """
        )
        XCTAssertEqual(cards.count, 2)
        guard case let .weather(location, satTemperature, satCondition, satDetails) = cards[0],
              case let .weather(_, sunTemperature, sunCondition, sunDetails) = cards[1] else {
            return XCTFail("Expected one weather card per forecast day")
        }
        // The place, not "Right now": the answer is about somewhere else.
        XCTAssertEqual(location, "Palo Alto")
        XCTAssertEqual(satDetails.first?.value, "Saturday")
        XCTAssertEqual(sunDetails.first?.value, "Sunday")
        XCTAssertEqual(satTemperature, "22°C (72°F)")
        XCTAssertEqual(sunTemperature, "23°C (73°F)")
        // A dry weekend reads its sky from the forecast, never from the label
        // of the "Rain chance: 0%" metric sitting underneath it.
        XCTAssertEqual(satCondition, "Partly Cloudy")
        XCTAssertEqual(sunCondition, "Sunny")
        XCTAssertEqual(satDetails.map(\.label), ["Day", "Wind", "Rain chance"])
        XCTAssertEqual(satDetails[1].value, "10 km/h (6 mph) — gentle breeze")
        XCTAssertEqual(sunDetails[1].value, "12 km/h (7 mph)")
        XCTAssertNotEqual(cards[0].id, cards[1].id)
        XCTAssertEqual(WeatherPresentation.caption(details: satDetails, hasForecast: false), "Saturday")
    }

    func testWeatherInferenceIgnoresDayMentionsThatCarryNoReading() {
        let cards = MessageResponseCard.inferred(
            from: """
            It is 18°C and sunny right now.

            **Monday**
            Nothing booked yet.
            """
        )
        XCTAssertEqual(cards.count, 1)
        guard case let .weather(location, temperature, condition, details) = cards[0] else {
            return XCTFail("Expected a single current-conditions card")
        }
        XCTAssertEqual(location, "Right now")
        XCTAssertEqual(temperature, "18°C")
        XCTAssertEqual(condition, "Sunny")
        XCTAssertTrue(details.isEmpty)
    }

    func testWeatherConditionIgnoresRainChanceAndReassurances() {
        let cards = MessageResponseCard.inferred(
            from: """
            Weather in Palo Alto:
            - 24°C (75°F), clear skies
            - **Rain chance:** 0% — no rain expected all day
            """
        )
        guard case let .weather(location, _, condition, _)? = cards.first else {
            return XCTFail("Expected a weather card")
        }
        XCTAssertEqual(location, "Palo Alto")
        XCTAssertEqual(condition, "Clear Skies")
    }

    func testWeatherCardReadsOneDayFromItsDaytimePart() {
        // The reported reply: one day written as its arc, with an aside, a
        // provenance line and a row of pseudo-buttons the model made up.
        let cards = MessageResponseCard.inferred(
            from: """
            Checking current weather sources...

            **San Francisco weather for Thu Aug 27, 2026:**

            🌤 **Morning:** Partly cloudy, 16°C (61°F)

            ☀️ **Afternoon:** Sunny, 21°C (70°F)

            🌬️ **Wind:** Light breeze (8 km/h W)

            🌧️ **Rain chance:** 10%

            **For your 11:00 Zoom meeting:** Ideal indoor conditions with mild temps outside.

            (Source: National Weather Service SF Bay Area)

            [⏰ Set weather alert] | [🌧️ Check rain timing]
            """
        )
        XCTAssertEqual(cards.count, 1)
        guard case let .weather(location, temperature, condition, details) = cards[0] else {
            return XCTFail("Expected a weather card")
        }
        // The place, not the date that followed "weather for".
        XCTAssertEqual(location, "San Francisco")
        // The day is what was asked about, so the afternoon carries the
        // headline — not the morning reading that happens to come first, and
        // not "Rain" swept out of the "Check rain timing" line below.
        XCTAssertEqual(temperature, "21°C (70°F)")
        XCTAssertEqual(condition, "Sunny")
        // Every part of the day stays on the card as its own row; the meeting
        // aside stays in the reply, where it reads as the sentence it is.
        XCTAssertEqual(details.map(\.label), ["Morning", "Afternoon", "Wind", "Rain chance"])
        XCTAssertEqual(details[0].value, "Partly cloudy, 16°C (61°F)")
        XCTAssertEqual(details[1].value, "Sunny, 21°C (70°F)")
        XCTAssertEqual(details[2].value, "Light breeze (8 km/h W)")
    }

    func testWeatherCardKeepsSentencesOutOfTheMetricList() {
        let cards = MessageResponseCard.inferred(
            from: """
            Weather in Palo Alto:
            - **Conditions:** Sunny, 22°C (72°F)
            - **Wind:** 10 km/h
            - **For your 11:00 Zoom meeting:** Ideal indoor conditions.
            - **Note for the drive home:** Nothing to worry about.
            """
        )
        guard case let .weather(_, _, _, details) = cards[0] else {
            return XCTFail("Expected a weather card")
        }
        XCTAssertEqual(details.map(\.label), ["Wind"])
    }

    func testWeatherCaptionNamesTheDayOnPerDayForecastCards() {
        let dayCard = [
            MessageResponseCard.WeatherDetail(label: "Day", value: "Saturday"),
            MessageResponseCard.WeatherDetail(label: "Forecast", value: "Sunny, 16–23°C"),
        ]
        XCTAssertEqual(WeatherPresentation.caption(details: dayCard, hasForecast: false), "Saturday")
        XCTAssertEqual(WeatherPresentation.caption(details: [], hasForecast: false), "Today")
        XCTAssertEqual(WeatherPresentation.caption(details: [], hasForecast: true), "Forecast")
        let updated = [MessageResponseCard.WeatherDetail(label: "Updated", value: "3:48 PM PDT")]
        XCTAssertEqual(WeatherPresentation.caption(details: updated, hasForecast: false), "Today · 3:48 PM PDT")
    }

    func testWeatherFactsSplitIntoCurrentAndPerDayForecast() {
        let details = [
            MessageResponseCard.WeatherDetail(label: "Today", value: "17–20°C"),
            MessageResponseCard.WeatherDetail(label: "Wind", value: "10 km/h"),
            MessageResponseCard.WeatherDetail(label: "Saturday morning", value: "Sunny, 17°C"),
            MessageResponseCard.WeatherDetail(label: "Saturday afternoon", value: "Clear, 22°C"),
            MessageResponseCard.WeatherDetail(label: "Sun", value: "Rain, 16°C"),
        ]
        let (current, days) = WeatherPresentation.split(details)
        XCTAssertEqual(current.map(\.label), ["Today", "Wind"])
        XCTAssertEqual(days.map(\.day), ["Saturday", "Sun"])
        XCTAssertEqual(days[0].facts.map(\.label), ["Morning", "Afternoon"])
        XCTAssertEqual(days[1].facts.map(\.label), ["Forecast"])
        XCTAssertEqual(days[1].facts.map(\.value), ["Rain, 16°C"])
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

    func testResolvedApprovalsDecodeWithoutPayloads() throws {
        // The resolved history deliberately drops payload/resolutionPayload —
        // they stay in the database. Decoding the row as the pending list's
        // full record failed the whole overview the moment a single approval
        // resolved, taking Activity, Goals, and Documents down with it.
        let trimmed = """
        {"pending":[],"resolved":[
          {"approval":{"id":"a1","taskId":"t1","shortCode":"A7","summary":"Search the web",
                       "status":"approved","requestedAt":"2026-08-27T09:00:00.000Z",
                       "resolvedAt":"2026-08-27T09:05:00.000Z","resolvedVia":"web",
                       "expiresAt":"2026-08-28T09:00:00.000Z","edited":true},
           "taskType":"chat"}
        ]}
        """.data(using: .utf8)!
        let inbox = try JSONDecoder().decode(ApprovalInbox.self, from: trimmed)
        XCTAssertEqual(inbox.resolved.first?.approval.id, "a1")
        XCTAssertEqual(inbox.resolved.first?.approval.edited, true)

        // A server build from before the trim still sends the full row; it
        // must still decode.
        let legacy = """
        {"pending":[],"resolved":[
          {"approval":{"id":"a1","taskId":"t1","shortCode":"A7","summary":"Search the web",
                       "payload":{"query":"cafes"},"resolutionPayload":{"approved":true},
                       "status":"approved","requestedAt":"2026-08-27T09:00:00.000Z",
                       "resolvedAt":"2026-08-27T09:05:00.000Z","resolvedVia":"web",
                       "expiresAt":"2026-08-28T09:00:00.000Z"},
           "taskType":"chat"}
        ]}
        """.data(using: .utf8)!
        let legacyInbox = try JSONDecoder().decode(ApprovalInbox.self, from: legacy)
        XCTAssertEqual(legacyInbox.resolved.first?.approval.id, "a1")
        XCTAssertNil(legacyInbox.resolved.first?.approval.edited)
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

    func testTopOverlaysClearTheIslandWhetherOrNotTheCrownIsShowing() {
        // iPhone 15 Pro. Idle the crown draws nothing, but its collapsed frame
        // still stands for the hardware pill it is attached to — 10 to 47, a
        // point high by design — so an overlay starts below that. This used to
        // be a flat 4pt, which put the error banner behind the pill.
        XCTAssertEqual(
            ActivityCrown.overlayTopInset(
                isAccessibilitySize: false,
                isExpanded: false,
                safeAreaTopInset: 59
            ),
            55,
            accuracy: 0.001
        )
        // Expanded, the crown itself is what has to be cleared. Measured from
        // the physical top edge: the previous safe-area-relative number was 35,
        // which landed inside the crown rather than below it.
        XCTAssertEqual(
            ActivityCrown.overlayTopInset(
                isAccessibilitySize: false,
                isExpanded: true,
                safeAreaTopInset: 59
            ),
            94,
            accuracy: 0.001
        )
        XCTAssertEqual(
            ActivityCrown.overlayTopInset(
                isAccessibilitySize: true,
                isExpanded: true,
                safeAreaTopInset: 59
            ),
            206,
            accuracy: 0.001
        )
        // The flush notch has no floating pill, and its own collapsed geometry
        // still resolves to a seat below the cutout.
        XCTAssertEqual(
            ActivityCrown.overlayTopInset(
                isAccessibilitySize: false,
                isExpanded: false,
                safeAreaTopInset: 47
            ),
            59,
            accuracy: 0.001
        )
    }

    func testTopOverlayNeverStartsInsideTheIslandOnAnyReportedInset() {
        for step in 20...70 {
            let inset = CGFloat(step)
            let islandBottom = ActivityCrown.islandTopInset(safeAreaTopInset: inset)
                + ActivityCrown.collapsedHeight
            for isExpanded in [false, true] {
                for isAccessibilitySize in [false, true] {
                    XCTAssertGreaterThanOrEqual(
                        ActivityCrown.overlayTopInset(
                            isAccessibilitySize: isAccessibilitySize,
                            isExpanded: isExpanded,
                            safeAreaTopInset: inset
                        ),
                        islandBottom + ActivityCrown.overlayClearanceGap,
                        "overlay drew into the island at a \(inset)pt top inset"
                    )
                }
            }
        }
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

    func testPullMenuPresentationKeepsClearanceAndRevealsRowsBottomUp() {
        XCTAssertEqual(
            PullMenuMotion.composerSurfaceBottomSpacing,
            12,
            accuracy: 0.001
        )
        XCTAssertTrue(
            PullMenuMotion.shouldPinTranscriptToBottom(
                userIsDraggingTranscript: false,
                isSending: false
            )
        )
        XCTAssertFalse(
            PullMenuMotion.shouldPinTranscriptToBottom(
                userIsDraggingTranscript: true,
                isSending: false
            )
        )
        XCTAssertFalse(
            PullMenuMotion.shouldPinTranscriptToBottom(
                userIsDraggingTranscript: false,
                isSending: true
            )
        )
        XCTAssertEqual(
            PullMenuMotion.menuRevealHeight(
                contentHeight: 383,
                bottomSafeAreaInset: 34
            ),
            417,
            accuracy: 0.001
        )
        XCTAssertEqual(
            PullMenuMotion.conversationSurfaceOffset(revealDistance: 137),
            137,
            accuracy: 0.001
        )
        XCTAssertEqual(
            PullMenuMotion.sheetCornerRadius(isActive: false, fullRadius: 34),
            0
        )
        XCTAssertEqual(
            PullMenuMotion.sheetCornerRadius(isActive: true, fullRadius: 34),
            34
        )
        XCTAssertEqual(
            PullMenuMotion.sheetCornerRadius(isActive: true, fullRadius: -10),
            0
        )
        XCTAssertEqual(
            PullMenuMotion.sheetCornerRadius(isActive: true, progress: 0.09, fullRadius: 34),
            17,
            accuracy: 0.001
        )
        XCTAssertEqual(
            PullMenuMotion.sheetCornerRadius(isActive: true, progress: 0, fullRadius: 34),
            0,
            accuracy: 0.001
        )

        // Normal layouts pair the destinations into rows. The bottom row
        // appears first, and every destination in a row shares a fade rank.
        // Nine destinations leave the last row holding More on its own.
        XCTAssertEqual(
            (0..<9).map {
                PullMenuMotion.bottomUpFadeRank(
                    itemIndex: $0,
                    itemCount: 9,
                    columns: 2
                )
            },
            [4, 4, 3, 3, 2, 2, 1, 1, 0]
        )

        // The accessibility layout presents every destination in one
        // horizontal row, so it fades as one group.
        XCTAssertEqual(
            (0..<9).map {
                PullMenuMotion.bottomUpFadeRank(
                    itemIndex: $0,
                    itemCount: 9,
                    columns: 9
                )
            },
            Array(repeating: 0, count: 9)
        )

        // Horizontal compact-height layouts use three equal columns so the
        // complete directory fits without shrinking the labels.
        XCTAssertEqual(
            (0..<9).map {
                PullMenuMotion.bottomUpFadeRank(
                    itemIndex: $0,
                    itemCount: 9,
                    columns: 3
                )
            },
            [2, 2, 2, 1, 1, 1, 0, 0, 0]
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
                .cards,
                .memory,
                .people,
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

/// `CardText` turns raw mail headers into display strings. Every case here is a
/// shape Gmail actually sends, so the assertions are about real input, not
/// invented input.
final class CardTextTests: XCTestCase {
    func testDecisionWebRequestKeepsExactURLAndRejectsAmbiguousSummaries() {
        let address = "https://www.yelp.com/search?find_desc=Food&find_loc=San%20Francisco"
        XCTAssertEqual(CardText.decisionWebRequestURL("Fetch the public web page \(address)")?.absoluteString, address)
        for summary in ["Visit \(address)", "Fetch the public web page \(address) then send an email",
            "Fetch the public web page javascript:alert(1)", "Fetch the public web page https://user:secret@example.com",
            "Fetch the public web page ", "Send an email to Katie"] {
            XCTAssertNil(CardText.decisionWebRequestURL(summary), summary)
        }
    }

    func testSnippetFormattingRemovesHighlightMarkupAndDecodesEntities() {
        XCTAssertEqual(CardText.readableSnippet("A <strong>frontend</strong> engineer &amp; designer"),
            "A frontend engineer & designer")
        XCTAssertEqual(CardText.readableSnippet("&lt;strong&gt;Hello&lt;/strong&gt;<br/>Next&nbsp;line &#8212; &#x1F44B;"),
            "Hello Next line — 👋")
        XCTAssertEqual(CardText.readableSnippet("<p>First</p><p>Second</p><script>hidden()</script>"), "First Second")
    }

    func testSnippetCleanupPreservesMailboxesComparisonsAndUnknownEntities() {
        XCTAssertEqual(CardText.readableSnippet("From &lt;a@example.com&gt; and <p@example.com>"),
            "From <a@example.com> and <p@example.com>")
        XCTAssertEqual(CardText.readableSnippet("2 < 3 and 5 > 4; &unknown; &#99999999;"),
            "2 < 3 and 5 > 4; &unknown; &#99999999;")
        XCTAssertEqual(CardText.readableSnippet("[title](https://example.com) **literal text**"),
            "[title](https://example.com) **literal text**")
    }

    private let reference = Date(timeIntervalSince1970: 1_788_401_284) // 2026-09-02T19:08:04-07:00

    // MARK: Timestamps

    func testParsesGmailDateHeaders() {
        // Every spelling below is the same instant, so they all land on it.
        let expected = reference.timeIntervalSince1970
        for header in [
            "Wed, 2 Sep 2026 19:08:04 -0700",
            "Wed, 02 Sep 2026 19:08:04 -0700",
            "Wed, 2 Sep 2026 19:08:04 -0700 (PDT)",
            "2 Sep 2026 19:08:04 -0700",
            // RFC 5322's obsolete two-digit year: 26 is 2026, not the year 26.
            "Wed, 2 Sep 26 19:08:04 -0700",
        ] {
            let date = CardText.timestamp(header)
            XCTAssertNotNil(date, "failed to parse \(header)")
            XCTAssertEqual(date?.timeIntervalSince1970, expected, "wrong instant for \(header)")
        }
    }

    func testParsesGmailHeadersWithOptionalSecondsAndAlphabeticZones() {
        XCTAssertEqual(
            CardText.timestamp("Wed, 2 Sep 2026 19:08 -0700")?.timeIntervalSince1970,
            reference.timeIntervalSince1970 - 4
        )
        XCTAssertEqual(
            CardText.timestamp("Wed, 2 Sep 2026 19:08:04 GMT")?.timeIntervalSince1970,
            reference.timeIntervalSince1970 - 7 * 3600
        )
    }

    func testISO8601StillWins() {
        XCTAssertEqual(
            CardText.timestamp("2026-09-03T02:08:04Z")?.timeIntervalSince1970,
            reference.timeIntervalSince1970
        )
        XCTAssertEqual(
            CardText.timestamp("2026-09-03T02:08:04.250Z")?.timeIntervalSince1970,
            reference.timeIntervalSince1970 + 0.25
        )
    }

    func testRejectsWhatIsNotADate() {
        XCTAssertNil(CardText.timestamp("today"))
        XCTAssertNil(CardText.timestamp(""))
        XCTAssertNil(CardText.timestamp("   "))
        XCTAssertNil(CardText.timestamp("not a date"))
    }

    // MARK: Date labels

    private var fixedCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles") ?? .gmt
        return calendar
    }()

    private func label(_ value: String, now: Date) -> String? {
        return CardText.compactDateLabel(
            value,
            now: now,
            calendar: fixedCalendar,
            locale: Locale(identifier: "en_US")
        )
        // `Date.FormatStyle` separates the time from AM/PM with U+202F, a
        // narrow no-break space. That is correct output and the card wants it;
        // it just cannot be typed into an expectation below, so both sides of
        // the comparison get ordinary spaces.
        .map { $0.replacingOccurrences(of: "\u{202F}", with: " ")
                 .replacingOccurrences(of: "\u{00A0}", with: " ") }
    }

    func testTodayIsATimeThisYearIsADayOlderEarnsItsYear() {
        let sameDay = reference.addingTimeInterval(3600)
        XCTAssertEqual(label("Wed, 2 Sep 2026 19:08:04 -0700", now: sameDay), "7:08 PM")

        let laterThatYear = reference.addingTimeInterval(60 * 24 * 3600)
        XCTAssertEqual(label("Wed, 2 Sep 2026 19:08:04 -0700", now: laterThatYear), "Sep 2")

        let nextYear = reference.addingTimeInterval(400 * 24 * 3600)
        XCTAssertEqual(label("Wed, 2 Sep 2026 19:08:04 -0700", now: nextYear), "Sep 2, 2026")
    }

    /// The regression this whole change exists for: the row used to print the
    /// raw header, which the single-line column then cut mid-second.
    func testAGmailHeaderNeverRendersAsARawHeader() {
        let stamp = label("Wed, 2 Sep 2026 19:08:04 -0700 (PDT)", now: reference.addingTimeInterval(400 * 24 * 3600))
        XCTAssertEqual(stamp, "Sep 2, 2026")
        XCTAssertFalse(stamp?.contains(":0") ?? true)
        XCTAssertFalse(stamp?.contains("-0700") ?? true)
    }

    func testShortUnparseableValuesPassThroughAndLongOnesAreDropped() {
        XCTAssertEqual(label("today", now: reference), "today")
        XCTAssertNil(label("", now: reference))
        XCTAssertNil(label("an unparseable forty character date value", now: reference))
    }

    // MARK: Sender names

    func testSenderNameKeepsTheHumanAndDropsTheMachine() {
        let cases: [(String, String)] = [
            ("\"Support at TripIt\" <support@tripit.com>", "Support at TripIt"),
            ("Support at TripIt <support@tripit.com>", "Support at TripIt"),
            ("<support@tripit.com>", "support@tripit.com"),
            ("support@tripit.com", "support@tripit.com"),
            ("\"support@tripit.com\" <support@tripit.com>", "support@tripit.com"),
            ("\"Doe, Jane\" <jane@example.com>", "Doe, Jane"),
            ("\"Jane \\\"JD\\\" Doe\" <jane@example.com>", "Jane \"JD\" Doe"),
            ("", ""),
            ("   ", ""),
        ]
        for (input, expected) in cases {
            XCTAssertEqual(CardText.senderName(input), expected, "input: \(input)")
        }
    }

    func testSenderNameCountsTheRestOfTheList() {
        XCTAssertEqual(
            CardText.senderName("\"Doe, Jane\" <jane@example.com>, bob@example.com"),
            "Doe, Jane +1"
        )
        XCTAssertEqual(
            CardText.senderName("a@example.com, b@example.com, c@example.com"),
            "a@example.com +2"
        )
    }

    /// Deliberate: a half-decoded encoded-word reads as our bug, the address
    /// never does.
    func testEncodedWordFallsBackToTheAddress() {
        XCTAssertEqual(
            CardText.senderName("=?UTF-8?B?U3VwcG9ydA==?= <support@tripit.com>"),
            "support@tripit.com"
        )
    }

    // MARK: Links

    func testGmailURLAddressesTheMessageInTheRightAccount() {
        XCTAssertEqual(
            CardText.gmailURL(id: "18f0a2b3c4d5e6f7", mailbox: "assistant@example.com")?.absoluteString,
            "https://mail.google.com/mail/?authuser=assistant@example.com#all/18f0a2b3c4d5e6f7"
        )
        XCTAssertEqual(
            CardText.gmailURL(id: "18f0a2b3c4d5e6f7", mailbox: "")?.absoluteString,
            "https://mail.google.com/mail/u/0/#all/18f0a2b3c4d5e6f7"
        )
    }

    func testGmailURLRefusesASynthesisedID() {
        XCTAssertNil(CardText.gmailURL(id: "email-0-0", mailbox: "assistant@example.com"))
        XCTAssertNil(CardText.gmailURL(id: "", mailbox: "assistant@example.com"))
    }

    func testPresentationLabelsHideTransportFormatting() {
        XCTAssertEqual(CardText.presentationLabel("SOURCE_MESSAGE"), "Source message")
        XCTAssertEqual(CardText.presentationLabel("source-document"), "Source document")
        XCTAssertEqual(CardText.presentationLabel("MCP"), "MCP")
        XCTAssertEqual(CardText.presentationLabel("Cinema email"), "Cinema email")
    }

    func testActivityHidesInternalPipelineDiagnostics() {
        let diagnostic = ActivityItem(
            id: "activity-1",
            type: "scheduled",
            status: "done",
            title: "Background work",
            progress: "pulse: quiet (no-candidates)",
            trust: "assistant",
            spentUsd: "0",
            budgetUsdLimit: "0.5",
            updatedAt: "2026-09-03T18:00:00Z",
            archivedAt: nil,
            hasPendingApproval: false
        )
        XCTAssertEqual(diagnostic.displayProgress, "")
    }
}

enum RelationshipGraphFixture {
    static func snapshot(count: Int = 18) -> RelationshipGraphSnapshot {
        let names = ["Alex Rivera", "Robin Rivera", "Maya Chen", "Sam Okafor", "Elena Rossi", "Noah Martin", "Northstar Studio", "San Francisco", "Design meetup", "Summer trip", "Iris Park", "Leo Jensen", "Ava Santos", "Owen Lee", "Sofia Costa", "Theo Reed", "Family dinner", "Oakland"]
        let nodes = (0..<count).map { i in RelationshipGraphNode(id: "node-\(i)", label: i < names.count ? names[i] : "Person \(i)", kind: i == 6 ? "organization" : [7, 17].contains(i) ? "place" : [8, 9, 16].contains(i) ? "project" : "person") }
        let edges = (1..<max(1, count)).map { i in edge("edge-\(i)", from: "node-\(i < 6 ? 0 : i < 12 ? 2 : 4)", to: "node-\(i)") }
            + (count > 8 ? [edge("cross", from: "node-1", to: "node-6"), edge("cross2", from: "node-4", to: "node-6"), edge("cross3", from: "node-2", to: "node-4")] : [])
        return .init(nodes: nodes, edges: edges, totalEdges: edges.count, truncated: false, focusId: nil)
    }
    static func edge(_ id: String, from: String, to: String) -> RelationshipGraphEdge {
        .init(id: id, subjectId: from, objectId: to, predicate: "knows", reviewStatus: "confirmed", sourceContent: "A synthetic source note.", presentation: .init(sentence: "Alex knows Robin.", label: "Knows", accessibleLabel: "Alex knows Robin."), validFrom: nil, validUntil: nil)
    }
}

extension APIModelsTests {
    func testForceGraphUsesTopologyRatherThanDuplicateSourceWeights() {
        let a = RelationshipGraphFixture.edge("a", from: "node-0", to: "node-1")
        let b = RelationshipGraphFixture.edge("b", from: "node-0", to: "node-1")
        var graph = RelationshipGraphFixture.snapshot(count: 2)
        graph.edges = [a, b]
        XCTAssertEqual(graph.links, [GraphLink("node-0", "node-1")])
        XCTAssertEqual(graph.neighborhood(of: "node-0"), Set(["node-0", "node-1"]))
        graph.edges.removeFirst()
        XCTAssertEqual(graph.links.count, 1, "Removing one source must retain the other claim")
    }

    func testForceGraphExpansionReplacesStaleNeighborhoodAndKeepsUnrelatedEdges() {
        let graph = RelationshipGraphFixture.snapshot()
        let replacement = RelationshipGraphSnapshot(nodes: graph.nodes, edges: [RelationshipGraphFixture.edge("new", from: "node-0", to: "node-17")], totalEdges: 1, truncated: false, focusId: "node-0")
        let merged = graph.merging(replacement, around: "node-0")
        XCTAssertEqual(merged.edges.filter { $0.subjectId == "node-0" }.map(\.id), ["new"])
        XCTAssertTrue(merged.edges.contains { $0.id == "cross" })
        XCTAssertEqual(merged.merging(replacement, around: "node-0").edges.count, merged.edges.count)
    }

    func testForceLayoutKeepsExistingPositionsDuringExpansionAndRemainsFiniteAtCapacity() {
        let graph = RelationshipGraphFixture.snapshot(count: 200)
        var layout = RelationshipGraphLayout()
        layout.update(nodes: Array(graph.nodes.prefix(18)), links: graph.links)
        for _ in 0..<120 { layout.step() }
        let before = Dictionary(uniqueKeysWithValues: zip(layout.ids, layout.positions))
        layout.update(nodes: graph.nodes, links: graph.links)
        for (id, point) in zip(layout.ids, layout.positions) where before[id] != nil { XCTAssertEqual(before[id], point) }
        let start = Date()
        for _ in 0..<120 { layout.step() }
        let elapsed = Date().timeIntervalSince(start)
        let note = XCTAttachment(string: "200 nodes, 120 settling steps: \(elapsed) seconds in simulator test build")
        note.lifetime = .keepAlways; add(note)
        XCTAssertTrue(layout.positions.allSatisfy { $0.x.isFinite && $0.y.isFinite })
        XCTAssertEqual(layout.positions.count, 200)
        layout.move(id: "node-0", to: CGPoint(x: 30, y: 40))
        layout.step(pinned: "node-0")
        XCTAssertEqual(layout.positions[layout.ids.firstIndex(of: "node-0")!], CGPoint(x: 30, y: 40))
    }

    func testGraphGroupsAndConnectionPromptsUseOnlyRecordedTopology() throws {
        let nodes = (0..<6).map { RelationshipGraphNode(id: "n\($0)", label: $0 < 2 ? "Alex" : "Item \($0)", kind: "person") }
        let edges = [RelationshipGraphFixture.edge("a", from: "n0", to: "n2"), RelationshipGraphFixture.edge("b", from: "n1", to: "n2"), RelationshipGraphFixture.edge("c", from: "n3", to: "n4")]
        let graph = RelationshipGraphSnapshot(nodes: nodes, edges: edges, totalEdges: 3, truncated: true, focusId: nil)
        XCTAssertEqual(graph.groups.map { $0.nodes.count }, [3, 2, 1])
        XCTAssertEqual(graph.groups.last?.ids, ["n5"])
        let candidates = graph.connectionCandidates(for: "n0")
        XCTAssertEqual(candidates.first?.node.id, "n1", "Same names must remain distinct entities")
        XCTAssertEqual(candidates.first?.reason, "Both connect to Item 2")
        XCTAssertFalse(candidates.contains { ["n0", "n2"].contains($0.node.id) })
        XCTAssertTrue(candidates.contains { $0.node.id == "n5" && $0.reason.contains("separate group") })
        let bridged = graph.merging(.init(nodes: nodes, edges: edges + [RelationshipGraphFixture.edge("bridge", from: "n0", to: "n3")], totalEdges: 4, truncated: false, focusId: "n0"), around: "n0")
        XCTAssertEqual(bridged.groups.map { $0.nodes.count }, [5, 1])
        XCTAssertEqual(graph.showing(["n0", "n2"]).links.count, 1)
    }

    func testGraphPackingSeparatesGroupsAndRemainsStable() {
        let nodes = (0..<12).map { RelationshipGraphNode(id: "n\($0)", label: "Item \($0)", kind: "person") }
        let edges = [RelationshipGraphFixture.edge("a", from: "n0", to: "n1"), RelationshipGraphFixture.edge("b", from: "n2", to: "n3")]
        let graph = RelationshipGraphSnapshot(nodes: nodes, edges: edges, totalEdges: 2, truncated: false, focusId: nil)
        var layout = RelationshipGraphLayout(); layout.update(nodes: nodes, links: graph.links)
        for _ in 0..<120 { layout.step() }
        layout.arrangeGroups()
        func boxes() -> [CGRect] {
            let positions = Dictionary(uniqueKeysWithValues: zip(layout.ids, layout.positions))
            return graph.groups.map { group in
                let points = group.nodes.compactMap { positions[$0.id] }
                let xs = points.map(\.x), ys = points.map(\.y)
                return CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!).insetBy(dx: -20, dy: -20)
            }
        }
        let initial = boxes()
        for i in initial.indices { for j in initial.indices where j > i { XCTAssertFalse(initial[i].intersects(initial[j])) } }
        for _ in 0..<100 { layout.step() }
        let settled = boxes()
        for i in settled.indices { for j in settled.indices where j > i { XCTAssertFalse(settled[i].intersects(settled[j])) } }
        XCTAssertTrue(layout.positions.allSatisfy { $0.x.isFinite && $0.y.isFinite })
    }

    func testGraphViewportZoomKeepsPinchAnchorAndClampsScale() {
        var viewport = GraphViewport(scale: 1.2, offset: CGPoint(x: 30, y: -22))
        let size = CGSize(width: 390, height: 640), anchor = CGPoint(x: 63, y: 97)
        let world = viewport.world(anchor, size: size)
        viewport.zoom(to: 2.4, anchor: anchor, size: size)
        XCTAssertEqual(viewport.screen(world, size: size).x, anchor.x, accuracy: 0.001)
        XCTAssertEqual(viewport.screen(world, size: size).y, anchor.y, accuracy: 0.001)
        viewport.zoom(to: 100, anchor: anchor, size: size); XCTAssertEqual(viewport.scale, 4)
        viewport.zoom(to: 0.001, anchor: anchor, size: size); XCTAssertEqual(viewport.scale, 0.15)
    }
}

final class AssistantConfirmationStateTests: XCTestCase {
    func testFirstTapNeverExecutesAndSecondTapConsumesConfirmation() {
        var state = AssistantConfirmationState()
        let now = Date(timeIntervalSince1970: 1_000)
        XCTAssertFalse(state.tap(now: now))
        XCTAssertTrue(state.tap(now: now.addingTimeInterval(1)))
        XCTAssertNil(state.expiresAt)
        // A third tap starts a fresh confirmation, including after an API failure.
        XCTAssertFalse(state.tap(now: now.addingTimeInterval(2)))
    }

    func testExpiredConfirmationCannotExecuteBeforeTimerResumes() {
        var state = AssistantConfirmationState()
        let now = Date(timeIntervalSince1970: 1_000)
        XCTAssertFalse(state.tap(now: now))
        XCTAssertFalse(state.tap(now: now.addingTimeInterval(AssistantConfirmationState.lifetime)))
        XCTAssertTrue(state.tap(now: now.addingTimeInterval(AssistantConfirmationState.lifetime + 1)))
    }

    func testLeavingOrDisablingControlResetsConfirmation() {
        var state = AssistantConfirmationState()
        XCTAssertFalse(state.tap())
        state.reset()
        XCTAssertNil(state.expiresAt)
        XCTAssertFalse(state.tap())
    }

    func testConfirmationDoesNotAuthorizeAnotherItem() {
        var first = AssistantConfirmationState()
        var second = AssistantConfirmationState()
        XCTAssertFalse(first.tap())
        XCTAssertFalse(second.tap())
        XCTAssertTrue(first.tap())
        XCTAssertNotNil(second.expiresAt)
    }
}
