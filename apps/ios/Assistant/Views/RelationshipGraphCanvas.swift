import SwiftUI
import UIKit

struct RelationshipGraphCanvas: UIViewRepresentable {
    let snapshot: RelationshipGraphSnapshot
    let selectedID: String?
    var command = GraphCanvasCommand()
    /// A still, framed thumbnail with no gestures — the Memory home's preview.
    var interactive = true
    /// Screen space the floating controls cover. A selected item is kept
    /// clear of them, and the camera frames the map inside what is left.
    var insets = UIEdgeInsets.zero
    var select: (String?) -> Void = { _ in }
    /// Long-press one item and let go over another.
    var connect: ((String, String) -> Void)? = nil
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeUIView(context: Context) -> RelationshipGraphCanvasView {
        RelationshipGraphCanvasView(interactive: interactive)
    }

    func updateUIView(_ view: RelationshipGraphCanvasView, context: Context) {
        view.onSelect = select
        view.onConnect = connect
        view.insets = insets
        view.configure(snapshot: snapshot, selectedID: selectedID, dark: colorScheme == .dark, reduceMotion: reduceMotion)
        view.perform(command)
    }
}

struct GraphCanvasCommand: Equatable {
    enum Action: Equatable {
        case fit, zoomIn, zoomOut
        /// Fly the camera to an item and bring it close enough to read.
        case reveal(String)
    }
    var id = 0
    var action: Action = .fit
}

/// The relationship map, drawn and driven by UIKit so that a frame of physics
/// or a finger's movement never rebuilds SwiftUI's view tree.
///
/// It behaves the way Obsidian's graph does, because that is the model the
/// owner already has in their hands: the map is alive and finds its own
/// shape; a node can be picked up and its neighbours follow it; one finger
/// pans with momentum, two pinch; names fade in as you zoom, hubs first, and
/// closer still each item says what it is and each line says what it means.
/// What it adds is connecting: long-press an item, drag to another, let go.
final class RelationshipGraphCanvasView: UIView, UIGestureRecognizerDelegate {
    /// Canvas labels are drawn into a CGContext, so they get none of SwiftUI's
    /// Dynamic Type scaling for free. Scaling them by hand is what keeps this
    /// screen legible for someone who has turned the system text size up.
    /// Capped, because past roughly double a name collides with its
    /// neighbours rather than helping.
    static func scaledFont(_ size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
        let base = UIFont.systemFont(ofSize: size, weight: weight)
        return UIFontMetrics(forTextStyle: .caption1).scaledFont(for: base, maximumPointSize: size * 2)
    }

    /// How much a node's name wants to be shown: a hub earns its name from
    /// further out than a leaf does, which is what lets a zoomed-out map be
    /// read by its landmarks.
    static func importance(degree: Int) -> CGFloat { 1 + 0.55 * log2(1 + CGFloat(degree)) }

    /// 0 → hidden, 1 → fully drawn. Names fade rather than pop, so zooming
    /// feels continuous instead of like a switch being flipped.
    static func labelOpacity(scale: CGFloat, degree: Int) -> CGFloat {
        min(1, max(0, (scale * importance(degree: degree) - 0.8) / 0.35))
    }

    /// World-space radius: node size carries how connected an item is.
    static func worldRadius(degree: Int) -> CGFloat { min(18, 5 + 2.2 * sqrt(CGFloat(degree))) }

    /// Zoom thresholds at which the map starts saying more.
    static let detailScale: CGFloat = 1.6
    static let allEdgePhrasesScale: CGFloat = 1.9

    /// Which nodes the last paint actually put a name on. The canvas has far
    /// more nodes than room for names, so which ones get one is a real
    /// decision with a real failure mode — an overview where nothing is
    /// named. Recording it is what lets that be asserted.
    private(set) var namedNodeIDs: Set<String> = []

    private(set) var layout = RelationshipGraphLayout()
    private(set) var viewport = GraphViewport()
    private(set) var selectedID: String?
    private let interactive: Bool
    private var nodes: [RelationshipGraphNode] = []
    private var nodeByID: [String: RelationshipGraphNode] = [:]
    private var links: [GraphLink] = []
    private var degrees: [String: Int] = [:]
    private var unreviewed = Set<GraphLink>()
    private var neighbors = Set<String>()
    private var dark = false
    private var reduceMotion = false
    private var previousSize = CGSize.zero
    private var edgeLabels: [GraphLink: String] = [:]
    private var edgeDirections: [GraphLink: String] = [:]
    private var lastCommand = -1
    private var needsInitialFit = true
    /// Until the owner moves the map, it keeps itself framed as the controls
    /// around it settle; after that, the camera is theirs.
    var insets = UIEdgeInsets.zero {
        didSet {
            guard oldValue != insets, !nodes.isEmpty, !bounds.isEmpty else { return }
            if !cameraTouched { fit(animated: false) }
            else if let selectedID { keepVisible(selectedID) }
        }
    }
    private var cameraTouched = false
    var onSelect: ((String?) -> Void)?
    var onConnect: ((String, String) -> Void)?

