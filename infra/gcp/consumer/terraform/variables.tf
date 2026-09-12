variable "project_id" {
  description = "Customer-owned Google Cloud project that owns this installation."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be an explicit valid Google Cloud project ID."
  }
}

variable "region" {
  description = "Customer-selected compute and Artifact Registry region."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+[0-9]$", var.region))
    error_message = "region must be an explicit Google Cloud region such as us-central1."
  }
}

variable "installation_id" {
  description = "Stable installation identifier used in labels and service identity names."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,19}[a-z0-9]$", var.installation_id))
    error_message = "installation_id must be 4-21 lowercase letters, digits, or hyphens so the runtime service account name stays valid."
  }
}

variable "firestore_database_id" {
  description = "Explicit Firestore Native database ID. Creating (default) requires a separate opt-in after verifying that the customer project has no existing default database."
  type        = string

  validation {
    condition = (
      var.firestore_database_id == "(default)" || (
        can(regex("^[a-z][a-z0-9-]{2,61}[a-z0-9]$", var.firestore_database_id)) &&
        !can(regex("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", var.firestore_database_id))
      )
    )
    error_message = "firestore_database_id must be (default) or a named 4-63 character ID that is not UUID-like."
  }
}

variable "create_default_database" {
  description = "Explicit creation intent for (default) in a fresh customer project. The installer must verify absence first; this never imports or adopts an existing database."
  type        = bool
  default     = false
}

variable "firestore_location_id" {
  description = "Firestore database location. Choose an available location compatible with the selected region."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.firestore_location_id))
    error_message = "firestore_location_id must be an explicit Firestore location."
  }
}

variable "assets_bucket_name" {
  description = "Globally unique customer-owned bucket for assistant assets and recovery objects."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", var.assets_bucket_name))
    error_message = "assets_bucket_name must be a valid globally unique GCS bucket name."
  }
}

variable "source_bucket_name" {
  description = "Globally unique customer-owned bucket for immutable source archives."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", var.source_bucket_name))
    error_message = "source_bucket_name must be a valid globally unique GCS bucket name."
  }
}

variable "artifact_repository_id" {
  description = "Customer-owned Artifact Registry Docker repository ID."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,62}[a-z0-9]$", var.artifact_repository_id))
    error_message = "artifact_repository_id must be a valid Artifact Registry repository ID."
  }
}
