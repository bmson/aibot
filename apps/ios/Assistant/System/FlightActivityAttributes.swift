import ActivityKit
import Foundation

/// A flight followed on the Lock Screen and in the Dynamic Island.
///
/// Times travel as epoch seconds plus the airport's UTC offset rather than as
/// `Date`s: the same state is meant to arrive by APNs push from the server,
/// and a plain number decodes identically from either sender. The offset
/// keeps each time on its own airport's clock — a departure at 16:40 from
/// Keflavík reads 16:40 wherever the phone is.
struct FlightActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var phase: String
        var statusText: String
        var departEpoch: Double?
        var departOffset: Int?
        var arriveEpoch: Double?
        var arriveOffset: Int?
        var gate: String
        var terminal: String
        var arrivalGate: String
        var baggage: String
        /// 0…1 while in the air.
        var progress: Double?
        var updatedEpoch: Double
    }

    let flightId: String
    let ident: String
    let originCode: String
    let originCity: String
    let destinationCode: String
    let destinationCity: String
}

extension FlightActivityAttributes.ContentState {
    var departure: Date? { departEpoch.map(Date.init(timeIntervalSince1970:)) }
    var arrival: Date? { arriveEpoch.map(Date.init(timeIntervalSince1970:)) }
    var isOver: Bool { phase == "arrived" || phase == "cancelled" }
    var isAirborne: Bool { phase == "en_route" || phase == "landed" }
    var isTrouble: Bool {
        phase == "cancelled" || phase == "diverted" || statusText.localizedCaseInsensitiveContains("delayed")
            || statusText.localizedCaseInsensitiveContains("late")
    }

    /// The moment the owner is waiting for: leaving, until the wheels are up;
    /// arriving, after.
    var nextMoment: Date? { isAirborne ? arrival : departure }

    static func clock(_ date: Date?, offset: Int?) -> String {
        guard let date else { return "—" }
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        if let offset, let zone = TimeZone(secondsFromGMT: offset) { style.timeZone = zone }
        return date.formatted(style)
    }

    var departureClock: String { Self.clock(departure, offset: departOffset) }
    var arrivalClock: String { Self.clock(arrival, offset: arriveOffset) }
}