    // Gesture state.
    private(set) var dragID: String?
    private var dragStart: CGPoint?
    private var dragGrabOffset = CGPoint.zero
    private var originalNodePosition: CGPoint?
    private var originalViewport = GraphViewport()
    private var pinchStartScale: CGFloat = 1
    private var pinchWorldAnchor = CGPoint.zero
    private var pinching = false
    private var momentum = CGPoint.zero
    private var camera: CameraFlight?
    private(set) var connectSourceID: String?
    private(set) var connectTargetID: String?
    private var connectPoint: CGPoint?
    private var lastLabelIDs: Set<String> = []
    private var labelSizes: [String: CGSize] = [:]

    // Frame loop.
    private var displayLink: CADisplayLink?
    private var lastTick: CFTimeInterval = 0
    private let selectionFeedback = UISelectionFeedbackGenerator()
    private let impactFeedback = UIImpactFeedbackGenerator(style: .medium)

    private struct CameraFlight {
        let from: GraphViewport
        let to: GraphViewport
        let start: CFTimeInterval
        let duration: CFTimeInterval
    }

    init(interactive: Bool = true) {
        self.interactive = interactive
        super.init(frame: .zero)
        commonInit()
    }

    override init(frame: CGRect) {
        interactive = true
        super.init(frame: frame)
        commonInit()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func commonInit() {
        isOpaque = true
        contentMode = .redraw
        isMultipleTouchEnabled = true
        accessibilityIdentifier = "assistant.relationship.graph.canvas"
        guard interactive else {
            isUserInteractionEnabled = false
            isAccessibilityElement = false
            return
        }
        let pan = UIPanGestureRecognizer(target: self, action: #selector(pan(_:)))
        pan.maximumNumberOfTouches = 1
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinch(_:)))
        let tap = UITapGestureRecognizer(target: self, action: #selector(tap(_:)))
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        let press = UILongPressGestureRecognizer(target: self, action: #selector(longPress(_:)))
        press.minimumPressDuration = 0.32
        press.allowableMovement = 12
        // A finger that moves straight away pans; one that holds still first
        // picks up a thread to connect. Waiting for the press to fail costs
        // the pan only its first 12 points.
        pan.require(toFail: press)
        tap.require(toFail: pan)
        for recognizer in [pan, pinch, press, tap, doubleTap] as [UIGestureRecognizer] {
            recognizer.delegate = self
            addGestureRecognizer(recognizer)
        }
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        // Pinch alongside a pan, so a second finger turns a drag into a zoom
        // without lifting the first.
        (gestureRecognizer is UIPinchGestureRecognizer && other is UIPanGestureRecognizer)
            || (gestureRecognizer is UIPanGestureRecognizer && other is UIPinchGestureRecognizer)
    }

    // MARK: - Configuration

    func configure(snapshot: RelationshipGraphSnapshot, selectedID: String?, dark: Bool, reduceMotion: Bool) {
        let newLinks = snapshot.links
        let changed = nodes != snapshot.nodes || links != newLinks
        let selectionChanged = self.selectedID != selectedID
        self.dark = dark
        self.reduceMotion = reduceMotion
        edgeLabels = [:]; edgeDirections = [:]
        let claims = Dictionary(grouping: snapshot.edges.filter { $0.reviewStatus != "rejected" },
                                by: { GraphLink($0.subjectId, $0.objectId) })
        for (link, edges) in claims {
            let statements = Set(edges.map { "\($0.subjectId)|\($0.predicate)|\($0.objectId)|\($0.validFrom ?? "")|\($0.validUntil ?? "")" })
            if statements.count == 1, let edge = edges.first {
                edgeLabels[link] = edge.presentation.label; edgeDirections[link] = edge.objectId
            } else { edgeLabels[link] = "\(statements.count) relationships" }
        }
        unreviewed = Set(snapshot.edges.filter { $0.reviewStatus != "confirmed" }.map { GraphLink($0.subjectId, $0.objectId) })
        if changed {
            nodes = snapshot.nodes
            nodeByID = Dictionary(nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            links = newLinks
            degrees = snapshot.degrees
            let firstLayout = layout.ids.isEmpty
            layout.update(nodes: nodes, links: links)
            if firstLayout || reduceMotion {
                // A cold start is run most of the way to rest before the
                // first frame, so the map opens already recognisable and then
                // eases into place, rather than exploding out of one point.
                // Reduce Motion runs it all the way.
                if reduceMotion { layout.settle() } else { for _ in 0..<150 where !layout.isSettled { layout.step() } }
                if firstLayout { needsInitialFit = true }
            }
            if needsInitialFit, !bounds.isEmpty { fit(animated: false); needsInitialFit = false }
        }
        self.selectedID = selectedID
        neighbors = selectedID.map { snapshot.neighborhood(of: $0) } ?? []
        if selectionChanged, let selectedID {
            // A selection brings up the card; the camera stops reframing
            // itself around the controls from here on.
            cameraTouched = true
            keepVisible(selectedID)
        }
        refreshAccessibility()
        setNeedsDisplay()
        startLoopIfNeeded()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Keep what is on screen where it is when the canvas changes size.
        if !previousSize.equalTo(.zero), previousSize != bounds.size {
            viewport.offset.x += (previousSize.width - bounds.width) / 2
            viewport.offset.y += (previousSize.height - bounds.height) / 2
        }
        previousSize = bounds.size
        if needsInitialFit, !bounds.isEmpty, !nodes.isEmpty { fit(animated: false); needsInitialFit = false }
        refreshAccessibility()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { stopLoop() } else { startLoopIfNeeded() }
    }

    func perform(_ command: GraphCanvasCommand) {
        guard lastCommand != command.id else { return }
        let first = lastCommand == -1
        lastCommand = command.id
        // The command a view is created with has already been honoured by the
        // initial fit; replaying it would throw away a restored position.
        if first && command.id == 0 { return }
        cameraTouched = true
        switch command.action {
        case .fit: fit(animated: true)
        case .zoomIn: zoom(to: viewport.scale * 1.5, anchor: focusCenter, animated: true)
        case .zoomOut: zoom(to: viewport.scale / 1.5, anchor: focusCenter, animated: true)
        case .reveal(let id): reveal(id)
        }
    }

    // MARK: - Camera

    /// The middle of the part of the canvas the controls leave uncovered.
    private var focusCenter: CGPoint {
        CGPoint(x: insets.left + (bounds.width - insets.left - insets.right) / 2,
                y: insets.top + (bounds.height - insets.top - insets.bottom) / 2)
    }

    private func fit(animated: Bool) {
        var target = GraphViewport()
        let area = CGSize(width: max(80, bounds.width - insets.left - insets.right),
                          height: max(80, bounds.height - insets.top - insets.bottom))
        // A thumbnail names only its hubs, so it can use its whole frame.
        target.fit(layout.positions, size: area,
                   margin: interactive ? CGSize(width: 100, height: 120) : CGSize(width: 48, height: 36))
        // `fit` centres on the canvas; shift it to the uncovered area's centre.
        target.offset.x += focusCenter.x - bounds.midX
        target.offset.y += focusCenter.y - bounds.midY
        fly(to: target, animated: animated)
    }

    func zoom(to scale: CGFloat, anchor: CGPoint, animated: Bool = false) {
        var target = viewport
        target.zoom(to: scale, anchor: anchor, size: bounds.size)
        fly(to: target, animated: animated)
    }

    private func reveal(_ id: String) {
        guard let position = position(of: id) else { return }
        var target = viewport
        target.scale = min(4, max(viewport.scale, 1.15))
        target.offset = CGPoint(x: focusCenter.x - bounds.midX - position.x * target.scale,
                                y: focusCenter.y - bounds.midY - position.y * target.scale)
        fly(to: target, animated: true)
    }

    /// A tapped item that would land under the controls is slid into view,
    /// keeping the zoom — the owner chose the scale, the canvas only makes
    /// room.
    private func keepVisible(_ id: String) {
        guard !bounds.isEmpty, let position = position(of: id) else { return }
        let point = viewport.screen(position, size: bounds.size)
        let safe = bounds.inset(by: insets).insetBy(dx: 24, dy: 24)
        guard !safe.isEmpty, !safe.contains(point) else { return }
        var target = viewport
        target.offset.x += min(max(point.x, safe.minX), safe.maxX) - point.x
        target.offset.y += min(max(point.y, safe.minY), safe.maxY) - point.y
        fly(to: target, animated: true)
    }

    private func fly(to target: GraphViewport, animated: Bool) {
        momentum = .zero
        if !animated || reduceMotion || window == nil {
            camera = nil
            viewport = target
            refreshAccessibility()
            setNeedsDisplay()
            return
        }
        camera = CameraFlight(from: viewport, to: target, start: CACurrentMediaTime(), duration: 0.42)
        startLoopIfNeeded()
    }

    private func position(of id: String) -> CGPoint? {
        guard let index = layout.ids.firstIndex(of: id) else { return nil }
        return layout.positions[index]
    }

    private func points() -> [String: CGPoint] { Dictionary(uniqueKeysWithValues: zip(layout.ids, layout.positions)) }

    private func screenRadius(for id: String) -> CGFloat {
        let world = Self.worldRadius(degree: degrees[id] ?? 0)
        return min(26, max(2.5, world * viewport.scale))
    }

    func hitNode(at point: CGPoint, slop: CGFloat = 20, excluding: String? = nil) -> String? {
        var closest: (String, CGFloat)?
        for (id, position) in zip(layout.ids, layout.positions) where id != excluding {
            let screen = viewport.screen(position, size: bounds.size)
            let distance = hypot(screen.x - point.x, screen.y - point.y)
            let reach = max(22, screenRadius(for: id) + slop)
            if distance <= reach && (closest == nil || distance < closest!.1) { closest = (id, distance) }
        }
        return closest?.0
    }

    // MARK: - Frame loop

    private var needsFrames: Bool {
        (!layout.isSettled && !reduceMotion) || camera != nil
            || hypot(momentum.x, momentum.y) > 4 || connectSourceID != nil
    }

    private func startLoopIfNeeded() {
        guard displayLink == nil, window != nil, needsFrames else { return }
        let link = CADisplayLink(target: FrameTarget(self), selector: #selector(FrameTarget.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 60)
        link.add(to: .main, forMode: .common)
        displayLink = link
        lastTick = CACurrentMediaTime()
    }

    private func stopLoop() {
        displayLink?.invalidate()
        displayLink = nil
    }

    fileprivate func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        let dt = min(1.0 / 20, max(1.0 / 240, now - lastTick))
        lastTick = now
        if !layout.isSettled && !reduceMotion {
            layout.step(pinned: dragID)
            if !interactive { fit(animated: false) }
        }
        if let flight = camera {
            let t = min(1, (now - flight.start) / flight.duration)
            let eased = CGFloat(t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2)
            viewport = GraphViewport(
                scale: flight.from.scale + (flight.to.scale - flight.from.scale) * eased,
                offset: CGPoint(x: flight.from.offset.x + (flight.to.offset.x - flight.from.offset.x) * eased,
                                y: flight.from.offset.y + (flight.to.offset.y - flight.from.offset.y) * eased))
            if t >= 1 { camera = nil }
        }
        if hypot(momentum.x, momentum.y) > 4 {
            viewport.offset.x += momentum.x * CGFloat(dt)
            viewport.offset.y += momentum.y * CGFloat(dt)
            // Exponential friction, frame-rate independent.
            let friction = CGFloat(pow(0.0025, dt))
            momentum.x *= friction; momentum.y *= friction
        }
        if let point = connectPoint, connectSourceID != nil { edgePan(toward: point, dt: dt) }
        setNeedsDisplay()
        if !needsFrames {
            momentum = .zero
            stopLoop()
            refreshAccessibility()
        }
    }

    /// While a connection is being drawn, holding the finger near an edge
    /// scrolls the map, so the other end can be anywhere.
    private func edgePan(toward point: CGPoint, dt: CFTimeInterval) {
        let margin: CGFloat = 44, speed: CGFloat = 420
        var push = CGPoint.zero
        if point.x < margin { push.x = (margin - point.x) / margin }
        if point.x > bounds.width - margin { push.x = -(point.x - bounds.width + margin) / margin }
        if point.y < insets.top + margin { push.y = (insets.top + margin - point.y) / margin }
        if point.y > bounds.height - margin { push.y = -(point.y - bounds.height + margin) / margin }
        guard push != .zero else { return }
        viewport.offset.x += push.x * speed * CGFloat(dt)
        viewport.offset.y += push.y * speed * CGFloat(dt)
        updateConnectTarget(at: point)
    }

    // MARK: - Gestures

    @objc private func tap(_ gesture: UITapGestureRecognizer) {
        momentum = .zero
        onSelect?(hitNode(at: gesture.location(in: self)))
    }

    @objc private func doubleTap(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        cameraTouched = true
        if let id = hitNode(at: point) {
            onSelect?(id)
            guard let position = position(of: id) else { return }
            var target = viewport
            target.scale = min(4, max(viewport.scale * 1.6, 1.3))
            target.offset = CGPoint(x: focusCenter.x - bounds.midX - position.x * target.scale,
                                    y: focusCenter.y - bounds.midY - position.y * target.scale)
            fly(to: target, animated: true)
        } else {
            zoom(to: viewport.scale * 1.8, anchor: point, animated: true)
        }
    }

    /// Starts a one-finger drag: on a node it picks the node up, anywhere else
    /// it grabs the canvas.
    func beginDrag(at point: CGPoint) {
        cameraTouched = true
        camera = nil; momentum = .zero
        dragStart = point; originalViewport = viewport
        dragID = hitNode(at: point, slop: 12)
        originalNodePosition = dragID.flatMap { position(of: $0) }
        if let origin = originalNodePosition {
            let world = viewport.world(point, size: bounds.size)
            dragGrabOffset = CGPoint(x: origin.x - world.x, y: origin.y - world.y)
            // Warm enough that neighbours follow the dragged node, cool enough
            // that the rest of the map does not churn.
            layout.hold(0.28)
            startLoopIfNeeded()
        }
    }

    func drag(to point: CGPoint) {
        guard dragStart != nil, !pinching else { return }
        if let id = dragID {
            let world = viewport.world(point, size: bounds.size)
            layout.move(id: id, to: CGPoint(x: world.x + dragGrabOffset.x, y: world.y + dragGrabOffset.y))
        } else if let start = dragStart {
            viewport.offset = CGPoint(x: originalViewport.offset.x + point.x - start.x,
                                      y: originalViewport.offset.y + point.y - start.y)
        }
        setNeedsDisplay()
    }

    func endDrag(cancelled: Bool, velocity: CGPoint = .zero) {
        guard dragStart != nil else { return }
        if let id = dragID {
            if cancelled, let point = originalNodePosition { layout.move(id: id, to: point) }
            layout.hold(0)
        } else if cancelled {
            viewport = originalViewport
        } else if !reduceMotion {
            momentum = velocity
        }
        dragID = nil; dragStart = nil; originalNodePosition = nil
        startLoopIfNeeded()
        refreshAccessibility(); setNeedsDisplay()
    }

    @objc private func pan(_ gesture: UIPanGestureRecognizer) {
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            let translation = gesture.translation(in: self)
            beginDrag(at: CGPoint(x: point.x - translation.x, y: point.y - translation.y)); drag(to: point)
        case .changed: drag(to: point)
        case .ended: endDrag(cancelled: false, velocity: gesture.velocity(in: self))
        case .cancelled, .failed: endDrag(cancelled: true)
        default: break
        }
    }

    @objc private func pinch(_ gesture: UIPinchGestureRecognizer) {
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            cameraTouched = true
            camera = nil; momentum = .zero
            pinching = true
            // A node being dragged stays where the second finger found it.
            if dragID != nil { endDrag(cancelled: false) }
            pinchStartScale = viewport.scale
            pinchWorldAnchor = viewport.world(point, size: bounds.size)
        case .changed, .ended:
            viewport.scale = min(4, max(0.15, pinchStartScale * gesture.scale))
            // The point under the fingers stays under the fingers, so moving
            // them while pinching pans as well.
            viewport.offset = CGPoint(x: point.x - bounds.midX - pinchWorldAnchor.x * viewport.scale,
                                      y: point.y - bounds.midY - pinchWorldAnchor.y * viewport.scale)
        default: break
        }
        if gesture.state == .ended || gesture.state == .cancelled || gesture.state == .failed {
            pinching = false
            // Re-anchor any pan still in progress so it continues from here.
            if dragStart != nil { dragStart = point; originalViewport = viewport }
            refreshAccessibility()
        }
        setNeedsDisplay()
    }

    @objc private func longPress(_ gesture: UILongPressGestureRecognizer) {
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            if onConnect != nil, let source = hitNode(at: point, slop: 12) {
                beginConnect(from: source, at: point)
            } else {
                // Not on an item: a held finger is just a slow pan.
                beginDrag(at: point)
            }
        case .changed:
            if connectSourceID != nil { moveConnect(to: point) } else { drag(to: point) }
        case .ended:
            if connectSourceID != nil { endConnect(cancelled: false) } else { endDrag(cancelled: false) }
        case .cancelled, .failed:
            if connectSourceID != nil { endConnect(cancelled: true) } else { endDrag(cancelled: true) }
        default: break
        }
    }

