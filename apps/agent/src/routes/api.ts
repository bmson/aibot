import { Hono } from 'hono';

/**
 * Mutations from the web app (enqueue workflows, resolve approvals, goals
 * CRUD). Authenticated with INTERNAL_API_SECRET locally, OIDC in prod.
 */
export const api = new Hono();

api.get('/ping', (c) => c.json({ pong: true }));
