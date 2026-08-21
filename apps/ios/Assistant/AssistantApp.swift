import SwiftUI

@main
struct AssistantApp: App {
    @StateObject private var model = AppModel()

    init() {
        // Set the notification delegate and register categories before iOS can
        // deliver a launch response from a tapped notification.
        _ = NotificationManager.shared
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
        }
    }
}