    func beginConnect(from source: String, at point: CGPoint) {
        camera = nil; momentum = .zero
        connectSourceID = source
        connectPoint = point
        connectTargetID = nil
        impactFeedback.impactOccurred()
        selectionFeedback.prepare()
        startLoopIfNeeded()
        setNeedsDisplay()
    }

    func moveConnect(to point: CGPoint) {
        connectPoint = point
        updateConnectTarget(at: point)
        setNeedsDisplay()
    }

    private func updateConnectTarget(at point: CGPoint) {
        let target = hitNode(at: point, slop: 26, excluding: connectSourceID)
        if target != connectTargetID {
            connectTargetID = target
            if target != nil { selectionFeedback.selectionChanged() }
        }
    }

    func endConnect(cancelled: Bool) {
        let source = connectSourceID, target = connectTargetID
        connectSourceID = nil; connectTargetID = nil; connectPoint = nil
        setNeedsDisplay()
        if !cancelled, let source, let target {
            impactFeedback.impactOccurred(intensity: 0.7)
            onConnect?(source, target)
        }
    }

    // MARK: - Drawing

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let scheme: ColorScheme = dark ? .dark : .light
        let canvas = UIColor(AssistantTheme.canvas(for: scheme))
        let ink = UIColor(AssistantTheme.ink(for: scheme))
        let muted = UIColor(AssistantTheme.inkMuted(for: scheme))
        let accent = UIColor(AssistantTheme.accent(for: scheme))
        canvas.setFill(); context.fill(bounds)
        let positions = points()
        let scale = viewport.scale
        let hasSelection = selectedID != nil
        let visibleArea = bounds.insetBy(dx: -60, dy: -40)
        func screen(_ id: String) -> CGPoint? { positions[id].map { viewport.screen($0, size: bounds.size) } }

