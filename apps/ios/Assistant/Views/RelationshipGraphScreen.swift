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
    @State private var showGroups = false
    @State private var connecting: RelationshipGraphNode?
    @State private var focusedGroupID: String?
    @State private var notice: String?
    @State private var showBrowser = false
    @State private var showConnections = false
    @State private var search = ""
    @State private var searchResults: [KnowledgeEntity] = []
    @State private var searching = false
    @State private var searchFailed = false

    private var selected: RelationshipGraphNode? { graph.nodes.first { $0.id == selectedID } }
    private var visible: RelationshipGraphSnapshot {
        var result = graph
        if let id = focusedGroupID, let group = graph.groups.first(where: { $0.ids.contains(id) }) { result = graph.showing(group.ids) }
        if peopleOnly { result = result.showing(Set(result.nodes.filter { $0.kind == "person" }.map(\.id))) }
        return result
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
            else { canvas.safeAreaInset(edge: .top, spacing: 0) { graphSummary }.safeAreaInset(edge: .bottom, spacing: 0) { bottomControls } }
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
                    Button("Connect loose groups", systemImage: "point.3.connected.trianglepath.dotted") { showGroups = true }
                    Button("Tidy layout", systemImage: "square.grid.2x2") { send(.tidy) }
                    if focusedGroupID != nil { Button("Show all groups") { focusedGroupID = nil; send(.fit) } }
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
        .sheet(item: $connecting) { node in
            NavigationStack {
                GraphConnectSheet(source: node, graph: graph) { await connectionSaved(around: node.id); connecting = nil }
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { connecting = nil } } }
            }
        }
        .sheet(isPresented: $showGroups) {
            NavigationStack {
                GraphGroupsSheet(graph: graph, focus: { node in
                    focusedGroupID = node.id; selectedID = node.id; focusOnly = false; peopleOnly = false
                    showGroups = false; send(.fit)
                }, saved: { id in await connectionSaved(around: id); showGroups = false })
            }
        }
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
            if loading {
                ProgressView(hasLoaded ? "Loading connections…" : "Opening graph…")
                    .padding(14).background(.regularMaterial, in: Capsule())
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                    .allowsHitTesting(false)
            }
        }
    }

    private var graphSummary: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button { showGroups = true } label: {
                    HStack(spacing: 5) {
                        Text("\(visible.groups.count) \(visible.groups.count == 1 ? "group" : "groups")").fontWeight(.semibold)
                        Image(systemName: "chevron.right").font(.caption2)
                    }
                }.accessibilityLabel("Browse groups and connect loose items")
                Spacer()
                Text("\(visible.nodes.count) items · \(visible.links.count) connections").foregroundStyle(.secondary)
            }.font(.caption)
            if graph.truncated { Text("Partial view · expand or search to see more").font(.caption2).foregroundStyle(.secondary) }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(AssistantTheme.canvas(for: colorScheme))
    }

    private var readableList: some View {
        ScrollViewReader { proxy in
        List {
            Section {
                Button("Browse groups and connect loose items") { showGroups = true }.id("graph-summary")
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
        .onChange(of: selectedID) { _, _ in proxy.scrollTo("graph-summary", anchor: .top) }
        }
    }

    private var bottomControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let notice { Text(notice).font(.caption).foregroundStyle(.secondary).accessibilityAddTraits(.updatesFrequently) }
            if focusedGroupID != nil {
                Button("Show all groups", systemImage: "arrow.uturn.backward") { focusedGroupID = nil; send(.fit) }.font(.caption)
            }
            if peopleOnly { Text("Places and projects are hidden. Show all items to see connections through them.").font(.caption).foregroundStyle(.secondary) }
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
                        Text(graph.neighborhood(of: selected.id).count == 1 ? "No connections loaded · add one or expand" : "\(selected.kind.sentenceCaseIdentifier) · \(graph.neighborhood(of: selected.id).count - 1) connected items")
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
                Text("Drag to move · pinch to zoom. Dashed lines need review.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, listView ? 0 : 16).padding(.vertical, 12)
        .background(.regularMaterial)
    }

    @ViewBuilder private func selectedActions(_ selected: RelationshipGraphNode) -> some View {
        Button("Connect", systemImage: "plus") { connecting = selected }
            .accessibilityIdentifier("assistant.relationship.connect")
        Button("Expand", systemImage: "arrow.up.left.and.arrow.down.right") { Task { await expand(selected.id) } }
            .disabled(loading)
        Button("Details") { showConnections = true }
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
                            Button(node.label) { selectedID = node.id; peopleOnly = false; focusedGroupID = nil; showBrowser = false; send(.fit) }
                        }
                    } else {
                        ForEach(searchResults) { item in
                            Button { showBrowser = false; peopleOnly = false; focusedGroupID = nil; Task { await expand(item.id, selectAfter: true) } } label: {
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

    private func connectionSaved(around id: String) async {
        focusedGroupID = nil; peopleOnly = false; focusOnly = false
        await expand(id, selectAfter: true)
        notice = "Connection saved"
        if let personID { await model.refreshPersonEvidence(id: personID) }
    }

    private func send(_ action: GraphCanvasCommand.Action) { command = .init(id: command.id + 1, action: action) }
    private func load(all: Bool = false) async {
        let token = UUID(); requestID = token; loading = true; failure = nil
        let result = await model.relationshipGraph(personID: all ? nil : personID, entityID: all ? nil : entityID)
        guard requestID == token, !Task.isCancelled else { return }
        loading = false
        guard let result else { failure = "Couldn’t load the graph. Check your connection and server version."; return }
        graph = result; hasLoaded = true; selectedID = result.focusId; focusOnly = false; focusedGroupID = nil; notice = nil
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

/// Help the owner join disconnected knowledge without presenting guesses as facts.
struct GraphGroupsSheet: View {
    @Environment(\.colorScheme) private var colorScheme
    let graph: RelationshipGraphSnapshot
    let focus: (RelationshipGraphNode) -> Void
    let saved: (String) async -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section {
                Text("Connect loose groups").font(.title2.weight(.semibold))
                Text("These groups are separate in the loaded graph. Start with a small group, explore its items, and add any relationship you know is missing.")
                    .font(.subheadline).foregroundStyle(.secondary)
                if graph.truncated { Label("This is a partial view. Expand an item to check for more recorded connections first.", systemImage: "info.circle").font(.footnote) }
            }
            if !graph.groups.filter({ $0.nodes.count == 1 }).isEmpty {
                Section("Items without a visible connection") {
                    ForEach(graph.groups.filter { $0.nodes.count == 1 }.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }) { group in
                        if let node = group.nodes.first {
                            NavigationLink { GraphConnectSheet(source: node, graph: graph) { await saved(node.id) } } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(node.label)
                                    Text(node.kind.sentenceCaseIdentifier).font(.caption).foregroundStyle(.secondary)
                                }
                            }.accessibilityLabel("Connect \(node.label)")
                        }
                    }
                }
            }
            ForEach(graph.groups.filter { $0.nodes.count > 1 }.sorted { $0.nodes.count == $1.nodes.count ? $0.label.localizedStandardCompare($1.label) == .orderedAscending : $0.nodes.count < $1.nodes.count }) { group in
                Section {
                    if let anchor = group.nodes.first {
                        Button { focus(anchor) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(group.nodes.count == 1 ? group.label : "Around \(group.label)").font(.headline)
                                    Text("\(group.nodes.count) items · \(group.connectionCount) connections in this view")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "scope")
                            }
                        }.buttonStyle(.plain).accessibilityHint("Focus this group on the graph")
                    }
                    if group.nodes.count <= 4 {
                        ForEach(group.nodes) { node in connectLink(node) }
                    } else {
                        DisclosureGroup("Choose an item to connect") { ForEach(group.nodes) { node in connectLink(node) } }
                    }
                }
            }
            if graph.nodes.isEmpty { Text("Search the graph for a person, place, or project to start connecting it.").foregroundStyle(.secondary) }
        }
        .scrollContentBackground(.hidden)
        .background(AssistantTheme.canvas(for: colorScheme))
        .tint(AssistantTheme.accent(for: colorScheme))
        .navigationTitle("Groups")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }

    private func connectLink(_ node: RelationshipGraphNode) -> some View {
        NavigationLink {
            GraphConnectSheet(source: node, graph: graph) { await saved(node.id) }
        } label: { Label("Connect \(node.label)", systemImage: "plus") }
    }
}

