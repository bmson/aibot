import Foundation

/// One flight as the server read it (core/flights/aeroapi.ts `FlightStatus`),
/// reduced to what the Lock Screen activity draws.
struct FlightSnapshot: Hashable, Sendable {
    let id: String
    let ident: String
    let originCode: String
    let originCity: String
    let destinationCode: String
    let destinationCity: String
    /// ISO 8601 on each airport's clock, offset included.
    let departure: String
    let arrival: String
    let gateOrigin: String
    let terminalOrigin: String
    let gateDestination: String
    let baggageClaim: String
    let phase: String
    let statusText: String
    let progressPercent: Double?

    init?(json: [String: JSONValue]) {
        guard let id = json["id"]?.string, !id.isEmpty,
              let ident = json["ident"]?.string else { return nil }
        let origin = json["origin"]?.objectValue ?? [:]
        let destination = json["destination"]?.objectValue ?? [:]
        self.id = id
        self.ident = ident
        originCode = origin["code"]?.string ?? ""
        originCity = origin["city"]?.string ?? ""
        destinationCode = destination["code"]?.string ?? ""
        destinationCity = destination["city"]?.string ?? ""
        departure = json["departure"]?.objectValue?["best"]?.string ?? ""
        arrival = json["arrival"]?.objectValue?["best"]?.string ?? ""
        gateOrigin = json["gateOrigin"]?.string ?? ""
        terminalOrigin = json["terminalOrigin"]?.string ?? ""
        gateDestination = json["gateDestination"]?.string ?? ""
        baggageClaim = json["baggageClaim"]?.string ?? ""
        phase = json["phase"]?.string ?? "scheduled"
        statusText = json["statusText"]?.string ?? ""
        progressPercent = json["progressPercent"]?.numberValue
    }

    var activityAttributes: FlightActivityAttributes {
        .init(
            flightId: id,
            ident: ident,
            originCode: originCode,
            originCity: originCity,
            destinationCode: destinationCode,
            destinationCity: destinationCity
        )
    }

    func activityState(now: Date = .now) -> FlightActivityAttributes.ContentState {
        let depart = GeneratedCardValue.instant(departure)
        let arrive = GeneratedCardValue.instant(arrival)
        return .init(
            phase: phase,
            statusText: statusText,
            departEpoch: depart?.date.timeIntervalSince1970,
            departOffset: depart?.zone.secondsFromGMT(),
            arriveEpoch: arrive?.date.timeIntervalSince1970,
            arriveOffset: arrive?.zone.secondsFromGMT(),
            gate: gateOrigin,
            terminal: terminalOrigin,
            arrivalGate: gateDestination,
            baggage: baggageClaim,
            progress: progressPercent.map { min(max($0 / 100, 0), 1) },
            updatedEpoch: now.timeIntervalSince1970
        )
    }
}

/// The runtime's note on a live flight card: which flight to read again, how
/// often, and until when. Absent once the flight is at the gate.
struct FlightLive: Hashable, Sendable {
    let id: String
    let pollSeconds: Int
    let until: Date
    let flight: FlightSnapshot

    init?(json: JSONValue?) {
        guard let object = json?.objectValue,
              object["kind"]?.string == "flight",
              let id = object["id"]?.string,
              let until = (object["until"]?.string).flatMap(ISO8601DateFormatter.flexible),
              let flight = object["flight"]?.objectValue.flatMap(FlightSnapshot.init(json:)) else { return nil }
        self.id = id
        pollSeconds = max(object["pollSeconds"]?.integerValue ?? 300, 60)
        self.until = until
        self.flight = flight
    }

    var isCurrent: Bool { until > .now }
}

/// `GET /api/mobile/v1/live/flight?id=` (application/live-flights.ts).
struct LiveFlightPayload: Decodable, Sendable {
    let fetchedAt: String?
    let spec: JSONValue
    let flight: JSONValue?
    let live: JSONValue?

    var snapshot: FlightSnapshot? { flight?.objectValue.flatMap(FlightSnapshot.init(json:)) }
}
