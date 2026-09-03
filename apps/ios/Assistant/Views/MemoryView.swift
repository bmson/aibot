import SwiftUI
import UniformTypeIdentifiers

/// Owner-facing memory controls. This deliberately uses the same vocabulary as
/// the web library: approve quarantined facts, confirm ordinary facts, control
/// prominence, correct text, and forget facts with a tombstone.
struct MemoryView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showingCreateMemory = false
    @State private var editingFact: WorkspaceMemoryFact?
    @State private var forgettingFact: WorkspaceMemoryFact?
    @State private var pendingFactID: String?
    @State private var showingPersonCreator = false
    @State private var editingPerson: WorkspacePerson?
    @State private var deletingPerson: WorkspacePerson?
    @State private var addingFactForPerson: WorkspacePerson?
    @State private var managingPerson: WorkspacePerson?
    @State private var profileActionInFlight: String?
    @State private var showingVoiceImporter = false
    @State private var voiceRegister = "email_casual"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let memory = model.workspace?.memory {
                    memoryContent(memory)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 220)
                }
            }
            .padding(16)
            .padding(.bottom, 28)
        }
        .navigationTitle("Memory")
        .assistantSubmenuChrome()
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Add memory", systemImage: "plus") { showingCreateMemory = true }
                        .disabled(model.workspace?.memory.ownerContactId == nil)
                    Button("Add person", systemImage: "person.badge.plus") {
                        showingPersonCreator = true
                    }
                    Button("Add writing samples", systemImage: "text.quote") {
                        showingVoiceImporter = true
                    }
                    Divider()
                    Button("Organize memory", systemImage: "sparkles") {
                        updateProfile(action: "organize")
                    }
                    Button("Refresh profile summary", systemImage: "arrow.clockwise") {
                        updateProfile(action: "recompile")
                    }
                    if let voice = model.workspace?.memory.voiceStats,
                       voice.auto + voice.uploaded > 0 {
                        Button("Clear writing samples", systemImage: "trash", role: .destructive) {
                            updateProfile(action: "purge-voice")
                        }
                    }
                } label: {
                    Label("Memory actions", systemImage: "ellipsis.circle")
                }
                .disabled(profileActionInFlight != nil)
            }
        }
        .refreshable { await model.refreshWorkspace() }
        .task { if model.workspace == nil { await model.refreshWorkspace() } }
        .fileImporter(
            isPresented: $showingVoiceImporter,
            allowedContentTypes: [.plainText, .json, .data],
            allowsMultipleSelection: false
        ) { result in
            guard case let .success(urls) = result, let url = urls.first else {
                if case let .failure(error) = result { model.errorMessage = error.localizedDescription }
                return
            }
            uploadVoiceSamples(from: url)
        }
        .sheet(isPresented: $showingCreateMemory) {
            if let ownerContactId = model.workspace?.memory.ownerContactId {
                NavigationStack { MemoryEditor(ownerContactId: ownerContactId, fact: nil) }
            }
        }
        .sheet(item: $editingFact) { fact in
            NavigationStack {
                MemoryEditor(
                    ownerContactId: model.workspace?.memory.ownerContactId ?? "",
                    fact: fact
                )
            }
        }
        .sheet(isPresented: $showingPersonCreator) {
            NavigationStack { PersonEditor(person: nil) }
        }
        .sheet(item: $editingPerson) { person in
            NavigationStack { PersonEditor(person: person) }
        }
        .sheet(item: $addingFactForPerson) { person in
            NavigationStack { MemoryEditor(ownerContactId: person.id, fact: nil) }
        }
        .sheet(item: $managingPerson) { person in
            NavigationStack { PersonDetailsView(person: person) }
        }
        .confirmationDialog(
            "Forget this memory?",
            isPresented: Binding(
                get: { forgettingFact != nil },
                set: { if !$0 { forgettingFact = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let fact = forgettingFact {
                Button("Forget permanently", role: .destructive) {
                    perform(fact, action: "forget")
                    forgettingFact = nil
                }
                Button("Cancel", role: .cancel) { forgettingFact = nil }
            }
        } message: {
            Text("This removes the fact and prevents it from being saved again from the same source text.")
        }
        .confirmationDialog(
            "Delete this person?",
            isPresented: Binding(
                get: { deletingPerson != nil },
                set: { if !$0 { deletingPerson = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let person = deletingPerson {
                Button("Delete person and facts", role: .destructive) {
                    profileActionInFlight = person.id
                    Task {
                        _ = await model.deletePerson(person)
                        profileActionInFlight = nil
                    }
                    deletingPerson = nil
                }
            }
            Button("Cancel", role: .cancel) { deletingPerson = nil }
        }
    }

    private func memoryContent(_ memory: WorkspaceMemory) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            memoryOverview(memory)
            NavigationLink {
                KnowledgeView()
            } label: {
                Label("Connections and cleanup", systemImage: "point.3.connected.trianglepath.dotted")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.bordered)
            metricGrid([
                ("In use", memory.health.totalUsable, "brain.head.profile", AssistantTheme.accent(for: colorScheme)),
                ("Review", memory.health.awaitingReview, "checklist", AssistantTheme.warning(for: colorScheme)),
                ("Verified", memory.health.ownerConfirmed, "checkmark.seal", AssistantTheme.success(for: colorScheme)),
            ])

            if memory.health.notYetOrganized > 0 || memory.latestOrganizer != nil {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Memory organizer").font(.headline)
                    Text(
                        memory.latestOrganizer.map {
                            "\($0.progress) · \(relative($0.updatedAt))"
                        } ?? "\(memory.health.notYetOrganized) facts are waiting to be organized."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Button("Organize now", systemImage: "sparkles") {
                        updateProfile(action: "organize")
                    }
                    .buttonStyle(.bordered)
                    .disabled(profileActionInFlight != nil)
                }
                .assistantPanel(in: colorScheme)
            }

            if let card = memory.card {
                DisclosureGroup("Used in conversations") {
                    Text(card.content)
                        .font(.subheadline)
                        .padding(.top, 8)
                    Button("Refresh summary", systemImage: "arrow.clockwise") {
                        updateProfile(action: "recompile")
                    }
                    .buttonStyle(.bordered)
                    .padding(.top, 8)
                }
                .assistantPanel(in: colorScheme)
            }

            if !memory.awaitingReview.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    sectionHeading("Waiting on you", count: memory.awaitingReview.count)
                    Text("These notes came from an unverified source. They stay out of the assistant’s working context until you approve them.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(memory.awaitingReview) { fact in
                        reviewCard(fact)
                    }
                }
            }

            HStack(alignment: .firstTextBaseline) {
                sectionHeading(
                    memory.ownerName.map { "About \($0)" } ?? "Memory library",
                    count: memory.facts.count
                )
                Spacer()
                if memory.ownerContactId == nil {
                    Text("Owner profile unavailable")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if memory.facts.isEmpty {
                AssistantEmptyState(
                    "Nothing saved yet",
                    systemImage: "brain",
                    description: "Add a fact the assistant should retain for future conversations."
                )
            } else {
                ForEach(memory.facts) { fact in
                    factCard(fact)
                }
            }

            if let people = memory.people {
                ViewThatFits(in: .horizontal) {
                    HStack {
                        peopleHeading(count: people.count)
                        Spacer()
                        Button("Add", systemImage: "person.badge.plus") {
                            showingPersonCreator = true
                        }
                        .buttonStyle(.bordered)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        peopleHeading(count: people.count)
                        Button("Add", systemImage: "person.badge.plus") {
                            showingPersonCreator = true
                        }
                        .buttonStyle(.bordered)
                    }
                }
                if people.isEmpty {
                    AssistantEmptyState("No people yet", systemImage: "person.2")
                } else {
                    ForEach(people) { person in
                        personCard(person)
                    }
                }
            }

            if let voice = memory.voiceStats {
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Your writing voice").font(.headline)
                        Text("\(voice.total) samples · \(voice.auto) learned · \(voice.uploaded) uploaded")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Picker("Style", selection: $voiceRegister) {
                        Text("Casual email").tag("email_casual")
                        Text("Professional email").tag("email_professional")
                        Text("Text messages").tag("sms")
                        Text("Chat").tag("chat")
                    }
                    AssistantFlowLayout(spacing: 9) {
                        Button("Upload sent messages", systemImage: "square.and.arrow.up") {
                            showingVoiceImporter = true
                        }
                        .buttonStyle(.borderedProminent)
                        if voice.auto + voice.uploaded > 0 {
                            Button("Clear", role: .destructive) {
                                updateProfile(action: "purge-voice")
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .disabled(profileActionInFlight != nil)
                }
                .assistantPanel(in: colorScheme)
            }
        }
    }

    private func memoryOverview(_ memory: WorkspaceMemory) -> some View {
        HStack(alignment: .top, spacing: 12) {
            AssistantGlyph(systemName: "brain.head.profile", tint: AssistantTheme.accent(for: colorScheme))
            VStack(alignment: .leading, spacing: 4) {
                Text(memory.ownerName.map { "\($0)'s memory" } ?? "Memory library")
                    .font(.headline)
                Text("Only verified, relevant facts are used in future conversations.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .assistantPanel(in: colorScheme)
    }

    /// Memory keeps the person editors; browsing lives in People, so the
    /// heading links there rather than duplicating the directory.
    private func peopleHeading(count: Int) -> some View {
        HStack(spacing: 7) {
            sectionHeading("People", count: count)
            Spacer(minLength: 8)
            Button {
                model.presentedRoute = .people
            } label: {
                Label("Open People", systemImage: "person.2")
                    .font(.caption.weight(.semibold))
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.borderless)
        }
    }

    private func personCard(_ person: WorkspacePerson) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            AssistantFlowLayout(spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(person.name).font(.headline)
                    Text(person.relationship.isEmpty ? "Relationship not set" : person.relationship)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                memoryTag("\(person.factCount) facts")
                if person.trust == "unknown" { memoryTag("Unverified") }
            }
            AssistantFlowLayout(spacing: 9) {
                Button("Manage", systemImage: "person.crop.circle") { managingPerson = person }
                    .buttonStyle(.borderedProminent)
                Button("Add fact", systemImage: "plus") { addingFactForPerson = person }
                    .buttonStyle(.bordered)
                Button("Edit", systemImage: "pencil") { editingPerson = person }
                    .buttonStyle(.bordered)
                Button("Delete", systemImage: "trash", role: .destructive) {
                    deletingPerson = person
                }
                .buttonStyle(.bordered)
            }
        }
        .assistantCard(in: colorScheme)
    }

    private func reviewCard(_ fact: WorkspaceMemoryFact) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            factIdentity(fact, review: true)
            AssistantFlowLayout(spacing: 9) {
                Button {
                    perform(fact, action: "approve")
                } label: {
                    actionLabel(fact, action: "approve", title: "Approve", icon: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .tint(AssistantTheme.accent(for: colorScheme))

                Button(role: .destructive) {
                    perform(fact, action: "reject")
                } label: {
                    actionLabel(fact, action: "reject", title: "Reject", icon: "xmark")
                }
                .buttonStyle(.bordered)
            }
            .disabled(pendingFactID != nil)
        }
        .assistantCard(
            in: colorScheme,
            surface: AssistantTheme.warningSurface(for: colorScheme),
            strokeTint: AssistantTheme.warning(for: colorScheme)
        )
    }

    private func factCard(_ fact: WorkspaceMemoryFact) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            factIdentity(fact, review: false)
            AssistantFlowLayout(spacing: 9) {
                if !fact.ownerConfirmed {
                    Button {
                        perform(fact, action: "confirm")
                    } label: {
                        actionLabel(fact, action: "confirm", title: "Confirm", icon: "checkmark.seal")
                    }
                    .buttonStyle(.bordered)
                }

                Menu {
                    Section("In conversations") {
                        Button("Always in profile") { perform(fact, action: "prominence", prominence: "always") }
                        Button("When relevant") { perform(fact, action: "prominence", prominence: "auto") }
                        Button("Minor detail") { perform(fact, action: "prominence", prominence: "minor") }
                    }
                    Button("Correct", systemImage: "pencil") {
                        editingFact = fact
                    }
                    Button("Forget", systemImage: "trash", role: .destructive) {
                        forgettingFact = fact
                    }
                } label: {
                    Label("Manage · \(prominenceLabel(fact))", systemImage: "ellipsis.circle")
                }
                .buttonStyle(.bordered)
            }
            .font(.subheadline)
            .disabled(pendingFactID != nil)
        }
        .assistantCard(in: colorScheme)
    }

    private func factIdentity(_ fact: WorkspaceMemoryFact, review: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: review ? "questionmark.circle.fill" : (fact.pinned ? "pin.fill" : "brain"))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(review ? AssistantTheme.warningInk(for: colorScheme) : AssistantTheme.accent(for: colorScheme))
                .frame(width: 32, height: 32)
                .background(
                    (review ? AssistantTheme.warning(for: colorScheme) : AssistantTheme.accent(for: colorScheme)).opacity(0.12),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
            VStack(alignment: .leading, spacing: 5) {
                Text(fact.content)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                AssistantFlowLayout(spacing: 6) {
                    memoryTag(fact.domain?.sentenceCaseIdentifier ?? "General")
                    if fact.pinned { memoryTag("In profile") }
                    if fact.ownerConfirmed { memoryTag("Verified") }
                    if !review && !fact.ownerConfirmed { memoryTag("Needs confirmation") }
                }
                Text("Saved \(relative(fact.createdAt))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func memoryTag(_ label: String) -> some View {
        Text(label)
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 6)
            .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
    }

    @ViewBuilder
    private func actionLabel(_ fact: WorkspaceMemoryFact, action: String, title: String, icon: String) -> some View {
        if pendingFactID == "\(action):\(fact.id)" {
            HStack(spacing: 7) {
                ProgressView().controlSize(.small)
                Text("Updating…")
            }
        } else {
            Label(title, systemImage: icon)
        }
    }

    private func prominenceLabel(_ fact: WorkspaceMemoryFact) -> String {
        if fact.pinned { return "Always" }
        return fact.importance <= 1 ? "Minor" : "Relevant"
    }

    private func perform(_ fact: WorkspaceMemoryFact, action: String, prominence: String? = nil) {
        pendingFactID = "\(action):\(fact.id)"
        Task {
            _ = await model.updateMemory(id: fact.id, action: action, prominence: prominence)
            pendingFactID = nil
        }
    }

    private func updateProfile(action: String) {
        profileActionInFlight = action
        Task {
            _ = await model.updateMemoryProfile(action: action)
            profileActionInFlight = nil
        }
    }

    private func uploadVoiceSamples(from url: URL) {
        profileActionInFlight = "voice-upload"
        Task {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                guard data.count <= 25 * 1024 * 1024 else {
                    model.errorMessage = "Writing sample uploads must be 25 MB or smaller."
                    profileActionInFlight = nil
                    return
                }
                _ = await model.uploadImport(
                    data: data,
                    name: url.lastPathComponent,
                    voice: true,
                    register: voiceRegister
                )
            } catch {
                model.errorMessage = error.localizedDescription
            }
            profileActionInFlight = nil
        }
    }

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    private func sectionHeading(_ title: String, count: Int? = nil) -> some View {
        HStack(spacing: 7) {
            Text(title).font(.headline)
            if let count {
                // Same capsule the workspace pages use for heading counts.
                Text("\(count)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 5)
                    .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
            }
        }
    }

    @ViewBuilder
    private func metricGrid(_ metrics: [(String, Int, String, Color)]) -> some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: usesAccessibilityLayout ? 1 : 3),
            spacing: 10
        ) {
            ForEach(Array(metrics.enumerated()), id: \.offset) { _, metric in
                metricCard(metric)
            }
        }
    }

    private func metricCard(_ metric: (String, Int, String, Color)) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Image(systemName: metric.2)
                .font(.caption.weight(.semibold))
                .foregroundStyle(metric.3)
            Text("\(metric.1)")
                .font(.title3.monospacedDigit().weight(.semibold))
            Text(metric.0)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantCard(in: colorScheme)
    }
}

