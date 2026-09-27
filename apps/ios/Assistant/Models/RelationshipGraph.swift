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

    /// Everything one step away, alphabetical so the list does not reshuffle
    /// as the map moves.
    func directNeighbors(of id: String) -> [RelationshipGraphNode] {
        let ids = neighborhood(of: id).subtracting([id])
        return nodes.filter { ids.contains($0.id) }.sorted {
            let order = $0.label.localizedStandardCompare($1.label)
            return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
        }
    }

    /// Distinct neighbours per item — the landmark weight a node is drawn and
    /// named by. Topology, not source rows: three notes about one link count once.
    var degrees: [String: Int] {
        links.reduce(into: [String: Int]()) { result, link in
            result[link.a, default: 0] += 1
            result[link.b, default: 0] += 1
        }
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
    /// `margin` is what is kept clear around the drawing on each axis, in
    /// screen points — room for the names that hang off the outermost dots.
    mutating func fit(_ points: [CGPoint], size: CGSize, margin: CGSize = CGSize(width: 100, height: 120)) {
        guard let first = points.first, size.width > 0, size.height > 0 else { self = Self(); return }
        let minX = points.reduce(first.x) { min($0, $1.x) }, maxX = points.reduce(first.x) { max($0, $1.x) }
        let minY = points.reduce(first.y) { min($0, $1.y) }, maxY = points.reduce(first.y) { max($0, $1.y) }
        scale = min(1.5, max(0.15, min(max(60, size.width - margin.width) / max(100, maxX - minX), max(60, size.height - margin.height) / max(100, maxY - minY))))
        offset = CGPoint(x: -(minX + maxX) / 2 * scale, y: -(minY + maxY) / 2 * scale)
    }
}

/// A live force simulation in the manner of d3-force, which is what Obsidian's
/// graph runs on: nodes repel, links pull to a rest length, a weak gravity
/// keeps loose islands in orbit instead of drifting off, and everything is
/// scaled by `alpha`, which cools towards zero so the map comes to rest.
/// Dragging a node pins it and reheats the simulation a little, so its
/// neighbours follow it through the drag and settle once it is let go.
///
/// Deterministic: the same nodes and links always settle the same way, and
/// positions survive an update, so expanding a neighbourhood grows the map
/// around what is already there rather than reshuffling it.
struct RelationshipGraphLayout {
    private(set) var ids: [String] = []
    private(set) var positions: [CGPoint] = []
    private var velocities: [CGPoint] = []
    private var springs: [(a: Int, b: Int, strength: CGFloat, bias: CGFloat)] = []
    private(set) var alpha: CGFloat = 1
    private var alphaTarget: CGFloat = 0

    static let linkDistance: CGFloat = 70
    static let alphaMin: CGFloat = 0.004
    /// Chosen so a cold start settles in roughly 250 frames — about four
    /// seconds of visible motion, which reads as the map finding its shape
    /// rather than as a loading delay.
    static let alphaDecay: CGFloat = 0.022
    static let velocityDecay: CGFloat = 0.42
    static let charge: CGFloat = -420
    static let gravity: CGFloat = 0.035
    static let collisionRadius: CGFloat = 16

    var isSettled: Bool { positions.isEmpty || (alpha < Self.alphaMin && alphaTarget == 0) }

    mutating func update(nodes: [RelationshipGraphNode], links: [GraphLink]) {
        let old = Dictionary(uniqueKeysWithValues: zip(ids, positions))
        let firstLayout = ids.isEmpty
        ids = nodes.map(\.id).sorted()
        let index = Dictionary(uniqueKeysWithValues: ids.enumerated().map { ($0.element, $0.offset) })
        var placedNew = 0
        positions = ids.enumerated().map { i, id in
            if let previous = old[id] { return previous }
            placedNew += 1
            // A newcomer starts beside a neighbour that is already on the map,
            // so an expansion blooms out of the item that was opened. With no
            // placed neighbour it takes a phyllotaxis slot, which spreads a
            // cold start evenly instead of stacking everything at the origin.
            let angle = Double(i) * 2.399963229728653
            let placedNeighbor = links.lazy.compactMap { link -> CGPoint? in
                if link.a == id { return old[link.b] }
                if link.b == id { return old[link.a] }
                return nil
            }.first
            if let anchor = placedNeighbor {
                return CGPoint(x: anchor.x + cos(angle) * 30, y: anchor.y + sin(angle) * 30)
            }
            let radius = 18 * sqrt(Double(i) + 0.5)
            return CGPoint(x: cos(angle) * radius, y: sin(angle) * radius)
        }
        velocities = ids.map { _ in .zero }
        var degree = Array(repeating: 0, count: ids.count)
        let pairs = links.compactMap { link -> (Int, Int)? in
            guard let a = index[link.a], let b = index[link.b], a != b else { return nil }
            degree[a] += 1; degree[b] += 1
            return (a, b)
        }
        // d3's defaults: a link is only as stiff as its less connected end
        // allows, so hubs are not yanked about by every leaf, and the leaf does
        // most of the moving.
        springs = pairs.map { a, b in
            let da = CGFloat(degree[a]), db = CGFloat(degree[b])
            return (a, b, 1 / max(1, min(da, db)), da / max(1, da + db))
        }
        if firstLayout { alpha = 1 } else if placedNew > 0 || old.count != ids.count { reheat(0.6) }
    }

