import SwiftUI

struct ApprovalsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pendingDecision: (PendingApproval, String)?
    @State private var decisionInFlightID: String?
    @State private var decisionInFlightAction: String?
    @State private var decisionSuccessFeedback = 0
    @State private var decisionErrorFeedback = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                // The chat-level error banner lives on the navigation root and
                // cannot draw above this pushed page, so a failed approve/deny
                // was only an error haptic here. Surface it in place.
                if let error = model.errorMessage {
                    HStack(spacing: 10) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .accessibilityHidden(true)
                        Text(error)
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 4)
                        Button {
                            model.dismissError()
                        } label: {
                            Image(systemName: "xmark")
                                .font(.caption.weight(.bold))
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Dismiss error")
                    }
                    .foregroundStyle(AssistantTheme.errorInk(for: colorScheme))
                    .padding(.leading, 14)
                    .padding(.trailing, 4)
                    .padding(.vertical, 4)
                    .background(
                        AssistantTheme.errorSurface(for: colorScheme),
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                    )
                }

                if pending.isEmpty {
                    ContentUnavailableView(
                        "Nothing is waiting",
                        systemImage: "checkmark.shield",
                        description: Text("The assistant asks here before an action leaves its workspace.")
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, 72)
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
                    .font(.headline)
                    .padding(16)
                    .background(AssistantTheme.sunken(for: colorScheme).opacity(0.65), in: RoundedRectangle(cornerRadius: 18))
                }
            }
            .padding(16)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
        .navigationTitle("Approvals")
        .navigationBarTitleDisplayMode(usesAccessibilityLayout ? .inline : .large)
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
                    pendingDecision = nil
                }
                Button("Cancel", role: .cancel) { pendingDecision = nil }
            }
        } message: {
            Text(pendingDecision?.0.approval.summary ?? "")
        }
        .sensoryFeedback(.success, trigger: decisionSuccessFeedback)
        .sensoryFeedback(.error, trigger: decisionErrorFeedback)
    }

    private var pending: [PendingApproval] { model.overview?.approvals.pending ?? [] }
    private var resolved: [ResolvedApproval] { model.overview?.approvals.resolved ?? [] }
    private var confirmationTitle: String {
        pendingDecision?.1 == "approved" ? "Approve this action?" : "Deny this action?"
    }

    private func approvalCard(_ item: PendingApproval) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            approvalHeader(item)
            Text(item.approval.summary)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            approvalMetadata(item)

            Group {
                if usesAccessibilityLayout {
                    VStack(spacing: 10) { approvalActions(item) }
                } else {
                    HStack(spacing: 10) { approvalActions(item) }
                }
            }
        }
        .assistantCard(in: colorScheme)
    }

    @ViewBuilder
    private func approvalHeader(_ item: PendingApproval) -> some View {
        let tool = Label(
            item.toolName.sentenceCaseIdentifier,
            systemImage: "shield.lefthalf.filled"
        )
        .font(.caption.weight(.semibold))
        .foregroundStyle(AssistantTheme.warning(for: colorScheme))

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
                    .padding(.vertical, 5)
                    .background(
                        AssistantTheme.sunken(for: colorScheme),
                        in: RoundedRectangle(cornerRadius: 7, style: .continuous)
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
        if usesAccessibilityLayout {
            VStack(alignment: .leading, spacing: 6) {
                Text(item.taskType.sentenceCaseIdentifier)
                Text("Requested \(relative(item.approval.requestedAt))")
                Text(item.taskTrust.sentenceCaseIdentifier)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        } else {
            // Two short lines rather than one dot-joined row: three segments
            // plus separators wrapped awkwardly on narrow phones, leaving the
            // trust level stranded mid-line.
            VStack(alignment: .leading, spacing: 3) {
                Text("\(item.taskType.sentenceCaseIdentifier) · \(item.taskTrust.sentenceCaseIdentifier)")
                Text("Requested \(relative(item.approval.requestedAt))")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func approvalActions(_ item: PendingApproval) -> some View {
        approvalActionButton(
            "Deny action",
            decision: "denied",
            item: item,
            role: .destructive,
            prominent: false
        )

        approvalActionButton(
            "Approve and continue",
            decision: "approved",
            item: item,
            prominent: true
        )
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
                pendingDecision = (item, decision)
            } label: {
                approvalActionLabel(title, isApplying: isApplyingThisDecision)
            }
            .buttonStyle(.borderedProminent)
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
        .frame(maxWidth: .infinity)
        .contentTransition(.opacity)
    }

    @ViewBuilder
    private func resolvedRow(_ item: ResolvedApproval) -> some View {
        let detail = VStack(alignment: .leading, spacing: 4) {
            Text(item.approval.summary)
                .font(.subheadline)
                .lineLimit(usesAccessibilityLayout ? nil : 2)
            Text("\(item.approval.shortCode) · \(relative(item.approval.resolvedAt ?? item.approval.expiresAt))")
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
}
