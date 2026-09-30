#!/usr/bin/env python3
"""Owner-run credential handoff. Tokens are hidden, never logged or written locally."""
import getpass
import json
import os
import subprocess

PROJECT = "bmson-assistant"
REGION = "us-west1"
SOURCE = "bmson/assistant"
WORKER = "bmson/assistant-repair-worker"


def run(args, secret_input=None, token=None, allow_failure=False):
    env = os.environ.copy()
    if token:
        env["GH_TOKEN"] = token
    result = subprocess.run(args, input=secret_input, text=True, capture_output=True, env=env)
    if result.returncode and not allow_failure:
        # Provider output could include supplied values. Report only the operation.
        raise SystemExit(f"Setup failed during {args[0]} {args[1]}. Credentials were not printed.")
    return result


def github(path, token):
    return json.loads(run(["gh", "api", path], token=token).stdout)


def main():
    print("Configure the private repair worker; automatic repair remains DISABLED until merge and release.")
    print("Create two fine-grained GitHub tokens. Do not paste them into chat.")
    print("Runtime: only assistant + assistant-repair-worker; Actions read/write, Contents read, Pull requests read.")
    print("Publisher: only assistant; Contents read/write, Pull requests read/write.")
    print("Runtime token will be sent to Google Secret Manager (bmson-assistant/github-token), mounted only on assistant-agent and assistant-web.")
    print("Publisher token will be sent to the private worker's SELF_REPAIR_GITHUB_TOKEN Actions secret.")
    if input("Type CONFIGURE to approve these exact destinations: ").strip() != "CONFIGURE":
        raise SystemExit("Cancelled; no changes made.")
    runtime = getpass.getpass("Runtime fine-grained token (hidden): ")
    publisher = getpass.getpass("Publisher fine-grained token (hidden): ")
    if not all(token.startswith("github_pat_") for token in (runtime, publisher)):
        raise SystemExit("Use dedicated fine-grained tokens; CLI login tokens are not accepted.")
    if runtime == publisher:
        raise SystemExit("Use separate runtime and publisher tokens.")
    worker = github(f"repos/{WORKER}", runtime)
    if worker.get("private") is not True:
        raise SystemExit("Worker must be private; no credentials saved.")
    if github(f"repos/{SOURCE}", publisher).get("full_name") != SOURCE:
        raise SystemExit("Unexpected source repository; no credentials saved.")
    github(f"repos/{WORKER}/actions/workflows/self-repair.yml", runtime)
    # Preflight cloud access before storing credentials; never print service env values.
    services = {}
    for name in ("assistant-agent", "assistant-web"):
        service = json.loads(run(["gcloud", "run", "services", "describe", name, f"--project={PROJECT}", f"--region={REGION}", "--format=json"]).stdout)
        account = service["spec"]["template"]["spec"].get("serviceAccountName")
        if not account:
            raise SystemExit("Explicit runtime service account is required; no credentials saved.")
        services[name] = account
    run(["gh", "secret", "set", "SELF_REPAIR_GITHUB_TOKEN", "--repo", WORKER], secret_input=publisher)
    existing = run(["gcloud", "secrets", "describe", "github-token", f"--project={PROJECT}"], allow_failure=True)
    if existing.returncode:
        run(["gcloud", "secrets", "create", "github-token", f"--project={PROJECT}", "--replication-policy=automatic", "--data-file=-", "--quiet"], secret_input=runtime)
    else:
        run(["gcloud", "secrets", "versions", "add", "github-token", f"--project={PROJECT}", "--data-file=-", "--quiet"], secret_input=runtime)
    for account in set(services.values()):
        run(["gcloud", "secrets", "add-iam-policy-binding", "github-token", f"--project={PROJECT}", f"--member=serviceAccount:{account}", "--role=roles/secretmanager.secretAccessor", "--quiet"])
    settings = f"GITHUB_REPO={SOURCE},SELF_REPAIR_WORKER_REPO={WORKER},SELF_REPAIR_REF=main,SELF_REPAIR_ENABLED=false,SELF_REPAIR_ALLOW_EXECUTOR=false,SELF_REPAIR_DAILY_LIMIT=2,SELF_REPAIR_DEPLOYMENT_URL=https://bot.bmson.com"
    for name in services:
        run(["gcloud", "run", "services", "update", name, f"--project={PROJECT}", f"--region={REGION}", "--update-secrets=GITHUB_TOKEN=github-token:latest", f"--update-env-vars={settings}", "--quiet"])
    print("Credentials installed and service configuration prepared. Automatic repair is still disabled.")
    print("After PR merge, release validation and coding-key installation, enable and verify a synthetic repair.")


if __name__ == "__main__":
    main()
