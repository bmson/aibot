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

    /// How much of the graph the phone holds at once. The server sends at most
    /// about two hundred items per request; the window is larger so that
    /// opening a neighbourhood adds to the map rather than replacing it.
    static let windowNodeCap = 320
    static let windowEdgeCap = 1600

    /// Merges a freshly fetched neighbourhood of `entityID` into the map.
    ///
    /// The fresh claims about `entityID` replace the old ones — that is how an
    /// edit, a confirmation or a new connection shows up. When the result is
    /// bigger than the window, the items furthest from `entityID` (in hops)
    /// are dropped first, never the neighbourhood just fetched or anything in
    /// `keep`. It never silently discards the fetch: an earlier version
    /// skipped the merge whenever the map was full, which on a real account
    /// meant saved changes never appeared.
    func merging(_ other: Self, around entityID: String, keep: Set<String> = [],
                 nodeCap: Int = windowNodeCap, edgeCap: Int = windowEdgeCap) -> Self {
        var nextNodes = nodes
        var byID = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($0.element.id, $0.offset) })
        for node in other.nodes {
            if let index = byID[node.id] { nextNodes[index] = node }
            else { byID[node.id] = nextNodes.count; nextNodes.append(node) }
        }
        var nextEdges = edges.filter { $0.subjectId != entityID && $0.objectId != entityID }
        var edgeIDs = Set(nextEdges.map(\.id))
        for edge in other.edges where edge.reviewStatus != "rejected" && byID[edge.subjectId] != nil && byID[edge.objectId] != nil {
            if edgeIDs.insert(edge.id).inserted { nextEdges.append(edge) }
        }
        let protected = keep.union(other.nodes.map(\.id)).union([entityID])
        let evicted = Self.evict(nodes: &nextNodes, edges: &nextEdges, around: entityID, protecting: protected, cap: nodeCap)
        var edgesCapped = false
        if nextEdges.count > edgeCap {
            // The claims about the item in hand are the ones being looked at.
            let touching = nextEdges.filter { $0.subjectId == entityID || $0.objectId == entityID }
            let rest = nextEdges.filter { $0.subjectId != entityID && $0.objectId != entityID }
            nextEdges = Array((touching + rest).prefix(edgeCap))
            edgesCapped = true
        }
        return Self(nodes: nextNodes, edges: nextEdges, totalEdges: max(totalEdges, other.totalEdges),
                    truncated: truncated || other.truncated || evicted || edgesCapped,
                    focusId: focusId)
    }

    /// The whole map re-read in the background, laid over what the phone
    /// already holds. Items and claims the server knows are brought up to
    /// date and new ones are added — so what the assistant has learned since
    /// the map opened blooms into it — while neighbourhoods opened by hand
    /// stay. Deletions made elsewhere wait for an explicit reload, because an
    /// overview that was cut short cannot say what is gone.
    func refreshed(with fresh: Self, keep: Set<String> = [],
                   nodeCap: Int = windowNodeCap, edgeCap: Int = windowEdgeCap) -> Self {
        var nextNodes = nodes
        var byID = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($0.element.id, $0.offset) })
        for node in fresh.nodes {
            if let index = byID[node.id] { nextNodes[index] = node }
            else { byID[node.id] = nextNodes.count; nextNodes.append(node) }
        }
        let updates = Dictionary(fresh.edges.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        var nextEdges = edges.compactMap { edge -> RelationshipGraphEdge? in
            guard let update = updates[edge.id] else { return edge }
            return update.reviewStatus == "rejected" ? nil : update
        }
        var edgeIDs = Set(nextEdges.map(\.id))
        for edge in fresh.edges where edge.reviewStatus != "rejected" && byID[edge.subjectId] != nil && byID[edge.objectId] != nil {
            if edgeIDs.insert(edge.id).inserted { nextEdges.append(edge) }
        }
        let evicted = Self.evict(nodes: &nextNodes, edges: &nextEdges, around: fresh.focusId ?? "",
                                 protecting: keep.union(fresh.nodes.map(\.id)), cap: nodeCap)
        let edgesCapped = nextEdges.count > edgeCap
        if edgesCapped { nextEdges = Array(nextEdges.prefix(edgeCap)) }
        return Self(nodes: nextNodes, edges: nextEdges, totalEdges: max(totalEdges, fresh.totalEdges),
                    truncated: truncated || fresh.truncated || evicted || edgesCapped, focusId: focusId)
    }

    /// Lets go of the items furthest (in hops) from `entityID` until the map
    /// fits `cap`, never anything in `protected`, and takes their lines with
    /// them. Returns whether anything went.
    private static func evict(nodes: inout [RelationshipGraphNode], edges: inout [RelationshipGraphEdge],
                              around entityID: String, protecting protected: Set<String>, cap: Int) -> Bool {
        guard nodes.count > cap else { return false }
        var adjacent: [String: [String]] = [:]
        for edge in edges where edge.reviewStatus != "rejected" {
            adjacent[edge.subjectId, default: []].append(edge.objectId)
            adjacent[edge.objectId, default: []].append(edge.subjectId)
        }
        var distance = [entityID: 0], queue = [entityID], head = 0
        while head < queue.count {
            let id = queue[head]; head += 1
            for next in adjacent[id] ?? [] where distance[next] == nil {
                distance[next] = distance[id]! + 1; queue.append(next)
            }
        }
        let removable = nodes.filter { !protected.contains($0.id) }.sorted {
            let a = distance[$0.id] ?? .max, b = distance[$1.id] ?? .max
            if a != b { return a > b }
            let da = adjacent[$0.id]?.count ?? 0, db = adjacent[$1.id]?.count ?? 0
            return da != db ? da < db : $0.id < $1.id
        }
        let dropping = Set(removable.prefix(nodes.count - cap).map(\.id))
        guard !dropping.isEmpty else { return false }
        nodes.removeAll { dropping.contains($0.id) }
        edges.removeAll { dropping.contains($0.subjectId) || dropping.contains($0.objectId) }
        return true
    }

    /// What the owner has chosen to see: kinds they have hidden are left
    /// out, as is their own item when `hidden` names it, and — with orphans
    /// off — anything that has no line left once the rest is filtered.
    /// `kept` survives the orphan filter, so a selection never vanishes from
    /// under the finger.
    func filtered(by settings: GraphSettings, hiding hidden: String? = nil, keeping kept: String? = nil) -> Self {
        guard !settings.hiddenKinds.isEmpty || hidden != nil || !settings.showOrphans else { return self }
        let ids = Set(nodes.lazy.filter { !settings.hiddenKinds.contains($0.kind) && $0.id != hidden }.map(\.id))
        let shown = showing(ids)
        guard !settings.showOrphans else { return shown }
        let degrees = shown.degrees
        return shown.showing(ids.filter { degrees[$0, default: 0] > 0 || $0 == kept })
    }

    /// Distinct neighbours of every item, from one pass over the lines.
    var adjacency: [String: Set<String>] {
        links.reduce(into: [String: Set<String>]()) { result, link in
            result[link.a, default: []].insert(link.b)
            result[link.b, default: []].insert(link.a)
        }
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

/// How the owner has tuned the map, in the manner of Obsidian's graph
/// settings: what is shown, how it is drawn, and the forces that shape it.
/// Every size and force is a multiplier on the tuned default, so 1 always
/// means "as designed" and the sliders can be reset without remembering
/// numbers.
struct GraphSettings: Codable, Equatable, Sendable {
    // Filters
    var hiddenKinds: Set<String> = []
    var showOrphans = true
    // Display
    var arrows = true
    /// Below zero names wait until the map is closer; above zero they
    /// appear from further out.
    var textFade: CGFloat = 0
    var nodeSize: CGFloat = 1
    var linkThickness: CGFloat = 1
    // Forces
    var centerForce: CGFloat = 1
    var repelForce: CGFloat = 1
    var linkForce: CGFloat = 1
    var linkDistance: CGFloat = 1

    static let defaultsKey = "assistant.graph.settings"
    static let multiplierRange: ClosedRange<CGFloat> = 0.25...2.5

    init() {}

    /// Decoded leniently: a setting added later reads as its default rather
    /// than throwing away everything the owner has already tuned.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let standard = Self()
        hiddenKinds = try container.decodeIfPresent(Set<String>.self, forKey: .hiddenKinds) ?? standard.hiddenKinds
        showOrphans = try container.decodeIfPresent(Bool.self, forKey: .showOrphans) ?? standard.showOrphans
        arrows = try container.decodeIfPresent(Bool.self, forKey: .arrows) ?? standard.arrows
        textFade = try container.decodeIfPresent(CGFloat.self, forKey: .textFade) ?? standard.textFade
        nodeSize = try container.decodeIfPresent(CGFloat.self, forKey: .nodeSize) ?? standard.nodeSize
        linkThickness = try container.decodeIfPresent(CGFloat.self, forKey: .linkThickness) ?? standard.linkThickness
        centerForce = try container.decodeIfPresent(CGFloat.self, forKey: .centerForce) ?? standard.centerForce
        repelForce = try container.decodeIfPresent(CGFloat.self, forKey: .repelForce) ?? standard.repelForce
        linkForce = try container.decodeIfPresent(CGFloat.self, forKey: .linkForce) ?? standard.linkForce
        linkDistance = try container.decodeIfPresent(CGFloat.self, forKey: .linkDistance) ?? standard.linkDistance
    }

    init(data: Data) {
        self = (try? JSONDecoder().decode(Self.self, from: data)) ?? Self()
    }

    var data: Data { (try? JSONEncoder().encode(self)) ?? Data() }

    /// Whether the physics has to be retuned to go from `other` to this.
    func reshapesLayout(from other: Self) -> Bool {
        nodeSize != other.nodeSize || centerForce != other.centerForce || repelForce != other.repelForce
            || linkForce != other.linkForce || linkDistance != other.linkDistance
    }

    var isDisplayStandard: Bool {
        arrows && textFade == 0 && nodeSize == 1 && linkThickness == 1
    }

    var areForcesStandard: Bool {
        centerForce == 1 && repelForce == 1 && linkForce == 1 && linkDistance == 1
    }
}

