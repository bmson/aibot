mock_provider "google" {}

override_resource {
  target          = google_service_account.web
  override_during = plan
  values = {
    email = "assistant-test-web@consumer-test-project.iam.gserviceaccount.com"
  }
}

override_resource {
  target          = google_cloud_run_v2_service.agent
  override_during = plan
  values = {
    uri = "https://assistant-test-agent-abc.us-west1.a.run.app"
  }
}

variables {
  project_id              = "consumer-test-project"
  region                  = "us-west1"
  installation_id         = "assistant-test"
  firestore_database_id   = "(default)"
  create_default_database = true
  firestore_location_id   = "us-west1"
  assets_bucket_name      = "consumer-test-project-assets"
  source_bucket_name      = "consumer-test-project-source"
  artifact_repository_id  = "assistant-test"

  firestore_agent_id = "11111111-1111-4111-8111-111111111111"
  firestore_embedding_space = {
    provider   = "vertex"
    model      = "text-embedding-005"
    dimensions = 768
    revision   = "customer-seed-v1"
  }
  owner_email                  = "owner@example.com"
  web_auth_url                 = "https://assistant.example.com"
  auth_secret_version          = 2
  google_client_id_version     = 3
  google_client_secret_version = 4
}

run "foundation_without_images_has_no_runtime_resources" {
  command = plan

  assert {
    condition = (
      length(google_project_service.runtime) == 0 &&
      length(google_cloud_run_v2_service.web) == 0 &&
      length(google_cloud_run_v2_service.agent) == 0 &&
      length(google_service_account.web) == 0 &&
      length(google_secret_manager_secret_iam_member.web_auth) == 0 &&
      length(google_cloud_run_v2_service_iam_member.agent_web_invoker) == 0 &&
      length(google_cloud_run_v2_service_iam_member.web_public) == 0
    )
    error_message = "Supplying no digests must preserve the foundation-only resource set."
  }
  assert {
    condition     = output.cloud_run_web_service_name == null && output.cloud_run_agent_service_name == null
    error_message = "Foundation-only output must not imply a deployed runtime."
  }
}

run "digest_pinned_private_runtime_uses_minimal_firestore_profile" {
  command = plan
  variables {
    web_image_digest   = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    agent_image_digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }

  assert {
    condition = (
      google_cloud_run_v2_service.web["current"].template[0].containers[0].image == "us-west1-docker.pkg.dev/consumer-test-project/assistant-test/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" &&
      google_cloud_run_v2_service.agent["current"].template[0].containers[0].image == "us-west1-docker.pkg.dev/consumer-test-project/assistant-test/agent@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    )
    error_message = "Both services must use immutable digests from the customer repository."
  }
  assert {
    condition = (
      google_cloud_run_v2_service.web["current"].invoker_iam_disabled == false &&
      length(google_cloud_run_v2_service_iam_member.web_public) == 0 &&
      google_cloud_run_v2_service.agent["current"].ingress == "INGRESS_TRAFFIC_ALL" &&
      google_cloud_run_v2_service.agent["current"].invoker_iam_disabled == false &&
      google_cloud_run_v2_service_iam_member.agent_web_invoker["current"].role == "roles/run.invoker" &&
      google_cloud_run_v2_service_iam_member.agent_web_invoker["current"].member == "serviceAccount:assistant-test-web@consumer-test-project.iam.gserviceaccount.com" &&
      google_cloud_run_v2_service_iam_member.agent_web_invoker["current"].name == google_cloud_run_v2_service.agent["current"].name
    )
    error_message = "Agent invocation must be IAM-private and limited to the dedicated web identity."
  }
  assert {
    condition = (
      google_cloud_run_v2_service.agent["current"].scaling[0].min_instance_count == 1 &&
      google_cloud_run_v2_service.agent["current"].scaling[0].max_instance_count == 1 &&
      google_cloud_run_v2_service.agent["current"].template[0].containers[0].resources[0].cpu_idle == false
    )
    error_message = "The local Firestore poller needs one always-CPU agent instance."
  }
  assert {
    condition = (
      one([for env in google_cloud_run_v2_service.agent["current"].template[0].containers[0].env : env.value if env.name == "PERSISTENCE_DRIVER"]) == "firestore" &&
      one([for env in google_cloud_run_v2_service.agent["current"].template[0].containers[0].env : env.value if env.name == "ASSISTANT_MODULES"]) == "minimal" &&
      one([for env in google_cloud_run_v2_service.agent["current"].template[0].containers[0].env : env.value if env.name == "QUEUE_DRIVER"]) == "local" &&
      one([for env in google_cloud_run_v2_service.web["current"].template[0].containers[0].env : env.value if env.name == "AUTH_DEV_BYPASS"]) == "false" &&
      one([for env in google_cloud_run_v2_service.web["current"].template[0].containers[0].env : env.value if env.name == "AGENT_URL"]) == "https://assistant-test-agent-abc.us-west1.a.run.app"
    )
    error_message = "Runtime must use the explicit minimal Firestore profile and agent URI without auth bypass."
  }
  assert {
    condition = (
      google_project_iam_member.web_firestore["current"].condition[0].expression == "resource.name == \"projects/consumer-test-project/databases/(default)\"" &&
      google_project_iam_member.agent_vertex["current"].role == "roles/aiplatform.user" &&
      google_project_iam_member.web_vertex["current"].role == "roles/aiplatform.user" &&
      google_secret_manager_secret_iam_member.web_auth["AUTH_SECRET"].secret_id == "assistant-test-auth-secret" &&
      one([for env in google_cloud_run_v2_service.web["current"].template[0].containers[0].env : env.value_source[0].secret_key_ref[0].version if env.name == "AUTH_SECRET"]) == "2"
    )
    error_message = "Web database access, agent Vertex access, and numbered auth-secret references must be scoped."
  }
}

run "single_image_is_rejected" {
  command = plan
  variables {
    web_image_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [terraform_data.runtime_input_guard["current"]]
}

run "named_database_runtime_is_rejected" {
  command = plan
  variables {
    firestore_database_id = "assistant-named"
    web_image_digest      = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    agent_image_digest    = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
  expect_failures = [terraform_data.runtime_input_guard["current"]]
}

run "missing_auth_secret_version_is_rejected" {
  command = plan
  variables {
    google_client_secret_version = null
    web_image_digest             = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    agent_image_digest           = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
  expect_failures = [terraform_data.runtime_input_guard["current"]]
}

run "mutable_image_reference_is_rejected" {
  command = plan
  variables {
    web_image_digest = "web:latest"
  }
  expect_failures = [var.web_image_digest]
}

run "public_opt_in_without_runtime_is_rejected" {
  command = plan
  variables {
    allow_public_web_invoker = true
  }
  expect_failures = [terraform_data.runtime_input_guard["current"]]
}

run "public_invocation_requires_separate_opt_in" {
  command = plan
  variables {
    web_image_digest         = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    agent_image_digest       = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    allow_public_web_invoker = true
  }
  assert {
    condition = (
      google_cloud_run_v2_service_iam_member.web_public["current"].member == "allUsers" &&
      google_cloud_run_v2_service_iam_member.web_public["current"].name == google_cloud_run_v2_service.web["current"].name &&
      google_cloud_run_v2_service.agent["current"].ingress == "INGRESS_TRAFFIC_ALL" &&
      google_cloud_run_v2_service.agent["current"].invoker_iam_disabled == false &&
      google_cloud_run_v2_service_iam_member.agent_web_invoker["current"].member != "allUsers"
    )
    error_message = "Only web invocation may become public after explicit opt-in; agent IAM remains private."
  }
}
