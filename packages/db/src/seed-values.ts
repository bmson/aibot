export interface OwnerPolicyContact {
  emails: string[];
  phones: string[];
}

/** Prefer durable owner-contact data when a deploy-time seed lacks owner env vars. */
export function resolveOwnerPolicyValues(
  contact: OwnerPolicyContact | undefined,
  fallback: { email: string; phone: string },
): { emails: string[]; phone: string } {
  const contactEmails = (contact?.emails ?? []).map((email) => email.trim()).filter(Boolean);
  const contactPhone = (contact?.phones ?? []).map((phone) => phone.trim()).find(Boolean);
  return {
    emails: contactEmails.length > 0 ? contactEmails : fallback.email ? [fallback.email] : [],
    phone: contactPhone ?? fallback.phone,
  };
}
