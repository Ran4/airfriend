// SNES framebuffer. The scene renders into a 256x224 target (nearest, no AA),
// then a fullscreen quad writes it to the canvas quantized to 15-bit color
// (5 bits per channel, like the SNES's CGRAM), with an optional, very subtle
// 4x4 Bayer dither that only shows on gradients (flat 5-bit art stays pure).
//
// Color space: the target stores sRGB-encoded 8-bit texels (three renders
// linear into it and the GPU encodes; sampling decodes back to linear). The
// quad re-encodes to sRGB itself, quantizes in display space (where the SNES
// palette lives) and writes the final value untouched to the canvas.
import * as THREE from 'three';
import { SCREEN } from '../config';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform float uDither;   // 0..1, in units of one 5-bit step
uniform float uQuantize; // 1 = 15-bit, 0 = pass-through (debug comparison)
varying vec2 vUv;

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

// Recursive 4x4 Bayer matrix: 16 levels in [0, 1).
float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }

void main() {
  vec3 c = linearToSrgb(texture2D(tScene, vUv).rgb);
  if (uQuantize > 0.5) {
    // centered threshold so a color sitting exactly on a 5-bit level never flips
    float t = bayer4(gl_FragCoord.xy) + 1.0 / 32.0 - 0.5;
    c += t * uDither / 31.0;
    c = floor(clamp(c, 0.0, 1.0) * 31.0 + 0.5) / 31.0;
  }
  gl_FragColor = vec4(c, 1.0);
}`;

export class PostFX {
  /** strength of the ordered dither, in 5-bit steps (0 = off) */
  dither = 0.55;
  /** false = show the raw 24-bit render (for A/B comparison) */
  quantize = true;

  private target: THREE.WebGLRenderTarget;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.target = new THREE.WebGLRenderTarget(SCREEN.width, SCREEN.height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
      samples: 0,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.target.texture },
        uDither: { value: this.dither },
        uQuantize: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    r.setRenderTarget(null);
    this.material.uniforms.uDither.value = this.dither;
    this.material.uniforms.uQuantize.value = this.quantize ? 1 : 0;
    r.render(this.quadScene, this.quadCam);
  }
}
