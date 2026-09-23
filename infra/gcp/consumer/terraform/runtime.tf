# This profile is separate from the verified foundation archive used by the
# installer. Nothing below exists until both immutable image digests are given.
locals {
  runtime_requested = var.web_image_digest != null || var.agent_image_digest != null || var.allow_public_web_invoker
  runtime_enabled   = var.web_image_digest != null && var.agent_image_digest != null
  runtime_instances = local.runtime_enabled ? { current = true } : {}
  runtime_labels = merge(local.installation_labels, {
    profile = "consumer-runtime"
  })

  runtime_common_env = {
    ASSISTANT_MODULES         = "minimal"
    ASSISTANT_WORKSPACE_ID    = var.installation_id
    FIRESTORE_AGENT_ID        = var.firestore_agent_id
    FIRESTORE_EMBEDDING_SPACE = jsonencode(var.firestore_embedding_space)
    GCP_PROJECT               = var.project_id
    GCP_LOCATION              = var.region
    PERSISTENCE_DRIVER        = "firestore"
    QUEUE_DRIVER              = "local"
    LLM_PROVIDER              = "vertex"
    VERTEX_PROJECT            = var.project_id
    VERTEX_LOCATION           = var.region
    CANARY_ENABLED            = "false"
    AUTH_DEV_BYPASS           = "false"
    AUTH_LOCALHOST_BYPASS     = "false"
  }

  web_env = merge(local.runtime_common_env, {
    OWNER_EMAIL     = var.owner_email
    AUTH_URL        = var.web_auth_url
    AUTH_TRUST_HOST = "true"
  })

  agent_env = merge(local.runtime_common_env, {
    FILES_DRIVER     = "gcs"
    WORKSPACE_BUCKET = google_storage_bucket.assets.name
  })

  # These exact secret names and numbered versions are supplied in the
  # customer project before runtime apply. No secret payload enters state.
  web_auth_secrets = {
    AUTH_SECRET = {
      id      = "${var.installation_id}-auth-secret"
      version = var.auth_secret_version
    }
    AUTH_GOOGLE_ID = {
      id      = "${var.installation_id}-google-client-id"
      version = var.google_client_id_version
    }
    AUTH_GOOGLE_SECRET = {
      id      = "${var.installation_id}-google-client-secret"
      version = var.google_client_secret_version
    }
  }
}

resource "terraform_data" "runtime_input_guard" {
  for_each = local.runtime_requested ? { current = true } : {}

  lifecycle {
    precondition {
      condition     = local.runtime_enabled
      error_message = "Provide both web_image_digest and agent_image_digest to opt in to the runtime."
    }
    precondition {
      condition     = var.firestore_database_id == "(default)"
      error_message = "The current Firestore web and agent composition opens only the (default) database."
    }
    precondition {
      condition     = var.firestore_agent_id != null && var.firestore_embedding_space != null
      error_message = "Runtime requires an explicit seeded Firestore agent ID and embedding provenance."
    }
    precondition {
      condition     = var.owner_email != null && var.web_auth_url != null
      error_message = "Runtime requires an owner email and the configured HTTPS Google OAuth origin."
    }
    precondition {
      condition = (
        var.auth_secret_version != null &&
        var.google_client_id_version != null &&
        var.google_client_secret_version != null
      )
      error_message = "Runtime requires numbered versions of the three existing owner-auth secrets."
    }
  }
}

resource "google_project_service" "runtime" {
  for_each = local.runtime_enabled ? toset([
    "aiplatform.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
  ]) : toset([])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false

  depends_on = [terraform_data.runtime_input_guard]
}

resource "google_service_account" "web" {
  for_each = local.runtime_instances

  project      = var.project_id
  account_id   = "${var.installation_id}-web"
  display_name = "${var.installation_id} Firestore web"
  description  = "Minimal customer-owned Firestore chat web identity."

  depends_on = [google_project_service.runtime]
}

resource "google_project_iam_member" "web_firestore" {
  for_each = local.runtime_instances

  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.web[each.key].email}"

  condition {
    title       = "assistant_web_installation_database"
    description = "Limit web chat datastore access to this installation database."
    expression  = "resource.name == \"projects/${var.project_id}/databases/${var.firestore_database_id}\""
  }
}

resource "google_project_iam_member" "agent_vertex" {
  for_each = local.runtime_instances

  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"

  depends_on = [google_project_service.runtime]
}

