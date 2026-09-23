import { getAgent, LEAGUE_KEYS, lookupScores } from '@assistant/core';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export function registerSportsTools(registry: ToolRegistry, deps: { fetchImpl?: Fetch } = {}) {
  register(
    registry,
    {
      name: 'sports.scores',
      description:
        'Live scores, results, and fixtures for pro and major college leagues (MLB, NFL, NBA, WNBA, NHL, college football and men\'s basketball, MLS, Premier League, LaLiga, Bundesliga, Serie A, Ligue 1, Champions League). Give `team` ("Giants", "Arsenal", "SF Giants") and/or `league`. For a team with no game on the day it returns its last result and next game. Several teams sharing a name come back as `candidates` — ask which one unless the request settles it. Use this, not web.search, for any score, result, or schedule question these leagues cover; the chat draws the games as a live-updating scoreboard, so the reply only needs one sentence with the result. `unsupported: true` means the team or league is not covered: then use web.search.',
      inputSchema: z.object({
        team: z
          .string()
          .max(80)
          .optional()
          .describe('Team name or nickname as the owner said it. Omit for a whole league slate.'),
        league: z
          .enum(LEAGUE_KEYS)
          .optional()
          .describe('Narrow to one league, or list its games when no team is given.'),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            'Owner-local date (YYYY-MM-DD) for "yesterday\'s game" or a future fixture. Omit for today.',
          ),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      cacheTtlSeconds: 20,
      execute: async (args, ctx) => {
        const agent = await getAgent(ctx.db);
        try {
          return await lookupScores({
            ...(args.team ? { team: args.team } : {}),
            ...(args.league ? { league: args.league } : {}),
            ...(args.date ? { date: args.date } : {}),
            timeZone: agent.timezone,
            now: ctx.now(),
            signal: ctx.signal,
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          });
        } catch (err) {
          return { games: [], error: `The scores provider could not be reached: ${String(err)}` };
        }
      },
    },
    // Neither networkEgress nor returnsUntrustedContent, for the reason given
    // on weather.lookup: the host and paths are fixed (the league is an enum,
    // the team is matched locally and only a numeric id reaches a URL), and the
    // result is scores plus clipped team names, not third-party prose. Flagging
    // it would put "what's the Giants score?" behind an approval card.
    {},
  );
}
