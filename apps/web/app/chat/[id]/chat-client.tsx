'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Inbox,
  Loader2,
  LogOut,
  type LucideIcon,
  Route,
  Sparkles,
  Square,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react';
import { signOutAction } from '@/app/actions';
import { destinationIcon, formatBadgeCount, useNavCommands } from '@/app/nav-commands';
import { cancelTask } from '@/app/tasks/actions';
import { hasContractNoticePart, isApprovalProseNotice, isContractNotice } from '@/lib/chat-notices';
import { BackLink, btnSm, CountBadge, focusRing, microLabelClass } from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
import { archiveConversation, changeConversationModel, restoreConversation } from '../actions';
import { ApprovalGroup } from './approval-group';
import type { InlineApprovalPart } from './inline-approval';
import { InlineBudgetRequest, type InlineBudgetRequestPart } from './inline-budget-request';
import { MessageMarkdown } from './markdown';
import {
  AssistantUpdate,
  ContractNotice,
  DayDivider,
  dayLabel,
  decodeRecallHeader,
  errorText,
  MessageActions,
  messageDate,
  messageText,
  PresenceRow,
  RecallNote,
  type RecallSource,
  recallSourcesOf,
  sameDay,
  timeLabel,
} from './message-view';

interface ChatClientProps {
  conversationId: string;
  title: string;
  /** The assistant's display name — the chat header shows who you're talking to. */
  agentName: string;
  initialMessages: UIMessage[];
  models: { id: string; label: string }[];
  modelOverride: string | null;
  goalTitle?: string;
  /** A task created by the goal form before this page opened. */
  initialAsyncTurn?: { taskId: string; cursor: string };
  archived: boolean;
  /** The one forever thread at /chat — it needs no title header of its own. */
  isPrimary: boolean;
  canArchive: boolean;
  initialNotice?: string;
  /** Pre-fills the composer (e.g. an "ask about this document" deep-link). */
  initialInput?: string;
}

const ASYNC_ACK_TEXT = 'Got it — I’m working on this now. I’ll post the result here.';

/** Task statuses that mean "parked on the owner", not "finished". */
const PARKED_TASK_STATUSES = new Set(['waiting_approval', 'waiting_budget', 'needs_attention']);

/**
 * A task publishes a parked status before the card explaining the park is
 * persisted. The executor now writes that card ahead of its outbound owner
 * ping, so the gap is a single insert — but a poll can still land inside it,
 * and stopping there is what left approvals invisible until a reload. Give a
 * parked task this many extra polls to produce a card before settling, so a
 * park that legitimately has no card (plain needs_attention prose) still ends.
 */
const PARK_GRACE_TICKS = 4;

/** An approval or budget card — the thing a parked task is waiting on. */
function hasDecisionPart(message: UIMessage): boolean {
  return (message.parts as Array<{ type?: string }>).some(
    (part) => part?.type === 'approval' || part?.type === 'budget-request',
  );
}

/**
 * One entry in the "/" palette. Composer commands act on this chat; navigation
 * entries leave for another surface. The palette is the app's only menu, so
 * both kinds have to live in one list you can type at.
 */
type SlashEntry = {
  command: string;
  hint: string;
  icon: LucideIcon;
  /** Other spellings that match while typing. */
  aliases: string[];
} & ({ kind: 'command' } | { kind: 'destination'; href: string; label: string; count: number });

/**
 * Commands that stay in the composer. Picking one either completes it into the
 * field, where the command's own palette (/model) takes over, or applies on the
 * spot (/auto, /signout) and hands the composer back empty.
 */
const COMPOSER_COMMANDS: SlashEntry[] = [
  {
    kind: 'command',
    command: '/model',
    hint: 'Switch which model answers this chat',
    icon: Sparkles,
    aliases: [],
  },
  {
    kind: 'command',
    command: '/auto',
    hint: 'Act without asking for this turn',
    icon: Zap,
    aliases: ['autonomous'],
  },
];

const SIGN_OUT_COMMAND: SlashEntry = {
  kind: 'command',
  command: '/signout',
  hint: 'End this session',
  icon: LogOut,
  aliases: ['logout'],
};

/** A bare "/" lists everything; typing narrows on the command or an alias. */
function matchesToken(entry: SlashEntry, token: string): boolean {
  return (
    entry.command.slice(1).startsWith(token) ||
    entry.aliases.some((alias) => alias.startsWith(token))
  );
}

