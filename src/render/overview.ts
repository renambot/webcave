/**
 * Overview: a third-person 3D view of the physical installation, used by the
 * simulator. It draws, in the CAVE frame: each screen as a quad with an
 * outline and label, the head as a sphere plus a cone pointing along the
 * viewing direction, and the four frustum edges from the eye to each
 * screen's corners. Orbit with the mouse.
 *
 * Content modes:
 *   "none"  - geometry only
 *   "walls" - each screen quad shows a mono render of what that wall displays
 *             (a "virtual CAVE"): the app scene is rendered from the head
 *             through each screen into a texture, in this renderer's context
 *   "world" - the app scene is drawn in space around the CAVE, placed by the
 *             navigation transform, then the geometry is drawn over it sharing
 *             the depth buffer; useful for debugging interaction with objects
 *
 * Two frames coexist here. The overview scene (screens, head, frusta) is in
 * the CAVE frame. The app scene is in the world frame. The `rig` group
 * carries the navigation transform between them: the wall camera lives in
 * the rig, and in "world" mode the overview camera is re-expressed in world
 * space through the rig's matrix.
 *
 * WebGL textures cannot be shared between canvases, so wall textures are
 * re-rendered here rather than copied from the tiles.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { ClusterConfig, ScreenConfig, Vec3 } from "../core/config";
import { screenCenter, screenPd } from "../core/projection";
import type { HeadPose, Navigation } from "../core/protocol";
import { applyOffAxis } from "./offaxis";

/** Flat apps: the canvas each screen's view draws into, keyed by screen id. */
export type WallCanvases = ReadonlyMap<string, HTMLCanvasElement | null>;

export type OverviewMode = "none" | "walls" | "world";

interface WallView {
  screen: ScreenConfig;
  quad: THREE.Mesh;
  ghostMaterial: THREE.Material;
  texturedMaterial: THREE.MeshBasicMaterial;
  /** Mono render shown on the wall quad (scene apps). */
  target: THREE.WebGLRenderTarget;
  /** Flat apps: texture sampled from the view's canvas, created on first use. */
  canvasTexture: THREE.CanvasTexture | null;
  canvasSource: HTMLCanvasElement | null;
}

