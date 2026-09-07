import SwiftUI

/// A bounded, one-hop map of real source-backed connections. Moving to a node
/// fetches its neighborhood; it never invents connections between the spokes.
struct KnowledgeGraphNeighbor: Identifiable {
    let entity: KnowledgeEntity
    var connections: [KnowledgeConnection]
    var id: String { entity.id }
    var confirmed: Bool { connections.allSatisfy(\.confirmed) }

    func hasOutgoing(from focusID: String) -> Bool {
        connections.contains { $0.relation.subject.id == focusID }
    }

    func hasIncoming(to focusID: String) -> Bool {
        connections.contains { $0.relation.object.id == focusID }
    }

    var linkLabel: String {
        guard connections.count == 1 else { return "\(connections.count) relationships" }
        let words = connections[0].relation.predicate.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    static func neighbors(of focus: KnowledgeEntity, relations: [KnowledgeRelation]) -> [Self] {
        let active = relations.filter { $0.inRecall != false && $0.reviewStatus != "rejected" }
        var result: [Self] = []
        for connection in KnowledgeConnection.group(active) {
            guard let other = connection.relation.connectedEntity(to: focus.id) else { continue }
            if let index = result.firstIndex(where: { $0.id == other.id }) {
                result[index].connections.append(connection)
            } else {
                result.append(.init(entity: other, connections: [connection]))
            }
        }
        return result.sorted {
            if $0.confirmed != $1.confirmed { return $0.confirmed }
            let order = $0.entity.displayLabel.localizedStandardCompare($1.entity.displayLabel)
            return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
        }
    }
}

struct KnowledgeGraphView: View {
    let focus: KnowledgeEntity
    let relations: [KnowledgeRelation]
    let loading: Bool
    let open: (KnowledgeEntity) -> Void
    let inspect: (KnowledgeGraphNeighbor) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var page = 0

    private var neighbors: [KnowledgeGraphNeighbor] {
        KnowledgeGraphNeighbor.neighbors(of: focus, relations: relations)
    }
    private var pageCount: Int { max(1, (neighbors.count + 3) / 4) }
    private var currentPage: Int { min(page, pageCount - 1) }
    private var visible: [KnowledgeGraphNeighbor] {
        Array(neighbors.dropFirst(currentPage * 4).prefix(4))
    }

