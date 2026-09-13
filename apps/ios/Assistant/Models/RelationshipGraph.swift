import Foundation
import CoreGraphics

struct RelationshipGraphNode: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let kind: String
    var contactId: String? = nil
    var entity: KnowledgeEntity { .init(id: id, label: label, kind: kind, canonicalKey: id) }
}

struct RelationshipGraphEdge: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let subjectId: String
    let objectId: String
    let predicate: String
    let reviewStatus: String
    let sourceContent: String
    let presentation: KnowledgePresentation
    let validFrom: String?
    let validUntil: String?
}

struct RelationshipGraphSnapshot: Codable, Sendable {
    var nodes: [RelationshipGraphNode]
    var edges: [RelationshipGraphEdge]
    let totalEdges: Int
    var truncated: Bool
    let focusId: String?

    static let empty = Self(nodes: [], edges: [], totalEdges: 0, truncated: false, focusId: nil)

    /// Exact source IDs deduplicate expansion. A refreshed neighborhood replaces its old claims.
    func merging(_ other: Self, around entityID: String) -> Self {
        var nextNodes = nodes
        var byID = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($0.element.id, $0.offset) })
        for node in other.nodes {
            if let index = byID[node.id] { nextNodes[index] = node }
            else if nextNodes.count < 200 { byID[node.id] = nextNodes.count; nextNodes.append(node) }
        }
        var nextEdges = edges.filter { $0.subjectId != entityID && $0.objectId != entityID }
        var edgeIDs = Set(nextEdges.map(\.id))
        for edge in other.edges where edge.reviewStatus != "rejected" && byID[edge.subjectId] != nil && byID[edge.objectId] != nil {
            if nextEdges.count < 1000, edgeIDs.insert(edge.id).inserted { nextEdges.append(edge) }
        }
        return Self(nodes: nextNodes, edges: nextEdges, totalEdges: max(totalEdges, other.totalEdges),
                    truncated: truncated || other.truncated || nextNodes.count < Set((nodes + other.nodes).map(\.id)).count || nextEdges.count >= 1000,
                    focusId: focusId)
    }

    /// Layout lines are topology, not source counts; duplicate notes never pull nodes harder.
    var links: [GraphLink] {
        var seen = Set<GraphLink>()
        let ids = Set(nodes.map(\.id))
        for edge in edges where edge.reviewStatus != "rejected" && ids.contains(edge.subjectId) && ids.contains(edge.objectId) && edge.subjectId != edge.objectId {
            seen.insert(GraphLink(edge.subjectId, edge.objectId))
        }
        return seen.sorted { $0.a == $1.a ? $0.b < $1.b : $0.a < $1.a }
    }

    func neighborhood(of id: String) -> Set<String> {
        Set(links.filter { $0.a == id || $0.b == id }.flatMap { [$0.a, $0.b] }).union([id])
    }
}

struct RelationshipGraphGroup: Identifiable {
    let id: String
    let nodes: [RelationshipGraphNode]
    let connectionCount: Int
    var label: String { nodes.first?.label ?? "Group" }
    var ids: Set<String> { Set(nodes.map(\.id)) }
}

