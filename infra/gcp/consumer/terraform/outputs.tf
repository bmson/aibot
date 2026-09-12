output "project_id" {
  description = "Customer project owning the installation."
  value       = var.project_id
}

output "region" {
  description = "Configured compute and Artifact Registry region."
  value       = var.region
}

output "installation_id" {
  description = "Stable installation identifier."
  value       = var.installation_id
}

output "firestore_database_name" {
  description = "Named Firestore Native database resource name."
  value       = google_firestore_database.consumer.name
}

output "assets_bucket_name" {
  description = "Private customer-owned assets bucket."
  value       = google_storage_bucket.assets.name
}

output "source_bucket_name" {
  description = "Private customer-owned source archive bucket."
  value       = google_storage_bucket.source.name
}

output "artifact_registry_repository" {
  description = "Customer-owned Artifact Registry repository resource name."
  value       = google_artifact_registry_repository.consumer.name
}

output "runtime_service_account_email" {
  description = "Runtime identity email for future Cloud Run services."
  value       = google_service_account.runtime.email
}
