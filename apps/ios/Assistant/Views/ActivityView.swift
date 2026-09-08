import SwiftUI

private enum ActivityFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case needsYou = "Needs you"
    case working = "Working"
    case scheduled = "Scheduled"
    case completed = "Done"
    var id: Self { self }
}

struct ActivityView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var filter: ActivityFilter = .all
    @State private var showingArchived = false
    @State private var activityActionInFlight: String?
    @State private var budgetItem: ActivityItem?
    @State private var budgetText = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                filterControl
                if !items.isEmpty { activitySummary }

                if showingArchived ? model.archivedActivity == nil : model.overview == nil {
                    AssistantLoadingState(title: "Loading activity…")
                } else if filteredItems.isEmpty {
                    AssistantEmptyState(
                        filter == .all ? "No activity yet" : "Nothing here",
                        systemImage: "waveform.path.ecg",
                        description: filter == .all
                            ? "Work you hand off in chat will appear here with its evidence and decisions."
                            : "Try another activity filter."
                    )
                } else if isLandscape {
                    LazyVGrid(
                        columns: [
                            GridItem(.flexible(), spacing: AssistantTheme.cardStackSpacing),
                            GridItem(.flexible(), spacing: AssistantTheme.cardStackSpacing),
                        ],
                        spacing: AssistantTheme.cardStackSpacing
                    ) {
                        ForEach(filteredItems) { item in
                            activityCard(item)
                        }
                    }
                } else {
                    LazyVStack(spacing: AssistantTheme.cardStackSpacing) {
                        ForEach(filteredItems) { item in
                            activityCard(item)
                        }
                    }
                }
            }
            .padding(16)
            .padding(.bottom, 28)
            .frame(maxWidth: isLandscape ? 760 : .infinity, alignment: .leading)
        }
        .navigationTitle("Activity")
        .assistantSubmenuChrome()
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    showingArchived.toggle()
                    if showingArchived { Task { await model.refreshArchivedActivity() } }
                } label: {
                    Label(
                        showingArchived ? "Current activity" : "Archived activity",
                        systemImage: showingArchived ? "tray.and.arrow.up" : "archivebox"
                    )
                }
                .accessibilityHint(
                    showingArchived
                        ? "Shows activity that is still current"
                        : "Shows hidden completed activity"
                )
                if !showingArchived {
                    Menu {
                        Button("Archive old activity", systemImage: "archivebox") {
                            activityActionInFlight = "archive-old"
                            Task {
                                _ = await model.archiveOldActivity()
                                activityActionInFlight = nil
                            }
                        }
                    } label: {
                        Label("More activity actions", systemImage: "ellipsis.circle")
                    }
                }
            }
        }
        .refreshable {
            if showingArchived { await model.refreshArchivedActivity() }
            else { await model.refreshOverview() }
        }
        .task {
            if showingArchived { await model.refreshArchivedActivity() }
            else if model.overview == nil { await model.refreshOverview() }
        }
        .alert(
            "Raise task budget",
            isPresented: Binding(
                get: { budgetItem != nil },
                set: { if !$0 { budgetItem = nil } }
            )
        ) {
            TextField("New limit in USD", text: $budgetText)
                .keyboardType(.decimalPad)
            Button("Raise and retry") {
                guard let item = budgetItem, let amount = Double(budgetText) else { return }
                updateActivity(item, action: "raise-budget", budgetUsdLimit: amount)
                budgetItem = nil
            }
            Button("Cancel", role: .cancel) { budgetItem = nil }
        } message: {
            Text("The task resumes from its saved checkpoint; completed actions are not repeated.")
        }
        .sensoryFeedback(.selection, trigger: filter)
    }

    private var filterControl: some View {
        AssistantFilterPicker(title: "Activity filter", options: ActivityFilter.allCases,
            selection: $filter, label: { $0.rawValue })
    }

    private var activitySummary: some View {
        let summary = ActivityVisualSummary(statuses: items.map(\.status))
        let colors: [Color] = [AssistantTheme.warning(for: colorScheme),
            AssistantTheme.accent(for: colorScheme), AssistantTheme.inkMuted(for: colorScheme),
            AssistantTheme.success(for: colorScheme).opacity(0.4), AssistantTheme.errorInk(for: colorScheme), .secondary]
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(showingArchived ? "Archived activity" : "Loaded activity")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(items.count) tasks").font(.caption).foregroundStyle(.secondary)
            }
            AssistantDistributionBar(values: summary.counts.map(Double.init), colors: colors)
            AssistantFlowLayout(spacing: 12) {
                ForEach(Array(summary.counts.enumerated()), id: \.offset) { index, count in
                    if count > 0 {
                        HStack(spacing: 5) {
                            Circle().fill(colors[index]).frame(width: 6, height: 6).accessibilityHidden(true)
                            Text("\(count) \(ActivityVisualSummary.labels[index])")
                                .font(.caption).foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        }
                    }
                }
            }
        }
        .assistantPanel(in: colorScheme)
        .accessibilityElement(children: .combine)
    }

    private var items: [ActivityItem] {
        showingArchived
            ? model.archivedActivity?.items ?? []
            : model.overview?.activity.items ?? []
    }

    private var filteredItems: [ActivityItem] {
        return items.filter { item in
            switch filter {
            case .all: true
            case .needsYou: ["waiting_approval", "waiting_budget", "needs_attention"].contains(item.status)
            case .working: ["pending", "running"].contains(item.status)
            case .scheduled: ["sleeping", "waiting_event"].contains(item.status)
            case .completed: ["done", "failed", "cancelled"].contains(item.status)
            }
        }
    }

    private func activityCard(_ item: ActivityItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            activityHeader(item)

            if !item.displayProgress.isEmpty {
                Text((try? AttributedString(markdown: item.displayProgress,
                    options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(item.displayProgress))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(usesAccessibilityLayout ? nil : 3)
            }

            HStack(alignment: .center, spacing: 8) {
                activityMetadata(item)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                if !showingArchived && isTerminal(item) {
                    Spacer(minLength: 0)
                    Button { updateActivity(item, action: "archive") } label: {
                        if activityActionInFlight == item.id {
                            ProgressView().controlSize(.small).frame(width: 44, height: 44)
                        } else {
                            Label("Archive \(item.displayTitle)", systemImage: "archivebox")
                                .labelStyle(.iconOnly).frame(width: 44, height: 44)
                        }
                    }
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .buttonStyle(AssistantTactileButtonStyle(reduceMotion: reduceMotion))
                    .disabled(activityActionInFlight != nil)
                    .accessibilityLabel("Archive \(item.displayTitle)")
                }
            }

            if showingArchived {
                Button {
                    updateActivity(item, action: "restore")
                } label: {
                    activityActionLabel(
                        item,
                        title: "Restore to activity",
                        icon: "tray.and.arrow.up"
                    )
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
                .disabled(activityActionInFlight != nil)
            } else {
                if item.hasPendingApproval {
                    Button {
                        model.present(.approvals)
                    } label: {
                        Label("Review approval", systemImage: "checkmark.shield")
                    }
                    .buttonStyle(AssistantActionButtonStyle(kind: .primary))
                    .tint(AssistantTheme.warning(for: colorScheme))
                }

                if !isTerminal(item) || item.stuckWaiting == true || item.hasActiveAutonomy == true {
                    AssistantFlowLayout(spacing: 9) {
                        if !isTerminal(item) {
                            actionButton(item, title: "Cancel", icon: "xmark.circle", action: "cancel")
                        }

                        if item.status == "needs_attention" {
                            if item.progress.hasPrefix("budget: task budget") {
                                Button {
                                    budgetItem = item
                                    budgetText = suggestedBudget(for: item)
                                } label: {
                                    Label("Raise budget", systemImage: "dollarsign.arrow.circlepath")
                                }
                                .buttonStyle(AssistantActionButtonStyle(kind: .primary))
                                .disabled(activityActionInFlight != nil)
                            } else {
                                actionButton(item, title: "Retry", icon: "arrow.clockwise", action: "retry")
                            }
                        } else if item.stuckWaiting == true {
                            actionButton(item, title: "Retry", icon: "arrow.clockwise", action: "retry")
                        }

                        if item.hasActiveAutonomy == true {
                            actionButton(
                                item,
                                title: "Revoke autonomy",
                                icon: "hand.raised",
                                action: "revoke-autonomy"
                            )
                        }
                    }
                }
            }
        }
        .assistantCard(in: colorScheme)
    }

    @ViewBuilder
    private func activityActionLabel(_ item: ActivityItem, title: String, icon: String) -> some View {
        if activityActionInFlight == item.id {
            HStack(spacing: 7) {
                ProgressView().controlSize(.small)
                Text("Updating…")
            }
        } else {
            Label(title, systemImage: icon)
        }
    }

    private func updateActivity(_ item: ActivityItem, action: String) {
        activityActionInFlight = item.id
        Task {
            _ = await model.updateActivity(item, action: action)
            activityActionInFlight = nil
        }
    }

    private func updateActivity(_ item: ActivityItem, action: String, budgetUsdLimit: Double) {
        activityActionInFlight = item.id
        Task {
            _ = await model.updateActivity(
                item,
                action: action,
                budgetUsdLimit: budgetUsdLimit
            )
            activityActionInFlight = nil
        }
    }

    private func actionButton(
        _ item: ActivityItem,
        title: String,
        icon: String,
        action: String
    ) -> some View {
        Button { updateActivity(item, action: action) } label: {
            activityActionLabel(item, title: title, icon: icon)
        }
        .buttonStyle(AssistantActionButtonStyle(kind: .secondary))
        .disabled(activityActionInFlight != nil)
    }

    private func suggestedBudget(for item: ActivityItem) -> String {
        let current = Double(item.budgetUsdLimit) ?? 0
        let spent = Double(item.spentUsd) ?? 0
        let suggested = ceil(max(current * 2, spent + 0.25) * 4) / 4
        return String(format: "%.2f", suggested)
    }

    private func isTerminal(_ item: ActivityItem) -> Bool {
        ["done", "failed", "cancelled"].contains(item.status)
    }

    @ViewBuilder
    private func activityHeader(_ item: ActivityItem) -> some View {
        let identity = HStack(alignment: .top, spacing: 12) {
                AssistantGlyph(systemName: icon(for: item.status), tint: color(for: item.status))
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.displayTitle)
                        .font(.headline)
                        .lineLimit(usesAccessibilityLayout ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    Text(item.type.sentenceCaseIdentifier)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }

        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 10) {
                identity
                StatusPill(status: item.status)
            }
        } else {
            HStack(alignment: .top, spacing: 12) {
                identity
                StatusPill(status: item.status)
            }
        }
    }

    @ViewBuilder
    private func activityMetadata(_ item: ActivityItem) -> some View {
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 6) {
                Text(item.budgetSummary)
                Text(relative(item.updatedAt))
                if item.hasPendingApproval {
                    Label("Approval waiting", systemImage: "hand.raised.fill")
                        .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                }
            }
        } else {
            AssistantFlowLayout(spacing: 7) {
                Text(item.budgetSummary)
                Text("·")
                Text(relative(item.updatedAt))
                if item.hasPendingApproval {
                    Text("·")
                    Label("Approval waiting", systemImage: "hand.raised.fill")
                    .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                }
            }
        }
    }

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }
    private var isLandscape: Bool { verticalSizeClass == .compact }

    private func icon(for status: String) -> String {
        switch status {
        case "running": "arrow.triangle.2.circlepath"
        case "done": "checkmark.circle.fill"
        case "failed", "cancelled": "xmark.circle.fill"
        case "waiting_approval", "waiting_budget", "needs_attention": "hand.raised.fill"
        case "sleeping", "waiting_event": "clock.fill"
        default: "circle.dotted"
        }
    }

    private func color(for status: String) -> Color {
        switch status {
        case "running": AssistantTheme.accent(for: colorScheme)
        // The brand green, matching the StatusPill sitting beside it in the
        // same card — system green is a visibly different hue.
        case "done": AssistantTheme.success(for: colorScheme)
        case "failed", "cancelled": .red
        case "waiting_approval", "waiting_budget", "needs_attention": AssistantTheme.warning(for: colorScheme)
        default: .secondary
        }
    }
}

func relative(_ value: String) -> String {
    // Both fractional and whole-second ISO timestamps are valid server dates.
    guard let date = value.assistantDate ?? ISO8601DateFormatter().date(from: value) else { return value }
    return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: .now)
}
