import SwiftUI

struct MoreView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject private var notifications = NotificationManager.shared
    @AppStorage(AssistantAppearance.defaultsKey) private var appearance = AssistantAppearance.dark
    @AppStorage(AppModel.shareLocationKey) private var shareLocation = false
    @AppStorage(AppModel.shareLocationBackgroundKey) private var shareLocationBackground = false
    @ObservedObject private var locations = LocationManager.shared
    @State private var showingAgentSettings = false
    @State private var settingsActionInFlight: String?
    @State private var deletingPolicy: WorkspacePolicy?

    var body: some View {
        List {
            Section {
                assistantIdentity
                .padding(.vertical, 6)
                Button("Edit assistant settings", systemImage: "pencil") {
                    showingAgentSettings = true
                }
                Text("Identity, notifications, proactive jobs, and approval rules.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section {
                notificationRow
                NavigationLink {
                    RemindersView()
                } label: {
                    HStack {
                        Label("Reminders", systemImage: "bell.and.waves.left.and.right")
                        Spacer(minLength: 12)
                        if let count = model.workspace?.settings.reminders.count, count > 0 {
                            Text("\(count)")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text("Notifications")
            } footer: {
                Text("Get an alert when background work finishes or needs a decision. Notification previews stay private.")
            }

            Section {
                Picker("Appearance", selection: $appearance) {
                    ForEach(AssistantAppearance.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Appearance")
            } footer: {
                Text("Dark keeps the conversation stage day and night. System follows this iPhone’s appearance setting.")
            }

            Section("Connection") {
                NavigationLink {
                    ConnectionView(isOnboarding: false)
                } label: {
                    Label("Assistant server", systemImage: "network")
                }
                NavigationLink {
                    MCPConnectionsView()
                } label: {
                    Label("MCP connections", systemImage: "point.3.connected.trianglepath.dotted")
                }
            }

            if let conversation = model.activeConversation ?? model.bootstrap?.conversation,
               !conversation.models.isEmpty {
                Section("Current chat") {
                    Picker(
                        "Model",
                        selection: Binding(
                            get: { conversation.conversation.modelOverride ?? "" },
                            set: { value in
                                settingsActionInFlight = "chat-model"
                                Task {
                                    _ = await model.changeConversationModel(value.isEmpty ? nil : value)
                                    settingsActionInFlight = nil
                                }
                            }
                        )
                    ) {
                        Text("Automatic").tag("")
                        ForEach(conversation.models) { option in
                            Text(option.label).tag(option.id)
                        }
                    }
                    .disabled(settingsActionInFlight != nil)
                }
            }

            Section {
                Toggle(isOn: $shareLocation) {
                    Label("Share iPhone location", systemImage: "location")
                }
                // Turning the intent on is what triggers the permission prompt
                // — never the app launch.
                .onChange(of: shareLocation) { _, on in
                    if on {
                        locations.requestAccess()
                        Task { await model.shareLocationIfEnabled(force: true) }
                    } else {
                        shareLocationBackground = false
                        locations.setBackgroundMonitoring(false)
                    }
                }
                if shareLocation && locations.accessDenied {
                    Button {
                        locations.openSystemSettings()
                    } label: {
                        Label("Location access is off — open Settings", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
                    }
                }
                Toggle(isOn: $shareLocationBackground) {
                    Label("Background arrival nudges", systemImage: "mappin.and.ellipse")
                }
                .disabled(!shareLocation)
                .onChange(of: shareLocationBackground) { _, on in
                    locations.setBackgroundMonitoring(on)
                }
                if shareLocationBackground && !locations.hasAlwaysAccess {
                    Text("iOS will ask for Always location access; until then, arrivals are noticed only while the app is open.")
                        .font(.caption)
                        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                }
            } header: {
                Text("Assistant context")
            } footer: {
                Text("Sent to your own server as a short-lived current-position ping (kept a few days, never stored as memory) with this iPhone’s time zone. It powers answers like “what can I eat around here?” — never shared with anyone else. Background nudges use coarse significant-change updates only, so a move can earn one considered tip (a lunch spot in a new area) — at most a few pings a day.")
            }

            // The lower-traffic work areas. The pull-up menu stays at eight
            // primary destinations; these open from here instead.
            Section("Workspace") {
                NavigationLink {
                    WorkspaceView(area: .capabilities)
                } label: {
                    Label("Capabilities", systemImage: "puzzlepiece.extension")
                }
                NavigationLink {
                    WorkspaceView(area: .documents)
                } label: {
                    Label("Documents", systemImage: "doc.text")
                }
                NavigationLink {
                    WorkspaceView(area: .skills)
                } label: {
                    Label("Skills", systemImage: "lightbulb")
                }
                NavigationLink {
                    WorkspaceView(area: .costs)
                } label: {
                    Label("Costs", systemImage: "dollarsign.circle")
                }
                NavigationLink {
                    WorkspaceView(area: .anomalies)
                } label: {
                    Label("Anomalies", systemImage: "exclamationmark.triangle")
                }
                NavigationLink {
                    WorkspaceView(area: .improvements)
                } label: {
                    Label("Improvements", systemImage: "arrow.triangle.2.circlepath")
                }
            }

            if let settings = model.workspace?.settings {
                Section("Recurring jobs") {
                    if settings.schedules.isEmpty {
                        Label("No recurring jobs", systemImage: "clock")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(settings.schedules) { schedule in
                            scheduleRow(schedule)
                        }
                    }
                    if settings.goalAutomationCount > 0 {
                        Label(
                            "\(settings.goalAutomationCount) goal \(settings.goalAutomationCount == 1 ? "automation" : "automations") managed from Goals",
                            systemImage: "scope"
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }

                Section("Standing approvals") {
                    if settings.policies.isEmpty {
                        Label("No standing rules", systemImage: "checkmark.shield")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(settings.policies) { policy in
                            policyRow(policy)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle("More")
        .assistantSubmenuChrome()
        .refreshable {
            async let overviewRefresh: Void = model.refreshAll()
            async let workspaceRefresh: Void = model.refreshWorkspace()
            _ = await (overviewRefresh, workspaceRefresh)
        }
        .task {
            await notifications.refreshAuthorizationStatus()
            if model.workspace == nil { await model.refreshWorkspace() }
            await model.refreshMcpConnections()
        }
        .sheet(isPresented: $showingAgentSettings) {
            if let settings = model.workspace?.settings.agent {
                NavigationStack { AgentSettingsEditor(settings: settings) }
            }
        }
        .confirmationDialog(
            "Delete this standing approval?",
            isPresented: Binding(
                get: { deletingPolicy != nil },
                set: { if !$0 { deletingPolicy = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let policy = deletingPolicy {
                Button("Delete rule", role: .destructive) {
                    settingsActionInFlight = policy.id
                    Task {
                        _ = await model.deletePolicy(policy)
                        settingsActionInFlight = nil
                    }
                    deletingPolicy = nil
                }
            }
            Button("Cancel", role: .cancel) { deletingPolicy = nil }
        }
    }

    @ViewBuilder
    private var notificationRow: some View {
        switch notifications.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            Button {
                notifications.openSystemSettings()
            } label: {
                notificationStatusLabel(title: "Notifications", value: "On", icon: "bell.badge.fill")
            }
        case .denied:
            Button {
                notifications.openSystemSettings()
            } label: {
                notificationStatusLabel(title: "Notifications", value: "Off", icon: "bell.slash")
            }
        case .notDetermined:
            VStack(alignment: .leading, spacing: 7) {
                Button {
                    Task { await notifications.requestAuthorization() }
                } label: {
                    if notifications.isRequestingAuthorization {
                        Label("Turning on notifications", systemImage: "bell.badge")
                    } else {
                        Label("Turn on notifications", systemImage: "bell.badge")
                    }
                }
                .disabled(notifications.isRequestingAuthorization)

                if let error = notifications.authorizationError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        @unknown default:
            EmptyView()
        }
    }

    private func notificationStatusLabel(title: String, value: String, icon: String) -> some View {
        HStack {
            Label(title, systemImage: icon)
            Spacer(minLength: 12)
            Text(value)
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(value)")
        .accessibilityHint("Opens notification settings")
    }

    @ViewBuilder
    private var assistantIdentity: some View {
        HStack(spacing: 12) {
            AssistantGlyph(systemName: "slider.horizontal.3", tint: AssistantTheme.accent(for: colorScheme))
            VStack(alignment: .leading, spacing: 4) {
                Text(model.agentName)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                Text(model.serverURL)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(usesAccessibilityLayout ? 2 : 1)
            }
            Spacer(minLength: 0)
        }
    }

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    // Labels arrive with the payload from the server's own dictionaries, so
    // the phone and the web dashboard describe the same job the same way.
    @ViewBuilder
    private func scheduleRow(_ schedule: WorkspaceSchedule) -> some View {
        let detail = VStack(alignment: .leading, spacing: 3) {
            Text(schedule.displayName)
            Text(
                schedule.enabled
                    ? schedule.nextRunAt.map { "Next \(relative($0))" } ?? "Preparing next run"
                    : "Paused"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Toggle(
            isOn: Binding(
                get: { schedule.enabled },
                set: { enabled in
                    settingsActionInFlight = schedule.id
                    Task {
                        _ = await model.setSchedule(schedule, enabled: enabled)
                        settingsActionInFlight = nil
                    }
                }
            )
        ) { detail }
        .disabled(settingsActionInFlight != nil)
    }

    @ViewBuilder
    private func policyRow(_ policy: WorkspacePolicy) -> some View {
        let detail = VStack(alignment: .leading, spacing: 3) {
            Text(policy.displayName)
            Text(policy.toolName.sentenceCaseIdentifier)
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        HStack {
            Toggle(
                isOn: Binding(
                    get: { policy.enabled },
                    set: { enabled in
                        settingsActionInFlight = policy.id
                        Task {
                            _ = await model.setPolicy(policy, enabled: enabled)
                            settingsActionInFlight = nil
                        }
                    }
                )
            ) { detail }
            .disabled(settingsActionInFlight != nil)
            Button("Delete", systemImage: "trash", role: .destructive) {
                deletingPolicy = policy
            }
            .labelStyle(.iconOnly)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .disabled(settingsActionInFlight != nil)
        }
    }

}

private struct RemindersView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var reminderToRemove: WorkspaceReminder?
    @State private var removalInFlight: String?

    private var reminders: [WorkspaceReminder] {
        model.workspace?.settings.reminders ?? []
    }

    var body: some View {
        List {
            if reminders.isEmpty {
                AssistantEmptyState(
                    "No active reminders",
                    systemImage: "bell.slash",
                    description: "Ask in chat to be reminded once, daily, or on selected days."
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else {
                Section {
                    ForEach(reminders) { reminder in
                        reminderRow(reminder)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button("Remove", systemImage: "trash", role: .destructive) {
                                    reminderToRemove = reminder
                                }
                            }
                    }
                } footer: {
                    Text("Removing a reminder stops queued and future alerts. Earlier chat messages stay in the conversation.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle("Reminders")
        .assistantSubmenuChrome()
        .refreshable { await model.refreshWorkspace() }
        .task {
            if model.workspace == nil { await model.refreshWorkspace() }
        }
        .confirmationDialog(
            "Remove this reminder?",
            isPresented: Binding(
                get: { reminderToRemove != nil },
                set: { if !$0 { reminderToRemove = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let reminder = reminderToRemove {
                Button("Remove reminder", role: .destructive) {
                    removalInFlight = reminder.id
                    Task {
                        _ = await model.deleteReminder(reminder)
                        removalInFlight = nil
                    }
                    reminderToRemove = nil
                }
                Button("Cancel", role: .cancel) { reminderToRemove = nil }
            }
        } message: {
            if let reminder = reminderToRemove {
                Text(reminder.text)
            }
        }
    }

    private func reminderRow(_ reminder: WorkspaceReminder) -> some View {
        HStack(alignment: .top, spacing: 12) {
            AssistantGlyph(
                systemName: reminder.repeats ? "repeat" : "bell",
                tint: AssistantTheme.accent(for: colorScheme)
            )
            VStack(alignment: .leading, spacing: 5) {
                Text(reminder.text)
                    .font(.body.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                Text(reminderDetail(reminder))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button("Remove", systemImage: "trash", role: .destructive) {
                reminderToRemove = reminder
            }
            .labelStyle(.iconOnly)
            .frame(minWidth: 44, minHeight: 44)
            .disabled(removalInFlight != nil)
        }
        .padding(.vertical, 4)
    }

    private func reminderDetail(_ reminder: WorkspaceReminder) -> String {
        if reminder.isDelivering { return "Delivering now · \(reminder.repeats ? "Repeats" : "Once")" }
        let cadence = reminder.repeats ? "Repeats" : "Once"
        guard let nextRunAt = reminder.nextRunAt else { return cadence }
        return "\(cadence) · Next \(relative(nextRunAt))"
    }
}

private struct AgentSettingsEditor: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var timezone: String
    @State private var locale: String
    @State private var signature: String
    @State private var isSaving = false

    init(settings: WorkspaceAgentSettings) {
        _timezone = State(initialValue: settings.timezone)
        _locale = State(initialValue: settings.locale)
        _signature = State(initialValue: settings.signature)
    }

    var body: some View {
        Form {
            Section("Language and time") {
                TextField("Timezone", text: $timezone)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("Locale", text: $locale)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Section("Signature") {
                TextField("Email signature", text: $signature, axis: .vertical)
                    .lineLimit(2...6)
            }
        }
        .navigationTitle("Assistant settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(isSaving || timezone.isEmpty || locale.isEmpty)
            }
        }
    }

    private func save() {
        isSaving = true
        Task {
            let saved = await model.updateAgentSettings(
                .init(timezone: timezone, locale: locale, signature: signature)
            )
            isSaving = false
            if saved { dismiss() }
        }
    }
}

/// Owner-managed remote tool servers. Connection discovery is intentionally
/// separate from tool use: a server can describe its tools here, but every
/// later invocation still becomes a normal approval-backed agent action.
private struct MCPConnectionsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var name = ""
    @State private var endpoint = ""
    @State private var bearerToken = ""
    @State private var isAdding = false
    @State private var workingConnectionID: String?
    @State private var pendingDeletionID: String?
    @FocusState private var focusedField: MCPField?

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                introduction
                addConnection

                if model.mcpConnections.isEmpty {
                    AssistantEmptyState(
                        "No MCP connections",
                        systemImage: "point.3.connected.trianglepath.dotted",
                        description: "Add a remote server to let the agent discover its tools."
                    )
                } else {
                    ForEach(model.mcpConnections) { connection in
                        connectionCard(connection)
                    }
                }
            }
            .padding(16)
            .padding(.bottom, 28)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
        .navigationTitle("MCP connections")
        .navigationBarTitleDisplayMode(usesAccessibilityLayout ? .inline : .large)
        .refreshable { await model.refreshMcpConnections() }
        .task { await model.refreshMcpConnections() }
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Tools, with a visible boundary", systemImage: "checkmark.shield")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
            Text("Connect a Streamable HTTP MCP server. The agent can inspect its tools, but it asks before every remote call.")
                .font(.subheadline)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 4)
    }

    private var addConnection: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text("Add a connection")
                .font(.headline)

            mcpField("Name", placeholder: "e.g. Home Assistant", text: $name, field: .name)
            mcpField("MCP endpoint", placeholder: "https://example.com/mcp", text: $endpoint, field: .endpoint)
            SecureField("Bearer token (optional)", text: $bearerToken)
                .textContentType(.password)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focusedField, equals: .bearer)
                .onSubmit(add)
                .padding(.horizontal, 12)
                .frame(minHeight: 46)
                .background(AssistantTheme.sunken(for: colorScheme), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            Button(action: add) {
                HStack(spacing: 8) {
                    if isAdding { ProgressView().controlSize(.small) }
                    Text(isAdding ? "Checking connection…" : "Add and inspect")
                    Spacer()
                    Image(systemName: "arrow.right")
                        .font(.caption.weight(.bold))
                }
                .frame(minHeight: 40)
            }
            .buttonStyle(.borderedProminent)
            .tint(AssistantTheme.accent(for: colorScheme))
            .disabled(isAdding || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .buttonStyle(AssistantTactileButtonStyle(reduceMotion: reduceMotion, pressedScale: 0.99))

            Text("Only public HTTPS endpoints are accepted in production. Bearer tokens are encrypted on the server and never shown again.")
                .font(.caption)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
        }
        .assistantCard(in: colorScheme)
    }

    private func mcpField(
        _ label: String,
        placeholder: String,
        text: Binding<String>,
        field: MCPField
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            TextField(placeholder, text: text)
                .textContentType(field == .endpoint ? .URL : .organizationName)
                .keyboardType(field == .endpoint ? .URL : .default)
                .textInputAutocapitalization(field == .endpoint ? .never : .words)
                .autocorrectionDisabled(field == .endpoint)
                .submitLabel(.next)
                .focused($focusedField, equals: field)
                .onSubmit {
                    if field == .name { focusedField = .endpoint }
                    else { focusedField = .bearer }
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 46)
                .background(AssistantTheme.sunken(for: colorScheme), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private func connectionCard(_ connection: McpConnection) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                AssistantGlyph(systemName: connection.statusIcon, tint: statusColor(connection))
                VStack(alignment: .leading, spacing: 4) {
                    Text(connection.name)
                        .font(.headline)
                    Text(connection.serverName.map { version in
                        connection.serverVersion.map { "\(version) · \($0)" } ?? version
                    } ?? connection.endpoint)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .lineLimit(usesAccessibilityLayout ? nil : 1)
                }
                Spacer(minLength: 6)
                statusTag(connection)
            }

            if connection.status == "ready" {
                HStack(spacing: 10) {
                    Label("\(connection.tools.count) \(connection.tools.count == 1 ? "tool" : "tools")", systemImage: "wrench.and.screwdriver")
                    if let checked = connection.lastCheckedAt { Text("Checked \(relative(checked))") }
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))

                if !connection.tools.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(connection.tools.prefix(5)) { tool in
                            Text(tool.name)
                                .font(.caption2.monospaced().weight(.medium))
                                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 5)
                                .background(AssistantTheme.accent(for: colorScheme).opacity(0.1), in: Capsule())
                        }
                        if connection.tools.count > 5 {
                            Text("+\(connection.tools.count - 5)")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 5)
                                .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
                        }
                    }
                }
            } else if let error = connection.lastError, !error.isEmpty {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }

            connectionActions(connection)
        }
        .assistantCard(in: colorScheme)
    }

    @ViewBuilder
    private func connectionActions(_ connection: McpConnection) -> some View {
        let isWorking = workingConnectionID == connection.id
        if usesAccessibilityLayout {
            VStack(spacing: 9) {
                actionButton("Refresh", icon: "arrow.clockwise", connection: connection, action: "refresh", prominent: true, working: isWorking)
                actionButton(connection.enabled ? "Pause" : "Enable", icon: connection.enabled ? "pause.fill" : "play.fill", connection: connection, action: connection.enabled ? "disable" : "enable", prominent: false, working: isWorking)
                deleteButton(connection, working: isWorking)
            }
        } else {
            HStack(spacing: 9) {
                actionButton("Refresh", icon: "arrow.clockwise", connection: connection, action: "refresh", prominent: true, working: isWorking)
                actionButton(connection.enabled ? "Pause" : "Enable", icon: connection.enabled ? "pause.fill" : "play.fill", connection: connection, action: connection.enabled ? "disable" : "enable", prominent: false, working: isWorking)
                deleteButton(connection, working: isWorking)
            }
        }
    }

    @ViewBuilder
    private func actionButton(
        _ title: String,
        icon: String,
        connection: McpConnection,
        action: String,
        prominent: Bool,
        working: Bool
    ) -> some View {
        if prominent {
            Button { perform(connection, action: action) } label: {
                actionButtonLabel(title, icon: icon, working: working)
            }
            .buttonStyle(.borderedProminent)
            .tint(AssistantTheme.accent(for: colorScheme))
            .disabled(workingConnectionID != nil)
        } else {
            Button { perform(connection, action: action) } label: {
                actionButtonLabel(title, icon: icon, working: working)
            }
            .buttonStyle(.bordered)
            .tint(AssistantTheme.inkMuted(for: colorScheme))
            .disabled(workingConnectionID != nil)
        }
    }

    private func actionButtonLabel(_ title: String, icon: String, working: Bool) -> some View {
        HStack(spacing: 6) {
            if working { ProgressView().controlSize(.small) }
            else { Image(systemName: icon) }
            Text(working ? "Working…" : title)
        }
        .frame(maxWidth: .infinity, minHeight: 36)
    }

    private func deleteButton(_ connection: McpConnection, working: Bool) -> some View {
        Button(role: .destructive) {
            pendingDeletionID = connection.id
        } label: {
            Image(systemName: "trash")
                .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .disabled(workingConnectionID != nil || working)
        .accessibilityLabel("Remove \(connection.name)")
        .confirmationDialog(
            "Remove \(connection.name)?",
            isPresented: Binding(
                get: { pendingDeletionID == connection.id },
                set: { if !$0 { pendingDeletionID = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove connection", role: .destructive) {
                workingConnectionID = connection.id
                pendingDeletionID = nil
                Task {
                    _ = await model.deleteMcpConnection(id: connection.id)
                    workingConnectionID = nil
                }
            }
            Button("Cancel", role: .cancel) { pendingDeletionID = nil }
        } message: {
            Text("The endpoint, discovered tools, and saved bearer credential will be deleted.")
        }
    }

    private func statusTag(_ connection: McpConnection) -> some View {
        Text(connection.statusLabel)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(statusColor(connection))
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(statusColor(connection).opacity(0.11), in: Capsule())
    }

    private func statusColor(_ connection: McpConnection) -> Color {
        switch connection.status {
        case "ready": AssistantTheme.success(for: colorScheme)
        case "checking": AssistantTheme.accent(for: colorScheme)
        case "disabled": AssistantTheme.inkMuted(for: colorScheme)
        case "error": AssistantTheme.errorInk(for: colorScheme)
        default: AssistantTheme.warning(for: colorScheme)
        }
    }

    private func add() {
        let candidateName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidateEndpoint = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isAdding, !candidateName.isEmpty, !candidateEndpoint.isEmpty else { return }
        focusedField = nil
        isAdding = true
        Task {
            if await model.createMcpConnection(name: candidateName, endpoint: candidateEndpoint, bearerToken: bearerToken.isEmpty ? nil : bearerToken) {
                name = ""
                endpoint = ""
                bearerToken = ""
            }
            isAdding = false
        }
    }

    private func perform(_ connection: McpConnection, action: String) {
        workingConnectionID = connection.id
        Task {
            _ = await model.updateMcpConnection(id: connection.id, action: action)
            workingConnectionID = nil
        }
    }
}

private enum MCPField: Hashable {
    case name
    case endpoint
    case bearer
}

/// A wrapping row for compact tool names. Unlike a horizontal scroller, all
/// discovered capabilities remain visible at once and retain their reading
/// order when Dynamic Type grows.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let width = proposal.width ?? .greatestFiniteMagnitude
        var cursorX: CGFloat = 0
        var cursorY: CGFloat = 0
        var lineHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            let nextX = cursorX > 0 ? cursorX + spacing + size.width : size.width
            if cursorX > 0, nextX > width {
                cursorX = 0
                cursorY += lineHeight + spacing
                lineHeight = 0
            }
            cursorX = cursorX > 0 ? cursorX + spacing + size.width : size.width
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: proposal.width ?? cursorX, height: cursorY + lineHeight)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var cursorX = bounds.minX
        var cursorY = bounds.minY
        var lineHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if cursorX > bounds.minX, cursorX + size.width > bounds.maxX {
                cursorX = bounds.minX
                cursorY += lineHeight + spacing
                lineHeight = 0
            }
            subview.place(at: CGPoint(x: cursorX, y: cursorY), proposal: .unspecified)
            cursorX += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}
