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
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var showingCreateMemory = false
    @State private var editingFact: WorkspaceMemoryFact?
    @State private var pendingFactID: String?
    @State private var showingPersonCreator = false
    @State private var editingPerson: WorkspacePerson?
    @State private var addingFactForPerson: WorkspacePerson?
    @State private var managingPerson: WorkspacePerson?
    @State private var profileActionInFlight: String?
    @State private var showingVoiceImporter = false
    @State private var showingVoiceProfile = false
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
            .frame(maxWidth: isLandscape ? 760 : .infinity, alignment: .leading)
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
                if case let .failure(error) = result { model.reportError(error) }
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
            NavigationStack { PersonDetailsView(personId: person.id, personName: person.name) }
        }
        .sheet(isPresented: $showingVoiceProfile) {
            NavigationStack { VoiceProfileEditor() }
        }
    }

    private var isLandscape: Bool { verticalSizeClass == .compact }

    private func memoryContent(_ memory: WorkspaceMemory) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            memoryOverview(memory)
            NavigationLink {
                KnowledgeView()
            } label: {
                Label("Connections and cleanup", systemImage: "point.3.connected.trianglepath.dotted")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
            NavigationLink {
                MemoryLibraryScreen()
            } label: {
                Label("Browse the whole library", systemImage: "books.vertical")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
            NavigationLink {
                MemoryDataScreen()
            } label: {
                Label("Your data", systemImage: "arrow.down.circle")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
            metricGrid([
                ("In use", memory.health.totalUsable, "brain.head.profile", AssistantTheme.accent(for: colorScheme)),
                ("Review", memory.health.awaitingReview, "checklist", AssistantTheme.warning(for: colorScheme)),
                ("Verified", memory.health.ownerConfirmed, "checkmark.seal", AssistantTheme.success(for: colorScheme)),
            ])

            if memory.health.notYetOrganized > 0 || memory.latestOrganizer != nil {
                MemoryOrganizerPanel(
                    pendingCount: memory.health.notYetOrganized,
                    latest: memory.latestOrganizer,
                    requestInFlight: profileActionInFlight != nil
                ) {
                    updateProfile(action: "organize")
                }
            }

            if let card = memory.card {
                DisclosureGroup("Used in conversations") {
                    Text(card.content)
                        .font(.subheadline)
                        .padding(.top, 8)
                    Button("Refresh summary", systemImage: "arrow.clockwise") {
                        updateProfile(action: "recompile")
                    }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
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
                        .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        peopleHeading(count: people.count)
                        Button("Add", systemImage: "person.badge.plus") {
                            showingPersonCreator = true
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
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
                        .buttonStyle(AssistantActionButtonStyle(kind: .primary))
                        Button("Edit voice", systemImage: "pencil") {
                            showingVoiceProfile = true
                        }
                        .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                        if voice.auto + voice.uploaded > 0 {
                            AssistantConfirmationButton("Clear") {
                                updateProfile(action: "purge-voice")
                            }
                            .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
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
                    // The design system puts a 44pt floor on every other
                    // control; caption-sized content alone falls well under it.
                    .frame(minHeight: 44)
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
                    .buttonStyle(AssistantActionButtonStyle(kind: .primary))
                Button("Add fact", systemImage: "plus") { addingFactForPerson = person }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                Button("Edit", systemImage: "pencil") { editingPerson = person }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                AssistantConfirmationButton("Delete", hint: "Deletes this person and their saved facts.") {
                    profileActionInFlight = person.id
                    _ = await model.deletePerson(id: person.id)
                    profileActionInFlight = nil
                }
                .disabled(profileActionInFlight != nil)
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
                .buttonStyle(AssistantActionButtonStyle(kind: .primary))
                .tint(AssistantTheme.accent(for: colorScheme))

                AssistantConfirmationButton("Reject", systemImage: "xmark") {
                    perform(fact, action: "reject")
                }
            }
            .disabled(isBusy(fact))
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
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
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
                } label: {
                    Label("Manage · \(prominenceLabel(fact))", systemImage: "ellipsis.circle")
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                AssistantConfirmationButton("Forget", hint: "Removes this fact and prevents relearning it from the same source text.") {
                    perform(fact, action: "forget")
                }
            }
            .font(.subheadline)
            .disabled(isBusy(fact))
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

    /// True only while an action on THIS fact is in flight. pendingFactID
    /// carries "action:id" so actionLabel can spin the one button that was
    /// pressed; gating .disabled on `!= nil` froze every other fact's buttons
    /// as well — the same defect already fixed per-row in the library screen.
    private func isBusy(_ fact: WorkspaceMemoryFact) -> Bool {
        pendingFactID?.hasSuffix(":\(fact.id)") ?? false
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
                model.reportError(error)
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

/// A maintenance receipt, not a second dashboard. Keep raw run details
/// available without making a completed maintenance log lead the memory page.
struct MemoryOrganizerPanel: View {
    let pendingCount: Int
    let latest: WorkspaceMemoryOrganizer?
    let requestInFlight: Bool
    let organize: () -> Void
    @State var showsDetails = false
    @Environment(\.colorScheme) private var colorScheme

    static func statusLabel(_ status: String?) -> String {
        switch status {
        case "done": "Last run completed"
        case "pending", "running": "Organizing memory"
        case "failed": "Last run failed"
        case "cancelled": "Last run stopped"
        case nil: "Ready to organize"
        default: "Organizer update"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                AssistantGlyph(systemName: "tray.2", tint: AssistantTheme.accent(for: colorScheme), variant: .inline)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Memory organizer").font(.subheadline.weight(.semibold))
                    Text(Self.statusLabel(latest?.status)).font(.caption)
                        .foregroundStyle(latest?.status == "failed"
                            ? AssistantTheme.errorInk(for: colorScheme) : AssistantTheme.inkMuted(for: colorScheme))
                }
            }
            if pendingCount > 0 {
                Text("\(pendingCount) \(pendingCount == 1 ? "fact is" : "facts are") waiting to be organized.")
                    .font(.subheadline).fixedSize(horizontal: false, vertical: true)
            }
            if let latest {
                DisclosureGroup("Run details", isExpanded: $showsDetails) {
                    VStack(alignment: .leading, spacing: 8) {
                        if !latest.progress.isEmpty {
                            Text(latest.progress).font(.subheadline)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Text("Updated \(relative(latest.updatedAt))").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .font(.subheadline)
                .disclosureGroupStyle(AssistantEvidenceDisclosureStyle())
            }
            Button(action: organize) {
                HStack(spacing: 7) {
                    if requestInFlight { ProgressView().controlSize(.small) }
                    else { Image(systemName: "sparkles") }
                    Text(requestInFlight ? "Updating…" : "Organize now")
                }
            }
            .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
            .disabled(requestInFlight)
        }
        .assistantPanel(in: colorScheme)
    }
}

/// Everything you can change about one person: relationship, aliases, their
/// dates, merging a duplicate away. Reached from Memory and from the People
/// directory, which is why it takes an id rather than a workspace row — People
/// has a PersonCard in hand, not the same struct Memory does.
struct PersonDetailsView: View {
    let personId: String
    let personName: String

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingOccasionEditor = false
    @State private var editingOccasion: PersonOccasion?
    /// Suggestions already saved in this sitting. The profile only reloads on
    /// the next fetch, so without this a just-saved date stays on offer.
    @State private var savedSuggestions: Set<String> = []
    @State private var editingContact: PersonProfileContact?
    @State private var mergeTarget = ""
    @State private var isWorking = false

    private var profile: PersonProfileResponse? { model.personProfiles[personId] }

    var body: some View {
        AssistantForm {
            if let profile {
                Section("Details") {
                    LabeledContent("Relationship", value: profile.contact.relationship.isEmpty
                        ? "Not set"
                        : profile.contact.relationship)
                    if !profile.contact.aliases.isEmpty {
                        LabeledContent("Aliases", value: profile.contact.aliases.joined(separator: ", "))
                    }
                    Button("Edit name and relationship", systemImage: "pencil") {
                        editingContact = profile.contact
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
                                AssistantFlowLayout(spacing: 8) {
                                    Button("Edit") { editingOccasion = occasion }
                                    if occasion.quarantined {
                                        Button("Approve") {
                                            review(occasion, verdict: "approve")
                                        }
                                        AssistantConfirmationButton("Reject", systemImage: "xmark") {
                                            review(occasion, verdict: "reject")
                                        }
                                    }
                                    AssistantConfirmationButton("Delete") {
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
                    // Dates the extractor already found in this person's facts
                    // but that are not recurring reminders yet. The endpoint
                    // has always sent them; web offers the same one-tap save.
                    if !visibleSuggestions.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Found in saved facts — save any of these as a recurring reminder:")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            AssistantFlowLayout(spacing: 8) {
                                ForEach(visibleSuggestions) { suggestion in
                                    Button {
                                        save(suggestion)
                                    } label: {
                                        Text("+ \(suggestionLabel(suggestion))")
                                            .font(.caption)
                                    }
                                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                                    .disabled(isWorking)
                                }
                            }
                        }
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
                        AssistantConfirmationButton("Merge person", systemImage: "person.2", hint: "Moves all saved facts to the selected person and removes this duplicate.") {
                            guard !mergeTarget.isEmpty else { return }
                            isWorking = true
                            Task {
                                let merged = await model.mergePerson(id: personId, targetId: mergeTarget)
                                isWorking = false
                                if merged { dismiss() }
                            }
                        }
                        .id(mergeTarget)
                        .disabled(isWorking || mergeTarget.isEmpty)
                    } header: {
                        // Web badges this as "possible duplicate" with the
                        // reason; without it the phone gave no clue why these
                        // merge options were being offered at all.
                        if let duplicate = profile.duplicate {
                            Label("Possible duplicate — \(duplicate.reason)", systemImage: "exclamationmark.triangle")
                                .font(.caption)
                                .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                        } else {
                            Text("Merge")
                        }
                    } footer: {
                        Text("Moves every saved fact onto the selected person and removes this duplicate.")
                    }
                }

                Section {
                    AssistantConfirmationButton(
                        "Delete \(personName)",
                        confirmationTitle: "Delete for good",
                        hint: "Removes this person and every fact saved about them.",
                        fillsWidth: true
                    ) {
                        isWorking = true
                        let deleted = await model.deletePerson(id: personId)
                        isWorking = false
                        if deleted { dismiss() }
                    }
                    .disabled(isWorking)
                } header: {
                    Text("Remove")
                } footer: {
                    Text("This cannot be undone.")
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(personName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
        .task { await model.loadPersonProfile(id: personId) }
        .sheet(isPresented: $showingOccasionEditor) {
            NavigationStack { OccasionEditor(personId: personId) }
        }
        .sheet(item: $editingOccasion) { occasion in
            NavigationStack { OccasionEditor(personId: personId, occasion: occasion) }
        }
        .sheet(item: $editingContact) { contact in
            NavigationStack { PersonEditor(contact: contact) }
        }
    }

    private var visibleSuggestions: [PersonOccasionSuggestion] {
        (profile.occasionSuggestions ?? []).filter { !savedSuggestions.contains($0.id) }
    }

    private func suggestionLabel(_ suggestion: PersonOccasionSuggestion) -> String {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMMMd")
        let date = Calendar.current.date(from: DateComponents(year: 2024, month: suggestion.month, day: suggestion.day))
        let day = date.map(formatter.string(from:)) ?? "\(suggestion.month)/\(suggestion.day)"
        return "\(day) · \(suggestion.kind)"
    }

    private func save(_ suggestion: PersonOccasionSuggestion) {
        isWorking = true
        Task {
            let saved = await model.addOccasion(
                personId: personId,
                mutation: OccasionMutation(
                    kind: suggestion.kind,
                    label: "",
                    month: String(suggestion.month),
                    day: String(suggestion.day),
                    year: "",
                    leadDays: "7",
                    notes: ""
                )
            )
            isWorking = false
            if saved { savedSuggestions.insert(suggestion.id) }
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
                personId: personId,
                occasion: occasion,
                verdict: verdict
            )
            isWorking = false
        }
    }

    private func delete(_ occasion: PersonOccasion) {
        isWorking = true
        Task {
            _ = await model.deleteOccasion(personId: personId, occasion: occasion)
            isWorking = false
        }
    }
}

struct OccasionEditor: View {
    let personId: String
    let occasion: PersonOccasion?

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var kind = "birthday"
    @State private var label = ""
    @State private var month = ""
    @State private var day = ""
    @State private var year = ""
    @State private var leadDays = "7"
    @State private var notes = ""
    @State private var isSaving = false
    @State private var failure: String?

    init(personId: String, occasion: PersonOccasion? = nil) {
        self.personId = personId
        self.occasion = occasion
        _kind = State(initialValue: occasion?.kind ?? "birthday")
        _label = State(initialValue: occasion?.label ?? "")
        _month = State(initialValue: occasion.map { String($0.month) } ?? "")
        _day = State(initialValue: occasion.map { String($0.day) } ?? "")
        _year = State(initialValue: occasion?.year.map { String($0) } ?? "")
        _leadDays = State(initialValue: String(occasion?.leadDays ?? 7))
        _notes = State(initialValue: occasion?.notes ?? "")
    }

    var body: some View {
        AssistantForm {
            Section("Occasion") {
                Picker("Type", selection: $kind) {
                    Text("Birthday").tag("birthday")
                    Text("Anniversary").tag("anniversary")
                    Text("Other").tag("custom")
                }
                if kind == "custom" { LabeledContent("Label") { TextField("Occasion name", text: $label).multilineTextAlignment(.trailing) } }
                Picker("Month", selection: $month) {
                    Text("Choose month").tag("")
                    ForEach(1...12, id: \.self) { number in
                        Text(DateFormatter().monthSymbols[number - 1]).tag(String(number))
                    }
                }
                LabeledContent("Day") { TextField("Day", text: $day).keyboardType(.numberPad).multilineTextAlignment(.trailing) }
                LabeledContent("Year (optional)") { TextField("Unknown", text: $year).keyboardType(.numberPad).multilineTextAlignment(.trailing) }
                LabeledContent("Remind days before") { TextField("7", text: $leadDays).keyboardType(.numberPad).multilineTextAlignment(.trailing) }
                LabeledContent("Notes") { TextField("Gift ideas", text: $notes, axis: .vertical).multilineTextAlignment(.trailing) }
            }
            .disabled(isSaving)
            if let failure {
                Section { Text(failure).foregroundStyle(AssistantTheme.errorInk(for: colorScheme)) }
            }
        }
        .interactiveDismissDisabled(isSaving)
        .navigationTitle(occasion == nil ? "Add occasion" : "Edit occasion")
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
        failure = nil
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
                ),
                occasionId: occasion?.id
            )
            isSaving = false
            if saved { dismiss() } else { failure = model.errorMessage ?? "Couldn’t save this date. Try again." }
        }
    }
}

struct PersonEditor: View {
    /// The id being edited; nil creates a new person.
    private let personId: String?

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var relationship: String
    @State private var aliases: String
    @State private var isSaving = false

    init(person: WorkspacePerson?) {
        personId = person?.id
        _name = State(initialValue: person?.name ?? "")
        _relationship = State(initialValue: person?.relationship ?? "")
        _aliases = State(initialValue: person?.aliases.joined(separator: ", ") ?? "")
    }

    /// The same editor from a loaded profile, which is what the People
    /// directory has rather than a workspace row.
    init(contact: PersonProfileContact) {
        personId = contact.id
        _name = State(initialValue: contact.name)
        _relationship = State(initialValue: contact.relationship)
        _aliases = State(initialValue: contact.aliases.joined(separator: ", "))
    }

    var body: some View {
        AssistantForm {
            Section("Person") {
                TextField("Name", text: $name)
                TextField("Relationship", text: $relationship)
                TextField("Aliases, separated by commas", text: $aliases, axis: .vertical)
                    .lineLimit(2...5)
            }
        }
        .navigationTitle(personId == nil ? "Add person" : "Edit person")
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
                id: personId,
                mutation: .init(name: name, relationship: relationship, aliases: aliases)
            )
            isSaving = false
            if saved { dismiss() }
        }
    }
}

struct MemoryEditor: View {
    private let ownerContactId: String
    /// The fact being corrected; nil creates a new one.
    private let factId: String?

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var content: String
    @State private var domain: String
    @State private var importance: Int
    @State private var pinned: Bool
    @State private var isSaving = false

    init(ownerContactId: String, fact: WorkspaceMemoryFact?) {
        self.ownerContactId = ownerContactId
        factId = fact?.id
        _content = State(initialValue: fact?.content ?? "")
        _domain = State(initialValue: fact?.domain ?? "other")
        _importance = State(initialValue: fact?.importance ?? 3)
        _pinned = State(initialValue: fact?.pinned ?? false)
    }

    /// Correcting a row from the library, which carries the same fields under a
    /// different type. Creation never starts here, so no owner contact is needed.
    init(row: MemoryLibraryRow) {
        ownerContactId = ""
        factId = row.id
        _content = State(initialValue: row.content)
        _domain = State(initialValue: row.domain.isEmpty ? "other" : row.domain)
        _importance = State(initialValue: row.importance)
        _pinned = State(initialValue: row.pinned)
    }

    var body: some View {
        AssistantForm {
            Section(factId == nil ? "New fact" : "Correction") {
                TextField("Something durable the assistant should remember", text: $content, axis: .vertical)
                    .lineLimit(3...8)
            }
            if factId == nil {
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
        .navigationTitle(factId == nil ? "Add memory" : "Correct memory")
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
            if let factId {
                succeeded = await model.correctMemory(id: factId, content: content)
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

/// Dates are editable where people are read, without a detour through Memory.
struct PersonDatesScreen: View {
    let personId: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var editing: PersonOccasion?
    @State private var adding = false

    var body: some View {
        AssistantForm {
            if let profile = model.personProfiles[personId] {
                Section("Important dates") {
                    ForEach(profile.occasions) { occasion in
                        Button { editing = occasion } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(occasion.label.isEmpty ? occasion.kind.sentenceCaseIdentifier : occasion.label)
                                    Text("\(DateFormatter().monthSymbols[max(0, min(11, occasion.month - 1))]) \(occasion.day)" + (occasion.year.map { ", \($0)" } ?? ""))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "pencil").accessibilityLabel("Edit")
                            }.frame(minHeight: 44)
                        }.buttonStyle(.plain)
                    }
                    Button("Add birthday or occasion", systemImage: "calendar.badge.plus") { adding = true }
                }
            } else {
                ProgressView("Loading dates…")
                Button("Try again") { Task { await model.loadPersonProfile(id: personId) } }
            }
        }
        .navigationTitle("Important dates")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .task { await model.loadPersonProfile(id: personId) }
        .sheet(item: $editing) { occasion in
            NavigationStack { OccasionEditor(personId: personId, occasion: occasion) }
        }
        .sheet(isPresented: $adding) { NavigationStack { OccasionEditor(personId: personId) } }
    }
}
