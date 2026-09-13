import SwiftUI

/// Open loops — promises, questions and follow-ups the assistant is tracking.
/// The memory desk has always shown these on the web; until now the phone had
/// no way to reach them, so a loop raised in conversation could only ever be
/// closed from a browser. The three verbs match the web hub exactly: Done
/// resolves, Later snoozes a day, Not relevant dismisses.
///
/// Cards, not list rows: `List` proposes each row a width that doesn't match
/// its real content width, so `AssistantFlowLayout`'s `sizeThatFits` measured
/// the action buttons far too narrow and their labels wrapped one character
/// per line. A `ScrollView` of cards — the same shape as `ApprovalsView` —
/// gives the layout a width it can actually trust.
struct CommitmentsScreen: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var rows: [Commitment] = []
    @State private var loaded = false
    @State private var loading = false
    /// Names the loop being acted on, so one row's action never disables the
    /// others — the mistake this app has made in four other lists.
    @State private var pendingID: String?
    @State private var correcting: Commitment?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                explainer
                if !loaded && loading {
                    AssistantLoadingState(title: "Loading open loops")
                } else if rows.isEmpty {
                    AssistantEmptyState(
                        "Nothing is waiting for your attention",
                        systemImage: "checkmark.circle",
                        description: "Decisions, questions and follow-ups appear here when the assistant is still holding one open.")
                } else {
                    ForEach(rows) { row in card(row) }
                }
            }
            .padding(16)
            .padding(.bottom, 28)
            .frame(maxWidth: isLandscape ? 760 : .infinity, alignment: .leading)
        }
        .assistantSubmenuChrome()
        .navigationTitle("Open loops")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { if !loaded { await load() } }
        .sheet(item: $correcting) { row in
            NavigationStack { CommitmentEditor(commitment: row, onSaved: { Task { await load() } }) }
        }
    }

    /// A one-line pitch plus the two easily-confused kinds. Collapsed by
    /// default so the glossary never outweighs the loops it explains.
    private var explainer: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What the assistant is still holding open")
                .font(.headline)
            Text("These are decisions, questions and follow-ups the assistant pulled out of your conversations automatically. A loop left untouched for 90 days is cleared out on its own.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            DisclosureGroup("The four kinds") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Decision — a choice that was made.")
                    Text("Question — something left unanswered.")
                    Text("Promise — something you said you'd do.")
                    Text("Waiting on — something you're expecting back from someone else.")
                }
                .font(.caption)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .padding(.top, 6)
            }
            .font(.subheadline.weight(.semibold))
        }
        .assistantPanel(in: colorScheme)
    }

    private func card(_ row: Commitment) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(row.kind.sentenceCaseIdentifier)
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
            actions(for: row)
                .lineLimit(1)
                .font(.caption)
                .disabled(pendingID == row.id)
        }
        .assistantCard(in: colorScheme)
    }

    private var isLandscape: Bool { verticalSizeClass == .compact }
    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    /// Three affirmative actions fit one row at default Dynamic Type;
    /// "Not relevant" is the widest label on this screen, so it gets a row of
    /// its own rather than leaving a fourth button to wrap unpredictably. At
    /// accessibility text sizes even three no longer fit — this is the same
    /// switch `ApprovalsView` makes for the same reason — so every action
    /// gets its own full-width row instead.
    @ViewBuilder
    private func actions(for row: Commitment) -> some View {
        if usesAccessibilityLayout {
            VStack(spacing: 8) {
                Button("Done", systemImage: "checkmark") { act(row, action: "resolve") }
                    .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true, fillsWidth: true))
                Button("Later", systemImage: "clock") { act(row, action: "snooze") }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true, fillsWidth: true))
                Button("Correct", systemImage: "pencil") { correcting = row }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true, fillsWidth: true))
                AssistantConfirmationButton(
                    "Not relevant",
                    systemImage: "xmark",
                    hint: "Stops the assistant bringing this loop back.",
                    compact: true,
                    fillsWidth: true
                ) {
                    await perform(row, action: "dismiss")
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Button("Done", systemImage: "checkmark") { act(row, action: "resolve") }
                        .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
                    Button("Later", systemImage: "clock") { act(row, action: "snooze") }
                        .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                    Button("Correct", systemImage: "pencil") { correcting = row }
                        .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                }
                AssistantConfirmationButton(
                    "Not relevant",
                    systemImage: "xmark",
                    hint: "Stops the assistant bringing this loop back."
                ) {
                    await perform(row, action: "dismiss")
                }
            }
        }
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
