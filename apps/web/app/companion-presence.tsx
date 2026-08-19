'use client';

import { useEffect, useRef } from 'react';
import {
  type CompanionState,
  type CompanionPresence as Presence,
  setCompanionState,
  subscribeCompanion,
} from '@/lib/companion-bus';
import { FRAGMENT_SRC, VERTEX_SRC } from '@/lib/companion-shader';
import { type CompanionUniforms, resolveCompanionUniforms } from '@/lib/companion-visual';

/*
 * The companion, rendered as the app itself.
 *
 * A fixed, click-through canvas behind every page. It listens to the companion
 * bus rather than to any one screen, so the same creature is present in chat,
 * on the tasks page, and while the shell reports background work.
 *
 * Everything here is progressive enhancement: without WebGL2 the element keeps
 * a soft CSS wash and the app is unchanged, and with reduced motion the field
 * is painted once and only repainted when the companion's state actually
 * changes — no idle animation loop at all.
 */

// The field is soft by nature, so it is rendered below CSS resolution and
// scaled up: full-DPR fbm over a 4K viewport costs a great deal of GPU for a
// difference nobody can see.
const RENDER_SCALE = 0.6;
const MAX_DPR = 2;
// Seconds. How fast the render catches up to a newly published cue — quick
// enough to feel like a reaction, slow enough to read as a living thing.
const EASE_RATE = 3.2;
const GAZE_RATE = 2.1;
const COLOR_RATE = 1.6;
const BLINK_SECONDS = 0.17;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('companion shader failed to compile', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function link(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  // The shaders are attached to the program; deleting the handles here just
  // drops our references, the program keeps what it needs.
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('companion program failed to link', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/** Frame-rate independent approach toward a target. */
function approach(from: number, to: number, rate: number, dt: number): number {
  return from + (to - from) * (1 - Math.exp(-rate * dt));
}

export function CompanionPresence({ presence }: { presence: Presence }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Publish the server's baseline. Its own effect so a navigation that changes
  // the shell's presence updates the creature without remounting the canvas.
  useEffect(() => {
    setCompanionState({ presence });
  }, [presence]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
    });
    // No WebGL2 (older Safari, blocked GPU, headless): hand over to the CSS
    // wash and never touch the canvas again.
    if (!gl) {
      canvas.dataset.fallback = 'true';
      return;
    }

    const program = link(gl);
    if (!program) {
      canvas.dataset.fallback = 'true';
      return;
    }

    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const locations = {
      resolution: uniform('uResolution'),
      time: uniform('uTime'),
      color: uniform('uColor'),
      dark: uniform('uDark'),
      openness: uniform('uOpenness'),
      lidTilt: uniform('uLidTilt'),
      lidRise: uniform('uLidRise'),
      pupil: uniform('uPupil'),
      energy: uniform('uEnergy'),
      warmth: uniform('uWarmth'),
      gaze: uniform('uGaze'),
      bob: uniform('uBob'),
      blink: uniform('uBlink'),
      pointer: uniform('uPointer'),
    };

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const isDark = () => document.documentElement.classList.contains('dark');

    let lastState: CompanionState = {
      expression: 'neutral',
      mood: 'default',
      activity: 'idle',
      presence: 'idle',
    };
    let target: CompanionUniforms = resolveCompanionUniforms(lastState, { dark: isDark() });
    // Start already settled so the first paint is the resting creature rather
    // than an animation flying in from zero.
    let shown: CompanionUniforms = { ...target, color: [...target.color] };
    let pointer = { x: 0, y: 0 };
    const pointerTarget = { x: 0, y: 0 };
    let blink = 0;
    let blinkUntil = 0;
    let nextBlink = 2 + Math.random() * 4;
    let clock = 0;
    let last = 0;
    let frame = 0;
    let running = false;
    let disposed = false;

    const resize = () => {
      const scale = Math.min(window.devicePixelRatio || 1, MAX_DPR) * RENDER_SCALE;
      const width = Math.max(1, Math.round(canvas.clientWidth * scale));
      const height = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width === width && canvas.height === height) return false;
      canvas.width = width;
      canvas.height = height;
      return true;
    };

    const paint = () => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      // WebGL's useProgram is not a React hook; the rule matches the `use` prefix.
      // biome-ignore lint/correctness/useHookAtTopLevel: not a React hook
      gl.useProgram(program);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(locations.resolution, canvas.width, canvas.height);
      gl.uniform1f(locations.time, clock);
      gl.uniform3f(locations.color, shown.color[0], shown.color[1], shown.color[2]);
      gl.uniform1f(locations.dark, isDark() ? 1 : 0);
      gl.uniform1f(locations.openness, shown.openness);
      gl.uniform1f(locations.lidTilt, shown.lidTilt);
      gl.uniform1f(locations.lidRise, shown.lidRise);
      gl.uniform1f(locations.pupil, shown.pupil);
      gl.uniform1f(locations.energy, shown.energy);
      gl.uniform1f(locations.warmth, shown.warmth);
      gl.uniform2f(locations.gaze, shown.gazeX, shown.gazeY);
      gl.uniform1f(locations.bob, shown.bob);
      gl.uniform1f(locations.blink, blink);
      gl.uniform2f(locations.pointer, pointer.x, pointer.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    /** Reduced motion: snap to the new state and paint exactly one frame. */
    const paintStatic = () => {
      resize();
      shown = { ...target, color: [...target.color] };
      pointer = { x: 0, y: 0 };
      blink = 0;
      paint();
    };

    const tick = (now: number) => {
      if (disposed) return;
      const dt = last === 0 ? 0.016 : Math.min((now - last) / 1000, 0.05);
      last = now;
      clock += dt;
      resize();

      shown.openness = approach(shown.openness, target.openness, EASE_RATE, dt);
      shown.lidTilt = approach(shown.lidTilt, target.lidTilt, EASE_RATE, dt);
      shown.lidRise = approach(shown.lidRise, target.lidRise, EASE_RATE, dt);
      shown.pupil = approach(shown.pupil, target.pupil, EASE_RATE, dt);
      shown.energy = approach(shown.energy, target.energy, EASE_RATE, dt);
      shown.warmth = approach(shown.warmth, target.warmth, EASE_RATE, dt);
      shown.bob = approach(shown.bob, target.bob, EASE_RATE, dt);
      shown.gazeX = approach(shown.gazeX, target.gazeX, GAZE_RATE, dt);
      shown.gazeY = approach(shown.gazeY, target.gazeY, GAZE_RATE, dt);
      for (let i = 0; i < 3; i += 1) {
        shown.color[i] = approach(
          shown.color[i] as number,
          target.color[i] as number,
          COLOR_RATE,
          dt,
        );
      }
      pointer.x = approach(pointer.x, pointerTarget.x, 1.8, dt);
      pointer.y = approach(pointer.y, pointerTarget.y, 1.8, dt);

      if (clock >= nextBlink && blinkUntil === 0) {
        blinkUntil = clock + BLINK_SECONDS;
        nextBlink = clock + 2.5 + Math.random() * 5;
      }
      if (blinkUntil > 0) {
        const remaining = blinkUntil - clock;
        blink = remaining <= 0 ? 0 : Math.sin((1 - remaining / BLINK_SECONDS) * Math.PI);
        if (remaining <= 0) blinkUntil = 0;
      }

      paint();
      frame = window.requestAnimationFrame(tick);
    };

    const start = () => {
      if (running || disposed || reduceMotion.matches) return;
      running = true;
      last = 0;
      frame = window.requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    };

    const apply = (state: CompanionState) => {
      lastState = state;
      target = resolveCompanionUniforms(state, { dark: isDark() });
      // A change of feeling gets a blink, the way a real face resets.
      if (!reduceMotion.matches) nextBlink = Math.min(nextBlink, clock + 0.12);
      if (reduceMotion.matches) paintStatic();
    };

    const unsubscribe = subscribeCompanion(apply);

    // The theme toggle rewrites the root class; re-read the palette from it
    // rather than depending on any one event name.
    const themeObserver = new MutationObserver(() => {
      target = resolveCompanionUniforms(lastState, { dark: isDark() });
      if (reduceMotion.matches) paintStatic();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    const onPointer = (event: PointerEvent) => {
      pointerTarget.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointerTarget.y = 1 - (event.clientY / window.innerHeight) * 2;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    const onMotionChange = () => {
      if (reduceMotion.matches) {
        stop();
        paintStatic();
      } else {
        start();
      }
    };
    const onResize = () => {
      if (reduceMotion.matches) paintStatic();
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      stop();
    };

    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    reduceMotion.addEventListener('change', onMotionChange);
    canvas.addEventListener('webglcontextlost', onContextLost);

    if (reduceMotion.matches) paintStatic();
    else start();

    return () => {
      disposed = true;
      stop();
      unsubscribe();
      themeObserver.disconnect();
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      reduceMotion.removeEventListener('change', onMotionChange);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);

  // The wrapper carries aria-hidden so the canvas itself stays a plain,
  // non-focusable element: this is decoration, and there is nothing here for a
  // screen reader to read — the chat still states its status in words.
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0">
      <canvas ref={canvasRef} className="companion-presence h-full w-full" />
    </div>
  );
}
