declare module "webxr-polyfill" {
  export default class WebXRPolyfill {
    constructor(config?: { global?: unknown; webvr?: boolean; cardboard?: boolean; cardboardConfig?: unknown; allowCardboardOnDesktop?: boolean });
  }
}