extension RelationshipGraphSnapshot {
    /// Components describe this loaded view, not proof that no other relationships exist.
    var groups: [RelationshipGraphGroup] {
        let topology = links
        var adjacent: [String: Set<String>] = [:]
        for link in topology { adjacent[link.a, default: []].insert(link.b); adjacent[link.b, default: []].insert(link.a) }
        let byID = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0) })
        var visited = Set<String>(), result: [RelationshipGraphGroup] = []
        for node in nodes.sorted(by: { $0.id < $1.id }) where !visited.contains(node.id) {
            var queue = [node.id], members = Set([node.id]); visited.insert(node.id)
            while let id = queue.popLast() {
                for next in adjacent[id] ?? [] where visited.insert(next).inserted { queue.append(next); members.insert(next) }
            }
            let ordered = members.compactMap { byID[$0] }.sorted {
                let a = adjacent[$0.id]?.count ?? 0, b = adjacent[$1.id]?.count ?? 0
                return a == b ? ($0.label == $1.label ? $0.id < $1.id : $0.label.localizedStandardCompare($1.label) == .orderedAscending) : a > b
            }
            result.append(.init(id: members.sorted().first!, nodes: ordered, connectionCount: topology.filter { members.contains($0.a) }.count))
        }
        return result.sorted { $0.nodes.count == $1.nodes.count ? $0.id < $1.id : $0.nodes.count > $1.nodes.count }
    }

    func showing(_ ids: Set<String>) -> Self {
        .init(nodes: nodes.filter { ids.contains($0.id) }, edges: edges.filter { ids.contains($0.subjectId) && ids.contains($0.objectId) }, totalEdges: totalEdges, truncated: truncated, focusId: focusId)
    }

    /// Stable pages keep a busy person's map readable without hiding access to other connections.
    func directNeighbors(of id: String, peopleOnly: Bool = false) -> [RelationshipGraphNode] {
        let ids = neighborhood(of: id).subtracting([id])
        return nodes.filter { ids.contains($0.id) && (!peopleOnly || $0.kind == "person") }.sorted {
            let order = $0.label.localizedStandardCompare($1.label)
            return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
        }
    }

    func focused(on id: String, page: Int = 0, pageSize: Int = 4, peopleOnly: Bool = false) -> Self {
        guard let center = nodes.first(where: { $0.id == id }) else { return .empty }
        let neighbors = directNeighbors(of: id, peopleOnly: peopleOnly)
        let size = max(1, pageSize)
        let lastPage = max(0, (neighbors.count - 1) / size)
        let start = min(max(0, page), lastPage) * size
        let shown = [center] + Array(neighbors.dropFirst(start).prefix(size))
        let ids = Set(shown.map(\.id))
        return .init(nodes: shown, edges: edges.filter {
            $0.reviewStatus != "rejected" && ($0.subjectId == id || $0.objectId == id)
                && ids.contains($0.subjectId) && ids.contains($0.objectId)
        }, totalEdges: totalEdges, truncated: truncated, focusId: id)
    }

    /// Suggestions are navigation prompts based on topology, never asserted new facts.
    func connectionCandidates(for id: String) -> [(node: RelationshipGraphNode, reason: String)] {
        let direct = neighborhood(of: id)
        let group = groups.first { $0.ids.contains(id) }?.ids ?? [id]
        let byID = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0.label) })
        var ranked: [(node: RelationshipGraphNode, reason: String, score: Int)] = []
        for node in nodes where !direct.contains(node.id) {
            let shared = direct.intersection(neighborhood(of: node.id)).subtracting([id, node.id])
            let labels = shared.compactMap { byID[$0] }.sorted()
            let separate = !group.contains(node.id)
            let reason: String
            if let label = labels.first { reason = "Both connect to \(label)" }
            else { reason = separate ? "In a separate group in this view" : "No direct connection shown" }
            let score = shared.isEmpty ? (separate ? 50 : 0) : 100 + shared.count
            ranked.append((node, reason, score))
        }
        ranked.sort {
            if $0.score != $1.score { return $0.score > $1.score }
            return $0.node.label.localizedStandardCompare($1.node.label) == .orderedAscending
        }
        return ranked.map { (node: $0.node, reason: $0.reason) }
    }
}

struct GraphLink: Hashable, Sendable {
    let a: String
    let b: String
    init(_ first: String, _ second: String) { a = min(first, second); b = max(first, second) }

    func contains(_ id: String) -> Bool { a == id || b == id }

    /// The end that is not `id`, or nil when the link does not touch it.
    func other(than id: String) -> String? {
        if a == id { return b }
        if b == id { return a }
        return nil
    }
}

struct GraphViewport: Equatable {
    var scale: CGFloat = 1
    var offset: CGPoint = .zero
    func screen(_ point: CGPoint, size: CGSize) -> CGPoint {
        CGPoint(x: point.x * scale + size.width / 2 + offset.x, y: point.y * scale + size.height / 2 + offset.y)
    }
    func world(_ point: CGPoint, size: CGSize) -> CGPoint {
        CGPoint(x: (point.x - size.width / 2 - offset.x) / scale, y: (point.y - size.height / 2 - offset.y) / scale)
    }
    mutating func zoom(to value: CGFloat, anchor: CGPoint, size: CGSize) {
        let fixed = world(anchor, size: size)
        scale = min(4, max(0.15, value))
        offset = CGPoint(x: anchor.x - size.width / 2 - fixed.x * scale, y: anchor.y - size.height / 2 - fixed.y * scale)
    }
    mutating func fit(_ points: [CGPoint], size: CGSize) {
        guard let first = points.first, size.width > 0, size.height > 0 else { self = Self(); return }
        let minX = points.reduce(first.x) { min($0, $1.x) }, maxX = points.reduce(first.x) { max($0, $1.x) }
        let minY = points.reduce(first.y) { min($0, $1.y) }, maxY = points.reduce(first.y) { max($0, $1.y) }
        scale = min(1.5, max(0.15, min(max(80, size.width - 100) / max(100, maxX - minX), max(80, size.height - 120) / max(100, maxY - minY))))
        offset = CGPoint(x: -(minX + maxX) / 2 * scale, y: -(minY + maxY) / 2 * scale)
    }
}

/// A bounded deterministic spring simulation. Positions survive data expansion and selection.
struct RelationshipGraphLayout {
    private(set) var ids: [String] = []
    private(set) var positions: [CGPoint] = []
    private var velocities: [CGPoint] = []
    private var springs: [(Int, Int)] = []
    private var anchors: [CGPoint] = []
    private var groupMembers: [[Int]] = []

