import SwiftUI

/// Uses the same source-backed groups as the dossier. Directory categories
/// are never edges, and matching names never manufacture a navigation ID.
struct PeopleConnectionBranch: Identifiable {
  let group: PersonRelationGroup
  var id: String { group.id }
  var contactID: String? { group.representative.otherContactId }
  var needsReview: Bool { group.relations.contains(where: \.unreviewed) }
  var label: String {
    group.roles.isEmpty ? "Recorded connection" : group.roles.joined(separator: " · ")
  }
  var detail: String? {
    if group.roles.isEmpty { return group.representative.sentence }
    let spans = Set(group.relationshipEvidence.map(\.span).filter { !$0.isEmpty }).sorted()
    return spans.isEmpty ? nil : spans.joined(separator: " · ")
  }

  static func branches(for card: PersonCard) -> [Self] {
    PersonRelationGroup.group(
      card.relations.filter { $0.otherContactId != card.id }, personName: card.name
    )
    .map { Self(group: $0) }
    .sorted {
      let order = $0.group.representative.otherLabel.localizedStandardCompare(
        $1.group.representative.otherLabel)
      return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
    }
  }

  static func exploring(_ id: String, from trail: [String]) -> [String] {
    if let index = trail.firstIndex(of: id) { return Array(trail.prefix(index + 1)) }
    return trail + [id]
  }
}

struct PeopleConnectionsExplorer: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  let people: [PersonSummary]
  @Binding var query: String
  var focusChanged: (String?) -> Void = { _ in }
  @State private var trail: [String] = []
  @State private var failed = false
  @State private var inspecting: PeopleConnectionBranch?

  private var focusID: String? { trail.last }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if let id = focusID, query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        HStack {
          Button {
            if trail.count > 1 { trail.removeLast() } else { trail = [] }
          } label: {
            Label(trail.count > 1 ? "Previous person" : "Choose someone", systemImage: "arrow.left")
          }
          Spacer()
          if trail.count > 1 {
            Button("Start over") { trail = [] }
          }
        }
        .font(.subheadline)
        .frame(minHeight: 44)
        if let card = model.personCards[id] {
          PeopleConnectionMap(
            card: card,
            open: { next in
              trail = PeopleConnectionBranch.exploring(next, from: trail)
            }, inspect: { inspecting = $0 }, pageChanged: { focusChanged(focusID) })
          NavigationLink(value: AssistantDestination.person(id: id)) {
            Label("Open full profile", systemImage: "person.text.rectangle")
              .frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.bordered)
        } else if failed {
          Text("Couldn’t load these connections.").font(.headline)
          Button("Try again") { Task { await load(id) } }
            .buttonStyle(.bordered)
        } else {
          ProgressView("Loading connections…")
            .frame(maxWidth: .infinity, minHeight: 180)
        }
      } else {
        VStack(alignment: .leading, spacing: 6) {
          Text("Explore your people").font(.title3.weight(.semibold))
          Text(
            "Choose someone to see who they’re connected to and how. Follow a person to explore further."
          )
          .font(.subheadline).foregroundStyle(.secondary)
        }
        if people.isEmpty {
          Text("No matching people. Try another name.").font(.subheadline)
        }
        LazyVGrid(
          columns: [
            GridItem(
              .adaptive(minimum: dynamicTypeSize.isAccessibilitySize ? 280 : 145), spacing: 12,
              alignment: .top)
          ], spacing: 12
        ) {
          ForEach(people) { person in
            Button {
              query = ""
              trail = [person.id]
            } label: {
              VStack(alignment: .leading, spacing: 10) {
                PersonInitialsBadge(initials: person.initials, size: 42)
                Text(person.name).font(.subheadline.weight(.semibold))
                  .fixedSize(horizontal: false, vertical: true)
                Text("Explore connections")
                  .font(.caption).foregroundStyle(AssistantTheme.accent(for: colorScheme))
              }
              .frame(maxWidth: .infinity, alignment: .leading)
              .assistantCard(in: colorScheme)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("assistant.people.choose.\(person.id)")
          }
        }
      }
    }
    .task(id: focusID) {
      if let id = focusID, model.personCards[id] == nil { await load(id) }
    }
    .onChange(of: focusID) { _, _ in
      failed = false
      focusChanged(focusID)
    }
    .sheet(item: $inspecting) { branch in
      NavigationStack {
        List(branch.group.relations) { evidence in
          NavigationLink {
            PersonRelationshipEvidenceScreen(evidence: evidence) {
              if let id = focusID { await model.refreshPersonEvidence(id: id) }
              inspecting = nil
            }
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              Text(evidence.sentence).font(.subheadline)
              if !evidence.span.isEmpty {
                Text(evidence.span).font(.caption).foregroundStyle(.secondary)
              }
              if evidence.unreviewed {
                Label("Not yet confirmed", systemImage: "questionmark.circle")
                  .font(.caption).foregroundStyle(AssistantTheme.warning(for: colorScheme))
              }
            }.padding(.vertical, 6)
          }
          .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .scrollContentBackground(.hidden)
        .background(AssistantTheme.canvas(for: colorScheme))
        .navigationTitle("Relationship evidence")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .confirmationAction) { Button("Done") { inspecting = nil } }
        }
      }
    }
  }

  private func load(_ id: String) async {
    failed = false
    await model.loadPersonCard(id: id)
    guard !Task.isCancelled, focusID == id else { return }
    failed = model.personCards[id] == nil
  }
}

