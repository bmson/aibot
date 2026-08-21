# Assistant for iOS

The native SwiftUI client keeps the agent runtime on the existing Assistant server. It provides:

- streamed chat with the companion expression and color cues;
- background polling for long-running turns and proactive updates;
- native Activity, Goals, Approvals, Documents, and memory summaries;
- a chat-first shell with no persistent navigation chrome; pull beyond the latest message to reveal controls;
- a Live Activity with compact, minimal, and expanded Dynamic Island presentations;
- opt-in local notifications for completed work and approval handoffs;
- deliberate confirmation before approving or denying outward actions;
- a Keychain-stored mobile credential, Dynamic Type, dark mode, and Reduce Motion support.

Open findings on the visual and interaction layer are tracked in
[`docs/visual-qa.md`](docs/visual-qa.md).

## Run locally

1. Start the database, agent, and web service with `pnpm dev` (or `docker compose up --build`).
2. Open `Assistant.xcodeproj` in Xcode 26 or newer.
3. Select the `Assistant` scheme and an iPhone simulator.
4. Connect to `http://localhost:3000`. With source development's explicit `AUTH_DEV_BYPASS=true`,
   the access-key field can remain empty.

The project targets iOS 18 and contains no third-party iOS dependencies.

## System surfaces

Long-running turns start a Live Activity automatically. Tool progress updates its Dynamic Island
line, approval waits remain visible in amber, and completed work settles briefly before the activity
closes. Tapping an attention activity opens the Approvals sheet through `assistant://approvals`.

Notifications are opt-in under Settings. Approval requests carry inline **Approve** / **Deny**
actions (device unlock required) and may banner even while the app is open; routine updates post
only while the app is inactive, avoiding duplicate banners while the conversation is visible.
The app icon badge mirrors the pending-approval count. These are device-local notifications for
turns the app is able to observe. Delivery after the app has been force-quit requires a future
APNs provider integration and Apple signing credentials; no provider credential is embedded in
the client.

## Connect a deployed server

The web UI has a self-serve pairing panel under **Settings → Mobile app**: it shows the server
URL and lets you generate or rotate the access key. The stored key is never displayed — the full
value is revealed once, when it is generated, so copy it into the app's Connection screen right
away.

The app sends the key as a bearer token only to the configured server and stores it with
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Use HTTPS for any non-local server.

The manual path still exists for Cloud Run deployments (where the web process has no writable
`.env`): set `MOBILE_API_TOKEN` in your local `.env` (`openssl rand -hex 32`) and run
`bash infra/gcp/deploy.sh` to publish it to Secret Manager. `deploy.sh` also creates the token
automatically on first provision when it is missing, and a regular release preserves the web
service's existing secret binding.

## Verify

```sh
xcrun simctl list devices available

xcodebuild -project apps/ios/Assistant.xcodeproj \
  -scheme Assistant \
  -destination 'platform=iOS Simulator,id=<SIMULATOR_UDID>' \
  test
```

The mobile API is versioned under `/api/mobile/v1`. It is a presentation transport over existing
application use cases; the phone never receives database or model-provider credentials.
