import type { Config } from '@assistant/config';
import type { Records } from '@assistant/persistence';
import { decryptStoredCredential } from '../mcp-secrets.js';
import { connectionIdForModel } from '../model-router/connections.js';
import { createGeminiLiveProvider } from './gemini.js';
import { createOpenAIRealtimeProvider } from './openai.js';
import type { RealtimeUsage, RealtimeVoiceProvider } from './types.js';

/**
 * The voice model is the catalog row the `voice` role points at, served by the
 * same owner-connected providers as the text models. Voice rows carry audio
 * rates in `capabilities` because audio and text tokens are priced apart.
 */
export interface VoiceModelCapabilities {
  realtime: true;
  /** USD per million audio input tokens (the other party's speech). */
  audioInputPerMTok: number;
  /** USD per million audio output tokens (the assistant's speech). */
  audioOutputPerMTok: number;
  /** Provider voice name, e.g. "marin" or "Aoede". */
  voice?: string;
}

export function voiceCapabilities(model: Records['models'] | null): VoiceModelCapabilities | null {
  const caps = (model?.capabilities ?? {}) as Partial<VoiceModelCapabilities>;
  if (
    caps.realtime !== true ||
    !Number.isFinite(caps.audioInputPerMTok) ||
    !Number.isFinite(caps.audioOutputPerMTok)
  )
    return null;
  return caps as VoiceModelCapabilities;
}

export interface ResolvedVoiceModel {
  provider: RealtimeVoiceProvider;
  /** The provider's own model name. */
  model: string;
  voice?: string;
  rates: {
    audioInputPerMTok: number;
    audioOutputPerMTok: number;
    textInputPerMTok: number;
    textOutputPerMTok: number;
  };
}

export class VoiceModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceModelUnavailableError';
  }
}

/** Build the live-session provider for a catalog voice model. */
export function resolveVoiceModel(input: {
  model: Records['models'] | null;
  connections: readonly Records['modelConnections'][];
  config: Pick<Config, 'VERTEX_PROJECT' | 'VERTEX_LOCATION'>;
  decrypt?: (sealed: string) => string;
}): ResolvedVoiceModel {
  const row = input.model;
  const caps = voiceCapabilities(row);
  if (!row?.enabled || !caps)
    throw new VoiceModelUnavailableError(
      'No voice model is set up. Choose one in Settings → AI providers.',
    );
  const decrypt = input.decrypt ?? decryptStoredCredential;
  const connectionId = connectionIdForModel(row.id);
  const connection = input.connections.find((candidate) => candidate.id === connectionId);
  if (connection && !connection.enabled)
    throw new VoiceModelUnavailableError(`The ${connection.label} connection is turned off.`);
  const rates = {
    audioInputPerMTok: caps.audioInputPerMTok,
    audioOutputPerMTok: caps.audioOutputPerMTok,
    textInputPerMTok: Number(row.promptCostPerMTok ?? 0),
    textOutputPerMTok: Number(row.completionCostPerMTok ?? 0),
  };
  if (row.id.startsWith('openai:')) {
    const key = connection?.apiKeyEncrypted ? decrypt(connection.apiKeyEncrypted) : '';
    if (!key)
      throw new VoiceModelUnavailableError(
        'Connect OpenAI with an API key in Settings → AI providers to use this voice model.',
      );
    return {
      provider: createOpenAIRealtimeProvider({ apiKey: key }),
      model: row.id.slice('openai:'.length),
      voice: caps.voice,
      rates,
    };
  }
  if (/^vertex[:/]/.test(row.id)) {
    const project = connection?.vertexProject || input.config.VERTEX_PROJECT;
    const location = connection?.vertexLocation || input.config.VERTEX_LOCATION;
    if (!project || !location)
      throw new VoiceModelUnavailableError(
        'Connect Google Vertex AI in Settings → AI providers to use this voice model.',
      );
    return {
      provider: createGeminiLiveProvider({ project, location }),
      model: row.id.replace(/^vertex[:/]/, ''),
      voice: caps.voice,
      rates,
    };
  }
  throw new VoiceModelUnavailableError(
    `${row.label} is not a supported live voice model (OpenAI Realtime or Gemini Live).`,
  );
}

/** Actual model spend for a finished call. */
export function realtimeCostUsd(usage: RealtimeUsage, rates: ResolvedVoiceModel['rates']): number {
  return (
    (usage.inputAudioTokens * rates.audioInputPerMTok +
      usage.inputTextTokens * rates.textInputPerMTok +
      usage.outputAudioTokens * rates.audioOutputPerMTok +
      usage.outputTextTokens * rates.textOutputPerMTok) /
    1_000_000
  );
}

/**
 * A deliberately high per-minute estimate for the budget hold. Realtime APIs
 * re-bill the whole conversation on every turn, so input grows with call
 * length; 6k input and 1.5k output tokens a minute covers a busy call.
 */
export function realtimeEstimatePerMinuteUsd(rates: ResolvedVoiceModel['rates']): number {
  return (6_000 * rates.audioInputPerMTok + 1_500 * rates.audioOutputPerMTok) / 1_000_000;
}
