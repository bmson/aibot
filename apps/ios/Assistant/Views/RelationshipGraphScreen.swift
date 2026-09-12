import SwiftUI

/// Begin with a named item; the full graph is an explicit overview.
struct RelationshipGraphScreen: View {
    var personID: String? = nil
    var entityID: String? = nil
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var graph = RelationshipGraphSnapshot.empty
    @State private var selectedID: String?
    @State private var centerID: String?
    @State private var history: [(id: String, page: Int)] = []
    @State private var page = 0
    @State private var overview = false
    @State private var loading = false
    @State private var hasLoaded = false
    @State private var failure: String?
    @State private var requestID = UUID()
    @State private var command = GraphCanvasCommand()
    @State private var listView = false
    @State private var peopleOnly = false
    @State private var moveNodes = false
    @State private var showGroups = false
    @State private var connecting: RelationshipGraphNode?
    @State private var notice: String?
    @State private var showBrowser = false
    @State private var showConnections = false
    @State private var search = ""
    @State private var searchResults: [KnowledgeEntity] = []
    @State private var searching = false
    @State private var searchFailed = false

    private var usesList: Bool { listView || dynamicTypeSize.isAccessibilitySize }
    private var selected: RelationshipGraphNode? { graph.nodes.first { $0.id == selectedID } }
    private var center: RelationshipGraphNode? { graph.nodes.first { $0.id == centerID } }
    private var neighbors: [RelationshipGraphNode] { centerID.map { graph.directNeighbors(of: $0, peopleOnly: peopleOnly) } ?? [] }
    private var pageCount: Int { max(1, (neighbors.count + 3) / 4) }
    private var visible: RelationshipGraphSnapshot {
        if let centerID { return graph.focused(on: centerID, page: page, peopleOnly: peopleOnly) }
        return peopleOnly ? graph.showing(Set(graph.nodes.filter { $0.kind == "person" }.map(\.id))) : graph
    }
    private var currentEdges: [RelationshipGraphEdge] {
        guard let selectedID else { return [] }
        return graph.edges.filter { $0.reviewStatus != "rejected" && ($0.subjectId == selectedID || $0.objectId == selectedID) }
    }
    private var selectionDescription: String {
        if let centerID, let selectedID, selectedID != centerID,
           let edge = currentEdges.first(where: { $0.subjectId == centerID || $0.objectId == centerID }) {
            return edge.presentation.sentence
        }
        return selected.map { "\($0.kind.sentenceCaseIdentifier) · \(graph.directNeighbors(of: $0.id).count) connected items" } ?? "Tap an item to read its connections."
    }

