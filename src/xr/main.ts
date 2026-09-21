/**
 * Headset viewer: the cluster's application in a WebXR headset.
 *
 * The page joins the running Manager as a controller (it mirrors the frame
 * state and never holds the barrier), builds the same application every node
 * runs, and renders its scene into an immersive-vr session. The headset's own
 * eye views replace the CAVE screens' off-axis frusta: the XR floor origin is
 * placed at the CAVE origin (the `origin` and `yaw` parameters move it), so
 * the wearer stands inside the virtual CAVE and the navigation driven from the
 * simulator on a laptop carries them through the world. Without a session the
 * page shows a mono preview from the cluster's tracked head, which is also the
 * spectator view on a laptop.
 *
 * Optionally the headset is also the tracker: `head=1` sends the viewer pose
 * to the Manager as the CAVE head every frame, so the wall screens' projections
 * follow the wearer, and the right XR controller is published as the wand
 * (absolute, CAVE frame) with its trigger, grip, A/B and thumbsticks mapped to
 * the ordinary actions, like any input client.
 *
 * URL: xr.html?manager=ws://host:8765[&head=1][&origin=x,y,z][&yaw=deg][&polyfill=1][&input=0]
 *   manager   default ws://<host>:8765, or wss://<host>/manager through the dev server's proxy when the page is https
 *   head=1    publish the headset pose as the CAVE head (switches the simulated head off)
 *   origin    the XR floor origin in the CAVE frame, meters (default 0,0,0)
 *   yaw       rotation of the XR frame about the CAVE's Y axis, degrees (default 0)
 *   polyfill  use the WebXR polyfill's Cardboard device (a phone, or testing without a headset)
 *   input=0   do not send the XR controllers as input / wand
 *
 * Scene and raw WebGL apps render here; flat and WebGPU apps do not (the status says so).
 */
import * as THREE from "three";
import type { ClusterConfig } from "../core/config";
import { decode, encode, type ClientMessage, type FrameState, type Pose, type ServerMessage } from "../core/protocol";
import { navigationMatrix } from "../core/navigation";
import { appSpecFromParams, createApp, isRawApp, isSceneApp, type AnyApp } from "../apps";
import { InputController } from "../input/controller";
import { emptyActions, mergeActions, type ActionState } from "../input/actions";
import { wandFromHead } from "../core/pose";

const params = new URLSearchParams(location.search);
const managerUrl = params.get("manager") ?? (location.protocol === "https:" ? `wss://${location.host}/manager` : `ws://${location.hostname}:8765`);
const publishHead = params.get("head") === "1";
const sendInput = params.get("input") !== "0";
const usePolyfill = params.get("polyfill") === "1";
const originOffset = (params.get("origin") ?? "0,0,0").split(",").map(Number) as [number, number, number];
const originYaw = (Number(params.get("yaw") ?? 0) * Math.PI) / 180;
const clientId = `xr:${Math.random().toString(36).slice(2, 6)}`;

const canvas = document.getElementById("view") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const enter = document.getElementById("enter") as HTMLButtonElement;

// The context is created XR-compatible up front, so entering a session needs no makeXRCompatible() round trip.
const gl = canvas.getContext("webgl2", { antialias: true, xrCompatible: true }) as WebGL2RenderingContext;
const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");

/** The XR frame inside the CAVE frame: where the headset's floor origin sits. */
const originMatrix = new THREE.Matrix4().compose(new THREE.Vector3(...originOffset), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), originYaw), new THREE.Vector3(1, 1, 1));
/** Navigation carries the CAVE through the world; both rigs hang from it. */
const caveRig = new THREE.Group(); // CAVE frame -> world (the preview camera lives here, posed by the cluster head)
caveRig.matrixAutoUpdate = false;
const xrRig = new THREE.Group(); // XR frame -> world (three.js poses xrCamera from the headset under it)
xrRig.matrixAutoUpdate = false;
const previewCamera = new THREE.PerspectiveCamera(70, 1, 0.05, 2000);
const xrCamera = new THREE.PerspectiveCamera(70, 1, 0.05, 2000);
caveRig.add(previewCamera);
xrRig.add(xrCamera);

let cfg: ClusterConfig | null = null;
let app: AnyApp | null = null;
let lastState: FrameState | null = null;
let sendToManager: ((m: ClientMessage) => void) | null = null;
let input: InputController | null = null;
let xrActions: ActionState = emptyActions();
let frames = 0;
let lastHeadSent = 0;
let status = "";

function fit() {
  if (renderer.xr.isPresenting) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  previewCamera.aspect = w / h;
  previewCamera.updateProjectionMatrix();
}
window.addEventListener("resize", fit);
fit();