/// A live force simulation in the manner of d3-force, which is what Obsidian's
/// graph runs on: nodes repel, links pull to a rest length, a weak gravity
/// keeps loose islands in orbit instead of drifting off, and everything is
/// scaled by `alpha`, which cools towards zero so the map comes to rest.
/// Dragging a node pins it and reheats the simulation a little, so its
/// neighbours follow it through the drag and settle once it is let go.
///
/// Size is part of the physics, not only of the drawing. An item's radius
/// grows with how connected it is, and a big item pushes harder, keeps a
/// wider berth and holds its leaves further out, so a hub sits in a clearing
/// of its own rather than under a pile of the dots it connects.
///
/// Deterministic: the same nodes and links always settle the same way, and
/// positions survive an update, so expanding a neighbourhood grows the map
/// around what is already there rather than reshuffling it.
struct RelationshipGraphLayout {
    private(set) var ids: [String] = []
    private(set) var positions: [CGPoint] = []
    /// Each item's world radius: how connected it is, as a size.
    private(set) var radii: [CGFloat] = []
    private(set) var settings = GraphSettings()
    private var slots: [String: Int] = [:]
    private var velocities: [CGPoint] = []
    private var degree: [Int] = []
    private var pairs: [(a: Int, b: Int)] = []
    private var charges: [CGFloat] = []
    private var pulls: [CGFloat] = []
    private var springs: [(a: Int, b: Int, strength: CGFloat, bias: CGFloat, rest: CGFloat)] = []
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
    /// Two dots never settle closer, centre to centre, than twice this —
    /// and bigger ones keep their own radii plus `collisionPadding` apart.
    static let collisionRadius: CGFloat = 16
    static let collisionPadding: CGFloat = 10
    /// Beyond this, items stop pushing each other, as d3's `distanceMax`
    /// does. Without it the whole map's repulsion adds up against a small
    /// island, holds it a screen away from everything else, and fitting the
    /// map then means shrinking all of it to a speck.
    static let repelReach: CGFloat = 500
    /// Items with no lines at all feel the centre this much more strongly,
    /// so they orbit close by the map instead of marking out its far edge.
    static let orphanPull: CGFloat = 3

