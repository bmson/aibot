'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

type Raw = Record<string, unknown>;

interface Side {
  name: string;
  shortName: string;
  abbreviation: string;
  logo?: string;
  score?: string;
  winner?: boolean;
  record?: string;
}

export interface ScoreGame {
  id: string;
  league: string;
  leagueLabel: string;
  state: 'pre' | 'in' | 'post';
  statusText: string;
  startsAt: string;
  venue?: string;
  broadcast?: string;
  link?: string;
  home: Side;
  away: Side;
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function side(value: unknown): Side | undefined {
  const raw = value && typeof value === 'object' ? (value as Raw) : undefined;
  const name = str(raw?.name);
  if (!raw || !name) return undefined;
  return {
    name,
    shortName: str(raw.shortName) || name,
    abbreviation: str(raw.abbreviation),
    ...(str(raw.logo) ? { logo: str(raw.logo) } : {}),
    ...(str(raw.score) ? { score: str(raw.score) } : {}),
    ...(typeof raw.winner === 'boolean' ? { winner: raw.winner } : {}),
    ...(str(raw.record) ? { record: str(raw.record) } : {}),
  };
}

export function scoreGames(value: unknown): ScoreGame[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const raw = entry && typeof entry === 'object' ? (entry as Raw) : undefined;
    const home = side(raw?.home);
    const away = side(raw?.away);
    const state = str(raw?.state);
    if (!raw || !home || !away || !str(raw.id)) return [];
    return [
      {
        id: str(raw.id),
        league: str(raw.league),
        leagueLabel: str(raw.leagueLabel),
        state: state === 'in' || state === 'post' ? state : 'pre',
        statusText: str(raw.statusText),
        startsAt: str(raw.startsAt),
        ...(str(raw.venue) ? { venue: str(raw.venue) } : {}),
        ...(str(raw.broadcast) ? { broadcast: str(raw.broadcast) } : {}),
        ...(/^https:\/\/www\.espn\.com\//.test(str(raw.link)) ? { link: str(raw.link) } : {}),
        home,
        away,
      },
    ];
  });
}

/** Within this long of kickoff a scheduled game is polled, so it goes live on its own. */
const STARTING_SOON_MS = 10 * 60_000;

/** Whether any game can still change: it is on, or it is about to start. */
export function scoreboardShouldPoll(games: ScoreGame[], now: number): boolean {
  return games.some((game) => {
    if (game.state === 'in') return true;
    if (game.state !== 'pre') return false;
    const start = Date.parse(game.startsAt);
    return Number.isFinite(start) && start - now <= STARTING_SOON_MS && now - start < 4 * 3600_000;
  });
}

/** `mlb:401,402;nfl:77` for the games that can still change. */
export function liveScoreQuery(games: ScoreGame[]): string {
  const byLeague = new Map<string, string[]>();
  for (const game of games) {
    if (game.state === 'post' || !game.league) continue;
    byLeague.set(game.league, [...(byLeague.get(game.league) ?? []), game.id]);
  }
  return [...byLeague].map(([league, ids]) => `${league}:${ids.join(',')}`).join(';');
}

function TeamRow({ team, state }: { team: Side; state: ScoreGame['state'] }) {
  const lost = state === 'post' && team.winner === false;
  return (
    <div className="flex items-center gap-2.5">
      {team.logo ? (
        <Image
          src={`/api/card-image?url=${encodeURIComponent(team.logo)}`}
          alt=""
          width={24}
          height={24}
          className="size-6 shrink-0 object-contain"
          unoptimized
        />
      ) : (
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-[0.625rem] font-semibold text-muted">
          {team.abbreviation.slice(0, 3)}
        </span>
      )}
      <span
        className={`min-w-0 flex-1 truncate ${lost ? 'text-muted' : 'font-medium text-strong'}`}
      >
        {team.shortName}
        {team.record ? (
          <span className="ml-1.5 text-xs font-normal text-muted">{team.record}</span>
        ) : null}
      </span>
      {state !== 'pre' && team.score !== undefined ? (
        <span
          className={`text-lg tabular-nums ${lost ? 'text-muted' : 'font-semibold text-strong'}`}
        >
          {team.score}
        </span>
      ) : null}
    </div>
  );
}

function GameRow({ game }: { game: ScoreGame }) {
  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 text-muted">
          {game.state === 'in' ? (
            <span className="inline-flex items-center gap-1 font-semibold text-red-700 dark:text-red-400">
              <span
                className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
                aria-hidden="true"
              />
              Live
            </span>
          ) : null}
          <span className={game.state === 'in' ? 'font-medium text-strong' : ''}>
            {game.statusText}
          </span>
        </span>
        {game.link ? (
          <a
            href={game.link}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-accent underline-offset-2 hover:underline"
          >
            Game details
          </a>
        ) : null}
      </div>
      <span className="sr-only">{`${game.away.name} at ${game.home.name}, ${game.statusText}`}</span>
      <div className="flex flex-col gap-1.5">
        <TeamRow team={game.away} state={game.state} />
        <TeamRow team={game.home} state={game.state} />
      </div>
      {game.venue || game.broadcast ? (
        <p className="mt-1.5 truncate text-xs text-muted">
          {[game.venue, game.broadcast].filter(Boolean).join(' · ')}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Games from the scores tool, re-read from the live endpoint while one is on.
 * Polling stops when every game is final, the tab is hidden, or the card has
 * scrolled away — a transcript full of old scoreboards costs nothing.
 */
export function ScoreboardCard({ data }: { data: Raw }) {
  const [games, setGames] = useState(() => scoreGames(data.games));
  const [updatedAt, setUpdatedAt] = useState(() => str(data.fetchedAt));
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const live = Boolean(data.live) && scoreboardShouldPoll(games, Date.now());
  const pollSeconds = Math.max(15, Number((data.live as Raw | undefined)?.pollSeconds) || 30);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(Boolean(entry?.isIntersecting)),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!live || !visible) return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      const query = liveScoreQuery(games);
      if (!query) return;
      const response = await fetch(
        `/api/live/scoreboard?leagues=${encodeURIComponent(query)}`,
      ).catch(() => null);
      const body = (await response?.json().catch(() => null)) as Raw | null;
      if (cancelled || !response?.ok || !body) return;
      const fresh = new Map(
        scoreGames(body.games).map((game) => [`${game.league}:${game.id}`, game]),
      );
      setGames((current) => current.map((game) => fresh.get(`${game.league}:${game.id}`) ?? game));
      setUpdatedAt(str(body.fetchedAt));
    };
    const timer = window.setInterval(tick, pollSeconds * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [live, visible, games, pollSeconds]);

  const updated = Date.parse(updatedAt);
  return (
    <div ref={ref}>
      <ul className="divide-y divide-edge/50 text-sm">
        {games.map((game) => (
          <GameRow key={`${game.league}-${game.id}`} game={game} />
        ))}
      </ul>
      {Number.isFinite(updated) ? (
        <p
          className="mt-2.5 border-t border-edge/60 pt-2 text-[0.6875rem] text-muted"
          aria-live="polite"
        >
          {live ? 'Updating live · ' : ''}Updated{' '}
          {new Date(updated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ESPN
        </p>
      ) : null}
    </div>
  );
}
