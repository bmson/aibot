import SwiftUI
import UIKit
@preconcurrency import UserNotifications

@MainActor
final class NotificationManager: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var isRequestingAuthorization = false
    @Published private(set) var authorizationError: String?
    @Published private(set) var pendingRoute: AssistantRoute?

    private let center = UNUserNotificationCenter.current()

    private override init() {
        super.init()
        center.delegate = self
        registerCategories()
        Task { await refreshAuthorizationStatus() }
    }

    func requestAuthorization() async {
        guard !isRequestingAuthorization else { return }
        isRequestingAuthorization = true
        authorizationError = nil
        defer { isRequestingAuthorization = false }
        do {
            _ = try await center.requestAuthorization(options: [.alert, .sound])
        } catch {
            authorizationError = "Notifications couldn’t be enabled. Try again."
        }
        await refreshAuthorizationStatus()
    }

    func refreshAuthorizationStatus() async {
        authorizationStatus = await center.notificationSettings().authorizationStatus
    }

    @discardableResult
    func schedule(title: String, body: String, route: AssistantRoute?) async -> Bool {
        let settings = await center.notificationSettings()
        authorizationStatus = settings.authorizationStatus
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional,
              UIApplication.shared.applicationState != .active else { return false }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = "assistant-work"
        content.categoryIdentifier = route == .approvals ? "ASSISTANT_ATTENTION" : "ASSISTANT_UPDATE"
        if let route {
            content.userInfo["route"] = route.rawValue
        }

        let request = UNNotificationRequest(
            identifier: "assistant-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        do {
            try await center.add(request)
            return true
        } catch {
            return false
        }
    }

#if DEBUG
    @discardableResult
    func schedulePreview() async -> Bool {
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            await requestAuthorization()
            status = authorizationStatus
        }
        guard status == .authorized || status == .provisional else { return false }

        let content = UNMutableNotificationContent()
        content.title = "Assistant needs you"
        content.body = "A decision is ready to review."
        content.sound = .default
        content.threadIdentifier = "assistant-work"
        content.categoryIdentifier = "ASSISTANT_ATTENTION"
        content.userInfo["route"] = AssistantRoute.approvals.rawValue

        let request = UNNotificationRequest(
            identifier: "assistant-preview",
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
        )
        do {
            try await center.add(request)
            return true
        } catch {
            return false
        }
    }
#endif

    func consumePendingRoute() {
        pendingRoute = nil
    }

    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        []
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let rawRoute = response.notification.request.content.userInfo["route"] as? String
        let route = rawRoute.flatMap(AssistantRoute.init(rawValue:))
        guard let route else { return }
        await MainActor.run { self.pendingRoute = route }
    }

    private func registerCategories() {
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: "ASSISTANT_ATTENTION",
                actions: [],
                intentIdentifiers: [],
                hiddenPreviewsBodyPlaceholder: "Decision ready",
                options: []
            ),
            UNNotificationCategory(
                identifier: "ASSISTANT_UPDATE",
                actions: [],
                intentIdentifiers: [],
                hiddenPreviewsBodyPlaceholder: "Assistant update",
                options: []
            ),
        ])
    }
}
