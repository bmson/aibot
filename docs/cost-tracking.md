# Cost tracking

The web Costs page and native iOS Costs view distinguish provider billing from the assistant's operation ledger. **Do not add the two together**: Vertex, Cloud Run jobs and storage may already be present in Google Cloud billing, and OpenRouter requests already appear in its reported spend. The budget caps protect assistant operations using conservative estimates; they cannot cap the cloud provider's bill.

## Google Cloud

The connector reads the standard or detailed [Cloud Billing BigQuery export](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-setup), using the runtime's Application Default Credentials. It includes every exported service and SKU (Firestore/Cloud SQL, Vertex AI, Cloud Run, Storage, networking, and future services), credits, negative adjustments, and original currencies. It does not estimate infrastructure prices or convert currencies. Project scope excludes unallocated account-level charges such as some taxes or adjustments. The report covers usage in the current UTC month, not invoice month; delayed usage and adjustments mean it is not a final invoice.

1. Enable standard usage cost export in **Cloud Billing → Billing export → BigQuery export** for your billing account. Select a billing dataset in the appropriate project and location. Initial data may take hours or days; export history depends on the dataset location and when export was enabled.
2. Set these environment variables on the **web service**:
   - `GCP_BILLING_EXPORT_TABLE=billing-project.billing_dataset.gcp_billing_export_v1_ACCOUNT_ID` (or the detailed export table).
   - `GCP_BILLING_LOCATION=US` (use the dataset's actual location).
   - `GCP_BILLING_QUERY_PROJECT=billing-project` (defaults to the export table's project).
   - `GCP_BILLING_SCOPE=project` (default) filters to `GCP_PROJECT`. Set `billing_account` explicitly to include all projects and unallocated charges in this account's export.
   - `GCP_BILLING_MAX_BYTES=1000000000` caps each query's scan allowance. BigQuery rejects a query that exceeds it; the dashboard keeps the previous snapshot and flags it stale. Querying the export can itself incur BigQuery charges.
3. Enable the BigQuery API in the query project. Grant the web runtime service account `roles/bigquery.jobUser` on that project and `roles/bigquery.dataViewer` on the export dataset. No billing-account administrator credential is needed at runtime. Scope access to the dataset; billing-account reporting is an explicit installation choice.
4. Open Costs. It shows the selected project/account scope, reporting month, snapshot fetch time, latest export time, and latest usage time. A latest timestamp is not proof that all services have reported. An empty export is shown as unavailable, not $0.

For existing installations, set these values on the existing web service before its next image release (ordinary release scripts preserve the live template's environment). The bootstrap `infra/gcp/deploy.sh` passes them from its environment file or shell when provisioning the web service. No dataset, billing export, IAM grant, production migration or deployment is performed by this code change.

## OpenRouter

The existing saved OpenRouter connection (or deployment key when no saved connection replaces it) is used with [GET /api/v1/key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key). `usage_monthly` is shown as the connected key's reported spend; an explicit zero is valid. This is not an account-wide invoice, does not include other keys or credit purchases, and may include other apps sharing the key. Use a dedicated key for installation-specific attribution. BYOK upstream usage is not added to OpenRouter's amount because its bill belongs to the upstream provider.

## Model usage and additional providers

Every model-router ledger entry records its connection, model and available request ID, plus one of:

- `provider_reported`: the provider returned an explicit nonnegative USD cost, including an authoritative zero.
- `token_rate`: complete usage multiplied by configured model prices. This remains an estimate (cache discounts, tiers, negotiated rates and special modalities can differ).
- `preflight_estimate`: a successful response lacked complete usage and a reported cost; the preflight amount protects the budget but is not described as a verified charge.
- `unknown`: old or other entries without sufficient provenance. Historical costs are not retroactively declared verified.

New models automatically use the same metering path, including custom gateway identities. Live voice model usage is explicitly marked as a rate-based estimate. Connected providers without a billing connector show their coverage gap instead of a made-up bill. Direct OpenAI and arbitrary compatible gateways currently have usage tracking, not account billing imports. Vertex uses the Google Cloud export, subject to project coverage. Adding a billing API requires a provider-specific adapter; there is no universal model billing endpoint.

## Refresh and persistence

Billing is read on demand and durably cached for one hour, shared by web and iOS, in the installation's existing tool cache. Snapshots are keyed by period, configuration and connection credentials (hashed, never stored in plaintext). Transport/auth/query errors retain the previous successful snapshot with a stale status; unsuccessful refreshes retry after five minutes. A prior month's snapshot cannot masquerade as the new month's spend. Cache records expire after seven days; this is a current-month dashboard, not a historical invoice archive. The billing export remains the historical source of truth.

PostgreSQL needs migration `0080_cost_evidence.sql`; Firestore accepts the new evidence object and interprets absent evidence as unknown. Billing snapshots do not create operation-ledger entries or change budget counters. This prevents overlapping billing sources from double-counting usage or unexpectedly pausing work.
