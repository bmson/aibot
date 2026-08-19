/*
 * The companion's face, as one fragment shader.
 *
 * There is no model and no geometry: a single full-screen triangle, and every
 * pixel of the app decides for itself how alive it is. That is the point of
 * the design — the character is not drawn inside the interface, it is the
 * surface the interface sits on.
 *
 * The face is deliberately plain: two lenses, a pupil, a glint, and a pair of
 * straight eyelids. All of the feeling is in the lids — how far they close and
 * what angle they sit at — which is the WALL·E trick, and it survives being
 * shrunk, blurred, or glanced at. Detail inside the eye only muddies that, so
 * there is none. Behind the face a slow noise field breathes, which is the
 * body; it is kept low-contrast so the eyes stay the thing you read.
 *
 * Alpha is capped per theme (see maxA) so this layer tints and glows but can
 * never wash out the page, keeping text above it readable by construction.
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
uniform float uOpenness;  // lid aperture
uniform float uLidTilt;   // -1 inner corners up .. +1 inner corners down
uniform float uLidRise;   // bottom lid push (the smile)
uniform float uPupil;     // pupil size
uniform float uEnergy;    // motion and glow
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

/*
 * One lens. Returns rgb in .xyz and coverage in .w.
 *
 * The side argument is -1 for the left eye and +1 for the right, mirroring the lid
 * angle so the two lids form a matched pair rather than parallel lines — that
 * symmetry is what makes the angle read as an eyebrow instead of a tilt.
 */
vec4 lens(vec2 p, float side, float R, float aa, vec3 tint, float dark,
          float openness, float tilt, float rise, float pupilScale, vec2 look) {
  float r = length(p);

  // Housing: a filled disc with a brighter rim, so the shape holds together on
  // a pale ground as well as a dark one.
  float disc = smoothstep(R + aa, R - aa, r);
  float rim = smoothstep(R + aa, R - aa, r) * smoothstep(R * 0.82 - aa, R * 0.82 + aa, r);

  // Pupil, offset by gaze so the eyes track together.
  vec2 q = p - look * R * 0.30;
  float pr = length(q);
  float pupilR = R * mix(0.20, 0.46, pupilScale);
  float pupil = smoothstep(pupilR + aa, pupilR - aa, pr);

  // A single hard glint. The one crisp detail on the whole face.
  float glint = smoothstep(R * 0.13, R * 0.05, length(q - vec2(-pupilR * 0.5, pupilR * 0.55)));

  // Eyelids: straight half-plane cuts, mirrored between the eyes. Everything
  // the face feels is in these two numbers.
  float a = tilt * side * 1.15;
  float ca = cos(a);
  float sa = sin(a);
  vec2 rp = vec2(p.x * ca + p.y * sa, p.y * ca - p.x * sa);

  // The bottom lid eats into whatever the top lid left, never past it: a big
  // smile-squeeze and a low aperture together used to cross the two lids and
  // erase the eye completely.
  float topEdge = R * (2.0 * openness - 1.0);
  float botEdge = -R + rise * (topEdge + R) * 0.82;

  // Top lid is a straight cut — that hard line is what reads as a brow. The
  // bottom lid is an arc, so a squeeze closes the eye into a smiling crescent
  // instead of a letterbox slot.
  float lidTop = smoothstep(topEdge + aa, topEdge - aa, rp.y);
  float botR = R * 1.9;
  float lidBot = smoothstep(botR - aa, botR + aa, length(rp - vec2(0.0, botEdge - botR)));
  float open = lidTop * lidBot;

  // Compose the lens, then let the lids cut the whole thing away.
  // Light: a saturated lens ringed by a dark outline, so it reads as drawn
  // rather than as a grey smudge on a pale page. Dark: a dim shell with a
  // bright rim, so it reads as a lit lens.
  vec3 shell = mix(tint * 0.85, tint * 0.42, dark);
  vec3 rimCol = mix(tint * 0.34, tint * 1.30, dark);
  vec3 pupilCol = mix(tint * 0.12, tint * 0.07, dark);
  vec3 glintCol = mix(tint * 1.7 + 0.30, vec3(1.0), dark);

  vec3 col = shell;
  col = mix(col, rimCol, rim);
  col = mix(col, pupilCol, pupil);
  col = mix(col, glintCol, glint * 0.95);

  float cover = max(disc * 0.93, rim * 0.97);
  cover = max(cover, pupil * 0.97);
  cover = max(cover, glint * 0.9);
  return vec4(col, cover * open);
}