# Web chat can classify and stream a direct reply before queuing an action, so
# it needs Vertex access as well as the background agent.
resource "google_project_iam_member" "web_vertex" {
  for_each = local.runtime_instances

  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.web[each.key].email}"

  depends_on = [google_project_service.runtime]
}

resource "google_secret_manager_secret_iam_member" "web_auth" {
  for_each = local.runtime_enabled ? local.web_auth_secrets : {}

  project   = var.project_id
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web["current"].email}"

  depends_on = [google_project_service.runtime]
}

resource "google_cloud_run_v2_service" "agent" {
  for_each = local.runtime_instances

  project     = var.project_id
  location    = var.region
  name        = "${var.installation_id}-agent"
  description = "Customer-owned minimal Firestore agent and local task poller."
  # Cloud Run web traffic is not recognized as internal without VPC routing.
  # Keep IAM invocation mandatory; only the dedicated web identity is granted it.
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = false
  deletion_protection  = true
  labels               = local.runtime_labels

  scaling {
    min_instance_count = 1
    max_instance_count = 1
  }

  template {
    service_account                  = google_service_account.runtime.email
    max_instance_request_concurrency = 4

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repository_id}/agent@${var.agent_image_digest}"

      ports {
        container_port = 8080
      }

      resources {
        limits   = { cpu = "1", memory = "1Gi" }
        cpu_idle = false
      }

      dynamic "env" {
        for_each = local.agent_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [
    terraform_data.runtime_input_guard,
    google_project_iam_member.agent_vertex,
    google_project_iam_member.runtime_firestore,
    google_storage_bucket_iam_member.runtime_assets,
  ]
}

resource "google_cloud_run_v2_service" "web" {
  for_each = local.runtime_instances

  project              = var.project_id
  location             = var.region
  name                 = "${var.installation_id}-web"
  description          = "Customer-owned minimal Firestore chat web service."
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = false
  deletion_protection  = true
  labels               = local.runtime_labels

  scaling {
    min_instance_count = 0
    max_instance_count = 2
  }

  template {
    service_account                  = google_service_account.web[each.key].email
    max_instance_request_concurrency = 20

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repository_id}/web@${var.web_image_digest}"

      ports {
        container_port = 8080
      }

      resources {
        limits   = { cpu = "1", memory = "1Gi" }
        cpu_idle = true
      }

      dynamic "env" {
        for_each = local.web_env
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name  = "AGENT_URL"
        value = google_cloud_run_v2_service.agent[each.key].uri
      }

      dynamic "env" {
        for_each = local.web_auth_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = "projects/${var.project_id}/secrets/${env.value.id}"
              version = env.value.version == null ? "0" : tostring(env.value.version)
            }
          }
        }
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [
    terraform_data.runtime_input_guard,
    google_project_iam_member.web_firestore,
    google_project_iam_member.web_vertex,
    google_secret_manager_secret_iam_member.web_auth,
  ]
}

# The agent has no anonymous invoker binding. Web's own Cloud Run identity can
# present an audience-bound ID token to read its secret-safe /ready response.
resource "google_cloud_run_v2_service_iam_member" "agent_web_invoker" {
  for_each = local.runtime_instances

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.agent[each.key].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.web[each.key].email}"
}

# Cloud Run IAM stays private by default. This is an explicit second gate:
# application Google OAuth must be configured before anonymous invocation is
# allowed through to its own owner-auth middleware.
resource "google_cloud_run_v2_service_iam_member" "web_public" {
  for_each = local.runtime_enabled && var.allow_public_web_invoker ? local.runtime_instances : {}

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web[each.key].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "web_service_account_email" {
  description = "Dedicated web identity, or null when runtime images were not supplied."
  value       = try(google_service_account.web["current"].email, null)
}

output "cloud_run_web_service_name" {
  description = "Configured private-by-default web service name; not a readiness signal."
  value       = try(google_cloud_run_v2_service.web["current"].name, null)
}

output "cloud_run_web_uri" {
  description = "Cloud Run web URI, or null without runtime images. OAuth/public access still require separate validation."
  value       = try(google_cloud_run_v2_service.web["current"].uri, null)
}

output "cloud_run_agent_service_name" {
  description = "Configured private agent service name; not a readiness signal."
  value       = try(google_cloud_run_v2_service.agent["current"].name, null)
}

output "cloud_run_agent_uri" {
  description = "Private agent URI, or null without runtime images."
  value       = try(google_cloud_run_v2_service.agent["current"].uri, null)
}
