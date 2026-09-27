import { describe, expect, it } from 'vitest';
import {
  dtmfMulaw,
  MULAW_FRAME_BYTES,
  mulawFrames,
  mulawToPcm16,
  pcm16FromBytes,
  pcm16ToBytes,
  pcm16ToMulaw,
  pcmToTelephone,
  resamplePcm16,
  telephoneToPcm,
} from './audio-codec.js';

function tone(frequency: number, rate: number, ms: number, amplitude = 8_000): Int16Array {
  return Int16Array.from({ length: (rate * ms) / 1_000 }, (_, i) =>
    Math.round(amplitude * Math.sin((2 * Math.PI * frequency * i) / rate)),
  );
}

function rms(samples: ArrayLike<number>, skip = 0): number {
  let sum = 0;
  for (let i = skip; i < samples.length - skip; i++) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, samples.length - 2 * skip));
}

/** Goertzel power of one frequency, normalized per sample. */
function power(samples: ArrayLike<number>, frequency: number, rate: number): number {
  const k = 2 * Math.cos((2 * Math.PI * frequency) / rate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = (samples[i] ?? 0) + k * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / samples.length ** 2;
}

describe('telephone audio codec', () => {
  it('round-trips every μ-law code through linear PCM', () => {
    const codes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const back = pcm16ToMulaw(mulawToPcm16(codes));
    for (let i = 0; i < 256; i++) {
      // 0x7f and 0xff both mean zero; the encoder picks 0xff.
      expect(back[i]).toBe(i === 0x7f ? 0xff : i);
    }
  });

  it('keeps a speech-band tone intact through encode, decode, and resampling', () => {
    const original = tone(440, 8_000, 200);
    const decoded = mulawToPcm16(pcm16ToMulaw(original));
    expect(Math.abs(rms(decoded) - rms(original)) / rms(original)).toBeLessThan(0.02);

    const up = resamplePcm16(decoded, 8_000, 16_000);
    expect(up).toHaveLength(3_200);
    expect(power(up, 440, 16_000)).toBeGreaterThan(100 * power(up, 1_000, 16_000));
    const down = resamplePcm16(tone(440, 24_000, 200), 24_000, 8_000);
    expect(down).toHaveLength(1_600);
    expect(rms(down, 20) / 8_000).toBeGreaterThan(0.65);
  });

  it('filters content above the telephone band before downsampling', () => {
    const hiss = resamplePcm16(tone(7_000, 24_000, 200), 24_000, 8_000);
    expect(rms(hiss, 20)).toBeLessThan(0.05 * 8_000);
  });

  it('converts whole frames between Twilio μ-law and realtime PCM bytes', () => {
    const frame = pcm16ToMulaw(tone(300, 8_000, 20));
    expect(frame).toHaveLength(MULAW_FRAME_BYTES);
    const pcm16k = telephoneToPcm(frame, 16_000);
    expect(pcm16k).toHaveLength(640);
    expect(pcm16FromBytes(pcm16ToBytes(Int16Array.of(-2, 1, 32_767)))).toEqual(
      Int16Array.of(-2, 1, 32_767),
    );
    expect(pcmToTelephone(pcm16ToBytes(tone(300, 24_000, 20)), 24_000)).toHaveLength(160);
  });

  it('synthesizes dual-tone key presses a phone menu can decode', () => {
    const audio = mulawToPcm16(dtmfMulaw('5'));
    const pressed = audio.subarray(0, 960);
    // 5 = 770 Hz + 1336 Hz; its neighbours on the keypad must be quiet.
    const low = power(pressed, 770, 8_000);
    const high = power(pressed, 1_336, 8_000);
    for (const other of [697, 852, 941, 1_209, 1_477]) {
      expect(low).toBeGreaterThan(50 * power(pressed, other, 8_000));
      expect(high).toBeGreaterThan(50 * power(pressed, other, 8_000));
    }
    expect(dtmfMulaw('12w#')).toHaveLength(3 * (960 + 640) + 4_000);
    expect(() => dtmfMulaw('1; rm')).toThrow('DTMF');
  });

  it('splits audio into 20 ms Twilio frames', () => {
    const frames = mulawFrames(new Uint8Array(400));
    expect(frames.map((frame) => frame.length)).toEqual([160, 160, 80]);
  });
});
