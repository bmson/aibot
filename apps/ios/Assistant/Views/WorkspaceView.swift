import SwiftUI
import UniformTypeIdentifiers

enum WorkspaceArea {
    case chats
    case documents
    case skills
    case capabilities
    case costs
    case anomalies
    case improvements

    var title: String {
        switch self {
        case .chats: "All chats"
        case .documents: "Documents"
        case .skills: "Skills"
        case .capabilities: "Capabilities"
        case .costs: "Costs"
        case .anomalies: "Anomalies"
        case .improvements: "Improvements"
        }
    }

    var icon: String {
        switch self {
        case .chats: "bubble.left.and.bubble.right"
        case .documents: "doc.text"
        case .skills: "lightbulb"
        case .capabilities: "puzzlepiece.extension"
        case .costs: "dollarsign.circle"
        case .anomalies: "exclamationmark.triangle"
        case .improvements: "arrow.triangle.2.circlepath"
        }
    }

    var introduction: String {
        switch self {
        case .chats:
            "Your main thread, active conversations, and the history you have kept."
        case .documents:
            "Files the assistant can search and cite when you ask a question in chat."
        case .skills:
            "Procedures the assistant has learned from completed work and reads as advice before planning."
        case .capabilities:
            "Optional tools installed on this assistant, including anything that still needs setup."
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showingDocumentImporter = false
    @State private var showingBackstoryImporter = false
    @State private var deletingDocument: DocumentRecord?
    @State private var showingSkillCreator = false
    @State private var editingSkill: WorkspaceSkill?
    @State private var deletingSkill: WorkspaceSkill?
    @State private var showingCostEditor = false
    @State private var workspaceActionInFlight: String?

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
        .scrollBounceBehavior(.basedOnSize)
        .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
        .navigationTitle(area.title)
        .navigationBarTitleDisplayMode(usesAccessibilityLayout ? .inline : .large)
        .refreshable { await refresh() }
        .task { await load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if area == .documents {
                    Menu {
                        Button("Add document", systemImage: "plus") {
                            showingDocumentImporter = true
                        }
                        Button("Import backstory", systemImage: "tray.and.arrow.down") {
                            showingBackstoryImporter = true
                        }
                    } label: {
                        Label("Document actions", systemImage: "ellipsis.circle")
                    }
                } else if area == .skills {
                    Button("Add skill", systemImage: "plus") { showingSkillCreator = true }
                } else if area == .costs {
                    Button("Edit limits", systemImage: "slider.horizontal.3") {
                        showingCostEditor = true
                    }
                }
            }
        }
        .fileImporter(
            isPresented: $showingDocumentImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: false
        ) { result in
            guard case let .success(urls) = result, let url = urls.first else {
                if case let .failure(error) = result { model.errorMessage = error.localizedDescription }
                return
            }
            uploadDocument(from: url)
        }
        .fileImporter(
            isPresented: $showingBackstoryImporter,
            allowedContentTypes: [.plainText, .json, .data],
            allowsMultipleSelection: false
        ) { result in
            guard case let .success(urls) = result, let url = urls.first else {
                if case let .failure(error) = result { model.errorMessage = error.localizedDescription }
                return
            }
            uploadBackstory(from: url)
        }
        .sheet(isPresented: $showingSkillCreator) {
            NavigationStack { SkillEditor(skill: nil) }
        }
        .sheet(item: $editingSkill) { skill in
            NavigationStack { SkillEditor(skill: skill) }
        }
        .sheet(isPresented: $showingCostEditor) {
            if let costs = model.workspace?.costs {
                NavigationStack { CostLimitsEditor(costs: costs) }
            }
        }
        .confirmationDialog(
            "Delete this document?",
            isPresented: Binding(
                get: { deletingDocument != nil },
                set: { if !$0 { deletingDocument = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let document = deletingDocument {
                Button("Delete document", role: .destructive) {
                    workspaceActionInFlight = document.id
                    Task {
                        _ = await model.deleteDocument(document)
                        workspaceActionInFlight = nil
                    }
                    deletingDocument = nil
                }
            }
            Button("Cancel", role: .cancel) { deletingDocument = nil }
        } message: {
            Text("This removes the file and its searchable passages.")
        }
        .confirmationDialog(
            "Delete this skill?",
            isPresented: Binding(
                get: { deletingSkill != nil },
                set: { if !$0 { deletingSkill = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let skill = deletingSkill {
                Button("Delete skill", role: .destructive) {
                    workspaceActionInFlight = skill.id
                    Task {
                        _ = await model.deleteSkill(skill)
                        workspaceActionInFlight = nil
                    }
                    deletingSkill = nil
                }
            }
            Button("Cancel", role: .cancel) { deletingSkill = nil }
        }
    }

    @ViewBuilder
    private var header: some View {
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 11) {
                headerIcon
                headerIntroduction
            }
            .padding(.vertical, 3)
        } else {
            HStack(alignment: .top, spacing: 13) {
                headerIcon
                headerIntroduction
                Spacer(minLength: 0)
            }
            .padding(.vertical, 3)
        }
    }

    private var headerIcon: some View {
        Image(systemName: area.icon)
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
            .frame(width: 46, height: 46)
            .background(
                AssistantTheme.accent(for: colorScheme).opacity(0.12),
                in: RoundedRectangle(cornerRadius: 15, style: .continuous)
            )
    }

    private var headerIntroduction: some View {
        Text(area.introduction)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func workspaceContent(_ workspace: WorkspaceResponse) -> some View {
        switch area {
        case .chats:
            chats(workspace.chats)
        case .skills:
            skills(workspace.skills)
        case .capabilities:
            capabilities(workspace.capabilities)
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
            HStack {
                sectionHeading("Current chats", count: chats.current.count)
                Spacer()
                Button {
                    workspaceActionInFlight = "new-chat"
                    Task {
                        _ = await model.createConversation()
                        workspaceActionInFlight = nil
                    }
                } label: {
                    Label("New chat", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(workspaceActionInFlight != nil)
                Menu {
                    Button("Archive inactive chats", systemImage: "archivebox") {
                        workspaceActionInFlight = "archive-inactive"
                        Task {
                            _ = await model.archiveInactiveConversations()
                            workspaceActionInFlight = nil
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .disabled(workspaceActionInFlight != nil)
            }

            if chats.current.isEmpty {
                emptyState("No conversations yet", symbol: "bubble.left")
            } else {
                ForEach(chats.current) { chat in
                    HStack(spacing: 12) {
                        Button {
                            openChat(chat)
                        } label: {
                            HStack(spacing: 12) {
                                AssistantGlyph(
                                    systemName: chat.isPrimary ? "bubble.left.fill" : "bubble.left",
                                    tint: AssistantTheme.accent(for: colorScheme),
                                    sunkenBackground: true
                                )
                                chatIdentity(chat)
                            }
                        }
                        .buttonStyle(.plain)
                        Spacer(minLength: 0)
                        if !chat.isPrimary {
                            Menu {
                                Button("Archive", systemImage: "archivebox") {
                                    updateChat(chat, action: "archive")
                                }
                                .disabled(chat.active)
                            } label: {
                                Image(systemName: "ellipsis.circle")
                            }
                            .disabled(workspaceActionInFlight != nil)
                        }
                    }
                    .assistantCard(in: colorScheme)
                }
            }

            if !chats.archived.isEmpty {
                DisclosureGroup("Archived chats (\(chats.archived.count))") {
                    VStack(spacing: 0) {
                        ForEach(chats.archived) { chat in
                            HStack {
                                Button { openChat(chat) } label: {
                                if usesAccessibilityLayout {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(chat.displayTitle)
                                        Text(relative(chat.updatedAt))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                } else {
                                    HStack {
                                        Text(chat.displayTitle).lineLimit(1)
                                        Spacer()
                                        Text(relative(chat.updatedAt))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                }
                                .buttonStyle(.plain)
                                Spacer()
                                Button("Restore", systemImage: "tray.and.arrow.up") {
                                    updateChat(chat, action: "restore")
                                }
                                .labelStyle(.iconOnly)
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(Rectangle())
                                .disabled(workspaceActionInFlight != nil)
                            }
                            .padding(.vertical, 10)
                            if chat.id != chats.archived.last?.id { Divider() }
                        }
                    }
                    .padding(.top, 8)
                }
                .font(.subheadline.weight(.semibold))
                .assistantPanel(in: colorScheme)
            }
        }
    }

    private var documentsContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let documents = model.overview?.documents {
                metricGrid([
                    ("Filed", documents.stats.total, "doc", AssistantTheme.accent(for: colorScheme)),
                    ("Ready", documents.stats.ready, "checkmark.circle", AssistantTheme.success(for: colorScheme)),
                    ("Reading", documents.stats.pending, "clock.arrow.circlepath", AssistantTheme.warning(for: colorScheme)),
                ])

                sectionHeading("Filed documents", count: documents.documents.count)
                if documents.documents.isEmpty {
                    emptyState("No documents filed", symbol: "doc")
                } else {
                    ForEach(documents.documents) { document in
                        documentCard(document)
                    }
                }

                if let imports = model.workspace?.imports {
                    backstoryImports(imports)
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
                        if usesAccessibilityLayout {
                            VStack(alignment: .leading, spacing: 7) {
                                skillIdentity(skill)
                                if skill.deprecated { workspaceTag("Retired", tint: .secondary) }
                            }
                        } else {
                            HStack(alignment: .top) {
                                skillIdentity(skill)
                                Spacer()
                                if skill.deprecated { workspaceTag("Retired", tint: .secondary) }
                            }
                        }
                        Text(skill.steps)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                        if !skill.preconditions.isEmpty || !skill.gotchas.isEmpty {
                            if usesAccessibilityLayout {
                                VStack(alignment: .leading, spacing: 8) {
                                    skillDetailPills(skill)
                                }
                            } else {
                                HStack(alignment: .top, spacing: 8) {
                                    skillDetailPills(skill)
                                }
                            }
                        }
                        Text("Used \(skill.useCount) times · \(skill.successCount) successful")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                        HStack(spacing: 9) {
                            Button("Edit", systemImage: "pencil") { editingSkill = skill }
                                .buttonStyle(.bordered)
                            Button(
                                skill.deprecated ? "Restore" : "Retire",
                                systemImage: skill.deprecated ? "arrow.uturn.backward" : "archivebox"
                            ) {
                                workspaceActionInFlight = skill.id
                                Task {
                                    _ = await model.setSkillDeprecated(
                                        skill,
                                        deprecated: !skill.deprecated
                                    )
                                    workspaceActionInFlight = nil
                                }
                            }
                            .buttonStyle(.bordered)
                            Button("Delete", systemImage: "trash", role: .destructive) {
                                deletingSkill = skill
                            }
                            .buttonStyle(.bordered)
                        }
                        .disabled(workspaceActionInFlight != nil)
                    }
                    .opacity(skill.deprecated ? 0.6 : 1)
                    .assistantCard(in: colorScheme)
                }
            }
        }
    }

    @ViewBuilder
    private func capabilities(_ capabilities: [WorkspaceCapability]?) -> some View {
        if let capabilities {
            let enabledCount = capabilities.filter(\.enabled).count
            let readyCount = capabilities.filter { $0.enabled && $0.ready }.count

            VStack(alignment: .leading, spacing: 14) {
                metricGrid([
                    ("Installed", enabledCount, "puzzlepiece.extension", AssistantTheme.accent(for: colorScheme)),
                    ("Ready", readyCount, "checkmark.circle", AssistantTheme.success(for: colorScheme)),
                    ("Available", capabilities.count, "square.grid.2x2", .secondary),
                ])

                sectionHeading("Optional capabilities", count: capabilities.count)

                ForEach(capabilities) { capability in
                    let tint: Color = if !capability.enabled {
                        .secondary
                    } else if capability.ready {
                        AssistantTheme.success(for: colorScheme)
                    } else if capability.status == "unavailable" {
                        .secondary
                    } else {
                        AssistantTheme.warning(for: colorScheme)
                    }

                    HStack(alignment: .top, spacing: 12) {
                        AssistantGlyph(systemName: capability.icon, tint: tint)
                            .accessibilityHidden(true)

                        VStack(alignment: .leading, spacing: 5) {
                            if usesAccessibilityLayout {
                                VStack(alignment: .leading, spacing: 7) {
                                    Text(capability.title)
                                        .font(.headline)
                                    workspaceTag(capability.statusTitle, tint: tint)
                                }
                            } else {
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text(capability.title)
                                        .font(.headline)
                                    Spacer(minLength: 4)
                                    workspaceTag(capability.statusTitle, tint: tint)
                                }
                            }
                            Text(capability.summary)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            if capability.enabled && !capability.ready {
                                Text(capability.detail.sentenceCaseIdentifier)
                                    .font(.caption)
                                    .foregroundStyle(
                                        capability.status == "unavailable"
                                            ? Color.secondary
                                            : AssistantTheme.warning(for: colorScheme)
                                    )
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .assistantCard(in: colorScheme)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(capability.title), \(capability.statusTitle). \(capability.summary)")
                }
            }
        } else {
            AssistantEmptyState(
                "Capabilities unavailable",
                systemImage: "puzzlepiece.extension",
                description: "Update the assistant server to see installed optional tools."
            )
        }
    }

    private func costs(_ costs: WorkspaceCosts) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if usesAccessibilityLayout {
                VStack(spacing: 10) {
                    costMetric("Today", spent: costs.dailySpentUsd, limit: costs.dailyLimitUsd)
                    costMetric("This month", spent: costs.monthlySpentUsd, limit: costs.monthlyLimitUsd)
                }
            } else {
                HStack(spacing: 10) {
                    costMetric("Today", spent: costs.dailySpentUsd, limit: costs.dailyLimitUsd)
                    costMetric("This month", spent: costs.monthlySpentUsd, limit: costs.monthlyLimitUsd)
                }
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
            Button("Edit spending limits", systemImage: "slider.horizontal.3") {
                showingCostEditor = true
            }
            .buttonStyle(.bordered)
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
                        if usesAccessibilityLayout {
                            VStack(alignment: .leading, spacing: 4) {
                                workspaceTag(
                                    anomaly.kind.sentenceCaseIdentifier,
                                    tint: anomaly.kind == "burst"
                                        ? .red
                                        : AssistantTheme.warning(for: colorScheme)
                                )
                                Text(anomaly.toolName.sentenceCaseIdentifier)
                                    .font(.headline)
                                Text(relative(anomaly.createdAt))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 4) {
                                    workspaceTag(
                                        anomaly.kind.sentenceCaseIdentifier,
                                        tint: anomaly.kind == "burst"
                                            ? .red
                                            : AssistantTheme.warning(for: colorScheme)
                                    )
                                    Text(anomaly.toolName.sentenceCaseIdentifier)
                                        .font(.headline)
                                }
                                Spacer()
                                Text(relative(anomaly.createdAt))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Text(anomaly.detail)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Observed \(anomaly.observed)× · expected \(anomaly.expected)× · \(anomaly.citationCount) evidence items")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                        HStack(spacing: 9) {
                            if anomaly.hasPolicy {
                                Button("Suspend policy", systemImage: "pause.circle") {
                                    updateAnomaly(anomaly, action: "suspend-policy")
                                }
                                .buttonStyle(.borderedProminent)
                            }
                            Button("Dismiss", systemImage: "xmark") {
                                updateAnomaly(anomaly, action: "dismiss")
                            }
                            .buttonStyle(.bordered)
                        }
                        .disabled(workspaceActionInFlight != nil)
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
                        if usesAccessibilityLayout {
                            VStack(alignment: .leading, spacing: 4) {
                                workspaceTag(improvement.kind.sentenceCaseIdentifier, tint: AssistantTheme.accent(for: colorScheme))
                                Text(inlineMarkdown(improvement.title)).font(.headline)
                                Text(relative(improvement.createdAt))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 4) {
                                    workspaceTag(improvement.kind.sentenceCaseIdentifier, tint: AssistantTheme.accent(for: colorScheme))
                                    Text(inlineMarkdown(improvement.title)).font(.headline)
                                }
                                Spacer()
                                Text(relative(improvement.createdAt))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        if !improvement.rationale.isEmpty {
                            Text(inlineMarkdown(improvement.rationale))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        if !improvement.suggestion.isEmpty {
                            detailPill("Proposed change", detail: improvement.suggestion, tint: AssistantTheme.sunken(for: colorScheme))
                        }
                        Text("Based on \(improvement.evidenceCount) \(improvement.evidenceCount == 1 ? "pattern" : "patterns") · \(improvement.applyable ? "Can apply directly" : "Advisory")")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                        HStack(spacing: 9) {
                            Button(
                                improvement.applyable ? "Apply" : "Acknowledge",
                                systemImage: "checkmark"
                            ) {
                                updateImprovement(improvement, action: "apply")
                            }
                            .buttonStyle(.borderedProminent)
                            Button("Dismiss", systemImage: "xmark") {
                                updateImprovement(improvement, action: "dismiss")
                            }
                            .buttonStyle(.bordered)
                        }
                        .disabled(workspaceActionInFlight != nil)
                    }
                    .assistantCard(in: colorScheme)
                }
            }
        }
    }

    private func documentCard(_ document: DocumentRecord) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            documentHeader(document)
            Text("\(ByteCountFormatter.string(fromByteCount: Int64(document.bytes), countStyle: .file)) · \(document.chunkCount) searchable \(document.chunkCount == 1 ? "passage" : "passages")")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            if document.status == "ready" {
                HStack(spacing: 9) {
                    Button {
                        model.returnToChat()
                        model.send("From my documents, tell me about \"\(document.title)\".")
                    } label: {
                        Label("Ask about this", systemImage: "bubble.left")
                            .font(.subheadline.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .tint(AssistantTheme.accent(for: colorScheme))
                    .disabled(model.isSending)
                    Button("Delete", systemImage: "trash", role: .destructive) {
                        deletingDocument = document
                    }
                    .buttonStyle(.bordered)
                }
                .accessibilityHint(
                    model.isSending
                        ? "Finish or stop the current response first"
                        : "Starts a question in chat"
                )
            }
            if document.status == "failed", let error = document.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
            }
            if document.status != "ready" {
                Button("Delete", systemImage: "trash", role: .destructive) {
                    deletingDocument = document
                }
                .buttonStyle(.bordered)
            }
        }
        .assistantCard(in: colorScheme)
    }

    private func backstoryImports(_ imports: WorkspaceImports) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                sectionHeading("Backstory imports", count: imports.sources.count)
                Spacer()
                Button("Upload", systemImage: "tray.and.arrow.down") {
                    showingBackstoryImporter = true
                }
                .buttonStyle(.bordered)
            }
            ForEach(imports.unstartedFiles) { file in
                HStack {
                    Text(file.name).font(.subheadline).lineLimit(1)
                    Spacer()
                    Button("Start") {
                        updateImport(
                            action: "start",
                            source: file.name.replacingOccurrences(
                                of: #"\.[A-Za-z0-9]+$"#,
                                with: "",
                                options: .regularExpression
                            ).lowercased(),
                            workspacePath: "import/\(file.name)"
                        )
                    }
                    .buttonStyle(.bordered)
                }
                .assistantCard(in: colorScheme)
            }
            ForEach(imports.sources) { source in
                VStack(alignment: .leading, spacing: 9) {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(source.source).font(.headline)
                            Text("\(source.memoriesSaved) saved · \(source.itemsProcessed) processed")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        StatusPill(status: source.status)
                    }
                    if source.quarantinedNow > 0 {
                        Text("\(source.quarantinedNow) memories are waiting for review.")
                            .font(.caption)
                            .foregroundStyle(AssistantTheme.warning(for: colorScheme))
                    }
                    if let error = source.error, !error.isEmpty {
                        Text(error).font(.caption).foregroundStyle(.red)
                    }
                    HStack(spacing: 9) {
                        if source.quarantinedNow > 0 {
                            Button("Approve all") {
                                updateImport(action: "review", source: source.source, verdict: "approve")
                            }
                            .buttonStyle(.borderedProminent)
                            Button("Reject all") {
                                updateImport(action: "review", source: source.source, verdict: "reject")
                            }
                            .buttonStyle(.bordered)
                        }
                        Menu {
                            Button("Run again") {
                                updateImport(
                                    action: "start",
                                    source: source.source,
                                    workspacePath: source.workspacePath
                                )
                            }
                            Button("Purge learned memories", role: .destructive) {
                                updateImport(action: "purge", source: source.source)
                            }
                            Button("Delete source", role: .destructive) {
                                updateImport(action: "delete", source: source.source)
                            }
                        } label: {
                            Label("More", systemImage: "ellipsis.circle")
                        }
                        .buttonStyle(.bordered)
                    }
                    .disabled(workspaceActionInFlight != nil)
                }
                .assistantCard(in: colorScheme)
            }
        }
    }

    @ViewBuilder
    private func documentHeader(_ document: DocumentRecord) -> some View {
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .center) {
                    documentGlyph(document)
                    Spacer(minLength: 10)
                    StatusPill(status: document.status)
                }
                documentIdentity(document)
            }
        } else {
            HStack(alignment: .top, spacing: 11) {
                documentGlyph(document)
                documentIdentity(document)
                Spacer()
                StatusPill(status: document.status)
            }
        }
    }

    private func documentGlyph(_ document: DocumentRecord) -> some View {
        AssistantGlyph(
            systemName: documentIcon(document.mime),
            tint: AssistantTheme.accent(for: colorScheme),
            sunkenBackground: true
        )
    }

    private func documentIdentity(_ document: DocumentRecord) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(document.title)
                .font(.headline)
                .lineLimit(usesAccessibilityLayout ? nil : 2)
            Text(document.source == "email" ? "Email attachment" : document.source.sentenceCaseIdentifier)
                .font(.caption)
                .foregroundStyle(.secondary)
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
                    if usesAccessibilityLayout {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(row.0)
                                .fixedSize(horizontal: false, vertical: true)
                            HStack(spacing: 9) {
                                Text("\(row.2)×").foregroundStyle(.secondary)
                                Text(currency(Double(row.1) ?? 0)).font(.caption.monospacedDigit())
                            }
                        }
                        .font(.caption)
                        .padding(.vertical, 5)
                    } else {
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
        }
        .assistantCard(in: colorScheme)
    }

    private func inlineMarkdown(_ source: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: source, options: options))
            ?? AttributedString(source)
    }

    @ViewBuilder
    private func metricGrid(_ metrics: [(String, Int, String, Color)]) -> some View {
        if usesAccessibilityLayout {
            VStack(spacing: 8) {
                metricCards(metrics)
            }
        } else {
            HStack(spacing: 8) {
                metricCards(metrics)
            }
        }
    }

    @ViewBuilder
    private func metricCards(_ metrics: [(String, Int, String, Color)]) -> some View {
        ForEach(Array(metrics.enumerated()), id: \.offset) { _, metric in
            VStack(alignment: .leading, spacing: 5) {
                Image(systemName: metric.2)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(metric.3)
                    .accessibilityHidden(true)
                Text("\(metric.1)")
                    .font(.title3.monospacedDigit().weight(.semibold))
                    .contentTransition(.numericText(value: Double(metric.1)))
                    .animation(
                        reduceMotion ? nil : .snappy(duration: 0.24, extraBounce: 0),
                        value: metric.1
                    )
                Text(metric.0)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(usesAccessibilityLayout ? nil : 1)
                    .minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .assistantCard(in: colorScheme)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(metric.0), \(metric.1)")
        }
    }

    private func chatIdentity(_ chat: WorkspaceChat) -> some View {
        VStack(alignment: .leading, spacing: usesAccessibilityLayout ? 6 : 3) {
            if usesAccessibilityLayout {
                Text(chat.displayTitle)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    chatTags(chat)
                }
            } else {
                HStack(spacing: 6) {
                    Text(chat.displayTitle)
                        .font(.headline)
                        .lineLimit(1)
                    chatTags(chat)
                }
            }
            Text("Last active \(relative(chat.updatedAt))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func chatTags(_ chat: WorkspaceChat) -> some View {
        if chat.isPrimary {
            workspaceTag("Main", tint: AssistantTheme.accent(for: colorScheme))
        }
        if chat.active {
            workspaceTag("Working", tint: AssistantTheme.warning(for: colorScheme))
        }
    }

    private func skillIdentity(_ skill: WorkspaceSkill) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(skill.name)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
            Text(skill.ownerAuthored ? "Written by you" : "Learned from completed work")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func skillDetailPills(_ skill: WorkspaceSkill) -> some View {
        if !skill.preconditions.isEmpty {
            detailPill(
                "When to use",
                detail: skill.preconditions,
                tint: AssistantTheme.sunken(for: colorScheme)
            )
        }
        if !skill.gotchas.isEmpty {
            detailPill(
                "Watch for",
                detail: skill.gotchas,
                tint: AssistantTheme.warningSurface(for: colorScheme)
            )
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

    @ViewBuilder
    private func sectionHeading(_ title: String, count: Int? = nil) -> some View {
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.headline)
                if let count { countTag(count) }
            }
        } else {
            HStack(spacing: 7) {
                Text(title).font(.headline)
                if let count { countTag(count) }
            }
        }
    }

    private func countTag(_ count: Int) -> some View {
        Text("\(count)")
            .font(.caption.monospacedDigit().weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
    }

    private func workspaceTag(_ title: String, tint: Color) -> some View {
        Text(title)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(tint.opacity(0.11), in: Capsule())
    }

    private func emptyState(_ title: String, symbol: String) -> some View {
        AssistantEmptyState(title, systemImage: symbol)
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

    private func openChat(_ chat: WorkspaceChat) {
        workspaceActionInFlight = chat.id
        Task {
            _ = await model.openConversation(id: chat.id)
            workspaceActionInFlight = nil
        }
    }

    private func updateChat(_ chat: WorkspaceChat, action: String) {
        workspaceActionInFlight = chat.id
        Task {
            _ = await model.updateConversation(chat, action: action)
            workspaceActionInFlight = nil
        }
    }

    private func updateAnomaly(_ anomaly: WorkspaceAnomaly, action: String) {
        workspaceActionInFlight = anomaly.id
        Task {
            _ = await model.updateAnomaly(anomaly, action: action)
            workspaceActionInFlight = nil
        }
    }

    private func updateImprovement(_ improvement: WorkspaceImprovement, action: String) {
        workspaceActionInFlight = improvement.id
        Task {
            _ = await model.updateImprovement(improvement, action: action)
            workspaceActionInFlight = nil
        }
    }

    private func uploadDocument(from url: URL) {
        workspaceActionInFlight = "document-upload"
        Task {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                guard data.count <= 25 * 1024 * 1024 else {
                    model.errorMessage = "Documents must be 25 MB or smaller."
                    workspaceActionInFlight = nil
                    return
                }
                let type = UTType(filenameExtension: url.pathExtension)
                _ = await model.uploadDocument(
                    data: data,
                    name: url.lastPathComponent,
                    title: url.deletingPathExtension().lastPathComponent,
                    mime: type?.preferredMIMEType ?? "application/octet-stream"
                )
            } catch {
                model.errorMessage = error.localizedDescription
            }
            workspaceActionInFlight = nil
        }
    }

    private func uploadBackstory(from url: URL) {
        workspaceActionInFlight = "backstory-upload"
        Task {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                guard data.count <= 25 * 1024 * 1024 else {
                    model.errorMessage = "Imports must be 25 MB or smaller."
                    workspaceActionInFlight = nil
                    return
                }
                _ = await model.uploadImport(data: data, name: url.lastPathComponent)
            } catch {
                model.errorMessage = error.localizedDescription
            }
            workspaceActionInFlight = nil
        }
    }

    private func updateImport(
        action: String,
        source: String,
        verdict: String? = nil,
        workspacePath: String? = nil
    ) {
        workspaceActionInFlight = source
        Task {
            _ = await model.updateImport(
                action: action,
                source: source,
                verdict: verdict,
                workspacePath: workspacePath
            )
            workspaceActionInFlight = nil
        }
    }

    private func load() async {
        if area == .documents {
            if model.overview == nil { await model.refreshOverview() }
            if model.workspace == nil { await model.refreshWorkspace() }
        } else if model.workspace == nil {
            await model.refreshWorkspace()
        }
    }

    private func refresh() async {
        if area == .documents {
            async let overviewRefresh: Void = model.refreshOverview()
            async let workspaceRefresh: Void = model.refreshWorkspace()
            _ = await (overviewRefresh, workspaceRefresh)
        } else {
            await model.refreshWorkspace()
        }
    }
}

