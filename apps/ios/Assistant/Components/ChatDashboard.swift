import SwiftUI

/// The chat's empty state doubles as the owner's briefing surface. It only
/// uses projections already loaded by the mobile overview endpoint, keeping
/// the conversation front door useful without inventing a separate dashboard
/// API or pretending an empty calendar contains appointments.
struct ChatDashboard: View {
    let agentName: String
    let overview: OverviewResponse?
    let pendingApprovalCount: Int
    let needsAttentionCount: Int
    let isSending: Bool
    let onRoute: (AssistantRoute) -> Void
    let onPrompt: (String) -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    private var activeWork: [ActivityItem] {
        (overview?.activity.items ?? []).filter {
            ["pending", "running", "sleeping", "waiting_event"].contains($0.status)
        }
    }

    private var firstGoal: GoalDashboardItem? {
        overview?.goals.items.first { !$0.stalled } ?? overview?.goals.items.first
    }

    private var firstApproval: PendingApproval? {
        overview?.approvals.pending.first
    }

    private var agendaItems: [DashboardAgendaItem] {
        var items: [DashboardAgendaItem] = []

        if let approval = firstApproval {
            items.append(
                .init(
                    marker: "Now",
                    title: approval.approval.summary,
                    tag: "Approval",
                    action: "Review",
                    icon: "hand.raised.fill",
                    destination: .route(.approvals)
                )
            )
        } else if pendingApprovalCount > 0 {
            // Bootstrap carries the count even when an overview refresh is
            // temporarily unavailable. Keep the priority honest rather than
            // showing an empty, cheerful card until that retry succeeds.
            items.append(
                .init(
                    marker: "Now",
                    title: "Review pending approvals",
                    tag: "\(pendingApprovalCount) waiting",
                    action: "Review",
                    icon: "hand.raised.fill",
                    destination: .route(.approvals)
                )
            )
        } else if needsAttentionCount > 0 {
            items.append(
                .init(
                    marker: "Now",
                    title: "A task is waiting for your direction",
                    tag: "Needs you",
                    action: "Open",
                    icon: "exclamationmark.circle",
                    destination: .route(.activity)
                )
            )
        }

        if let work = activeWork.first {
            items.append(
                .init(
                    marker: items.isEmpty ? "Now" : "Next",
                    title: work.displayTitle,
                    tag: work.status == "running" ? "In motion" : "Scheduled",
                    action: "Track",
                    icon: "arrow.triangle.2.circlepath",
                    destination: .route(.activity)
                )
            )
        }

        if items.count < 2, let goal = firstGoal {
            items.append(
                .init(
                    marker: items.isEmpty ? "Next" : "Later",
                    title: goal.goal.nextAction.isEmpty ? goal.goal.displayTitle : goal.goal.nextAction,
                    tag: "Goal",
                    action: "Open",
                    icon: "scope",
                    destination: .route(.goals)
                )
            )
        }

        if items.isEmpty {
            items.append(
                .init(
                    marker: "Ready",
                    title: "Put a task in motion",
                    tag: "Start here",
                    action: "Ask",
                    icon: "sparkles",
                    destination: .prompt("Help me decide what to focus on today")
                )
            )
        }

        return items
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            greeting
            upNextCard
            attentionCard
            workCard
            goalsCard
            startCard
        }
        .padding(.top, 76)
        .padding(.bottom, 28)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(greetingTitle)
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
            Text("A quick view of what can move forward with \(agentName).")
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.68))
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }

    private var greetingTitle: String {
        switch Calendar.current.component(.hour, from: .now) {
        case 5..<12: "Good morning"
        case 12..<18: "Good afternoon"
        default: "Good evening"
        }
    }

    private var upNextCard: some View {
        DashboardCard(title: "Up next", icon: "calendar", tint: AssistantTheme.accent(for: colorScheme)) {
            VStack(spacing: 0) {
                ForEach(Array(agendaItems.enumerated()), id: \.offset) { index, item in
                    agendaRow(item)
                    if index < agendaItems.count - 1 {
                        DashboardDivider()
                    }
                }
                DashboardDivider()
                dashboardFooter("View all activity", icon: "calendar") {
                    onRoute(.activity)
                }
            }
        }
    }

    private func agendaRow(_ item: DashboardAgendaItem) -> some View {
        Button {
            perform(item.destination)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Text(item.marker)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .frame(width: usesAccessibilityLayout ? 62 : 54, alignment: .leading)

                VStack(alignment: .leading, spacing: 7) {
                    Text(item.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        .lineLimit(usesAccessibilityLayout ? nil : 2)
                        .multilineTextAlignment(.leading)
                    DashboardTag(title: item.tag, icon: item.icon)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .trailing, spacing: 4) {
                    Text(item.action)
                        .font(.subheadline.weight(.medium))
                    Image(systemName: "arrow.right")
                        .font(.caption.weight(.bold))
                }
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .padding(.top, 1)
            }
            .padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(DashboardButtonStyle(reduceMotion: reduceMotion))
        .disabled(isSending && item.destination.isPrompt)
    }

    private var attentionCard: some View {
        DashboardCard(
            title: pendingApprovalCount > 0 || needsAttentionCount > 0 ? "Needs you" : "Approvals",
            icon: "checkmark.shield",
            tint: pendingApprovalCount > 0 || needsAttentionCount > 0
                ? AssistantTheme.warning(for: colorScheme)
                : AssistantTheme.accent(for: colorScheme)
        ) {
            if let approval = firstApproval {
                dashboardDetail(
                    approval.approval.summary,
                    detail: "\(pendingApprovalCount) \(pendingApprovalCount == 1 ? "decision" : "decisions") waiting",
                    tag: "Review needed",
                    action: "Review"
                ) {
                    onRoute(.approvals)
                }
            } else if pendingApprovalCount > 0 {
                dashboardDetail(
                    "Review pending approvals",
                    detail: "\(pendingApprovalCount) \(pendingApprovalCount == 1 ? "decision is" : "decisions are") waiting for you.",
                    tag: "Review needed",
                    action: "Review"
                ) {
                    onRoute(.approvals)
                }
            } else if needsAttentionCount > 0 {
                dashboardDetail(
                    "A task is waiting for your direction",
                    detail: "\(needsAttentionCount) \(needsAttentionCount == 1 ? "item" : "items") need attention",
                    tag: "Needs you",
                    action: "Open"
                ) {
                    onRoute(.activity)
                }
            } else {
                dashboardDetail(
                    "Nothing needs approval",
                    detail: "The assistant will surface outward actions here before it takes them.",
                    tag: "All clear",
                    action: "History"
                ) {
                    onRoute(.approvals)
                }
            }
        }
    }

    private var workCard: some View {
        DashboardCard(title: "In motion", icon: "arrow.triangle.2.circlepath", tint: AssistantTheme.accent(for: colorScheme)) {
            if let work = activeWork.first {
                dashboardDetail(
                    work.displayTitle,
                    detail: work.displayProgress.isEmpty ? "The assistant is keeping this moving." : work.displayProgress,
                    tag: work.status == "running" ? "Working" : "Scheduled",
                    action: "Track"
                ) {
                    onRoute(.activity)
                }
            } else {
                dashboardDetail(
                    "No work is running right now",
                    detail: "Hand off research, a draft, or a follow-up and it will stay visible here.",
                    tag: "Ready",
                    action: "Start"
                ) {
                    onPrompt("Help me plan the next piece of work")
                }
            }
        }
    }

    private var goalsCard: some View {
        DashboardCard(title: "Goals", icon: "scope", tint: AssistantTheme.accent(for: colorScheme)) {
            if let goal = firstGoal {
                dashboardDetail(
                    goal.goal.displayTitle,
                    detail: goal.goal.nextAction.isEmpty ? goal.cadenceLabel : "Next: \(goal.goal.nextAction)",
                    tag: goal.workActive ? "Active" : goal.cadenceLabel,
                    action: "Open"
                ) {
                    onRoute(.goals)
                }
            } else {
                dashboardDetail(
                    "Give a goal a home",
                    detail: "Name an outcome and the assistant can keep it moving between conversations.",
                    tag: "Plan ahead",
                    action: "Create"
                ) {
                    onPrompt("Help me define a goal and the first next steps")
                }
            }
        }
    }

    private var startCard: some View {
        DashboardCard(title: "Start a workstream", icon: "sparkles", tint: AssistantTheme.accent(for: colorScheme)) {
            VStack(spacing: 0) {
                promptRow("Plan a project", prompt: "Help me make a practical plan for a project", icon: "list.bullet.clipboard")
                DashboardDivider()
                promptRow("Research a decision", prompt: "Research the options and help me make a decision", icon: "magnifyingglass")
                DashboardDivider()
                promptRow("Draft something", prompt: "Help me draft a message", icon: "square.and.pencil")
            }
        }
    }

    private func dashboardDetail(
        _ title: String,
        detail: String,
        tag: String,
        action: String,
        perform actionHandler: @escaping () -> Void
    ) -> some View {
        Button(action: actionHandler) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                        .lineLimit(usesAccessibilityLayout ? nil : 2)
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                        .lineLimit(usesAccessibilityLayout ? nil : 3)
                    DashboardTag(title: tag)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 4) {
                    Text(action)
                        .font(.subheadline.weight(.medium))
                    Image(systemName: "arrow.right")
                        .font(.caption.weight(.bold))
                }
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .padding(.top, 2)
            }
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(DashboardButtonStyle(reduceMotion: reduceMotion))
        .disabled(isSending)
    }

    private func promptRow(_ title: String, prompt: String, icon: String) -> some View {
        Button {
            onPrompt(prompt)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.semibold))
                    .frame(width: 26)
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
            }
            .frame(minHeight: 46)
            .contentShape(Rectangle())
        }
        .buttonStyle(DashboardButtonStyle(reduceMotion: reduceMotion))
        .disabled(isSending)
    }

    private func dashboardFooter(
        _ title: String,
        icon: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.semibold))
                    .frame(width: 26)
                Text(title)
                    .font(.body.weight(.medium))
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
            }
            .foregroundStyle(AssistantTheme.ink(for: colorScheme))
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(DashboardButtonStyle(reduceMotion: reduceMotion))
    }

    private func perform(_ destination: DashboardDestination) {
        switch destination {
        case let .route(route): onRoute(route)
        case let .prompt(prompt): onPrompt(prompt)
        }
    }
}