    /// Wakes the simulation without restarting it from scratch.
    mutating func reheat(_ value: CGFloat = 0.3) { alpha = max(alpha, value) }

    /// Holds the simulation warm while something is being dragged; 0 lets it cool.
    mutating func hold(_ target: CGFloat) {
        alphaTarget = target
        if target > 0 { alpha = max(alpha, target) }
    }

    mutating func move(id: String, to point: CGPoint) {
        guard let i = ids.firstIndex(of: id) else { return }
        positions[i] = point; velocities[i] = .zero
    }

    /// Runs the simulation straight to rest — for Reduce Motion, and for
    /// anywhere a settled picture is wanted without watching it form.
    mutating func settle(maxSteps: Int = 400) {
        var steps = 0
        while !isSettled && steps < maxSteps { step(); steps += 1 }
    }

    /// One tick. `pinned` stays exactly where it is put, like d3's fx/fy.
    @discardableResult mutating func step(pinned: String? = nil) -> CGFloat {
        let n = positions.count
        guard n > 0 else { return 0 }
        alpha += (alphaTarget - alpha) * Self.alphaDecay
        let pinnedIndex = pinned.flatMap { ids.firstIndex(of: $0) }
        var force = Array(repeating: CGPoint.zero, count: n)
        // Many-body repulsion, plus a hard collision floor so two dots never
        // sit on top of each other however crowded a cluster gets. At the 200
        // node cap this is 20,000 pairs a tick, well inside a frame.
        for i in 0..<n {
            for j in (i + 1)..<n {
                var dx = positions[j].x - positions[i].x
                var dy = positions[j].y - positions[i].y
                if dx == 0 && dy == 0 {
                    // Coincident points get a deterministic nudge apart.
                    dx = CGFloat((i * 7 + j * 13) % 11 - 5) * 0.1 + 0.05
                    dy = CGFloat((i * 5 + j * 3) % 11 - 5) * 0.1 + 0.05
                }
                let d2 = max(1, dx * dx + dy * dy)
                let d = sqrt(d2)
                // Negative charge: each moves away from the other, by
                // charge·alpha/d — strong up close, a whisper across the map.
                var w = Self.charge * alpha / d2
                let minimum = Self.collisionRadius * 2
                if d < minimum { w -= (minimum - d) / d * 0.5 }
                force[i].x += dx * w; force[i].y += dy * w
                force[j].x -= dx * w; force[j].y -= dy * w
            }
        }
        for spring in springs {
            let a = spring.a, b = spring.b
            let dx = positions[b].x + velocities[b].x - positions[a].x - velocities[a].x
            let dy = positions[b].y + velocities[b].y - positions[a].y - velocities[a].y
            let length = max(0.01, sqrt(dx * dx + dy * dy))
            let pull = (length - Self.linkDistance) / length * alpha * spring.strength
            let x = dx * pull, y = dy * pull
            force[b].x -= x * spring.bias; force[b].y -= y * spring.bias
            force[a].x += x * (1 - spring.bias); force[a].y += y * (1 - spring.bias)
        }
        var energy: CGFloat = 0
        for i in 0..<n where i != pinnedIndex {
            force[i].x -= positions[i].x * Self.gravity * alpha
            force[i].y -= positions[i].y * Self.gravity * alpha
            velocities[i].x = (velocities[i].x + force[i].x) * (1 - Self.velocityDecay)
            velocities[i].y = (velocities[i].y + force[i].y) * (1 - Self.velocityDecay)
            // Clamped so one tick can never fling a node across the canvas,
            // whatever a collision or a fresh insertion asks for.
            positions[i].x += max(-40, min(40, velocities[i].x))
            positions[i].y += max(-40, min(40, velocities[i].y))
            energy += abs(velocities[i].x) + abs(velocities[i].y)
        }
        if let pinnedIndex { velocities[pinnedIndex] = .zero }
        return energy / CGFloat(n)
    }
}
