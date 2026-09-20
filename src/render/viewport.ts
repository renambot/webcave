/**
 * ViewportRenderer: everything needed to drive one physical screen.
 *
 * Owns a WebGL renderer bound to one canvas, a camera inside a navigation
 * rig, and a StereoPacker with one offscreen target per eye. The app's scene
 * is passed in at render time, so one scene can be drawn by several
 * viewports (the simulator does this for all tiles).
 *
 * The frame lifecycle mirrors the cluster barrier on purpose:
 *
 *   renderFrame(scene, state)   draw the eye(s) into offscreen targets
 *   present(frame)              pack the eyes onto the canvas (the "swap")
 *
 * A node calls renderFrame() on the manager's "frame" message and present()
 * on "present". Splitting the two is what lets every screen in the cluster
 * flip to the new image at the same moment, even though the browser gives us
 * no direct control of vsync.
 *
 * Per-frame steps inside renderFrame():
 *   1. put the rig at the navigation pose (CAVE frame -> world)
 *   2. compute eye positions from the head pose and IPD
 *   3. for each eye: off-axis camera through this screen, render to its target
 */
import * as THREE from "three";
import type { ClusterConfig, ScreenConfig, StereoParams, Vec3 } from "../core/config";
import { screenSize } from "../core/projection";
import type { FrameState } from "../core/protocol";
import type { RawApp, RawRenderContext, WebGpuApp, WebGpuRenderContext } from "../apps/types";
import { applyOffAxis, eyePositions } from "./offaxis";
import { StereoPacker, canvasSizeFor, isStereo } from "./stereo";

