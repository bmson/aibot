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

# The runtime profile is deliberately opt-in. Both digests must be supplied;
# tags and image URLs cannot silently select a mutable or publisher-owned image.
variable "web_image_digest" {
  description = "Immutable sha256 digest of the customer-owned Artifact Registry web image; null leaves the foundation unchanged."
  type        = string
  default     = null

  validation {
    condition     = var.web_image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.web_image_digest))
    error_message = "web_image_digest must be a lowercase sha256:<64 hex> digest."
  }
}

variable "agent_image_digest" {
  description = "Immutable sha256 digest of the customer-owned Artifact Registry agent image; null leaves the foundation unchanged."
  type        = string
  default     = null

  validation {
    condition     = var.agent_image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.agent_image_digest))
    error_message = "agent_image_digest must be a lowercase sha256:<64 hex> digest."
  }
}

variable "firestore_agent_id" {
  description = "ID of an already seeded owner agent document. Required only for the Firestore runtime."
  type        = string
  default     = null

  validation {
    condition     = var.firestore_agent_id == null || can(regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", var.firestore_agent_id))
    error_message = "firestore_agent_id must be a UUID."
  }
}

variable "firestore_embedding_space" {
  description = "Explicit provenance of imported/seeded Firestore embeddings, not an inferred model default."
  type = object({
    provider   = string
    model      = string
    dimensions = number
    revision   = string
  })
  default = null

  validation {
    condition = var.firestore_embedding_space == null || (
      length(trimspace(var.firestore_embedding_space.provider)) > 0 &&
      length(trimspace(var.firestore_embedding_space.model)) > 0 &&
      var.firestore_embedding_space.dimensions >= 1 &&
      var.firestore_embedding_space.dimensions <= 2048 &&
      floor(var.firestore_embedding_space.dimensions) == var.firestore_embedding_space.dimensions &&
      length(trimspace(var.firestore_embedding_space.revision)) > 0
    )
    error_message = "firestore_embedding_space needs nonempty provider/model/revision and 1-2048 integer dimensions."
  }
}

variable "owner_email" {
  description = "Verified Google account allowed to sign in to the web application. Required for the runtime."
  type        = string
  default     = null

  validation {
    condition     = var.owner_email == null || can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.owner_email))
    error_message = "owner_email must be an email address."
  }
}

variable "web_auth_url" {
  description = "Explicit HTTPS URL whose Google OAuth callback is configured; it is not inferred from an uncreated Cloud Run service."
  type        = string
  default     = null

  validation {
    condition     = var.web_auth_url == null || can(regex("^https://[A-Za-z0-9.-]+(?::443)?$", var.web_auth_url))
    error_message = "web_auth_url must be an HTTPS origin without a path or query."
  }
}

# These are version numbers of three *existing*, customer-populated Secret
# Manager secrets. Terraform never receives their values or creates versions.
variable "auth_secret_version" {
  description = "Numbered version of <installation_id>-auth-secret in the customer project."
  type        = number
  default     = null

  validation {
    condition     = var.auth_secret_version == null || (var.auth_secret_version >= 1 && floor(var.auth_secret_version) == var.auth_secret_version)
    error_message = "auth_secret_version must be a positive integer version, not latest."
  }
}

variable "google_client_id_version" {
  description = "Numbered version of <installation_id>-google-client-id in the customer project."
  type        = number
  default     = null

  validation {
    condition     = var.google_client_id_version == null || (var.google_client_id_version >= 1 && floor(var.google_client_id_version) == var.google_client_id_version)
    error_message = "google_client_id_version must be a positive integer version, not latest."
  }
}

variable "google_client_secret_version" {
  description = "Numbered version of <installation_id>-google-client-secret in the customer project."
  type        = number
  default     = null

  validation {
    condition     = var.google_client_secret_version == null || (var.google_client_secret_version >= 1 && floor(var.google_client_secret_version) == var.google_client_secret_version)
    error_message = "google_client_secret_version must be a positive integer version, not latest."
  }
}

variable "mobile_api_token_version" {
  description = "Optional numbered version of <installation_id>-mobile-api-token in the customer project. Never the token value."
  type        = number
  default     = null

  validation {
    condition     = var.mobile_api_token_version == null || (var.mobile_api_token_version >= 1 && floor(var.mobile_api_token_version) == var.mobile_api_token_version)
    error_message = "mobile_api_token_version must be a positive integer version, not latest."
  }
}

variable "allow_public_web_invoker" {
  description = "Explicitly grant allUsers Cloud Run invocation after owner Google OAuth and URL have been configured. Default is private."
  type        = bool
  default     = false
}
