import { GoogleGenAI, type LiveServerMessage, Modality, type Session } from '@google/genai';
import { pcmToTelephone, telephoneToPcm } from './audio-codec.js';
import {
  emptyRealtimeUsage,
  type RealtimeSession,
  type RealtimeSessionConfig,
  type RealtimeSessionEvents,
  type RealtimeToolCall,
  type RealtimeUsage,
  type RealtimeVoiceProvider,
} from './types.js';

export interface GeminiLiveOptions {
  project: string;
  location: string;
  /** Injected for tests. */
  client?: Pick<GoogleGenAI, 'live'>;
}

const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000;

type TokenDetail = { modality?: string; tokenCount?: number };

function split(details: TokenDetail[] | undefined, total: number | undefined) {
  let audio = 0;
  let text = 0;
  for (const detail of details ?? []) {
    const tokens = detail.tokenCount ?? 0;
    if (detail.modality === 'AUDIO') audio += tokens;
    else text += tokens;
  }
  // Without a breakdown, count everything as audio: the dearer rate, so an
  // estimate errs toward the budget rather than past it.
  if (!details?.length && total) audio = total;
  return { audio, text };
}

/**
 * Gemini Live on Vertex, authenticated by the service's own Google
 * credentials (ADC) — no API key. The phone's μ-law is widened to 16 kHz PCM
 * on the way in, and the model's 24 kHz speech narrowed back on the way out.
 *
 * Usage arrives per model turn and each turn is billed on its whole prompt,
 * so the turns are summed.
 */
export function createGeminiLiveProvider(options: GeminiLiveOptions): RealtimeVoiceProvider {
  return {
    kind: 'vertex',
    async connect(config, events) {
      const client =
        options.client ??
        new GoogleGenAI({ vertexai: true, project: options.project, location: options.location });
      return connectGeminiLive(client, config, events);
    },
  };
}

async function connectGeminiLive(
  client: Pick<GoogleGenAI, 'live'>,
  config: RealtimeSessionConfig,
  events: RealtimeSessionEvents,
): Promise<RealtimeSession> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(config.model))
    throw new Error(`Not a Vertex live model name: ${config.model}`);
  const usage: RealtimeUsage = emptyRealtimeUsage();
  let callerText = '';
  let assistantText = '';
  let closedByUs = false;

  const flush = () => {
    if (callerText.trim()) events.transcript('caller', callerText.trim());
    if (assistantText.trim()) events.transcript('assistant', assistantText.trim());
    callerText = '';
    assistantText = '';
  };

  const onMessage = (message: LiveServerMessage) => {
    const content = message.serverContent;
    if (content?.interrupted) {
      events.speechStarted();
      flush();
    }
    if (content?.inputTranscription?.text) callerText += content.inputTranscription.text;
    if (content?.outputTranscription?.text) {
      // The model has started answering: the caller's turn is complete.
      if (callerText.trim()) {
        events.transcript('caller', callerText.trim());
        callerText = '';
      }
      assistantText += content.outputTranscription.text;
    }
    for (const part of content?.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data && part.inlineData?.mimeType?.startsWith('audio/'))
        events.audio(pcmToTelephone(new Uint8Array(Buffer.from(data, 'base64')), OUTPUT_RATE));
    }
    if (content?.turnComplete) flush();
    for (const call of message.toolCall?.functionCalls ?? []) {
      if (call.id && call.name)
        events.toolCall({ id: call.id, name: call.name, args: call.args ?? {} });
    }
    const metadata = message.usageMetadata;
    if (metadata) {
      const input = split(metadata.promptTokensDetails, metadata.promptTokenCount);
      const output = split(metadata.responseTokensDetails, metadata.responseTokenCount);
      usage.inputAudioTokens += input.audio;
      usage.inputTextTokens += input.text;
      usage.cachedInputTokens += metadata.cachedContentTokenCount ?? 0;
      usage.outputAudioTokens += output.audio;
      usage.outputTextTokens += output.text + (metadata.thoughtsTokenCount ?? 0);
    }
  };

  const session: Session = await client.live.connect({
    model: config.model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: config.instructions,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      ...(config.voice
        ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } } }
        : {}),
      ...(config.tools.length
        ? {
            tools: [
              {
                functionDeclarations: config.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parametersJsonSchema: tool.parameters,
                })),
              },
            ],
          }
        : {}),
    },
    callbacks: {
      onmessage: onMessage,
      onerror: (event) =>
        events.error(new Error(`Gemini Live error: ${String(event.message ?? event)}`)),
      onclose: () => {
        flush();
        if (!closedByUs) events.closed();
      },
    },
  });

  return {
    sendAudio(mulaw) {
      session.sendRealtimeInput({
        audio: {
          data: Buffer.from(telephoneToPcm(mulaw, INPUT_RATE)).toString('base64'),
          mimeType: `audio/pcm;rate=${INPUT_RATE}`,
        },
      });
    },
    sendToolResult(call: RealtimeToolCall, result: unknown) {
      session.sendToolResponse({
        functionResponses: [{ id: call.id, name: call.name, response: { output: result } }],
      });
    },
    respond(instructions) {
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: instructions ?? 'Continue.' }] }],
        turnComplete: true,
      });
    },
    // Gemini stops its own reply server-side when it hears the caller.
    interrupt() {},
    usage: () => ({ ...usage }),
    async close() {
      closedByUs = true;
      flush();
      session.close();
    },
  };
}
