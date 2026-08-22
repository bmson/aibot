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
    @State private var filter: ActivityFilter = .all

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                filterControl

                if filteredItems.isEmpty {
                    ContentUnavailableView(
                        filter == .all ? "No activity yet" : "Nothing here",
                        systemImage: "waveform.path.ecg",
                        description: Text(filter == .all
                            ? "Work you hand off in chat will appear here with its evidence and decisions."
                            : "Try another activity filter.")
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, 56)
                } else {
                    LazyVStack(spacing: 12) {
                        ForEach(filteredItems) { item in
                            activityCard(item)
                        }
                    }
                }
            }
            .padding(16)
        }
        .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
        .navigationTitle("Activity")
        .navigationBarTitleDisplayMode(usesAccessibilityLayout ? .inline : .large)
        .refreshable { await model.refreshAll() }
        .task { if model.overview == nil { await model.refreshOverview() } }
    }

    @ViewBuilder
    private var filterControl: some View {
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 10) {
                Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
                    .font(.headline)
                Picker("Filter activity", selection: $filter) {
                    ForEach(ActivityFilter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(14)
            .background(
                AssistantTheme.sunken(for: colorScheme),
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
        } else {
            Picker("Filter activity", selection: $filter) {
                ForEach(ActivityFilter.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
        }
    }

    private var filteredItems: [ActivityItem] {
        let items = model.overview?.activity.items ?? []
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
                Text(item.displayProgress)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(usesAccessibilityLayout ? nil : 3)
            }

            activityMetadata(item)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .assistantCard(in: colorScheme)
    }

    @ViewBuilder
    private func activityHeader(_ item: ActivityItem) -> some View {
        let identity = HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon(for: item.status))
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(color(for: item.status))
                    .frame(width: 44, height: 44)
                    .background(color(for: item.status).opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
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
                        .foregroundStyle(.orange)
                }
            }
        } else {
            HStack(spacing: 7) {
                Text(item.budgetSummary)
                Text("·")
                Text(relative(item.updatedAt))
                if item.hasPendingApproval {
                    Text("·")
                    Label("Approval waiting", systemImage: "hand.raised.fill")
                    .foregroundStyle(.orange)
                }
            }
        }
    }

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

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
        case "done": AssistantTheme.accent(for: colorScheme)
        case "failed", "cancelled": .red
        case "waiting_approval", "waiting_budget", "needs_attention": .orange
        default: .secondary
        }
    }
}

func relative(_ value: String) -> String {
    guard let date = value.assistantDate else { return value }
    return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: .now)
}
