import CoreLocation
import Foundation
import MapKit
import UIKit

/// Location for the assistant's ambient context, in two gears:
///
/// - Foreground bounded fixes (`captureCurrentPlace`) — the phone's position
///   goes to the owner's OWN server as a transient ping (it ages out with
///   LOCATION_RETENTION_DAYS and never enters memory). Two fresh, consistent
///   samples avoid treating the first cached or wandering fix as authoritative.
/// - Background arrival awareness (`setBackgroundMonitoring`) — the
///   significant-change service wakes the app on ~500m moves so the server can
///   notice an arrival and consider one nudge. Coarse by design: no continuous
///   tracking, and pings are throttled below what the service could deliver.
@MainActor
final class LocationManager: NSObject, ObservableObject {
    static let shared = LocationManager()

    @Published private(set) var authorizationStatus: CLAuthorizationStatus
    @Published private(set) var backgroundMonitoring = false

    /// Wired by AppModel: post one background ping per wake. The server applies
    /// its own arrival logic — the app only reports movement.
    var backgroundHandler: (@MainActor (CLLocation, String) async -> Void)?

    private let manager = CLLocationManager()
    private var locationContinuation: CheckedContinuation<CLLocation?, Never>?
    private var fixCandidate: CLLocation?
    private var fixTimeout: Task<Void, Never>?
    private var backgroundCaptureInFlight = false
    private let defaults = UserDefaults.standard
    private let backgroundEnabledKey = "assistant.share-location-background"
    private let lastBackgroundPostKey = "assistant.background-location-posted"

    private override init() {
        authorizationStatus = manager.authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        // A background relaunch (iOS waking the app for a significant change)
        // re-runs this init: resume monitoring when the owner left it on.
        if defaults.bool(forKey: backgroundEnabledKey),
           manager.authorizationStatus == .authorizedAlways {
            backgroundMonitoring = true
            manager.startMonitoringSignificantLocationChanges()
            manager.startMonitoringVisits()
        }
    }

    var isAuthorized: Bool {
        authorizationStatus == .authorizedWhenInUse || authorizationStatus == .authorizedAlways
    }

    var accessDenied: Bool {
        authorizationStatus == .denied || authorizationStatus == .restricted
    }

    var hasAlwaysAccess: Bool {
        authorizationStatus == .authorizedAlways
    }

    func requestAccess() {
        manager.requestWhenInUseAuthorization()
    }

    /// The toggle in More → Assistant context. Enabling asks iOS for Always
    /// access (the prompt belongs to the intent, never to app launch); without
    /// it the app keeps foreground-only sharing and says so in the UI.
    func setBackgroundMonitoring(_ enabled: Bool) {
        defaults.set(enabled, forKey: backgroundEnabledKey)
        if enabled {
            if manager.authorizationStatus != .authorizedAlways {
                manager.requestAlwaysAuthorization()
                // Did the owner already decline Always? Keep the honest state.
                if manager.authorizationStatus != .authorizedAlways { return }
            }
            backgroundMonitoring = true
            manager.startMonitoringSignificantLocationChanges()
            manager.startMonitoringVisits()
        } else {
            backgroundMonitoring = false
            manager.stopMonitoringSignificantLocationChanges()
            manager.stopMonitoringVisits()
            if backgroundCaptureInFlight { finishFix(nil) }
        }
    }

    /// This app's page in iOS Settings, for recovering from a denied permission.
    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    /// A fresh fix with a short human label for the ambient line, or nil when
    /// access or a fix is unavailable. Stops after confirmation or 12 seconds.
    func captureCurrentPlace() async -> (location: CLLocation, label: String)? {
        guard isAuthorized else { return nil }
        guard let location = await requestConfirmedLocation() else { return nil }
        let label = await reverseGeocodeLabel(for: location)
        return (location, label)
    }

    private func requestConfirmedLocation() async -> CLLocation? {
        guard locationContinuation == nil else { return nil }
        return await withCheckedContinuation { continuation in
            locationContinuation = continuation
            fixCandidate = nil
            manager.startUpdatingLocation()
            fixTimeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(12)) } catch { return }
                self?.finishFix(nil)
            }
        }
    }

    private func finishFix(_ location: CLLocation?) {
        guard let continuation = locationContinuation else { return }
        locationContinuation = nil
        fixCandidate = nil
        fixTimeout?.cancel()
        fixTimeout = nil
        manager.stopUpdatingLocation()
        continuation.resume(returning: location)
    }

    private func postBackground(_ location: CLLocation, label: String, bypassThrottle: Bool = false) async {
        guard backgroundMonitoring, LocationFixPolicy.isUsable(location) else { return }
        let lastPost = defaults.double(forKey: lastBackgroundPostKey)
        guard bypassThrottle || Date().timeIntervalSince1970 - lastPost > 15 * 60 else { return }
        defaults.set(Date().timeIntervalSince1970, forKey: lastBackgroundPostKey)
        await backgroundHandler?(location, label)
    }

    private func reverseGeocodeLabel(for location: CLLocation) async -> String {
        if #available(iOS 26.0, *) {
            guard let request = MKReverseGeocodingRequest(location: location) else { return "" }
            let mapItems = try? await request.mapItems
            if let item = mapItems?.first {
                // A reverse-geocoder's nearest venue is not proof that the
                // owner is in that venue. Keep the ambient label city-level.
                return item.addressRepresentations?.cityName ?? ""
            }
            return ""
        } else {
            return await legacyReverseGeocodeLabel(for: location)
        }
    }

    /// MapKit supersedes CLGeocoder on iOS 26. This fallback keeps location
    /// labels available on earlier supported systems without presenting the
    /// iOS 26 deprecation to the current code path.
    @available(iOS, introduced: 2.0, deprecated: 26.0)
    private func legacyReverseGeocodeLabel(for location: CLLocation) async -> String {
        let geocoder = CLGeocoder()
        let placemarks = try? await geocoder.reverseGeocodeLocation(location)
        let place = placemarks?.first
        // A locality ("Reykjavík") reads naturally in the ambient line; fall
        // back to the area name, never a street address — this is context for
        // the assistant, not a check-in.
        return place?.locality ?? place?.subAdministrativeArea ?? place?.administrativeArea ?? ""
    }
}

