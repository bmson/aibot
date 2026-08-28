import CoreLocation
import Foundation
import MapKit
import UIKit

/// Location for the assistant's ambient context, in two gears:
///
/// - Foreground one-shot fixes (`captureCurrentPlace`) — the phone's position
///   goes to the owner's OWN server as a transient ping (it ages out with
///   LOCATION_RETENTION_DAYS and never enters memory). Hundred-meter accuracy
///   is plenty for "what can I eat around here" and keeps the fix fast.
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
        } else {
            backgroundMonitoring = false
            manager.stopMonitoringSignificantLocationChanges()
        }
    }

    /// This app's page in iOS Settings, for recovering from a denied permission.
    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    /// A fresh fix with a short human label for the ambient line, or nil when
    /// access or a fix is unavailable. One-shot: nothing keeps listening.
    func captureCurrentPlace() async -> (location: CLLocation, label: String)? {
        guard isAuthorized else { return nil }
        guard let location = await requestOneShotLocation() else { return nil }
        let label = await reverseGeocodeLabel(for: location)
        return (location, label)
    }

    private func requestOneShotLocation() async -> CLLocation? {
        guard locationContinuation == nil else { return nil }
        return await withCheckedContinuation { continuation in
            locationContinuation = continuation
            manager.requestLocation()
        }
    }

    private func reverseGeocodeLabel(for location: CLLocation) async -> String {
        if #available(iOS 26.0, *) {
            guard let request = MKReverseGeocodingRequest(location: location) else { return "" }
            let mapItems = try? await request.mapItems
            if let item = mapItems?.first {
                return item.addressRepresentations?.cityName ?? item.name ?? ""
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
        return place?.locality ?? place?.subAdministrativeArea ?? place?.name ?? ""
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
            }
            if authorizationStatus != .authorizedAlways, backgroundMonitoring {
                backgroundMonitoring = false
                manager.stopMonitoringSignificantLocationChanges()
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            if let continuation = locationContinuation {
                locationContinuation = nil
                continuation.resume(returning: locations.last)
                return
            }
            // A significant-change wake: post one ping per wake, throttled so
            // a day of moving stays a handful of radio hits (and the server's
            // arrival gate does the real dedupe).
            guard backgroundMonitoring, let location = locations.last else { return }
            let lastPost = defaults.double(forKey: lastBackgroundPostKey)
            guard Date().timeIntervalSince1970 - lastPost > 15 * 60 else { return }
            defaults.set(Date().timeIntervalSince1970, forKey: lastBackgroundPostKey)
            let label = await reverseGeocodeLabel(for: location)
            await backgroundHandler?(location, label)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            let continuation = locationContinuation
            locationContinuation = nil
            continuation?.resume(returning: nil)
        }
    }
}
