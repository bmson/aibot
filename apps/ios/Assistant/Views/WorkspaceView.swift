import SwiftUI

enum WorkspaceArea {
    case chats
    case memory
    case documents
    case skills
    case costs
    case anomalies
    case improvements

    var title: String {
        switch self {
        case .chats: "All chats"
        case .memory: "Memory"
        case .documents: "Documents"
        case .skills: "Skills"
        case .costs: "Costs"
        case .anomalies: "Anomalies"
        case .improvements: "Improvements"
        }
    }

    var icon: String {
        switch self {
        case .chats: "bubble.left.and.bubble.right"
        case .memory: "brain.head.profile"
        case .documents: "doc.text"
        case .skills: "lightbulb"
        case .costs: "dollarsign.circle"
        case .anomalies: "exclamationmark.triangle"
        case .improvements: "arrow.triangle.2.circlepath"
        }
    }

    var introduction: String {
        switch self {
        case .chats:
            "Your main thread, active conversations, and the history you have kept."
        case .memory:
            "The durable context the assistant can use, plus anything still waiting for your review."
        case .documents:
            "Files the assistant can search and cite when you ask a question in chat."
        case .skills:
            "Procedures the assistant has learned from completed work and reads as advice before planning."
        case .costs:
            "Live spend, reserved work, and the limits that keep your assistant in control."
        case .anomalies:
            "Unusual approval-policy activity that deserves a closer look before it becomes routine."
        case .improvements:
            "Changes the assistant has proposed from its own reliability and cost reviews."
        }
    }
}

struct WorkspaceView: View {
    let area: WorkspaceArea

    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header

