locals {
  installation_labels = {
    installation = var.installation_id
    managed_by   = "terraform"
    profile      = "consumer-foundation"
  }

  required_services = toset([
    "artifactregistry.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
  ])
}

resource "google_project_service" "required" {
  for_each = local.required_services

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_firestore_database" "consumer" {
  project                 = var.project_id
  name                    = var.firestore_database_id
  location_id             = var.firestore_location_id
  type                    = "FIRESTORE_NATIVE"
  database_edition        = "STANDARD"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "PREVENT"

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.firestore_database_id != "(default)" || var.create_default_database
      error_message = "Creating (default) requires create_default_database=true after verifying that no default database already exists in the fresh customer project. Existing databases must not be imported or adopted."
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket" "assets" {
  project                     = var.project_id
  name                        = var.assets_bucket_name
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.installation_labels

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 604800
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.assets_bucket_name != var.source_bucket_name
      error_message = "assets_bucket_name and source_bucket_name must be different customer-owned buckets."
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket" "source" {
  project                     = var.project_id
  name                        = var.source_bucket_name
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.installation_labels

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 604800
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required]
}

resource "google_artifact_registry_repository" "consumer" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_repository_id
  description   = "Customer-owned assistant images for ${var.installation_id}"
  format        = "DOCKER"
  labels        = local.installation_labels

  docker_config {
    immutable_tags = true
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required]
}

resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "${var.installation_id}-runtime"
  display_name = "${var.installation_id} assistant runtime"
  description  = "Runtime identity for the customer-owned assistant installation."

  depends_on = [google_project_service.required]
}

# Firestore IAM is project-scoped. The condition narrows the database role to
# the selected installation database without granting project administration or
# service-account impersonation.
resource "google_project_iam_member" "runtime_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"

  condition {
    title       = "assistant_installation_database"
    description = "Limit runtime datastore access to this installation database."
    expression  = "resource.name == \"projects/${var.project_id}/databases/${var.firestore_database_id}\""
  }
}

resource "google_storage_bucket_iam_member" "runtime_assets" {
  bucket = google_storage_bucket.assets.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.runtime.email}"
}
