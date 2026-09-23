export interface VoiceProfileEditInput {
  description: string;
  dos: string;
  donts: string;
  signature: string;
}

export interface NormalizedVoiceProfile {
  description: string;
  dos: string[];
  donts: string[];
  signature: string;
}

/** The same owner-edit bounds apply to PostgreSQL and Firestore profiles. */
export function normalizeVoiceProfileEdit(
  input: VoiceProfileEditInput,
): { value: NormalizedVoiceProfile; error?: never } | { value?: never; error: string } {
  const description = input.description.trim().slice(0, 2000);
  if (!description) return { error: 'The voice description is required.' };
  const lines = (raw: string) =>
    raw
      .split('\n')
      .map((line) => line.trim().slice(0, 300))
      .filter((line) => line.length > 0)
      .slice(0, 12);
  return {
    value: {
      description,
      dos: lines(input.dos),
      donts: lines(input.donts),
      signature: input.signature.trim().slice(0, 300),
    },
  };
}