    mutating func update(nodes: [RelationshipGraphNode], links: [GraphLink]) {
        let old = Dictionary(uniqueKeysWithValues: zip(ids, positions))
        ids = nodes.map(\.id).sorted()
        let index = Dictionary(uniqueKeysWithValues: ids.enumerated().map { ($0.element, $0.offset) })
        positions = ids.enumerated().map { i, id in
            if let previous = old[id] { return previous }
            let angle = Double(i) * 2.399963229728653
            let radius = 45 * sqrt(Double(i) + 1)
            let neighbors = links.compactMap { link -> CGPoint? in
                if link.a == id { return old[link.b] }; if link.b == id { return old[link.a] }; return nil
            }
            let anchor = neighbors.first ?? .zero
            return CGPoint(x: anchor.x + cos(angle) * (neighbors.isEmpty ? radius : 65), y: anchor.y + sin(angle) * (neighbors.isEmpty ? radius : 65))
        }
        velocities = Array(repeating: .zero, count: ids.count)
        springs = links.compactMap { link in guard let a = index[link.a], let b = index[link.b] else { return nil }; return (a, b) }
        // Build components from layout springs without source or presentation dependencies.
        var visited = Set<Int>(); groupMembers = []
        for i in ids.indices where visited.insert(i).inserted {
            var group = [i], queue = [i]
            while let current = queue.popLast() {
                for (a, b) in springs where a == current || b == current {
                    let other = a == current ? b : a
                    if visited.insert(other).inserted { group.append(other); queue.append(other) }
                }
            }
            groupMembers.append(group)
        }
        updateAnchors()
    }

    private mutating func updateAnchors() {
        anchors = Array(repeating: .zero, count: ids.count)
        for group in groupMembers {
            let center = CGPoint(x: group.reduce(0) { $0 + positions[$1].x } / CGFloat(group.count), y: group.reduce(0) { $0 + positions[$1].y } / CGFloat(group.count))
            for i in group { anchors[i] = center }
        }
    }

    /// Pack disconnected components into distinct, non-overlapping areas instead of one cloud.
    mutating func arrangeGroups() {
        let groups = groupMembers.sorted { $0.count == $1.count ? $0[0] < $1[0] : $0.count > $1.count }
        let boxes = groups.map { group -> CGRect in
            let xs = group.map { positions[$0].x }, ys = group.map { positions[$0].y }
            return CGRect(x: xs.min() ?? 0, y: ys.min() ?? 0, width: (xs.max() ?? 0) - (xs.min() ?? 0), height: (ys.max() ?? 0) - (ys.min() ?? 0))
        }
        let area = boxes.reduce(CGFloat(0)) { $0 + max(150, $1.width + 110) * max(130, $1.height + 110) }
        let rowWidth = max(boxes.map { $0.width + 110 }.max() ?? 150, sqrt(area) * 0.85)
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for (group, box) in zip(groups, boxes) {
            let width = max(150, box.width + 110), height = max(130, box.height + 110)
            if x > 0, x + width > rowWidth { x = 0; y += rowHeight; rowHeight = 0 }
            for i in group { positions[i].x += x + width / 2 - box.midX; positions[i].y += y + height / 2 - box.midY; velocities[i] = .zero }
            x += width; rowHeight = max(rowHeight, height)
        }
        updateAnchors()
    }

    mutating func move(id: String, to point: CGPoint) {
        guard let i = ids.firstIndex(of: id) else { return }
        positions[i] = point; velocities[i] = .zero
    }

    @discardableResult mutating func step(pinned: String? = nil) -> CGFloat {
        let n = positions.count
        guard n > 1 else { return 0 }
        var force = Array(repeating: CGPoint.zero, count: n)
        for i in 0..<n {
            for j in (i + 1)..<n {
                let dx = positions[i].x - positions[j].x, dy = positions[i].y - positions[j].y
                let d2 = max(64, dx * dx + dy * dy)
                let length = sqrt(d2)
                let strength = min(5, 1800 / d2)
                let x = dx / length * strength, y = dy / length * strength
                force[i].x += x; force[i].y += y; force[j].x -= x; force[j].y -= y
            }
        }
        for (a, b) in springs {
            let dx = positions[b].x - positions[a].x, dy = positions[b].y - positions[a].y
            let length = max(1, sqrt(dx * dx + dy * dy))
            let strength = (length - 105) * 0.018
            let x = dx / length * strength, y = dy / length * strength
            force[a].x += x; force[a].y += y; force[b].x -= x; force[b].y -= y
        }
        var energy: CGFloat = 0
        for i in 0..<n where ids[i] != pinned {
            velocities[i].x = (velocities[i].x + force[i].x - (positions[i].x - anchors[i].x) * 0.002) * 0.78
            velocities[i].y = (velocities[i].y + force[i].y - (positions[i].y - anchors[i].y) * 0.002) * 0.78
            positions[i].x += max(-8, min(8, velocities[i].x))
            positions[i].y += max(-8, min(8, velocities[i].y))
            energy += abs(velocities[i].x) + abs(velocities[i].y)
        }
        return energy / CGFloat(n)
    }
}