extension LocationManager: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            authorizationStatus = manager.authorizationStatus
            // A granted Always upgrade completes the pending toggle intent.
            if defaults.bool(forKey: backgroundEnabledKey),
               authorizationStatus == .authorizedAlways,
               !backgroundMonitoring {
                backgroundMonitoring = true
                manager.startMonitoringSignificantLocationChanges()
                manager.startMonitoringVisits()
            }
            if authorizationStatus != .authorizedAlways, backgroundMonitoring {
                backgroundMonitoring = false
                manager.stopMonitoringSignificantLocationChanges()
                manager.stopMonitoringVisits()
                if backgroundCaptureInFlight { finishFix(nil) }
            }
            if !isAuthorized { finishFix(nil) }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            if locationContinuation != nil {
                for location in locations.sorted(by: { $0.timestamp < $1.timestamp }) {
                    guard LocationFixPolicy.isUsable(location) else { continue }
                    if let candidate = fixCandidate {
                        guard location.timestamp > candidate.timestamp else { continue }
                        if LocationFixPolicy.confirms(candidate, with: location) {
                            finishFix(location)
                            return
                        }
                        // Preserve the first sample while waiting for the
                        // minimum interval; restart after drift or a long gap.
                        if location.timestamp.timeIntervalSince(candidate.timestamp) < 2,
                           location.distance(from: candidate) <= 200 { continue }
                    }
                    fixCandidate = location
                }
                return
            }
            // A significant-change wake: post one ping per wake, throttled so
            // a day of moving stays a handful of radio hits (and the server's
            // arrival gate does the real dedupe).
            guard backgroundMonitoring, !backgroundCaptureInFlight,
                  !locations.isEmpty,
                  Date().timeIntervalSince1970 - defaults.double(forKey: lastBackgroundPostKey) > 15 * 60 else { return }
            backgroundCaptureInFlight = true
            defer { backgroundCaptureInFlight = false }
            if let place = await captureCurrentPlace() {
                await postBackground(place.location, label: place.label)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        Task { @MainActor in
            // Significant-change events describe movement, not a stop. A visit
            // gives us a low-power opportunity to confirm the phone is still
            // nearby, even when no further movement events arrive.
            guard backgroundMonitoring, !backgroundCaptureInFlight, visit.departureDate == .distantFuture,
                  visit.arrivalDate != .distantPast,
                  Date().timeIntervalSince(visit.arrivalDate) >= 3 * 60,
                  visit.horizontalAccuracy >= 0, visit.horizontalAccuracy <= 200 else { return }
            backgroundCaptureInFlight = true
            defer { backgroundCaptureInFlight = false }
            guard let place = await captureCurrentPlace() else { return }
            let center = CLLocation(latitude: visit.coordinate.latitude, longitude: visit.coordinate.longitude)
            guard place.location.distance(from: center) <= 200 else { return }
            // Do not let the movement ping's 15-minute throttle swallow the
            // stationary confirmation. The server still enforces dwell/dedupe.
            await postBackground(place.location, label: place.label, bypassThrottle: true)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            if (error as? CLError)?.code == .locationUnknown { return }
            finishFix(nil)
        }
    }
}

enum LocationFixPolicy {
    static func isUsable(_ location: CLLocation, now: Date = Date()) -> Bool {
        let age = now.timeIntervalSince(location.timestamp)
        return CLLocationCoordinate2DIsValid(location.coordinate)
            && location.horizontalAccuracy.isFinite
            && location.horizontalAccuracy >= 0 && location.horizontalAccuracy <= 200
            && age >= -5 && age <= 30
    }

    static func confirms(_ first: CLLocation, with second: CLLocation, now: Date = Date()) -> Bool {
        let interval = second.timestamp.timeIntervalSince(first.timestamp)
        return isUsable(first, now: now) && isUsable(second, now: now)
            && interval >= 2 && interval <= 12
            && second.distance(from: first) <= min(200, max(50, first.horizontalAccuracy + second.horizontalAccuracy))
    }
}
