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
        case stream(body: Data)
    }

    private static let lock = NSLock()
    private static var outcomes: [Outcome] = []
    private static var recordedMethods: [String] = []
    private static var recordedURLs: [URL] = []
    private static weak var activeStream: StubURLProtocol?

    static func prime(_ queued: [Outcome]) {
        lock.withLock {
            outcomes = queued
            recordedMethods = []
            recordedURLs = []
            activeStream = nil
        }
    }

    /// One entry per attempt that reached the network — the assertion that
    /// distinguishes "retried once" from "never retried" and from "retried".
    static var attempts: [String] {
        lock.withLock { recordedMethods }
    }

    static var urls: [URL] { lock.withLock { recordedURLs } }

    static func appendStream(_ body: Data) {
        guard let stream = lock.withLock({ activeStream }) else { return }
        stream.client?.urlProtocol(stream, didLoad: body)
    }

    private static func next(for method: String, url: URL?) -> Outcome {
        lock.withLock {
            recordedMethods.append(method)
            if let url { recordedURLs.append(url) }
            return outcomes.isEmpty ? .success(status: 200, body: Data()) : outcomes.removeFirst()
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let method = request.httpMethod ?? "GET"
        switch Self.next(for: method, url: request.url) {
        case let .failure(error):
            client?.urlProtocol(self, didFailWithError: error)
        case let .stream(body):
            Self.lock.withLock { Self.activeStream = self }
            let response = HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: "HTTP/1.1", headerFields: ["content-type": "text/event-stream"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            // Remain open so the test can deliver later tokens while sending.
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
    func testRelationshipGraphOmitsAbsentQueryIdentifiers() async throws {
        let body = try JSONEncoder().encode(RelationshipGraphSnapshot.empty)
        for (person, entity, expected) in [(nil, nil, Set<String>()), ("person-id", nil, ["person"]), (nil, "entity-id", ["entity"])] as [(String?, String?, Set<String>)] {
            StubURLProtocol.prime([.success(status: 200, body: body)])
            _ = try await makeClient().relationshipGraph(personID: person, entityID: entity)
            let url = try XCTUnwrap(StubURLProtocol.urls.first)
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            XCTAssertEqual(Set(items.map(\.name)), expected)
            XCTAssertTrue(items.allSatisfy { $0.value?.isEmpty == false })
        }
    }

    func testSpendingBreakdownPreservesEntriesAndSeparatesUnknownFromZero() {
        let breakdown = SpendingBreakdown(rows: [
            ("Small", "1", 1), ("Unknown", nil, 2), ("Largest", "4", 3),
            ("Zero", "0", 4), ("Invalid", "nan", 5), ("Negative", "-2", 6),
            ("Infinite", "inf", 7), ("Tie", "1", 8), ("Tiny", "0.0000001", 9)
        ])
        XCTAssertEqual(breakdown.entries.count, 9)
        XCTAssertEqual(breakdown.entries.map(\.label), ["Largest", "Small", "Tie", "Tiny", "Zero",
            "Unknown", "Invalid", "Negative", "Infinite"])
        XCTAssertEqual(Set(breakdown.entries.map(\.id)).count, 9)
        XCTAssertEqual(breakdown.fraction(for: breakdown.entries[0]), 1)
        XCTAssertEqual(breakdown.fraction(for: breakdown.entries[1]), 0.25)
        XCTAssertEqual(breakdown.entries[3].amountLabel, "< $0.000001")
        XCTAssertNotNil(breakdown.entries[4].amount)
        XCTAssertNil(breakdown.entries[5].amount)
        XCTAssertEqual(breakdown.entries[5].amountLabel, "Unavailable")
        let zeros = SpendingBreakdown(rows: [("Zero", "0", 0)])
        XCTAssertEqual(zeros.fraction(for: zeros.entries[0]), 0)
        let large = SpendingBreakdown(rows: [("Large", String(Double.greatestFiniteMagnitude), 1)])
        XCTAssertEqual(large.fraction(for: large.entries[0]), 1)
    }

    func testOrganizerStatusDoesNotImplyCompletionFromUnknownOrActiveStatus() {
        XCTAssertEqual(MemoryOrganizerPanel.statusLabel("done"), "Last run completed")
        XCTAssertEqual(MemoryOrganizerPanel.statusLabel("running"), "Organizing memory")
        XCTAssertEqual(MemoryOrganizerPanel.statusLabel("failed"), "Last run failed")
        XCTAssertEqual(MemoryOrganizerPanel.statusLabel("new_status"), "Organizer update")
        XCTAssertEqual(MemoryOrganizerPanel.statusLabel(nil), "Ready to organize")
    }

    @MainActor
    func testMemoryOrganizerAndSpendingVisualStates() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let rows: [(String, String?, Int)] = [
            ("Research", "3.6", 22), ("Calendar assistance", "1.2", 14),
            ("Memory organization", "0.034", 9), ("Travel planning", "0.0025", 2),
            ("Documents", "0", 4), ("Other provider", nil, 1), ("Small request", "0.0000001", 1)
        ]
        for (name, scheme, width, size, expanded, status) in [
            ("light", ColorScheme.light, CGFloat(393), DynamicTypeSize.large, false, "done"),
            ("dark", ColorScheme.dark, CGFloat(393), DynamicTypeSize.large, false, "running"),
            ("compact", ColorScheme.light, CGFloat(320), DynamicTypeSize.large, false, "failed"),
            ("accessible", ColorScheme.light, CGFloat(393), DynamicTypeSize.accessibility3, false, "done"),
            ("expanded", ColorScheme.light, CGFloat(393), DynamicTypeSize.large, true, "done")
        ] {
            for page in ["memory", "costs"] {
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: width, height: 852)
                window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
                let content = NavigationStack {
                    ScrollView {
                        if page == "memory" {
                            MemoryOrganizerPanel(pendingCount: 17,
                                latest: WorkspaceMemoryOrganizer(id: "visual", status: status,
                                    progress: "consolidation: 17 memories reviewed in 2 batch(es) across 3 people, 5 duplicates expired, 0 contradictions resolved, 4 facts unified, owner card recompiled",
                                    updatedAt: "2026-09-06T20:00:00Z"), requestInFlight: false, organize: {}, showsDetails: expanded)
                                .padding(16)
                        } else {
                            SpendingBreakdownCard(title: "By source", rows: rows, showingAll: expanded).padding(16)
                        }
                    }
                    .navigationTitle(page == "memory" ? "Memory" : "Costs")
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
                attachment.name = "detail-\(page)-\(name)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

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
    func testForceGraphCanvasDragCancelAndSelectionPreserveViewport() throws {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        let graph = RelationshipGraphFixture.snapshot()
        view.configure(snapshot: graph, selectedID: nil, focusOnly: false, dark: false, reduceMotion: true, allowsNodeDragging: true)
        let point = view.layout.positions[0]
        let screen = view.viewport.screen(point, size: view.bounds.size)
        let viewport = view.viewport
        view.configure(snapshot: graph, selectedID: view.layout.ids[0], focusOnly: false, dark: false, reduceMotion: true, allowsNodeDragging: true)
        XCTAssertEqual(view.viewport, viewport)
        view.beginDrag(at: screen)
        view.drag(to: CGPoint(x: screen.x + 60, y: screen.y + 30))
        XCTAssertEqual(view.layout.positions[0].x, point.x + 60 / viewport.scale, accuracy: 0.001)
        XCTAssertEqual(view.viewport, viewport, "Dragging a node must not pan the canvas")
        view.endDrag(cancelled: true)
        XCTAssertEqual(view.layout.positions[0], point)
        view.beginDrag(at: CGPoint(x: -100, y: -100))
        view.drag(to: CGPoint(x: -50, y: -60))
        XCTAssertEqual(view.viewport.offset.x, viewport.offset.x + 50, accuracy: 0.001)
        view.endDrag(cancelled: true)
        XCTAssertEqual(view.viewport, viewport)
        view.zoom(to: 1.8, anchor: CGPoint(x: 70, y: 90))
        let zoomed = view.viewport
        view.endDrag(cancelled: true)
        XCTAssertEqual(view.viewport, zoomed, "Starting a pinch without a pan must preserve the current viewport")
    }

    @MainActor
    func testFocusedGraphPanSelectionRefreshAndResizeStayStable() throws {
        let view = RelationshipGraphCanvasView(frame: CGRect(x: 0, y: 0, width: 393, height: 420))
        var graph = RelationshipGraphFixture.snapshot(count: 200).focused(on: "node-4")
        view.configure(snapshot: graph, selectedID: "node-4", focusOnly: false, dark: false, reduceMotion: false, centeredID: "node-4")
        view.layoutIfNeeded()
        let positions = view.layout.positions
        let point = view.viewport.screen(positions[0], size: view.bounds.size)
        let original = view.viewport
        view.beginDrag(at: point)
        view.drag(to: CGPoint(x: point.x + 45, y: point.y + 20))
        view.endDrag(cancelled: false)
        XCTAssertEqual(view.layout.positions, positions, "Default dragging over a node pans instead of rearranging nodes")
        XCTAssertEqual(view.viewport.offset.x, original.offset.x + 45, accuracy: 0.001)
        let panned = view.viewport
        view.configure(snapshot: graph, selectedID: graph.nodes.last?.id, focusOnly: false, dark: false, reduceMotion: false, centeredID: "node-4")
        XCTAssertEqual(view.layout.positions, positions)
        XCTAssertEqual(view.viewport, panned)
        graph.edges.removeLast()
        view.configure(snapshot: graph, selectedID: graph.nodes.last?.id, focusOnly: false, dark: true, reduceMotion: false, centeredID: "node-4")
        XCTAssertEqual(view.layout.positions, positions, "Evidence refresh cannot rearrange existing items")
        XCTAssertEqual(view.viewport, panned)
        let screenBefore = view.viewport.screen(positions[0], size: view.bounds.size)
        view.frame.size.height -= 65
        view.layoutIfNeeded()
        XCTAssertEqual(view.viewport.screen(positions[0], size: view.bounds.size), screenBefore, "Wrapping controls must not shift map targets")
        view.beginDrag(at: .zero); view.drag(to: CGPoint(x: 20, y: 30)); view.endDrag(cancelled: true)
        XCTAssertEqual(view.viewport.screen(positions[0], size: view.bounds.size), screenBefore)
    }

    @MainActor
    func testForceGraphScreenLightDarkDenseAndAccessibleSnapshots() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for (name, scheme, count, size) in [
            ("light", ColorScheme.light, 18, DynamicTypeSize.large),
            ("dark", ColorScheme.dark, 18, DynamicTypeSize.large),
            ("selected", ColorScheme.light, 18, DynamicTypeSize.large),
            ("islands", ColorScheme.light, 18, DynamicTypeSize.large),
            ("dense", ColorScheme.dark, 200, DynamicTypeSize.large),
            ("dense-selected", ColorScheme.dark, 200, DynamicTypeSize.large),
            ("accessible", ColorScheme.light, 18, DynamicTypeSize.accessibility3),
            ("accessible-selected", ColorScheme.light, 18, DynamicTypeSize.accessibility3),
            ("empty", ColorScheme.light, 0, DynamicTypeSize.large)
        ] {
            let fixture = RelationshipGraphFixture.snapshot(count: count)
            let snapshot = RelationshipGraphSnapshot(nodes: fixture.nodes, edges: name == "islands" ? Array(fixture.edges.prefix(4)) : fixture.edges, totalEdges: fixture.totalEdges, truncated: name == "islands", focusId: name == "dense-selected" ? "node-4" : name.contains("selected") ? "node-0" : nil)
            StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(snapshot))])
            let model = AppModel(apiClient: makeClient())
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
            window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
            window.rootViewController = UIHostingController(rootView:
                NavigationStack { RelationshipGraphScreen() }.environmentObject(model)
                    .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size))
            window.isHidden = false
            defer { window.isHidden = true; window.rootViewController = nil }
            try await Task.sleep(for: .milliseconds(500))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "force-graph-\(name)"; attachment.lifetime = .keepAlways; add(attachment)
            XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
        }
    }

    @MainActor
    func testGraphManagementScreensInBothAppearances() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let fixture = RelationshipGraphFixture.snapshot()
        let graph = RelationshipGraphSnapshot(nodes: fixture.nodes, edges: Array(fixture.edges.prefix(4)), totalEdges: 20, truncated: true, focusId: nil)
        let source = try XCTUnwrap(graph.nodes.first)
        for scheme in [ColorScheme.light, .dark] {
            let model = AppModel(apiClient: makeClient())
            for (name, content) in [
                ("groups", AnyView(GraphGroupsSheet(graph: graph, focus: { _ in }, saved: { _ in }))),
                ("connect", AnyView(GraphConnectSheet(source: source, graph: graph, saved: {}))),
                ("editor", AnyView(KnowledgeConnectionEditor(selected: source.entity, initialObject: graph.nodes[1].entity, candidates: [], didSave: {})))
            ] {
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
                window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
                window.rootViewController = UIHostingController(rootView: NavigationStack { content }.environmentObject(model).environment(\.colorScheme, scheme))
                window.isHidden = false
                defer { window.isHidden = true; window.rootViewController = nil }
                try await Task.sleep(for: .milliseconds(350))
                window.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
                let attachment = XCTAttachment(image: image); attachment.name = "graph-management-\(name)-\(scheme)"; attachment.lifetime = .keepAlways; add(attachment)
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
    func testPersonTreeAndBirthdayEditorSnapshots() async throws {
        let card = PeopleMapFixture.card(relations: PeopleMapFixture.relations)
        StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(card))])
        let model = AppModel(apiClient: makeClient())
        await model.loadPersonCard(id: card.id)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for scheme in [ColorScheme.light, .dark] {
            for editor in [false, true] {
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
                window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
                window.rootViewController = UIHostingController(rootView:
                    NavigationStack {
                        if editor {
                            OccasionEditor(personId: card.id, occasion: PersonOccasion(id: "date", kind: "birthday", label: "", month: 3, day: 18, year: 1985, notes: "Gift ideas", quarantined: false, leadDays: 14))
                        } else {
                            ScrollView { PersonConnectionOutline(personId: card.id, ancestors: [card.id]).padding(16) }.navigationTitle("Connections")
                        }
                    }.environmentObject(model).environment(\.colorScheme, scheme))
                window.isHidden = false
                defer { window.isHidden = true; window.rootViewController = nil }
                try await Task.sleep(for: .milliseconds(350))
                window.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let attachment = XCTAttachment(image: image)
                attachment.name = "person-\(editor ? "birthday" : "tree")-\(scheme)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
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

    func testBirthdayEditUsesPatchAndRejectsFailedSave() async throws {
        let mutation = OccasionMutation(kind: "birthday", label: "", month: "2", day: "29", year: "", leadDays: "3", notes: "")
        StubURLProtocol.prime([.success(status: 200, body: Data(#"{"ok":true}"#.utf8))])
        try await makeClient().updateOccasion(id: "birthday", occasion: mutation)
        XCTAssertEqual(StubURLProtocol.attempts, ["PATCH"])
        StubURLProtocol.prime([.success(status: 400, body: Data(#"{"error":"That date does not exist."}"#.utf8))])
        do {
            try await makeClient().updateOccasion(id: "birthday", occasion: mutation)
            XCTFail("A rejected edit must not report success")
        } catch { XCTAssertEqual(StubURLProtocol.attempts, ["PATCH"]) }
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

    func testCancellationIsControlFlowIncludingFoundationWrappers() {
        let cancellations: [Error] = [
            CancellationError(), URLError(.cancelled), APIError.transport(URLError(.cancelled)),
            NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError),
            NSError(domain: "wrapper", code: 1, userInfo: [NSUnderlyingErrorKey: URLError(.cancelled)])
        ]
        for error in cancellations {
            XCTAssertTrue(isRequestCancellation(error))
        }
        XCTAssertFalse(isRequestCancellation(URLError(.timedOut)))
        XCTAssertFalse(isRequestCancellation(APIError.server(status: 409, message: "Action cancelled by server policy")))
    }

    @MainActor
    func testCancelledRefreshesNeverCreateOrReplaceAnError() async {
        let model = AppModel(apiClient: makeClient())
        for hasExistingError in [false, true] {
            if hasExistingError {
                model.reportError(APIError.transport(URLError(.notConnectedToInternet)), retry: {})
            }
            let original = model.errorMessage
            let notice = model.errorNotice
            for read in 0..<4 {
                StubURLProtocol.prime([.failure(URLError(.cancelled))])
                switch read {
                case 0: await model.refreshAll()
                case 1: await model.refreshOverview()
                case 2: await model.refreshWorkspace()
                default: _ = await model.knowledge()
                }
                XCTAssertEqual(StubURLProtocol.attempts, ["GET"], "Cancellation must not trigger a transport retry")
                XCTAssertEqual(model.errorMessage, original)
                XCTAssertEqual(model.errorNotice, notice)
                XCTAssertEqual(model.errorRetry != nil, hasExistingError)
            }
        }
    }

    @MainActor
    func testCancelledConnectionDoesNotOpenPairingOrOfferRetry() async {
        StubURLProtocol.prime([.failure(URLError(.cancelled))])
        let model = AppModel(apiClient: makeClient())
        await model.connect()
        XCTAssertFalse(model.showingConnection)
        XCTAssertFalse(model.isLoading)
        XCTAssertNil(model.errorMessage)
        XCTAssertNil(model.errorNotice)
        XCTAssertNil(model.errorRetry)
    }

    @MainActor
    func testCancelledTaskCannotPublishAnUnrelatedTransportError() async {
        let model = AppModel(apiClient: makeClient())
        let request = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            model.reportError(APIError.transport(URLError(.networkConnectionLost)), retry: {})
        }
        await request.value
        XCTAssertNil(model.errorMessage)
        XCTAssertNil(model.errorRetry)
    }

    @MainActor
    func testAutomaticRefreshFailuresAreQuietButExplicitRefreshRemainsActionable() async {
        let model = AppModel(apiClient: makeClient())
        for read in 0..<3 {
            StubURLProtocol.prime([.failure(URLError(.notConnectedToInternet))])
            switch read {
            case 0: await model.refreshAll(reportFailure: false)
            case 1: await model.refreshOverview(reportFailure: false)
            default: await model.refreshWorkspace(reportFailure: false)
            }
            XCTAssertNil(model.errorNotice)
            XCTAssertNil(model.errorRetry)
        }
        StubURLProtocol.prime([.failure(URLError(.notConnectedToInternet))])
        await model.refreshOverview()
        XCTAssertEqual(model.errorNotice?.title, "You’re offline")
        XCTAssertNotNil(model.errorRetry)
        model.dismissError()
        XCTAssertNil(model.errorMessage)
        XCTAssertNil(model.errorNotice)
        XCTAssertNil(model.errorRetry)
    }

    @MainActor
    func testRecoveredReadClearsOnlyItsOwnNotice() async throws {
        let model = AppModel(apiClient: makeClient())
        let overview = OverviewResponse(generatedAt: "2026-09-07",
            activity: ActivityList(items: [], archivedCount: 0),
            goals: GoalsDashboard(items: [], archivedCount: 0),
            approvals: ApprovalInbox(pending: [], resolved: []),
            documents: DocumentsOverview(documents: [], stats: DocumentStats(total: 0, ready: 0, pending: 0, chunks: 0),
                primaryConversationId: "test"))
        let body = try JSONEncoder().encode(overview)
        StubURLProtocol.prime([.failure(URLError(.notConnectedToInternet))])
        await model.refreshOverview()
        XCTAssertNotNil(model.errorNotice)
        StubURLProtocol.prime([.success(status: 200, body: body)])
        await model.refreshOverview(reportFailure: false)
        XCTAssertNil(model.errorNotice)
        model.reportError(APIError.server(status: 400, message: "Your edit could not be saved."))
        StubURLProtocol.prime([.success(status: 200, body: body)])
        await model.refreshOverview(reportFailure: false)
        XCTAssertEqual(model.errorMessage, "Your edit could not be saved.")
    }

    @MainActor
    func testActualFailuresKeepUsefulCopyAndNeverInheritAnUnsafeRetry() {
        let model = AppModel(apiClient: makeClient())
        model.reportError(APIError.transport(URLError(.timedOut)), retry: {})
        XCTAssertNotNil(model.errorRetry)
        XCTAssertEqual(model.errorNotice?.title, "Connection interrupted")
        model.reportError(APIError.server(status: 400, message: "Choose a valid date."), retry: {})
        XCTAssertNil(model.errorRetry)
        XCTAssertEqual(model.errorNotice?.message, "Choose a valid date.")
        model.reportError(APIError.decoding(model: "InternalModel", detail: "raw implementation detail"))
        XCTAssertFalse(model.errorNotice?.message.contains("InternalModel") ?? true)
        XCTAssertTrue(model.errorNotice?.message.contains("app update") ?? false)
        model.errorMessage = "Your draft is preserved."
        XCTAssertEqual(model.errorNotice?.message, "Your draft is preserved.")
    }

    @MainActor
    func testErrorBannerVisualStates() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for (name, scheme, width, size, retryable) in [
            ("light", ColorScheme.light, CGFloat(393), DynamicTypeSize.large, true),
            ("dark", ColorScheme.dark, CGFloat(393), DynamicTypeSize.large, true),
            ("compact", ColorScheme.light, CGFloat(320), DynamicTypeSize.large, true),
            ("accessible", ColorScheme.light, CGFloat(393), DynamicTypeSize.accessibility3, true),
            ("validation", ColorScheme.light, CGFloat(393), DynamicTypeSize.large, false)
        ] {
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: width, height: 600)
            window.overrideUserInterfaceStyle = scheme == .light ? .light : .dark
            let content = VStack {
                AssistantErrorBanner(
                    notice: retryable
                        ? AssistantErrorNotice(error: APIError.transport(URLError(.notConnectedToInternet)))
                        : AssistantErrorNotice(message: "Choose a valid date before saving this occasion."),
                    retry: retryable ? {} : nil,
                    dismiss: {}
                )
                .padding(12)
                Spacer()
            }
            .background(AssistantTheme.canvas(for: scheme))
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size)
            window.rootViewController = UIHostingController(rootView: content)
            window.isHidden = false
            defer { window.isHidden = true; window.rootViewController = nil }
            try await Task.sleep(for: .milliseconds(250))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "error-banner-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    @MainActor
    func testChatFollowsNewMessagesAndGrowingStreamWhileAtBottom() async throws {
        let model = AppModel(apiClient: makeClient())
        var messages = (0..<16).map { index in
            ChatMessage(id: "follow-\(index)", role: .assistant,
                parts: [.init(type: "text", text: "Earlier message \(index).\nKeep the latest response above the input.")])
        }
        func loadMessages() async throws {
            let conversation = ConversationView(
                conversation: .init(id: "follow-chat", title: "Follow test", modelOverride: nil,
                    archivedAt: nil, isPrimary: true),
                agentName: "Assistant", agentTimezone: "UTC", messages: messages,
                models: [], goalTitle: nil, canArchive: false, cursor: nil, asyncTurn: nil)
            StubURLProtocol.prime([.success(status: 200, body: try JSONEncoder().encode(conversation))])
            let opened = await model.openConversation(id: "follow-chat")
            XCTAssertTrue(opened)
        }
        try await loadMessages()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previousKeyWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = UIHostingController(rootView:
            ChatView(safeAreaTopInset: 62, safeAreaBottomInset: 34,
                safeAreaLeadingInset: 0, safeAreaTrailingInset: 0)
                .environmentObject(model))
        window.makeKeyAndVisible()
        defer {
            model.cancelSend()
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKey()
        }
        try await Task.sleep(for: .milliseconds(400))
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let scroll = try XCTUnwrap(descendants(window).compactMap { $0 as? UIScrollView }
            .first { !($0 is UITextView) })
        func assertAtBottom(file: StaticString = #filePath, line: UInt = #line) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            var settled = 0
            repeat {
                try await Task.sleep(for: .milliseconds(100))
                window.layoutIfNeeded()
                let error = abs(scroll.contentOffset.y + scroll.bounds.height
                    - scroll.contentSize.height - scroll.adjustedContentInset.bottom)
                settled = error <= 2 ? settled + 1 : 0
            } while settled < 3 && ContinuousClock.now < deadline
            XCTAssertEqual(scroll.contentOffset.y + scroll.bounds.height,
                scroll.contentSize.height + scroll.adjustedContentInset.bottom, accuracy: 2,
                "Incoming content must keep the newest edge visible", file: file, line: line)
        }
        try await assertAtBottom()
        messages.append(ChatMessage(id: "incoming", role: .assistant,
            parts: [.init(type: "text", text: String(repeating: "A newly arrived response.\n", count: 40))]))
        try await loadMessages()
        try await assertAtBottom()

        func chunk(_ text: String) throws -> Data {
            let json = try JSONSerialization.data(withJSONObject: ["type": "text-delta", "delta": text])
            return Data("data: \(String(decoding: json, as: UTF8.self))\n\n".utf8)
        }
        StubURLProtocol.prime([.stream(body: try chunk("First words.\n"))])
        model.send("Continue with a detailed response.")
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while model.messages.last?.text != "First words.\n", ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(model.messages.last?.text, "First words.\n")
        let streamID = model.messages.last?.id
        try await assertAtBottom()
        for index in 1...3 {
            let delta = String(repeating: "Streaming section \(index).\n", count: 35)
            let previousText = model.messages.last?.text ?? ""
            StubURLProtocol.appendStream(try chunk(delta))
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertEqual(model.messages.last?.text, previousText + delta)
            XCTAssertEqual(model.messages.last?.id, streamID)
            XCTAssertTrue(model.isSending)
            try await assertAtBottom()
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