    /// World radius for an item with `degree` distinct neighbours. The radius
    /// grows with the square root, so the area a dot covers grows with its
    /// connections: a hub reads as a hub without a leaf shrinking to nothing,
    /// and the cap stops the centre of a star swallowing its own neighbours.
    static func radius(degree: Int, size: CGFloat = 1) -> CGFloat {
        min(28, 4.5 + 2.6 * sqrt(CGFloat(max(0, degree)))) * size
    }

    var isSettled: Bool { positions.isEmpty || (alpha < Self.alphaMin && alphaTarget == 0) }

    func index(of id: String) -> Int? { slots[id] }
    func position(of id: String) -> CGPoint? { slots[id].map { positions[$0] } }
    func radius(of id: String) -> CGFloat? { slots[id].map { radii[$0] } }

    mutating func update(nodes: [RelationshipGraphNode], links: [GraphLink]) {
        let old = Dictionary(zip(ids, positions), uniquingKeysWith: { first, _ in first })
        let oldVelocity = Dictionary(zip(ids, velocities), uniquingKeysWith: { first, _ in first })
        let oldLinks = Set(pairs.map { GraphLink(ids[$0.a], ids[$0.b]) })
        let firstLayout = ids.isEmpty
        ids = Array(Set(nodes.map(\.id))).sorted()
        slots = Dictionary(uniqueKeysWithValues: ids.enumerated().map { ($0.element, $0.offset) })
        var adjacent: [String: [String]] = [:]
        for link in links {
            adjacent[link.a, default: []].append(link.b)
            adjacent[link.b, default: []].append(link.a)
        }
        var placedNew = 0
        positions = ids.enumerated().map { i, id in
            if let previous = old[id] { return previous }
            placedNew += 1
            // A newcomer starts among the neighbours already on the map, so
            // an expansion blooms out of the item that was opened and an item
            // joining two others lands between them. With no placed neighbour
            // it takes a phyllotaxis slot, which spreads a cold start evenly
            // instead of stacking everything at the origin.
            let angle = Double(i) * 2.399963229728653
            let anchors = (adjacent[id] ?? []).compactMap { old[$0] }
            if !anchors.isEmpty {
                let count = CGFloat(anchors.count)
                let x = anchors.reduce(0) { $0 + $1.x } / count, y = anchors.reduce(0) { $0 + $1.y } / count
                return CGPoint(x: x + cos(angle) * 30, y: y + sin(angle) * 30)
            }
            let radius = 18 * sqrt(Double(i) + 0.5)
            return CGPoint(x: cos(angle) * radius, y: sin(angle) * radius)
        }
        velocities = ids.map { oldVelocity[$0] ?? .zero }
        degree = Array(repeating: 0, count: ids.count)
        pairs = links.compactMap { link -> (a: Int, b: Int)? in
            guard let a = slots[link.a], let b = slots[link.b], a != b else { return nil }
            degree[a] += 1; degree[b] += 1
            return (a, b)
        }
        rebuildForces()
        if firstLayout { alpha = 1 }
        else if placedNew > 0 || old.count != ids.count { reheat(0.6) }
        // A new line between two items already on the map has to pull them
        // together, and a removed one let them drift apart; without this the
        // map drew the line and left its ends where they were.
        else if Set(pairs.map { GraphLink(ids[$0.a], ids[$0.b]) }) != oldLinks { reheat(0.35) }
    }

