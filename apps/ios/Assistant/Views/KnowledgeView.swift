import SwiftUI

/// Housekeeping for the knowledge map: derived items that lost their source,
/// connections nobody has confirmed, facts that expired or were superseded.
/// Browsing and editing connections happens on the map itself; this is the
/// short list of things that need a decision.
struct KnowledgeCleanupScreen: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var cleanup: KnowledgeCleanupResponse?
    @State private var pendingID: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Nothing here is removed until you say so.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let cleanup, cleanup.findings.isEmpty {
                    AssistantEmptyState("All tidy", systemImage: "checkmark.seal",
                                        description: "Nothing on your map needs a decision right now.")
                } else if let cleanup {
                    ForEach(cleanup.findings) { finding in cleanupCard(finding) }
                } else {
                    AssistantLoadingState(title: "Checking your map")
                }
            }
            .padding(16)
            .padding(.bottom, 28)
        }
        .navigationTitle("Tidy up")
        .assistantSubmenuChrome()
        .task { await refresh() }
        .refreshable { await refresh() }
    }

    private func cleanupCard(_ finding: KnowledgeCleanupFinding) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(finding.title).font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(finding.detail).font(.footnote).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .top, spacing: 8) {
                primaryAction(finding)
                if let memoryId = finding.memoryId {
                    KnowledgeForgetButton(memoryId: memoryId) { await refresh() }
                        .id(memoryId)
                }
            }
            .disabled(pendingID == finding.id)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantCard(in: colorScheme)
    }

    @ViewBuilder
    private func primaryAction(_ finding: KnowledgeCleanupFinding) -> some View {
        switch finding.kind {
        case "projection_orphan":
            AssistantConfirmationButton("Clear", systemImage: "trash", compact: true) {
                await resolve(action: "remove-orphans", finding: finding)
            }
        case "projection_failed":
            Button("Retry", systemImage: "arrow.clockwise") { Task { await resolve(action: "retry", finding: finding) } }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
        case "unreviewed_connection":
            if let relationId = finding.relationId {
                Button("Confirm", systemImage: "checkmark") {
                    pendingID = finding.id
                    Task {
                        _ = await model.reviewKnowledgeRelation(id: relationId, approve: true)
                        pendingID = nil
                        await refresh()
                    }
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
            }
        case "quarantined":
            Button("Approve", systemImage: "checkmark") { Task { await resolve(action: "approve", finding: finding) } }
                .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
        case "expired", "superseded":
            if finding.memoryId != nil {
                Button("Keep", systemImage: "checkmark.shield") { Task { await resolve(action: "keep", finding: finding) } }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
            }
        default:
            EmptyView()
        }
    }

    private func refresh() async {
        if let result = await model.knowledgeCleanup() { cleanup = result }
    }

    private func resolve(action: String, finding: KnowledgeCleanupFinding) async {
        pendingID = finding.id
        _ = await model.resolveKnowledgeCleanup(action: action, memoryId: finding.memoryId)
        pendingID = nil
        await refresh()
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

    static func relationshipOptions(subjectKind: String, objectKind: String) -> [(
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

struct KnowledgeItemEditor: View {
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
            AssistantConfirmationButton("Forget", compact: true, prepare: {
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
