import { ShaderMount, dotOrbitFragmentShader, getShaderColorFromString, getShaderNoiseTexture,
  type DotOrbitUniforms } from '@paper-design/shaders';

// Same engine and defaults as React DotOrbit, mounted in the vanilla renderer.
const host = document.getElementById('bg-shader');
if (host) host.dataset.shaderState = 'loading';
const toggle = document.getElementById('pref-shader') as HTMLInputElement | null;
const motion = matchMedia('(prefers-reduced-motion: reduce)');
let mount: ShaderMount | undefined;
let disposed = false;
const uniforms: DotOrbitUniforms = {
  u_colorBack: getShaderColorFromString('#000000'),
  u_colors: ['#ffc96b', '#ff6200', '#ff2f00', '#421100', '#1a0000'].map(color => getShaderColorFromString(color)),
  u_colorsCount: 5, u_stepsPerColor: 4, u_size: 1, u_sizeRange: 0, u_spreading: 1,
  u_fit: 0, u_scale: 1, u_rotation: 0, u_originX: 0.5, u_originY: 0.5,
  u_offsetX: 0, u_offsetY: 0, u_worldWidth: 0, u_worldHeight: 0,
};

function refresh() {
  mount?.setSpeed(motion.matches || document.hidden || toggle?.checked === false ? 0 : 1.5);
}

function attach() {
  if (!host || disposed) return;
  mount?.dispose();
  mount = undefined;
  host.replaceChildren();
  try {
    mount = new ShaderMount(host, dotOrbitFragmentShader, uniforms, { alpha: false }, 0, 0, 1, 1920 * 1080);
    host.dataset.shaderState = 'ready';
    mount.canvasElement.setAttribute('aria-hidden', 'true');
    mount.canvasElement.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      mount?.setSpeed(0);
      host.dataset.shaderState = 'lost';
    });
    mount.canvasElement.addEventListener('webglcontextrestored', attach, { once: true });
    refresh();
  } catch (error) {
    mount?.dispose();
    mount = undefined;
    host.replaceChildren();
    host.dataset.shaderState = 'fallback';
    console.warn('DotOrbit unavailable; showing static background.', error);
  }
}

async function start() {
  if (!host) return;
  try {
    const noise = getShaderNoiseTexture();
    if (!noise) throw new Error('DotOrbit noise texture unavailable');
    await new Promise<void>((resolve, reject) => {
      if (noise.complete && noise.naturalWidth > 0) { resolve(); return; }
      noise.onload = () => resolve();
      noise.onerror = () => reject(new Error('DotOrbit noise texture failed to load'));
    });
    uniforms.u_noiseTexture = noise;
    attach();
  } catch (error) {
    host.dataset.shaderState = 'fallback';
    console.warn('DotOrbit texture failed to load.', error);
  }
}

toggle?.addEventListener('change', refresh);
motion.addEventListener('change', refresh);
document.addEventListener('visibilitychange', refresh);
window.addEventListener('muse-shader-refresh', refresh);
window.addEventListener('pagehide', () => {
  disposed = true;
  mount?.dispose();
  mount = undefined;
  motion.removeEventListener('change', refresh);
  document.removeEventListener('visibilitychange', refresh);
}, { once: true });
void start();
