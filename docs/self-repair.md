# Automatic issue investigation and repair PRs

The assistant captures failed tasks, explicit owner corrections in chat, manual reports in Improvements, and selected self-maintenance proposals. A scheduled investigation checks the audit, separates code defects from provider/configuration/answer problems, and produces a bounded technical brief with synthetic reproduction steps. Plausible code issues with an unknown cause can reach the private coding worker for repository investigation, even without known source paths. The worker must reproduce a defect and add a regression test before any patch can be published. A suspected bad answer also reaches the private worker when there are actionable steps and expected behavior: incorrect capability claims can originate in repository routing or prompts. Preliminary labels do not establish that the repository is correct. Established provider and configuration problems stay out of the coding worker.

The worker opens a feature branch, adds a regression test, checks the patch, and creates a PR. Improvements shows the diagnosis, progress, history, worker run and PR. Manual reports can attach a related activity to supply its owner-scoped audit. Queued reports show their position and waiting reason. The existing notification channel sends the owner the PR link and reports blocked or failed investigations in the same check. A retry can receive a new notification even if it reaches the same status again. The owner reviews and merges; this flow never merges or deploys. After the merge reaches the configured deployment, the issue enters monitoring. Confirm the behavior in Improvements to mark it resolved. A matching failure after deployment starts a new linked investigation.

## Activate

1. Release these changes and the `self-repair.yml` workflow to the source repository's default branch. For PostgreSQL, apply migration 0081 and run the seed. For Firestore, provision the checked-in indexes, including `tasks(agentId, updatedAt DESC)`; the agent creates the 15-minute reconciliation schedule when enabled. New reports and retries make that schedule due immediately; the minute sweep commits the repair task and its durable queue wake. Waiting reports are also recovered on each sweep as soon as the rolling coding allowance is available. Existing disabled schedules remain disabled.
2. If the source repository is public, create a private worker repository (this installation uses `bmson/assistant-repair-worker`). Copy `.github/workflows/self-repair.yml` to its default branch and set its repository variables `SELF_REPAIR_SOURCE_REPO=bmson/assistant` and `SELF_REPAIR_SOURCE_REF=main`. It checks out an immutable source commit from the source default branch; only verified code is published back. Diagnostics, Actions logs and artifacts stay private. The public PR body omits the brief and private run link.
3. Create the repository label `self-maintenance`.
4. Add Actions secrets in the private worker repository:
   - `SELF_REPAIR_OPENAI_API_KEY`: a dedicated project API key for the coding worker.
   - `SELF_REPAIR_GITHUB_TOKEN`: a repository-scoped publisher token with Contents and Pull requests write access. Use a dedicated identity without permission to bypass protected-branch rules. This token is available only to the publish job, after checks pass. A separate token is used so creating the PR triggers ordinary PR checks.
5. Configure the assistant runtime and web service:

   ```dotenv
   GITHUB_REPO=bmson/assistant
   GITHUB_TOKEN=<runtime token: Actions read/write, Contents read, Pull requests read>
   SELF_REPAIR_WORKER_REPO=bmson/assistant-repair-worker
   SELF_REPAIR_ENABLED=true
   SELF_REPAIR_ALLOW_EXECUTOR=false
   SELF_REPAIR_DAILY_LIMIT=2
   SELF_REPAIR_WORKFLOW=self-repair.yml
   SELF_REPAIR_REF=main
   SELF_REPAIR_DEPLOYMENT_URL=https://<assistant-host>/api/health
   ```

   Match `SELF_REPAIR_REF` to the worker repository's actual default branch. Source commits are resolved from the source repository's default branch. Use separate dedicated fine-grained tokens. Runtime: restrict to source and worker repositories with Actions read/write, Contents read and Pull requests read. Publisher: restrict to the source repository with Contents and Pull requests read/write. Keep the runtime token in Secret Manager; do not copy an all-repositories CLI login token into the worker. The health endpoint must return the deployed commit SHA. Configure the normal assistant model provider for investigation and the existing notification delivery channel for owner pings. Use the installation's secret manager for runtime credentials; never commit them or pass them as visible command arguments.
6. Submit a small, reproducible report through Improvements. Confirm investigation, worker checks, PR notification, owner merge, deployment monitoring, and confirmation before relying on unattended runs. Check both SQL and Firestore paths for the selected installation backend.