private struct SkillEditor: View {
    let skill: WorkspaceSkill?

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var preconditions: String
    @State private var steps: String
    @State private var gotchas: String
    @State private var isSaving = false

    init(skill: WorkspaceSkill?) {
        self.skill = skill
        _name = State(initialValue: skill?.name ?? "")
        _preconditions = State(initialValue: skill?.preconditions ?? "")
        _steps = State(initialValue: skill?.steps ?? "")
        _gotchas = State(initialValue: skill?.gotchas ?? "")
    }

    var body: some View {
        Form {
            Section("Skill") {
                TextField("Name", text: $name)
                TextField("When to use it", text: $preconditions, axis: .vertical)
                    .lineLimit(2...5)
                TextField("Steps", text: $steps, axis: .vertical)
                    .lineLimit(4...10)
                TextField("Gotchas", text: $gotchas, axis: .vertical)
                    .lineLimit(2...5)
            }
        }
        .navigationTitle(skill == nil ? "New skill" : "Edit skill")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(
                        isSaving
                            || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || steps.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
            }
        }
    }

    private func save() {
        isSaving = true
        Task {
            let saved = await model.saveSkill(
                id: skill?.id,
                mutation: .init(
                    name: name,
                    preconditions: preconditions,
                    steps: steps,
                    gotchas: gotchas
                )
            )
            isSaving = false
            if saved { dismiss() }
        }
    }
}

