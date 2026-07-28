# Self-hosting on Google Cloud Run

The supported production shape is two scale-to-zero Cloud Run services plus optional isolated Cloud
Run Jobs. PostgreSQL is external (Neon or another PostgreSQL 17-compatible provider with pgvector).

## Prerequisites

- a Google Cloud project with billing enabled;
- `gcloud` authenticated with permission to create IAM, Cloud Run, storage, Pub/Sub, Scheduler,
  Cloud Tasks, Artifact Registry, Cloud Build, and Secret Manager resources;
- a production PostgreSQL connection string;
- an OpenRouter key;
- a Google OAuth client for dashboard login;
- Node.js 22+ and pnpm 10+ on the provisioning machine.

Google Workspace OAuth, Twilio, search, and worker modules are optional.

## Configure

Create `.env` if needed:

```sh
pnpm setup -- \
  --owner-email=you@example.com \
  --owner-name="Your name" \
  --assistant-email=assistant@example.com \
  --assistant-name=Assistant \
  --workspace-id=assistant \
  --timezone=America/Los_Angeles \
  --modules=google,reminders,search
```

Set these values in `.env`:

```dotenv
PROD_DATABASE_URL=postgres://...
OPENROUTER_API_KEY=...
GCP_PROJECT=your-project-id
GCP_LOCATION=us-west1
ARTIFACT_REPOSITORY=assistant

AUTH_GOOGLE_ID=...
AUTH_GOOGLE_SECRET=...
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
```

The same OAuth client may be used for the web login and assistant account when its redirect URIs and
consent configuration cover both flows. Add module-specific values from [the module reference](modules.md).

Validate before provisioning:

```sh
pnpm config:check
gcloud auth login
gcloud config set project your-project-id
```

## Provision and deploy

```sh
bash infra/gcp/deploy.sh
```

The script is idempotent. It:

1. migrates and reconciles the database;
2. enables required Google APIs;
3. creates least-privilege runtime identities;
4. creates versioned workspace and expiring trace buckets;
5. writes secrets without logging their values;
6. builds immutable containers;
7. deploys web and agent services;
8. deploys only the isolated worker jobs selected by `ASSISTANT_MODULES`;
9. creates the queue and scheduled sweep;
10. creates Gmail Scheduler/Pub/Sub only when the Google module is enabled.

At completion it prints service URLs and the remaining OAuth, Gmail, custom-domain, or Twilio steps
that apply to the selected modules.

## Web login

Add the printed callback to the Google OAuth client's authorized redirect URIs:

```text
https://YOUR_WEB_URL/api/auth/callback/google
```

Only the exact `OWNER_EMAIL` with a Google-verified email claim may sign in. Production never honors
`AUTH_DEV_BYPASS=true`. The Compose quickstart uses the separate `AUTH_LOCALHOST_BYPASS` guard, which
is accepted only with a loopback `AUTH_URL` and local queue driver.

For the assistant's own Google Workspace identity, follow [OAuth setup](../infra/gcp/oauth-setup.md)
and run:

```sh
pnpm auth:bot
bash infra/gcp/deploy.sh
```

The second provision updates the refresh-token secret and activates Google tools.

## Releases

After the first provision:

```sh
GCP_PROJECT=your-project-id bash infra/gcp/release.sh
```

`release.sh` builds or consumes immutable images, creates a release-tagged PostgreSQL backup, runs
database reconciliation as a Cloud Run Job, updates selected services/jobs, repairs Scheduler OIDC,
and verifies that the web service reports the released commit. CI scans and signs every image and
attaches its SPDX SBOM.

GitHub OIDC deployment is optional and documented in `infra/gcp/github-actions.md`.
Restore instructions and migration compatibility rules are in [recovery.md](recovery.md).

## Costs and scaling

Both services default to zero minimum instances. Worker jobs exist only for bounded tasks. The fixed
cost is primarily the PostgreSQL provider and any Google Workspace seat; model, search, Twilio, job,
and storage usage scale with activity. Configure provider-side spending limits in addition to the
application budgets.

For what your specific selection costs, ask the module plan:

```sh
pnpm modules:plan --billing
```

It lists third-party services that bill directly — the model gateway, the PostgreSQL provider,
Twilio, a search provider — separately from the Google Cloud services each enabled module adds,
noting which normally stay inside the always-free allowance. The same declarations drive
provisioning, so the explanation cannot drift from what is actually deployed.