    /// Retunes the physics to the owner's settings, and wakes the map so the
    /// change can be watched taking effect.
    mutating func apply(_ next: GraphSettings) {
        let reshapes = next.reshapesLayout(from: settings)
        settings = next
        guard reshapes else { return }
        rebuildForces()
        if !ids.isEmpty { reheat(0.5) }
    }

    private mutating func rebuildForces() {
        radii = degree.map { Self.radius(degree: $0, size: settings.nodeSize) }
        // A hub pushes harder than a leaf, so it clears room for its leaves.
        charges = degree.map { 0.8 + 0.2 * sqrt(1 + CGFloat($0)) }
        pulls = degree.map { $0 == 0 ? Self.orphanPull : 1 }
        let distance = Self.linkDistance * settings.linkDistance
        let radii = radii
        // d3's defaults: a link is only as stiff as its less connected end
        // allows, so hubs are not yanked about by every leaf, and the leaf does
        // most of the moving. Its rest length leaves room for both bubbles.
        springs = pairs.map { pair in
            let da = CGFloat(degree[pair.a]), db = CGFloat(degree[pair.b])
            return (pair.a, pair.b, 1 / max(1, min(da, db)), da / max(1, da + db),
                    distance + (radii[pair.a] + radii[pair.b]) * 0.6)
        }
    }

