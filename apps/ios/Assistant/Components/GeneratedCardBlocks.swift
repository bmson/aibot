import Charts
import MapKit
import SwiftUI

/// The layout blocks a generated card gained beyond its first seven
/// (docs/generative-ui.md). Every value is drawn as the composer lifted it
/// out of the evidence. The only arithmetic here — a bar's fraction, a
/// countdown, a chart's scale — is this code's, done over grounded figures;
/// the model never computes anything a card shows.
///
/// A sensitive fact stays behind its reveal control in the blocks that show
/// text, and is left out of the ones that would draw it (a bar, a pin).
struct GeneratedCardBlockView: View {
    let block: MessageResponseCard.GeneratedBlock
    let facts: [String: MessageResponseCard.GeneratedFact]
    let cardId: String
    /// Facts another block on this card already shows — a journey's clocks —
    /// so a countdown to the same moment need not repeat it.
    var shownElsewhere: Set<String> = []
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        switch block.type {
        case "metrics": metrics
        case "journey": journey
        case "progress": progress
        case "stages": stages
        case "countdown": countdown
        case "table": table
        case "chart": chart
        case "checklist": GeneratedChecklist(items: ids("factIds").compactMap { facts[$0] }, storageKey: "generated-checklist.\(cardId).\(block.id)")
        case "map": GeneratedPlacesMap(places: ids("placeFactIds").compactMap { facts[$0] }.filter { !$0.sensitive })
        default: EmptyView()
        }
    }

    private func ids(_ key: String) -> [String] { block.values[key]?.arrayStrings ?? [] }
    private func fact(_ key: String) -> MessageResponseCard.GeneratedFact? {
        block.values[key]?.string.flatMap { facts[$0] }
    }

    private var accent: Color { AssistantTheme.accent(for: colorScheme) }
    private var muted: Color { AssistantTheme.inkMuted(for: colorScheme) }
    private var ink: Color { AssistantTheme.ink(for: colorScheme) }

    @ViewBuilder
    private func value(_ fact: MessageResponseCard.GeneratedFact, font: Font = .callout.weight(.medium)) -> some View {
        if fact.sensitive {
            SensitiveCardValue(fact: fact)
        } else {
            Text(fact.value)
                .font(font)
                .foregroundStyle(ink)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private func caption(_ text: String) -> some View {
        CardEyebrow(text)
    }

    // MARK: - Metrics

    /// Two to four headline values abreast on one panel: Gate · Seat · Boards.
    /// Each column is the same width, so values line up card to card.
    private var metrics: some View {
        let items = ids("factIds").compactMap { facts[$0] }
        return LazyVGrid(
            columns: CardStyle.columns(min(items.count, 4), accessibility: dynamicTypeSize.isAccessibilitySize),
            alignment: .leading,
            spacing: CardStyle.partSpacing
        ) {
            ForEach(items) { item in
                VStack(alignment: .leading, spacing: CardStyle.labelSpacing) {
                    CardEyebrow(item.label)
                    value(item, font: CardStyle.figure)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(CardStyle.panelPadding)
        .background(
            AssistantTheme.sunken(for: colorScheme),
            in: RoundedRectangle(cornerRadius: CardStyle.panelRadius, style: .continuous)
        )
    }

    // MARK: - Journey

    /// A boarding pass: the codes are the anchors, each clock sits under its
    /// own end, and the line between carries the mode and the duration. A
    /// place written "Reykjavik (KEF)" splits into its code and its city; one
    /// with no code is shown whole.
    private var journey: some View {
        let mode = block.values["mode"]?.string ?? "flight"
        let from = fact("fromFact").map(JourneyPlace.init)
        let to = fact("toFact").map(JourneyPlace.init)
        return VStack(alignment: .leading, spacing: CardStyle.partSpacing) {
            Grid(horizontalSpacing: CardStyle.gutter, verticalSpacing: 2) {
                GridRow(alignment: .lastTextBaseline) {
                    placeName(from, alignment: .leading)
                    Color.clear.frame(height: 1).gridCellUnsizedAxes([.horizontal, .vertical])
                    placeName(to, alignment: .trailing)
                }
                GridRow(alignment: .center) {
                    placeCity(from, alignment: .leading)
                    route(mode: mode)
                    placeCity(to, alignment: .trailing)
                }
                GridRow(alignment: .firstTextBaseline) {
                    clock(fact("departFact"), alignment: .leading)
                    Color.clear.frame(height: 1).gridCellUnsizedAxes([.horizontal, .vertical])
                    clock(fact("arriveFact"), alignment: .trailing)
                }
            }
            if let status = fact("statusFact"), !status.sensitive {
                CardStatusPill(text: status.value)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private struct JourneyPlace {
        let code: String?
        let name: String
        let fact: MessageResponseCard.GeneratedFact

        init(_ fact: MessageResponseCard.GeneratedFact) {
            self.fact = fact
            let value = fact.value.trimmingCharacters(in: .whitespaces)
            if value.hasSuffix(")"), let open = value.lastIndex(of: "(") {
                let inner = value[value.index(after: open)..<value.index(before: value.endIndex)]
                let place = value[..<open].trimmingCharacters(in: .whitespaces)
                let isCode = (2...4).contains(inner.count) && inner.allSatisfy { $0.isUppercase || $0.isNumber }
                code = isCode ? String(inner) : nil
                name = isCode ? place : value
            } else {
                code = nil
                name = value
            }
        }
    }

    @ViewBuilder
    private func placeName(_ place: JourneyPlace?, alignment: HorizontalAlignment) -> some View {
        if let place {
            if place.fact.sensitive {
                SensitiveCardValue(fact: place.fact)
            } else {
                Text(place.code ?? place.name)
                    .font(place.code == nil ? .headline.weight(.semibold) : CardStyle.display)
                    .foregroundStyle(ink)
                    .lineLimit(place.code == nil ? 2 : 1)
                    .minimumScaleFactor(0.8)
                    .multilineTextAlignment(alignment == .leading ? .leading : .trailing)
                    .gridColumnAlignment(alignment == .leading ? .leading : .trailing)
                    .textSelection(.enabled)
            }
        } else {
            Color.clear.frame(height: 1)
        }
    }

    @ViewBuilder
    private func placeCity(_ place: JourneyPlace?, alignment: HorizontalAlignment) -> some View {
        if let place, place.code != nil, !place.fact.sensitive, !place.name.isEmpty {
            Text(place.name)
                .font(.caption)
                .foregroundStyle(muted)
                .lineLimit(1)
                .gridColumnAlignment(alignment == .leading ? .leading : .trailing)
        } else {
            Color.clear.frame(height: 1)
        }
    }

    private func route(mode: String) -> some View {
        HStack(spacing: 6) {
            line
            VStack(spacing: 2) {
                Image(systemName: Self.modeSymbol(mode))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(accent)
                if let duration = fact("durationFact"), !duration.sensitive {
                    Text(duration.value)
                        .font(.caption2.weight(.medium).monospacedDigit())
                        .foregroundStyle(muted)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            line
        }
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)
    }

    private var line: some View {
        Rectangle()
            .fill(accent.opacity(0.28))
            .frame(height: 1)
            .frame(minWidth: 12, maxWidth: .infinity)
    }

    @ViewBuilder
    private func clock(_ time: MessageResponseCard.GeneratedFact?, alignment: HorizontalAlignment) -> some View {
        let trailing = alignment == .trailing
        if let time {
            VStack(alignment: trailing ? .trailing : .leading, spacing: 1) {
                if time.sensitive {
                    SensitiveCardValue(fact: time)
                } else if let reading = GeneratedCardValue.clockAndDay(time.value) {
                    Text(reading.time)
                        .font(CardStyle.figure)
                        .foregroundStyle(ink)
                    Text(reading.day)
                        .font(.caption)
                        .foregroundStyle(muted)
                } else {
                    Text(time.value)
                        .font(CardStyle.value)
                        .foregroundStyle(ink)
                        .multilineTextAlignment(trailing ? .trailing : .leading)
                }
            }
            .padding(.top, 8)
            .gridColumnAlignment(trailing ? .trailing : .leading)
        } else {
            Color.clear.frame(height: 1)
        }
    }

    static func modeSymbol(_ mode: String) -> String {
        switch mode {
        case "train": "tram.fill"
        case "bus": "bus.fill"
        case "car": "car.fill"
        case "ferry": "ferry.fill"
        case "walk": "figure.walk"
        default: "airplane"
        }
    }

    // MARK: - Progress

    @ViewBuilder
    private var progress: some View {
        if let current = fact("valueFact"), !current.sensitive,
           let fraction = GeneratedCardValue.fraction(value: current.value, total: fact("totalFact")?.value) {
            let total = fact("totalFact")
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    CardEyebrow(fact("labelFact")?.value ?? current.label)
                    Spacer(minLength: 8)
                    Text(total.map { "\(current.value) / \($0.value)" } ?? current.value)
                        .font(CardStyle.value.monospacedDigit())
                        .foregroundStyle(ink)
                }
                // Drawn rather than a ProgressView, so the bar takes the
                // card's accent and track like the stages and metrics do.
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(muted.opacity(0.18))
                        Capsule().fill(accent).frame(width: max(6, proxy.size.width * fraction))
                    }
                }
                .frame(height: 6)
                .accessibilityHidden(true)
            }
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: - Stages

    private var stages: some View {
        let items = ids("factIds").compactMap { facts[$0] }
        let reached = items.firstIndex { $0.id == block.values["currentFact"]?.string } ?? -1
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                HStack(alignment: .top, spacing: 12) {
                    VStack(spacing: 0) {
                        stageDot(done: index < reached, current: index == reached)
                        if index < items.count - 1 {
                            Rectangle()
                                .fill(index < reached ? accent : muted.opacity(0.25))
                                .frame(width: 2)
                                .frame(minHeight: 14)
                        }
                    }
                    Text(item.sensitive ? CardText.presentationLabel(item.label) : item.value)
                        .font(index == reached ? .callout.weight(.semibold) : .callout)
                        .foregroundStyle(index <= reached ? ink : muted)
                        .padding(.bottom, index < items.count - 1 ? 12 : 0)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue(index < reached ? "Done" : index == reached ? "Current" : "Not yet")
            }
        }
    }

    private func stageDot(done: Bool, current: Bool) -> some View {
        ZStack {
            Circle()
                .strokeBorder(done || current ? accent : muted.opacity(0.4), lineWidth: 2)
                .background(Circle().fill(done ? accent : .clear))
                .frame(width: 18, height: 18)
            if done {
                Image(systemName: "checkmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(AssistantTheme.raised(for: colorScheme))
            } else if current {
                Circle().fill(accent).frame(width: 8, height: 8)
            }
        }
        .padding(.top, 1)
        .accessibilityHidden(true)
    }

    // MARK: - Countdown

    /// A tinted callout: the time left as the figure, and the moment itself,
    /// on its own clock, beside it — the one thing on the card that moves.
    @ViewBuilder
    private var countdown: some View {
        if let target = fact("dateFact"), !target.sensitive,
           let instant = GeneratedCardValue.instant(target.value) {
            TimelineView(.everyMinute) { context in
                let future = instant.date > context.date
                HStack(alignment: .center, spacing: CardStyle.gutter) {
                    VStack(alignment: .leading, spacing: CardStyle.labelSpacing) {
                        CardEyebrow(fact("labelFact")?.value ?? target.label)
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            if future {
                                Text("in").font(CardStyle.body).foregroundStyle(muted)
                            }
                            Text(instant.date, style: .relative)
                                .font(.title2.weight(.bold).monospacedDigit())
                                .foregroundStyle(future ? accent : muted)
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                            if !future {
                                Text("ago").font(CardStyle.body).foregroundStyle(muted)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                    if !shownElsewhere.contains(target.id),
                       let reading = GeneratedCardValue.clockAndDay(target.value) {
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(reading.time)
                                .font(CardStyle.value.monospacedDigit())
                                .foregroundStyle(ink)
                            Text(reading.day)
                                .font(.caption)
                                .foregroundStyle(muted)
                        }
                    }
                }
                .padding(CardStyle.panelPadding)
                .background(
                    accent.opacity(future ? 0.08 : 0.04),
                    in: RoundedRectangle(cornerRadius: CardStyle.panelRadius, style: .continuous)
                )
                .accessibilityElement(children: .combine)
            }
        }
    }

    // MARK: - Table

    private var table: some View {
        let columns = block.values["columns"]?.arrayStrings ?? []
        let rows: [[String]] = {
            guard case let .array(values)? = block.values["rows"] else { return [] }
            return values.compactMap { $0.arrayStrings }.filter { $0.count == columns.count }
        }()
        // A column of figures reads down its right edge, the way prices and
        // weights line up on a receipt; words stay on the left.
        let numeric = columns.indices.map { index in
            !rows.isEmpty && rows.allSatisfy { row in
                row.indices.contains(index) && facts[row[index]].map { GeneratedCardValue.number($0.value) != nil } == true
            }
        }
        return Grid(alignment: .leading, horizontalSpacing: CardStyle.gutter, verticalSpacing: 10) {
            GridRow {
                ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
                    CardEyebrow(column)
                        .gridColumnAlignment(numeric[index] ? .trailing : .leading)
                        .frame(maxWidth: index == columns.count - 1 ? .infinity : nil,
                               alignment: numeric[index] ? .trailing : .leading)
                }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                Divider().gridCellUnsizedAxes(.horizontal)
                GridRow(alignment: .firstTextBaseline) {
                    ForEach(Array(row.enumerated()), id: \.offset) { index, id in
                        if let cell = facts[id] {
                            value(cell, font: index == 0 ? CardStyle.value : CardStyle.body.monospacedDigit())
                                .multilineTextAlignment(numeric[index] ? .trailing : .leading)
                        } else {
                            Text("")
                        }
                    }
                }
            }
        }
    }

    // MARK: - Chart

    private struct ChartPoint: Identifiable {
        let id: Int
        let label: String
        let value: Double
    }

    @ViewBuilder
    private var chart: some View {
        let points: [ChartPoint] = {
            guard case let .array(values)? = block.values["points"] else { return [] }
            return values.enumerated().compactMap { index, raw in
                guard let point = raw.objectValue,
                      let label = point["labelFact"]?.string.flatMap({ facts[$0] }),
                      let figure = point["valueFact"]?.string.flatMap({ facts[$0] }),
                      !label.sensitive, !figure.sensitive,
                      let number = GeneratedCardValue.number(figure.value) else { return nil }
                return ChartPoint(id: index, label: label.value, value: number)
            }
        }()
        if points.count >= 2 {
            // Two charts rather than a branch inside one: conditional chart
            // content needs iOS 27, and this app still runs on 26.
            Group {
                if block.values["kind"]?.string == "line" {
                    Chart(points) { point in
                        LineMark(x: .value("Label", point.label), y: .value("Value", point.value))
                            .foregroundStyle(accent)
                            .interpolationMethod(.monotone)
                        PointMark(x: .value("Label", point.label), y: .value("Value", point.value))
                            .foregroundStyle(accent)
                    }
                } else {
                    Chart(points) { point in
                        BarMark(x: .value("Label", point.label), y: .value("Value", point.value))
                            .foregroundStyle(accent.gradient)
                            .cornerRadius(4)
                    }
                }
            }
            .chartXAxis {
                AxisMarks { _ in AxisValueLabel().font(.caption2) }
            }
            .frame(height: 170)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(points.map { "\($0.label): \(GeneratedCardValue.plain($0.value))" }.joined(separator: ", "))
        }
    }
}

// MARK: - Checklist

/// Ticks are the owner's, not the card's: they stay on this phone and survive
/// a refresh of the card they sit on.
private struct GeneratedChecklist: View {
    let items: [MessageResponseCard.GeneratedFact]
    let storageKey: String
    @State private var checked: Set<String> = []
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(items) { item in
                Button {
                    if checked.contains(item.id) { checked.remove(item.id) } else { checked.insert(item.id) }
                    UserDefaults.standard.set(Array(checked), forKey: storageKey)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: checked.contains(item.id) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(checked.contains(item.id)
                                ? AssistantTheme.accent(for: colorScheme)
                                : AssistantTheme.inkMuted(for: colorScheme))
                        Text(item.sensitive ? CardText.presentationLabel(item.label) : item.value)
                            .font(.callout)
                            .foregroundStyle(checked.contains(item.id)
                                ? AssistantTheme.inkMuted(for: colorScheme)
                                : AssistantTheme.ink(for: colorScheme))
                            .strikethrough(checked.contains(item.id))
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(checked.contains(item.id) ? .isSelected : [])
            }
        }
        .onAppear {
            checked = Set(UserDefaults.standard.stringArray(forKey: storageKey) ?? [])
        }
    }
}

// MARK: - Map

/// Places the card names, pinned. An address is looked up with MapKit; a
/// "lat, lng" pair is used as written. Places that do not resolve stay in the
/// list below the map, where tapping any of them opens Maps on it.
private struct GeneratedPlacesMap: View {
    let places: [MessageResponseCard.GeneratedFact]
    @State private var pins: [Pin] = []
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL

    struct Pin: Identifiable {
        let id: String
        let label: String
        let coordinate: CLLocationCoordinate2D
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !pins.isEmpty {
                Map(initialPosition: .automatic, interactionModes: []) {
                    ForEach(pins) { pin in
                        Marker(pin.label, coordinate: pin.coordinate)
                            .tint(AssistantTheme.accent(for: colorScheme))
                    }
                }
                .frame(height: 170)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityHidden(true)
            }
            ForEach(places) { place in
                Button {
                    if let url = GeneratedCardValue.mapsURL(place.value) { openURL(url) }
                } label: {
                    // A bare "lat, lng" names nowhere a person would recognise;
                    // the fact's label ("Harpa") does, and the pin sits on it.
                    Label(GeneratedCardValue.coordinate(place.value) == nil ? place.value : place.label,
                          systemImage: "mappin.and.ellipse")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens in Maps.")
            }
        }
        .task(id: places.map(\.id).joined(separator: ",")) {
            pins = await resolve()
        }
    }

    private func resolve() async -> [Pin] {
        var resolved: [Pin] = []
        for place in places {
            if let coordinate = GeneratedCardValue.coordinate(place.value) {
                resolved.append(.init(id: place.id, label: place.label, coordinate: coordinate))
                continue
            }
            let request = MKLocalSearch.Request()
            request.naturalLanguageQuery = place.value
            guard let item = try? await MKLocalSearch(request: request).start().mapItems.first else { continue }
            resolved.append(.init(id: place.id, label: place.label, coordinate: item.location.coordinate))
        }
        return resolved
    }
}

// MARK: - Values

/// Reading grounded strings for drawing. Mirrors `numericFactValue` and the
/// zoned-instant rule in core/generative-card.ts, which have already refused
/// anything these would have to guess at.
enum GeneratedCardValue {
    private static let figure = try! Regex(#"^[^\d-]{0,3}(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*[^\d]{0,6}$"#)
    private static let offset = try! Regex(#"([+-])(\d{2}):?(\d{2})$"#)

    static func number(_ value: String) -> Double? {
        guard let match = value.trimmingCharacters(in: .whitespacesAndNewlines).wholeMatch(of: figure),
              let captured = match.output[1].substring else { return nil }
        return Double(captured.replacingOccurrences(of: ",", with: ""))
    }

    /// 0…1 for a bar: a percentage on its own, or a value over its total.
    static func fraction(value: String, total: String?) -> Double? {
        guard let current = number(value), current >= 0 else { return nil }
        if let total {
            guard let whole = number(total), whole > 0, current <= whole else { return nil }
            return current / whole
        }
        guard value.trimmingCharacters(in: .whitespaces).hasSuffix("%"), current <= 100 else { return nil }
        return current / 100
    }

    /// An ISO 8601 instant and the zone it was written in.
    static func instant(_ value: String) -> (date: Date, zone: TimeZone)? {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard let date = ISO8601DateFormatter.flexible(trimmed) else { return nil }
        if trimmed.hasSuffix("Z") { return (date, TimeZone(identifier: "UTC") ?? .current) }
        guard let match = trimmed.firstMatch(of: offset),
              let sign = match.output[1].substring,
              let hours = match.output[2].substring.flatMap({ Int($0) }),
              let minutes = match.output[3].substring.flatMap({ Int($0) }) else { return nil }
        let seconds = (hours * 3600 + minutes * 60) * (sign == "-" ? -1 : 1)
        return (date, TimeZone(secondsFromGMT: seconds) ?? .current)
    }

    /// An instant shown on the wall clock it was written for: a departure at
    /// 16:40 from Keflavík reads 16:40 in San Francisco too.
    static func displayInstant(_ value: String) -> String? {
        guard let (date, zone) = instant(value) else { return nil }
        var style = Date.FormatStyle(date: .abbreviated, time: .shortened)
        style.timeZone = zone
        return date.formatted(style)
    }

    /// "16:40" and "Oct 2" apart, for a departure board: the clock is the
    /// thing being read, the day is the thing being checked.
    static func clockAndDay(_ value: String) -> (time: String, day: String)? {
        guard let (date, zone) = instant(value) else { return nil }
        var time = Date.FormatStyle(date: .omitted, time: .shortened)
        time.timeZone = zone
        var day = Date.FormatStyle().month(.abbreviated).day().weekday(.abbreviated)
        day.timeZone = zone
        return (date.formatted(time), date.formatted(day))
    }

    static func coordinate(_ value: String) -> CLLocationCoordinate2D? {
        let parts = value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 2, let lat = Double(parts[0]), let lng = Double(parts[1]),
              (-90...90).contains(lat), (-180...180).contains(lng) else { return nil }
        return .init(latitude: lat, longitude: lng)
    }

    static func mapsURL(_ place: String) -> URL? {
        var components = URLComponents(string: "https://maps.apple.com/")
        components?.queryItems = [.init(name: "q", value: place)]
        return components?.url
    }

    static func plain(_ number: Double) -> String {
        number.formatted(.number.precision(.fractionLength(0...2)))
    }
}

// MARK: - Grid and type

/// The generated card's grid and type scale, on a 4-point grid. Blocks sit
/// 20 apart, the parts of a block 12 apart, a label 4 above its value, and
/// columns split the card's width evenly across a 12-point gutter. Five text
/// styles, all Dynamic Type: an uppercase eyebrow for labels, body and value
/// for facts, a figure for anything read at a glance (a gate, a clock), and
/// a display size for the one thing a block is about (an airport code).
enum CardStyle {
    static let blockSpacing: CGFloat = 20
    static let partSpacing: CGFloat = 12
    static let labelSpacing: CGFloat = 4
    static let gutter: CGFloat = 12
    static let panelPadding: CGFloat = 14
    static let panelRadius: CGFloat = 14

    static let eyebrow = Font.caption2.weight(.semibold)
    static let body = Font.callout
    static let value = Font.callout.weight(.semibold)
    static let figure = Font.title3.weight(.semibold).monospacedDigit()
    static let display = Font.title.weight(.bold)

    /// Equal columns for `count` items, one column at accessibility sizes.
    static func columns(_ count: Int, accessibility: Bool) -> [GridItem] {
        Array(
            repeating: GridItem(.flexible(), spacing: gutter, alignment: .topLeading),
            count: accessibility ? 1 : max(1, count)
        )
    }
}

/// A label above a value: small, uppercase, muted — never competing with
/// the value it names.
struct CardEyebrow: View {
    let text: String
    @Environment(\.colorScheme) private var colorScheme

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(CardText.presentationLabel(text))
            .font(CardStyle.eyebrow)
            .textCase(.uppercase)
            .tracking(0.5)
            .foregroundStyle(AssistantTheme.inkMuted(for: colorScheme))
            .lineLimit(1)
    }
}

/// A status in the colour of what it means: trouble in amber, a cancellation
/// in red, everything else in the card's accent. Read from the words
/// themselves, since a status is a verbatim fact.
struct CardStatusPill: View {
    let text: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(tint.opacity(0.12), in: Capsule())
            .lineLimit(1)
    }

    private var tint: Color {
        let lower = text.lowercased()
        if ["cancel", "divert"].contains(where: lower.contains) { return AssistantTheme.errorInk(for: colorScheme) }
        if ["delay", "late"].contains(where: lower.contains) { return AssistantTheme.warning(for: colorScheme) }
        return AssistantTheme.accent(for: colorScheme)
    }
}

/// The card's action row: equal tiles, icon over a short label, so three
/// actions read as one row rather than a stack of wide buttons.
struct CardActionButtonStyle: ButtonStyle {
    @Environment(\.cardActionSolo) private var solo
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(CardActionLabelStyle(solo: solo))
            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
            .padding(.horizontal, solo ? 16 : 6)
            .padding(.vertical, 10)
            // Tiles in a row share its height, so a label that wraps does not
            // leave its neighbours short.
            .frame(maxWidth: .infinity, minHeight: solo ? 44 : 58, maxHeight: solo ? nil : .infinity)
            .background(
                AssistantTheme.sunken(for: colorScheme),
                in: RoundedRectangle(cornerRadius: CardStyle.panelRadius, style: .continuous)
            )
            .contentShape(RoundedRectangle(cornerRadius: CardStyle.panelRadius, style: .continuous))
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.48)
            .animation(reduceMotion ? nil : .spring(response: 0.22, dampingFraction: 0.82), value: configuration.isPressed)
    }
}

struct CardActionLabelStyle: LabelStyle {
    var solo = false

    @ViewBuilder
    func makeBody(configuration: Configuration) -> some View {
        if solo {
            // One action alone is a plain button, not a tall empty tile.
            HStack(spacing: 8) {
                configuration.icon.font(.system(size: 15, weight: .semibold))
                configuration.title.font(.subheadline.weight(.semibold)).lineLimit(1)
            }
        } else {
            tile(configuration)
        }
    }

    private func tile(_ configuration: Configuration) -> some View {
        VStack(spacing: 5) {
            configuration.icon
                .font(.system(size: 17, weight: .semibold))
                .frame(height: 20)
            configuration.title
                .font(.caption.weight(.semibold))
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.85)
        }
    }
}

private struct CardActionSoloKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Set by the card when its row holds one action.
    var cardActionSolo: Bool {
        get { self[CardActionSoloKey.self] }
        set { self[CardActionSoloKey.self] = newValue }
    }
}
