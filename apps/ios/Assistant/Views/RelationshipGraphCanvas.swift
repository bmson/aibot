import SwiftUI
import UIKit

struct RelationshipGraphCanvas: UIViewRepresentable {
    let snapshot: RelationshipGraphSnapshot
    let selectedID: String?
    let focusOnly: Bool
    let command: GraphCanvasCommand
    var centeredID: String? = nil
    var allowsNodeDragging = false
    let select: (String?) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeUIView(context: Context) -> RelationshipGraphCanvasView { RelationshipGraphCanvasView() }
    func updateUIView(_ view: RelationshipGraphCanvasView, context: Context) {
        view.onSelect = select
        view.configure(snapshot: snapshot, selectedID: selectedID, focusOnly: focusOnly, dark: colorScheme == .dark, reduceMotion: reduceMotion, centeredID: centeredID, allowsNodeDragging: allowsNodeDragging)
        view.perform(command)
    }
}

struct GraphCanvasCommand: Equatable {
    enum Action { case fit, zoomIn, zoomOut, tidy }
    var id = 0
    var action: Action = .fit
}

/// UIKit owns gestures and drawing so dragging does not rebuild SwiftUI's view tree.
final class RelationshipGraphCanvasView: UIView, UIGestureRecognizerDelegate {
    /// Canvas labels are drawn into a CGContext, so they get none of SwiftUI's
    /// Dynamic Type scaling for free. Scaling them by hand is what keeps this
    /// screen legible for someone who has turned the system text size up —
    /// every other screen in the app already grows with it.
    ///
    /// Capped because the layout reserves fixed room for a label: past roughly
    /// double, text would collide with neighbouring nodes rather than help.
    static func scaledFont(_ size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
        let base = UIFont.systemFont(ofSize: size, weight: weight)
        return UIFontMetrics(forTextStyle: .caption1).scaledFont(for: base, maximumPointSize: size * 2)
    }