private struct DashboardCard<Content: View>: View {
    let title: String
    let icon: String
    let tint: Color
    let content: Content

    init(
        title: String,
        icon: String,
        tint: Color,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.icon = icon
        self.tint = tint
        self.content = content()
    }

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: AssistantTheme.cardCornerRadius, style: .continuous)

        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(tint)
                    .frame(width: 36, height: 36)
                    .background(tint.opacity(colorScheme == .dark ? 0.16 : 0.1), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    .accessibilityHidden(true)
                Text(title)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(AssistantTheme.ink(for: colorScheme))
                Spacer(minLength: 0)
            }

            DashboardDivider()
            content
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AssistantTheme.dashboardPaper(for: colorScheme), in: shape)
        .overlay {
            shape.strokeBorder(
                AssistantTheme.ink(for: colorScheme).opacity(colorScheme == .dark ? 0.12 : 0.07),
                lineWidth: 0.8
            )
        }
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.18 : 0.12), radius: 18, y: 8)
    }
}

private struct DashboardDivider: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Rectangle()
            .fill(AssistantTheme.ink(for: colorScheme).opacity(colorScheme == .dark ? 0.13 : 0.09))
            .frame(height: 1)
    }
}

private struct DashboardTag: View {
    let title: String
    var icon: String? = nil

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if let icon {
                Label(title, systemImage: icon)
            } else {
                Text(title)
            }
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(
            AssistantTheme.accent(for: colorScheme).opacity(colorScheme == .dark ? 0.15 : 0.09),
            in: Capsule()
        )
    }
}

private struct DashboardButtonStyle: ButtonStyle {
    let reduceMotion: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.72 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

private struct DashboardAgendaItem {
    let marker: String
    let title: String
    let tag: String
    let action: String
    let icon: String
    let destination: DashboardDestination
}

private enum DashboardDestination {
    case route(AssistantRoute)
    case prompt(String)

    var isPrompt: Bool {
        if case .prompt(_) = self { return true }
        return false
    }
}
