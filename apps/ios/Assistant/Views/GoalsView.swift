import SwiftUI

struct GoalsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if goals.isEmpty {
                    ContentUnavailableView(
                        "No goals yet",
                        systemImage: "scope",
                        description: Text("Give the assistant an outcome in chat and it can keep moving it forward on a schedule.")
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, 72)
                } else {
                    digest
                    ForEach(goals) { item in
                        goalCard(item)
                    }
                }
            }
            .padding(16)
        }
        .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
        .navigationTitle("Goals")
        .navigationBarTitleDisplayMode(usesAccessibilityLayout ? .inline : .large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    model.returnToChat()
                } label: {
                    Label("Open chat", systemImage: "bubble.left")
                }
                .accessibilityLabel("Open chat")
            }
        }
        .refreshable { await model.refreshAll() }
        .task { if model.overview == nil { await model.refreshOverview() } }
    }

    private var goals: [GoalDashboardItem] { model.overview?.goals.items ?? [] }

    private var digest: some View {
        let waiting = goals.filter { !$0.blockedQuestion.isEmpty || $0.stalled }.count
        let moving = goals.filter { $0.goal.status == "active" && $0.blockedQuestion.isEmpty && !$0.stalled }.count
        return Group {
            if usesAccessibilityLayout {
                VStack(alignment: .leading, spacing: 14) {
                    metric(value: waiting, label: "waiting on you", color: .orange)
                    Divider()
                    metric(
                        value: moving,
                        label: "moving on their own",
                        color: AssistantTheme.accent(for: colorScheme)
                    )
                }
            } else {
                HStack(spacing: 14) {
                    metric(value: waiting, label: "waiting on you", color: .orange)
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
        .padding(15)
        .background(
            AssistantTheme.sunken(for: colorScheme).opacity(0.72),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
    }

    private func metric(value: Int, label: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)").font(.title3.monospacedDigit().weight(.semibold)).foregroundStyle(color)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func goalCard(_ item: GoalDashboardItem) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            goalHeader(item)

            if !item.blockedQuestion.isEmpty || item.stalled {
                Label(
                    item.blockedQuestion.isEmpty ? "The last session needs review." : item.blockedQuestion,
                    systemImage: "hand.raised.fill"
                )
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.orange)
                .padding(11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
            } else if !item.goal.progress.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Latest progress").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(item.goal.progress)
                        .font(.subheadline)
                        .lineLimit(usesAccessibilityLayout ? nil : 3)
                }
            }

            goalCadence(item)

            if item.conversationId != nil {
                Button {
                    model.returnToChat()
                } label: {
                    Label("Continue in chat", systemImage: "bubble.left")
                        .font(.subheadline.weight(.semibold))
                }
            }
        }
        .assistantCard(in: colorScheme)
    }

    @ViewBuilder
    private func goalHeader(_ item: GoalDashboardItem) -> some View {
        let identity = VStack(alignment: .leading, spacing: 5) {
            Text(item.goal.title)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if !item.goal.description.isEmpty {
                Text(item.goal.description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(usesAccessibilityLayout ? nil : 3)
            }
        }

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

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }
}