/// A phone-sized branching diagram, not a force layout. Anchor preferences
/// keep wires attached as names wrap or Dynamic Type changes node heights.
struct PeopleConnectionMap: View {
  let card: PersonCard
  let open: (String) -> Void
  let inspect: (PeopleConnectionBranch) -> Void
  var pageChanged: () -> Void = {}
  @Environment(\.colorScheme) private var colorScheme
  @State private var page = 0
  private var branches: [PeopleConnectionBranch] { PeopleConnectionBranch.branches(for: card) }
  private var pageCount: Int { max(1, (branches.count + 3) / 4) }
  private var currentPage: Int { min(page, pageCount - 1) }
  private var visible: [PeopleConnectionBranch] {
    Array(branches.dropFirst(currentPage * 4).prefix(4))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      VStack(alignment: .leading, spacing: 6) {
        Text("Direct connections").font(.headline)
        Text(
          "Relationships are shown relative to \(card.name). Tap a person to follow their connections."
        )
        .font(.caption).foregroundStyle(.secondary)
      }
      VStack(alignment: .leading, spacing: 18) {
        HStack(spacing: 12) {
          Text(card.initials).font(.system(size: 18, weight: .semibold))
            .frame(width: 44, height: 44)
            .background(.white.opacity(0.15), in: Circle())
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 4) {
            Text(card.name).font(.headline)
            Text("\(branches.count) direct \(branches.count == 1 ? "connection" : "connections")")
              .font(.caption).opacity(0.8)
          }
          Spacer(minLength: 0)
        }
        .padding(16)
        .foregroundStyle(AssistantTheme.stageStrong)
        .background(AssistantTheme.accent, in: RoundedRectangle(cornerRadius: 22))
        .anchorPreference(key: PeopleNodeAnchors.self, value: .bounds) { ["focus": $0] }

        ForEach(visible) { branch in
          branchNode(branch)
            .anchorPreference(key: PeopleNodeAnchors.self, value: .bounds) { [branch.id: $0] }
        }
      }
      .padding(.leading, 28)
      .backgroundPreferenceValue(PeopleNodeAnchors.self) { anchors in
        GeometryReader { geometry in
          if let focus = anchors["focus"] {
            let root = geometry[focus]
            if let last = visible.last, let bottom = anchors[last.id] {
              Path { path in
                path.move(to: CGPoint(x: root.minX, y: root.midY))
                path.addLine(to: CGPoint(x: 6, y: root.midY))
                path.addLine(to: CGPoint(x: 6, y: geometry[bottom].midY))
              }
              .stroke(
                AssistantTheme.accent(for: colorScheme).opacity(0.3),
                style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))
            }
            ForEach(visible) { branch in
              if let anchor = anchors[branch.id] {
                let node = geometry[anchor]
                Path { path in
                  path.move(to: CGPoint(x: 6, y: node.midY))
                  path.addLine(to: CGPoint(x: node.minX, y: node.midY))
                }
                .stroke(
                  tint(branch).opacity(0.55),
                  style: StrokeStyle(
                    lineWidth: 1.5, lineCap: .round, lineJoin: .round,
                    dash: branch.needsReview ? [4, 4] : []))
                Circle().fill(tint(branch))
                  .frame(width: 5, height: 5)
                  .position(x: node.minX, y: node.midY)
              }
            }
          }
        }.allowsHitTesting(false).accessibilityHidden(true)
      }
      if branches.isEmpty {
        Text(
          "No person-to-person connections recorded yet. This doesn’t mean they have no relationships."
        )
        .font(.subheadline).foregroundStyle(.secondary)
      } else {
        Text(
          "Dashed branches include evidence that hasn’t been confirmed. Lines don’t imply relationships between neighboring people."
        )
        .font(.caption).foregroundStyle(.secondary)
      }
      if pageCount > 1 {
        HStack {
          Button("Previous") { page = max(0, currentPage - 1) }.disabled(currentPage == 0)
          Spacer()
          Text("\(currentPage + 1) of \(pageCount)").font(.caption.monospacedDigit())
          Spacer()
          Button("Next") { page = min(pageCount - 1, currentPage + 1) }
            .disabled(currentPage == pageCount - 1)
        }.font(.subheadline).frame(minHeight: 44)
      }
    }
    .onChange(of: card.id) { _, _ in page = 0 }
    .onChange(of: currentPage) { _, _ in pageChanged() }
  }

  private func tint(_ branch: PeopleConnectionBranch) -> Color {
    branch.needsReview
      ? AssistantTheme.warning(for: colorScheme) : AssistantTheme.accent(for: colorScheme)
  }

  private func branchNode(_ branch: PeopleConnectionBranch) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        if let id = branch.contactID { open(id) } else { inspect(branch) }
      } label: {
        HStack(alignment: .top, spacing: 10) {
          PersonInitialsBadge(initials: branch.group.representative.otherInitials, size: 36)
          VStack(alignment: .leading, spacing: 5) {
            Text(branch.group.representative.otherLabel).font(.subheadline.weight(.semibold))
            Text(branch.label).font(.caption.weight(.medium)).foregroundStyle(tint(branch))
            if let detail = branch.detail {
              Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            if branch.needsReview {
              Text("Needs review").font(.caption2).foregroundStyle(.secondary)
            }
          }
          .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
          Image(
            systemName: branch.contactID == nil
              ? "doc.text.magnifyingglass" : "arrow.turn.down.right"
          )
          .font(.system(size: 12, weight: .medium)).foregroundStyle(tint(branch))
          .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(14)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityHint(
        branch.contactID == nil
          ? "No linked profile. View recorded evidence." : "Make this person the center of the map"
      )
      .accessibilityIdentifier("assistant.people.node.\(branch.id)")
      Divider().padding(.horizontal, 14)
      Button {
        inspect(branch)
      } label: {
        HStack {
          Text("View evidence (\(branch.group.relations.count))")
          Spacer(minLength: 4)
          Image(systemName: "chevron.right")
        }
        .font(.caption)
        .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
        .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 44)
        .contentShape(Rectangle())
      }.buttonStyle(.plain)
    }
    .background(AssistantTheme.raised(for: colorScheme), in: RoundedRectangle(cornerRadius: 20))
    .overlay {
      RoundedRectangle(cornerRadius: 20).strokeBorder(tint(branch).opacity(0.22), lineWidth: 1)
    }
  }
}

private struct PeopleNodeAnchors: PreferenceKey {
  static let defaultValue: [String: Anchor<CGRect>] = [:]
  static func reduce(
    value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]
  ) {
    value.merge(nextValue(), uniquingKeysWith: { _, new in new })
  }
}