The local coding key is stored in ignored `.env.local`; transfer it only to the private worker secret with explicit owner approval. The key has now been installed in this installation’s private worker. Runtime configuration loads `.env`; installing the coding key alone does not activate the worker.

## Limits and recovery

There is one active issue per owner and a default limit of two coding dispatches per rolling 24 hours (maximum configurable limit: five). The coding step has a 15-minute timeout. Investigation uses the scheduled task budget. If the preliminary review exhausts retries on a rate limit or provider outage, it tries one distinct configured fallback model within that budget. These are execution limits, not a guaranteed dollar cap; set a dedicated API project budget and monitor usage.

Patches are limited to 20 files and 100 KB. A regression test and explicit reproduction result are required. Credentials, authentication, trust controls, infrastructure, dependency/configuration files, schemas and the repair machinery are protected. Executor fixes require the separate owner-enabled tier, which permits only selected implementation files. The candidate is tested in fresh jobs without publisher credentials. Publication rechecks the exact patch that passed lint, type checking, PostgreSQL tests, Firestore tests and applicable iOS tests.

A completed investigation can conclude that no repository defect was confirmed. With an unchanged checkout and a complete explanation, this is a successful investigation without a PR; the report shows the explanation as blocked. A missing/incomplete result, changed files without confirmed reproduction, or failed checks remain failures. The private worker retains its investigation result for seven days, including when later patch checks fail.

An uncertain dispatch is reconciled by repair UUID, branch and workflow run before retry. A missing run eventually becomes failed; interrupted investigations expire. Failed or blocked issues expose Retry, which clears the old diagnosis and joins the back of the queue; active coding/PR issues cannot be dismissed. Closed PRs become dismissed. Deployment is recorded separately from confirmation of a fix. Disabling `SELF_REPAIR_ENABLED` stops new investigations, dispatches and polling; already-dispatched GitHub runs must be cancelled separately if needed.

Raw conversations and audits stay in the assistant installation. Reports are scrubbed before storage; the worker receives a technical brief rather than the original audit or owner message. Model-generated briefs still need care: the investigation prompt requires synthetic data, and the worker repository must be private. Repair records participate in privacy erasure.

## Secure credential handoff for this installation

GitHub does not let this setup create a fine-grained personal token through the CLI. The owner creates and enters these credentials. Two prefilled forms help choose the permissions; select only the repositories specified:

- [Runtime token](https://github.com/settings/personal-access-tokens/new?name=Assistant%20repair%20runtime&target_name=bmson&expires_in=90&actions=write&contents=read&pull_requests=read): `assistant` and `assistant-repair-worker`.
- [Publisher token](https://github.com/settings/personal-access-tokens/new?name=Assistant%20repair%20publisher&target_name=bmson&expires_in=90&contents=write&pull_requests=write): `assistant` only.

Run `python3 scripts/configure-self-repair.py` from the repository. Enter the tokens only into its hidden prompts. It explains and confirms the exact destinations, verifies account/repository access, installs the publisher secret in the private worker, and installs the runtime credential in Google Secret Manager. It preserves existing service settings and mounts the credential only on the two application services. It never prints or saves the tokens locally, rejects broad CLI credentials and keeps automatic repair disabled until merge, release and a synthetic end-to-end check. Tokens expire after 90 days and need rotation. The OpenAI coding key is installed separately with explicit transfer approval.

The owner-facing setup tool is scoped to `bmson-assistant` in `us-west1`; other installations should adapt the constants and repository settings before running it.

Queued, failed, and blocked reports offer **Run now** on web and iPhone. This authenticated owner action authorizes one investigation attempt beyond the automatic daily dispatch allowance. The request is consumed atomically when claimed; double clicks cannot authorize duplicate coding runs. Another active investigation or PR review still takes precedence, and model spending budgets, provider quota, protected paths, and owner PR review remain enforced. Triage has a one-minute provider deadline and at most one fresh minute on a distinct configured fallback.

Feature requests are actionable work. Triage labels them as features and the worker demonstrates the missing requested behavior with an acceptance test, implements it, and checks that the test passes. Intentional current behavior is not a reason to decline a requested feature. Already implemented, unclear, or protected changes still require an explanation rather than a fabricated patch. Coding, test, PR, and deployment states are reconciled on each minute sweep in Firestore installations.