export function ChatClient({
  conversationId,
  title,
  agentName,
  initialMessages,
  models,
  modelOverride,
  goalTitle,
  initialAsyncTurn,
  archived,
  isPrimary,
  canArchive,
  initialNotice,
  initialInput,
}: ChatClientProps) {
  const router = useRouter();
  const { destinations, signedIn } = useNavCommands();
  const [input, setInput] = useState(initialInput ?? '');
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [isSwitching, startTransition] = useTransition();
  const [selectedModel, setSelectedModel] = useState(modelOverride);
  const [modelError, setModelError] = useState<string | null>(null);
  /** Keyboard cursor into the /model palette (arrow keys move it, Enter picks). */
  const [modelHighlight, setModelHighlight] = useState(0);
  /** Whether the scroller is pinned near the bottom (drives the jump pill). */
  const [atBottom, setAtBottom] = useState(true);
  /** New messages that arrived while scrolled up (the pill shows a dot). */
  const [unseenCount, setUnseenCount] = useState(0);
  /** Set when the route handed the turn to the executor — we poll until it settles. */
  const [asyncTurn, setAsyncTurn] = useState<{
    taskId: string;
    cursor: string;
  } | null>(initialAsyncTurn ?? null);
  const [asyncNote, setAsyncNote] = useState<string | null>(null);
  const [asyncActionError, setAsyncActionError] = useState<string | null>(null);
  const [isCancellingAsync, startCancelTransition] = useTransition();
  const [activity, setActivity] = useState<
    Array<{ toolName: string; status: string; step: number }>
  >([]);
  /** Live provenance for the current streaming turn (the persisted part covers reloads). */
  const [liveRecall, setLiveRecall] = useState<RecallSource[] | null>(null);
  /** This-turn autonomy: one submitted turn can skip routine approvals. */
  const [autonomous, setAutonomous] = useState(false);
  const autonomousRef = useRef(false);
  autonomousRef.current = autonomous;
  const resetAutonomyAfterSubmitRef = useRef(false);
  /** A failed send can put the exact text back into the composer without guesswork. */
  const [lastSubmittedText, setLastSubmittedText] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageScrollerRef = useRef<HTMLDivElement>(null);
  /** The floating composer overlays the log — see the layout note on the form. */
  const [composerHeight, setComposerHeight] = useState(112);
  const stickToBottomRef = useRef(true);
  const previousMessageCountRef = useRef(initialMessages.length);
  const previousTranscriptLengthRef = useRef(
    initialMessages.reduce((total, message) => total + messageText(message).length, 0),
  );
  /** Messages present at mount render static; only genuinely new ones animate in. */
  const initialMessageIdsRef = useRef<Set<string> | null>(null);
  initialMessageIdsRef.current ??= new Set(initialMessages.map((message) => message.id));

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: { conversationId },
        // The server owns history. Sending only the new user turn keeps request
        // size flat and prevents a client from selecting model context.
        prepareSendMessagesRequest: ({ messages, body }) => {
          const latestUser = [...messages].reverse().find((message) => message.role === 'user');
          // Read the toggle through a ref so the memoized transport always sees
          // its current value without re-creating on every keystroke.
          return {
            body: {
              ...body,
              autonomous: autonomousRef.current,
              messages: latestUser ? [latestUser] : [],
            },
          };
        },
        // Wrap fetch to capture the routing headers set by the chat route.
        fetch: (async (info, init) => {
          const response = await fetch(info, init);
          const modelId = response.headers.get('x-model-id');
          const degraded = response.headers.get('x-model-degraded') === 'true';
          setFallbackNote(degraded && modelId ? `responded with ${modelId} (fallback)` : null);
          setLiveRecall(decodeRecallHeader(response.headers.get('x-recall')));
          const taskId = response.headers.get('x-async-task');
          const cursor = response.headers.get('x-message-cursor');
          setAsyncTurn(taskId && cursor ? { taskId, cursor } : null);
          if (taskId) {
            setAsyncNote(null);
            setAsyncActionError(null);
          }
          return response;
        }) as typeof fetch,
      }),
    [conversationId],
  );

  const { messages, sendMessage, setMessages, status, error, clearError, stop } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
  });

  // Timestamps and day dividers use the browser timezone, so they render only
  // after mount — the server-rendered HTML must not bake in the server's zone.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setSelectedModel(modelOverride);
  }, [modelOverride]);

  // The elevated mode belongs to exactly one turn. Wait until useChat has
  // accepted the request so the memoized transport can read the submitted
  // value, then return the composer to its safer default.
  useEffect(() => {
    if (resetAutonomyAfterSubmitRef.current && (status === 'submitted' || status === 'streaming')) {
      resetAutonomyAfterSubmitRef.current = false;
      setAutonomous(false);
    }
  }, [status]);

  // Action turns run in the executor (tools, approvals) — poll the thread
  // until the task settles, then replace the local ack with the real answer.
  useEffect(() => {
    if (!asyncTurn) return;
    const startedAt = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000;
    let cancelled = false;
    let cursor = asyncTurn.cursor;
    let sawAssistant = false;
    /** An approval or budget card for this turn actually reached the client. */
    let sawDecision = false;
    /** Extra polls left to a parked task before we stop listening for its card. */
    let parkGraceTicks = PARK_GRACE_TICKS;

    const mergeMessages = (incoming: UIMessage[]) => {
      if (incoming.length === 0) return;
      setMessages((current) => {
        const merged = [...current];
        const indexes = new Map(merged.map((message, index) => [message.id, index]));
        for (const message of incoming) {
          const index = indexes.get(message.id);
          if (index === undefined) {
            indexes.set(message.id, merged.length);
            merged.push(message);
          } else {
            merged[index] = message;
          }
        }
        // The route sends a short acknowledgement while an action task starts.
        // Once the durable assistant reply arrives, remove that temporary copy
        // so a simple request still reads as one coherent conversation.
        const hasDurableReply = incoming.some(
          (message) => message.role === 'assistant' && messageText(message) !== ASYNC_ACK_TEXT,
        );
        return hasDurableReply
          ? merged.filter(
              (message) => message.role !== 'assistant' || messageText(message) !== ASYNC_ACK_TEXT,
            )
          : merged;
      });
    };

    const settle = (note: string | null) => {
      if (cancelled) return;
      setAsyncNote(note);
      setAsyncTurn(null);
      setActivity([]);
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const query = new URLSearchParams({
          conversationId,
          taskId: asyncTurn.taskId,
          cursor,
        });
        const res = await fetch(`/api/chat/status?${query.toString()}`);
        if (res.ok) {
          const data = (await res.json()) as {
            taskStatus: string;
            messages: UIMessage[];
            nextCursor: string | null;
            hasMore: boolean;
            activity?: Array<{
              toolName: string;
              status: string;
              step: number;
            }>;
          };
          setActivity(data.activity ?? []);
          mergeMessages(data.messages);
          sawAssistant ||= data.messages.some((message) => message.role === 'assistant');
          sawDecision ||= data.messages.some(hasDecisionPart);
          if (data.nextCursor) cursor = data.nextCursor;
          if (data.hasMore) {
            if (!cancelled) window.setTimeout(tick, 0);
            return;
          }
          if (data.taskStatus === 'done' && sawAssistant) return settle(null);
          if (PARKED_TASK_STATUSES.has(data.taskStatus) && sawAssistant) {
            // Stop as soon as the card the park is waiting on is here. Without
            // one, keep polling for a bounded grace: the status can be observed
            // in the moment between the park commit and the card's insert, and
            // settling there loses the card until the page is reloaded.
            if (sawDecision || parkGraceTicks <= 0) return settle(null);
            parkGraceTicks -= 1;
          }
          if (data.taskStatus === 'failed' || data.taskStatus === 'cancelled') {
            return settle(
              `The task ${data.taskStatus === 'cancelled' ? 'was cancelled' : 'ended unsuccessfully'}.`,
            );
          }
        }
      } catch {
        // transient poll failure — keep trying until the timeout
      }
      if (Date.now() - startedAt > TIMEOUT_MS) {
        return settle('Still working. The result will appear here when it finishes.');
      }
      if (!cancelled) window.setTimeout(tick, 2500);
    };

    void tick();
    return () => {
      cancelled = true;
    };
  }, [asyncTurn, conversationId, setMessages]);

  const busy = status === 'submitted' || status === 'streaming' || asyncTurn !== null;
  const displayTitle = title === 'Untitled' ? 'New conversation' : title;
  const notificationMode = displayTitle.toLowerCase() === 'notifications';
  const commandInput = input.trimStart();
  const modelCommandOpen = /^\/model(?:\s.*)?$/i.test(commandInput);
  const modelQuery = modelCommandOpen
    ? commandInput
        .replace(/^\/model\s*/i, '')
        .trim()
        .toLowerCase()
    : '';
  const modelOptions = useMemo(
    () =>
      [
        {
          id: null,
          label: 'Auto',
          detail: 'Use the best model for the request',
        },
        ...models.map((model) => ({ ...model, detail: model.id })),
      ].filter(
        (model) =>
          modelQuery === '' ||
          model.label.toLowerCase().includes(modelQuery) ||
          model.detail.toLowerCase().includes(modelQuery),
      ),
    [models, modelQuery],
  );
  const selectedModelLabel =
    selectedModel === null
      ? 'Auto'
      : (models.find((model) => model.id === selectedModel)?.label ?? selectedModel);

  // The "/" affordance: a bare slash token lists everything the composer can
  // do and everywhere the app can go, so nobody has to already know "/model" or
  // hunt for a menu. Once the token completes into a real command, that
  // command's own palette takes over (modelCommandOpen above).
  //
  // Composer commands sort ahead of destinations, and the two render as
  // separate groups — but they share one flat match list, so the arrow keys
  // walk the whole palette without knowing the groups exist.
  const slashEntries = useMemo<SlashEntry[]>(
    () => [
      ...COMPOSER_COMMANDS,
      ...(signedIn ? [SIGN_OUT_COMMAND] : []),
      ...destinations.map(
        (destination): SlashEntry => ({
          kind: 'destination',
          command: destination.command,
          hint: destination.hint,
          icon: destinationIcon(destination.href),
          aliases: destination.aliases,
          href: destination.href,
          label: destination.label,
          count: destination.count,
        }),
      ),
    ],
    [destinations, signedIn],
  );
  const slashToken =
    /^\/\S*$/.test(commandInput) && !modelCommandOpen ? commandInput.slice(1).toLowerCase() : null;
  const commandMatches =
    slashToken !== null ? slashEntries.filter((entry) => matchesToken(entry, slashToken)) : [];
  const commandPaletteOpen = commandMatches.length > 0;
  const composerMatches = commandMatches.filter((entry) => entry.kind === 'command');
  const destinationMatches = commandMatches.filter((entry) => entry.kind === 'destination');
  /** There is something to send, and nothing in the way of sending it. */
  const canSend =
    !busy && input.trim() !== '' && !modelCommandOpen && !commandPaletteOpen && !isSwitching;
  const [commandHighlight, setCommandHighlight] = useState(0);
  // Clamp instead of resetting via effect — the list is tiny and refilters
  // on every keystroke, so an out-of-range cursor just snaps to the end.
  const safeCommandHighlight = Math.min(commandHighlight, Math.max(0, commandMatches.length - 1));

  const runCommand = (entry: SlashEntry) => {
    // A destination leaves the chat, so the token goes with it — coming back to
    // a composer still holding "/settings" would read as an unsent draft.
    if (entry.kind === 'destination') {
      setInput('');
      router.push(entry.href);
      return;
    }
    // /auto and /signout are actions, not prefixes: they have no palette of
    // their own to hand off to, so they apply on the spot and give the composer
    // back empty rather than leaving a token the reader has to clear.
    if (entry.command === '/auto') {
      setAutonomous((value) => !value);
      setInput('');
      textareaRef.current?.focus();
      return;
    }
    if (entry.command === '/signout') {
      setInput('');
      void signOutAction();
      return;
    }
    setInput(entry.command);
    textareaRef.current?.focus();
  };

  // Every row reads the same way — the token you typed, then what it does —
  // so a destination is not a different kind of object from a command, just a
  // command that happens to leave. The badge is the only extra a row can carry.
  const renderCommandOption = (entry: SlashEntry, index: number) => {
    const highlighted = index === safeCommandHighlight;
    const EntryIcon = entry.icon;
    const count = entry.kind === 'destination' ? entry.count : 0;
    return (
      <button
        key={entry.command}
        id={`command-option-${index}`}
        type="button"
        role="option"
        aria-selected={highlighted}
        aria-label={`${entry.command}, ${entry.hint}${
          count > 0 ? `, ${count} waiting for you` : ''
        }`}
        onMouseMove={() => setCommandHighlight(index)}
        onClick={() => runCommand(entry)}
        className={`mobile-touch-target flex min-h-11 w-full min-w-0 items-center gap-3 rounded-[var(--radius-shell-inset-6)] px-3 py-2 text-left motion-safe:transition-colors ${focusRing} ${
          highlighted ? 'bg-sunken text-strong' : 'text-strong hover:bg-sunken'
        }`}
      >
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <EntryIcon className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-sm font-medium">{entry.command}</span>
          <span className="block truncate text-xs text-muted">{entry.hint}</span>
        </span>
        {count > 0 ? (
          <span aria-hidden="true">
            <CountBadge tone="amber">{formatBadgeCount(count)}</CountBadge>
          </span>
        ) : null}
      </button>
    );
  };

  // A heading only earns its space when there is something to tell apart, so
  // the labels appear once a filter still leaves both kinds of entry standing.
  const showGroupLabels = composerMatches.length > 0 && destinationMatches.length > 0;

  const renderCommandGroup = (label: string, entries: SlashEntry[], offset: number) => (
    // A `group` inside a `listbox` is the ARIA pattern for exactly this; the
    // semantic element the rule wants (`fieldset`) is form markup and would be
    // invalid as a listbox child.
    // biome-ignore lint/a11y/useSemanticElements: listbox sections are ARIA groups
    <div role="group" aria-label={label}>
      {showGroupLabels ? (
        <p
          aria-hidden="true"
          className={`px-3 pt-2.5 pb-1 first:pt-1 ${microLabelClass} text-muted`}
        >
          {label}
        </p>
      ) : null}
      {entries.map((entry, index) => renderCommandOption(entry, offset + index))}
    </div>
  );

  // Opening the palette (or refiltering it) lands the cursor on the current
  // model, or the top match when it's filtered out.
  useEffect(() => {
    if (!modelCommandOpen) return;
    const selectedIndex = modelOptions.findIndex((model) => model.id === selectedModel);
    setModelHighlight(selectedIndex >= 0 ? selectedIndex : 0);
  }, [modelCommandOpen, modelOptions, selectedModel]);

  // Keep the highlighted option in view as the arrows walk the list. Both
  // palettes scroll now — the "/" list carries every destination in the app.
  useEffect(() => {
    if (!modelCommandOpen) return;
    document.getElementById(`model-option-${modelHighlight}`)?.scrollIntoView({ block: 'nearest' });
  }, [modelCommandOpen, modelHighlight]);

  useEffect(() => {
    if (!commandPaletteOpen) return;
    document
      .getElementById(`command-option-${safeCommandHighlight}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [commandPaletteOpen, safeCommandHighlight]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const scroller = messageScrollerRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  });

  // A message or streamed text landed while the reader was scrolled up — keep
  // the jump pill meaningful even when the message count itself did not grow.
  useEffect(() => {
    const addedMessages = Math.max(0, messages.length - previousMessageCountRef.current);
    const transcriptLength = messages.reduce(
      (total, message) => total + messageText(message).length,
      0,
    );
    const streamedTextGrew = transcriptLength > previousTranscriptLengthRef.current;
    if (!stickToBottomRef.current && (addedMessages > 0 || streamedTextGrew)) {
      setUnseenCount((count) => (addedMessages > 0 ? count + addedMessages : Math.max(count, 1)));
    }
    previousMessageCountRef.current = messages.length;
    previousTranscriptLengthRef.current = transcriptLength;
  }, [messages]);

  // The composer floats over the conversation, so nothing in the log can rely
  // on it taking layout space. Measure the form and feed that height back two
  // ways: a negative top margin cancels the space it would occupy in the
  // column, and the scroller reserves it as bottom padding so the newest
  // message still clears the composer by the same 5rem the log keeps on top.
  useLayoutEffect(() => {
    const element = formRef.current;
    if (!element) return;
    setComposerHeight(element.offsetHeight);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setComposerHeight(entry.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Grow the composer with its content, up to the CSS max-height cap. `input`
  // is the trigger; the new height is read from the DOM, not from `input`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: input drives the re-measure
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [input]);

  const jumpToLatest = () => {
    stickToBottomRef.current = true;
    setAtBottom(true);
    setUnseenCount(0);
    const scroller = messageScrollerRef.current;
    if (!scroller) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  };

  const sendTurn = (text: string, clearComposer: boolean) => {
    stickToBottomRef.current = true;
    setAtBottom(true);
    setUnseenCount(0);
    setLastSubmittedText(text);
    if (clearComposer) setInput('');
    setFallbackNote(null);
    setModelError(null);
    setLiveRecall(null);
    if (error) clearError();
    resetAutonomyAfterSubmitRef.current = autonomous;
    void sendMessage({ text });
  };

  const submitCurrentMessage = () => {
    const text = input.trim();
    if (!text || busy) return;
    // Slash commands are local composer controls, never conversation messages.
    if (/^\/model(?:\s.*)?$/i.test(text)) return;
    if (commandPaletteOpen) return;
    sendTurn(text, true);
  };

  const closeModelPicker = () => {
    // You reach the picker by typing "/model" over whatever was in the
    // composer, so there is no draft of yours left to put back.
    setModelError(null);
    setInput('');
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const chooseModel = (modelId: string | null) => {
    if (isSwitching) return;
    setModelError(null);
    startTransition(async () => {
      try {
        await changeConversationModel(conversationId, modelId);
        setSelectedModel(modelId);
        closeModelPicker();
      } catch {
        setModelError('Could not switch models. Try again.');
      }
    });
  };

  const cancelAsyncTurn = () => {
    if (!asyncTurn || isCancellingAsync) return;
    const taskId = asyncTurn.taskId;
    setAsyncActionError(null);
    startCancelTransition(async () => {
      try {
        await cancelTask(taskId);
        setAsyncNote('Stopped by you.');
        setAsyncTurn(null);
        setActivity([]);
      } catch {
        setAsyncActionError('Could not stop this task. Try again or open Activity.');
      }
    });
  };

  return (
    // The log is the full height of the screen, not a panel inset within it.
    // The negative margins cancel the page shell's vertical padding, which was
    // otherwise dead space the log could not use: messages clipped at a line
    // ~4rem below the top of the window instead of at the window itself, so
    // text vanished mid-scroll with visible emptiness above it. Anything that
    // needs breathing room (the header, the log's own opening air) supplies it
    // from the inside, where it scrolls.
    //
    // The column widens on larger screens so the header/composer use the
    // space a floating rail plus a wide canvas otherwise leaves empty — but
    // each bubble caps its own width separately (max-w-[min(76%,42rem)]
    // above), not this container: prose that runs to 1000px is tiring, and
    // pinning the user's bubbles that far right would make a two-way
    // exchange read as two columns regardless of how wide the column is.
    <div className="chat-viewport relative mx-auto -my-5 flex h-[calc(100dvh-1rem-var(--app-chrome,0px))] w-full min-w-0 max-w-3xl flex-col lg:-my-7 lg:h-[calc(100dvh-var(--app-chrome,0px))] lg:max-w-4xl 2xl:max-w-[56rem]">
      {/* The primary thread is the whole surface — it needs no title. Side and
          goal chats keep a slim header so you know which one you're in. */}
      {!isPrimary ? (
        // A side thread is a subpage like any other: it gets back to its parent
        // list, which gets back to the main thread. The "/" palette only exists
        // in the composer below, so this is the way out that is always visible.
        <header className="border-b border-edge pt-7 pb-3 lg:pt-10">
          <BackLink href="/chat/all">All chats</BackLink>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1
                className="truncate font-display text-lg font-semibold tracking-[-0.03em]"
                title={displayTitle}
              >
                {displayTitle}
              </h1>
              {goalTitle ? (
                <p className="mt-0.5 truncate text-xs text-muted">Working toward: {goalTitle}</p>
              ) : null}
              {archived ? (
                <p className="mt-0.5 text-xs text-muted">
                  Archived — sending a message restores this chat.
                </p>
              ) : null}
            </div>
            {archived || canArchive ? (
              <div className="flex min-w-0 items-center gap-2">
                {archived ? (
                  <form action={restoreConversation.bind(null, conversationId)}>
                    <SubmitButton variant="outline" pendingLabel="Restoring…">
                      Restore
                    </SubmitButton>
                  </form>
                ) : canArchive ? (
                  <form action={archiveConversation.bind(null, conversationId)}>
                    <SubmitButton variant="outline" pendingLabel="Archiving…">
                      Archive
                    </SubmitButton>
                  </form>
                ) : null}
              </div>
            ) : null}
          </div>
        </header>
      ) : null}
      {initialNotice ? (
        <div
          role="alert"
          className="mt-3 border-l-2 border-amber-400 py-1 pl-4 text-sm leading-5 text-amber-900 dark:border-amber-700 dark:text-amber-100"
        >
          {initialNotice}
        </div>
      ) : null}

      <div
        ref={messageScrollerRef}
        role="log"
        aria-label="Conversation"
        onScroll={(event) => {
          const element = event.currentTarget;
          const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          stickToBottomRef.current = bottom;
          setAtBottom(bottom);
          if (bottom) setUnseenCount(0);
        }}
        style={{ paddingBottom: `calc(5rem + ${composerHeight}px)` }}
        className="scroll-subtle min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-20"
      >
        {/* A short thread rests on the composer instead of hanging from the top
            of the window with a void beneath it — `mt-auto` on the log (and
            `my-auto` on the opening screen) does that, while a thread long
            enough to overflow simply scrolls as before. */}
        <div className="flex min-h-full min-w-0 flex-col">
          {messages.length === 0 ? (
            <div className="mx-auto flex max-w-xl flex-col items-center text-center my-auto">
              <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-sunken text-accent">
                <Sparkles className="size-5" aria-hidden="true" />
              </span>
              <p className="mt-4 font-display text-2xl leading-8 font-semibold tracking-[-0.025em] text-balance text-strong">
                What should we move forward?
              </p>
              {/* A small hand-drawn stroke that sketches itself in under the
                greeting — the page's one flourish. Static for reduced motion. */}
              <svg aria-hidden="true" viewBox="0 0 140 10" fill="none" className="mt-2 h-2.5 w-36">
                <path
                  d="M3 7 C 28 3, 55 8.5, 82 5 S 125 3.5, 137 5.5"
                  stroke="var(--accent)"
                  strokeOpacity="0.65"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  className="[stroke-dasharray:160] [stroke-dashoffset:160] motion-safe:animate-[draw-in_700ms_ease-out_250ms_forwards] motion-reduce:[stroke-dashoffset:0]"
                />
              </svg>
              <p className="mt-2 max-w-md text-base leading-6 text-pretty text-muted">
                Start with an outcome. {agentName} can research, plan, draft, schedule, and keep
                following up when the work takes time.
              </p>
              <div className="mt-6 grid w-full gap-2 sm:grid-cols-3">
                {[
                  {
                    text: 'Summarize my unread email',
                    label: 'Clear the inbox',
                    icon: Inbox,
                  },
                  {
                    text: 'What’s on my calendar this week?',
                    label: 'Review the week',
                    icon: CalendarDays,
                  },
                  {
                    text: 'Draft a plan for my next trip',
                    label: 'Plan a trip',
                    icon: Route,
                  },
                ].map((suggestion, index) => {
                  const SuggestionIcon = suggestion.icon;
                  return (
                    <button
                      key={suggestion.text}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        sendTurn(suggestion.text, false);
                      }}
                      style={{ animationDelay: `${index * 60}ms` }}
                      className={`mobile-touch-target flex min-h-20 flex-col items-start justify-between rounded-2xl bg-raised p-3 text-left ring-1 ring-edge/60 motion-safe:animate-[presence-arrive_320ms_ease-out_both] motion-safe:transition-colors hover:bg-sunken/30 disabled:opacity-60 ${focusRing}`}
                    >
                      <SuggestionIcon className="size-4 text-accent" aria-hidden="true" />
                      <span className="mt-3 text-sm font-medium text-strong">
                        {suggestion.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="mt-auto flex min-w-0 flex-col">
              {messages.map((message, messageIndex) => {
                const parts = message.parts as Array<
                  UIMessage['parts'][number] | InlineApprovalPart | InlineBudgetRequestPart
                >;
                const approvalParts = parts.filter(
                  (part): part is InlineApprovalPart => part.type === 'approval',
                );
                const budgetParts = parts.filter(
                  (part): part is InlineBudgetRequestPart => part.type === 'budget-request',
                );
                const textParts = parts.filter(
                  (part): part is Extract<UIMessage['parts'][number], { type: 'text' }> =>
                    part.type === 'text',
                );
                // The grouped card repeats the executor's prose approval list —
                // hide the duplicate text, never the persisted message itself.
                const visibleTextParts =
                  approvalParts.length > 0
                    ? textParts.filter((part) => !isApprovalProseNotice(part.text))
                    : textParts;
                const fullText = visibleTextParts
                  .map((part) => part.text)
                  .join('')
                  .trim();
                const isNotice =
                  message.role === 'assistant' &&
                  approvalParts.length === 0 &&
                  budgetParts.length === 0 &&
                  fullText !== '' &&
                  (hasContractNoticePart(parts) || isContractNotice(fullText));
                const date = messageDate(message);
                const previousDate =
                  messageIndex > 0 ? messageDate(messages[messageIndex - 1] as UIMessage) : null;
                const showDivider =
                  mounted &&
                  date !== null &&
                  (previousDate === null || !sameDay(previousDate, date));
                // A chat is one continuous discussion — per-message clock times
                // are noise there, and the day dividers already carry the "when".
                // Proactive updates are the exception: those arrive at a time
                // that is part of the message, so Notifications keeps them.
                const showTime = mounted && date !== null && notificationMode;
                const recallSources = recallSourcesOf(message);
                const hasText = visibleTextParts.length > 0 && !isNotice;
                const isNewMessage = !initialMessageIdsRef.current?.has(message.id);
                const previousMessage = messageIndex > 0 ? messages[messageIndex - 1] : undefined;
                // A "run" is a streak of turns from the same speaker. Handing
                // over gets a clear break; a follow-on from the same speaker
                // tucks in close, so a run reads as one continuous thought.
                const startsRun =
                  !previousMessage || previousMessage.role !== message.role || showDivider;
                const streamingCaret =
                  status === 'streaming' &&
                  message.role === 'assistant' &&
                  messageIndex === messages.length - 1;
                return (
                  <div
                    key={message.id}
                    className={`flex min-w-0 flex-col gap-2 first:mt-0 ${startsRun ? 'mt-7' : 'mt-2'} ${
                      isNewMessage ? 'motion-safe:animate-[message-in_220ms_ease-out]' : ''
                    }`}
                  >
                    {showDivider && date ? <DayDivider label={dayLabel(date, new Date())} /> : null}
                    {isNotice ? (
                      <ContractNotice text={fullText} />
                    ) : notificationMode && message.role === 'assistant' && hasText ? (
                      <AssistantUpdate text={fullText} sources={recallSources} />
                    ) : hasText ? (
                      <div
                        className={
                          message.role === 'user' ? 'flex justify-end' : 'flex justify-start'
                        }
                      >
                        {message.role === 'assistant' ? (
                          // A neutral bubble distinct from the user's accent
                          // gradient — it reads as the bot's voice while
                          // keeping the raised-card treatment meaning one
                          // thing only: an object the assistant placed in the
                          // thread (an approval, a budget ask, a work trail).
                          <div className="group/msg min-w-0 max-w-[88%] sm:max-w-[min(76%,42rem)]">
                            <RecallNote sources={recallSources} />
                            <div
                              className={`min-w-0 max-w-full rounded-2xl rounded-bl-md bg-raised px-4 py-3 text-sm text-strong ring-1 ring-edge/60 ${
                                streamingCaret ? 'chat-caret' : ''
                              }`}
                            >
                              {visibleTextParts.map((part, index) => (
                                <MessageMarkdown
                                  key={`${message.id}-${index.toString()}`}
                                  text={part.text}
                                />
                              ))}
                            </div>
                            <MessageActions text={fullText} date={date} />
                          </div>
                        ) : (
                          // Both speakers read at the same size — a smaller user
                          // bubble made your own words look like a footnote.
                          // That size is the one the event cards already use, so
                          // speech and system notices sit on one typographic
                          // scale instead of two.
                          <div
                            title={date ? date.toLocaleString() : undefined}
                            className="min-w-0 max-w-[88%] rounded-2xl rounded-br-md bg-gradient-to-br from-accent to-accent-hover px-4 py-3 text-sm leading-6 text-white sm:max-w-[min(76%,42rem)]"
                          >
                            {visibleTextParts.map((part, index) => (
                              <p
                                key={`${message.id}-${index.toString()}`}
                                className="break-words whitespace-pre-wrap [overflow-wrap:anywhere]"
                              >
                                {part.text}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : null}
                    {approvalParts.length > 0 ? <ApprovalGroup parts={approvalParts} /> : null}
                    {budgetParts.map((part) => (
                      <InlineBudgetRequest key={part.taskId} part={part} />
                    ))}
                    {showTime && date ? (
                      <p
                        title={date.toLocaleString()}
                        className={`text-xs text-muted ${
                          message.role === 'user' ? 'self-end' : 'self-start'
                        }`}
                      >
                        {timeLabel(date)}
                      </p>
                    ) : null}
                  </div>
                );
              })}
              {status === 'submitted' ? (
                <div className="mt-6">
                  <PresenceRow phase="thinking" activity={[]} />
                </div>
              ) : asyncTurn ? (
                <div className="mt-6">
                  <PresenceRow
                    phase={activity.length > 0 ? 'working' : 'starting'}
                    activity={activity}
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-2 pl-[18px]">
                    <Link href={`/tasks/${asyncTurn.taskId}`} className={btnSm.outline}>
                      View activity
                    </Link>
                    <button
                      type="button"
                      disabled={isCancellingAsync}
                      onClick={cancelAsyncTurn}
                      className={btnSm.dangerOutline}
                    >
                      {isCancellingAsync ? (
                        <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                      ) : (
                        <Square className="size-3.5 fill-current" aria-hidden="true" />
                      )}
                      {isCancellingAsync ? 'Stopping…' : 'Stop task'}
                    </button>
                  </div>
                  {asyncActionError ? (
                    <p
                      role="alert"
                      className="mt-2 pl-[18px] text-xs text-red-700 dark:text-red-300"
                    >
                      {asyncActionError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {asyncNote ? (
                <p role="status" className="mt-3 text-xs text-muted">
                  {asyncNote}{' '}
                  <Link href="/tasks" className="font-medium underline underline-offset-2">
                    Open Activity
                  </Link>
                </p>
              ) : null}
              {liveRecall ? <RecallNote sources={liveRecall} /> : null}
            </div>
          )}
        </div>
      </div>

      {/* The composer floats over the conversation rather than docking under
          it: no bar, no border — just the raised card lifted off the log, with
          a scrim so the text scrolling beneath it fades out instead of
          colliding with it. It stays `sticky` so it tracks the viewport bottom
          even when the column overflows, and the negative margin gives back
          the space it would otherwise take from the log. Everything transient
          (errors, palettes) sits in an out-of-flow stack above it, so opening
          the "/" palette never resizes the conversation. */}
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          submitCurrentMessage();
        }}
        style={{ marginTop: `-${composerHeight}px` }}
        className="mobile-safe-bottom pointer-events-none sticky bottom-0 z-20 min-w-0 sm:pb-3"
      >
        {/* The scrim stops at the composer's own bottom edge. It used to hang
            below it, which cost nothing when the column ended above the fold
            but now adds its overhang to the document — the whole page would
            scroll a little, sliding the "full height" log out of place. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-16 bottom-0 bg-gradient-to-t from-surface from-35% via-surface/85 to-transparent"
        />
        {!atBottom && messages.length > 0 && !error && !commandPaletteOpen && !modelCommandOpen ? (
          <div className="pointer-events-none absolute inset-x-0 -top-14 z-10 flex justify-center">
            <button
              type="button"
              onClick={jumpToLatest}
              aria-label="Jump to latest"
              className={`pointer-events-auto mobile-touch-target inline-flex h-9 items-center gap-1.5 rounded-full bg-raised px-3.5 text-xs font-medium text-strong ring-1 ring-edge motion-safe:animate-[pop-in_140ms_ease-out] ${focusRing}`}
            >
              <ArrowDown className="size-3.5" aria-hidden="true" />
              Jump to latest
              {unseenCount > 0 ? (
                <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
              ) : null}
            </button>
          </div>
        ) : null}
        <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 min-w-0">
          {/* Autonomy is a per-turn choice, so it no longer holds a permanent
              seat in the composer — /auto sets it and this says so until the
              turn goes out. Out of flow, so arming it never resizes the field. */}
          {autonomous ? (
            <div className="pointer-events-auto mb-2 flex min-w-0 items-center gap-2 rounded-[var(--radius-shell)] bg-amber-100 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-300">
              <Zap className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">Acting without asking this turn</span>
              <button
                data-testid="chat-autonomy-mode"
                type="button"
                onClick={() => setAutonomous(false)}
                aria-label="Ask before acting again"
                title="Sensitive steps including unknown recipients and logged-in browsing still ask, and budget caps still apply."
                className={`shrink-0 rounded-[var(--radius-shell-inset-8)] px-2 font-medium underline underline-offset-2 hover:no-underline ${focusRing}`}
              >
                Cancel
              </button>
            </div>
          ) : null}
          {error ? (
            <div
              role="alert"
              className="pointer-events-auto mb-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
            >
              <span>{errorText(error)}</span>
              <span className="flex shrink-0 items-center gap-2">
                {lastSubmittedText && input === '' ? (
                  <button
                    type="button"
                    onClick={() => {
                      clearError();
                      setInput(lastSubmittedText);
                      window.requestAnimationFrame(() => textareaRef.current?.focus());
                    }}
                    className="text-xs font-medium underline underline-offset-2 hover:no-underline"
                  >
                    Restore draft
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={clearError}
                  className="text-xs underline underline-offset-2 hover:no-underline"
                >
                  Dismiss
                </button>
              </span>
            </div>
          ) : null}
          {commandPaletteOpen ? (
            <section
              aria-label="Commands"
              className="pointer-events-auto relative mb-2 min-w-0 overflow-hidden rounded-[var(--radius-shell)] bg-raised ring-1 ring-edge motion-safe:animate-[pop-in_120ms_ease-out]"
            >
              <div className="flex min-w-0 items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
                <p className="text-sm font-semibold text-strong">Commands</p>
                <span className="hidden shrink-0 text-xs text-muted sm:block">
                  ↑↓ choose · Enter open · Esc dismiss
                </span>
              </div>
              {/* One flat listbox in two labelled groups. The arrow keys index
                  `commandMatches`, so the destination rows continue the
                  composer rows' numbering rather than restarting at zero. */}
              <div
                id="command-listbox"
                role="listbox"
                aria-label="Commands"
                className="max-h-72 overscroll-contain overflow-y-auto p-1.5"
              >
                {composerMatches.length > 0
                  ? renderCommandGroup('This chat', composerMatches, 0)
                  : null}
                {destinationMatches.length > 0
                  ? renderCommandGroup('Go to', destinationMatches, composerMatches.length)
                  : null}
              </div>
            </section>
          ) : null}
          {modelCommandOpen ? (
            <section
              aria-label="Choose response model"
              className="pointer-events-auto relative mb-2 min-w-0 overflow-hidden rounded-[var(--radius-shell)] bg-raised ring-1 ring-edge motion-safe:animate-[pop-in_120ms_ease-out]"
            >
              <div className="flex min-w-0 items-center justify-between gap-3 border-b border-edge px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-strong">Response model</p>
                  <p className="truncate text-xs text-muted">Currently {selectedModelLabel}</p>
                </div>
                {isSwitching ? (
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    Switching…
                  </span>
                ) : (
                  <span className="hidden shrink-0 text-xs text-muted sm:block">
                    ↑↓ choose · Enter select · Esc close
                  </span>
                )}
              </div>
              <div
                id="model-listbox"
                role="listbox"
                aria-label="Response model"
                className="max-h-56 overscroll-contain overflow-y-auto p-1.5"
              >
                {modelOptions.length > 0 ? (
                  modelOptions.map((model, index) => {
                    const active = selectedModel === model.id;
                    const highlighted = index === modelHighlight;
                    return (
                      <button
                        key={model.id ?? 'auto'}
                        id={`model-option-${index}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        disabled={isSwitching}
                        onMouseMove={() => setModelHighlight(index)}
                        onClick={() => chooseModel(model.id)}
                        className={`mobile-touch-target flex min-h-11 w-full min-w-0 items-center gap-3 rounded-[var(--radius-shell-inset-6)] px-3 py-2 text-left motion-safe:transition-colors ${focusRing} ${
                          active
                            ? 'bg-accent/10 text-accent'
                            : highlighted
                              ? 'bg-sunken text-strong'
                              : 'text-strong hover:bg-sunken'
                        } ${active && highlighted ? 'ring-1 ring-accent/40' : ''}`}
                      >
                        <span
                          aria-hidden="true"
                          className={`size-2 shrink-0 rounded-full ${
                            active ? 'bg-accent' : 'bg-edge'
                          }`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{model.label}</span>
                          <span className="block truncate text-xs text-muted">{model.detail}</span>
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <p className="px-3 py-4 text-center text-sm text-muted">
                    No models match “{modelQuery}”
                  </p>
                )}
              </div>
              {modelError ? (
                <p role="alert" className="border-t border-edge px-4 py-2 text-xs text-red-700">
                  {modelError}
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
        <div className="pointer-events-auto relative min-w-0">
          {/* One row: the field, then send. `items-end` keeps the button on the
              last line as the field grows upward, and the card's own padding is
              the only inset either of them needs. */}
          <div
            data-testid="chat-composer-surface"
            className="flex min-w-0 items-end gap-2 overflow-hidden rounded-[var(--radius-shell)] bg-raised/90 p-2 backdrop-blur-xl motion-safe:transition-shadow"
          >
            <textarea
              ref={textareaRef}
              role="combobox"
              aria-label="Message"
              aria-expanded={modelCommandOpen || commandPaletteOpen}
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-controls={
                modelCommandOpen
                  ? 'model-listbox'
                  : commandPaletteOpen
                    ? 'command-listbox'
                    : undefined
              }
              aria-activedescendant={
                modelCommandOpen
                  ? `model-option-${modelHighlight}`
                  : commandPaletteOpen
                    ? `command-option-${safeCommandHighlight}`
                    : undefined
              }
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                // While the /model palette is open the arrows drive it, Enter picks
                // the highlighted model, and Escape closes it — so none of those
                // reach the send handler.
                if (modelCommandOpen) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setModelHighlight((h) =>
                      modelOptions.length ? (h + 1) % modelOptions.length : 0,
                    );
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setModelHighlight((h) =>
                      modelOptions.length ? (h - 1 + modelOptions.length) % modelOptions.length : 0,
                    );
                  } else if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    const choice = modelOptions[modelHighlight];
                    if (choice && !isSwitching) chooseModel(choice.id);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    closeModelPicker();
                  }
                  return;
                }
                // The "/" palette: arrows move the cursor, Enter or Tab complete
                // the highlighted command, Escape dismisses.
                if (commandPaletteOpen) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setCommandHighlight((h) => (h + 1) % commandMatches.length);
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setCommandHighlight(
                      (h) => (h - 1 + commandMatches.length) % commandMatches.length,
                    );
                  } else if (
                    event.key === 'Tab' ||
                    (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing)
                  ) {
                    event.preventDefault();
                    const choice = commandMatches[safeCommandHighlight];
                    if (choice) runCommand(choice);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setInput('');
                  }
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }}
              placeholder="Ask anything…"
              rows={1}
              className="block max-h-40 min-h-11 w-full min-w-0 flex-1 resize-none self-center border-0 bg-transparent px-2 py-2 text-base leading-6 outline-none placeholder:text-muted/70 sm:text-sm"
            />
            {/* No rule between the field and its controls. A full-bleed border
                ran straight into the card's corner arc, which cut it off at an
                angle and made one object look like two stacked ones. Without it
                the card reads as a single well with the controls resting in it,
                and the round send button agrees with the corners instead of
                fighting them. */}
            {status === 'submitted' || status === 'streaming' ? (
              <button
                type="button"
                onClick={() => stop()}
                title="Stop generating"
                className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-edge bg-raised text-strong motion-safe:animate-[pop-in_120ms_ease-out] motion-safe:transition-colors hover:bg-sunken active:bg-sunken/80 ${focusRing}`}
              >
                <Square className="size-3 fill-current" aria-hidden="true" />
                <span className="sr-only">Stop</span>
              </button>
            ) : (
              // Readiness is a state change, not a dimmed copy of the live
              // button: with nothing to send it sits back as a quiet tonal
              // control, then fills with accent once you have typed.
              <button
                type="submit"
                disabled={!canSend}
                aria-label={asyncTurn ? 'Working on your request' : 'Send'}
                className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full motion-safe:transition-[background-color,color,box-shadow] ${focusRing} ${
                  canSend
                    ? 'bg-accent text-white hover:bg-accent-hover'
                    : 'cursor-not-allowed bg-sunken text-muted'
                }`}
              >
                {asyncTurn ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                ) : (
                  <ArrowUp className="size-4" aria-hidden="true" />
                )}
              </button>
            )}
          </div>
          <span aria-live="polite" className="sr-only">
            {modelCommandOpen && modelOptions[modelHighlight]
              ? `${modelOptions[modelHighlight].label}, ${modelOptions[modelHighlight].detail}`
              : commandPaletteOpen && commandMatches[safeCommandHighlight]
                ? `${commandMatches[safeCommandHighlight].command}, ${commandMatches[safeCommandHighlight].hint}`
                : ''}
          </span>
          {fallbackNote ? (
            <p className="px-1 pt-1.5 text-right text-xs text-muted">{fallbackNote}</p>
          ) : null}
        </div>
      </form>
    </div>
  );
}