    var body: some View {
        Group {
            if centerID == nil && !overview { startingPoints }
            else if listView || dynamicTypeSize.isAccessibilitySize { readableList }
            else {
                canvas
                    .safeAreaInset(edge: .top, spacing: 0) { graphSummary }
                    .safeAreaInset(edge: .bottom, spacing: 0) { bottomControls }
            }
        }
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
                    Button("Choose a starting item", systemImage: "list.bullet") { returnToStart() }
                    Button("Full map overview", systemImage: "circle.hexagongrid") { centerID = nil; overview = true; selectedID = nil; send(.fit) }
                    Toggle("List view", isOn: $listView)
                    Toggle("People only", isOn: $peopleOnly)
                    Toggle("Reposition nodes", isOn: $moveNodes)
                    Button("Fit map", systemImage: "arrow.up.left.and.arrow.down.right") { send(.fit) }
                    Button("Tidy overview", systemImage: "square.grid.2x2") { send(.tidy) }.disabled(centerID != nil)
                    Button("Connect loose groups", systemImage: "point.3.connected.trianglepath.dotted") { showGroups = true }
                    Button("Reload graph", systemImage: "arrow.clockwise") { Task { await load() } }
                    Button("All knowledge", systemImage: "circle.hexagongrid") { Task { await load(all: true) } }
                } label: { Label("Graph options", systemImage: "slider.horizontal.3") }
            }
        }
        .onChange(of: peopleOnly) { _, _ in page = 0; selectedID = centerID; send(.fit) }
        .task { if !hasLoaded { await load() } }
        .sheet(isPresented: $showBrowser) { itemBrowser }
        .sheet(item: $connecting) { node in
            NavigationStack {
                GraphConnectSheet(source: node, graph: graph) {
                    await expand(node.id)
                    model.invalidatePersonCaches()
                    notice = "Connection saved"
                    connecting = nil
                }
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { connecting = nil } } }
            }
        }
        .sheet(isPresented: $showGroups) {
            NavigationStack {
                GraphGroupsSheet(graph: graph, focus: { node in
                    open(node.id); showGroups = false
                }, saved: { id in
                    await expand(id)
                    model.invalidatePersonCaches()
                    open(id)
                    showGroups = false
                })
            }
        }
        .sheet(isPresented: $showConnections) {
            if let selected {
                NavigationStack {
                    GraphConnectionsSheet(node: selected, edges: currentEdges, explore: { id in
                        showConnections = false; open(id); Task { await expand(id) }
                    }, removed: { id in
                        graph.edges.removeAll { $0.id == id }; page = min(page, pageCount - 1)
                        model.invalidatePersonCaches()
                        if let personID { Task { await model.refreshPersonEvidence(id: personID) } }
                    }, refresh: {
                        await expand(selected.id)
                        model.invalidatePersonCaches()
                    })
                }
            }
        }
    }

    private var startingPoints: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Start with someone you know").font(.title2.weight(.semibold))
                    Text("Choose a person, place, or project. Explore a few connections at a time, with names and relationships you can read.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button("Find a person or item", systemImage: "magnifyingglass") { showBrowser = true }
                        .buttonStyle(AssistantActionButtonStyle(kind: .secondary)).padding(.top, 6)
                }.padding(.vertical, 8)
            }
            if loading { AssistantLoadingState(title: "Loading connections") }
            if let failure { Section { Text(failure); Button("Retry") { Task { await load() } } } }
            Section("Starting points") {
                ForEach(Array(graph.groups.flatMap { Array($0.nodes.prefix(3)) }.prefix(12))) { node in
                    itemRow(node)
                }
                if hasLoaded && graph.nodes.isEmpty { Text("No recorded connections yet.").foregroundStyle(.secondary) }
                if !graph.nodes.isEmpty { Button("Browse all \(graph.nodes.count) loaded items") { showBrowser = true } }
            }
            if !graph.nodes.isEmpty {
                Section {
                    Button("Full map overview", systemImage: "circle.hexagongrid") { overview = true; send(.fit) }
                    Text("\(graph.nodes.count) loaded items. The overview shows how groups connect; start with an item for a readable map.")
                        .font(.caption).foregroundStyle(.secondary)
                    if graph.truncated { Text("Partial view. Search for items beyond this map.").font(.caption).foregroundStyle(.secondary) }
                }
            }
        }.scrollContentBackground(.hidden).background(AssistantTheme.canvas(for: colorScheme))
    }

    private func itemRow(_ node: RelationshipGraphNode) -> some View {
        Button { open(node.id); Task { await expand(node.id) } } label: {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(node.label).foregroundStyle(.primary)
                    Text("\(node.kind.sentenceCaseIdentifier) · \(graph.directNeighbors(of: node.id).count) connected items")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
            }.padding(.vertical, 4)
        }
    }

    private var canvas: some View {
        ZStack {
            RelationshipGraphCanvas(snapshot: visible, selectedID: selectedID, focusOnly: false, command: command,
                                    centeredID: centerID, allowsNodeDragging: moveNodes) { id in
                // Blank taps leave the selection and control height stable.
                if let id { selectedID = id }
            }.accessibilityIdentifier("assistant.relationship.graph")
            if hasLoaded && visible.nodes.isEmpty { AssistantEmptyState("No items to show", systemImage: "point.3.connected.trianglepath.dotted", description: "Try showing all items.") }
            // Deliberately NOT AssistantLoadingState: that is a full-area state
            // (maxWidth .infinity, minHeight 190), and this is a transient pill
            // floating over the canvas. Routing it through the shared component
            // stretched the capsule across the whole graph — and `loading` is
            // set on every expand, so it covered the thing it was reporting on.
            if loading {
                ProgressView("Loading connections…")
                    .padding(12)
                    .background(.regularMaterial, in: Capsule())
                    .allowsHitTesting(false)
            }
        }.background(AssistantTheme.canvas(for: colorScheme))
    }

    private var graphSummary: some View {
        VStack(alignment: .leading, spacing: 6) {
            (dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout())) {
                Button { goBack() } label: { Label(history.last.flatMap { visit in graph.nodes.first { $0.id == visit.id }?.label } ?? "Starting points", systemImage: "chevron.left") }
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1).accessibilityIdentifier("assistant.relationship.back")
                if !dynamicTypeSize.isAccessibilitySize {
                    Spacer()
                    Button(listView ? "Map" : "List", systemImage: listView ? "point.3.connected.trianglepath.dotted" : "list.bullet") { listView.toggle() }
                }
            }.font(.caption)
            if let center {
                Text("Connections to \(center.label)").font(.headline).lineLimit(2)
                if usesList { Text("\(neighbors.count) connected items").font(.caption).foregroundStyle(.secondary) }
                else { HStack {
                    Text(neighbors.isEmpty ? "No connections loaded" : "\(min(page, pageCount - 1) * 4 + 1)–\(min((min(page, pageCount - 1) + 1) * 4, neighbors.count)) of \(neighbors.count) connected items")
                    Spacer()
                    if pageCount > 1 {
                        Button("Previous connections", systemImage: "chevron.left") { changePage(-1) }.disabled(page == 0)
                        Button("Next connections", systemImage: "chevron.right") { changePage(1) }.disabled(page >= pageCount - 1)
                    }
                }.font(.caption).labelStyle(.iconOnly).buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true)) }
            } else {
                Text("Full map overview").font(.headline)
                Text("\(visible.nodes.count) items. Select one, then open its map.").font(.caption).foregroundStyle(.secondary)
            }
            if peopleOnly { Text("Places and projects are hidden.").font(.caption2).foregroundStyle(.secondary) }
            if graph.truncated { Text("Partial view · search or reload connections for more").font(.caption2).foregroundStyle(.secondary) }
        }.padding(.horizontal, 16).padding(.vertical, 10).background(AssistantTheme.canvas(for: colorScheme))
    }

    private var readableList: some View {
        List {
            Section { graphSummary }
            Section { bottomControls }
            Section(center == nil ? "Loaded items" : "Connected items") {
                ForEach(center == nil ? visible.nodes : neighbors) { node in itemRow(node) }
            }
        }.scrollContentBackground(.hidden).background(AssistantTheme.canvas(for: colorScheme))
    }

    private var bottomControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let failure { Text(failure).font(.caption); Button("Retry") { Task { if let centerID { await expand(centerID) } else { await load() } } } }
            if let notice { Text(notice).font(.caption).foregroundStyle(.secondary) }
            VStack(alignment: .leading, spacing: 4) {
                Text(selected?.label ?? "Explore the map").font(.headline).lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                Text(selectionDescription).font(.subheadline).foregroundStyle(.secondary).lineLimit(listView || dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }.frame(height: listView || dynamicTypeSize.isAccessibilitySize ? nil : 70, alignment: .topLeading)
            (dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) : AnyLayout(HStackLayout(spacing: 8))) {
                Button("Connections") { showConnections = true }.disabled(selected == nil)
                Button("Open map") { if let selected { open(selected.id); Task { await expand(selected.id) } } }
                    .disabled(selected == nil || selectedID == centerID)
                Menu {
                    if let selected {
                        Button("Add connection", systemImage: "plus") { connecting = selected }
                        Button("Reload connections", systemImage: "arrow.clockwise") { Task { await expand(selected.id) } }
                        if let contactID = selected.contactId {
                            NavigationLink("Open profile") { PersonCardScreen(personId: contactID) }
                        }
                    }
                } label: { Image(systemName: "ellipsis").accessibilityLabel("Item actions") }.disabled(selected == nil)
            }.font(.subheadline).buttonStyle(AssistantActionButtonStyle(kind: .secondary))
            if !listView && !dynamicTypeSize.isAccessibilitySize {
                HStack {
                    Text(moveNodes ? "Drag a node to reposition it" : "Drag to pan · pinch to zoom").font(.caption2).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button("Zoom out", systemImage: "minus") { send(.zoomOut) }.labelStyle(.iconOnly).frame(width: 40, height: 40)
                    Button("Fit graph", systemImage: "arrow.up.left.and.arrow.down.right") { send(.fit) }.labelStyle(.iconOnly).frame(width: 40, height: 40)
                    Button("Zoom in", systemImage: "plus") { send(.zoomIn) }.labelStyle(.iconOnly).frame(width: 40, height: 40)
                }
                Text("Lines are recorded relationships; dashed lines need review.").font(.caption2).foregroundStyle(.secondary)
            }
        }.padding(.horizontal, 16).padding(.vertical, 12).background(.regularMaterial)
    }

    private var itemBrowser: some View {
        NavigationStack {
            List {
                Section(search.isEmpty ? "Loaded items" : "Matching items") {
                    if searching { ProgressView("Searching…") }
                    if searchFailed { Text("Search couldn’t load. Try again.").foregroundStyle(.secondary) }
                    if search.isEmpty {
                        ForEach(graph.nodes.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }) { node in
                            Button(node.label) { showBrowser = false; open(node.id); Task { await expand(node.id) } }
                        }
                    } else {
                        ForEach(searchResults) { item in
                            Button { showBrowser = false; Task { await expand(item.id, openAfter: true) } } label: {
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

    private func open(_ id: String) {
        if let centerID, centerID != id { history.append((centerID, page)) }
        centerID = id; selectedID = id; overview = false; page = 0; peopleOnly = false; notice = nil
        send(.fit)
    }
    private func returnToStart() { centerID = nil; selectedID = nil; overview = false; history = []; page = 0 }
    private func goBack() {
        if let visit = history.popLast() {
            centerID = visit.id; selectedID = visit.id; page = visit.page; send(.fit)
            if !graph.nodes.contains(where: { $0.id == visit.id }) { Task { await expand(visit.id) } }
        }
        else { returnToStart() }
    }
    private func changePage(_ delta: Int) { page = min(max(0, page + delta), pageCount - 1); selectedID = centerID; send(.fit) }
    private func send(_ action: GraphCanvasCommand.Action) { command = .init(id: command.id + 1, action: action) }
    private func load(all: Bool = false) async {
        let token = UUID(); requestID = token; loading = true; failure = nil
        let result = await model.relationshipGraph(personID: all ? nil : personID, entityID: all ? nil : entityID)
        guard requestID == token, !Task.isCancelled else { return }
        loading = false
        guard let result else { failure = "Couldn’t load the graph. Check your connection and server version."; return }
        graph = result; hasLoaded = true
        if all { returnToStart() }
        else if let id = centerID ?? result.focusId, graph.nodes.contains(where: { $0.id == id }) { centerID = id; selectedID = id }
        page = min(page, pageCount - 1); notice = nil
    }
    private func expand(_ id: String, openAfter: Bool = false) async {
        let token = UUID(); requestID = token; loading = true; failure = nil
        let result = await model.relationshipGraph(entityID: id)
        guard requestID == token, !Task.isCancelled else { return }
        loading = false
        guard let result else { failure = "Couldn’t load those connections."; return }
        if Set((graph.nodes + result.nodes).map(\.id)).count > 200 { graph = result }
        else { graph = graph.merging(result, around: id) }
        if openAfter { open(id) }
        page = min(page, pageCount - 1)
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
                    AssistantFlowLayout(spacing: 8) {
                        Button("Edit") { Task { correcting = await model.knowledgeRelation(id: edge.id); if correcting == nil { failure = "Couldn’t load this connection." } } }
                            .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                        AssistantConfirmationButton("Remove", hint: "The original note and other claims stay saved.") {
                            working = true
                            failure = nil
                            if await model.removeKnowledgeRelation(id: edge.id) { removed(edge.id) }
                            else { failure = "Couldn’t remove this connection. Try again." }
                            working = false
                        }
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