function setup(c: ClusterConfig) {
  app?.dispose?.();
  const spec = appSpecFromParams(params, c.app);
  app = createApp(spec, { audio: false, debug: params.get("debug") === "1" });
  if (isSceneApp(app)) app.scene.add(caveRig, xrRig);
  status = isSceneApp(app) || isRawApp(app) ? "" : `${app.name} is a ${app.kind ?? "flat"} app: not available in the headset`;
  if (sendInput && !input) {
    input = new InputController({
      send: (m) => sendToManager?.(m),
      getState: () => lastState ?? { frame: 0, time: 0, head: c.defaultHead, wand: wandFromHead(c.defaultHead, c.defaultWand), navigation: { position: [0, 0, 0], yaw: 0, pitch: 0 }, appState: {}, issuedAt: 0 },
      getApp: () => app,
      onReset: () => sendToManager?.({ type: "setNavigation", navigation: { position: [0, 0, 0], yaw: 0, pitch: 0 } }),
      defaultWand: c.defaultWand,
      extraActions: () => xrActions,
    });
    input.bindKeyboard();
  }
  (window as unknown as { webcave: unknown }).webcave = { app, renderer, xrCamera, previewCamera, lastState: () => lastState, send: (m: ClientMessage) => sendToManager?.(m), enterVR, xrActions: () => xrActions, presenting: () => renderer.xr.isPresenting, clientId };
}

// ---- Manager connection -------------------------------------------------------------------
function connect() {
  const ws = new WebSocket(managerUrl);
  const send = (m: ClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(encode(m));
  ws.addEventListener("open", () => (hud.textContent = `connected to ${managerUrl} as ${clientId}`));
  ws.addEventListener("message", (ev) => {
    const msg = decode<ServerMessage>(ev.data);
    switch (msg.type) {
      case "welcome":
        cfg = msg.config;
        send({ type: "hello", nodeId: clientId, role: "controller" });
        sendToManager = send;
        setup(cfg);
        break;
      case "frame": {
        if (!app) return;
        const prevTime = lastState?.time ?? msg.state.time;
        lastState = msg.state;
        input?.step(Math.max(0, Math.min(0.1, msg.state.time - prevTime)));
        if (isSceneApp(app) || isRawApp(app)) app.update(msg.state.time, msg.state);
        frames++;
        break;
      }
      default:
        break;
    }
  });
  ws.addEventListener("close", () => {
    hud.textContent = `disconnected from ${managerUrl}, retrying...`;
    sendToManager = null;
    setTimeout(connect, 1000);
  });
}

// ---- Rendering ---------------------------------------------------------------------------
const navMatrix = new THREE.Matrix4();
const tmpM = new THREE.Matrix4();
const tmpP = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const worldEye = new THREE.Vector3();

/** A pose in the XR reference frame -> the CAVE frame. */
function xrToCave(matrix: THREE.Matrix4): Pose {
  tmpM.multiplyMatrices(originMatrix, matrix).decompose(tmpP, tmpQ, tmpS);
  return { position: [tmpP.x, tmpP.y, tmpP.z], orientation: [tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w] };
}

function drawRaw(app: Extract<AnyApp, { kind: "raw" }>, cameras: THREE.PerspectiveCamera[], eyes: ("left" | "right" | "center")[], width: number, height: number) {
  const gl = renderer.getContext();
  cameras.forEach((cam, i) => {
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    cam.getWorldPosition(worldEye);
    const v = (cam as THREE.PerspectiveCamera & { viewport?: THREE.Vector4 }).viewport;
    renderer.resetState();
    if (v && cameras.length > 1) {
      gl.viewport(v.x, v.y, v.z, v.w);
      gl.scissor(v.x, v.y, v.z, v.w);
      gl.enable(gl.SCISSOR_TEST);
    } else gl.viewport(0, 0, width, height);
    app.render({
      gl,
      eye: eyes[i] ?? "center",
      eyePosition: [worldEye.x, worldEye.y, worldEye.z],
      view: cam.matrixWorldInverse.elements,
      viewInverse: cam.matrixWorld.elements,
      projection: cam.projectionMatrix.elements,
      width: v && cameras.length > 1 ? v.z : width,
      height: v && cameras.length > 1 ? v.w : height,
    });
    gl.disable(gl.SCISSOR_TEST);
    renderer.resetState();
  });
}

renderer.setAnimationLoop((_t: number, xrFrame?: XRFrame) => {
  if (!app || !lastState) return;
  // The polyfill's Cardboard distorter draws with our context between frames and leaves
  // bindings three.js believes are still its own (textured materials then draw nothing).
  if (usePolyfill && renderer.xr.isPresenting) renderer.resetState();
  navigationMatrix(lastState.navigation, navMatrix);
  caveRig.matrix.copy(navMatrix);
  caveRig.matrixWorldNeedsUpdate = true;
  xrRig.matrix.multiplyMatrices(navMatrix, originMatrix);
  xrRig.matrixWorldNeedsUpdate = true;
  const presenting = renderer.xr.isPresenting;
  if (!presenting) {
    previewCamera.position.set(...lastState.head.position);
    previewCamera.quaternion.set(...lastState.head.orientation);
  } else if (xrFrame) pollXr(xrFrame);

  if (isSceneApp(app)) {
    renderer.render(app.scene, presenting ? xrCamera : previewCamera);
  } else if (isRawApp(app)) {
    if (presenting) {
      renderer.xr.updateCamera(xrCamera);
      const arr = renderer.xr.getCamera();
      const target = renderer.getRenderTarget();
      drawRaw(app, arr.cameras.length ? arr.cameras : [arr], ["left", "right"], target?.width ?? canvas.width, target?.height ?? canvas.height);
    } else {
      caveRig.updateMatrixWorld(true);
      renderer.setRenderTarget(null);
      drawRaw(app, [previewCamera], ["center"], canvas.width, canvas.height);
    }
  }
  const now = performance.now();
  if (now - lastHeadSent > 500) {
    lastHeadSent = lastHeadSent || now;
    hud.textContent = `${clientId}  ${presenting ? "immersive" : "preview"}  frames ${frames}  ${app.status}${status ? "\n" + status : ""}${publishHead ? "\nheadset is the tracked head" : ""}${sendInput ? "\nXR controllers: right = wand, trigger A, grip X, sticks move / look" : ""}`;
  }
});

// ---- XR input: head, wand and buttons ---------------------------------------------------
const controllerMatrix = new THREE.Matrix4();
let lastPoseSent = 0;
function pollXr(frame: XRFrame) {
  const session = renderer.xr.getSession();
  const space = renderer.xr.getReferenceSpace();
  if (!session || !space) return;
  const now = performance.now();
  const due = now - lastPoseSent >= 1000 / 60;
  if (publishHead && due) {
    // three.js has just posed xrCamera from the viewer pose, in the XR frame.
    controllerMatrix.compose(xrCamera.position, xrCamera.quaternion, tmpS.set(1, 1, 1));
    sendToManager?.({ type: "setHead", head: xrToCave(controllerMatrix) });
  }
  if (!sendInput) {
    if (due) lastPoseSent = now;
    return;
  }
  const merged: ActionState[] = [];
  for (const source of session.inputSources) {
    const pad = source.gamepad;
    const a = emptyActions();
    const right = source.handedness !== "left";
    if (pad) {
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      const ax = (i: number) => pad.axes[i] ?? 0;
      if (right) {
        a.buttons.primary = b(0); // trigger
        a.buttons.tertiary = b(1); // grip: grab
        a.buttons.secondary = b(4); // A
        a.buttons.quaternary = b(5); // B
        a.move = [ax(2), -ax(3)];
      } else {
        a.buttons.tertiary = b(0) || b(1); // left trigger or grip also grabs
        a.buttons.spin = b(4); // X
        a.buttons.reset = b(5); // Y
        a.look = [ax(2), -ax(3)];
      }
      a.buttons.menu = b(3);
    }
    merged.push(a);
    if (right && due) {
      const pose = frame.getPose(source.targetRaySpace, space);
      if (pose) {
        controllerMatrix.fromArray(pose.transform.matrix);
        sendToManager?.({ type: "setWand", wand: xrToCave(controllerMatrix) });
      }
    }
  }
  if (due) lastPoseSent = now;
  xrActions = merged.length ? mergeActions(merged) : emptyActions();
}

// ---- Entering VR --------------------------------------------------------------------------
async function enterVR(): Promise<boolean> {
  if (!navigator.xr) return false;
  try {
    const session = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "bounded-floor"] });
    await renderer.xr.setSession(session);
    enter.textContent = "Exit VR";
    session.addEventListener("end", () => {
      enter.textContent = "Enter VR";
      xrActions = emptyActions();
      fit();
    });
    return true;
  } catch (e) {
    hud.textContent = `WebXR session failed: ${(e as Error).message}`;
    return false;
  }
}

