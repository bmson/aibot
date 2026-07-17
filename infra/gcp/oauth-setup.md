# Google OAuth setup for the bot account (one-time, ~10 minutes)

Goal: an OAuth client the assistant uses to act as `bot@bmson.com` (its own Gmail + Calendar). No domain-wide delegation — the bot authorizes itself once via `pnpm auth:bot`.

## 1. GCP project

1. Go to https://console.cloud.google.com → create project **`bmson-assistant`**.
   **Important:** create it under the **bmson.com organization** (not "No organization") — that's what makes the Internal consent screen possible, which exempts the app from Google's restricted-scope verification.
2. Enable APIs (APIs & Services → Library): **Gmail API**, **Google Calendar API**, **Google Docs API**, **Google Drive API**. (Pub/Sub comes later, with push notifications.)

## 2. OAuth consent screen

APIs & Services → OAuth consent screen:
- User type: **Internal** ← the whole trick; only bmson.com users can authorize, and no Google review is needed for Gmail's restricted scopes.
- App name: `Assistant`, support email: you.
- Scopes: you can leave this empty — scopes are requested at authorization time.

## 3. OAuth client

APIs & Services → Credentials → Create credentials → **OAuth client ID**:
- Application type: **Web application**
- Name: `assistant-bot`
- Authorized redirect URIs: `http://localhost:8123/callback`
- Copy the **Client ID** and **Client secret** into `.env`:
  ```
  GOOGLE_OAUTH_CLIENT_ID=...
  GOOGLE_OAUTH_CLIENT_SECRET=...
  ```

## 4. Trust the app (Workspace admin)

Gmail is a "restricted service" inside Workspace, so the client must be trusted:
admin.google.com → Security → Access and data control → **API controls** → App access control → Manage third-party app access → add your app by its Client ID → **Trusted**.

## 5. Authorize the bot

```sh
pnpm auth:bot
```
Open the printed URL **signed in as `bot@bmson.com`** (use a private window if needed), approve, done — the refresh token lands in `.env` as `BOT_GOOGLE_REFRESH_TOKEN`.

## Notes

- The refresh token survives indefinitely (Internal apps have no 7-day expiry) but **dies if the bot account's password changes** — rerun step 5 if that happens.
- Adding scopes (e.g. Docs/Drive) means the existing refresh token lacks them — **rerun step 5** after enabling the new APIs so the bot re-consents to the fuller scope set. Until then `docs.*` tools return a Google "insufficient scope" error.
- Later (web auth, Phase 7): the same client can carry the production redirect URI for Auth.js sign-in, or use a separate client — either is fine.
