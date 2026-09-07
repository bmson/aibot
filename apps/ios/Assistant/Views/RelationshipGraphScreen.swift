import SwiftUI

/// The graph is a full-screen destination, so its pan never competes with a transcript or list.
struct RelationshipGraphScreen: View {
    var personID: String? = nil
    var entityID: String? = nil
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var graph = RelationshipGraphSnapshot.empty
    @State private var selectedID: String?
    @State private var loading = false
    @State private var hasLoaded = false
    @State private var failure: String?
    @State private var requestID = UUID()
    @State private var command = GraphCanvasCommand()
    @State private var listView = false
    @State private var peopleOnly = false
    @State private var focusOnly = false
    @State private var showBrowser = false
    @State private var showConnections = false
    @State private var search = ""
    @State private var searchResults: [KnowledgeEntity] = []
    @State private var searching = false
    @State private var searchFailed = false

    private var selected: RelationshipGraphNode? { graph.nodes.first { $0.id == selectedID } }
    private var visible: RelationshipGraphSnapshot {
        guard peopleOnly else { return graph }
        let nodes = graph.nodes.filter { $0.kind == "person" }
        let ids = Set(nodes.map(\.id))
        return .init(nodes: nodes, edges: graph.edges.filter { ids.contains($0.subjectId) && ids.contains($0.objectId) }, totalEdges: graph.totalEdges, truncated: graph.truncated, focusId: graph.focusId)
    }
    private var listedNodes: [RelationshipGraphNode] {
        let neighborhood = selectedID.map { graph.neighborhood(of: $0) }
        return visible.nodes.filter { !focusOnly || neighborhood?.contains($0.id) != false }
            .sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
    }
    private var currentEdges: [RelationshipGraphEdge] {
        guard let selectedID else { return [] }
        return graph.edges.filter { $0.subjectId == selectedID || $0.objectId == selectedID }
    }