        // Lines first, underneath everything.
        context.setLineCap(.round)
        var highlightedLinks: [GraphLink] = []
        for link in links {
            guard let start = screen(link.a), let end = screen(link.b) else { continue }
            let lineBox = CGRect(x: min(start.x, end.x), y: min(start.y, end.y),
                                 width: abs(start.x - end.x) + 1, height: abs(start.y - end.y) + 1)
            guard lineBox.intersects(visibleArea) else { continue }
            let highlighted = hasSelection && (link.a == selectedID || link.b == selectedID)
            if highlighted { highlightedLinks.append(link) }
            let alpha: CGFloat = highlighted ? 0.75 : hasSelection ? 0.06 : (dark ? 0.26 : 0.2)
            context.setStrokeColor((highlighted ? accent : ink).withAlphaComponent(alpha).cgColor)
            context.setLineWidth((highlighted ? 1.6 : 0.8) * min(1.5, max(0.8, sqrt(scale))))
            context.setLineDash(phase: 0, lengths: unreviewed.contains(link) ? [3, 4] : [])
            context.move(to: start); context.addLine(to: end); context.strokePath()
            // Direction is carried by an arrowhead in the recorded direction —
            // on the selection's lines once they can be told apart, and on
            // every line once the map is close enough to read them.
            if (highlighted && scale >= 0.55) || scale >= 1.4, let target = edgeDirections[link] {
                let tip = target == link.b ? end : start, tail = target == link.b ? start : end
                let angle = atan2(tip.y - tail.y, tip.x - tail.x)
                let inset = screenRadius(for: target) + 3
                let arrow = CGPoint(x: tip.x - cos(angle) * inset, y: tip.y - sin(angle) * inset)
                let size: CGFloat = highlighted ? 7 : 5
                context.setLineDash(phase: 0, lengths: [])
                context.move(to: CGPoint(x: arrow.x - cos(angle - 0.5) * size, y: arrow.y - sin(angle - 0.5) * size))
                context.addLine(to: arrow)
                context.addLine(to: CGPoint(x: arrow.x - cos(angle + 0.5) * size, y: arrow.y - sin(angle + 0.5) * size))
                context.strokePath()
            }
        }
        context.setLineDash(phase: 0, lengths: [])

