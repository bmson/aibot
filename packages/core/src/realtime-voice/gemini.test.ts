import type { GoogleGenAI, LiveConnectParameters, LiveServerMessage } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { pcm16ToBytes } from './audio-codec.js';
import { createGeminiLiveProvider } from './gemini.js';
import type { RealtimeSessionEvents } from './types.js';

function fakeClient() {
  const session = {
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
    sendClientContent: vi.fn(),
    close: vi.fn(),
  };
  let params: LiveConnectParameters | undefined;
  const client = {
    live: {
      connect: vi.fn(async (input: LiveConnectParameters) => {
        params = input;
        return session;
      }),
    },
  } as unknown as Pick<GoogleGenAI, 'live'>;
  return {
    client,
    session,
    params: () => params as LiveConnectParameters,
    emit: (message: Partial<LiveServerMessage>) =>
      params?.callbacks.onmessage(message as LiveServerMessage),
  };
}

function recorder(): RealtimeSessionEvents & { log: unknown[] } {
  const log: unknown[] = [];
  return {
    log,
    audio: (bytes) => log.push(['audio', bytes.length]),
    speechStarted: () => log.push(['speechStarted']),
    transcript: (role, text) => log.push(['transcript', role, text]),
    toolCall: (call) => log.push(['toolCall', call]),
    error: (error) => log.push(['error', error.message]),
    closed: () => log.push(['closed']),
  };
}

describe('Gemini Live adapter', () => {
  it('opens an audio session with the brief, voice, transcription and tools', async () => {
    const fake = fakeClient();
    await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
    }).connect(
      {
        model: 'gemini-live-2.5-flash-native-audio',
        instructions: 'Ask about opening hours.',
        voice: 'Aoede',
        tools: [{ name: 'end_call', description: 'Hang up.', parameters: { type: 'object' } }],
      },
      recorder(),
    );
    expect(fake.params()).toMatchObject({
      model: 'gemini-live-2.5-flash-native-audio',
      config: {
        responseModalities: ['AUDIO'],
        systemInstruction: 'Ask about opening hours.',
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } },
        tools: [
          {
            functionDeclarations: [{ name: 'end_call', parametersJsonSchema: { type: 'object' } }],
          },
        ],
      },
    });
  });

  it('transcodes phone audio both ways and relays turns, tools and usage', async () => {
    const fake = fakeClient();
    const events = recorder();
    const session = await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);

    session.sendAudio(new Uint8Array(160));
    const sent = fake.session.sendRealtimeInput.mock.calls[0]?.[0];
    expect(sent.audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(Buffer.from(sent.audio.data, 'base64')).toHaveLength(640);

    fake.emit({ serverContent: { inputTranscription: { text: 'We open ' } } });
    fake.emit({ serverContent: { inputTranscription: { text: 'at nine.' } } });
    fake.emit({
      serverContent: {
        outputTranscription: { text: 'Thanks!' },
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/pcm;rate=24000',
                data: Buffer.from(pcm16ToBytes(new Int16Array(480))).toString('base64'),
              },
            },
          ],
        },
      },
    });
    fake.emit({
      serverContent: { turnComplete: true },
      usageMetadata: {
        promptTokenCount: 120,
        promptTokensDetails: [
          { modality: 'AUDIO' as never, tokenCount: 100 },
          { modality: 'TEXT' as never, tokenCount: 20 },
        ],
        responseTokenCount: 50,
        responseTokensDetails: [{ modality: 'AUDIO' as never, tokenCount: 50 }],
      },
    });
    fake.emit({ serverContent: { interrupted: true } });
    fake.emit({
      toolCall: { functionCalls: [{ id: 't1', name: 'end_call', args: { outcome: 'done' } }] },
    });

    expect(events.log).toEqual([
      ['transcript', 'caller', 'We open at nine.'],
      ['audio', 160],
      ['transcript', 'assistant', 'Thanks!'],
      ['speechStarted'],
      ['toolCall', { id: 't1', name: 'end_call', args: { outcome: 'done' } }],
    ]);
    expect(session.usage()).toEqual({
      inputAudioTokens: 100,
      inputTextTokens: 20,
      cachedInputTokens: 0,
      outputAudioTokens: 50,
      outputTextTokens: 0,
    });

    session.sendToolResult({ id: 't1', name: 'end_call', args: {} }, { ok: true });
    expect(fake.session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [{ id: 't1', name: 'end_call', response: { output: { ok: true } } }],
    });
    session.respond('Greet them.');
    expect(fake.session.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: 'user', parts: [{ text: 'Greet them.' }] }],
      turnComplete: true,
    });
    await session.close();
    fake.params().callbacks.onclose?.({} as CloseEvent);
    expect(events.log.at(-1)).toEqual(['toolCall', expect.anything()]);
  });
});
