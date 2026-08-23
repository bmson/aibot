import CoreLocation
import Foundation

/// One-shot, on-foreground location capture for the assistant's ambient
/// context. The phone's position goes to the owner's OWN server as a
/// transient ping (it ages out with LOCATION_RETENTION_DAYS and never enters
/// memory) — no continuous tracking, no significant-change monitoring, no
/// background updates. Hundred-meter accuracy is plenty for "what can I eat
/// around here" and keeps the fix fast and battery-neutral.
@MainActor
final class LocationManager: NSObject, ObservableObject {
    static let shared = LocationManager()

    @Published private(set) var authorizationStatus: CLAuthorizationStatus

    private let manager = CLLocationManager()
    private var locationContinuation: CheckedContinuation<CLLocation?, Never>?

    private override init() {
        authorizationStatus = manager.authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    var isAuthorized: Bool {
        authorizationStatus == .authorizedWhenInUse || authorizationStatus == .authorizedAlways
    }

    var accessDenied: Bool {
        authorizationStatus == .denied || authorizationStatus == .restricted
    }

    func requestAccess() {
        manager.requestWhenInUseAuthorization()
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
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            let continuation = locationContinuation
            locationContinuation = nil
            continuation?.resume(returning: locations.last)
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
