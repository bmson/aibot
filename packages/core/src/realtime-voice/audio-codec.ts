/**
 * Telephone audio plumbing for live calls.
 *
 * Twilio Media Streams carry G.711 μ-law at 8 kHz, 20 ms (160-byte) frames.
 * OpenAI Realtime speaks μ-law natively; Gemini Live wants 16-bit PCM at
 * 16 kHz in and sends 24 kHz back. Everything here is pure and synchronous:
 * a call runs these on every 20 ms frame, so no allocation-heavy streams.
 */

export const TELEPHONE_RATE = 8_000;
/** Bytes in one 20 ms μ-law frame at 8 kHz. */
export const MULAW_FRAME_BYTES = 160;

const BIAS = 0x84;
const CLIP = 32_635;

const DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const value = ~i & 0xff;
    const sign = value & 0x80;
    const exponent = (value >> 4) & 0x07;
    const mantissa = value & 0x0f;
    const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
    table[i] = sign ? -magnitude : magnitude;
  }
  return table;
})();

/** G.711 μ-law bytes → 16-bit linear PCM samples. */
export function mulawToPcm16(input: Uint8Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) output[i] = DECODE_TABLE[input[i] ?? 0xff] ?? 0;
  return output;
}

function encodeSample(sample: number): number {
  let value = Math.max(-CLIP, Math.min(CLIP, sample | 0));
  const sign = value < 0 ? 0x80 : 0;
  if (sign) value = -value;
  value += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** 16-bit linear PCM samples → G.711 μ-law bytes. */
export function pcm16ToMulaw(input: Int16Array): Uint8Array {
  const output = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) output[i] = encodeSample(input[i] ?? 0);
  return output;
}

/** Little-endian 16-bit PCM bytes, the wire format of every realtime API. */
export function pcm16FromBytes(bytes: Uint8Array): Int16Array {
  const samples = new Int16Array(bytes.length >> 1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return samples;
}

export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true);
  return bytes;
}

/** A symmetric windowed-sinc low-pass kernel, normalized to unity gain. */
function lowPassKernel(cutoff: number, taps: number): Float64Array {
  const kernel = new Float64Array(taps);
  const middle = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - middle;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const blackman =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    kernel[i] = sinc * blackman;
    sum += kernel[i] ?? 0;
  }
  for (let i = 0; i < taps; i++) kernel[i] = (kernel[i] ?? 0) / sum;
  return kernel;
}

const kernels = new Map<string, Float64Array>();

/**
 * Resample 16-bit PCM between the rates a call uses (8, 16, 24 kHz).
 * Downsampling low-passes first so speech above the telephone band does not
 * fold back as hiss; upsampling interpolates linearly, which is inaudible at
 * telephone bandwidth. Stateless per chunk: at 20 ms frames the seam between
 * chunks is below the noise floor of a phone line.
 */
export function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || input.length === 0) return input.slice();
  let source: ArrayLike<number> = input;
  if (toRate < fromRate) {
    const key = `${fromRate}:${toRate}`;
    let kernel = kernels.get(key);
    if (!kernel) {
      // Cut just below the new Nyquist frequency, as a fraction of the old rate.
      kernel = lowPassKernel((0.45 * toRate) / fromRate, 31);
      kernels.set(key, kernel);
    }
    const filtered = new Float64Array(input.length);
    const half = (kernel.length - 1) / 2;
    for (let i = 0; i < input.length; i++) {
      let acc = 0;
      for (let k = 0; k < kernel.length; k++) {
        const index = Math.min(input.length - 1, Math.max(0, i + k - half));
        acc += (input[index] ?? 0) * (kernel[k] ?? 0);
      }
      filtered[i] = acc;
    }
    source = filtered;
  }
  const length = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const output = new Int16Array(length);
  const step = fromRate / toRate;
  for (let i = 0; i < length; i++) {
    const position = i * step;
    const left = Math.floor(position);
    const right = Math.min(source.length - 1, left + 1);
    const fraction = position - left;
    const value = (source[left] ?? 0) * (1 - fraction) + (source[right] ?? 0) * fraction;
    output[i] = Math.max(-32_768, Math.min(32_767, Math.round(value)));
  }
  return output;
}

/** μ-law 8 kHz (Twilio) → PCM16 at `rate`, as bytes. */
export function telephoneToPcm(mulaw: Uint8Array, rate: number): Uint8Array {
  return pcm16ToBytes(resamplePcm16(mulawToPcm16(mulaw), TELEPHONE_RATE, rate));
}

/** PCM16 bytes at `rate` → μ-law 8 kHz (Twilio). */
export function pcmToTelephone(pcm: Uint8Array, rate: number): Uint8Array {
  return pcm16ToMulaw(resamplePcm16(pcm16FromBytes(pcm), rate, TELEPHONE_RATE));
}

const DTMF: Record<string, [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  A: [697, 1633],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  B: [770, 1633],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  C: [852, 1633],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477],
  D: [941, 1633],
};

/** Digits a phone menu accepts; `w` is a half-second pause. */
export const DTMF_DIGITS = /^[0-9*#A-Dw]{1,32}$/;

/**
 * In-band DTMF as μ-law audio, for navigating phone menus. A bidirectional
 * media stream can only send audio, so key presses are synthesized as the
 * standard dual tones (≥ 40 ms each by ITU Q.24; 120 ms here for margin over
 * lossy codecs).
 */
export function dtmfMulaw(digits: string, toneMs = 120, gapMs = 80): Uint8Array {
  if (!DTMF_DIGITS.test(digits)) throw new Error('DTMF digits must be 0-9, *, #, A-D or w');
  const perMs = TELEPHONE_RATE / 1_000;
  const samples: number[] = [];
  for (const digit of digits) {
    if (digit === 'w') {
      for (let i = 0; i < 500 * perMs; i++) samples.push(0);
      continue;
    }
    const [low, high] = DTMF[digit] as [number, number];
    for (let i = 0; i < toneMs * perMs; i++) {
      const t = i / TELEPHONE_RATE;
      samples.push(
        Math.round(7_000 * (Math.sin(2 * Math.PI * low * t) + Math.sin(2 * Math.PI * high * t))),
      );
    }
    for (let i = 0; i < gapMs * perMs; i++) samples.push(0);
  }
  return pcm16ToMulaw(Int16Array.from(samples));
}

/** Split μ-law audio into Twilio-sized 20 ms frames (the last may be short). */
export function mulawFrames(audio: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < audio.length; offset += MULAW_FRAME_BYTES)
    frames.push(audio.subarray(offset, offset + MULAW_FRAME_BYTES));
  return frames;
}
