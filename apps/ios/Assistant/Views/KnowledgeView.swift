import SwiftUI

/// Native companion to the web knowledge manager. The phone keeps the same
/// browse, cleanup, and evidence-backed editing model, with a focused native
/// map that reveals one neighborhood at a time.
struct KnowledgeView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var overview: KnowledgeOverview?
    @State private var cleanup: KnowledgeCleanupResponse?
    @State private var search = ""
    @State private var showingCleanup = false
    @State private var showingConnectionEditor = false
    @State private var correcting: KnowledgeRelation?
    @State private var editingItem = false
    @State private var pendingRelationID: String?
    @State private var selectionHistory: [KnowledgeEntity] = []
    @State private var selectedID: String?
    @State private var loadID = UUID()
    @State private var loading = false
    @State private var showingMap = true
    @State private var showsVisualGraph = false
    @State private var inspectedNeighborID: String?
    @State private var evidenceRequest = 0

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Color.clear.frame(height: 0).id("knowledge-top")
                    Picker("Knowledge view", selection: $showingCleanup) {
                        Text("Connections").tag(false)
                        Text("Cleanup").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: showingCleanup) { _, _ in Task { await refresh() } }

                    if showingCleanup {
                        cleanupContent
                    } else {
                        relationshipsContent
                    }
                }
                .padding(16)
                .padding(.bottom, 28)
                .frame(maxWidth: isLandscape ? 760 : .infinity, alignment: .leading)
            }
            .onChange(of: selectedID) { _, _ in
                proxy.scrollTo("knowledge-top", anchor: .top)
            }
            .onChange(of: evidenceRequest) { _, _ in
                if inspectedNeighborID != nil {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
                        proxy.scrollTo("knowledge-evidence", anchor: .top)
                    }
                }
            }
        }
        .navigationTitle("Knowledge")
        .assistantSubmenuChrome()
        // Toolbar placement participates in the navigation/search layout; the
        // default overlay placement could cover the lower cleanup cards while
        // the user scrolled.
        .searchable(
            text: $search,
            placement: .toolbar,
            prompt: "Find a person, place, project…"
        )
        .contentMargins(.bottom, 72, for: .scrollContent)
        .onSubmit(of: .search) { Task { await loadSearch() } }
        .fullScreenCover(isPresented: $showsVisualGraph) {
            NavigationStack { RelationshipGraphScreen(entityID: selectedID) }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Open visual graph", systemImage: "circle.hexagongrid") { showsVisualGraph = true }
            }
            if !showingCleanup, selectedEntity != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Add connection", systemImage: "plus") {
                            showingConnectionEditor = true
                        }
                        Button("Edit item", systemImage: "pencil") { editingItem = true }
                    } label: {
                        Label("Knowledge actions", systemImage: "ellipsis.circle")
                    }
                }
            }
        }
        .task { await refresh() }
        .refreshable { await refresh() }
        .sheet(isPresented: $showingConnectionEditor) {
            if let selected = selectedEntity {
                NavigationStack {
                    KnowledgeConnectionEditor(
                        selected: selected, candidates: overview?.entities ?? []
                    ) {
                        await refresh()
                    }
                }
            }
        }
        .sheet(item: $correcting) { relation in
            NavigationStack {
                KnowledgeConnectionEditor(
                    selected: relation.subject,
                    relationToCorrect: relation,
                    candidates: overview?.entities ?? []
                ) { await refresh() }
            }
        }
        .sheet(isPresented: $editingItem) {
            if let selected = selectedEntity {
                NavigationStack {
                    KnowledgeItemEditor(item: selected, duplicates: overview?.duplicates ?? []) {
                        survivingID in
                        selectedID = survivingID
                        selectionHistory.removeAll { $0.id == selected.id }
                        await refresh()
                    }
                }
            }
        }
    }

    private var isLandscape: Bool { verticalSizeClass == .compact }

    private var selectedEntity: KnowledgeEntity? {
        overview?.entitySelected(by: selectedID)
    }

    @ViewBuilder
    private var relationshipsContent: some View {
        if let overview {
            if let selected = selectedEntity {
                Button(
                    selectionHistory.last.map { "Back to \($0.displayLabel)" }
                        ?? "Back to knowledge",
                    systemImage: "chevron.left"
                ) {
                    Task {
                        if let previous = selectionHistory.last {
                            await open(previous, goingBack: true)
                        } else {
                            await loadSearch()
                        }
                    }
                }
                .disabled(loading)
                .frame(minHeight: 44)
                selectedItem(selected, overview: overview)
            } else {
                knowledgeSummary(overview)
            }
            itemBrowser(overview)
        } else {
            if loading {
                AssistantLoadingState(title: "Loading knowledge")
            } else {
                AssistantEmptyState(
                    "Knowledge is unavailable", systemImage: "arrow.clockwise",
                    description: "Pull down to try loading your connections again.")
            }
        }
    }

    @ViewBuilder
    private var cleanupContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Knowledge cleanup").font(.title3.weight(.semibold))
            Text(
                "Suggestions never remove saved knowledge until you confirm. Disconnected graph items are derived and safe to clear."
            )
            .font(.subheadline)
            .foregroundStyle(.secondary)
            if let cleanup, cleanup.findings.isEmpty {
                AssistantEmptyState("Nothing needs cleanup", systemImage: "checkmark.seal")
            } else if let cleanup {
                ForEach(cleanup.findings) { finding in cleanupCard(finding) }
            } else {
                AssistantLoadingState(title: "Loading connections")
            }
        }
    }

    private func cleanupCard(_ finding: KnowledgeCleanupFinding) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(finding.kind.replacingOccurrences(of: "_", with: " ").sentenceCaseIdentifier)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(finding.title).font(.subheadline.weight(.semibold))
            Text(finding.detail).font(.footnote).foregroundStyle(.secondary)
            AssistantFlowLayout(spacing: 8) {
                if finding.kind == "projection_orphan" {
                    AssistantConfirmationButton("Remove derived items") {
                        resolveCleanup(action: "remove-orphans", finding: finding)
                    }.buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                } else if finding.kind == "projection_failed" {
                    Button("Retry", systemImage: "arrow.clockwise") {
                        resolveCleanup(action: "retry", finding: finding)
                    }.buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                } else if finding.kind == "unreviewed_connection",
                    let relationId = finding.relationId
                {
                    Button("Confirm connection", systemImage: "checkmark") {
                        pendingRelationID = relationId
                        Task {
                            _ = await model.reviewKnowledgeRelation(id: relationId, approve: true)
                            pendingRelationID = nil
                            await refresh()
                        }
                    }.buttonStyle(AssistantActionButtonStyle(kind: .primary))
                } else if finding.kind == "quarantined" {
                    Button("Approve", systemImage: "checkmark") {
                        resolveCleanup(action: "approve", finding: finding)
                    }.buttonStyle(AssistantActionButtonStyle(kind: .primary))
                } else if ["expired", "superseded"].contains(finding.kind), finding.memoryId != nil
                {
                    Button("Keep as current", systemImage: "checkmark.shield") {
                        resolveCleanup(action: "keep", finding: finding)
                    }.buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                }
            }
            if let memoryId = finding.memoryId {
                KnowledgeForgetButton(memoryId: memoryId) { await refresh() }
                    .id(memoryId)
            }
        }
        .assistantCard(in: colorScheme)
    }

    private func knowledgeSummary(_ overview: KnowledgeOverview) -> some View {
        HStack(spacing: 12) {
            summaryCount("Items", value: overview.totalEntities, icon: "circle.hexagongrid")
            summaryCount(
                "Connections", value: overview.totalRelations,
                icon: "point.3.connected.trianglepath.dotted")
            summaryCount("Review", value: overview.unreviewedRelations, icon: "checklist")
        }
    }

    private func summaryCount(_ title: String, value: Int, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: icon).foregroundStyle(AssistantTheme.accent(for: colorScheme))
            Text(value, format: .number).font(.headline)
            Text(title).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantPanel(in: colorScheme)
    }

    private func selectedItem(_ item: KnowledgeEntity, overview: KnowledgeOverview) -> some View {
        let connections = KnowledgeConnection.group(overview.relations)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.kind.sentenceCaseIdentifier).font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(showingMap && !dynamicTypeSize.isAccessibilitySize ? "Connection map" : item.displayLabel)
                        .font(.title3.weight(.semibold))
                    Text(
                        "\(connections.count) \(connections.count == 1 ? "connection" : "connections") shown"
                    )
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Add", systemImage: "plus") { showingConnectionEditor = true }
                    .buttonStyle(AssistantActionButtonStyle(kind: .primary))
            }
            Picker("Connection presentation", selection: $showingMap) {
                Label("Map", systemImage: "point.3.connected.trianglepath.dotted").tag(true)
                Label("Details", systemImage: "list.bullet").tag(false)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("assistant.knowledge.presentation")
            if overview.relations.isEmpty {
                AssistantEmptyState(
                    "No active connections", systemImage: "point.3.connected.trianglepath.dotted",
                    description: "Add a connection with a short source note.")
            } else {
                if showingMap && !dynamicTypeSize.isAccessibilitySize {
                    KnowledgeGraphView(focus: item, relations: overview.relations, loading: loading) { neighbor in
                        Task { await open(neighbor) }
                    } inspect: { neighbor in
                        inspectedNeighborID = neighbor.id
                        evidenceRequest += 1
                    }
                    if let neighbor = KnowledgeGraphNeighbor.neighbors(of: item, relations: overview.relations)
                        .first(where: { $0.id == inspectedNeighborID }) {
                        HStack {
                            Text("Linked to \(neighbor.entity.displayLabel)").font(.headline)
                            Spacer()
                            Button("Close evidence", systemImage: "xmark") { inspectedNeighborID = nil }
                                .labelStyle(.iconOnly)
                                .frame(width: 44, height: 44)
                        }
                        .id("knowledge-evidence")
                        ForEach(neighbor.connections) { connection in
                            connectionCard(connection)
                        }
                    }
                } else {
                    if showingMap {
                        Text("Connections are shown as a readable list at this text size.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(connections) { connection in
                        connectionCard(connection)
                    }
                }
                if overview.selectedActiveRelationTotal
                    > overview.relations.filter({
                        $0.inRecall != false && $0.reviewStatus != "rejected"
                    }).count
                {
                    Text(
                        "This is a partial view of \(overview.selectedActiveRelationTotal) active source connections. Explore a linked item or use the web knowledge workspace for the full set."
                    )
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func itemBrowser(_ overview: KnowledgeOverview) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("Browse knowledge").font(.headline)
            if selectedEntity == nil {
                Text("Choose a person, place, or project to open its connection map. Tap linked nodes to keep exploring.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Text("\(overview.matchingEntities) matching items")
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(overview.entities) { item in
                Button {
                    Task { await open(item) }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.displayLabel).foregroundStyle(.primary)
                            Text(item.kind.sentenceCaseIdentifier).font(.caption).foregroundStyle(
                                .secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(
                            .secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(loading)
                .frame(minHeight: 44)
                .padding(.vertical, 6)
                Divider()
            }
        }
        .assistantPanel(in: colorScheme)
    }

    private func connectionCard(_ connection: KnowledgeConnection) -> some View {
        let relation = connection.relation
        return VStack(alignment: .leading, spacing: 8) {
            Text(relation.presentation.label.sentenceCaseIdentifier)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(relation.presentation.sentence)
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                if !connection.confirmed {
                    Label("Needs your review", systemImage: "questionmark.circle")
                        .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
                } else {
                    Label("Confirmed connection", systemImage: "checkmark.seal")
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                }
                if connection.sources.allSatisfy({ $0.inRecall == false }) {
                    Text("Not in recall").foregroundStyle(.secondary)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if let selected = overview?.selected,
                let other = relation.connectedEntity(to: selected.id)
            {
                Button(
                    "Explore \(other.displayLabel)",
                    systemImage: "point.3.connected.trianglepath.dotted"
                ) {
                    Task { await open(other) }
                }
                .font(.subheadline)
                .frame(minHeight: 44)
                .disabled(loading)
            }
            Divider()
            DisclosureGroup("Supporting evidence (\(connection.sources.count))") {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(connection.sources) { source in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(
                                source.needsReview
                                    ? "Source connection not yet reviewed"
                                    : "Reviewed source connection"
                            )
                            .font(.caption).foregroundStyle(.secondary)
                            Text(source.source.content).font(.footnote)
                            AssistantFlowLayout(spacing: 8) {
                                if source.needsReview {
                                    Button("Confirm", systemImage: "checkmark") {
                                        review(source, approve: true)
                                    }
                                    .buttonStyle(AssistantActionButtonStyle(kind: .primary))
                                }
                                Menu {
                                    Button("Correct", systemImage: "pencil") { correcting = source }
                                } label: {
                                    Label("Edit evidence", systemImage: "ellipsis")
                                }.buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                                AssistantConfirmationButton("Mark inaccurate", systemImage: "xmark") {
                                    review(source, approve: false)
                                }
                            }
                            .disabled(pendingRelationID != nil)
                        }
                    }
                }
                .padding(.top, 8)
            }
            .font(.subheadline)
        }
        .assistantCard(in: colorScheme)
    }

    private func refresh() async {
        let request = UUID()
        loadID = request
        loading = true
        defer { if loadID == request { loading = false } }
        if showingCleanup {
            let result = await model.knowledgeCleanup()
            if loadID == request { cleanup = result }
        } else {
            let result: KnowledgeOverview?
            if let selectedID {
                result = await model.knowledgeItem(id: selectedID)
            } else {
                result = await model.knowledge(query: search)
            }
            if loadID == request, let result { overview = result }
        }
    }

    private func loadSearch() async {
        showingCleanup = false
        selectedID = nil
        inspectedNeighborID = nil
        selectionHistory = []
        await refresh()
    }

    private func open(_ item: KnowledgeEntity, goingBack: Bool = false) async {
        let request = UUID()
        loadID = request
        loading = true
        defer { if loadID == request { loading = false } }
        guard let result = await model.knowledgeItem(id: item.id), loadID == request,
            result.selected?.id == item.id
        else { return }
        if goingBack {
            _ = selectionHistory.popLast()
        } else if let previous = selectedEntity, previous.id != item.id {
            selectionHistory.append(previous)
        }
        selectedID = item.id
        inspectedNeighborID = nil
        overview = result
    }

    private func review(_ relation: KnowledgeRelation, approve: Bool) {
        pendingRelationID = relation.id
        Task {
            _ = await model.reviewKnowledgeRelation(id: relation.id, approve: approve)
            pendingRelationID = nil
            await refresh()
        }
    }

    private func resolveCleanup(action: String, finding: KnowledgeCleanupFinding) {
        Task {
            _ = await model.resolveKnowledgeCleanup(action: action, memoryId: finding.memoryId)
            await refresh()
        }
    }
}

struct KnowledgeConnectionEditor: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var subject: KnowledgeEntity
    let relationToCorrect: KnowledgeRelation?
    let candidates: [KnowledgeEntity]
    let didSave: () async -> Void
    @State private var objectLabel: String
    @State private var objectKind: String
    @State private var objectId: String?
    @State private var objectIdLabel: String
    @State private var objectIdKind: String
    @State private var predicate: String
    @State private var customPredicate = ""
    @State private var note = ""
    @State private var saving = false
    @State private var saveError: String?

    init(
        selected: KnowledgeEntity,
        relationToCorrect: KnowledgeRelation? = nil,
        initialObject: KnowledgeEntity? = nil,
        candidates: [KnowledgeEntity],
        didSave: @escaping () async -> Void
    ) {
        _subject = State(initialValue: selected)
        self.relationToCorrect = relationToCorrect
        self.candidates = candidates
        self.didSave = didSave
        _objectLabel = State(initialValue: (relationToCorrect?.object ?? initialObject)?.displayLabel ?? "")
        _objectKind = State(initialValue: (relationToCorrect?.object ?? initialObject)?.kind ?? "person")
        _objectId = State(initialValue: (relationToCorrect?.object ?? initialObject)?.id)
        _objectIdLabel = State(initialValue: (relationToCorrect?.object ?? initialObject)?.displayLabel ?? "")
        _objectIdKind = State(initialValue: (relationToCorrect?.object ?? initialObject)?.kind ?? "person")
        let initialKind = (relationToCorrect?.object ?? initialObject)?.kind ?? "person"
        let options = Self.relationshipOptions(subjectKind: selected.kind, objectKind: initialKind)
        if let relationToCorrect, !options.contains(where: { $0.id == relationToCorrect.predicate })
        {
            _predicate = State(initialValue: "__custom")
            _customPredicate = State(initialValue: relationToCorrect.predicate)
        } else {
            _predicate = State(
                initialValue: relationToCorrect?.predicate ?? "__choose")
        }
    }

    var body: some View {
        AssistantForm {
            Section {
                Text(
                    "Describe the relationship and add a source note to support it. Corrections keep the original source for reference."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            Section("First item") {
                Text(subject.displayLabel)
                Text(subject.kind.sentenceCaseIdentifier).font(.caption).foregroundStyle(
                    .secondary)
            }
            Section("Connected item") {
                TextField("Name", text: $objectLabel)
                    .onChange(of: objectLabel) { _, value in
                        if value != objectIdLabel { objectId = nil }
                    }
                Picker("Type", selection: $objectKind) {
                    ForEach(
                        ["person", "organization", "project", "place", "event", "date", "topic"],
                        id: \.self
                    ) { Text($0.sentenceCaseIdentifier).tag($0) }
                }
                .onChange(of: objectKind) { _, value in
                    if value != objectIdKind { objectId = nil }
                    let allowed = Self.relationshipOptions(
                        subjectKind: subject.kind, objectKind: value)
                    if predicate != "__custom" && !allowed.contains(where: { $0.id == predicate }) {
                        predicate = "__choose"
                    }
                }
                if !candidates.isEmpty {
                    Menu("Choose an existing item") {
                        ForEach(candidates.prefix(30)) { item in
                            Button(item.displayLabel) {
                                objectLabel = item.displayLabel
                                objectKind = item.kind
                                objectIdLabel = item.displayLabel
                                objectIdKind = item.kind
                                objectId = item.id
                            }
                        }
                    }
                }
            }
            Section("Relationship") {
                if relationToCorrect == nil, let objectId {
                    Button("Swap direction", systemImage: "arrow.up.arrow.down") {
                        let previous = subject
                        subject = .init(id: objectId, label: objectLabel, kind: objectKind, canonicalKey: objectId)
                        objectLabel = previous.displayLabel; objectKind = previous.kind
                        objectIdLabel = previous.displayLabel; objectIdKind = previous.kind
                        self.objectId = previous.id; predicate = "__choose"
                    }
                }
                Picker("Relationship", selection: $predicate) {
                    Text("Choose a relationship…").tag("__choose")
                    ForEach(relationshipOptions, id: \.id) { option in
                        Text(option.label).tag(option.id)
                    }
                    Text("Use my own words…").tag("__custom")
                }
                if predicate == "__custom" {
                    TextField("e.g. advises", text: $customPredicate)
                }
                Text("This will say: \(previewSentence)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("Source note") {
                TextEditor(text: $note).frame(minHeight: 110)
            }
            if let saveError {
                Section { Text(saveError).foregroundStyle(.red) }
            }
        }
        .navigationTitle(relationToCorrect == nil ? "Add connection" : "Correct connection")
        .navigationBarTitleDisplayMode(.inline)
        .tint(AssistantTheme.accent(for: colorScheme))
        .interactiveDismissDisabled(saving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.disabled(saving)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") { save() }
                    .disabled(
                        saving || predicate == "__choose" || objectId == subject.id
                            || objectLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || (predicate == "__custom"
                                && customPredicate.trimmingCharacters(in: .whitespacesAndNewlines)
                                    .isEmpty)
                            || note.trimmingCharacters(in: .whitespacesAndNewlines).count < 3)
            }
        }
    }

    private func save() {
        saving = true
        saveError = nil
        let mutation = KnowledgeConnectionMutation(
            subjectLabel: subject.label,
            subjectKind: subject.kind,
            subjectId: subject.id,
            predicate: storedPredicate,
            objectLabel: objectLabel,
            objectKind: objectKind,
            objectId: objectId,
            note: note
        )
        Task {
            let saved =
                if let relationToCorrect {
                    await model.correctKnowledgeRelation(
                        id: relationToCorrect.id, mutation: mutation)
                } else {
                    await model.createKnowledgeConnection(mutation)
                }
            if saved {
                await didSave()
                dismiss()
            } else {
                saveError =
                    "The relationship could not be saved. Your changes are still here; please try again."
            }
            saving = false
        }
    }

    private var storedPredicate: String {
        predicate == "__custom" ? customPredicate : predicate
    }

    private var relationshipOptions: [(id: String, label: String)] {
        Self.relationshipOptions(subjectKind: subject.kind, objectKind: objectKind)
    }

    private static func relationshipOptions(subjectKind: String, objectKind: String) -> [(
        id: String, label: String
    )] {
        switch (subjectKind, objectKind) {
        case ("person", "person"):
            return [
                ("parent_of", "is the parent of"),
                ("daughter_of", "is the daughter of"),
                ("son_of", "is the son of"),
                ("spouse_of", "is the spouse of"),
                ("sibling_of", "is the sibling of"),
                ("friend_of", "is a friend of"),
                ("colleague_of", "is a colleague of"),
                ("met", "met"),
            ]
        case ("person", "organization"):
            return [
                ("works_at", "works at"), ("worked_at", "worked at"), ("studies_at", "studies at"),
                ("studied_at", "studied at"),
            ]
        case ("organization", "person"):
            return [("employs", "employs")]
        case ("person", "place"):
            return [
                ("lives_in", "lives in"), ("born_in", "was born in"), ("grew_up_in", "grew up in"),
                ("met_at", "met at"),
            ]
        case ("person", "event"):
            return [("attended", "attended"), ("attends", "attends"), ("met_during", "met during")]
        case ("event", "person"):
            return [("attended_by", "was attended by")]
        case ("event", "place"):
            return [("happens_at", "happens at")]
        case ("event", "date"), ("project", "date"):
            return [
                ("happens_on", "happens on"), ("starts_on", "starts on"), ("ends_on", "ends on"),
            ]
        case ("person", "date"):
            return [
                ("born_on", "was born on"), ("married_on", "married on"), ("died_on", "died on"),
            ]
        default:
            return []
        }
    }

    private var previewSentence: String {
        if predicate == "__choose" { return "Choose how these items are connected." }
        return Self.previewSentence(
            subject: subject.displayLabel, predicate: storedPredicate, objectLabel: objectLabel)
    }

    static func previewSentence(subject: String, predicate: String, objectLabel: String) -> String {
        let object = objectLabel.isEmpty ? "the connected item" : objectLabel
        switch predicate {
        case "daughter_of": return "\(subject) is \(object)’s daughter."
        case "son_of": return "\(subject) is \(object)’s son."
        case "spouse_of": return "\(subject) and \(object) are spouses."
        case "works_at": return "\(subject) works at \(object)."
        case "worked_at": return "\(subject) worked at \(object)."
        case "parent_of": return "\(subject) is \(object)’s parent."
        case "lives_in": return "\(subject) lives in \(object)."
        case "attended": return "\(subject) attended \(object)."
        default:
            return
                "\(subject) \(predicate.replacingOccurrences(of: "_", with: " ")) \(object)."
        }
    }
}

private struct KnowledgeItemEditor: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let item: KnowledgeEntity
    let duplicates: [KnowledgeDuplicate]
    let didSave: (String) async -> Void
    @State private var label: String
    @State private var kind: String
    @State private var mergeTargetId = ""
    @State private var mergeTargetLabel = ""
    @State private var mergeSearch = ""
    @State private var mergeResults: [KnowledgeEntity] = []
    @State private var searchTask: Task<Void, Never>?
    @State private var searching = false
    @State private var saving = false

    init(
        item: KnowledgeEntity, duplicates: [KnowledgeDuplicate],
        didSave: @escaping (String) async -> Void
    ) {
        self.item = item
        self.duplicates = duplicates
        self.didSave = didSave
        _label = State(initialValue: item.displayLabel)
        _kind = State(initialValue: item.kind)
    }

    var body: some View {
        AssistantForm {
            Section("Display name") { TextField("Name", text: $label) }
            Section("Type") {
                Picker("Type", selection: $kind) {
                    ForEach(
                        ["person", "organization", "project", "place", "event", "date", "topic"],
                        id: \.self
                    ) { Text($0.sentenceCaseIdentifier).tag($0) }
                }
            }
            // Not gated on duplicates any more. The server only flags likely
            // duplicates, so an item it had not paired could not be merged from
            // the phone at all, while the web form has always searched the whole
            // graph. Suggestions stay as one-tap shortcuts when they exist.
            Section("Merge into another item") {
                if mergeTargetId.isEmpty {
                    ForEach(duplicates) { duplicate in
                        Button {
                            mergeTargetId = duplicate.targetId
                            mergeTargetLabel = duplicate.label.replacingOccurrences(
                                of: "_", with: " ")
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(duplicate.label.replacingOccurrences(of: "_", with: " "))
                                Text("Suggested — \(duplicate.reason)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .frame(minHeight: 44)
                    }
                    TextField("Search every item", text: $mergeSearch)
                        .autocorrectionDisabled()
                        .onChange(of: mergeSearch) { _, value in scheduleSearch(value) }
                    if searching {
                        Text("Searching…").font(.caption).foregroundStyle(.secondary)
                    } else if !mergeResults.isEmpty {
                        ForEach(mergeResults) { entity in
                            Button {
                                mergeTargetId = entity.id
                                mergeTargetLabel = entity.displayLabel
                                mergeSearch = ""
                                mergeResults = []
                            } label: {
                                HStack {
                                    Text(entity.displayLabel)
                                    Spacer(minLength: 8)
                                    Text(entity.kind.sentenceCaseIdentifier)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .frame(minHeight: 44)
                        }
                    } else if mergeSearch.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 {
                        Text("No other items match.").font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    LabeledContent("Merging into", value: mergeTargetLabel)
                    Button("Keep separate") {
                        mergeTargetId = ""
                        mergeTargetLabel = ""
                    }
                    .frame(minHeight: 44)
                }
                Text(
                    "Merging keeps its source-backed connections and uses the selected item as the surviving record."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Edit item")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") { save() }.disabled(saving || label.isEmpty)
            }
        }
    }

    /// Debounced, and cancelling: without cancellation a slower earlier query
    /// could land after a later one and replace the results actually typed for.
    private func scheduleSearch(_ query: String) {
        searchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            mergeResults = []
            searching = false
            return
        }
        searching = true
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            let result = await model.knowledge(query: trimmed)
            guard !Task.isCancelled else { return }
            // Never offer the item as its own merge target.
            mergeResults = (result?.entities ?? []).filter { $0.id != item.id }
            searching = false
        }
    }

    private func save() {
        saving = true
        Task {
            let renamed: Bool
            if label == item.displayLabel {
                renamed = true
            } else {
                renamed = await model.updateKnowledgeItem(
                    id: item.id, action: "rename", value: label)
            }
            let retyped: Bool
            if kind == item.kind {
                retyped = true
            } else {
                retyped = await model.updateKnowledgeItem(
                    id: item.id, action: "retype", value: kind)
            }
            let merged: Bool
            if mergeTargetId.isEmpty {
                merged = true
            } else {
                merged = await model.mergeKnowledgeItem(id: item.id, targetId: mergeTargetId)
            }
            saving = false
            if renamed && retyped && merged {
                await didSave(mergeTargetId.isEmpty ? item.id : mergeTargetId)
                dismiss()
            }
        }
    }
}

/// Show the affected knowledge inline before the second tap can forget a source.
private struct KnowledgeForgetButton: View {
    let memoryId: String
    let refresh: () async -> Void
    @EnvironmentObject private var model: AppModel
    @State private var impact: KnowledgeSourceImpact?
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            AssistantConfirmationButton("Forget", prepare: {
                failure = nil
                impact = await model.knowledgeSourceImpact(id: memoryId)
                if impact == nil { failure = "Couldn’t check the affected knowledge. Try again." }
                return impact != nil
            }) {
                guard let impact else { return }
                if await model.forgetKnowledgeSource(id: impact.memoryId) {
                    self.impact = nil
                    await refresh()
                }
            }
            if let impact {
                Text(forgetImpactMessage(impact))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
        }
    }

    private func forgetImpactMessage(_ impact: KnowledgeSourceImpact) -> String {
        let retired =
            impact.retiredProjections > 0
            ? " It also clears \(impact.retiredProjections) retired derived projections."
            : ""
        return
            "This removes \(impact.activeConnections) active connections and \(impact.orphanedItems.count) items that would no longer be connected.\(retired) The source is tombstoned so it is not learned again verbatim."
    }

}