                if area == .documents {
                    documentsContent
                } else if let workspace = model.workspace {
                    workspaceContent(workspace)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 180)
                        .accessibilityLabel("Loading \(area.title.lowercased())")
                }
            }
            .padding(16)
            .padding(.bottom, 28)
        }
        .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
        .navigationTitle(area.title)
        .navigationBarTitleDisplayMode(usesAccessibilityLayout ? .inline : .large)
        .refreshable { await refresh() }
        .task { await load() }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: area.icon)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .frame(width: 46, height: 46)
                .background(
                    AssistantTheme.accent(for: colorScheme).opacity(0.12),
                    in: RoundedRectangle(cornerRadius: 15, style: .continuous)
                )

            VStack(alignment: .leading, spacing: 4) {
                Text(area.introduction)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
    }

    @ViewBuilder
    private func workspaceContent(_ workspace: WorkspaceResponse) -> some View {
        switch area {
        case .chats:
            chats(workspace.chats)
        case .memory:
            memory(workspace.memory)
        case .skills:
            skills(workspace.skills)
        case .costs:
            costs(workspace.costs)
        case .anomalies:
            anomalies(workspace.anomalies)
        case .improvements:
            improvements(workspace.improvements)
        case .documents:
            EmptyView()
        }
    }

    private func chats(_ chats: WorkspaceChats) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeading("Current chats", count: chats.current.count)

            if chats.current.isEmpty {
                emptyState("No conversations yet", symbol: "bubble.left")
            } else {
                ForEach(chats.current) { chat in
                    HStack(spacing: 12) {
                        Image(systemName: chat.isPrimary ? "bubble.left.fill" : "bubble.left")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            .frame(width: 38, height: 38)
                            .background(
                                AssistantTheme.sunken(for: colorScheme),
                                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                            )
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(chat.displayTitle)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                if chat.isPrimary { workspaceTag("Main", tint: AssistantTheme.accent(for: colorScheme)) }
                                if chat.active { workspaceTag("Working", tint: .orange) }
                            }
                            Text("Last active \(relative(chat.updatedAt))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .assistantCard(in: colorScheme)
                }
            }

            if !chats.archived.isEmpty {
                DisclosureGroup("Archived chats (\(chats.archived.count))") {
                    VStack(spacing: 0) {
                        ForEach(chats.archived) { chat in
                            HStack {
                                Text(chat.displayTitle).lineLimit(1)
                                Spacer()
                                Text(relative(chat.updatedAt))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 10)
                            if chat.id != chats.archived.last?.id { Divider() }
                        }
                    }
                    .padding(.top, 8)
                }
                .font(.subheadline.weight(.semibold))
                .padding(16)
                .background(AssistantTheme.sunken(for: colorScheme).opacity(0.72), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
    }

    private func memory(_ memory: WorkspaceMemory) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            metricGrid([
                ("In use", memory.health.totalUsable, "brain.head.profile", AssistantTheme.accent(for: colorScheme)),
                ("Review", memory.health.awaitingReview, "checklist", .orange),
                ("Verified", memory.health.ownerConfirmed, "checkmark.seal", .green),
            ])

            if !memory.awaitingReview.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    sectionHeading("Waiting on you", count: memory.awaitingReview.count)
                    Text("These notes came from an unverified source and are held out of the assistant’s working context.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(memory.awaitingReview.prefix(4)) { fact in
                        factRow(fact, review: true)
                    }
                }
            }

            sectionHeading(
                memory.ownerName.map { "About \($0)" } ?? "Memory library",
                count: memory.facts.count
            )

            if memory.facts.isEmpty {
                emptyState("Nothing saved yet", symbol: "brain")
            } else {
                ForEach(memory.facts.prefix(12)) { fact in
                    factRow(fact, review: false)
                }
                if memory.facts.count > 12 {
                    Text("Showing the most relevant recent notes.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            }
        }
    }

    private var documentsContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let documents = model.overview?.documents {
                metricGrid([
                    ("Filed", documents.stats.total, "doc", AssistantTheme.accent(for: colorScheme)),
                    ("Ready", documents.stats.ready, "checkmark.circle", .green),
                    ("Reading", documents.stats.pending, "clock.arrow.circlepath", .orange),
                ])

                sectionHeading("Filed documents", count: documents.documents.count)
                if documents.documents.isEmpty {
                    emptyState("No documents filed", symbol: "doc")
                } else {
                    ForEach(documents.documents) { document in
                        documentCard(document)
                    }
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 180)
            }
        }
    }

    private func skills(_ skills: [WorkspaceSkill]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeading("Learned procedures", count: skills.count)

            if skills.isEmpty {
                emptyState("No skills yet", symbol: "lightbulb")
            } else {
                ForEach(skills) { skill in
                    VStack(alignment: .leading, spacing: 11) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(skill.name)
                                    .font(.headline)
                                Text(skill.ownerAuthored ? "Written by you" : "Learned from completed work")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if skill.deprecated { workspaceTag("Retired", tint: .secondary) }
                        }
                        Text(skill.steps)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                        if !skill.preconditions.isEmpty || !skill.gotchas.isEmpty {
                            HStack(alignment: .top, spacing: 8) {
                                if !skill.preconditions.isEmpty {
                                    detailPill("When to use", detail: skill.preconditions, tint: AssistantTheme.sunken(for: colorScheme))
                                }
                                if !skill.gotchas.isEmpty {
                                    detailPill("Watch for", detail: skill.gotchas, tint: Color.orange.opacity(0.11))
                                }
                            }
                        }
                        Text("Used \(skill.useCount) times · \(skill.successCount) successful")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .opacity(skill.deprecated ? 0.6 : 1)
                    .assistantCard(in: colorScheme)
                }
            }
        }
    }

    private func costs(_ costs: WorkspaceCosts) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                costMetric("Today", spent: costs.dailySpentUsd, limit: costs.dailyLimitUsd)
                costMetric("This month", spent: costs.monthlySpentUsd, limit: costs.monthlyLimitUsd)
            }

            if costs.parkedTasks > 0 {
                Label(
                    "\(costs.parkedTasks) \(costs.parkedTasks == 1 ? "task is" : "tasks are") paused at a spending limit.",
                    systemImage: "pause.circle"
                )
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AssistantTheme.warningSurface(for: colorScheme), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }

            if costs.heldUsd > 0 {
                Label("\(currency(costs.heldUsd)) reserved for work in progress", systemImage: "clock.arrow.circlepath")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            sectionHeading("Usage this month")
            breakdownCard(title: "By source", rows: costs.bySource.map { ($0.source, $0.usd ?? "0", $0.count) })
            breakdownCard(title: "By model", rows: costs.byModel.map { ($0.model, $0.usd ?? "0", $0.count) })
        }
    }

    private func anomalies(_ anomalies: [WorkspaceAnomaly]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeading("Needs a closer look", count: anomalies.count)
            if anomalies.isEmpty {
                emptyState("Nothing unusual", symbol: "checkmark.shield")
            } else {
                ForEach(anomalies) { anomaly in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                workspaceTag(anomaly.kind.sentenceCaseIdentifier, tint: anomaly.kind == "burst" ? .red : .orange)
                                Text(anomaly.toolName.sentenceCaseIdentifier)
                                    .font(.headline)
                            }
                            Spacer()
                            Text(relative(anomaly.createdAt))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Text(anomaly.detail)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Observed \(anomaly.observed)× · expected \(anomaly.expected)× · \(anomaly.citationCount) evidence items")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .assistantCard(in: colorScheme)
                }
            }
        }
    }

    private func improvements(_ improvements: [WorkspaceImprovement]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeading("Open proposals", count: improvements.count)
            if improvements.isEmpty {
                emptyState("No open proposals", symbol: "checkmark.circle")
            } else {
                ForEach(improvements) { improvement in
                    VStack(alignment: .leading, spacing: 11) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                workspaceTag(improvement.kind.sentenceCaseIdentifier, tint: AssistantTheme.accent(for: colorScheme))
                                Text(improvement.title).font(.headline)
                            }
                            Spacer()
                            Text(relative(improvement.createdAt))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if !improvement.rationale.isEmpty {
                            Text(improvement.rationale)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        if !improvement.suggestion.isEmpty {
                            detailPill("Proposed change", detail: improvement.suggestion, tint: AssistantTheme.sunken(for: colorScheme))
                        }
                        Text("Based on \(improvement.evidenceCount) \(improvement.evidenceCount == 1 ? "pattern" : "patterns") · \(improvement.applyable ? "Can apply directly" : "Advisory")")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .assistantCard(in: colorScheme)
                }
            }
        }
    }

    private func documentCard(_ document: DocumentRecord) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: documentIcon(document.mime))
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                    .frame(width: 40, height: 40)
                    .background(AssistantTheme.sunken(for: colorScheme), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(document.title).font(.headline).lineLimit(2)
                    Text(document.source == "email" ? "Email attachment" : document.source.sentenceCaseIdentifier)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                StatusPill(status: document.status)
            }
            Text("\(ByteCountFormatter.string(fromByteCount: Int64(document.bytes), countStyle: .file)) · \(document.chunkCount) searchable \(document.chunkCount == 1 ? "passage" : "passages")")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            if document.status == "ready" {
                Button {
                    model.returnToChat()
                    model.send("From my documents, tell me about \\\"\(document.title)\\\".")
                } label: {
                    Label("Ask about this", systemImage: "bubble.left")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .tint(AssistantTheme.accent(for: colorScheme))
            }
            if document.status == "failed", let error = document.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
            }
        }
        .assistantCard(in: colorScheme)
    }

    private func factRow(_ fact: WorkspaceMemoryFact, review: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: review ? "questionmark.shield" : (fact.pinned ? "pin.fill" : "brain"))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(review ? .orange : AssistantTheme.accent(for: colorScheme))
                .frame(width: 32, height: 32)
                .background(
                    (review ? Color.orange : AssistantTheme.accent(for: colorScheme)).opacity(0.12),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
            VStack(alignment: .leading, spacing: 4) {
                Text(fact.content)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    if let domain = fact.domain, !domain.isEmpty {
                        Text(domain.sentenceCaseIdentifier)
                    }
                    Text(relative(fact.createdAt))
                    if fact.ownerConfirmed { Text("Verified") }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(
            review ? AssistantTheme.warningSurface(for: colorScheme) : AssistantTheme.raised(for: colorScheme),
            in: RoundedRectangle(cornerRadius: 17, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 17, style: .continuous)
                .stroke(.primary.opacity(colorScheme == .dark ? 0.12 : 0.07), lineWidth: 1)
        }
    }

    private func costMetric(_ title: String, spent: Double, limit: Double?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(currency(spent)).font(.title3.monospacedDigit().weight(.semibold))
            Text(limit.map { "of \(currency($0))" } ?? "No cap")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let limit, limit > 0 {
                GeometryReader { geometry in
                    Capsule()
                        .fill(AssistantTheme.sunken(for: colorScheme))
                        .overlay(alignment: .leading) {
                            Capsule()
                                .fill(spent >= limit ? Color.red : AssistantTheme.accent(for: colorScheme))
                                .frame(width: geometry.size.width * min(max(spent / limit, 0), 1))
                        }
                }
                .frame(height: 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantCard(in: colorScheme)
    }

    private func breakdownCard(title: String, rows: [(String, String, Int)]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold))
            if rows.isEmpty {
                Text("No spending yet this month").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(Array(rows.prefix(8).enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 9) {
                        Text(row.0).lineLimit(1)
                        Spacer(minLength: 8)
                        Text("\(row.2)×").foregroundStyle(.secondary)
                        Text(currency(Double(row.1) ?? 0)).font(.caption.monospacedDigit())
                    }
                    .font(.caption)
                    .padding(.vertical, 5)
                }
            }
        }
        .assistantCard(in: colorScheme)
    }

    private func metricGrid(_ metrics: [(String, Int, String, Color)]) -> some View {
        HStack(spacing: 8) {
            ForEach(Array(metrics.enumerated()), id: \.offset) { _, metric in
                VStack(alignment: .leading, spacing: 5) {
                    Image(systemName: metric.2)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(metric.3)
                    Text("\(metric.1)")
                        .font(.title3.monospacedDigit().weight(.semibold))
                    Text(metric.0)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .assistantCard(in: colorScheme)
            }
        }
    }

    private func detailPill(_ title: String, detail: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(detail).font(.caption).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(tint, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func sectionHeading(_ title: String, count: Int? = nil) -> some View {
        HStack(spacing: 7) {
            Text(title).font(.headline)
            if let count {
                Text("\(count)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
            }
        }
    }

    private func workspaceTag(_ title: String, tint: Color) -> some View {
        Text(title)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(tint.opacity(0.11), in: Capsule())
    }

    private func emptyState(_ title: String, symbol: String) -> some View {
        ContentUnavailableView(title, systemImage: symbol)
            .frame(maxWidth: .infinity, minHeight: 190)
            .background(AssistantTheme.raised(for: colorScheme), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func documentIcon(_ mime: String) -> String {
        if mime.contains("pdf") { return "doc.richtext" }
        if mime.contains("image") { return "photo" }
        return "doc.text"
    }

    private func currency(_ value: Double) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(value > 0 && value < 0.01 ? 4 : 2)))
    }

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    private func load() async {
        if area == .documents {
            if model.overview == nil { await model.refreshOverview() }
        } else if model.workspace == nil {
            await model.refreshWorkspace()
        }
    }

    private func refresh() async {
        if area == .documents {
            await model.refreshOverview()
        } else {
            await model.refreshWorkspace()
        }
    }
}
