import SwiftUI
import UIKit

struct RelationshipGraphCanvas: UIViewRepresentable {
    let snapshot: RelationshipGraphSnapshot
    let selectedID: String?
    let focusOnly: Bool
    let command: GraphCanvasCommand
    let select: (String?) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeUIView(context: Context) -> RelationshipGraphCanvasView { RelationshipGraphCanvasView() }
    func updateUIView(_ view: RelationshipGraphCanvasView, context: Context) {
        view.onSelect = select
        view.configure(snapshot: snapshot, selectedID: selectedID, focusOnly: focusOnly, dark: colorScheme == .dark, reduceMotion: reduceMotion)
        view.perform(command)
    }
    static func dismantleUIView(_ view: RelationshipGraphCanvasView, coordinator: ()) { view.stop() }
}

struct GraphCanvasCommand: Equatable {
    enum Action { case fit, zoomIn, zoomOut }
    var id = 0
    var action: Action = .fit
}

private final class GraphFrameTarget: NSObject {
    weak var canvas: RelationshipGraphCanvasView?
    @objc func tick() { canvas?.tick() }
}

/// UIKit owns gestures and drawing so dragging does not rebuild SwiftUI's view tree.
final class RelationshipGraphCanvasView: UIView, UIGestureRecognizerDelegate {
    private(set) var layout = RelationshipGraphLayout()
    private(set) var viewport = GraphViewport()
    private var nodes: [RelationshipGraphNode] = []
    private var links: [GraphLink] = []
    private var unreviewed = Set<GraphLink>()
    private var selectedID: String?
    private var neighbors = Set<String>()
    private var focusOnly = false
    private var dark = false
    private var reduceMotion = false
    private var frameLink: CADisplayLink?
    private let frameTarget = GraphFrameTarget()
    private var ticksLeft = 0
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
        frameTarget.canvas = self
        NotificationCenter.default.addObserver(self, selector: #selector(pause), name: UIApplication.willResignActiveNotification, object: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { NotificationCenter.default.removeObserver(self) }

    func configure(snapshot: RelationshipGraphSnapshot, selectedID: String?, focusOnly: Bool, dark: Bool, reduceMotion: Bool) {
        let newLinks = snapshot.links
        let changed = nodes != snapshot.nodes || links != newLinks
        self.dark = dark; self.reduceMotion = reduceMotion
        self.selectedID = selectedID; self.focusOnly = focusOnly
        neighbors = selectedID.map { snapshot.neighborhood(of: $0) } ?? []
        unreviewed = Set(snapshot.edges.filter { $0.reviewStatus != "confirmed" }.map { GraphLink($0.subjectId, $0.objectId) })
        if changed {
            nodes = snapshot.nodes; links = newLinks
            layout.update(nodes: nodes, links: links)
            // A settled first frame makes the map immediately legible, even in Reduce Motion.
            for _ in 0..<120 { layout.step() }
            if needsInitialFit && !bounds.isEmpty { fit(); needsInitialFit = false }
            wake()
        } else if reduceMotion { stop() }
        refreshAccessibility()
        setNeedsDisplay()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if needsInitialFit, !bounds.isEmpty, !nodes.isEmpty { fit(); needsInitialFit = false }
        refreshAccessibility()
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { stop() }
    }
    @objc private func pause() { stop() }
    func stop() { frameLink?.invalidate(); frameLink = nil; ticksLeft = 0 }
    private func wake() {
        guard !reduceMotion, window != nil else { return }
        ticksLeft = 100
        if frameLink == nil {
            let link = CADisplayLink(target: frameTarget, selector: #selector(GraphFrameTarget.tick))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
            link.add(to: .main, forMode: .common)
            frameLink = link
        }
    }
    func tick() {
        guard window != nil, ticksLeft > 0 else { stop(); return }
        let energy = layout.step(pinned: dragID)
        ticksLeft -= 1
        setNeedsDisplay()
        if (energy < 0.025 && dragID == nil) || ticksLeft == 0 { stop(); refreshAccessibility() }
    }
    func perform(_ command: GraphCanvasCommand) {
        guard lastCommand != command.id else { return }
        lastCommand = command.id
        switch command.action {
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
        dragID = hitNode(at: point)
        originalNodePosition = dragID.flatMap { points()[$0] }
        stop()
    }
    func drag(to point: CGPoint) {
        guard let start = dragStart else { return }
        if let id = dragID, let origin = originalNodePosition {
            layout.move(id: id, to: CGPoint(x: origin.x + (point.x - start.x) / viewport.scale, y: origin.y + (point.y - start.y) / viewport.scale))
            wake()
        } else {
            viewport.offset = CGPoint(x: originalViewport.offset.x + point.x - start.x, y: originalViewport.offset.y + point.y - start.y)
        }
        setNeedsDisplay()
    }
    func endDrag(cancelled: Bool) {
        guard dragStart != nil else { return }
        if cancelled { stop() }
        let movedNode = dragID != nil
        if cancelled {
            if let id = dragID, let point = originalNodePosition { layout.move(id: id, to: point) }
            else { viewport = originalViewport }
        }
        dragID = nil; dragStart = nil; originalNodePosition = nil
        refreshAccessibility(); setNeedsDisplay()
        if !cancelled && movedNode { wake() }
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
            stop(); originalViewport = viewport
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
        for link in links {
            guard let a = positions[link.a], let b = positions[link.b] else { continue }
            let highlighted = selectedID == link.a || selectedID == link.b
            if focusOnly && selectedID != nil && !(neighbors.contains(link.a) && neighbors.contains(link.b)) { continue }
            let start = viewport.screen(a, size: bounds.size), end = viewport.screen(b, size: bounds.size)
            context.setStrokeColor((highlighted ? accent.withAlphaComponent(0.65) : ink.withAlphaComponent(selectedID == nil ? 0.16 : 0.06)).cgColor)
            context.setLineWidth(highlighted ? 1.4 : 0.7)
            context.setLineDash(phase: 0, lengths: unreviewed.contains(link) ? [3, 4] : [])
            context.move(to: start); context.addLine(to: end); context.strokePath()
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
            let relevant = selectedID == nil || neighbors.contains(node.id)
            let radius: CGFloat = selected ? 11 : min(9, 4 + sqrt(CGFloat(degrees[node.id] ?? 0)))
            let tint = node.kind == "person" ? accent : Self.tint(for: node.kind)
            if selected {
                context.setFillColor(accent.withAlphaComponent(0.13).cgColor)
                context.fillEllipse(in: CGRect(x: point.x - 21, y: point.y - 21, width: 42, height: 42))
            }
            context.setFillColor(tint.withAlphaComponent(relevant ? 1 : 0.22).cgColor)
            context.fillEllipse(in: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2))
            guard selected || neighbors.contains(node.id) || (selectedID == nil && (viewport.scale > 0.5 || nodes.count < 35)) else { continue }
            let text = node.label as NSString
            let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: selected ? 14 : 11, weight: selected ? .semibold : .regular), .foregroundColor: ink.withAlphaComponent(relevant ? 1 : 0.4)]
            let measured = text.size(withAttributes: attributes)
            let width = min(150, measured.width)
            let candidates = [
                CGRect(x: point.x - width / 2, y: point.y + radius + 7, width: width, height: measured.height),
                CGRect(x: point.x - width / 2, y: point.y - radius - 7 - measured.height, width: width, height: measured.height),
                CGRect(x: point.x + radius + 8, y: point.y - measured.height / 2, width: width, height: measured.height),
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
    private func refreshAccessibility() {
        let positions = points()
        accessibilityElements = nodes.compactMap { node -> UIAccessibilityElement? in
            guard let position = positions[node.id], !focusOnly || selectedID == nil || neighbors.contains(node.id) else { return nil }
            let point = viewport.screen(position, size: bounds.size)
            guard bounds.contains(point) else { return nil }
            let element = GraphAccessibleNode(accessibilityContainer: self)
            element.accessibilityLabel = node.label
            element.accessibilityValue = node.kind.capitalized
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
