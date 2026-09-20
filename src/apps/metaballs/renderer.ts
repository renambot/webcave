/**
 * The webgpu-metaballs renderer driven by WebCAVE instead of its own page.
 *
 * The original WebGPURenderer renders one view from an orbit camera, or two
 * views from WebXR poses. renderView() is that XR path with WebCAVE as the
 * pose source: one view per eye, its matrices written into the project's
 * per-view uniform buffers, the marching-cubes compute run once per frame,
 * the clustered-light compute once per view, and the scene drawn into the
 * OffscreenCanvas WebCAVE hands over. Everything else (materials, glTF,
 * lights, metaball compute, timestamps) is the vendored code untouched.
 *
 * Two conversions on the way in:
 *   - WebGL projections map depth to [-1, 1]; WebGPU wants [0, 1]. The
 *     projection is premultiplied by a z-remap.
 *   - The scene is placed in the world with `offset` (the XR mode put the
 *     viewer 1.8 m from it): view_scene = view_world * translate(offset).
 */
import { mat4, vec3 } from "gl-matrix";
import { WebGPURenderer } from "./vendor/webgpu-renderer/webgpu-renderer.js";
import { ProjectionUniformsSize, ViewUniformsSize } from "./vendor/webgpu-renderer/shaders/common.js";
import type { WebGpuRenderContext } from "../types";

/** Remaps clip-space z from [-1, 1] to [0, 1] when premultiplied to a GL projection (column-major). */
const Z_REMAP = mat4.fromValues(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1);

interface GpuView {
  projectionMatrix: Float32Array;
  inverseProjectionMatrix: Float32Array;
  outputSize: Float32Array;
  zRange: Float32Array;
  viewMatrix: Float32Array;
  cameraPosition: Float32Array;
  timeArray: Float32Array;
  uniformsArray: Float32Array;
  projectionBuffer: GPUBuffer;
  viewBuffer: GPUBuffer;
  clusteredLights: { updateClusters(pass: GPUComputePassEncoder): void };
  getMsaaTextureView(texture: GPUTexture, samples: number): GPUTextureView;
  getDepthTextureView(texture: GPUTexture, format: GPUTextureFormat, samples: number): GPUTextureView;
}

export class CaveMetaballRenderer extends WebGPURenderer {
  TextureLoader: unknown;
  private configured = new WeakSet<OffscreenCanvas>();
  private computePending = false;
  private tmpView = mat4.create();
  private offsetMatrix = mat4.create();
  private tmpProj = mat4.create();

  constructor(TextureLoader: unknown, mediaRoot: string, public offset: [number, number, number]) {
    super();
    this.TextureLoader = TextureLoader;
    this.mediaRoot = mediaRoot;
    mat4.fromTranslation(this.offsetMatrix, this.offset);
  }

  /** Per frame, before any eye: metaball positions for this time, and a GPU recompute on the first view. */
  beginCaveFrame(timeMs: number) {
    if (this.drawMetaballs) this.updateMetaballs(timeMs);
    this.computePending = true;
  }

  /** Draw one eye into `ctx.canvas`. `viewIndex` 0 or 1 selects the per-view buffers (left / mono, right). */
  renderView(ctx: WebGpuRenderContext, viewIndex: 0 | 1, timeMs: number) {
    const device: GPUDevice | undefined = this.device;
    if (!device || !this.metaballRenderer) return;
    const gctx = ctx.canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!gctx) return;
    if (!this.configured.has(ctx.canvas)) {
      gctx.configure({ device, format: this.contextFormat, viewFormats: [this.renderFormat], alphaMode: "opaque" });
      this.configured.add(ctx.canvas);
    }
    const view: GpuView = this.views[viewIndex];

    // Matrices: GL projection -> WebGPU depth range; world view -> scene view; camera in scene space.
    mat4.multiply(this.tmpProj, Z_REMAP, ctx.projection as Float32Array);
    mat4.copy(view.projectionMatrix, this.tmpProj);
    mat4.invert(view.inverseProjectionMatrix, view.projectionMatrix);
    mat4.multiply(this.tmpView, ctx.view as Float32Array, this.offsetMatrix);
    mat4.copy(view.viewMatrix, this.tmpView);
    vec3.set(view.cameraPosition, ctx.eyePosition[0] - this.offset[0], ctx.eyePosition[1] - this.offset[1], ctx.eyePosition[2] - this.offset[2]);
    view.outputSize[0] = ctx.width;
    view.outputSize[1] = ctx.height;
    view.zRange[0] = ctx.near;
    view.zRange[1] = ctx.far;
    view.timeArray[0] = timeMs;
    device.queue.writeBuffer(view.projectionBuffer, 0, view.uniformsArray.buffer, 0, ProjectionUniformsSize);
    device.queue.writeBuffer(view.viewBuffer, 0, view.uniformsArray.buffer, ProjectionUniformsSize, ViewUniformsSize);
    device.queue.writeBuffer(this.lightsBuffer, 0, this.lightManager.uniformArray);

    const encoder = device.createCommandEncoder();
    if (this.computePending) {
      this.computePending = false;
      this.metaballRenderer.updateCompute(encoder, this.timestampHelper);
    }
    const computePass = encoder.beginComputePass({ timestampWrites: this.timestampHelper.timestampWrites("Clusters") });
    view.clusteredLights.updateClusters(computePass);
    computePass.end();

    const current = gctx.getCurrentTexture();
    const currentView = current.createView({ format: this.renderFormat });
    const samples: number = this.sampleCount;
    const colorAttachment: GPURenderPassColorAttachment = {
      view: samples > 1 ? view.getMsaaTextureView(current, samples) : currentView,
      resolveTarget: samples > 1 ? currentView : undefined,
      loadOp: "clear",
      storeOp: samples > 1 ? "discard" : "store",
      clearValue: [0, 0, 0, 1],
    };
    const pass = encoder.beginRenderPass({
      label: `WebCAVE eye ${ctx.eye}`,
      colorAttachments: [colorAttachment],
      depthStencilAttachment: {
        view: view.getDepthTextureView(current, this.depthFormat, samples),
        depthLoadOp: "clear",
        depthClearValue: 1.0,
        depthStoreOp: "discard",
      },
      timestampWrites: this.timestampHelper.timestampWrites(`Render ${ctx.eye}`),
    });
    this.renderScene(pass, view);
    pass.end();
    const timestamps = this.timestampHelper.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    if (this.stats) {
      void timestamps.read().then((results: Record<string, number>) => {
        for (const [key, value] of Object.entries(results)) this.stats.addSample(key, value);
      });
    }
  }
}
