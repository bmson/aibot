/**
 * A live speech-to-speech model session bridged onto a phone call.
 *
 * Audio crosses this boundary as G.711 μ-law at 8 kHz in both directions —
 * the phone line's own format — so the call bridge never knows which model is
 * on the other side; each adapter converts to whatever its API speaks.
 */

export interface RealtimeToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface RealtimeSessionConfig {
  /** The provider's own model name, without our catalog namespace. */
  model: string;
  instructions: string;
  /** Provider voice name; the provider default when omitted. */
  voice?: string;
  tools: readonly RealtimeToolSpec[];
}

export interface RealtimeToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** Token counts by modality; audio and text are priced differently. */
export interface RealtimeUsage {
  inputAudioTokens: number;
  inputTextTokens: number;
  cachedInputTokens: number;
  outputAudioTokens: number;
  outputTextTokens: number;
}

export function emptyRealtimeUsage(): RealtimeUsage {
  return {
    inputAudioTokens: 0,
    inputTextTokens: 0,
    cachedInputTokens: 0,
    outputAudioTokens: 0,
    outputTextTokens: 0,
  };
}

export interface RealtimeSessionEvents {
  /** Speech for the other party, μ-law 8 kHz. */
  audio(mulaw: Uint8Array): void;
  /** The other party started talking over the assistant: stop playback now. */
  speechStarted(): void;
  /** A finished utterance. `caller` is the person on the phone. */
  transcript(role: 'caller' | 'assistant', text: string): void;
  toolCall(call: RealtimeToolCall): void;
  error(error: Error): void;
  /** The provider closed the session. */
  closed(): void;
}

/**
 * Whether answering a tool call should make the model speak again.
 *
 * - `respond`: the result is news the model must act on (an owner's answer).
 * - `if_silent`: bookkeeping made alongside speech (a noted fact). Speak only
 *   when the turn that made the call said nothing, so the caller is never
 *   left waiting — and never hears the same sentence twice.
 * - `none`: the line itself answers next (keys pressed into a phone menu), or
 *   the call is ending.
 */
export type ToolFollowUp = 'respond' | 'if_silent' | 'none';

export interface RealtimeSession {
  /** Caller audio from the phone line, μ-law 8 kHz. */
  sendAudio(mulaw: Uint8Array): void;
  /** Answer a tool call. `followUp` defaults to `respond`. */
  sendToolResult(call: RealtimeToolCall, result: unknown, followUp?: ToolFollowUp): void;
  /** Ask the model to speak now, optionally steering this one turn. */
  respond(instructions?: string): void;
  /**
   * The caller interrupted. `unplayedMs` is how much already-sent speech had
   * not reached the line yet, so the model's memory of what it said matches
   * what the caller heard.
   */
  interrupt(unplayedMs: number): void;
  usage(): RealtimeUsage;
  close(): Promise<void>;
}

export interface RealtimeVoiceProvider {
  readonly kind: 'openai' | 'vertex';
  connect(config: RealtimeSessionConfig, events: RealtimeSessionEvents): Promise<RealtimeSession>;
}
