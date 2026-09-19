# Mocked provider plans exercise creation guards without credentials or cloud calls.
mock_provider "google" {}

variables {
  project_id             = "consumer-test-project"
  region                 = "us-west1"
  installation_id        = "assistant-test"
  firestore_location_id  = "us-west1"
  assets_bucket_name     = "consumer-test-project-assets"
  source_bucket_name     = "consumer-test-project-source"
  artifact_repository_id = "assistant-test"
}

run "default_requires_explicit_creation_intent" {
  command = plan
  variables {
    firestore_database_id = "(default)"
  }
  expect_failures = [google_firestore_database.consumer]
}

run "default_creation_is_database_scoped" {
  command = plan
  variables {
    firestore_database_id   = "(default)"
    create_default_database = true
  }
  assert {
    condition     = google_firestore_database.consumer.name == "(default)"
    error_message = "Default creation must not silently fall back to a named database."
  }
  assert {
    condition     = google_project_iam_member.runtime_firestore.condition[0].expression == "resource.name == \"projects/consumer-test-project/databases/(default)\""
    error_message = "Runtime access must be limited to the selected database."
  }
  assert {
    condition     = google_firestore_database.consumer.delete_protection_state == "DELETE_PROTECTION_ENABLED"
    error_message = "Default database must retain server-side deletion protection."
  }
  assert {
    condition     = google_firestore_database.consumer.point_in_time_recovery_enablement == "POINT_IN_TIME_RECOVERY_ENABLED"
    error_message = "Consistent managed snapshot exports require point-in-time recovery."
  }
}

run "named_creation_remains_explicit" {
  command = plan
  variables {
    firestore_database_id = "assistant-test-db"
  }
  assert {
    condition     = google_firestore_database.consumer.name == "assistant-test-db"
    error_message = "An explicitly selected named database must retain its identity."
  }
  assert {
    condition     = google_project_iam_member.runtime_firestore.condition[0].expression == "resource.name == \"projects/consumer-test-project/databases/assistant-test-db\""
    error_message = "A named database must not grant project-wide data access."
  }
}

run "uuid_database_is_rejected" {
  command = plan
  variables {
    firestore_database_id = "01234567-89ab-cdef-0123-456789abcdef"
  }
  expect_failures = [var.firestore_database_id]
}

run "application_indexes_use_selected_database" {
  command = plan
  variables {
    firestore_database_id = "assistant-index-test"
  }
  assert {
    condition = alltrue([
      for index in google_firestore_index.application :
      index.project == "consumer-test-project" && index.database == "assistant-index-test" && index.query_scope == "COLLECTION"
    ])
    error_message = "Application indexes must use collection scope in the customer-selected database."
  }
  assert {
    condition = anytrue([
      for index in google_firestore_index.application :
      index.collection == "messages" && anytrue([
        for field in index.fields :
        field.field_path == "embedding" && anytrue([for vector in field.vector_config : vector.dimension == 1536 && length(vector.flat) == 1])
      ])
    ])
    error_message = "Historical message recall requires a 1536-dimensional flat vector index."
  }
  assert {
    condition = anytrue([
      for index in google_firestore_index.application :
      index.collection == "tasks" && tolist([for field in index.fields : field.field_path]) == tolist(["agentId", "trigger.payload.refreshCardId", "status", "createdAt"])
    ])
    error_message = "Active card refresh deduplication requires its filtered task index."
  }
  assert {
    condition = (
      google_firestore_field.unindexed_payload["toolCalls/result"].database == "assistant-index-test" &&
      length(google_firestore_field.unindexed_payload["toolCalls/result"].index_config[0].indexes) == 0
    )
    error_message = "Large tool results must have single-field indexing disabled in the selected database."
  }
}