async function checkXr() {
  if (usePolyfill) {
    // The polyfill only installs where navigator.xr is missing; on a desktop Chrome it is
    // present but has no device, so drop the native API first (the polyfill would otherwise
    // pick up the native, unconstructible XRSession and friends).
    delete (Navigator.prototype as unknown as Record<string, unknown>).xr;
    for (const name of ["XRSystem", "XRSession", "XRSessionEvent", "XRFrame", "XRView", "XRViewport", "XRViewerPose", "XRWebGLLayer", "XRSpace", "XRReferenceSpace", "XRReferenceSpaceEvent", "XRInputSource", "XRInputSourceEvent", "XRInputSourcesChangeEvent", "XRRenderState", "XRRigidTransform", "XRPose", "XRLayer", "XRWebGLBinding"]) {
      delete (window as unknown as Record<string, unknown>)[name];
    }
    const { default: WebXRPolyfill } = await import("webxr-polyfill");
    new WebXRPolyfill({ allowCardboardOnDesktop: true });
  }
  const ok = !!navigator.xr && (await navigator.xr.isSessionSupported("immersive-vr").catch(() => false));
  enter.disabled = !ok;
  enter.textContent = ok ? "Enter VR" : "no WebXR headset (preview only)";
  enter.addEventListener("click", () => {
    if (renderer.xr.isPresenting) void renderer.xr.getSession()?.end();
    else void enterVR();
  });
}

void checkXr();
connect();
