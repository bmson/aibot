import SwiftUI

/// Native companion to the web knowledge manager. The phone keeps the same
/// browse, cleanup, and evidence-backed editing model, but intentionally leaves
/// the dense graph canvas to a larger screen.
struct KnowledgeView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var overview: KnowledgeOverview?
    @State private var cleanup: KnowledgeCleanupResponse?
    @State private var search = ""
    @State private var showingCleanup = false
    @State private var showingConnectionEditor = false
    @State private var correcting: KnowledgeRelation?
    @State private var editingItem = false
    @State private var pendingRelationID: String?
    @State private var forgettingImpact: KnowledgeSourceImpact?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
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
        }
        .navigationTitle("Knowledge")
        .searchable(text: $search, prompt: "Find a person, place, project…")
        .onSubmit(of: .search) { Task { await loadSearch() } }
        .toolbar {
            if !showingCleanup, overview?.selected != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Add connection", systemImage: "plus") { showingConnectionEditor = true }
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
            if let selected = overview?.selected {
                NavigationStack {
                    KnowledgeConnectionEditor(selected: selected, candidates: overview?.entities ?? []) {
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
            if let selected = overview?.selected {
                NavigationStack {
                    KnowledgeItemEditor(item: selected, duplicates: overview?.duplicates ?? []) { await refresh() }
                }
            }
        }
        .confirmationDialog(
            "Forget this source knowledge?",
            isPresented: Binding(
                get: { forgettingImpact != nil },
                set: { if !$0 { forgettingImpact = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let impact = forgettingImpact {
                Button("Forget knowledge", role: .destructive) {
                    Task {
                        _ = await model.forgetKnowledgeSource(id: impact.memoryId)
                        forgettingImpact = nil
                        await refresh()
                    }
                }
            }
            Button("Cancel", role: .cancel) { forgettingImpact = nil }
        } message: {
            if let impact = forgettingImpact {
                Text(forgetImpactMessage(impact))
            }
        }
    }

    private func forgetImpactMessage(_ impact: KnowledgeSourceImpact) -> String {
        let retired = impact.retiredProjections > 0
            ? " It also clears \(impact.retiredProjections) retired derived projections."
            : ""
        return "This removes \(impact.activeConnections) active connections and \(impact.orphanedItems.count) items that would no longer be connected.\(retired) The source is tombstoned so it is not learned again verbatim."
    }

    @ViewBuilder
    private var relationshipsContent: some View {
        if let overview {
            knowledgeSummary(overview)
            if let selected = overview.selected {
                selectedItem(selected, overview: overview)
            }
            itemBrowser(overview)
        } else {
            ProgressView().frame(maxWidth: .infinity, minHeight: 220)
        }
    }

    @ViewBuilder
    private var cleanupContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Knowledge cleanup").font(.title3.weight(.semibold))
            Text("Suggestions never remove saved knowledge until you confirm. Disconnected graph items are derived and safe to clear.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let cleanup, cleanup.findings.isEmpty {
                AssistantEmptyState("Nothing needs cleanup", systemImage: "checkmark.seal")
            } else if let cleanup {
                ForEach(cleanup.findings) { finding in cleanupCard(finding) }
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 180)
            }
        }
    }

    private func cleanupCard(_ finding: KnowledgeCleanupFinding) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(finding.kind.replacingOccurrences(of: "_", with: " ").uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(finding.title).font(.subheadline.weight(.semibold))
            Text(finding.detail).font(.footnote).foregroundStyle(.secondary)
            AssistantFlowLayout(spacing: 8) {
                if finding.kind == "projection_orphan" {
                    Button("Remove derived items", systemImage: "trash") {
                        resolveCleanup(action: "remove-orphans", finding: finding)
                    }.buttonStyle(.bordered)
                } else if finding.kind == "projection_failed" {
                    Button("Retry", systemImage: "arrow.clockwise") {
                        resolveCleanup(action: "retry", finding: finding)
                    }.buttonStyle(.bordered)
                } else if finding.kind == "unreviewed_connection", let relationId = finding.relationId {
                    Button("Confirm connection", systemImage: "checkmark") {
                        pendingRelationID = relationId
                        Task {
                            _ = await model.reviewKnowledgeRelation(id: relationId, approve: true)
                            pendingRelationID = nil
                            await refresh()
                        }
                    }.buttonStyle(.borderedProminent)
                } else if finding.kind == "quarantined" {
                    Button("Approve", systemImage: "checkmark") {
                        resolveCleanup(action: "approve", finding: finding)
                    }.buttonStyle(.borderedProminent)
                } else if ["expired", "superseded"].contains(finding.kind), finding.memoryId != nil {
                    Button("Keep as current", systemImage: "checkmark.shield") {
                        resolveCleanup(action: "keep", finding: finding)
                    }.buttonStyle(.bordered)
                }
                if let memoryId = finding.memoryId {
                    Button("Forget", systemImage: "trash", role: .destructive) {
                        Task { forgettingImpact = await model.knowledgeSourceImpact(id: memoryId) }
                    }.buttonStyle(.bordered)
                }
            }
        }
        .assistantCard(in: colorScheme)
    }

    private func knowledgeSummary(_ overview: KnowledgeOverview) -> some View {
        HStack(spacing: 12) {
            summaryCount("Items", value: overview.totalEntities, icon: "circle.hexagongrid")
            summaryCount("Connections", value: overview.totalRelations, icon: "point.3.connected.trianglepath.dotted")
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
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.kind.sentenceCaseIdentifier).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(item.displayLabel).font(.title3.weight(.semibold))
                    Text("\(overview.selectedActiveRelationTotal) active connections")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Add", systemImage: "plus") { showingConnectionEditor = true }
                    .buttonStyle(.borderedProminent)
            }
            if overview.relations.isEmpty {
                AssistantEmptyState("No active connections", systemImage: "point.3.connected.trianglepath.dotted", description: "Add a connection with a short source note.")
            } else {
                ForEach(overview.relations.filter { $0.reviewStatus != "rejected" }) { relation in
                    relationCard(relation, showCorrection: true)
                }
            }
        }
        .assistantPanel(in: colorScheme)
    }

    private func itemBrowser(_ overview: KnowledgeOverview) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("Browse knowledge").font(.headline)
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
                            Text(item.kind.sentenceCaseIdentifier).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.vertical, 6)
                Divider()
            }
        }
        .assistantPanel(in: colorScheme)
    }

    private func relationCard(_ relation: KnowledgeRelation, showCorrection: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(relation.presentation.label.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(relation.presentation.sentence)
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Text("\(Int((relation.confidence * 100).rounded()))% confidence")
                if relation.needsReview { Text("Needs review").foregroundStyle(AssistantTheme.warningInk(for: colorScheme)) }
                if relation.inRecall == false { Text("Not in recall").foregroundStyle(.secondary) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            DisclosureGroup("Source evidence") {
                Text(relation.source.content)
                    .font(.footnote)
                    .padding(.top, 6)
            }
            AssistantFlowLayout(spacing: 8) {
                if relation.needsReview {
                    Button("Confirm", systemImage: "checkmark") { review(relation, approve: true) }
                        .buttonStyle(.borderedProminent)
                }
                if relation.reviewStatus != "rejected" {
                    Button("Mark inaccurate", systemImage: "xmark", role: .destructive) { review(relation, approve: false) }
                        .buttonStyle(.bordered)
                }
                if showCorrection {
                    Button("Correct", systemImage: "pencil") { correcting = relation }
                        .buttonStyle(.bordered)
                }
            }
            .disabled(pendingRelationID != nil)
        }
        .assistantCard(in: colorScheme)
    }

    private func refresh() async {
        if showingCleanup {
            cleanup = await model.knowledgeCleanup()
        } else {
            overview = await model.knowledge(query: search)
        }
    }

    private func loadSearch() async {
        showingCleanup = false
        overview = await model.knowledge(query: search)
    }

    private func open(_ item: KnowledgeEntity) async {
        overview = await model.knowledgeItem(id: item.id)
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

private struct KnowledgeConnectionEditor: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let selected: KnowledgeEntity
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

    init(
        selected: KnowledgeEntity,
        relationToCorrect: KnowledgeRelation? = nil,
        candidates: [KnowledgeEntity],
        didSave: @escaping () async -> Void
    ) {
        self.selected = selected
        self.relationToCorrect = relationToCorrect
        self.candidates = candidates
        self.didSave = didSave
        _objectLabel = State(initialValue: relationToCorrect?.object.displayLabel ?? "")
        _objectKind = State(initialValue: relationToCorrect?.object.kind ?? "person")
        _objectId = State(initialValue: relationToCorrect?.object.id)
        _objectIdLabel = State(initialValue: relationToCorrect?.object.displayLabel ?? "")
        _objectIdKind = State(initialValue: relationToCorrect?.object.kind ?? "person")
        let initialKind = relationToCorrect?.object.kind ?? "person"
        _predicate = State(initialValue: relationToCorrect?.predicate ?? Self.relationshipOptions(subjectKind: selected.kind, objectKind: initialKind).first?.id ?? "__custom")
    }

    var body: some View {
        Form {
            Section {
                Text(relationToCorrect == nil ? "Add connection" : "Correct connection")
                    .font(.headline)
                Text("The note is saved as evidence, so this never becomes an unsupported graph-only fact.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("First item") {
                Text(selected.displayLabel)
                Text(selected.kind.sentenceCaseIdentifier).font(.caption).foregroundStyle(.secondary)
            }
            Section("Connected item") {
                TextField("Name", text: $objectLabel)
                    .onChange(of: objectLabel) { _, value in
                        if value != objectIdLabel { objectId = nil }
                    }
                Picker("Type", selection: $objectKind) {
                    ForEach(["person", "organization", "project", "place", "event", "date", "topic"], id: \.self) { Text($0.sentenceCaseIdentifier).tag($0) }
                }
                .onChange(of: objectKind) { _, value in
                    if value != objectIdKind { objectId = nil }
                    let allowed = Self.relationshipOptions(subjectKind: selected.kind, objectKind: value)
                    if predicate != "__custom" && !allowed.contains(where: { $0.id == predicate }) {
                        predicate = allowed.first?.id ?? "__custom"
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
                Picker("Relationship", selection: $predicate) {
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
        }
        .navigationTitle(relationToCorrect == nil ? "Add connection" : "Correct connection")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") { save() }
                    .disabled(saving || objectLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (predicate == "__custom" && customPredicate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) || note.trimmingCharacters(in: .whitespacesAndNewlines).count < 3)
            }
        }
    }

    private func save() {
        saving = true
        let mutation = KnowledgeConnectionMutation(
            subjectLabel: selected.label,
            subjectKind: selected.kind,
            subjectId: selected.id,
            predicate: storedPredicate,
            objectLabel: objectLabel,
            objectKind: objectKind,
            objectId: objectId,
            note: note
        )
        Task {
            let saved = if let relationToCorrect {
                await model.correctKnowledgeRelation(id: relationToCorrect.id, mutation: mutation)
            } else {
                await model.createKnowledgeConnection(mutation)
            }
            saving = false
            if saved {
                await didSave()
                dismiss()
            }
        }
    }

    private var storedPredicate: String {
        predicate == "__custom" ? customPredicate : predicate
    }

    private var relationshipOptions: [(id: String, label: String)] {
        Self.relationshipOptions(subjectKind: selected.kind, objectKind: objectKind)
    }

    private static func relationshipOptions(subjectKind: String, objectKind: String) -> [(id: String, label: String)] {
        switch (subjectKind, objectKind) {
        case ("person", "person"):
            return [
                ("parent_of", "is the parent of"),
                ("daughter_of", "is the daughter of"),
                ("son_of", "is the son of"),
                ("spouse_of", "is the spouse of"),
                ("sibling_of", "is the sibling of"),
                ("met", "met"),
            ]
        case ("person", "organization"):
            return [("works_at", "works at"), ("worked_at", "worked at"), ("studies_at", "studies at"), ("studied_at", "studied at")]
        case ("organization", "person"):
            return [("employs", "employs")]
        case ("person", "place"):
            return [("lives_in", "lives in"), ("born_in", "was born in"), ("grew_up_in", "grew up in"), ("met_at", "met at")]
        case ("person", "event"):
            return [("attended", "attended"), ("attends", "attends"), ("met_during", "met during")]
        case ("event", "person"):
            return [("attended_by", "was attended by")]
        case ("event", "place"):
            return [("happens_at", "happens at")]
        case ("event", "date"), ("project", "date"):
            return [("happens_on", "happens on"), ("starts_on", "starts on"), ("ends_on", "ends on")]
        case ("person", "date"):
            return [("born_on", "was born on"), ("married_on", "married on"), ("died_on", "died on")]
        default:
            return []
        }
    }

    private var previewSentence: String {
        let object = objectLabel.isEmpty ? "the connected item" : objectLabel
        switch storedPredicate {
        case "daughter_of": return "\(object) is \(selected.displayLabel)’s daughter."
        case "son_of": return "\(object) is \(selected.displayLabel)’s son."
        case "spouse_of": return "\(selected.displayLabel) and \(object) are spouses."
        case "works_at": return "\(selected.displayLabel) works at \(object)."
        case "worked_at": return "\(selected.displayLabel) worked at \(object)."
        case "parent_of": return "\(selected.displayLabel) is \(object)’s parent."
        case "lives_in": return "\(selected.displayLabel) lives in \(object)."
        case "attended": return "\(selected.displayLabel) attended \(object)."
        default: return "\(selected.displayLabel) \(storedPredicate.replacingOccurrences(of: "_", with: " ")) \(object)."
        }
    }
}

private struct KnowledgeItemEditor: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let item: KnowledgeEntity
    let duplicates: [KnowledgeDuplicate]
    let didSave: () async -> Void
    @State private var label: String
    @State private var kind: String
    @State private var mergeTargetId = ""
    @State private var saving = false

    init(item: KnowledgeEntity, duplicates: [KnowledgeDuplicate], didSave: @escaping () async -> Void) {
        self.item = item
        self.duplicates = duplicates
        self.didSave = didSave
        _label = State(initialValue: item.displayLabel)
        _kind = State(initialValue: item.kind)
    }

    var body: some View {
        Form {
            Section("Display name") { TextField("Name", text: $label) }
            Section("Type") {
                Picker("Type", selection: $kind) {
                    ForEach(["person", "organization", "project", "place", "event", "date", "topic"], id: \.self) { Text($0.sentenceCaseIdentifier).tag($0) }
                }
            }
            if !duplicates.isEmpty {
                Section("Merge duplicate") {
                    Picker("Keep this item separate", selection: $mergeTargetId) {
                        Text("Keep separate").tag("")
                        ForEach(duplicates) { duplicate in
                            Text(duplicate.label.replacingOccurrences(of: "_", with: " ")).tag(duplicate.targetId)
                        }
                    }
                    Text("Merging keeps its source-backed connections and uses the selected item as the surviving record.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
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

    private func save() {
        saving = true
        Task {
            let renamed: Bool
            if label == item.displayLabel {
                renamed = true
            } else {
                renamed = await model.updateKnowledgeItem(id: item.id, action: "rename", value: label)
            }
            let retyped: Bool
            if kind == item.kind {
                retyped = true
            } else {
                retyped = await model.updateKnowledgeItem(id: item.id, action: "retype", value: kind)
            }
            let merged: Bool
            if mergeTargetId.isEmpty {
                merged = true
            } else {
                merged = await model.mergeKnowledgeItem(id: item.id, targetId: mergeTargetId)
            }
            saving = false
            if renamed && retyped && merged {
                await didSave()
                dismiss()
            }
        }
    }
}
