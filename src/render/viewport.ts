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
