/*
 * The companion's body, as one fragment shader.
 *
 * There is no model and no geometry: a single full-screen triangle, and every
 * pixel of the app decides for itself how alive it is. That is the whole point
 * of the design — the character is not something drawn inside the interface,
 * it is the surface the interface sits on.
 *
 * Two layers compose it. The *body* is a slow flowing fbm field, breathing and
 * pooling toward the center, which gives the screen the sense of being skin.
 * The *iris* is the one focal feature: it drifts on its own path, dilates with
 * feeling, narrows to a slit when concentrating, blinks, and leans toward the
 * cursor so the thing plainly notices you.
 *
 * Alpha is clamped per theme (see maxA) — this layer tints and glows but can
 * never wash out the page, so text contrast above it is safe by construction.
 */

/** Full-screen triangle from gl_VertexID — no attribute buffers at all. */
export const VERTEX_SRC = `#version 300 es
void main() {
  vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FRAGMENT_SRC = `#version 300 es
precision highp float;

uniform vec2  uResolution;
uniform float uTime;
uniform vec3  uColor;
uniform float uDark;      // 0 = light theme, 1 = dark
uniform float uOpenness;  // iris dilation
uniform float uEnergy;    // motion and bloom
uniform float uWarmth;    // -1 cool .. +1 warm
uniform vec2  uGaze;      // where it is looking
uniform float uBob;       // nod amplitude
uniform float uBlink;     // 0 open .. 1 shut
uniform vec2  uPointer;   // cursor, -1..1

out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.02 + 11.7;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 res = max(uResolution, vec2(1.0));
  vec2 uv = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float t = uTime;

  // ── Body: the screen as skin. A flow field advects the noise so the motion
  // curls instead of sliding, and a slow sine breathes the whole thing.
  float breathe = 0.5 + 0.5 * sin(t * 0.5);
  vec2 flow = vec2(fbm(uv * 1.1 + t * 0.035), fbm(uv * 1.1 - t * 0.028 + 19.3)) - 0.5;
  float body = fbm(uv * 1.5 + flow * (0.8 + 0.6 * uEnergy) + vec2(0.0, t * 0.02));
  body = smoothstep(0.25, 0.95, body);
  float vign = 1.0 - smoothstep(0.35, 1.3, length(uv));
  body *= (0.45 + 0.35 * breathe + 0.45 * uEnergy) * vign;

  // ── Iris: its own wandering path, plus gaze, plus a gentle pull toward the
  // cursor. The nod rides on top as a vertical rock.
  vec2 wander = vec2(sin(t * 0.23), cos(t * 0.19)) * 0.06;
  vec2 center = uGaze * 0.34 + wander + uPointer * 0.05;
  center.y += sin(t * 2.4) * 0.03 * uBob;

  vec2 q = uv - center;
  q.y /= max(0.10, 1.0 - uBlink);
  float r = length(q);
  float ang = atan(q.y, q.x);

  float radius = mix(0.085, 0.30, uOpenness);
  // Every edge is deliberately wide. This is a presence seen through water,
  // not a diagram: a crisp boundary would paste a sticker onto the page.
  float irisBody = smoothstep(radius * 1.18, radius * 0.72, r);
  float pupilMask = smoothstep(radius * 0.52, radius * 0.18, r);
  float rim = smoothstep(radius * 1.35, radius * 0.95, r) * smoothstep(radius * 0.55, radius * 1.0, r);
  float bloom = exp(-r * (3.4 - 1.6 * uEnergy)) * (0.34 + 0.66 * uEnergy);

  // Barely-there internal weather rather than spokes. Noise leads and the
  // periodic term only nudges it, so nothing in here reads as machined teeth.
  float wobble = fbm(vec2(ang * 1.1 + t * 0.05, r * 3.2 - t * 0.09));
  float fibre = wobble * 0.75 + 0.25 * (0.5 + 0.5 * sin(ang * 5.0 + wobble * 6.0));
  fibre = mix(0.5, fibre, smoothstep(radius * 0.2, radius * 0.85, r) * 0.3);

  // ── Compose. Warmth leans the hue without leaving the mood's family.
  vec3 warmTint = mix(vec3(-0.06, -0.02, 0.10), vec3(0.16, 0.06, -0.06), uWarmth * 0.5 + 0.5);
  vec3 tint = clamp(uColor + warmTint, 0.0, 1.0);

  // Layers are averaged by weight, never summed. Summing tinted light is what
  // washes a pale canvas out to near-white; averaging keeps every pixel inside
  // the mood's own family, so the palette alone decides whether the creature
  // reads as ink on paper (light) or as emitted light (dark). Coverage is
  // tracked separately and becomes the alpha.
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  float cover = 0.0;

  float wBody = body * 0.55;
  acc += tint * wBody;
  wsum += wBody;
  cover += body * 0.42;

  float wBloom = bloom * 0.6;
  acc += tint * wBloom;
  wsum += wBloom;
  cover += bloom * 0.46;

  vec3 irisLo = mix(tint * 0.78, tint * 0.60, uDark);
  vec3 irisHi = mix(tint * 1.04, tint * 1.16, uDark);
  acc += mix(irisLo, irisHi, fibre) * irisBody;
  wsum += irisBody;
  cover += irisBody * 0.95;

  vec3 rimCol = mix(tint * 0.66, tint * 1.28, uDark);
  float wRim = rim * 0.9;
  acc += rimCol * wRim;
  wsum += wRim;
  cover += rim * 0.46;

  vec3 col = wsum > 0.0001 ? acc / wsum : tint;

  // The pupil absorbs: a deep well of the mood's own colour, never flat black,
  // which would punch a hole in the page.
  vec3 pupil = mix(tint * 0.30, tint * 0.12, uDark);
  col = mix(col, pupil, pupilMask * 0.92);
  cover = max(cover, pupilMask * 0.92);

  // A small off-centre glint — the one hard detail allowed, and the thing that
  // makes the shape read as looking back at you.
  vec2 hl = q - vec2(-radius * 0.26, radius * 0.30);
  float spec = exp(-dot(hl, hl) / (radius * radius * 0.014 + 1e-6));
  col = mix(col, mix(vec3(1.0), tint * 1.6 + 0.3, 1.0 - uDark), spec * 0.85);
  cover = max(cover, spec * 0.55);

  // Bounded so content above stays readable on either ground. Light needs the
  // larger budget: a dark-on-pale creature has to commit to be seen at all,
  // where the dark theme reads from a much smaller amount of emitted light.
  float maxA = mix(0.62, 0.58, uDark);
  fragColor = vec4(clamp(col, 0.0, 1.0), clamp(cover, 0.0, 1.0) * maxA);
}`;