export class OverviewRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  /** Head marker: sphere at the eye center plus a cone pointing forward (-Z of the head frame). */
  private head = new THREE.Group();
  private frusta: THREE.LineSegments;
  private cfg: ClusterConfig;
  private walls: WallView[] = [];
  private background = new THREE.Color(0x111318);

  /** Rig carrying the navigation transform (CAVE frame -> world). */
  private rig = new THREE.Group();
  /** Off-axis camera used to render wall textures, child of the rig. */
  private wallCamera = new THREE.PerspectiveCamera();
  /** The overview camera re-expressed in world space for the "world" pass. */
  private worldCamera = new THREE.PerspectiveCamera();

  mode: OverviewMode = "walls";
  wallTextureSize = 512;

  constructor(cfg: ClusterConfig, canvas: HTMLCanvasElement) {
    this.cfg = cfg;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.scene.background = this.background;
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    this.worldCamera.matrixAutoUpdate = false;
    this.rig.rotation.order = "YXZ";
    this.rig.add(this.wallCamera);

    // Frame the whole installation: screens plus default head position.
    const box = new THREE.Box3();
    for (const s of cfg.screens) for (const c of [s.pa, s.pb, s.pc, screenPd(s)]) box.expandByPoint(new THREE.Vector3(...c));
    box.expandByPoint(new THREE.Vector3(...cfg.defaultHead.position));
    const center = box.getCenter(new THREE.Vector3());
    const extent = box.getSize(new THREE.Vector3()).length();
    this.camera.position.copy(center).add(new THREE.Vector3(0.9, 0.8, 1.3).multiplyScalar(extent * 0.75));
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(center);

    this.scene.add(new THREE.GridHelper(10, 20, 0x444, 0x2a2a2a));
    this.scene.add(new THREE.AxesHelper(0.5));

    // Screens as quads with outlines and labels
    for (const s of cfg.screens) {
      const pd = screenPd(s);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute([...s.pa, ...s.pb, ...pd, ...s.pc], 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      geo.computeVertexNormals();
      const ghostMaterial = new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
      const target = new THREE.WebGLRenderTarget(this.wallTextureSize, this.wallTextureSize, { samples: 4 });
      const texturedMaterial = new THREE.MeshBasicMaterial({ map: target.texture, side: THREE.DoubleSide });
      const quad = new THREE.Mesh(geo, ghostMaterial);
      this.scene.add(quad);
      const outline = new THREE.LineLoop(
        new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([...s.pa, ...s.pb, ...pd, ...s.pc], 3)),
        new THREE.LineBasicMaterial({ color: 0x93c5fd }),
      );
      this.scene.add(outline);
      this.scene.add(makeLabel(s.id, screenCenter(s)));
      this.walls.push({ screen: s, quad, ghostMaterial, texturedMaterial, target, canvasTexture: null, canvasSource: null });
    }

    const headMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x7c2d12 });
    this.head.add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 24, 16), headMat));
    // Cone: base at the head center, tip 0.35 m forward along -Z.
    const coneLen = 0.5;
    const coneGeo = new THREE.ConeGeometry(0.1, coneLen, 24);
    coneGeo.translate(0, coneLen / 2, 0); // base at origin, tip at +Y
    coneGeo.rotateX(-Math.PI / 2); // +Y -> -Z
    this.head.add(new THREE.Mesh(coneGeo, new THREE.MeshStandardMaterial({ color: 0xfef08a, emissive: 0xb45309, emissiveIntensity: 0.6 })));
    this.scene.add(this.head);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));

    // Frustum lines: 4 per screen, eye to each corner
    const n = cfg.screens.length * 4 * 2;
    this.frusta = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3)),
      new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.5 }),
    );
    this.scene.add(this.frusta);
  }

  setSize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setWallTextureSize(px: number) {
    if (px === this.wallTextureSize) return;
    this.wallTextureSize = px;
    for (const w of this.walls) w.target.setSize(px, px);
  }

  /** Move the overview camera to the head, looking at the front-most screen. */
  viewFromHead(head: HeadPose) {
    this.camera.position.set(...head.position);
    const s = this.cfg.screens[0];
    this.controls.target.set(...screenCenter(s));
    this.controls.update();
  }

  /**
   * @param worldScene   the scene app's scene, or null for flat apps
   * @param wallCanvases flat apps: each screen's canvas, shown on the walls in
   *                     "walls" mode (uploaded as a texture every frame)
   */
  render(head: HeadPose, nav: Navigation, worldScene: THREE.Scene | null, wallCanvases?: WallCanvases) {
    this.head.position.set(...head.position);
    this.head.quaternion.set(...head.orientation);
    this.updateFrusta(head.position);
    this.controls.update();

    this.rig.position.set(...nav.position);
    this.rig.rotation.set(nav.pitch, nav.yaw, 0);
    this.rig.updateMatrixWorld(true);

    for (const w of this.walls) {
      w.quad.material = this.mode === "walls" ? w.texturedMaterial : w.ghostMaterial;
    }
    // Wall textures are always mono, from the head center, whatever stereo
    // mode the real walls use. The tiles show the packed stereo output.
    if (this.mode === "walls") {
      for (const w of this.walls) {
        const src = wallCanvases?.get(w.screen.id) ?? null;
        if (src) {
          // Flat app: copy the view's canvas. Needs preserveDrawingBuffer on
          // the source context, which the map app sets.
          if (w.canvasSource !== src) {
            w.canvasTexture?.dispose();
            w.canvasTexture = new THREE.CanvasTexture(src);
            w.canvasTexture.colorSpace = THREE.SRGBColorSpace;
            w.canvasSource = src;
          }
          w.canvasTexture!.needsUpdate = true;
          w.texturedMaterial.map = w.canvasTexture;
          w.texturedMaterial.needsUpdate = true;
        } else if (worldScene) {
          if (w.texturedMaterial.map !== w.target.texture) {
            w.texturedMaterial.map = w.target.texture;
            w.texturedMaterial.needsUpdate = true;
          }
          applyOffAxis(this.wallCamera, w.screen, head.position, this.cfg.near, this.cfg.far);
          this.rig.updateMatrixWorld(true);
          this.renderer.setRenderTarget(w.target);
          this.renderer.render(worldScene, this.wallCamera);
        } else {
          w.quad.material = w.ghostMaterial;
        }
      }
      this.renderer.setRenderTarget(null);
    }

    if (this.mode === "world" && worldScene) {
      // Pass 1: the virtual world, seen by the overview camera expressed in world space.
      this.camera.updateMatrixWorld(true);
      this.worldCamera.matrixWorld.multiplyMatrices(this.rig.matrixWorld, this.camera.matrixWorld);
      this.worldCamera.matrixWorldInverse.copy(this.worldCamera.matrixWorld).invert();
      this.worldCamera.projectionMatrix.copy(this.camera.projectionMatrix);
      this.worldCamera.projectionMatrixInverse.copy(this.camera.projectionMatrixInverse);
      this.renderer.autoClear = true;
      this.renderer.render(worldScene, this.worldCamera);
      // Pass 2: CAVE geometry on top, sharing the depth buffer.
      this.scene.background = null;
      this.renderer.autoClear = false;
      this.renderer.render(this.scene, this.camera);
      this.renderer.autoClear = true;
    } else {
      this.scene.background = this.background;
      this.renderer.autoClear = true;
      this.renderer.render(this.scene, this.camera);
    }
  }

  private updateFrusta(eye: Vec3) {
    const pos = this.frusta.geometry.getAttribute("position") as THREE.BufferAttribute;
    let i = 0;
    const put = (a: Vec3, b: Vec3) => {
      pos.setXYZ(i++, a[0], a[1], a[2]);
      pos.setXYZ(i++, b[0], b[1], b[2]);
    };
    for (const s of this.cfg.screens) {
      const pd = screenPd(s);
      for (const c of [s.pa, s.pb, s.pc, pd]) put(eye, c);
    }
    pos.needsUpdate = true;
  }
}

function makeLabel(text: string, at: Vec3): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.font = "bold 40px system-ui, sans-serif";
  ctx.fillStyle = "#e5e7eb";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(1, 0.25, 1);
  sprite.position.set(...at);
  return sprite;
}