void main() {
  vec2 res = max(uResolution, vec2(1.0));
  vec2 uv = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float t = uTime;

  // ── Body: the screen as skin. A flow field advects the noise so the motion
  // curls instead of sliding, and a slow sine breathes the whole thing. Kept
  // quiet — it is the room the face lives in, not the subject.
  float breathe = 0.5 + 0.5 * sin(t * 0.5);
  vec2 flow = vec2(fbm(uv * 1.1 + t * 0.035), fbm(uv * 1.1 - t * 0.028 + 19.3)) - 0.5;
  float body = fbm(uv * 1.5 + flow * (0.8 + 0.6 * uEnergy) + vec2(0.0, t * 0.02));
  body = smoothstep(0.25, 0.95, body);
  float vign = 1.0 - smoothstep(0.35, 1.3, length(uv));
  body *= (0.40 + 0.30 * breathe + 0.40 * uEnergy) * vign;

  // ── The face drifts on its own slow path, leaning toward the cursor.
  vec2 wander = vec2(sin(t * 0.23), cos(t * 0.19)) * 0.05;
  vec2 center = uGaze * 0.22 + wander + uPointer * 0.045;
  center.y += sin(t * 2.4) * 0.03 * uBob;

  float R = 0.145;
  float sep = R * 1.28;
  float aa = R * 0.04;
  vec2 look = clamp(uGaze * 1.6 + uPointer * 0.35, -1.0, 1.0);
  // Blinking just closes the lids, the same control the expressions use.
  float openness = mix(uOpenness, 0.02, uBlink);

  vec3 warmTint = mix(vec3(-0.06, -0.02, 0.10), vec3(0.16, 0.06, -0.06), uWarmth * 0.5 + 0.5);
  vec3 tint = clamp(uColor + warmTint, 0.0, 1.0);

  vec4 lensL = lens(uv - (center + vec2(-sep, 0.0)), -1.0, R, aa, tint, uDark,
                    openness, uLidTilt, uLidRise, uPupil, look);
  vec4 lensR = lens(uv - (center + vec2(sep, 0.0)), 1.0, R, aa, tint, uDark,
                    openness, uLidTilt, uLidRise, uPupil, look);

  // A soft halo tying the two lenses to the field behind them.
  float halo = exp(-length(uv - center) * 5.0) * (0.25 + 0.55 * uEnergy);

  // ── Compose. Layers are averaged by weight, never summed: summing tinted
  // light washes a pale canvas out to near-white, while averaging keeps every
  // pixel inside the mood's family, so the palette alone decides whether the
  // creature reads as ink on paper or as emitted light.
  vec3 acc = tint * (body * 0.55) + tint * (halo * 0.6);
  float wsum = body * 0.55 + halo * 0.6;
  float cover = body * 0.34 + halo * 0.34;

  vec3 col = wsum > 0.0001 ? acc / wsum : tint;
  cover = clamp(cover, 0.0, 1.0);

  // The face sits on top of its own field rather than averaging into it.
  float faceA = max(lensL.w, lensR.w);
  vec3 faceCol = lensL.w >= lensR.w ? lensL.xyz : lensR.xyz;
  col = mix(col, faceCol, faceA);
  cover = max(cover, faceA);

  // Bounded so content above stays readable on either ground. Light needs the
  // larger budget: a dark-on-pale creature has to commit to be seen at all,
  // where the dark theme reads from much less emitted light.
  float maxA = mix(0.72, 0.66, uDark);
  fragColor = vec4(clamp(col, 0.0, 1.0), cover * maxA);
}`;
