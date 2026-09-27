import WebSocket from 'ws';
import {
  emptyRealtimeUsage,
  type RealtimeSession,
  type RealtimeSessionConfig,
  type RealtimeSessionEvents,
  type RealtimeToolCall,
  type RealtimeUsage,
  type RealtimeVoiceProvider,
} from './types.js';

export interface OpenAIRealtimeOptions {
  apiKey: string;
  /** Override for tests. */
  url?: string;
  /** Speech-to-text model for the caller's side of the transcript. */
  transcriptionModel?: string;
  connectTimeoutMs?: number;
}

type ServerEvent = {
  type?: string;
  delta?: string;
  item_id?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { message?: string };
  response?: {
    usage?: {
      input_token_details?: { audio_tokens?: number; text_tokens?: number; cached_tokens?: number };
      output_token_details?: { audio_tokens?: number; text_tokens?: number };
    };
  };
};

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * OpenAI Realtime over WebSocket. Phone audio passes straight through: the
 * API speaks G.711 μ-law (`audio/pcmu`) natively, so there is no transcoding
 * and no added latency on either leg.
 */
export function createOpenAIRealtimeProvider(
  options: OpenAIRealtimeOptions,
): RealtimeVoiceProvider {
  if (!options.apiKey) throw new Error('OpenAI Realtime requires an API key');
  return {
    kind: 'openai',
    connect(config, events) {
      return connectOpenAIRealtime(options, config, events);
    },
  };
}

async function connectOpenAIRealtime(
  options: OpenAIRealtimeOptions,
  config: RealtimeSessionConfig,
  events: RealtimeSessionEvents,
): Promise<RealtimeSession> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.model))
    throw new Error(`Not an OpenAI realtime model name: ${config.model}`);
  const url =
    options.url ?? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`;
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${options.apiKey}` } });
  const usage: RealtimeUsage = emptyRealtimeUsage();
  let currentAudioItem: string | undefined;
  let closedByUs = false;

  const send = (event: Record<string, unknown>) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('OpenAI Realtime did not connect in time'));
    }, options.connectTimeoutMs ?? 10_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      reject(
        new Error(
          response.statusCode === 401
            ? 'OpenAI rejected the API key'
            : `OpenAI Realtime refused the connection (HTTP ${response.statusCode})`,
        ),
      );
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  socket.on('message', (raw) => {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw.toString()) as ServerEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case 'response.output_audio.delta':
        if (event.delta) {
          currentAudioItem = event.item_id ?? currentAudioItem;
          events.audio(new Uint8Array(Buffer.from(event.delta, 'base64')));
        }
        break;
      case 'input_audio_buffer.speech_started':
        events.speechStarted();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript?.trim()) events.transcript('caller', event.transcript.trim());
        break;
      case 'response.output_audio_transcript.done':
        if (event.transcript?.trim()) events.transcript('assistant', event.transcript.trim());
        break;
      case 'response.function_call_arguments.done': {
        let args: unknown = {};
        try {
          args = event.arguments ? JSON.parse(event.arguments) : {};
        } catch {
          args = { _unparsed: event.arguments };
        }
        if (event.call_id && event.name)
          events.toolCall({ id: event.call_id, name: event.name, args });
        break;
      }
      case 'response.done': {
        const input = event.response?.usage?.input_token_details;
        const output = event.response?.usage?.output_token_details;
        usage.inputAudioTokens += count(input?.audio_tokens);
        usage.inputTextTokens += count(input?.text_tokens);
        usage.cachedInputTokens += count(input?.cached_tokens);
        usage.outputAudioTokens += count(output?.audio_tokens);
        usage.outputTextTokens += count(output?.text_tokens);
        break;
      }
      case 'error':
        events.error(new Error(event.error?.message ?? 'OpenAI Realtime error'));
        break;
    }
  });
  socket.on('error', (error) => events.error(error));
  socket.on('close', () => {
    if (!closedByUs) events.closed();
  });

  send({
    type: 'session.update',
    session: {
      type: 'realtime',
      model: config.model,
      output_modalities: ['audio'],
      instructions: config.instructions,
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          // Semantic VAD waits for the other person to finish a thought, not
          // just a pause — fewer interruptions of someone reading out a date.
          turn_detection: { type: 'semantic_vad', create_response: true, interrupt_response: true },
          transcription: { model: options.transcriptionModel ?? 'gpt-4o-mini-transcribe' },
        },
        output: {
          format: { type: 'audio/pcmu' },
          ...(config.voice ? { voice: config.voice } : {}),
        },
      },
      tools: config.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      tool_choice: 'auto',
    },
  });

  return {
    sendAudio(mulaw) {
      send({ type: 'input_audio_buffer.append', audio: Buffer.from(mulaw).toString('base64') });
    },
    sendToolResult(call: RealtimeToolCall, result: unknown) {
      send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: call.id, output: JSON.stringify(result) },
      });
      send({ type: 'response.create' });
    },
    respond(instructions) {
      send({ type: 'response.create', ...(instructions ? { response: { instructions } } : {}) });
    },
    interrupt(playedMs) {
      if (!currentAudioItem) return;
      send({
        type: 'conversation.item.truncate',
        item_id: currentAudioItem,
        content_index: 0,
        audio_end_ms: Math.max(0, Math.round(playedMs)),
      });
      currentAudioItem = undefined;
    },
    usage: () => ({ ...usage }),
    async close() {
      closedByUs = true;
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close();
        setTimeout(() => {
          socket.terminate();
          resolve();
        }, 2_000).unref();
      });
    },
  };
}
