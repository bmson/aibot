import SwiftUI

struct MoreView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject private var notifications = NotificationManager.shared
    @AppStorage(AssistantAppearance.defaultsKey) private var appearance = AssistantAppearance.dark
    @AppStorage(AppModel.shareLocationKey) private var shareLocation = false
    @ObservedObject private var locations = LocationManager.shared

    var body: some View {
        List {
            Section {
                assistantIdentity
                .padding(.vertical, 6)
                Text("Identity, notifications, proactive jobs, and approval rules.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section {
                notificationRow
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
                    }
                }
                if shareLocation && locations.accessDenied {
                    Button {
                        notifications.openSystemSettings()
                    } label: {
                        Label("Location access is off — open Settings", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
                    }
                }
            } header: {
                Text("Assistant context")
            } footer: {
                Text("Sent to your own server as a short-lived current-position ping (kept a few days, never stored as memory) with this iPhone’s time zone. It powers answers like “what can I eat around here?” — never shared with anyone else.")
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
        .scrollContentBackground(.hidden)
        .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
        .navigationTitle("More")
        .navigationBarTitleDisplayMode(usesAccessibilityLayout ? .inline : .large)
        .refreshable {
            async let overviewRefresh: Void = model.refreshAll()
            async let workspaceRefresh: Void = model.refreshWorkspace()
            _ = await (overviewRefresh, workspaceRefresh)
        }
        .task {
            await notifications.refreshAuthorizationStatus()
            if model.workspace == nil { await model.refreshWorkspace() }
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
        let details = VStack(alignment: .leading, spacing: 3) {
            Text(model.agentName)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
            Text(model.serverURL)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(usesAccessibilityLayout ? 2 : 1)
        }

        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 12) {
                CompanionCapsule(
                    presence: model.presence,
                    face: model.latestFace,
                    name: model.agentName
                )
                details
            }
        } else {
            HStack(spacing: 14) {
                CompanionCapsule(
                    presence: model.presence,
                    face: model.latestFace,
                    name: model.agentName
                )
                details
            }
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

        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 8) {
                detail
                settingsTag(
                    schedule.enabled ? "On" : "Paused",
                    tint: schedule.enabled
                        ? AssistantTheme.success(for: colorScheme)
                        : AssistantTheme.warning(for: colorScheme)
                )
            }
        } else {
            HStack {
                detail
                Spacer()
                settingsTag(
                    schedule.enabled ? "On" : "Paused",
                    tint: schedule.enabled
                        ? AssistantTheme.success(for: colorScheme)
                        : AssistantTheme.warning(for: colorScheme)
                )
            }
        }
    }

    @ViewBuilder
    private func policyRow(_ policy: WorkspacePolicy) -> some View {
        let detail = VStack(alignment: .leading, spacing: 3) {
            Text(policy.displayName)
            Text(policy.toolName.sentenceCaseIdentifier)
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 8) {
                detail
                settingsTag(
                    policy.enabled ? (policy.effect == "allow" ? "Allowed" : "Blocked") : "Paused",
                    tint: policy.enabled
                        ? (policy.effect == "allow" ? AssistantTheme.success(for: colorScheme) : .red)
                        : AssistantTheme.warning(for: colorScheme)
                )
            }
        } else {
            HStack {
                detail
                Spacer()
                settingsTag(
                    policy.enabled ? (policy.effect == "allow" ? "Allowed" : "Blocked") : "Paused",
                    tint: policy.enabled
                        ? (policy.effect == "allow" ? AssistantTheme.success(for: colorScheme) : .red)
                        : AssistantTheme.warning(for: colorScheme)
                )
            }
        }
    }

    private func settingsTag(_ title: String, tint: Color) -> some View {
        Text(title)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(tint.opacity(0.11), in: Capsule())
    }
}
