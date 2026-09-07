import XCTest
import SwiftUI
@testable import Assistant

/// Stands in for the network so a dead pooled connection can be reproduced
/// deterministically. Each queued outcome is consumed by one request, so a test
/// says exactly what the first attempt and the retry each see.
final class StubURLProtocol: URLProtocol {
    enum Outcome {
        case failure(URLError)
        case success(status: Int, body: Data)
    }

    private static let lock = NSLock()
    private static var outcomes: [Outcome] = []
    private static var recordedMethods: [String] = []

    static func prime(_ queued: [Outcome]) {
        lock.withLock {
            outcomes = queued
            recordedMethods = []
        }
    }

    /// One entry per attempt that reached the network — the assertion that
    /// distinguishes "retried once" from "never retried" and from "retried".
    static var attempts: [String] {
        lock.withLock { recordedMethods }
    }

    private static func next(for method: String) -> Outcome {
        lock.withLock {
            recordedMethods.append(method)
            return outcomes.isEmpty ? .success(status: 200, body: Data()) : outcomes.removeFirst()
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let method = request.httpMethod ?? "GET"
        switch Self.next(for: method) {
        case let .failure(error):
            client?.urlProtocol(self, didFailWithError: error)
        case let .success(status, body):
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["content-type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
}

final class APIClientRetryTests: XCTestCase {
    func testVisualSummaryKeepsEveryStatusAndRejectsInvalidChartValues() {
        let summary = ActivityVisualSummary(statuses: ["waiting_approval", "waiting_budget", "needs_attention",
            "pending", "running", "sleeping", "waiting_event", "done", "failed", "cancelled", "new_status"])
        XCTAssertEqual(summary.counts, [3, 2, 2, 1, 2, 1])
        XCTAssertEqual(AssistantChartScale.shares([0, -1, .nan, .infinity]), [0, 0, 0, 0])
        XCTAssertEqual(AssistantChartScale.shares([]), [])
        XCTAssertEqual(AssistantChartScale.shares([1, 3]), [0.25, 0.75])
        XCTAssertEqual(AssistantChartScale.shares([.greatestFiniteMagnitude, .greatestFiniteMagnitude]), [0.5, 0.5])
        XCTAssertNil(AssistantMotion.response(reduceMotion: true))
        XCTAssertNotNil(AssistantMotion.response(reduceMotion: false))
        XCTAssertNotEqual(relative("2026-09-06T20:00:00Z"), "2026-09-06T20:00:00Z")
        XCTAssertEqual(relative("Unknown date"), "Unknown date")
    }

    @MainActor
    func testVisualConsistencyActivityGoalsAndEditorSnapshots() async throws {
        let goal = GoalRecord(id: "visual-goal", title: "Plan the weekend", description: "A relaxed family trip.",
            status: "active", priority: 3, progress: "Found **three places** with space for everyone.",
            nextAction: "Compare travel times and cancellation policies before choosing.", targetDate: nil,
            createdAt: "2026-09-06", updatedAt: "2026-09-06", archivedAt: nil,
            mirrorToPrimary: false, autonomy: false, taintedOrigin: false)
        let overview = OverviewResponse(generatedAt: "2026-09-06",
            activity: ActivityList(items: [
                ActivityItem(id: "done", type: "chat_turn", status: "done", title: "Find places for lunch",
                    progress: "Compared **three options** along your route, with opening hours and travel times.",
                    trust: "owner", spentUsd: "0.008", budgetUsdLimit: "0.50", updatedAt: "2026-09-06T20:00:00Z",
                    archivedAt: nil, hasPendingApproval: false),
                ActivityItem(id: "running", type: "scheduled", status: "running", title: "Check the weekend forecast",
                    progress: "Checking the forecast for your destination.", trust: "owner", spentUsd: "0.003",
                    budgetUsdLimit: "0.02", updatedAt: "2026-09-06T20:00:00Z", archivedAt: nil, hasPendingApproval: false)
            ], archivedCount: 0),
            goals: GoalsDashboard(items: [GoalDashboardItem(goal: goal, conversationId: "visual-chat",
                workActive: false, automation: nil, cadenceLabel: "On demand", blockedQuestion: "", stalled: false)], archivedCount: 0),
            approvals: ApprovalInbox(pending: [], resolved: []),
            documents: DocumentsOverview(documents: [], stats: DocumentStats(total: 0, ready: 0, pending: 0, chunks: 0),
                primaryConversationId: "visual-chat"))
        StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(overview))])
        let model = AppModel(apiClient: makeClient())
        await model.refreshOverview()
        XCTAssertEqual(model.overview?.activity.items.count, 2)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for (name, scheme, width, size) in [
            ("light", ColorScheme.light, CGFloat(393), DynamicTypeSize.large),
            ("dark", ColorScheme.dark, CGFloat(393), DynamicTypeSize.large),
            ("compact", ColorScheme.light, CGFloat(320), DynamicTypeSize.large),
            ("accessible", ColorScheme.light, CGFloat(393), DynamicTypeSize.accessibility3)
        ] {
            for page in ["activity", "goals", "editor"] {
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: width, height: 852)
                window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
                let content = NavigationStack {
                    if page == "activity" { ActivityView() }
                    else if page == "goals" { GoalsView() }
                    else {
                        AssistantForm {
                            Section("Details") {
                                TextField("Name", text: .constant("Weekend plan"))
                                Toggle("Keep updated", isOn: .constant(true))
                            }
                            Section("Evidence") {
                                DisclosureGroup("Recorded details", isExpanded: .constant(true)) {
                                    Text("Only confirmed information is shown here.")
                                }
                                DisclosureGroup("Source messages") { Text("Source preview") }
                            }
                        }
                        .disclosureGroupStyle(AssistantEvidenceDisclosureStyle())
                        .navigationTitle("Edit details")
                    }
                }
                .environmentObject(model).environment(\.colorScheme, scheme)
                .environment(\.dynamicTypeSize, size)
                window.rootViewController = UIHostingController(rootView: content)
                window.isHidden = false
                defer { window.isHidden = true; window.rootViewController = nil }
                try await Task.sleep(for: .milliseconds(350))
                window.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let attachment = XCTAttachment(image: image)
                attachment.name = "visual-\(page)-\(name)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    @MainActor
    func testPeopleConnectionsStartsWithChoiceNotInventedDirectoryEdges() async throws {
        let people = PeopleMapFixture.relations.compactMap { relation -> PersonSummary? in
            guard let id = relation.otherContactId else { return nil }
            return PersonSummary(id: id, name: relation.otherLabel, initials: relation.otherInitials,
                relationship: "", group: "family", groupLabel: "Family", trust: "known",
                location: nil, factCount: 1, birthday: nil, birthdayDaysUntil: nil, lastContact: nil)
        }
        var seen = Set<String>()
        let response = PersonDirectoryResponse(generatedAt: "2026-09-06", people: people.filter { seen.insert($0.id).inserted })
        StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(response))])
        let model = AppModel(apiClient: makeClient())
        await model.loadPeople()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for size in [DynamicTypeSize.large, .accessibility3] {
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
            window.overrideUserInterfaceStyle = .light
            window.rootViewController = UIHostingController(rootView:
                NavigationStack { PeopleView() }.environmentObject(model)
                    .environment(\.colorScheme, .light).environment(\.dynamicTypeSize, size))
            window.isHidden = false
            defer { window.isHidden = true; window.rootViewController = nil }
            try await Task.sleep(for: .milliseconds(350))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "people-chooser-\(size)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        XCTAssertTrue(model.peopleLoaded)
        XCTAssertTrue(model.personCards.isEmpty, "A directory category must not imply a connection or eagerly fetch every person")
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
    }

    @MainActor
    func testPeopleConnectionMapLightDarkCompactAndLargeTextSnapshots() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for (name, scheme, width, size, count) in [
            ("light", ColorScheme.light, CGFloat(393), DynamicTypeSize.large, 7),
            ("dark", ColorScheme.dark, CGFloat(393), DynamicTypeSize.large, 7),
            ("compact", ColorScheme.light, CGFloat(320), DynamicTypeSize.large, 7),
            ("accessible", ColorScheme.light, CGFloat(393), DynamicTypeSize.accessibility3, 7),
            ("empty", ColorScheme.light, CGFloat(393), DynamicTypeSize.large, 0)
        ] {
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: width, height: 852)
            window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
            let content = NavigationStack {
                ScrollView {
                    PeopleConnectionMap(card: PeopleMapFixture.card(relations: Array(PeopleMapFixture.relations.prefix(count))),
                        open: { _ in }, inspect: { _ in }).padding(16)
                }
                .navigationTitle("People")
                .assistantSubmenuChrome()
            }.environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            window.rootViewController = UIHostingController(rootView: content)
            window.isHidden = false
            defer { window.isHidden = true; window.rootViewController = nil }
            try await Task.sleep(for: .milliseconds(350))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "people-map-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testKnowledgeMapLightDarkAndCompactSnapshots() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for (name, scheme, width, count) in [
            ("light", ColorScheme.light, CGFloat(393), 6),
            ("dark", ColorScheme.dark, CGFloat(393), 6),
            ("compact", ColorScheme.light, CGFloat(320), 6),
            ("single", ColorScheme.light, CGFloat(393), 1),
            ("empty", ColorScheme.light, CGFloat(393), 0)
        ] {
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: width, height: 852)
            window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
            let content = NavigationStack {
                ScrollView {
                    KnowledgeGraphView(focus: KnowledgeGraphFixture.focus,
                        relations: Array(KnowledgeGraphFixture.relations.prefix(count)), loading: false,
                        open: { _ in }, inspect: { _ in })
                        .padding(16)
                }
                .navigationTitle("Knowledge")
                .assistantSubmenuChrome()
            }.environment(\.colorScheme, scheme)
            window.rootViewController = UIHostingController(rootView: content)
            window.isHidden = false
            defer { window.isHidden = true; window.rootViewController = nil }
            try await Task.sleep(for: .milliseconds(350))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "knowledge-map-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testGoalEditorUsesSharedCanvasInBothAppearances() async throws {
        let goal = GoalRecord(
            id: "preview", title: "Plan the weekend", description: "Keep the plan flexible.",
            status: "active", priority: 3, progress: "Gathering options", nextAction: "Compare travel times",
            targetDate: nil, createdAt: "2026-09-06", updatedAt: "2026-09-06", archivedAt: nil,
            mirrorToPrimary: false, autonomy: false, taintedOrigin: false
        )
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for scheme in [ColorScheme.light, .dark] {
            for editing in [false, true] {
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
                window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
                let content = NavigationStack {
                    GoalEditor(goal: editing ? goal : nil)
                }
                .environmentObject(AppModel(apiClient: makeClient()))
                .environment(\.colorScheme, scheme)
                window.rootViewController = UIHostingController(rootView: content)
                window.isHidden = false
                defer {
                    window.isHidden = true
                    window.rootViewController = nil
                }
                try await Task.sleep(for: .milliseconds(350))
                window.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let attachment = XCTAttachment(image: image)
                attachment.name = "goal-\(editing ? "edit" : "new")-\(scheme == .light ? "light" : "dark")"
                attachment.lifetime = .keepAlways
                add(attachment)

                // The exposed gutter must be our canvas, not UIKit's gray
                // grouped-form background. Sample away from glass controls.
                let cgImage = try XCTUnwrap(image.cgImage)
                var pixels = [UInt8](repeating: 0, count: cgImage.width * cgImage.height * 4)
                let context = try XCTUnwrap(CGContext(
                    data: &pixels, width: cgImage.width, height: cgImage.height,
                    bitsPerComponent: 8, bytesPerRow: cgImage.width * 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                ))
                context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
                let offset = (cgImage.height / 2 * cgImage.width + Int(2 * image.scale)) * 4
                let expected = scheme == .light ? [238, 245, 240] : [16, 23, 18]
                for channel in 0..<3 {
                    XCTAssertEqual(Double(pixels[offset + channel]), Double(expected[channel]), accuracy: 2)
                }
            }
        }
    }

    @MainActor
    func testSituationPackLightAndDarkSnapshots() async throws {
        let data = Data("""
        {"packs":[{"id":"pack","title":"Soccer weekend","version":3,"archived":false,"updatedAt":"2026-09-06T12:00:00Z",
        "data":{"items":[{"id":"ride","title":"Confirm ride","details":"Share the arrival time once confirmed.","lane":"i_owe","dependsOn":[],"source":null,"snapshot":null,"needsReview":true}],"decisions":[]},"changes":[],"affectedIds":["ride"]}],"sources":[]}
        """.utf8)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for scheme in [ColorScheme.light, .dark] {
            for screen in ["list", "detail", "form", "unavailable"] {
                StubURLProtocol.prime([screen == "unavailable"
                    ? .success(status: 404, body: Data(#"{"error":"not found"}"#.utf8))
                    : .success(status: 200, body: data)])
                let model = AppModel(apiClient: makeClient())
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
                window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
                let content = NavigationStack {
                    if screen == "detail" {
                        SituationPackDetail(packId: "pack")
                    } else if screen == "form" {
                        SituationPackForm {
                            Section("Item") {
                                TextField("Title", text: .constant("Confirm ride"))
                                TextField("Notes", text: .constant("Share the arrival time"))
                            }
                            Button("Save") {}
                        }.navigationTitle("Linked item").navigationBarTitleDisplayMode(.inline)
                    } else {
                        SituationPacksView()
                    }
                }
                .environmentObject(model)
                .environment(\.colorScheme, scheme)
                window.rootViewController = UIHostingController(rootView: content)
                window.isHidden = false
                try await Task.sleep(for: .milliseconds(350))
                window.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let attachment = XCTAttachment(image: image)
                attachment.name = "situation-\(screen)-\(scheme == .light ? "light" : "dark")"
                attachment.lifetime = .keepAlways
                add(attachment)
                window.isHidden = true
                window.rootViewController = nil
            }
        }
    }

    @MainActor
    func testEvidenceRefreshReloadsCurrentPersonAndInvalidatesOtherDossiers() async {
        func card(_ id: String, name: String) -> Data {
            Data("""
            {"id":"\(id)","name":"\(name)","initials":"AR","relationship":"Family",
             "group":"family","groupLabel":"Family","trust":"known","howWeMet":[],
             "relations":[],"connections":[],"events":[],"eventsAreRecent":true,"factCount":0}
            """.utf8)
        }
        StubURLProtocol.prime([
            .success(status: 200, body: card("alex", name: "Alex")),
            .success(status: 200, body: card("robin", name: "Robin")),
            .success(status: 200, body: card("robin", name: "Robin refreshed"))
        ])
        let model = AppModel(apiClient: makeClient())
        await model.loadPersonCard(id: "alex")
        await model.loadPersonCard(id: "robin")
        XCTAssertEqual(model.personCards.count, 2)
        await model.refreshPersonEvidence(id: "robin")
        XCTAssertNil(model.personCards["alex"], "Back navigation must not reuse stale evidence")
        XCTAssertEqual(model.personCards["robin"]?.name, "Robin refreshed")
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "GET", "GET"])
    }

    @MainActor
    func testRemovingRelationshipRequiresServerSuccess() async {
        StubURLProtocol.prime([.success(status: 404, body: Data(#"{"error":"relationship not found"}"#.utf8))])
        let model = AppModel(apiClient: makeClient())
        let failed = await model.removeKnowledgeRelation(id: "missing")
        XCTAssertFalse(failed)
        XCTAssertEqual(StubURLProtocol.attempts, ["DELETE"])
        XCTAssertNotNil(model.errorMessage)

        StubURLProtocol.prime([.success(status: 200, body: Data(#"{"ok":false}"#.utf8))])
        let refused = await model.removeKnowledgeRelation(id: "claim")
        XCTAssertFalse(refused)

        StubURLProtocol.prime([.success(status: 200, body: Data(#"{"ok":true}"#.utf8))])
        let removed = await model.removeKnowledgeRelation(id: "claim")
        XCTAssertTrue(removed)
        XCTAssertEqual(StubURLProtocol.attempts, ["DELETE"])
    }

    @MainActor
    func testPackDiscussionPreparesADraftWithoutSendingOrCallingTheServer() {
        StubURLProtocol.prime([])
        let model = AppModel(apiClient: makeClient())
        model.discussSituationPack(id: "test-pack-id")
        XCTAssertTrue(model.packDiscussionDraft?.contains("test-pack-id") == true)
        XCTAssertFalse(model.isSending)
        XCTAssertTrue(model.messages.isEmpty)
        XCTAssertTrue(StubURLProtocol.attempts.isEmpty)
        XCTAssertNotNil(model.consumePackDiscussionDraft())
        XCTAssertNil(model.packDiscussionDraft)
        XCTAssertNil(model.restorableDraft)
    }
    @MainActor
    func testAcceptedApprovalAndDenialUpdateChatEvenWhenInboxRefreshFails() async {
        for decision in ["approved", "denied"] {
            StubURLProtocol.prime([
                .success(status: 200, body: Data(#"{"ok":true,"taskId":"t1","toolCallId":"tc1","approvalId":"a1"}"#.utf8)),
                .success(status: 401, body: Data())
            ])
            let model = AppModel(apiClient: makeClient(), initialMessages: [.init(id: "summary", role: .assistant,
                parts: [.init(type: "approval-summary", purpose: "Test action", approvalCount: 1,
                    approvalIds: ["a1"])])])
            let accepted = await model.decideApproval(id: "a1", decision: decision)
            XCTAssertTrue(accepted)
            XCTAssertEqual(model.messages[0].approvalSummary?.pendingCount, 0)
            XCTAssertEqual(model.messages[0].approvalSummary?.outcomes.first?.status, decision)
            XCTAssertEqual(StubURLProtocol.attempts, ["POST", "GET"])
        }
    }

    @MainActor
    func testFailedApprovalRequestDoesNotSettleTheChatCard() async {
        for response in [
            StubURLProtocol.Outcome.failure(URLError(.timedOut)),
            .success(status: 200, body: Data(#"{"ok":false,"taskId":"t1","toolCallId":"tc1","approvalId":"a1"}"#.utf8))
        ] {
            StubURLProtocol.prime([response])
            let pending = ChatMessage(id: "summary", role: .assistant,
                parts: [.init(type: "approval-summary", purpose: "Test action", approvalCount: 1,
                    approvalIds: ["a1"])])
            let model = AppModel(apiClient: makeClient(), initialMessages: [pending])
            let accepted = await model.decideApproval(id: "a1", decision: "approved")
            XCTAssertFalse(accepted)
            XCTAssertEqual(model.messages, [pending])
            XCTAssertNotNil(model.errorMessage)
            XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
        }
    }

    private func makeClient() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return APIClient(
            configuration: .init(baseURL: URL(string: "https://assistant.test")!, token: "t"),
            session: URLSession(configuration: configuration)
        )
    }

    /// The failure this whole change exists for: the first attempt is handed a
    /// connection that died during suspension, and the second one succeeds.
    func testReadRetriesOnceAfterATimeout() async throws {
        let body = Data(#"{"findings":[]}"#.utf8)
        StubURLProtocol.prime([
            .failure(URLError(.timedOut)),
            .success(status: 200, body: body),
        ])

        let cleanup = try await makeClient().knowledgeCleanup()

        XCTAssertEqual(cleanup.findings.count, 0)
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "GET"])
    }

    /// A retry that fails too reports the transport error, not Foundation's.
    func testRepeatedTimeoutSurfacesTransportCopy() async {
        StubURLProtocol.prime([
            .failure(URLError(.timedOut)),
            .failure(URLError(.timedOut)),
        ])

        do {
            _ = try await makeClient().knowledgeCleanup()
            XCTFail("expected the second timeout to propagate")
        } catch let error as APIError {
            XCTAssertTrue(error.isTransport)
            XCTAssertEqual(
                error.errorDescription,
                "Couldn't reach your assistant — it may still be waking up."
            )
        } catch {
            XCTFail("expected APIError.transport, got \(error)")
        }
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "GET"])
    }

    /// Writes are never replayed: the server may well have applied the first
    /// one before its answer went missing, and a doubled decision is worse
    /// than a visible failure.
    func testWriteIsNotRetried() async {
        StubURLProtocol.prime([.failure(URLError(.timedOut))])

        do {
            _ = try await makeClient().decideApproval(id: "a1", decision: "approved")
            XCTFail("expected the timeout to propagate")
        } catch let error as APIError {
            XCTAssertTrue(error.isTransport)
        } catch {
            XCTFail("expected APIError.transport, got \(error)")
        }
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
    }

    /// Only failures a fresh connection could plausibly fix are retried.
    func testUnrecoverableTransportFailureIsNotRetried() async {
        StubURLProtocol.prime([.failure(URLError(.userAuthenticationRequired))])

        do {
            _ = try await makeClient().knowledgeCleanup()
            XCTFail("expected the error to propagate")
        } catch let error as APIError {
            XCTAssertTrue(error.isTransport)
        } catch {
            XCTFail("expected APIError.transport, got \(error)")
        }
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
    }

    /// A server that answered is not a transport failure, so the banner must
    /// not offer to retry it — the same answer would come back.
    func testServerErrorIsNotTreatedAsTransport() async {
        StubURLProtocol.prime([
            .success(status: 500, body: Data(#"{"error":"boom"}"#.utf8)),
        ])

        do {
            _ = try await makeClient().knowledgeCleanup()
            XCTFail("expected a server error")
        } catch let error as APIError {
            XCTAssertFalse(error.isTransport)
            XCTAssertEqual(error.errorDescription, "boom")
        } catch {
            XCTFail("expected APIError.server, got \(error)")
        }
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
    }

    func testOfflineGetsItsOwnCopy() {
        let error = APIError.transport(URLError(.notConnectedToInternet))
        XCTAssertEqual(error.errorDescription, "You appear to be offline.")
    }
}