        // The thread being drawn to make a new connection.
        if let source = connectSourceID, let from = screen(source), let finger = connectPoint {
            let to = connectTargetID.flatMap(screen) ?? finger
            context.setStrokeColor(accent.cgColor)
            context.setLineWidth(2.2)
            context.setLineDash(phase: 0, lengths: connectTargetID == nil ? [6, 5] : [])
            context.move(to: from); context.addLine(to: to); context.strokePath()
            context.setLineDash(phase: 0, lengths: [])
            if connectTargetID == nil {
                context.setFillColor(accent.withAlphaComponent(0.25).cgColor)
                context.fillEllipse(in: CGRect(x: finger.x - 14, y: finger.y - 14, width: 28, height: 28))
            }
        }

        // Names are handed out in this order, and the canvas runs out of room
        // long before it runs out of nodes, so the order decides which names
        // the owner gets: the selection, its neighbours, names already showing
        // (so they do not flicker as the map drifts), then the biggest hubs.
        let rank = { (id: String) -> Int in
            if id == self.connectSourceID || id == self.connectTargetID || id == self.selectedID { return 0 }
            if self.neighbors.contains(id) { return 1 }
            if self.lastLabelIDs.contains(id) { return 2 }
            return 3
        }
        let ordered = nodes.sorted {
            let r0 = rank($0.id), r1 = rank($1.id)
            if r0 != r1 { return r0 < r1 }
            let d0 = degrees[$0.id] ?? 0, d1 = degrees[$1.id] ?? 0
            return d0 != d1 ? d0 > d1 : $0.id < $1.id
        }

