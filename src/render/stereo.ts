/**
 * Stereo output packer.
 *
 * Rendering the two eyes and getting them onto a particular kind of 3D
 * display are separate problems. The viewport renders each eye into its own
 * texture (see viewport.ts); this class then combines the two textures into
 * the layout the display hardware expects, in one fullscreen pass:
 *
 *   mono              copy the left texture
 *   side-by-side      left eye in the left half, right eye in the right half
 *                     (full: double-wide canvas; half: normal canvas, eyes squeezed)
 *   top-bottom        same, stacked
 *   row / column /    alternate eyes per pixel row, column or checker cell:
 *   checkerboard      passive polarized panels with a patterned retarder
 *   anaglyph          colour-multiplex both eyes for red-cyan glasses
 *   frame-sequential  show one eye per frame, parity from the cluster frame
 *                     counter (experimental: browsers give no vsync guarantee)
 *
 * One shader handles every mode; a uniform selects it. The pass can write to
 * the canvas or to a render target (used by the overview).
 *
 * Interleaved modes are pixel-exact: they only work when one canvas pixel is
 * one display pixel (fullscreen, devicePixelRatio 1, no browser zoom). The
 * `phase` uniforms shift the pattern by whole pixels to compensate for a
 * window that does not start on an even display row or column.
 */
import * as THREE from "three";
import type { AnaglyphScheme, StereoMode, StereoParams } from "../core/config";

const MODE_ID: Record<StereoMode, number> = {
  mono: 0,
  "side-by-side": 1,
  "side-by-side-half": 1,
  "top-bottom": 2,
  "top-bottom-half": 2,
  "row-interleaved": 3,
  "column-interleaved": 4,
  checkerboard: 5,
  anaglyph: 6,
  "frame-sequential": 7,
};

/**
 * Red-cyan anaglyph matrices (row-major, output RGB from input RGB of each eye).
 *   dubois: least-squares optimized (Dubois 2009), keeps colour with reduced ghosting
 *   bw:     R = luma(left), G = B = luma(right); Rec. 709 weights, no colour rivalry
 */
const LUMA = [0.2126, 0.7152, 0.0722];
const ANAGLYPH: Record<AnaglyphScheme, { left: number[]; right: number[] }> = {
  dubois: {
    left: [0.437, 0.449, 0.164, -0.062, -0.062, -0.024, -0.048, -0.05, -0.017],
    right: [-0.011, -0.032, -0.007, 0.377, 0.761, 0.009, -0.026, -0.093, 1.234],
  },
  bw: {
    left: [...LUMA, 0, 0, 0, 0, 0, 0],
    right: [0, 0, 0, ...LUMA, ...LUMA],
  },
};

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D texL;
  uniform sampler2D texR;
  uniform int mode;
  uniform bool swapEyes;
  uniform int firstEyeRight;   // 0 = left owns even lines, 1 = right
  uniform ivec2 phase;
  uniform int frameParity;
  uniform mat3 duboisL;
  uniform mat3 duboisR;
  varying vec2 vUv;

  vec3 sampleEye(bool right, vec2 uv) {
    bool r = swapEyes ? !right : right;
    return r ? texture2D(texR, uv).rgb : texture2D(texL, uv).rgb;
  }

  void main() {
    vec3 c;
    ivec2 px = ivec2(gl_FragCoord.xy) + phase;
    if (mode == 0) {
      c = sampleEye(false, vUv);
    } else if (mode == 1) {
      // side by side: left half = left eye
      bool right = vUv.x >= 0.5;
      vec2 uv = vec2(right ? (vUv.x - 0.5) * 2.0 : vUv.x * 2.0, vUv.y);
      c = sampleEye(right, uv);
    } else if (mode == 2) {
      // top bottom: top half = left eye
      bool right = vUv.y < 0.5;
      vec2 uv = vec2(vUv.x, right ? vUv.y * 2.0 : (vUv.y - 0.5) * 2.0);
      c = sampleEye(right, uv);
    } else if (mode == 3) {
      bool right = ((px.y & 1) == firstEyeRight) ? false : true;
      c = sampleEye(right, vUv);
    } else if (mode == 4) {
      bool right = ((px.x & 1) == firstEyeRight) ? false : true;
      c = sampleEye(right, vUv);
    } else if (mode == 5) {
      bool right = (((px.x + px.y) & 1) == firstEyeRight) ? false : true;
      c = sampleEye(right, vUv);
    } else if (mode == 6) {
      vec3 l = sampleEye(false, vUv);
      vec3 r = sampleEye(true, vUv);
      c = clamp(duboisL * l + duboisR * r, 0.0, 1.0);
    } else {
      // frame sequential: parity picks the eye
      c = sampleEye(frameParity == 1, vUv);
    }
    gl_FragColor = vec4(c, 1.0);
  }
