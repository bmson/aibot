import SwiftUI

struct GoalsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showingGoalCreator = false
    @State private var editingGoal: GoalRecord?
    @State private var deletingGoal: GoalRecord?
    @State private var goalActionInFlight: String?
    @State private var showingArchived = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if goals.isEmpty {
                    AssistantEmptyState(
                        "No goals yet",
                        systemImage: "scope",
                        description: "Give the assistant an outcome in chat and it can keep moving it forward on a schedule."
                    )
                } else {
                    goalOverviewLabel
                    digest
                    ForEach(goals) { item in
                        goalCard(item)
                    }
                }
            }
            .padding(16)
            .padding(.bottom, 28)
        }
        .navigationTitle("Goals")
        .assistantSubmenuChrome()
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    showingArchived.toggle()
                    if showingArchived { Task { await model.refreshArchivedGoals() } }
                } label: {
                    Label(
                        showingArchived ? "Current goals" : "Archived goals",
                        systemImage: showingArchived ? "tray.and.arrow.up" : "archivebox"
                    )
                }
                if !showingArchived {
                    Button {
                        showingGoalCreator = true
                    } label: {
                        Label("Add goal", systemImage: "plus")
                    }
                    Menu {
                        Button("Archive inactive goals", systemImage: "archivebox") {
                            goalActionInFlight = "archive-inactive"
                            Task {
                                _ = await model.archiveInactiveGoals()
                                goalActionInFlight = nil
                            }
                        }
                    } label: {
                        Label("More goal actions", systemImage: "ellipsis.circle")
                    }
                }
            }
        }
        // Navigation back returns to chat; the card-level "Continue in chat"
        // button remains the direct route back into the conversation.
        .refreshable {
            if showingArchived { await model.refreshArchivedGoals() }
            else { await model.refreshAll() }
        }
        .task {
            if showingArchived { await model.refreshArchivedGoals() }
            else if model.overview == nil { await model.refreshOverview() }
        }
        .sheet(isPresented: $showingGoalCreator) {
            NavigationStack { GoalEditor(goal: nil) }
        }
        .sheet(item: $editingGoal) { goal in
            NavigationStack { GoalEditor(goal: goal) }
        }
        .confirmationDialog(
            "Delete this goal?",
            isPresented: Binding(
                get: { deletingGoal != nil },
                set: { if !$0 { deletingGoal = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let goal = deletingGoal {
                Button("Delete goal", role: .destructive) {
                    goalActionInFlight = goal.id
                    Task {
                        _ = await model.deleteGoal(goal)
                        goalActionInFlight = nil
                    }
                    deletingGoal = nil
                }
                Button("Cancel", role: .cancel) { deletingGoal = nil }
            }
        } message: {
            Text("This archives the goal from the active list. Its work chat and activity remain available as a record.")
        }
    }

    private var goals: [GoalDashboardItem] {
        showingArchived ? model.archivedGoals?.items ?? [] : model.overview?.goals.items ?? []
    }

    private var digest: some View {
        let waiting = goals.filter { !$0.blockedQuestion.isEmpty || $0.stalled }.count
        let moving = goals.filter { $0.goal.status == "active" && $0.blockedQuestion.isEmpty && !$0.stalled }.count
        return Group {
            if usesAccessibilityLayout {
                VStack(alignment: .leading, spacing: 14) {
                    metric(
                        value: waiting,
                        label: "waiting on you",
                        color: AssistantTheme.warning(for: colorScheme)
                    )
                    Divider()
                    metric(
                        value: moving,
                        label: "moving on their own",
                        color: AssistantTheme.accent(for: colorScheme)
                    )
                }
            } else {
                HStack(spacing: 14) {
                    metric(
                        value: waiting,
                        label: "waiting on you",
                        color: AssistantTheme.warning(for: colorScheme)
                    )
                    Divider().frame(height: 30)
                    metric(
                        value: moving,
                        label: "moving on their own",
                        color: AssistantTheme.accent(for: colorScheme)
                    )
                    Spacer()
                }
            }
        }
        .assistantPanel(in: colorScheme)
    }

    private var goalOverviewLabel: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(showingArchived ? "Archived goals" : "Your active outcomes")
                    .font(.headline)
                Text("Progress stays here between conversations.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Text("\(goals.count)")
                .font(.title3.monospacedDigit().weight(.semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
        }
        .assistantPanel(in: colorScheme)
    }

    private func metric(value: Int, label: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)")
                .font(.title3.monospacedDigit().weight(.semibold))
                .foregroundStyle(color)
                .contentTransition(.numericText(value: Double(value)))
                .animation(
                    reduceMotion ? nil : .snappy(duration: 0.24, extraBounce: 0),
                    value: value
                )
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func goalCard(_ item: GoalDashboardItem) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            goalHeader(item)

            if !item.blockedQuestion.isEmpty || item.stalled {
                attentionCallout(item)
            } else if !item.goal.progress.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Latest progress").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(inlineMarkdown(item.goal.progress))
                        .font(.subheadline)
                        .lineLimit(usesAccessibilityLayout ? nil : 3)
                }
            }

            goalCadence(item)

            if showingArchived {
                Button {
                    goalActionInFlight = item.goal.id
                    Task {
                        _ = await model.restoreGoal(item.goal)
                        goalActionInFlight = nil
                    }
                } label: {
                    if goalActionInFlight == item.goal.id {
                        HStack(spacing: 7) {
                            ProgressView().controlSize(.small)
                            Text("Restoring…")
                        }
                    } else {
                        Label("Restore goal", systemImage: "tray.and.arrow.up")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(goalActionInFlight != nil)
            } else {
                AssistantFlowLayout(spacing: 9) {
                    if item.goal.status == "active" {
                        lifecycleButton(item, title: "Pause", action: "status", status: "paused")
                    } else if item.goal.status == "paused" {
                        lifecycleButton(item, title: "Resume", action: "status", status: "active")
                    } else if item.conversationId == nil {
                        lifecycleButton(item, title: "Start work", action: "start")
                    }

                    Button {
                        editingGoal = item.goal
                    } label: {
                        Label("Edit", systemImage: "pencil")
                    }
                    .buttonStyle(.bordered)
                    .disabled(goalActionInFlight != nil)

                    Button(role: .destructive) {
                        deletingGoal = item.goal
                    } label: {
                        if goalActionInFlight == item.goal.id {
                            HStack(spacing: 7) {
                                ProgressView().controlSize(.small)
                                Text("Deleting…")
                            }
                        } else {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(item.workActive || goalActionInFlight != nil)
                    .accessibilityHint(
                        item.workActive
                            ? "Finish or cancel active work before deleting this goal"
                            : "Archives the goal and keeps its work history"
                    )

                    Menu {
                        Button(item.goal.autonomy ? "Require approvals" : "Run autonomously") {
                            updateLifecycle(item, action: "autonomy", enabled: !item.goal.autonomy)
                        }
                        .disabled(item.goal.taintedOrigin)

                        if ["active", "paused"].contains(item.goal.status) {
                            Button("Mark done") {
                                updateLifecycle(item, action: "status", status: "done")
                            }
                        } else {
                            Button("Reactivate") {
                                updateLifecycle(item, action: "status", status: "active")
                            }
                        }

                        if item.goal.status != "abandoned" {
                            Button("Stop goal", role: .destructive) {
                                updateLifecycle(item, action: "status", status: "abandoned")
                            }
                        }
                    } label: {
                        Label("More", systemImage: "ellipsis.circle")
                    }
                    .disabled(goalActionInFlight != nil)
                }
            }

            if let conversationId = item.conversationId {
                Button {
                    goalActionInFlight = item.goal.id
                    Task {
                        _ = await model.openConversation(id: conversationId)
                        goalActionInFlight = nil
                    }
                } label: {
                    Label("Continue in chat", systemImage: "bubble.left")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(
                    AssistantTactileButtonStyle(
                        reduceMotion: reduceMotion,
                        pressedScale: 0.985
                    )
                )
            }
        }
        .assistantCard(in: colorScheme)
    }

    private func attentionCallout(_ item: GoalDashboardItem) -> some View {
        let source = item.blockedQuestion.isEmpty
            ? "The last session needs review."
            : item.blockedQuestion
        let rendered = inlineMarkdown(source)
        let tint = AssistantTheme.warningInk(for: colorScheme)
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)

        return HStack(alignment: .top, spacing: 11) {
            Image(systemName: "hand.raised.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(tint)
                .frame(width: 32, height: 32)
                .background(
                    AssistantTheme.warning(for: colorScheme).opacity(0.12),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(item.stalled && item.blockedQuestion.isEmpty ? "Review needed" : "Needs you")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint)
                Text(rendered)
                    .font(.subheadline)
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                    .lineLimit(usesAccessibilityLayout ? nil : 4)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AssistantTheme.warningSurface(for: colorScheme), in: shape)
        .overlay {
            shape.strokeBorder(
                AssistantTheme.warning(for: colorScheme).opacity(colorScheme == .dark ? 0.22 : 0.16),
                lineWidth: 0.8
            )
        }
        .accessibilityElement(children: .combine)
    }

    private func inlineMarkdown(_ source: String) -> AttributedString {
        let compactSource = source
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (try? AttributedString(
            markdown: compactSource,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(compactSource)
    }

    @ViewBuilder
    private func goalHeader(_ item: GoalDashboardItem) -> some View {
        let identity = VStack(alignment: .leading, spacing: 5) {
            Text(item.goal.displayTitle)
                .font(.headline)
                .lineLimit(usesAccessibilityLayout ? nil : 2)
                .fixedSize(horizontal: false, vertical: usesAccessibilityLayout)
                .accessibilityAddTraits(.isHeader)
            if !item.goal.description.isEmpty {
                Text(item.goal.description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(usesAccessibilityLayout ? nil : 2)
            }
        }
        .layoutPriority(1)

        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 10) {
                identity
                StatusPill(status: item.goal.status)
            }
        } else {
            HStack(alignment: .top) {
                identity
                Spacer()
                StatusPill(status: item.goal.status)
            }
        }
    }

    @ViewBuilder
    private func goalCadence(_ item: GoalDashboardItem) -> some View {
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 7) {
                Label(item.cadenceLabel, systemImage: "clock.arrow.circlepath")
                if item.workActive {
                    Label("Working", systemImage: "sparkles")
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        } else {
            HStack {
                Label(item.cadenceLabel, systemImage: "clock.arrow.circlepath")
                if item.workActive {
                    Spacer()
                    Label("Working", systemImage: "sparkles")
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private func lifecycleButton(
        _ item: GoalDashboardItem,
        title: String,
        action: String,
        status: String? = nil
    ) -> some View {
        Button(title) { updateLifecycle(item, action: action, status: status) }
            .buttonStyle(.bordered)
            .disabled(goalActionInFlight != nil)
    }

    private func updateLifecycle(
        _ item: GoalDashboardItem,
        action: String,
        status: String? = nil,
        enabled: Bool? = nil
    ) {
        goalActionInFlight = item.goal.id
        Task {
            _ = await model.updateGoalLifecycle(
                item.goal,
                action: action,
                status: status,
                enabled: enabled
            )
            goalActionInFlight = nil
        }
    }

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }
}

/// The same small goal form handles creation and edits; a new goal starts its
/// first work session on the server, while an edit only changes its settings.
private struct GoalEditor: View {
    let goal: GoalRecord?

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var description: String
    @State private var priority: Int
    @State private var targetDate: String
    @State private var progress: String
    @State private var nextAction: String
    @State private var mirrorToPrimary: Bool
    @State private var isSaving = false

    init(goal: GoalRecord?) {
        self.goal = goal
        _title = State(initialValue: goal?.title ?? "")
        _description = State(initialValue: goal?.description ?? "")
        _priority = State(initialValue: goal?.priority ?? 3)
        _targetDate = State(initialValue: goal?.targetDate?.prefix(10).description ?? "")
        _progress = State(initialValue: goal?.progress ?? "")
        _nextAction = State(initialValue: goal?.nextAction ?? "")
        _mirrorToPrimary = State(initialValue: goal?.mirrorToPrimary ?? false)
    }

    var body: some View {
        Form {
            Section {
                TextField("What should the assistant work toward?", text: $title, axis: .vertical)
                    .lineLimit(1...3)
                TextField("Context, constraints, definition of done", text: $description, axis: .vertical)
                    .lineLimit(2...5)
            } header: {
                Text("Goal")
            }

            Section("Pace and target") {
                Picker("Pace", selection: $priority) {
                    Text("Fast").tag(1)
                    Text("Focused").tag(2)
                    Text("Normal").tag(3)
                    Text("Gentle").tag(4)
                    Text("Low").tag(5)
                }
                TextField("Target date (YYYY-MM-DD)", text: $targetDate)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.numbersAndPunctuation)
                Toggle("Show updates in my main chat", isOn: $mirrorToPrimary)
            }

            Section("Current direction") {
                TextField("Latest progress", text: $progress, axis: .vertical)
                    .lineLimit(2...5)
                TextField("Next action", text: $nextAction, axis: .vertical)
                    .lineLimit(2...5)
            }
        }
        .navigationTitle(goal == nil ? "New goal" : "Edit goal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : (goal == nil ? "Start" : "Save")) {
                    save()
                }
                .disabled(isSaving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func save() {
        let mutation = GoalMutation(
            title: title,
            description: description,
            priority: priority,
            targetDate: targetDate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : targetDate,
            progress: progress,
            nextAction: nextAction,
            mirrorToPrimary: mirrorToPrimary
        )
        isSaving = true
        Task {
            let saved: Bool
            if let goal {
                saved = await model.updateGoal(id: goal.id, goal: mutation)
            } else {
                saved = await model.createGoal(mutation)
            }
            isSaving = false
            if saved { dismiss() }
        }
    }
}