private struct CostLimitsEditor: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var taskDefault: String
    @State private var daily: String
    @State private var monthly: String
    @State private var isSaving = false

    init(costs: WorkspaceCosts) {
        _taskDefault = State(initialValue: costs.taskDefaultLimit ?? "")
        _daily = State(initialValue: costs.dailyLimitUsd.map { String($0) } ?? "")
        _monthly = State(initialValue: costs.monthlyLimitUsd.map { String($0) } ?? "")
    }

    var body: some View {
        Form {
            Section {
                TextField("Default task limit", text: $taskDefault)
                    .keyboardType(.decimalPad)
                TextField("Daily limit", text: $daily)
                    .keyboardType(.decimalPad)
                TextField("Monthly limit", text: $monthly)
                    .keyboardType(.decimalPad)
            } header: {
                Text("Spending limits in USD")
            } footer: {
                Text("Limits must be between $0.01 and $10,000. Blank fields keep their current value.")
            }
        }
        .navigationTitle("Spending limits")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(isSaving)
            }
        }
    }

    private func save() {
        isSaving = true
        Task {
            let saved = await model.updateCostLimits(
                .init(taskDefault: taskDefault, daily: daily, monthly: monthly)
            )
            isSaving = false
            if saved { dismiss() }
        }
    }
}