        // Every dot before any name, so no dot is ever painted over a name.
        var nodeBounds: [CGRect] = []
        for node in ordered.reversed() {
            guard let point = screen(node.id), visibleArea.contains(point) else { continue }
            let radius = screenRadius(for: node.id)
            let isSelected = node.id == selectedID
            let isTarget = node.id == connectTargetID || node.id == connectSourceID
            let relevant = !hasSelection || neighbors.contains(node.id) || isTarget
            if isSelected || isTarget {
                context.setFillColor(accent.withAlphaComponent(isTarget ? 0.28 : 0.16).cgColor)
                let halo = radius + (isTarget ? 12 : 9)
                context.fillEllipse(in: CGRect(x: point.x - halo, y: point.y - halo, width: halo * 2, height: halo * 2))
            }
            let tint = Self.tint(for: node.kind, accent: accent)
            context.setFillColor(tint.withAlphaComponent(relevant ? 1 : 0.18).cgColor)
            context.fillEllipse(in: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2))
            nodeBounds.append(CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2))
        }

        var occupied: [CGRect] = []
        var named: Set<String> = []
        // A ration for the zoomed-out map. Fading alone would still let a
        // two-hundred-item overview wear forty names, and nobody reads that.
        var looseNamesLeft = scale < 0.6 ? 18 : 60
        let showDetail = scale >= Self.detailScale
        for (place, node) in ordered.enumerated() {
            guard let point = screen(node.id), bounds.insetBy(dx: 2, dy: 2).contains(point) else { continue }
            let degree = degrees[node.id] ?? 0
            let isSelected = node.id == selectedID
            let isConnectEnd = node.id == connectSourceID || node.id == connectTargetID
            let isNeighbor = hasSelection && neighbors.contains(node.id)
            let mustName = isSelected || isConnectEnd || isNeighbor || (!hasSelection && place < 3)
            var opacity = mustName ? 1 : Self.labelOpacity(scale: scale, degree: degree)
            if hasSelection && !isNeighbor && !isSelected && !isConnectEnd { opacity *= 0.35 }
            guard opacity > 0.04 else { continue }
            guard mustName || looseNamesLeft > 0 else { continue }

            let font = Self.scaledFont(isSelected || isConnectEnd ? 14 : 12, weight: isSelected || isConnectEnd ? .semibold : .medium)
            let title = node.label as NSString
            let titleAttributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink.withAlphaComponent(opacity)]
            let key = "\(node.id)|\(node.label)|\(font.pointSize)"
            let measured = labelSizes[key] ?? title.size(withAttributes: titleAttributes)
            labelSizes[key] = measured
            let width = min(isSelected ? 200 : 150, ceil(measured.width))
            var subtitle: NSString?
            var subtitleAttributes: [NSAttributedString.Key: Any] = [:]
            var height = ceil(measured.height)
            if showDetail {
                let links = degree == 1 ? "1 link" : "\(degree) links"
                subtitle = "\(node.kind.sentenceCaseIdentifier) · \(links)" as NSString
                subtitleAttributes = [.font: Self.scaledFont(10), .foregroundColor: muted.withAlphaComponent(opacity)]
                height += ceil(Self.scaledFont(10).lineHeight)
            }
            let boxWidth = max(width, subtitle.map { min(150, ceil($0.size(withAttributes: subtitleAttributes).width)) } ?? 0)
            let radius = screenRadius(for: node.id)
            func inside(_ rect: CGRect) -> CGRect {
                var shifted = rect
                shifted.origin.x = min(max(4, rect.origin.x), max(4, bounds.width - rect.width - 4))
                shifted.origin.y = min(max(2, rect.origin.y), max(2, bounds.height - rect.height - 2))
                return shifted
            }
            let candidates = [
                CGRect(x: point.x - boxWidth / 2, y: point.y + radius + 4, width: boxWidth, height: height),
                CGRect(x: point.x - boxWidth / 2, y: point.y - radius - 4 - height, width: boxWidth, height: height),
                CGRect(x: point.x + radius + 6, y: point.y - height / 2, width: boxWidth, height: height),
                CGRect(x: point.x - radius - 6 - boxWidth, y: point.y - height / 2, width: boxWidth, height: height),
            ].map(inside)
            func crowding(_ candidate: CGRect) -> CGFloat {
                let padded = candidate.insetBy(dx: -3, dy: -1)
                var total: CGFloat = 0
                for other in occupied {
                    let overlap = other.intersection(padded)
                    if !overlap.isNull { total += overlap.width * overlap.height }
                }
                for other in nodeBounds where other.intersects(padded) {
                    let overlap = other.intersection(padded)
                    total += overlap.width * overlap.height * 0.5
                }
                return total
            }
            let clear = candidates.first { crowding($0) == 0 }
            let fallback = mustName ? candidates.min(by: { crowding($0) < crowding($1) }) : nil
            guard let box = clear ?? fallback else { continue }
            if !mustName { looseNamesLeft -= 1 }
            named.insert(node.id)
            occupied.append(box)
            // An opaque backing: the placement avoids dots and names but not
            // lines, and a line through a word is what makes it unreadable.
            canvas.withAlphaComponent(min(1, opacity + 0.1)).setFill()
            context.addPath(UIBezierPath(roundedRect: box.insetBy(dx: -3, dy: -1), cornerRadius: 4).cgPath)
            context.fillPath()
            let paragraph = NSMutableParagraphStyle(); paragraph.alignment = .center; paragraph.lineBreakMode = .byTruncatingTail
            var centered = titleAttributes; centered[.paragraphStyle] = paragraph
            title.draw(with: CGRect(x: box.minX, y: box.minY, width: box.width, height: measured.height),
                       options: [.truncatesLastVisibleLine, .usesLineFragmentOrigin], attributes: centered, context: nil)
            if let subtitle {
                subtitleAttributes[.paragraphStyle] = paragraph
                subtitle.draw(with: CGRect(x: box.minX, y: box.minY + ceil(measured.height), width: box.width, height: height - ceil(measured.height)),
                              options: [.truncatesLastVisibleLine, .usesLineFragmentOrigin], attributes: subtitleAttributes, context: nil)
            }
        }
        namedNodeIDs = named
        lastLabelIDs = named

        // What each line means: the selection's lines once they are long
        // enough to carry words, every line once the map is close enough.
        let phraseLinks: [GraphLink]
        if scale >= Self.allEdgePhrasesScale { phraseLinks = highlightedLinks + links.filter { !highlightedLinks.contains($0) } }
        else if scale >= 0.85 { phraseLinks = highlightedLinks }
        else { phraseLinks = [] }
        let phraseAttributes: [NSAttributedString.Key: Any] = [.font: Self.scaledFont(10, weight: .medium), .foregroundColor: muted]
        for link in phraseLinks {
            guard let label = edgeLabels[link], let start = screen(link.a), let end = screen(link.b) else { continue }
            let length = hypot(end.x - start.x, end.y - start.y)
            guard length > 70 else { continue }
            let middle = CGPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2)
            guard bounds.contains(middle) else { continue }
            let text = label as NSString
            let size = text.size(withAttributes: phraseAttributes)
            let width = min(length - 30, min(120, ceil(size.width)))
            guard width > 24 else { continue }
            let box = CGRect(x: middle.x - width / 2, y: middle.y - size.height / 2, width: width, height: ceil(size.height))
            let padded = box.insetBy(dx: -3, dy: -1)
            guard !occupied.contains(where: { $0.intersects(padded) }),
                  !nodeBounds.contains(where: { $0.intersects(padded) }) else { continue }
            occupied.append(padded)
            canvas.setFill()
            context.addPath(UIBezierPath(roundedRect: padded, cornerRadius: 4).cgPath); context.fillPath()
            text.draw(with: box, options: [.truncatesLastVisibleLine, .usesLineFragmentOrigin], attributes: phraseAttributes, context: nil)
        }
    }

    static func tint(for kind: String, accent: UIColor) -> UIColor {
        switch kind {
        case "person": accent
        case "place": .systemTeal
        case "organization": .systemIndigo
        case "project": .systemOrange
        case "event": .systemPurple
        default: .systemGray
        }
    }

    // MARK: - Accessibility

    /// How this node connects, in words. The canvas draws a relationship as a
    /// line and its review status as a dash, so without this a VoiceOver user
    /// could hear every name and still learn nothing about how two relate.
    /// Bounded, because an announcement that recites forty edges is its own
    /// kind of unusable.
    private func connectionSummary(for id: String, names: [String: String], linksByID: [String: [GraphLink]]) -> String {
        let touching = linksByID[id] ?? []
        let described = touching.prefix(6).compactMap { link -> String? in
            guard let otherID = link.other(than: id), let other = names[otherID] else { return nil }
            let relation = edgeLabels[link] ?? "connected"
            let status = unreviewed.contains(link) ? "needs review" : "confirmed"
            return "\(relation) \(other), \(status)"
        }
        guard !described.isEmpty else { return "No recorded connections" }
        let more = touching.count > described.count ? ", and \(touching.count - described.count) more" : ""
        return described.joined(separator: "; ") + more
    }

    private func refreshAccessibility() {
        guard interactive else { accessibilityElements = nil; return }
        let positions = points()
        let names = Dictionary(nodes.map { ($0.id, $0.label) }, uniquingKeysWith: { first, _ in first })
        var linksByID: [String: [GraphLink]] = [:]
        for link in links {
            linksByID[link.a, default: []].append(link)
            if link.b != link.a { linksByID[link.b, default: []].append(link) }
        }
        accessibilityElements = nodes.compactMap { node -> UIAccessibilityElement? in
            guard let position = positions[node.id] else { return nil }
            let point = viewport.screen(position, size: bounds.size)
            guard bounds.contains(point) else { return nil }
            let element = GraphAccessibleNode(accessibilityContainer: self)
            element.accessibilityLabel = node.label
            element.accessibilityValue = "\(node.kind.sentenceCaseIdentifier). \(connectionSummary(for: node.id, names: names, linksByID: linksByID))"
            element.accessibilityHint = "Select to see its connections"
            element.accessibilityTraits = node.id == selectedID ? [.button, .selected] : [.button]
            element.accessibilityFrameInContainerSpace = CGRect(x: point.x - 22, y: point.y - 22, width: 44, height: 44)
            element.activate = { [weak self] in self?.onSelect?(node.id) }
            return element
        }
    }
}

/// CADisplayLink retains its target; this keeps it from retaining the view.
private final class FrameTarget {
    weak var view: RelationshipGraphCanvasView?
    init(_ view: RelationshipGraphCanvasView) { self.view = view }
    @objc func tick(_ link: CADisplayLink) {
        guard let view else { link.invalidate(); return }
        view.tick(link)
    }
}

private final class GraphAccessibleNode: UIAccessibilityElement {
    var activate: (() -> Void)?
    override func accessibilityActivate() -> Bool { activate?(); return true }
}
