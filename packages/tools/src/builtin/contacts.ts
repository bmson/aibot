import type { ContactLookupRepository } from '@assistant/persistence';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

/** `contacts.lookup` over a contact repository instead of SQL. */
export function registerPortableContactLookupTool(
  registry: ToolRegistry,
  contacts: ContactLookupRepository,
): ToolRegistry {
  register(
    registry,
    {
      name: 'contacts.lookup',
      description:
        "Resolve a person's saved email address(es) and phone number(s) by name BEFORE emailing or texting them. Returns only matching saved contacts. If it returns no contact (or no address for the person), you do NOT know how to reach them — ask the owner instead of guessing an address. Never invent a recipient.",
      inputSchema: z.object({
        name: z
          .string()
          .min(2)
          .max(120)
          .describe('The person to look up, e.g. "Anna" or "Dr. Smith".'),
      }),
      risk: 'autonomous',
      // Owner-curated identifier rows, sanitized to email/phone/name only. Like
      // the SQL tool this deliberately does NOT set returnsUntrustedContent, so
      // resolving an address never taints the session.
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        const matches = await contacts.findByName({ agentId: ctx.agentId, query: args.name });
        return {
          query: args.name,
          contacts: matches.map((c) => ({
            name: c.name,
            emails: c.emails.filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 5),
            phones: c.phones.filter((p) => /^\+?\d[\d\s().-]{5,}$/.test(p)).slice(0, 5),
            relationship: c.relationship || undefined,
          })),
        };
      },
    },
    { confidentialRead: true },
  );
  return registry;
}