    /// Lets the simulation come to rest where it stands.
    mutating func cool() { alpha = min(alpha, Self.alphaMin / 2) }

    /// Wakes the simulation without restarting it from scratch.
    mutating func reheat(_ value: CGFloat = 0.3) { alpha = max(alpha, value) }

    /// Holds the simulation warm while something is being dragged; 0 lets it cool.
    mutating func hold(_ target: CGFloat) {
        alphaTarget = target
        if target > 0 { alpha = max(alpha, target) }
    }

    mutating func move(id: String, to point: CGPoint) {
        guard let i = slots[id] else { return }
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
        let pinnedIndex = pinned.flatMap { slots[$0] }
        var force = Array(repeating: CGPoint.zero, count: n)
        let charge = Self.charge * settings.repelForce * alpha
        let floor = Self.collisionRadius * 2
        let reach = Self.repelReach * max(1, settings.linkDistance)
        // Many-body repulsion, plus a hard collision floor so two dots never
        // sit on top of each other however crowded a cluster gets. At the
        // window's cap this is about fifty thousand pairs a tick, well inside
        // a frame.
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
                // charge·alpha/d — strong up close, a whisper across the map —
                // and by how hard the other one pushes.
                var wi: CGFloat = 0, wj: CGFloat = 0
                if d < reach { wi = charge * charges[j] / d2; wj = charge * charges[i] / d2 }
                let minimum = max(floor, radii[i] + radii[j] + Self.collisionPadding)
                if d < minimum {
                    let push = (minimum - d) / d * 0.5
                    wi -= push; wj -= push
                }
                force[i].x += dx * wi; force[i].y += dy * wi
                force[j].x -= dx * wj; force[j].y -= dy * wj
            }
        }
        let stiffness = alpha * settings.linkForce
        for spring in springs {
            let a = spring.a, b = spring.b
            let dx = positions[b].x + velocities[b].x - positions[a].x - velocities[a].x
            let dy = positions[b].y + velocities[b].y - positions[a].y - velocities[a].y
            let length = max(0.01, sqrt(dx * dx + dy * dy))
            let pull = (length - spring.rest) / length * stiffness * spring.strength
            let x = dx * pull, y = dy * pull
            force[b].x -= x * spring.bias; force[b].y -= y * spring.bias
            force[a].x += x * (1 - spring.bias); force[a].y += y * (1 - spring.bias)
        }
        let gravity = Self.gravity * settings.centerForce * alpha
        var energy: CGFloat = 0
        for i in 0..<n where i != pinnedIndex {
            force[i].x -= positions[i].x * gravity * pulls[i]
            force[i].y -= positions[i].y * gravity * pulls[i]
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
