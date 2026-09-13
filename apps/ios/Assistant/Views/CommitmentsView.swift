import SwiftUI

/// Open loops — promises, questions and follow-ups the assistant is tracking.
/// The memory desk has always shown these on the web; until now the phone had
/// no way to reach them, so a loop raised in conversation could only ever be
/// closed from a browser. The three verbs match the web hub exactly: Done
/// resolves, Later snoozes a day, Not relevant dismisses.
///
/// Built on the same ScrollView + VStack + `.assistantCard(in:)` structure as
/// every other screen (Goals, Approvals, the memory library, People) rather
/// than a List of Sections. `AssistantFlowLayout`, which lays out the action
/// row, is only ever proposed a concrete width inside a ScrollView — inside a
/// List it sizes itself against an unspecified width and then wraps its
/// buttons into rows it never accounted for, which is what made this one
/// screen's buttons clip and overlap.
struct CommitmentsScreen: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var rows: [Commitment] = []
    @State private var loaded = false
    @State private var loading = false
    /// Names the loop being acted on, so one row's action never disables the
    /// others — the mistake this app has made in four other lists.
    @State private var pendingID: String?
    @State private var correcting: Commitment?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                introCard
                if !loaded && loading {
                    AssistantLoadingState(title: "Loading open loops")
                } else if rows.isEmpty {
                    AssistantEmptyState(
                        "Nothing is waiting for your attention",
                        systemImage: "checkmark.circle",
                        description: "Decisions, questions and follow-ups appear here when the assistant is still holding one open.")
                } else {
                    ForEach(rows) { row in loopCard(row) }
                }
            }
            .padding(16)
            .padding(.bottom, 28)
        }
        .navigationTitle("Open loops")
        .assistantSubmenuChrome()
        .refreshable { await load() }
        .task { if !loaded { await load() } }
        .sheet(item: $correcting) { row in
            NavigationStack { CommitmentEditor(commitment: row, onSaved: { Task { await load() } }) }
        }
    }

    /// Always visible, including in the empty state — a first-time visitor
    /// needs to know what a "loop" is before an empty list can mean anything
    /// to them. The legend is the part worth hiding once that's learned.
    private var introCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Loops are the threads the assistant is still holding from your conversations — something you decided, asked, promised, or are waiting on. They stay here until you close them: **Done** resolves a loop, **Later** hides it for a day, **Correct** fixes what the assistant misheard, and **Not relevant** drops it for good. A loop you never touch retires itself eventually, and how long that takes depends on the kind.")
                .font(.subheadline)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
            DisclosureGroup("What the labels mean") {
                VStack(alignment: .leading, spacing: 10) {
                    legendRow(
                        title: "Decision",
                        description: "a choice you settled that is worth remembering.",
                        retires: "90 days")
                    legendRow(
                        title: "Question",
                        description: "something left unanswered.",
                        retires: "30 days")
                    legendRow(
                        title: "Promise",
                        description: "a concrete follow-up you said you would do.",
                        retires: "45 days")
                    legendRow(
                        title: "Waiting on",
                        description: "a reply, approval, or document you need from someone else.",
                        retires: "30 days")
                    Text("A loop that named a due date retires two weeks after it, whatever kind it is.")
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .font(.subheadline.weight(.semibold))
        }
        .assistantCard(in: colorScheme)
    }

    /// The retirement window is part of what the label means — a kind the
    /// assistant forgets in a month is a different promise to the owner than
    /// one it holds for a quarter, and this is the only screen that says so.
    private func legendRow(title: String, description: String, retires: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.subheadline.weight(.semibold))
            Text(description)
                .font(.caption)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
            Text("Retires after \(retires) untouched")
                .font(.caption2)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
        }
    }

    private func loopCard(_ row: Commitment) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(kindLabel(row.kind))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            Text(row.title).font(.subheadline.weight(.medium))
            if !row.nextAction.isEmpty {
                Text("Next: \(row.nextAction)")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            }
            if let due = dueLabel(row) {
                Text(due)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            }
            AssistantFlowLayout(spacing: 8) {
                Button("Done", systemImage: "checkmark") { act(row, action: "resolve") }
                    .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
                Button("Later", systemImage: "clock") { act(row, action: "snooze") }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                Button("Correct", systemImage: "pencil") { correcting = row }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                AssistantConfirmationButton(
                    "Not relevant",
                    systemImage: "xmark",
                    hint: "Stops the assistant bringing this loop back."
                ) {
                    await perform(row, action: "dismiss")
                }
            }
            .font(.caption)
            .disabled(pendingID == row.id)
        }
        .assistantCard(in: colorScheme)
    }

    /// `sentenceCaseIdentifier` title-cases every word of a machine
    /// identifier, which turns `waiting_on` into "Waiting On". Every other
    /// kind here is already one capitalized word, so only this one needs its
    /// own mapping rather than a change to the shared helper.
    private func kindLabel(_ kind: String) -> String {
        kind == "waiting_on" ? "Waiting on" : kind.sentenceCaseIdentifier
    }

    private func dueLabel(_ row: Commitment) -> String? {
        guard let date = row.dueAt?.assistantDate else { return nil }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        return "Due \(formatter.string(from: date))"
    }

    private func act(_ row: Commitment, action: String) {
        Task { await perform(row, action: action) }
    }

    private func perform(_ row: Commitment, action: String) async {
        pendingID = row.id
        let ok = await model.updateCommitment(CommitmentMutation(action: action, id: row.id))
        pendingID = nil
        if ok { await load() }
    }

    private func load() async {
        loading = true
        if let result = await model.commitments() { rows = result }
        loading = false
        loaded = true
    }
}

/// Correcting a loop rather than closing it: the assistant heard it slightly
/// wrong and the owner is fixing the record. A title is required, matching the
/// web form and the route, since an empty one would blank the loop's only
/// identifying text.
struct CommitmentEditor: View {
    let commitment: Commitment
    let onSaved: () -> Void

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var details: String
    @State private var nextAction: String
    @State private var isSaving = false

    init(commitment: Commitment, onSaved: @escaping () -> Void) {
        self.commitment = commitment
        self.onSaved = onSaved
        _title = State(initialValue: commitment.title)
        _details = State(initialValue: commitment.details)
        _nextAction = State(initialValue: commitment.nextAction)
    }

    var body: some View {
        AssistantForm {
            Section("What you actually said") {
                TextField("Title", text: $title, axis: .vertical)
                TextField("Details", text: $details, axis: .vertical)
                TextField("Next action", text: $nextAction, axis: .vertical)
            }
            .disabled(isSaving)
        }
        .interactiveDismissDisabled(isSaving)
        .navigationTitle("Correct this loop")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(
                        isSaving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func save() {
        isSaving = true
        Task {
            let saved = await model.updateCommitment(
                CommitmentMutation(
                    action: "correct",
                    id: commitment.id,
                    title: title,
                    details: details,
                    nextAction: nextAction
                )
            )
            isSaving = false
            if saved {
                onSaved()
                dismiss()
            }
        }
    }
}