export class ViewportRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly screen: ScreenConfig;
  private cfg: ClusterConfig;
  private camera = new THREE.PerspectiveCamera();
  /** Navigation rig: places the physical CAVE frame in the virtual world. The camera is its child. */
  private rig = new THREE.Group();
  private packer = new StereoPacker();
  private lastFrame: FrameState | null = null;
  /** Live stereo settings; the simulator edits these from its toolbar. */
  stereo: StereoParams;

  constructor(cfg: ClusterConfig, screen: ScreenConfig, canvas: HTMLCanvasElement, stereo: StereoParams) {
    this.cfg = cfg;
    this.screen = screen;
    this.stereo = { ...stereo };
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    // Pixel-exact stereo modes (row/column interleave) need one canvas pixel
    // per device pixel, so never let the browser upscale for us.
    this.renderer.setPixelRatio(1);
    // Shadow maps are on so apps can opt in per light and mesh (castShadow /
    // receiveShadow); they cost nothing until a light casts.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera.matrixAutoUpdate = true;
    this.rig.rotation.order = "YXZ"; // yaw about world up, then pitch
    this.rig.add(this.camera);
  }

  private applyNavigation(nav: FrameState["navigation"]) {
    this.rig.position.set(...nav.position);
    this.rig.rotation.set(nav.pitch, nav.yaw, 0);
    this.rig.updateMatrixWorld(true);
  }

  /** Aspect ratio of the physical screen (width / height), from its corners. */
  get aspect() {
    const s = screenSize(this.screen);
    return s.width / s.height;
  }

  /**
   * Resize the canvas backing store. The eye buffers are "one screen's worth"
   * of pixels: for full side-by-side the canvas is twice as wide as an eye.
   */
  setSize(width: number, height: number) {
    this.renderer.setSize(width, height, false);
    const mode = this.stereo.mode;
    const eye = mode === "side-by-side" ? { w: width / 2, h: height } : mode === "top-bottom" ? { w: width, h: height / 2 } : { w: width, h: height };
    this.packer.setEyeSize(Math.max(2, Math.floor(eye.w)), Math.max(2, Math.floor(eye.h)));
  }

  /**
   * Fit the canvas into a box (a tile or the window), preserving the screen's
   * physical aspect and the packing (a double-wide canvas for full SbS).
   * Letterboxes rather than stretching, so geometry stays correct.
   */
  fitInto(boxW: number, boxH: number) {
    const packed = canvasSizeFor(this.stereo.mode, this.aspect, 1);
    const targetAspect = packed.width / packed.height;
    let w = boxW;
    let h = w / targetAspect;
    if (h > boxH) {
      h = boxH;
      w = h * targetAspect;
    }
    this.setSize(Math.floor(w), Math.floor(h));
    return { width: Math.floor(w), height: Math.floor(h) };
  }

  /** Configure the camera for an off-axis view from `eye` through this screen. */
  private setupCamera(eye: Vec3) {
    // Eye and screen basis are in the physical CAVE frame; the rig maps to world.
    applyOffAxis(this.camera, this.screen, eye, this.cfg.near, this.cfg.far);
    this.rig.updateMatrixWorld(true);
  }

  /** Render the eye images for this frame into offscreen targets. Does not touch the canvas. */
  renderFrame(scene: THREE.Scene, state: FrameState) {
    this.lastFrame = state;
    this.applyNavigation(state.navigation);
    const eyes = eyePositions(state.head, this.stereo.eyeSeparation);
    if (isStereo(this.stereo.mode)) {
      this.setupCamera(eyes.left);
      this.renderer.setRenderTarget(this.packer.left);
      this.renderer.render(scene, this.camera);
      this.setupCamera(eyes.right);
      this.renderer.setRenderTarget(this.packer.right);
      this.renderer.render(scene, this.camera);
    } else {
      // Mono still goes through the packer (mode 0 copies the left target),
      // so present() is the same call in every mode.
      const eye = this.stereo.monoEye === "left" ? eyes.left : this.stereo.monoEye === "right" ? eyes.right : eyes.center;
      this.setupCamera(eye);
      this.renderer.setRenderTarget(this.packer.left);
      this.renderer.render(scene, this.camera);
    }
    this.renderer.setRenderTarget(null);
  }

  /**
   * Render a raw WebGL app's eye images: same lifecycle as renderFrame(), but
   * instead of drawing a scene, each eye's off-axis camera is handed to the
   * app as matrices and the app draws into the eye target with its own code.
   * three.js state is reset around the call so the two can share the context.
   */
  renderRaw(app: RawApp, state: FrameState) {
    this.lastFrame = state;
    this.applyNavigation(state.navigation);
    const eyes = eyePositions(state.head, this.stereo.eyeSeparation);
    const draw = (eye: Vec3, which: RawRenderContext["eye"], target: THREE.WebGLRenderTarget) => {
      this.setupCamera(eye); // camera pose + projection through this screen; rig matrices updated
      this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
      this.camera.getWorldPosition(this.worldEye);
      // Forget three.js's cached state, bind the target (which also sets the viewport), draw, forget again.
      this.renderer.resetState();
      this.renderer.setRenderTarget(target);
      app.render({
        gl: this.renderer.getContext(),
        eye: which,
        eyePosition: [this.worldEye.x, this.worldEye.y, this.worldEye.z],
        view: this.camera.matrixWorldInverse.elements,
        viewInverse: this.camera.matrixWorld.elements,
        projection: this.camera.projectionMatrix.elements,
        width: target.width,
        height: target.height,
      });
      this.resolveMultisample(target);
      this.renderer.resetState();
    };
    if (isStereo(this.stereo.mode)) {
      draw(eyes.left, "left", this.packer.left);
      draw(eyes.right, "right", this.packer.right);
    } else {
      const eye = this.stereo.monoEye === "left" ? eyes.left : this.stereo.monoEye === "right" ? eyes.right : eyes.center;
      draw(eye, this.stereo.monoEye, this.packer.left);
    }
    this.renderer.setRenderTarget(null);
  }
  private worldEye = new THREE.Vector3();

  /** Offscreen canvases a WebGPU app renders each eye into, sized like the eye targets. */
  private gpuCanvases: Partial<Record<"left" | "right", OffscreenCanvas>> = {};
  /** Full-target quad that copies a WebGPU eye image into an eye target, flipped to GL's row order. */
  private blitTexture = (() => {
    const t = new THREE.Texture();
    t.colorSpace = THREE.NoColorSpace;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  })();
  private blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private blitScene = (() => {
    const scene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: this.blitTexture, toneMapped: false, depthTest: false, depthWrite: false }));
    quad.scale.y = -1; // ImageBitmap rows are top-down; the target is read bottom-up
    scene.add(quad);
    return scene;
  })();

  /**
   * Render a WebGPU app's eye images. WebGPU cannot draw into WebGL's eye
   * targets, so each eye gets an OffscreenCanvas of the target's size; the
   * app renders and submits, the canvas's image is taken with
   * transferToImageBitmap() (which waits for the GPU work) and copied into the
   * eye target's texture with texSubImage2D. Everything after that, packing
   * and presenting, is the ordinary WebGL path.
   */
  renderGpu(app: WebGpuApp, state: FrameState) {
    this.lastFrame = state;
    this.applyNavigation(state.navigation);
    const eyes = eyePositions(state.head, this.stereo.eyeSeparation);
    const draw = (eye: Vec3, which: WebGpuRenderContext["eye"], slot: "left" | "right", target: THREE.WebGLRenderTarget) => {
      this.setupCamera(eye);
      this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
      this.camera.getWorldPosition(this.worldEye);
      let canvas = this.gpuCanvases[slot];
      if (!canvas) canvas = this.gpuCanvases[slot] = new OffscreenCanvas(target.width, target.height);
      if (canvas.width !== target.width || canvas.height !== target.height) {
        canvas.width = target.width;
        canvas.height = target.height;
      }
      app.render({
        canvas,
        eye: which,
        eyePosition: [this.worldEye.x, this.worldEye.y, this.worldEye.z],
        view: this.camera.matrixWorldInverse.elements,
        viewInverse: this.camera.matrixWorld.elements,
        projection: this.camera.projectionMatrix.elements,
        near: this.cfg.near,
        far: this.cfg.far,
        width: target.width,
        height: target.height,
      });
      let bitmap: ImageBitmap;
      try {
        bitmap = canvas.transferToImageBitmap();
      } catch {
        return; // nothing rendered yet (context not configured)
      }
      // Draw the bitmap into the eye target through a quad. WebGL ignores its
      // Y-flip flag for ImageBitmap sources, so the flip is in the quad; three.js
      // also resolves the multisampled target on the way.
      this.blitTexture.image = bitmap;
      this.blitTexture.needsUpdate = true;
      this.renderer.resetState();
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.blitScene, this.blitCamera);
      this.blitTexture.image = null;
      bitmap.close();
    };
    if (isStereo(this.stereo.mode)) {
      draw(eyes.left, "left", "left", this.packer.left);
      draw(eyes.right, "right", "right", this.packer.right);
    } else {
      const eye = this.stereo.monoEye === "left" ? eyes.left : this.stereo.monoEye === "right" ? eyes.right : eyes.center;
      draw(eye, this.stereo.monoEye, "left", this.packer.left);
    }
    this.renderer.setRenderTarget(null);
  }

  /**
   * The eye targets are multisampled. three.js resolves the multisample
   * buffer into the target's texture at the end of its own render(); a raw
   * app never goes through that, so blit it here or the texture stays empty.
   */
  private resolveMultisample(target: THREE.WebGLRenderTarget) {
    const gl = this.renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) return;
    const props = this.renderer.properties.get(target) as { __webglFramebuffer?: WebGLFramebuffer; __webglMultisampledFramebuffer?: WebGLFramebuffer };
    if (!props.__webglMultisampledFramebuffer || !props.__webglFramebuffer) return;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, props.__webglMultisampledFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, props.__webglFramebuffer);
    gl.blitFramebuffer(0, 0, target.width, target.height, 0, 0, target.width, target.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  /** Pack the last rendered eyes onto the canvas. `frame` feeds frame-sequential parity. */
  present(frame?: number) {
    const f = frame ?? this.lastFrame?.frame ?? 0;
    this.packer.present(this.renderer, this.stereo, f);
  }

  dispose() {
    this.packer.dispose();
    this.renderer.dispose();
  }
}