private struct PersonDetailsView: View {
    let person: WorkspacePerson

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var showingOccasionEditor = false
    @State private var mergeTarget = ""
    @State private var isWorking = false

    private var profile: PersonProfileResponse? { model.personProfiles[person.id] }

    var body: some View {
        Form {
            if let profile {
                Section("Details") {
                    LabeledContent("Relationship", value: profile.contact.relationship.isEmpty
                        ? "Not set"
                        : profile.contact.relationship)
                    if !profile.contact.aliases.isEmpty {
                        LabeledContent("Aliases", value: profile.contact.aliases.joined(separator: ", "))
                    }
                }

                Section {
                    if profile.occasions.isEmpty {
                        Text("No birthdays or anniversaries saved.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(profile.occasions) { occasion in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(occasion.label.isEmpty
                                    ? occasion.kind.sentenceCaseIdentifier
                                    : occasion.label)
                                Text(occasionDate(occasion))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                HStack {
                                    if occasion.quarantined {
                                        Button("Approve") {
                                            review(occasion, verdict: "approve")
                                        }
                                        Button("Reject", role: .destructive) {
                                            review(occasion, verdict: "reject")
                                        }
                                    }
                                    Button("Delete", role: .destructive) {
                                        delete(occasion)
                                    }
                                }
                                .font(.caption)
                                .disabled(isWorking)
                            }
                        }
                    }
                    Button("Add occasion", systemImage: "calendar.badge.plus") {
                        showingOccasionEditor = true
                    }
                } header: {
                    Text("Important dates")
                }

                if !profile.mergeOptions.isEmpty {
                    Section {
                        Picker("Merge into", selection: $mergeTarget) {
                            Text("Choose a person").tag("")
                            ForEach(profile.mergeOptions) { option in
                                Text(option.label).tag(option.id)
                            }
                        }
                        Button("Merge person", role: .destructive) {
                            guard !mergeTarget.isEmpty else { return }
                            isWorking = true
                            Task {
                                let merged = await model.mergePerson(person, targetId: mergeTarget)
                                isWorking = false
                                if merged { dismiss() }
                            }
                        }
                        .disabled(isWorking || mergeTarget.isEmpty)
                    } header: {
                        Text("Merge")
                    } footer: {
                        Text("Moves every saved fact onto the selected person and removes this duplicate.")
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(person.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
        .task { await model.loadPersonProfile(id: person.id) }
        .sheet(isPresented: $showingOccasionEditor) {
            NavigationStack { OccasionEditor(personId: person.id) }
        }
    }

    private func occasionDate(_ occasion: PersonOccasion) -> String {
        let month = DateFormatter().monthSymbols[max(0, min(11, occasion.month - 1))]
        return [month, String(occasion.day), occasion.year.map { String($0) }]
            .compactMap { $0 }
            .joined(separator: " ")
    }

    private func review(_ occasion: PersonOccasion, verdict: String) {
        isWorking = true
        Task {
            _ = await model.reviewOccasion(
                personId: person.id,
                occasion: occasion,
                verdict: verdict
            )
            isWorking = false
        }
    }

    private func delete(_ occasion: PersonOccasion) {
        isWorking = true
        Task {
            _ = await model.deleteOccasion(personId: person.id, occasion: occasion)
            isWorking = false
        }
    }
}

private struct OccasionEditor: View {
    let personId: String

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "birthday"
    @State private var label = ""
    @State private var month = ""
    @State private var day = ""
    @State private var year = ""
    @State private var leadDays = "7"
    @State private var notes = ""
    @State private var isSaving = false

    var body: some View {
        Form {
            Section("Occasion") {
                Picker("Type", selection: $kind) {
                    Text("Birthday").tag("birthday")
                    Text("Anniversary").tag("anniversary")
                    Text("Other").tag("custom")
                }
                TextField("Label", text: $label)
                TextField("Month", text: $month).keyboardType(.numberPad)
                TextField("Day", text: $day).keyboardType(.numberPad)
                TextField("Year (optional)", text: $year).keyboardType(.numberPad)
                TextField("Remind days ahead", text: $leadDays).keyboardType(.numberPad)
                TextField("Notes", text: $notes, axis: .vertical)
            }
        }
        .navigationTitle("Add occasion")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(isSaving || month.isEmpty || day.isEmpty)
            }
        }
    }

    private func save() {
        isSaving = true
        Task {
            let saved = await model.addOccasion(
                personId: personId,
                mutation: .init(
                    kind: kind,
                    label: label,
                    month: month,
                    day: day,
                    year: year,
                    leadDays: leadDays,
                    notes: notes
                )
            )
            isSaving = false
            if saved { dismiss() }
        }
    }
}

private struct PersonEditor: View {
    let person: WorkspacePerson?

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var relationship: String
    @State private var aliases: String
    @State private var isSaving = false