    var body: some View {
        Group {
            if listView { readableList }
            else { canvas.safeAreaInset(edge: .bottom, spacing: 0) { bottomControls } }
        }
        .onAppear { listView = dynamicTypeSize.isAccessibilitySize }
        .onChange(of: dynamicTypeSize) { _, size in listView = size.isAccessibilitySize }
        .navigationTitle("Relationship graph")
        .navigationBarTitleDisplayMode(.inline)
        .tint(AssistantTheme.accent(for: colorScheme))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Find an item", systemImage: "magnifyingglass") { showBrowser = true }
                    .accessibilityIdentifier("assistant.relationship.search")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Toggle("List view", isOn: $listView)
                    Toggle("People only", isOn: $peopleOnly)
                    Toggle("Selected neighborhood", isOn: $focusOnly).disabled(selected == nil)
                    Button("Reload graph", systemImage: "arrow.clockwise") { Task { await load() } }
                    Button("All knowledge", systemImage: "circle.hexagongrid") { Task { await load(all: true) } }
                } label: { Label("Graph options", systemImage: "slider.horizontal.3") }
            }
        }
        .onChange(of: peopleOnly) { _, value in
            if value, selected?.kind != "person" { selectedID = nil; focusOnly = false }
            send(.fit)
        }
        .onChange(of: focusOnly) { _, _ in send(.fit) }
        .task { if !hasLoaded { await load() } }
        .sheet(isPresented: $showBrowser) { itemBrowser }
        .sheet(isPresented: $showConnections) {
            if let selected {
                NavigationStack {
                    GraphConnectionsSheet(node: selected, edges: currentEdges, explore: { nodeID in
                        selectedID = nodeID; showConnections = false
                    }, removed: { id in
                        graph.edges.removeAll { $0.id == id }
                        if let personID { Task { await model.refreshPersonEvidence(id: personID) } }
                    }, refresh: { await expand(selected.id) })
                }
            }
        }
    }

    private var canvas: some View {
        ZStack(alignment: .topLeading) {
            AssistantTheme.canvas(for: colorScheme).ignoresSafeArea()
            RelationshipGraphCanvas(snapshot: visible, selectedID: selectedID, focusOnly: focusOnly, command: command) { id in
                selectedID = id
                if id == nil { focusOnly = false }
            }
            .accessibilityIdentifier("assistant.relationship.graph")
            if hasLoaded && visible.nodes.isEmpty {
                ContentUnavailableView("No connections to show", systemImage: "point.3.connected.trianglepath.dotted", description: Text(peopleOnly ? "Try showing all items. People may connect through shared places or projects." : "Relationships appear here when they’re recorded in your knowledge graph."))
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("\(visible.nodes.count) items · \(visible.links.count) connections")
                    .font(.caption.weight(.medium))
                Text("Drag a node or the canvas. Pinch to zoom.")
                    .font(.caption2).foregroundStyle(.secondary)
                if graph.truncated {
                    Text("Partial graph · search or expand an item to see more")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            .padding(12)
            .allowsHitTesting(false)
            if loading {
                ProgressView(hasLoaded ? "Loading connections…" : "Opening graph…")
                    .padding(14).background(.regularMaterial, in: Capsule())
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                    .allowsHitTesting(false)
            }
        }
    }

    private var readableList: some View {
        List {
            Section {
                Text("\(visible.nodes.count) items · \(visible.links.count) connections")
                if loading { ProgressView("Loading connections…") }
                if graph.truncated { Text("Partial graph. Search or expand an item to see more.").foregroundStyle(.secondary) }
            }
            if selected != nil || failure != nil { Section { bottomControls } }
            Section("Select an item") {
                ForEach(listedNodes) { node in
                    Button { selectedID = node.id } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(node.label).foregroundStyle(.primary)
                            Text("\(node.kind.sentenceCaseIdentifier) · \(graph.neighborhood(of: node.id).count - 1) connections").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityAddTraits(node.id == selectedID ? .isSelected : [])
                }
                if hasLoaded && visible.nodes.isEmpty { Text("No connections to show.").foregroundStyle(.secondary) }
            }
        }
    }

    private var bottomControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let failure {
                HStack {
                    Text(failure).font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    Button("Retry") { Task { if let selectedID, hasLoaded { await expand(selectedID) } else { await load() } } }
                }
            }
            if let selected {
                HStack(alignment: .center, spacing: 12) {
                    Circle().fill(AssistantTheme.accent(for: colorScheme)).frame(width: 9, height: 9)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(selected.label).font(.headline).lineLimit(2)
                        Text("\(selected.kind.sentenceCaseIdentifier) · \(graph.neighborhood(of: selected.id).count - 1) connected items")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Button("Deselect", systemImage: "xmark") { selectedID = nil; focusOnly = false }
                        .labelStyle(.iconOnly).frame(width: 44, height: 44)
                }
                Group {
                    if dynamicTypeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: 12) { selectedActions(selected) }
                    } else {
                        HStack(spacing: 8) { selectedActions(selected) }
                    }
                }
                .font(.subheadline).buttonStyle(.bordered).fixedSize(horizontal: false, vertical: true)
            }
            if !listView {
                HStack(spacing: 8) {
                    Label("People", systemImage: "circle.fill").foregroundStyle(AssistantTheme.accent(for: colorScheme))
                    Label("Other items", systemImage: "circle.fill").foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button("Zoom out", systemImage: "minus") { send(.zoomOut) }.labelStyle(.iconOnly).frame(width: 44, height: 44)
                    Button("Fit graph", systemImage: "arrow.up.left.and.arrow.down.right") { send(.fit) }.labelStyle(.iconOnly).frame(width: 44, height: 44)
                    Button("Zoom in", systemImage: "plus") { send(.zoomIn) }.labelStyle(.iconOnly).frame(width: 44, height: 44)
                }
                .font(.caption).lineLimit(1).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                Text("Dashed lines include unreviewed claims. Select Connections for direction and sources.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, listView ? 0 : 16).padding(.vertical, 12)
        .background(.regularMaterial)
    }

    @ViewBuilder private func selectedActions(_ selected: RelationshipGraphNode) -> some View {
        Button("Expand", systemImage: "arrow.up.left.and.arrow.down.right") { Task { await expand(selected.id) } }
            .disabled(loading)
        Button("Connections", systemImage: "line.3.horizontal") { showConnections = true }
        if let contactID = selected.contactId {
            NavigationLink { PersonCardScreen(personId: contactID) } label: { Image(systemName: "person.text.rectangle") }
                .accessibilityLabel("Open \(selected.label)'s profile")
        }
    }

    private var itemBrowser: some View {
        NavigationStack {
            List {
                Section(search.isEmpty ? "On this graph" : "Matching items") {
                    if searching { ProgressView("Searching…") }
                    if searchFailed { Text("Search couldn’t load. Try again.").foregroundStyle(.secondary) }
                    if search.isEmpty {
                        ForEach(graph.nodes.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }) { node in
                            Button(node.label) { selectedID = node.id; peopleOnly = false; showBrowser = false; send(.fit) }
                        }
                    } else {
                        ForEach(searchResults) { item in
                            Button { showBrowser = false; peopleOnly = false; Task { await expand(item.id, selectAfter: true) } } label: {
                                VStack(alignment: .leading) { Text(item.displayLabel); Text(item.kind.sentenceCaseIdentifier).font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                        if !searching && !searchFailed && searchResults.isEmpty { Text("No matching items.").foregroundStyle(.secondary) }
                    }
                }
            }
            .navigationTitle("Find an item")
            .searchable(text: $search, prompt: "Person, place, project…")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showBrowser = false } } }
            .task(id: search) {
                let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
                searchResults = []; searchFailed = false; searching = false
                guard !query.isEmpty else { return }
                searching = true
                do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
                let result = await model.knowledge(query: query)
                guard !Task.isCancelled, query == search.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
                searchResults = result?.entities ?? []; searching = false; searchFailed = result == nil
            }
        }
    }

    private func send(_ action: GraphCanvasCommand.Action) { command = .init(id: command.id + 1, action: action) }
    private func load(all: Bool = false) async {
        let token = UUID(); requestID = token; loading = true; failure = nil
        let result = await model.relationshipGraph(personID: all ? nil : personID, entityID: all ? nil : entityID)
        guard requestID == token, !Task.isCancelled else { return }
        loading = false
        guard let result else { failure = "Couldn’t load the graph. Check your connection and server version."; return }
        graph = result; hasLoaded = true; selectedID = result.focusId; focusOnly = false
        send(.fit)
    }
    private func expand(_ id: String, selectAfter: Bool = false) async {
        let token = UUID(); requestID = token; loading = true; failure = nil
        let result = await model.relationshipGraph(entityID: id)
        guard requestID == token, !Task.isCancelled else { return }
        loading = false
        guard let result else { failure = "Couldn’t load those connections."; return }
        let newCount = Set((graph.nodes + result.nodes).map(\.id)).count
        if selectAfter && newCount > 200 { graph = result }
        else { graph = graph.merging(result, around: id) }
        if selectAfter { selectedID = id; send(.fit) }
    }
}

