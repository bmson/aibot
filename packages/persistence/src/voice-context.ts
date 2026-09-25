export interface VoiceProfileText {
  description: string;
  dos: string[];
  donts: string[];
  signature: string;
}

/**
 * The owner's writing voice for outbound rewrites (SMS, email): the stored
 * profile and the nearest writing samples of one register.
 */
export interface VoiceContextRepository {
  readonly kind: 'voice-context-repository';
  profile(): Promise<VoiceProfileText | null>;
  /** Whether any sample of the register exists, so a draft is embedded only when it can match. */
  hasSamples(register: string): Promise<boolean>;
  /** Up to `limit` sample texts nearest the draft embedding. */
  nearestSamples(register: string, embedding: number[], limit: number): Promise<string[]>;
  /** Whether a sample with exactly this text exists, whatever its register. */
  hasSampleText(text: string): Promise<boolean>;
  /** Samples whose context starts with `prefix` (automatic captures). */
  countSamplesWithContextPrefix(prefix: string): Promise<number>;
  addSample(input: {
    register: string;
    text: string;
    context: string;
    embedding: number[];
  }): Promise<void>;
}