    var body: some View {
        VStack(spacing: 8) {
            if neighbors.isEmpty {
                AssistantEmptyState(
                    "No active connections to map", systemImage: "point.3.connected.trianglepath.dotted",
                    description: "Use Details to review older evidence, or add a connection.")
            } else {
                Text("Tap a node to explore. Tap a link for evidence.")
                    .font(.caption)
                    .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
                    .frame(maxWidth: .infinity, alignment: .leading)

                GeometryReader { geometry in
                    let width = geometry.size.width
                    let center = CGPoint(x: width / 2, y: 260)
                    let nodeWidth = min(140, (width - 32) / 2)
                    ZStack(alignment: .topLeading) {
                        ForEach(Array(visible.enumerated()), id: \.element.id) { index, neighbor in
                            let left = index.isMultiple(of: 2)
                            let top = index < 2
                            let centered = visible.count == 1 || (visible.count == 3 && index == 2)
                            let point = CGPoint(x: centered ? center.x : left ? nodeWidth / 2 + 4 : width - nodeWidth / 2 - 4,
                                                y: top ? 62 : 458)
                            let start = CGPoint(x: center.x + (centered ? 0 : left ? -35 : 35), y: center.y + (top ? -50 : 50))
                            let end = CGPoint(x: point.x, y: point.y + (top ? 50 : -50))
                            let tint = neighbor.confirmed
                                ? AssistantTheme.accent(for: colorScheme)
                                : AssistantTheme.warning(for: colorScheme)

                            GraphConnector(start: start, end: end,
                                arrowAtStart: neighbor.hasIncoming(to: focus.id),
                                arrowAtEnd: neighbor.hasOutgoing(from: focus.id))
                                .stroke(tint.opacity(0.65), style: StrokeStyle(
                                    lineWidth: 1.5, lineCap: .round, dash: neighbor.confirmed ? [] : [5, 5]))
                                .accessibilityHidden(true)
                                .allowsHitTesting(false)

                            Button { inspect(neighbor) } label: {
                                Text(neighbor.linkLabel)
                                    .font(.caption.weight(.medium))
                                    .multilineTextAlignment(.center)
                                    .lineLimit(2)
                                    .foregroundStyle(tint)
                                    .padding(.horizontal, 8)
                                    .frame(width: nodeWidth, height: 44)
                                    .background(AssistantTheme.canvas(for: colorScheme),
                                                in: RoundedRectangle(cornerRadius: 12))
                            }
                            .buttonStyle(.plain)
                            .position(x: point.x, y: top ? 160 : 360)
                            .accessibilityLabel(neighbor.connections.map { $0.relation.presentation.accessibleLabel }.joined(separator: " "))
                            .accessibilityValue(neighbor.confirmed ? "Confirmed" : "Needs review")
                            .accessibilityHint("Shows supporting evidence")
                            .accessibilityIdentifier("assistant.knowledge.link.\(neighbor.id)")

                            Button { open(neighbor.entity) } label: {
                                graphNode(neighbor.entity, focused: false, width: nodeWidth)
                            }
                            .buttonStyle(.plain)
                            .position(point)
                            .accessibilityLabel(neighbor.entity.displayLabel)
                            .accessibilityValue(neighbor.entity.kind.sentenceCaseIdentifier)
                            .accessibilityHint("Explore this item's connections")
                            .accessibilityIdentifier("assistant.knowledge.node.\(neighbor.id)")
                        }

                        graphNode(focus, focused: true, width: min(164, width - 32))
                            .position(center)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("Focused on \(focus.displayLabel)")
                    }
                }
                .frame(height: visible.count <= 2 ? 320 : 520)
                .disabled(loading)
                .overlay {
                    if loading {
                        ProgressView("Loading connections…")
                            .padding(16)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                    }
                }

                HStack(spacing: 8) {
                    Path { path in path.move(to: CGPoint(x: 0, y: 6)); path.addLine(to: CGPoint(x: 16, y: 6)) }
                        .stroke(AssistantTheme.accent(for: colorScheme), lineWidth: 1.5)
                        .frame(width: 16, height: 12).accessibilityHidden(true)
                    Text("Confirmed")
                    Path { path in path.move(to: CGPoint(x: 0, y: 6)); path.addLine(to: CGPoint(x: 16, y: 6)) }
                        .stroke(AssistantTheme.warning(for: colorScheme), style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                        .frame(width: 16, height: 12).accessibilityHidden(true)
                    Text("Dashed: needs review")
                    Spacer(minLength: 0)
                }
                .font(.caption2)
                .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))

                if pageCount > 1 {
                    HStack {
                        Button { page = max(0, currentPage - 1) } label: {
                            Label("Previous", systemImage: "chevron.left")
                        }.disabled(currentPage == 0 || loading)
                        Spacer()
                        Text("\(currentPage + 1) of \(pageCount)")
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        Spacer()
                        Button { page = min(pageCount - 1, currentPage + 1) } label: {
                            Label("Next", systemImage: "chevron.right")
                        }.disabled(currentPage == pageCount - 1 || loading)
                    }
                    .font(.subheadline)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("assistant.knowledge.map.pages")
                }
            }
        }
        .onChange(of: focus.id) { _, _ in page = 0 }
    }

    private func graphNode(_ entity: KnowledgeEntity, focused: Bool, width: CGFloat) -> some View {
        VStack(spacing: 5) {
            Image(systemName: Self.symbol(for: entity.kind)).font(.system(size: 18, weight: .medium))
            Text(entity.displayLabel)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
                .multilineTextAlignment(.center)
            Text(entity.kind.sentenceCaseIdentifier)
                .font(.caption2)
                .opacity(0.75)
        }
        .padding(.horizontal, 8)
        .frame(width: width, height: 100)
        .foregroundStyle(focused ? AssistantTheme.stageStrong : AssistantTheme.ink(for: colorScheme))
        .background(focused ? AssistantTheme.accent : AssistantTheme.raised(for: colorScheme),
                    in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(AssistantTheme.accent(for: colorScheme).opacity(focused ? 0 : 0.22), lineWidth: 1)
        }
        .contentShape(RoundedRectangle(cornerRadius: 20))
    }

    static func symbol(for kind: String) -> String {
        switch kind {
        case "person": "person"
        case "place": "mappin"
        case "organization": "building.2"
        case "project": "folder"
        case "event", "date": "calendar"
        default: "circle.hexagongrid"
        }
    }
}

private struct GraphConnector: Shape {
    let start: CGPoint
    let end: CGPoint
    let arrowAtStart: Bool
    let arrowAtEnd: Bool

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: start)
        path.addLine(to: end)
        func arrow(at tip: CGPoint, from origin: CGPoint) {
            let angle = atan2(tip.y - origin.y, tip.x - origin.x)
            for delta in [-0.5, 0.5] {
                path.move(to: CGPoint(x: tip.x - 8 * cos(angle + delta), y: tip.y - 8 * sin(angle + delta)))
                path.addLine(to: tip)
            }
        }
        if arrowAtStart { arrow(at: start, from: end) }
        if arrowAtEnd { arrow(at: end, from: start) }
        return path
    }
}