    private(set) var layout = RelationshipGraphLayout()
    private(set) var viewport = GraphViewport()
    private var nodes: [RelationshipGraphNode] = []
    private var links: [GraphLink] = []
    private var groups: [RelationshipGraphGroup] = []
    private var unreviewed = Set<GraphLink>()
    private var selectedID: String?
    private var neighbors = Set<String>()
    private var focusOnly = false
    private var dark = false
    private var centeredID: String?
    private var allowsNodeDragging = false
    private var previousSize = CGSize.zero
    private var edgeLabels: [GraphLink: String] = [:]
    private var edgeDirections: [GraphLink: String] = [:]
    private var lastCommand = -1
    private var needsInitialFit = true
    private var dragID: String?
    private var dragStart: CGPoint?
    private var originalNodePosition: CGPoint?
    private var originalViewport = GraphViewport()
    private var pinchStartScale: CGFloat = 1
    private var pinchWorldAnchor = CGPoint.zero
    var onSelect: ((String?) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = true
        isMultipleTouchEnabled = true
        accessibilityIdentifier = "assistant.relationship.graph.canvas"
        let pan = UIPanGestureRecognizer(target: self, action: #selector(pan(_:)))
        pan.maximumNumberOfTouches = 1
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinch(_:)))
        let tap = UITapGestureRecognizer(target: self, action: #selector(tap(_:)))
        tap.require(toFail: pan)
        pan.delegate = self; pinch.delegate = self
        addGestureRecognizer(pan); addGestureRecognizer(pinch); addGestureRecognizer(tap)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(snapshot: RelationshipGraphSnapshot, selectedID: String?, focusOnly: Bool, dark: Bool, reduceMotion: Bool, centeredID: String? = nil, allowsNodeDragging: Bool = false) {
        let newLinks = snapshot.links
        let changed = nodes != snapshot.nodes || links != newLinks || self.centeredID != centeredID
        let newFocus = self.centeredID != centeredID
        self.centeredID = centeredID; self.allowsNodeDragging = allowsNodeDragging
        edgeLabels = [:]; edgeDirections = [:]
        let claims = Dictionary(grouping: snapshot.edges.filter { $0.reviewStatus != "rejected" }, by: { GraphLink($0.subjectId, $0.objectId) })
        for (link, edges) in claims {
            let statements = Set(edges.map { "\($0.subjectId)|\($0.predicate)|\($0.objectId)|\($0.validFrom ?? "")|\($0.validUntil ?? "")" })
            if statements.count == 1, let edge = edges.first {
                edgeLabels[link] = edge.presentation.label; edgeDirections[link] = edge.objectId
            } else { edgeLabels[link] = "\(statements.count) relationships" }
        }
        self.dark = dark
        self.selectedID = selectedID; self.focusOnly = focusOnly
        neighbors = selectedID.map { snapshot.neighborhood(of: $0) } ?? []
        unreviewed = Set(snapshot.edges.filter { $0.reviewStatus != "confirmed" }.map { GraphLink($0.subjectId, $0.objectId) })
        if changed {
            nodes = snapshot.nodes; links = newLinks; groups = snapshot.groups
            let existing = !layout.ids.isEmpty
            let changedItems = Set(layout.ids) != Set(nodes.map(\.id))
            layout.update(nodes: nodes, links: links)
            if let centeredID, newFocus || changedItems {
                layout.move(id: centeredID, to: .zero)
                let others = nodes.filter { $0.id != centeredID }
                let slots = [CGPoint(x: -115, y: -130), CGPoint(x: 115, y: -130), CGPoint(x: -115, y: 130), CGPoint(x: 115, y: 130)]
                for (index, node) in others.enumerated() {
                    layout.move(id: node.id, to: slots[index % slots.count])
                }
                if !bounds.isEmpty { fit(); needsInitialFit = false }
            } else if centeredID == nil && (!existing || newFocus) {
                for _ in 0..<160 { layout.step() }
                layout.arrangeGroups()
                if !bounds.isEmpty { fit(); needsInitialFit = false }
            }
        }
        refreshAccessibility()
        setNeedsDisplay()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Insets may change when controls wrap. Keep existing nodes at their screen positions.
        if !previousSize.equalTo(.zero), previousSize != bounds.size {
            viewport.offset.x += (previousSize.width - bounds.width) / 2
            viewport.offset.y += (previousSize.height - bounds.height) / 2
        }
        previousSize = bounds.size
        if needsInitialFit, !bounds.isEmpty, !nodes.isEmpty { fit(); needsInitialFit = false }
        refreshAccessibility()
    }
    func perform(_ command: GraphCanvasCommand) {
        guard lastCommand != command.id else { return }
        lastCommand = command.id
        switch command.action {
        case .tidy:
            if centeredID == nil {
                for _ in 0..<120 { layout.step() }
                layout.arrangeGroups()
            }
            fit()
        case .fit: fit()
        case .zoomIn: zoom(to: viewport.scale * 1.35, anchor: CGPoint(x: bounds.midX, y: bounds.midY))
        case .zoomOut: zoom(to: viewport.scale / 1.35, anchor: CGPoint(x: bounds.midX, y: bounds.midY))
        }
        refreshAccessibility(); setNeedsDisplay()
    }
    private func fit() {
        let points = zip(layout.ids, layout.positions).filter { !focusOnly || selectedID == nil || neighbors.contains($0.0) }.map(\.1)
        viewport.fit(points, size: bounds.size)
        setNeedsDisplay()
    }
    func zoom(to scale: CGFloat, anchor: CGPoint) {
        viewport.zoom(to: scale, anchor: anchor, size: bounds.size)
        refreshAccessibility(); setNeedsDisplay()
    }

    private func points() -> [String: CGPoint] { Dictionary(uniqueKeysWithValues: zip(layout.ids, layout.positions)) }
    func hitNode(at point: CGPoint) -> String? {
        var closest: (String, CGFloat)?
        for (id, position) in zip(layout.ids, layout.positions) where !focusOnly || selectedID == nil || neighbors.contains(id) {
            let screen = viewport.screen(position, size: bounds.size)
            let distance = hypot(screen.x - point.x, screen.y - point.y)
            if distance <= 24 && (closest == nil || distance < closest!.1) { closest = (id, distance) }
        }
        return closest?.0
    }
    @objc private func tap(_ gesture: UITapGestureRecognizer) { onSelect?(hitNode(at: gesture.location(in: self))) }

    func beginDrag(at point: CGPoint) {
        dragStart = point; originalViewport = viewport
        dragID = allowsNodeDragging ? hitNode(at: point) : nil
        originalNodePosition = dragID.flatMap { points()[$0] }
    }
    func drag(to point: CGPoint) {
        guard let start = dragStart else { return }
        if let id = dragID, let origin = originalNodePosition {
            layout.move(id: id, to: CGPoint(x: origin.x + (point.x - start.x) / viewport.scale, y: origin.y + (point.y - start.y) / viewport.scale))
        } else {
            viewport.offset = CGPoint(x: originalViewport.offset.x + point.x - start.x, y: originalViewport.offset.y + point.y - start.y)
        }
        setNeedsDisplay()
    }
    func endDrag(cancelled: Bool) {
        guard dragStart != nil else { return }
        if cancelled {
            if let id = dragID, let point = originalNodePosition { layout.move(id: id, to: point) }
            else { viewport = originalViewport }
        }
        dragID = nil; dragStart = nil; originalNodePosition = nil
        refreshAccessibility(); setNeedsDisplay()
    }
    @objc private func pan(_ gesture: UIPanGestureRecognizer) {
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            let translation = gesture.translation(in: self)
            beginDrag(at: CGPoint(x: point.x - translation.x, y: point.y - translation.y)); drag(to: point)
        case .changed: drag(to: point)
        case .ended: endDrag(cancelled: false)
        case .cancelled, .failed: endDrag(cancelled: true)
        default: break
        }
    }
    @objc private func pinch(_ gesture: UIPinchGestureRecognizer) {
        let point = gesture.location(in: self)
        if gesture.state == .began {
            endDrag(cancelled: true)
            originalViewport = viewport
            pinchStartScale = viewport.scale
            pinchWorldAnchor = viewport.world(point, size: bounds.size)
        }
        if gesture.state == .changed || gesture.state == .ended {
            viewport.scale = min(4, max(0.15, pinchStartScale * gesture.scale))
            viewport.offset = CGPoint(x: point.x - bounds.midX - pinchWorldAnchor.x * viewport.scale, y: point.y - bounds.midY - pinchWorldAnchor.y * viewport.scale)
        } else if gesture.state == .cancelled { viewport = originalViewport }
        refreshAccessibility(); setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let canvas = UIColor(AssistantTheme.canvas(for: dark ? .dark : .light))
        let ink = UIColor(AssistantTheme.ink(for: dark ? .dark : .light))
        let accent = UIColor(AssistantTheme.accent(for: dark ? .dark : .light))
        canvas.setFill(); context.fill(bounds)
        let positions = points()
        let degrees = links.reduce(into: [String: Int]()) { result, link in result[link.a, default: 0] += 1; result[link.b, default: 0] += 1 }
        if groups.count > 1, !focusOnly {
            for group in groups where group.nodes.count > 1 {
                let points = group.nodes.compactMap { positions[$0.id] }.map { viewport.screen($0, size: bounds.size) }
                guard let first = points.first else { continue }
                var area = CGRect(origin: first, size: CGSize(width: 1, height: 1))
                for point in points { area = area.union(CGRect(origin: point, size: CGSize(width: 1, height: 1))) }
                area = area.insetBy(dx: -22, dy: -26)
                let highlighted = selectedID.map { group.ids.contains($0) } ?? false
                context.setFillColor(accent.withAlphaComponent(highlighted ? 0.07 : 0.035).cgColor)
                context.addPath(UIBezierPath(roundedRect: area, cornerRadius: 28).cgPath); context.fillPath()
            }
        }
        for link in links {
            guard let a = positions[link.a], let b = positions[link.b] else { continue }
            let highlighted = selectedID == link.a || selectedID == link.b
            if focusOnly && selectedID != nil && !(neighbors.contains(link.a) && neighbors.contains(link.b)) { continue }
            let start = viewport.screen(a, size: bounds.size), end = viewport.screen(b, size: bounds.size)
            context.setStrokeColor((highlighted ? accent.withAlphaComponent(0.65) : ink.withAlphaComponent(centeredID != nil ? 0.3 : selectedID == nil ? 0.24 : 0.07)).cgColor)
            context.setLineWidth(highlighted ? 1.4 : 0.7)
            context.setLineDash(phase: 0, lengths: unreviewed.contains(link) ? [3, 4] : [])
            context.move(to: start); context.addLine(to: end); context.strokePath()
            if centeredID != nil, let target = edgeDirections[link] {
                let tip = target == link.b ? end : start, tail = target == link.b ? start : end
                let angle = atan2(tip.y - tail.y, tip.x - tail.x)
                let inset: CGFloat = target == selectedID ? 16 : 12
                let arrow = CGPoint(x: tip.x - cos(angle) * inset, y: tip.y - sin(angle) * inset)
                context.setLineDash(phase: 0, lengths: [])
                context.move(to: CGPoint(x: arrow.x - cos(angle - 0.5) * 7, y: arrow.y - sin(angle - 0.5) * 7))
                context.addLine(to: arrow)
                context.addLine(to: CGPoint(x: arrow.x - cos(angle + 0.5) * 7, y: arrow.y - sin(angle + 0.5) * 7))
                context.strokePath()
            }
            if centeredID != nil, let label = edgeLabels[link] {
                let text = label as NSString
                let attributes: [NSAttributedString.Key: Any] = [.font: Self.scaledFont(11), .foregroundColor: ink.withAlphaComponent(0.75)]
                let size = text.size(withAttributes: attributes)
                let box = CGRect(x: (start.x + end.x - min(105, size.width)) / 2, y: (start.y + end.y - size.height) / 2,
                                 width: min(105, size.width), height: size.height)
                canvas.setFill(); context.fill(box.insetBy(dx: -4, dy: -3))
                text.draw(with: box, options: [.truncatesLastVisibleLine], attributes: attributes, context: nil)
            }
        }
        context.setLineDash(phase: 0, lengths: [])
        let nodeBounds = nodes.compactMap { node -> CGRect? in
            guard let position = positions[node.id], !focusOnly || selectedID == nil || neighbors.contains(node.id) else { return nil }
            let point = viewport.screen(position, size: bounds.size)
            let radius: CGFloat = node.id == selectedID ? 12 : 10
            return CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)
        }
        var occupiedLabels: [CGRect] = []
        let orderedNodes = nodes.sorted { ($0.id == selectedID ? 0 : neighbors.contains($0.id) ? 1 : 2) < ($1.id == selectedID ? 0 : neighbors.contains($1.id) ? 1 : 2) }
        for node in orderedNodes {
            guard let position = positions[node.id], !focusOnly || selectedID == nil || neighbors.contains(node.id) else { continue }
            let point = viewport.screen(position, size: bounds.size)
            guard bounds.insetBy(dx: -100, dy: -50).contains(point) else { continue }
            let selected = node.id == selectedID
            let relevant = centeredID != nil || selectedID == nil || neighbors.contains(node.id)
            let radius: CGFloat = selected ? 11 : min(9, 4 + sqrt(CGFloat(degrees[node.id] ?? 0)))
            let tint = node.kind == "person" ? accent : Self.tint(for: node.kind)
            if selected {
                context.setFillColor(accent.withAlphaComponent(0.13).cgColor)
                context.fillEllipse(in: CGRect(x: point.x - 21, y: point.y - 21, width: 42, height: 42))
            }
            context.setFillColor(tint.withAlphaComponent(relevant ? 1 : 0.22).cgColor)
            context.fillEllipse(in: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2))
            guard centeredID != nil || selected || neighbors.contains(node.id) || (selectedID == nil && (viewport.scale > 0.5 || nodes.count < 35)) else { continue }
            let text = node.label as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: Self.scaledFont(
                    selected || centeredID != nil ? 14 : 11,
                    weight: selected ? .semibold : .regular
                ),
                .foregroundColor: ink.withAlphaComponent(relevant ? 1 : 0.4),
            ]
            let measured = text.size(withAttributes: attributes)
            let width = max(1, min(centeredID == nil ? 150 : 125, measured.width))
            let labelHeight = centeredID == nil ? measured.height : min(2, ceil(measured.width / width)) * measured.height
            let labelRadius = max(10, radius)
            let candidates = [
                CGRect(x: point.x - width / 2, y: point.y + labelRadius + 7, width: width, height: labelHeight),
                CGRect(x: point.x - width / 2, y: point.y - labelRadius - 7 - labelHeight, width: width, height: labelHeight),
                CGRect(x: point.x + labelRadius + 8, y: point.y - labelHeight / 2, width: width, height: labelHeight),
            ]
            let clearLabel = candidates.first { candidate in
                !(nodeBounds + occupiedLabels).contains { $0.intersects(candidate.insetBy(dx: -3, dy: -2)) }
            }
            guard let label = clearLabel ?? (selected ? candidates.first : nil) else { continue }
            occupiedLabels.append(label)
            canvas.withAlphaComponent(0.88).setFill(); context.fill(label.insetBy(dx: -2, dy: -1))
            text.draw(with: label, options: [.truncatesLastVisibleLine, .usesLineFragmentOrigin], attributes: attributes, context: nil)
        }
    }
    static func tint(for kind: String) -> UIColor {
        switch kind { case "place": .systemTeal; case "organization": .systemIndigo; case "project": .systemOrange; default: .systemPink }
    }
    /// How this node connects, in words.
    ///
    /// The canvas draws a relationship as a line and its review status as a
    /// dash pattern, so without this a VoiceOver user could hear every name on
    /// the graph and still learn nothing about how any two of them relate, or
    /// which claims are unconfirmed. Bounded because an announcement that
    /// recites forty edges is its own kind of unusable.
    ///
    /// The name and link lookups are passed in rather than rebuilt: this is
    /// called once per node from `refreshAccessibility`, which itself runs on
    /// every pinch frame, and deriving them here made that O(nodes × links)
    /// many times a second.
    private func connectionSummary(
        for id: String,
        names: [String: String],
        linksByID: [String: [GraphLink]]
    ) -> String {
        let touching = linksByID[id] ?? []
        let described = touching.prefix(6).compactMap { link -> String? in
            guard let otherID = link.other(than: id), let other = names[otherID] else { return nil }
            let relation = edgeLabels[link] ?? "connected"
            let status = unreviewed.contains(link) ? "needs review" : "confirmed"
            return "\(relation) \(other), \(status)"
        }
        guard !described.isEmpty else { return "No recorded connections" }
        let more = touching.count > described.count
            ? ", and \(touching.count - described.count) more"
            : ""
        return described.joined(separator: "; ") + more
    }

    private func refreshAccessibility() {
        let positions = points()
        let names = Dictionary(nodes.map { ($0.id, $0.label) }, uniquingKeysWith: { first, _ in first })
        var linksByID: [String: [GraphLink]] = [:]
        for link in links {
            linksByID[link.a, default: []].append(link)
            // A link whose ends are equal would otherwise be counted twice for
            // that node, inflating the "and N more" tail.
            if link.b != link.a { linksByID[link.b, default: []].append(link) }
        }
        accessibilityElements = nodes.compactMap { node -> UIAccessibilityElement? in
            guard let position = positions[node.id], !focusOnly || selectedID == nil || neighbors.contains(node.id) else { return nil }
            let point = viewport.screen(position, size: bounds.size)
            guard bounds.contains(point) else { return nil }
            let element = GraphAccessibleNode(accessibilityContainer: self)
            element.accessibilityLabel = node.label
            element.accessibilityValue = "\(node.kind.capitalized). \(connectionSummary(for: node.id, names: names, linksByID: linksByID))"
            element.accessibilityHint = "Select to view connections"
            element.accessibilityTraits = node.id == selectedID ? [.button, .selected] : [.button]
            element.accessibilityFrameInContainerSpace = CGRect(x: point.x - 22, y: point.y - 22, width: 44, height: 44)
            element.activate = { [weak self] in self?.onSelect?(node.id) }
            return element
        }
    }
}

private final class GraphAccessibleNode: UIAccessibilityElement {
    var activate: (() -> Void)?
    override func accessibilityActivate() -> Bool { activate?(); return true }
}