private struct GraphConnectionsSheet: View {
    let node: RelationshipGraphNode
    let edges: [RelationshipGraphEdge]
    let explore: (String) -> Void
    let removed: (String) -> Void
    let refresh: () async -> Void
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var removing: RelationshipGraphEdge?
    @State private var working = false
    @State private var failure: String?
    @State private var correcting: KnowledgeRelation?

    var body: some View {
        List {
            if edges.isEmpty { Text("No active connections recorded.").foregroundStyle(.secondary) }
            ForEach(edges) { edge in
                Section {
                    Text(edge.presentation.sentence).font(.subheadline.weight(.medium))
                    if edge.validFrom != nil || edge.validUntil != nil {
                        Text("\(edge.validFrom ?? "Unknown start") to \(edge.validUntil ?? "present")").font(.caption).foregroundStyle(.secondary)
                    }
                    if edge.reviewStatus != "confirmed" { Text("Needs review").font(.caption).foregroundStyle(.secondary) }
                    DisclosureGroup("Source note") { Text(edge.sourceContent).font(.subheadline).textSelection(.enabled) }
                    Button("Explore connected item") { explore(edge.subjectId == node.id ? edge.objectId : edge.subjectId) }
                    HStack {
                        Button("Edit") { Task { correcting = await model.knowledgeRelation(id: edge.id); if correcting == nil { failure = "Couldn’t load this connection." } } }
                        Spacer()
                        Button("Remove", role: .destructive) { removing = edge }
                    }.disabled(working)
                }
            }
            if let failure { Text(failure).foregroundStyle(.red) }
        }
        .navigationTitle(node.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .sheet(item: $correcting) { relation in
            NavigationStack {
                KnowledgeConnectionEditor(selected: relation.subject, relationToCorrect: relation, candidates: [relation.subject, relation.object]) { await refresh() }
            }
        }
        .confirmationDialog("Remove this relationship claim?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            if let edge = removing {
                Button("Remove connection", role: .destructive) {
                    Task { working = true; failure = nil
                        if await model.removeKnowledgeRelation(id: edge.id) { removed(edge.id) }
                        else { failure = "Couldn’t remove this connection. Try again." }
                        working = false
                    }
                }
            }
        } message: { Text("The original note and other supporting claims stay saved.") }
    }
}