    init(person: WorkspacePerson?) {
        self.person = person
        _name = State(initialValue: person?.name ?? "")
        _relationship = State(initialValue: person?.relationship ?? "")
        _aliases = State(initialValue: person?.aliases.joined(separator: ", ") ?? "")
    }

    var body: some View {
        Form {
            Section("Person") {
                TextField("Name", text: $name)
                TextField("Relationship", text: $relationship)
                TextField("Aliases, separated by commas", text: $aliases, axis: .vertical)
                    .lineLimit(2...5)
            }
        }
        .navigationTitle(person == nil ? "Add person" : "Edit person")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(isSaving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func save() {
        isSaving = true
        Task {
            let saved = await model.savePerson(
                id: person?.id,
                mutation: .init(name: name, relationship: relationship, aliases: aliases)
            )
            isSaving = false
            if saved { dismiss() }
        }
    }
}

private struct MemoryEditor: View {
    let ownerContactId: String
    let fact: WorkspaceMemoryFact?

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var content: String
    @State private var domain: String
    @State private var importance: Int
    @State private var pinned: Bool
    @State private var isSaving = false

    init(ownerContactId: String, fact: WorkspaceMemoryFact?) {
        self.ownerContactId = ownerContactId
        self.fact = fact
        _content = State(initialValue: fact?.content ?? "")
        _domain = State(initialValue: fact?.domain ?? "other")
        _importance = State(initialValue: fact?.importance ?? 3)
        _pinned = State(initialValue: fact?.pinned ?? false)
    }

    var body: some View {
        Form {
            Section(fact == nil ? "New fact" : "Correction") {
                TextField("Something durable the assistant should remember", text: $content, axis: .vertical)
                    .lineLimit(3...8)
            }
            if fact == nil {
                Section("How it should be used") {
                    Picker("Topic", selection: $domain) {
                        ForEach(["identity", "work", "home", "relationships", "preferences", "health", "other"], id: \.self) { value in
                            Text(value.sentenceCaseIdentifier).tag(value)
                        }
                    }
                    Picker("Importance", selection: $importance) {
                        Text("Very high").tag(5)
                        Text("High").tag(4)
                        Text("Normal").tag(3)
                        Text("Low").tag(2)
                        Text("Minor").tag(1)
                    }
                    Toggle("Keep in profile summary", isOn: $pinned)
                }
            }
        }
        .navigationTitle(fact == nil ? "Add memory" : "Correct memory")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(isSaving || content.trimmingCharacters(in: .whitespacesAndNewlines).count < 3)
            }
        }
    }

    private func save() {
        isSaving = true
        Task {
            let succeeded: Bool
            if let fact {
                succeeded = await model.correctMemory(id: fact.id, content: content)
            } else {
                succeeded = await model.createMemory(MemoryMutation(
                    content: content,
                    domain: domain,
                    importance: importance,
                    pinned: pinned,
                    subjectContactId: ownerContactId
                ))
            }
            isSaving = false
            if succeeded { dismiss() }
        }
    }
}