`;

/**
 * Owns the two eye render targets and the packing pass.
 *
 *   setEyeSize(w, h)      size of each eye buffer in pixels
 *   left / right          targets the viewport renders the eyes into
 *   present(renderer, params, frame, target?)   run the packing shader
 *
 * Targets start tiny and are resized on first use; MSAA (4 samples) is
 * enabled on them since the packing pass itself does no anti-aliasing.
 */
export class StereoPacker {
  private targetL: THREE.WebGLRenderTarget;
  private targetR: THREE.WebGLRenderTarget;
  private material: THREE.ShaderMaterial;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private width = 0;
  private height = 0;

  constructor() {
    this.targetL = this.makeTarget(2, 2);
    this.targetR = this.makeTarget(2, 2);
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        texL: { value: this.targetL.texture },
        texR: { value: this.targetR.texture },
        mode: { value: 0 },
        swapEyes: { value: false },
        firstEyeRight: { value: 0 },
        phase: { value: new THREE.Vector2(0, 0) },
        frameParity: { value: 0 },
        duboisL: { value: new THREE.Matrix3() },
        duboisR: { value: new THREE.Matrix3() },
      },
    });
    // A single triangle that covers the whole clip-space square (uv runs 0..2
    // and is clipped): cheaper than a quad and avoids the diagonal seam.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quadScene.add(new THREE.Mesh(geo, this.material));
  }

  private makeTarget(w: number, h: number) {
    return new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      samples: 4,
    });
  }

  /** Size of each eye buffer, in pixels. */
  setEyeSize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.targetL.setSize(width, height);
    this.targetR.setSize(width, height);
  }

  get left() {
    return this.targetL;
  }
  get right() {
    return this.targetR;
  }

  /** Write the packed frame to the canvas, or to `target` when given. */
  present(renderer: THREE.WebGLRenderer, params: StereoParams, frame: number, target: THREE.WebGLRenderTarget | null = null) {
    const u = this.material.uniforms;
    u.mode.value = MODE_ID[params.mode];
    u.swapEyes.value = params.swapEyes;
    u.firstEyeRight.value = params.firstEye === "right" ? 1 : 0;
    (u.phase.value as THREE.Vector2).set(params.phaseX, params.phaseY);
    u.frameParity.value = frame & 1;
    const d = ANAGLYPH[params.anaglyph];
    (u.duboisL.value as THREE.Matrix3).set(...(d.left as [number, number, number, number, number, number, number, number, number]));
    (u.duboisR.value as THREE.Matrix3).set(...(d.right as [number, number, number, number, number, number, number, number, number]));
    renderer.setRenderTarget(target);
    renderer.render(this.quadScene, this.quadCamera);
    if (target) renderer.setRenderTarget(null);
  }

  dispose() {
    this.targetL.dispose();
    this.targetR.dispose();
    this.material.dispose();
  }
}

/**
 * Canvas pixel size for a given screen and stereo mode.
 * Full side-by-side doubles the width; full top-bottom doubles the height.
 */
export function canvasSizeFor(mode: StereoMode, w: number, h: number): { width: number; height: number } {
  switch (mode) {
    case "side-by-side":
      return { width: w * 2, height: h };
    case "top-bottom":
      return { width: w, height: h * 2 };
    default:
      return { width: w, height: h };
  }
}

/** Whether a mode needs two eye renders. */
export function isStereo(mode: StereoMode) {
  return mode !== "mono";
}