struct GraphConnectSheet: View {
    @Environment(\.colorScheme) private var colorScheme
    let source: RelationshipGraphNode
    let graph: RelationshipGraphSnapshot
    let saved: () async -> Void
    @EnvironmentObject private var model: AppModel
    @State private var search = ""
    @State private var results: [KnowledgeEntity] = []
    @State private var searching = false
    @State private var searchFailed = false
    @State private var target: KnowledgeEntity?
    private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        List {
            Section {
                Text("How does \(source.label) connect?").font(.title2.weight(.semibold))
                Text("Choose an item you know is connected, then describe how. Shared connections can help you find the right item.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if query.isEmpty {
                Section("Items to consider") {
                    ForEach(graph.connectionCandidates(for: source.id).prefix(20), id: \.node.id) { candidate in
                        Button { target = candidate.node.entity } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(candidate.node.label)
                                Text(candidate.reason).font(.caption).foregroundStyle(.secondary)
                            }
                        }.buttonStyle(.plain)
                    }
                    if graph.connectionCandidates(for: source.id).isEmpty {
                        Text("Search for another person, place, or project.").foregroundStyle(.secondary)
                    }
                }
                Section("Already connected") {
                    ForEach(graph.nodes.filter { $0.id != source.id && graph.neighborhood(of: source.id).contains($0.id) }) { node in
                        Button(node.label) { target = node.entity }
                    }
                }
            } else {
                Section("Matching items") {
                    if searching { ProgressView("Searching…") }
                    if searchFailed { Text("Search couldn’t load. Change the search to try again.").foregroundStyle(.secondary) }
                    ForEach(results.filter { $0.id != source.id }) { item in
                        Button { target = item } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.displayLabel)
                                Text(item.kind.sentenceCaseIdentifier).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if !searching && !searchFailed && results.filter({ $0.id != source.id }).isEmpty { Text("No matching items.").foregroundStyle(.secondary) }
                }
            }
            Section {
                NavigationLink("Connect a new item…") {
                    KnowledgeConnectionEditor(selected: source.entity, candidates: [], didSave: saved)
                }
            } footer: { Text("Search first to reuse an existing item and avoid duplicate nodes.") }
        }
        .scrollContentBackground(.hidden)
        .background(AssistantTheme.canvas(for: colorScheme))
        .tint(AssistantTheme.accent(for: colorScheme))
        .navigationTitle("Add connection")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Find a person, place, project…")
        .navigationDestination(item: $target) { item in
            KnowledgeConnectionEditor(selected: source.entity, initialObject: item, candidates: [], didSave: saved)
        }
        .task(id: query) {
            results = []; searchFailed = false; searching = false
            guard !query.isEmpty else { return }
            let expected = query; searching = true
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            let response = await model.knowledge(query: expected)
            guard !Task.isCancelled, expected == query else { return }
            results = response?.entities ?? []; searchFailed = response == nil; searching = false
        }
    }
}
