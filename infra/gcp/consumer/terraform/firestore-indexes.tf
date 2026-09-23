locals {
  firestore_index_spec = jsondecode(file("${path.module}/../../firestore/firestore.indexes.json"))
  firestore_indexes = {
    for index in local.firestore_index_spec.indexes :
    "${index.collectionGroup}-${substr(sha256(jsonencode(index)), 0, 16)}" => index
  }
  firestore_field_exemptions = {
    for field in local.firestore_index_spec.fieldOverrides :
    "${field.collectionGroup}/${field.fieldPath}" => field
  }
}

# The same checked-in specification drives installation and live validation.
resource "google_firestore_index" "application" {
  for_each = local.firestore_indexes

  project     = var.project_id
  database    = google_firestore_database.consumer.name
  collection  = each.value.collectionGroup
  query_scope = each.value.queryScope
  # Index backfills can exceed a short-lived gcloud OAuth token. The installer
  # separately checks every live index is READY before recording provisioning.
  skip_wait = true

  lifecycle {
    # Firestore inserts an implicit __name__ field before vector fields. The
    # provider reads that ordering back as a different fields list and would
    # otherwise replace a healthy index on every subsequent apply. A changed
    # index specification changes its for_each key, while the installer checks
    # the exact live definition and READY state before provisioning.
    ignore_changes = [fields]
  }

  dynamic "fields" {
    for_each = each.value.fields
    content {
      field_path   = fields.value.fieldPath
      order        = try(fields.value.order, null)
      array_config = try(fields.value.arrayConfig, null)
      dynamic "vector_config" {
        for_each = try([fields.value.vectorConfig], [])
        content {
          dimension = vector_config.value.dimension
          flat {}
        }
      }
    }
  }
}

# Large content/payload fields are never queried. Avoid indexing their map leaves.
resource "google_firestore_field" "unindexed_payload" {
  for_each = local.firestore_field_exemptions

  project    = var.project_id
  database   = google_firestore_database.consumer.name
  collection = each.value.collectionGroup
  field      = each.value.fieldPath

  # Exemption updates can take longer than the short-lived installer OAuth token.
  # The installer independently verifies the live field config before provisioning.
  skip_wait = true

  index_config {}

  lifecycle {
    precondition {
      condition     = length(each.value.indexes) == 0
      error_message = "This resource supports only complete single-field exemptions. Explicit field indexes need a corresponding Terraform configuration."
    }
  }
}
