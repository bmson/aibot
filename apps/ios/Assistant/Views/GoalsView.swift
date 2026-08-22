import SwiftUI

struct GoalsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
        .scrollBounceBehavior(.basedOnSize)
        .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
        .navigationTitle("Goals")
        .navigationBarTitleDisplayMode(usesAccessibilityLayout ? .inline : .large)
        // Navigation back returns to chat; the card-level "Continue in chat"
        // button remains the direct route back into the conversation.
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
        .padding(15)
        .background(
            AssistantTheme.sunken(for: colorScheme).opacity(0.72),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
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

            if item.conversationId != nil {
                Button {
                    model.returnToChat()
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

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }
}
