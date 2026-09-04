import SwiftUI

struct ApprovalsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var pendingDecision: (PendingApproval, String)?
    @State private var decisionInFlightID: String?
    @State private var decisionInFlightAction: String?
    @State private var decisionSuccessFeedback = 0
    @State private var decisionErrorFeedback = 0
    @State private var editingApproval: PendingApproval?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                approvalSummary
                if pending.isEmpty {
                    AssistantEmptyState(
                        "Nothing is waiting",
                        systemImage: "checkmark.shield",
                        description: "The assistant asks here before an action leaves its workspace."
                    )
                } else {
                    Text("Review the real-world effect first. Approving resumes the parked task immediately.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    ForEach(pending) { item in approvalCard(item) }
                }

                if !resolved.isEmpty {
                    DisclosureGroup("Recently resolved") {
                        VStack(spacing: 0) {
                            ForEach(resolved) { item in
                                resolvedRow(item)
                                .padding(.vertical, 11)
                                if item.id != resolved.last?.id { Divider() }
                            }
                        }
                        .padding(.top, 6)
                    }
                    .font(.subheadline.weight(.semibold))
                    .assistantPanel(in: colorScheme)
                }
            }
            .padding(16)
            .padding(.bottom, 28)
            .frame(maxWidth: isLandscape ? 760 : .infinity, alignment: .leading)
        }
        .navigationTitle("Approvals")
        .assistantSubmenuChrome()
        .refreshable { await model.refreshAll() }
        .task { if model.overview == nil { await model.refreshOverview() } }
        .confirmationDialog(
            confirmationTitle,
            isPresented: Binding(
                get: { pendingDecision != nil },
                set: { if !$0 { pendingDecision = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let (item, decision) = pendingDecision {
                Button(
                    decision == "approved" ? "Approve and continue" : "Deny action",
                    role: decision == "denied" ? .destructive : nil
                ) {
                    applyDecision(item, decision: decision)
                    pendingDecision = nil
                }
                Button("Cancel", role: .cancel) { pendingDecision = nil }
            }
        } message: {
            Text(pendingDecision?.0.approval.summary ?? "")
        }
        .sensoryFeedback(.success, trigger: decisionSuccessFeedback)
        .sensoryFeedback(.error, trigger: decisionErrorFeedback)
        .sheet(item: $editingApproval) { item in
            NavigationStack { ApprovalPayloadEditor(item: item) }
        }
    }

    private var pending: [PendingApproval] { model.overview?.approvals.pending ?? [] }
    private var resolved: [ResolvedApproval] { model.overview?.approvals.resolved ?? [] }
    private var confirmationTitle: String {
        pendingDecision?.1 == "approved" ? "Approve this action?" : "Deny this action?"
    }

    private var approvalSummary: some View {
        HStack(alignment: .top, spacing: 12) {
            AssistantGlyph(
                systemName: pending.isEmpty ? "checkmark.shield.fill" : "hand.raised.fill",
                tint: pending.isEmpty ? AssistantTheme.success(for: colorScheme) : AssistantTheme.warning(for: colorScheme)
            )
            VStack(alignment: .leading, spacing: 4) {
                Text(pending.isEmpty ? "All clear" : "Your attention is needed")
                    .font(.headline)
                Text(
                    pending.isEmpty
                        ? "No actions are waiting for a decision."
                        : "\(pending.count) \(pending.count == 1 ? "action is" : "actions are") parked until you decide."
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .assistantPanel(in: colorScheme)
    }

    private func approvalCard(_ item: PendingApproval) -> some View {
        Group {
            if isLandscape {
                HStack(alignment: .top, spacing: 20) {
                    approvalDetails(item)
                    Divider()
                        .overlay(AssistantTheme.warning(for: colorScheme).opacity(0.18))
                    VStack(alignment: .leading, spacing: 9) {
                        approvalActions(item)
                    }
                    .frame(width: 190)
                }
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    approvalDetails(item)
                    Group {
                        if usesAccessibilityLayout {
                            VStack(spacing: 9) { approvalActions(item) }
                        } else {
                            AssistantFlowLayout(spacing: 9) { approvalActions(item) }
                        }
                    }
                }
            }
        }
        .assistantCard(
            in: colorScheme,
            surface: AssistantTheme.warningSurface(for: colorScheme),
            strokeTint: AssistantTheme.warning(for: colorScheme)
        )
    }

    private func approvalDetails(_ item: PendingApproval) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            approvalHeader(item)
            Text(item.approval.summary)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Divider()
                .overlay(AssistantTheme.warning(for: colorScheme).opacity(0.18))
            approvalMetadata(item)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func approvalHeader(_ item: PendingApproval) -> some View {
        let tool = HStack(spacing: 10) {
            AssistantGlyph(systemName: "checkmark.shield.fill", tint: AssistantTheme.warning(for: colorScheme))
            VStack(alignment: .leading, spacing: 3) {
                Text("Approval needed")
                    .font(.caption.weight(.bold))
                    .textCase(.uppercase)
                    .tracking(0.65)
                    .foregroundStyle(AssistantTheme.warningInk(for: colorScheme))
                Text(item.toolName.sentenceCaseIdentifier)
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.warningInk(for: colorScheme).opacity(0.74))
            }
        }

        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 10) {
                tool
                approvalCode(item)
            }
        } else {
            HStack {
                tool
                Spacer()
                approvalCode(item)
            }
        }
    }

    private func approvalCode(_ item: PendingApproval) -> some View {
        // One fixed-height slot holding both states. The spinner used to be
        // 44pt tall against the badge's ~26, so confirming a decision grew the
        // card header by 18pt and snapped it back — on the most consequential
        // screen in the app.
        ZStack {
            if decisionInFlightID == item.id {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Applying decision")
            } else {
                Text(item.approval.shortCode)
                    .font(.caption.monospaced().weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 7)
                    .background(
                        AssistantTheme.warning(for: colorScheme).opacity(0.12),
                        in: Capsule()
                    )
            }
        }
        .frame(minHeight: 28)
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.18),
            value: decisionInFlightID
        )
    }

    @ViewBuilder
    private func approvalMetadata(_ item: PendingApproval) -> some View {
        let labels = [
            (item.taskType.sentenceCaseIdentifier, "square.stack.3d.up"),
            (item.taskTrust.sentenceCaseIdentifier, "person.crop.circle"),
        ]
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(labels, id: \.0) { label in
                    Label(label.0, systemImage: label.1)
                }
                Text("Requested \(relative(item.approval.requestedAt))")
            }
            .font(.caption)
            .foregroundStyle(AssistantTheme.warningInk(for: colorScheme).opacity(0.78))
        } else {
            VStack(alignment: .leading, spacing: 6) {
                AssistantFlowLayout(spacing: 6) {
                    ForEach(labels, id: \.0) { label in
                        Label(label.0, systemImage: label.1)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 7)
                            .background(AssistantTheme.warning(for: colorScheme).opacity(0.1), in: Capsule())
                    }
                }
                Text("Requested \(relative(item.approval.requestedAt))")
            }
            .font(.caption)
            .foregroundStyle(AssistantTheme.warningInk(for: colorScheme).opacity(0.78))
        }
    }

    @ViewBuilder
    private func approvalActions(_ item: PendingApproval) -> some View {
        approvalActionButton(
            "Deny",
            decision: "denied",
            item: item,
            role: .destructive,
            prominent: false
        )

        approvalActionButton(
            "Approve",
            decision: "approved",
            item: item,
            prominent: true
        )

        Menu {
            Button("Edit request", systemImage: "pencil") {
                editingApproval = item
            }
            if canRemember(item) {
                Button("Approve and remember recipient", systemImage: "checkmark.shield") {
                    decisionInFlightID = item.id
                    decisionInFlightAction = "remember"
                    Task {
                        let succeeded = await model.approveAndRemember(item)
                        decisionInFlightID = nil
                        decisionInFlightAction = nil
                        if succeeded { decisionSuccessFeedback += 1 }
                        else { decisionErrorFeedback += 1 }
                    }
                }
            }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
                .font(.subheadline.weight(.medium))
                .frame(minHeight: 32)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .disabled(decisionInFlightID != nil)
    }

    @ViewBuilder
    private func approvalActionButton(
        _ title: String,
        decision: String,
        item: PendingApproval,
        role: ButtonRole? = nil,
        prominent: Bool
    ) -> some View {
        let isApplyingThisDecision = decisionInFlightID == item.id
            && decisionInFlightAction == decision

        if prominent {
            Button {
                applyDecision(item, decision: decision)
            } label: {
                approvalActionLabel(title, isApplying: isApplyingThisDecision)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .tint(AssistantTheme.accent(for: colorScheme))
            .disabled(decisionInFlightID != nil)
            .accessibilityLabel(isApplyingThisDecision ? "Applying \(title.lowercased())" : title)
            .accessibilityHint("Resumes this task immediately")
            .accessibilityIdentifier("assistant.approvals.\(item.id).\(decision)")
        } else {
            Button(role: role) {
                pendingDecision = (item, decision)
            } label: {
                approvalActionLabel(title, isApplying: isApplyingThisDecision)
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .tint(.red)
            .disabled(decisionInFlightID != nil)
            .accessibilityLabel(isApplyingThisDecision ? "Applying \(title.lowercased())" : title)
            .accessibilityHint("Stops this action")
            .accessibilityIdentifier("assistant.approvals.\(item.id).\(decision)")
        }
    }

    private func approvalActionLabel(_ title: String, isApplying: Bool) -> some View {
        HStack(spacing: 7) {
            if isApplying {
                ProgressView()
                    .controlSize(.small)
            }
            Text(isApplying ? "Applying…" : title)
        }
        .font(.subheadline.weight(.semibold))
        .frame(minHeight: 32)
        .contentTransition(.opacity)
    }

    private func applyDecision(_ item: PendingApproval, decision: String) {
        guard decisionInFlightID == nil else { return }
        decisionInFlightID = item.id
        decisionInFlightAction = decision
        Task {
            let succeeded = await model.decide(item, decision: decision)
            decisionInFlightID = nil
            decisionInFlightAction = nil
            if succeeded {
                decisionSuccessFeedback += 1
            } else {
                decisionErrorFeedback += 1
            }
        }
    }

    @ViewBuilder
    private func resolvedRow(_ item: ResolvedApproval) -> some View {
        let detail = VStack(alignment: .leading, spacing: 4) {
            Text(item.approval.summary)
                .font(.subheadline)
                .lineLimit(usesAccessibilityLayout ? nil : 2)
            Text("\(item.approval.shortCode) · \(relative(item.approval.resolvedAt ?? item.approval.expiresAt))\(item.approval.edited == true ? " · edited" : "")")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
        }

        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 9) {
                detail
                StatusPill(status: item.approval.status)
            }
        } else {
            HStack(alignment: .top) {
                detail
                Spacer()
                StatusPill(status: item.approval.status)
            }
        }
    }

    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }
    private var isLandscape: Bool { verticalSizeClass == .compact }

    private func canRemember(_ item: PendingApproval) -> Bool {
        guard item.toolName == "gmail.send",
              case let .object(payload) = item.approval.payload,
              case let .array(recipients)? = payload["to"] else { return false }
        return recipients.compactMap(\.string).filter { !$0.isEmpty }.count == 1
    }
}

private struct ApprovalPayloadEditor: View {
    let item: PendingApproval

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var payload: String
    @State private var error: String?
    @State private var isSaving = false

    init(item: PendingApproval) {
        self.item = item
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = (try? encoder.encode(item.approval.payload)) ?? Data("{}".utf8)
        _payload = State(initialValue: String(decoding: data, as: UTF8.self))
    }

    var body: some View {
        Form {
            Section {
                TextEditor(text: $payload)
                    .font(.system(.caption, design: .monospaced))
                    .frame(minHeight: 260)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Exact request")
            } footer: {
                Text("The assistant uses this JSON payload after approval.")
            }
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Edit request")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Approving…" : "Approve") { approve() }
                    .disabled(isSaving)
            }
        }
    }

    private func approve() {
        guard let data = payload.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object = decoded else {
            error = "Payload must be a valid JSON object."
            return
        }
        error = nil
        isSaving = true
        Task {
            let succeeded = await model.editAndApprove(item, payload: decoded)
            isSaving = false
            if succeeded { dismiss() }
        }
    }
}
