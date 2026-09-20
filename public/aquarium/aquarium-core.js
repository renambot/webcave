/**
 * WebGL Aquarium core, adapted for WebCAVE from aquarium.js
 * (WebGLSamples, Copyright 2009 Google Inc., BSD 3-clause; see LICENSE.md).
 *
 * What changed from the original:
 *   - no page: no canvas, UI, FPS counter, network sync, WebXR or multiview;
 *     the host gives the projection and view-inverse matrices per eye
 *     (the original already drew from external matrices in its VR path)
 *   - one instance per WebGL context (window.AquariumCore.create(gl, ...)),
 *     because a simulator page draws several screens with several contexts;
 *     tdl keeps its program and texture caches per context, and a small
 *     wrapper makes texture uploads use the context they were created in
 *   - shaders come from shaders.json instead of <script> tags
 *   - time comes from the host (the cluster clock): the fish are pure
 *     functions of it as before; light rays and bubbles, which used
 *     Math.random and a countdown, are now hashed from time so every screen
 *     agrees
 *   - settings (fish count, options, lasers) are set by the host
 *
 * tdl relies on a global `gl`; every entry point of an instance sets it.
 */
(function () {
  "use strict";

  var loaded = false;
  var math, fast;

  /** Make tdl textures upload into the context they were created in, whatever `gl` is at image-load time. */
  function patchTdlForManyContexts() {
    if (tdl.textures.__webcavePatched) return;
    tdl.textures.__webcavePatched = true;
    function wrapClass(name, methods) {
      var Orig = tdl.textures[name];
      var Wrapped = function () {
        this.__gl = window.gl;
        return Orig.apply(this, arguments);
      };
      Wrapped.prototype = Orig.prototype;
      methods.forEach(function (m) {
        var orig = Orig.prototype[m];
        if (!orig) return;
        Orig.prototype[m] = function () {
          if (this.__gl) window.gl = this.__gl;
          return orig.apply(this, arguments);
        };
      });
      tdl.textures[name] = Wrapped;
    }
    wrapClass("Texture2D", ["uploadTexture", "setTexture", "updateTexture", "bindToUnit"]);
    wrapClass("CubeMap", ["uploadTextures", "bindToUnit"]);
  }

  /** Stateless hash of small integers -> [0, 1), for effects that were random. */
  function hash(a, b) {
    var h = (a | 0) * 374761393 + (b | 0) * 668265263;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ---- Tables from aquarium.js -------------------------------------------------------
  var fishTable = [
    { name: "SmallFishA", speed: 1, speedRange: 1.5, radius: 30, radiusRange: 25, tailSpeed: 10, heightOffset: 0, heightRange: 16, constUniforms: { fishLength: 10, fishWaveLength: 1, fishBendAmount: 2 } },
    { name: "MediumFishA", speed: 1, speedRange: 2, radius: 10, radiusRange: 20, tailSpeed: 1, heightOffset: 0, heightRange: 16, constUniforms: { fishLength: 10, fishWaveLength: -2, fishBendAmount: 2 } },
    { name: "MediumFishB", speed: 0.5, speedRange: 4, radius: 10, radiusRange: 20, tailSpeed: 3, heightOffset: -8, heightRange: 5, constUniforms: { fishLength: 10, fishWaveLength: -2, fishBendAmount: 2 } },
    { name: "BigFishA", speed: 0.5, speedRange: 0.5, radius: 50, radiusRange: 3, tailSpeed: 1.5, heightOffset: 0, heightRange: 16, lasers: true, laserRot: 0.04, laserOff: [0, 0.1, 9], laserScale: [0.3, 0.3, 1000], constUniforms: { fishLength: 10, fishWaveLength: -1, fishBendAmount: 0.5 } },
    { name: "BigFishB", speed: 0.5, speedRange: 0.5, radius: 45, radiusRange: 3, tailSpeed: 1, heightOffset: 0, heightRange: 16, lasers: true, laserRot: 0.04, laserOff: [0, -0.3, 9], laserScale: [0.3, 0.3, 1000], constUniforms: { fishLength: 10, fishWaveLength: -0.7, fishBendAmount: 0.3 } },
  ];
  var sceneInfo = [
    { name: "SmallFishA", program: ["fishVertexShader", "fishReflectionFragmentShader"] },
    { name: "MediumFishA", program: ["fishVertexShader", "fishNormalMapFragmentShader"] },
    { name: "MediumFishB", program: ["fishVertexShader", "fishReflectionFragmentShader"] },
    { name: "BigFishA", program: ["fishVertexShader", "fishNormalMapFragmentShader"] },
    { name: "BigFishB", program: ["fishVertexShader", "fishNormalMapFragmentShader"] },
    { name: "Arch" }, { name: "Coral" }, { name: "CoralStoneA" }, { name: "CoralStoneB" },
    { name: "EnvironmentBox", fog: false, group: "outside", program: ["diffuseVertexShader", "diffuseFragmentShader"] },
    { name: "FloorBase_Baked" }, { name: "FloorCenter" },
    { name: "GlobeBase", fog: false, program: ["diffuseVertexShader", "diffuseFragmentShader"] },
    { name: "GlobeInner", group: "inner", program: ["innerRefractionMapVertexShader", "innerRefractionMapFragmentShader"] },
    { name: "GlobeOuter", group: "outer", blend: true, program: ["outerRefractionMapVertexShader", "outerRefractionMapFragmentShader"] },
    { name: "RockA" }, { name: "RockB" }, { name: "RockC" }, { name: "RuinColumn" },
    { name: "Skybox", fog: false, group: "outside", program: ["diffuseVertexShader", "diffuseFragmentShader"] },
    { name: "Stone" }, { name: "Stones" }, { name: "SunknShip" }, { name: "SunknSub" },
    { name: "SupportBeams", group: "outside", fog: false },
    { name: "SeaweedA", blend: true, group: "seaweed", program: ["seaweedVertexShader", "seaweedFragmentShader"] },
    { name: "SeaweedB", blend: true, group: "seaweed", program: ["seaweedVertexShader", "seaweedFragmentShader"] },
    { name: "TreasureChest" },
  ];
  /** The fish counts the original offered, and how each total splits into big / medium / small (from initialize()). */
  var fishCounts = [1, 100, 500, 1000, 5000, 10000, 15000, 20000, 25000, 30000];
  function splitFish(totalFish) {
    var counts = {};
    var numLeft = totalFish;
    ["Big", "Medium", "Small"].forEach(function (type) {
      fishTable.forEach(function (fishInfo) {
        if (fishInfo.name.indexOf(type) !== 0) return;
        var numType = numLeft;
        if (type === "Big") numType = Math.min(numLeft, totalFish < 100 ? 1 : 2);
        else if (type === "Medium") numType = totalFish < 1000 ? Math.min(numLeft, (totalFish / 10) | 0) : totalFish < 10000 ? Math.min(numLeft, 80) : Math.min(numLeft, 160);
        numLeft -= numType;
        counts[fishInfo.name] = numType;
      });
    });
    return counts;
  }

  /** View presets (aquarium-common.js g_viewSettings): fog, ambient and tank constants. */
  var viewSettings = {
    inside: { ambientRed: 0.218, ambientGreen: 0.502, ambientBlue: 0.706, fogPower: 16.5, fogMult: 1.5, fogOffset: 0.738, fogRed: 0.338, fogGreen: 0.81, fogBlue: 1, refractionFudge: 3, eta: 1, tankColorFudge: 0.796 },
    outside: { ambientRed: 0.218, ambientGreen: 0.246, ambientBlue: 0.394, fogPower: 27.1, fogMult: 1.46, fogOffset: 0.53, fogRed: 0.382, fogGreen: 0.602, fogBlue: 1, refractionFudge: 3, eta: 1, tankColorFudge: 1 },
    original: { ambientRed: 0.22, ambientGreen: 0.25, ambientBlue: 0.39, fogPower: 14.5, fogMult: 1.66, fogOffset: 0.53, fogRed: 0.54, fogGreen: 0.86, fogBlue: 1, refractionFudge: 3, eta: 1, tankColorFudge: 0.8 },
  };
  /** Fish motion defaults (the g_ui sliders). */
  var fishDefaults = { fishHeightRange: 1, fishHeight: 25, fishSpeed: 0.124, fishOffset: 0.52, fishXClock: 1, fishYClock: 0.556, fishZClock: 1, fishTailSpeed: 1 };

  var tankRadius = 74, tankHeight = 36;
  var numLightRays = 5, lightRayY = 50, lightRayDurationMin = 1, lightRayDurationRange = 1, lightRayPosRange = 20, lightRayRotRange = 1.0, lightRayRotLerp = 0.2;
  var numBubbleSets = 10, laserEta = 1.2;

  function raySphereIntersection(point1, point2, center, radius) {
    var kEpsilon = 0.001;
    var dx = point2[0] - point1[0], dy = point2[1] - point1[1], dz = point2[2] - point1[2];
    var a = dx * dx + dy * dy + dz * dz;
    var b = 2 * (dx * (point1[0] - center[0]) + dy * (point1[1] - center[1]) + dz * (point1[2] - center[2]));
    var c = center[0] * center[0] + center[1] * center[1] + center[2] * center[2] + point1[0] * point1[0] + point1[1] * point1[1] + point1[2] * point1[2] - 2 * (center[0] * point1[0] + center[1] * point1[1] + center[2] * point1[2]) - radius * radius;
    var disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    var t = (-b + Math.sqrt(disc)) / (2 * a);
    if (t < kEpsilon) return null;
    return [point1[0] + t * dx, point1[1] + t * dy, point1[2] + t * dz];
  }
  function refract(i, n, eta) {
    var cosi = -math.dot(i, n);
    var cost2 = 1.0 - eta * eta * (1.0 - cosi * cosi);
    if (cost2 <= 0) return null;
    return math.subVector(math.mulVectorScalar(i, eta), math.mulVectorScalar(n, eta * cosi + Math.sqrt(cost2)));
  }

  // ---- One aquarium per WebGL context --------------------------------------------------
  /**
   * @param gl        the context to draw into (bound framebuffer and viewport are the host's business)
   * @param opts      { root: url of the aquarium folder, shaders: {id: source}, onStatus(text) }
   */
  function create(gl, opts) {
    window.gl = gl;
    if (!gl.tdl) gl.tdl = {}; // tdl.webgl.setupWebGL() would have made this; the context is the host's
    math = tdl.math;
    fast = tdl.fast;
    patchTdlForManyContexts();
    var root = opts.root;
    var shaderText = opts.shaders;
    var status = opts.onStatus || function () {};

    var settings = {
      fishSetting: 2,
      speed: 1,
      view: "inside",
      drawLasers: false,
      options: { normalMaps: false, reflection: false, tank: true, museum: true, fog: true, bubbles: true, lightRays: true },
    };
    var fishNum = splitFish(fishCounts[settings.fishSetting]);
    var scenes = {}, sceneGroups = {}, sceneInfoByName = {};
    sceneInfo.forEach(function (info) { sceneInfoByName[info.name] = info; });
    var shadersNeedUpdate = false;
    var clock = 0, time = 0;

    // ---- Programs, with the original's fog / reflection / normal-map variants ----
    function createProgramFromTags(vsId, fsId, fog, reflection, normalMaps) {
      var fogUniforms = "uniform float fogPower;\nuniform float fogMult;\nuniform float fogOffset;\nuniform vec4 fogColor;\n";
      var fogCode = "outColor = mix(outColor, vec4(fogColor.rgb, diffuseColor.a),\n   clamp(pow((v_position.z / v_position.w), fogPower) * fogMult - fogOffset,0.0,1.0));\n";
      var fs = shaderText[fsId];
      var vs = shaderText[vsId];
      if (!fs || !vs) throw new Error("missing shader " + vsId + " / " + fsId);
      if (fog) fs = fs.replace("// #fogUniforms", fogUniforms).replace("// #fogCode", fogCode);
      fs = reflection ? fs.replace(/^.*?\/\/ #noReflection$/gm, "") : fs.replace(/^.*?\/\/ #reflection$/gm, "");
      fs = normalMaps ? fs.replace(/^.*?\/\/ #noNormalMap$/gm, "") : fs.replace(/^.*?\/\/ #normalMap$/gm, "");
      window.gl = gl;
      return tdl.programs.loadProgram(vs, fs);
    }
    function shadingSettings() {
      return { fog: settings.options.fog, reflection: settings.options.reflection, normalMap: settings.options.normalMaps };
    }
    function ProgramSet(vsId, fsId, fogMask) {
      this.vsId = vsId; this.fsId = fsId; this.fogMask = fogMask; this.cache = {};
    }
    ProgramSet.prototype.getProgram = function (s) {
      var fog = this.fogMask && s.fog;
      var key = "p" + (fog ? "Fog" : "") + (s.reflection ? "Reflect" : "") + (s.normalMap ? "Normalmap" : "");
      if (!this.cache[key]) this.cache[key] = createProgramFromTags(this.vsId, this.fsId, fog, s.reflection, s.normalMap);
      return this.cache[key];
    };

    // ---- Scenes: JSON models with textures ----
    var skyBoxUrls = ["positive_x", "negative_x", "positive_y", "negative_y", "positive_z", "negative_z"].map(function (s) { return root + "assets/GlobeOuter_EM_" + s + ".jpg"; });
    function Scene(programIds, fog) {
      this.programIds = programIds; this.fog = fog; this.models = []; this.loaded = false; this.bad = false;
    }
    Scene.prototype.load = function (url) {
      var that = this;
      this.url = url;
      tdl.io.loadJSON(url, function (data, exception) { that.onload_(data, exception); });
    };
    Scene.prototype.onload_ = function (data, exception) {
      window.gl = gl; // this callback is asynchronous: make sure we build into our own context
      this.loaded = true;
      if (exception) { this.bad = true; status("failed: " + this.url); return; }
      for (var mm = 0; mm < data.models.length; ++mm) {
        var model = data.models[mm];
        var textures = {};
        for (var tname in model.textures) textures[tname] = tdl.textures.loadTexture(root + "assets/" + model.textures[tname], true);
        var arrays = {};
        for (var fname in model.fields) {
          var field = model.fields[fname];
          arrays[fname] = new tdl.primitives.AttribBuffer(field.numComponents, field.data, field.type);
        }
        var vsId, fsId;
        if (!textures.diffuse) throw new Error("missing diffuse texture for " + this.url);
        if (this.programIds) { vsId = this.programIds[0]; fsId = this.programIds[1]; textures.skybox = tdl.textures.loadTexture(skyBoxUrls); }
        else if (textures.reflectionMap) { vsId = "reflectionMapVertexShader"; fsId = "reflectionMapFragmentShader"; textures.skybox = tdl.textures.loadTexture(skyBoxUrls); }
        else if (textures.normalMap) { vsId = "normalMapVertexShader"; fsId = "normalMapFragmentShader"; }
        else { vsId = "diffuseVertexShader"; fsId = "diffuseFragmentShader"; }
        var programSet = new ProgramSet(vsId, fsId, this.fog);
        var program = programSet.getProgram(shadingSettings());
        var m = new tdl.models.Model(program, arrays, textures);
        m.programSet = programSet;
        m.extents = arrays.position.computeExtents();
        this.models.push(m);
      }
      loadedCount++;
      status(loadedCount + "/" + sceneInfo.length + " models");
    };
    var loadedCount = 0;
    sceneInfo.forEach(function (info) {
      var s = new Scene(info.program, info.fog !== undefined ? info.fog : true);
      scenes[info.name] = s;
      s.load(root + "assets/" + info.name + ".js");
    });
    tdl.io.loadJSON(root + "assets/PropPlacement.js", function (json, exception) {
      if (exception) { status("placement failed"); return; }
      json.objects.forEach(function (object) {
        var info = sceneInfoByName[object.name];
        var groupName = (info && info.group) || "base";
        (sceneGroups[groupName] = sceneGroups[groupName] || []).push(object);
      });
    });

    // ---- Laser, light rays, bubbles ----
    function setupLaser() {
      var textures = { colorMap: tdl.textures.loadTexture(root + "static/beam.png") };
      var beam1 = tdl.primitives.createPlane(1, 1, 1, 1);
      delete beam1.normal;
      tdl.primitives.reorient(beam1, math.matrix4.translation([0, 0, 0.5]));
      var beam2 = tdl.primitives.clone(beam1), beam3 = tdl.primitives.clone(beam1);
      tdl.primitives.reorient(beam2, math.matrix4.rotationZ(math.degToRad(120)));
      tdl.primitives.reorient(beam3, math.matrix4.rotationZ(math.degToRad(-120)));
      var arrays = tdl.primitives.concat([beam1, beam2, beam3]);
      var ps = new ProgramSet("laserVertexShader", "laserFragmentShader", false);
      var m = new tdl.models.Model(ps.getProgram(shadingSettings()), arrays, textures);
      m.programSet = ps;
      return m;
    }
    function setupLightRay() {
      var textures = { colorMap: tdl.textures.loadTexture(root + "assets/LightRay.png") };
      var arrays = tdl.primitives.createPlane(1, 1, 1, 1);
      tdl.primitives.reorient(arrays, [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0.5, 0, 1]);
      delete arrays.normal;
      var ps = new ProgramSet("texVertexShader", "texFragmentShader", false);
      var m = new tdl.models.Model(ps.getProgram(shadingSettings()), arrays, textures);
      m.programSet = ps;
      return m;
    }
    var laser = setupLaser();
    var lightRay = setupLightRay();
    // Light rays as functions of time: each ray has a fixed period; rotation and x come from the cycle number.
    var lightRayInfo = [];
    for (var ii = 0; ii < numLightRays; ++ii) lightRayInfo.push({ duration: lightRayDurationMin + hash(ii, 7) * lightRayDurationRange, lerp: 1, rot: 0, x: 0 });

    var particleSystem = new tdl.particles.ParticleSystem(gl, function () { return time; }, math.pseudoRandom, false);
    var bubbleSets = [];
    (function setupBubbles() {
      var texture = tdl.textures.loadTexture(root + "static/bubble.png");
      var emitter = particleSystem.createParticleEmitter(texture.texture);
      emitter.setTranslation(0, 0, 0);
      emitter.setState(tdl.particles.ParticleStateIds.ADD);
      emitter.setColorRamp([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
      emitter.setParameters({
        numParticles: 100, numFrames: 1, frameDuration: 1000.0, frameStartRange: 0, lifeTime: 40, startTime: 0,
        startSize: 0.01, startSizeRange: 0.01, endSize: 0.4, endSizeRange: 0.2, position: [0, -2, 0], positionRange: [0.1, 2, 0.1],
        acceleration: [0, 0.05, 0], accelerationRange: [0, 0.02, 0], velocityRange: [0.05, 0, 0.05], colorMult: [0.7, 0.8, 1, 1],
      });
      for (var i = 0; i < numBubbleSets; ++i) bubbleSets[i] = emitter.createOneShot();
    })();
    // Bubble bursts on a fixed schedule: burst k starts at T_k = sum of (2 + hash * 8) intervals.
    var nextBubble = 0, nextBubbleTime = 0, bubbleWorld = new Float32Array(16);

    // ---- Uniform blocks (as in the original) ----
    var projection = new Float32Array(16), view = new Float32Array(16), viewInverse = new Float32Array(16);
    var world = new Float32Array(16), worldInverse = new Float32Array(16), worldInverseTranspose = new Float32Array(16);
    var viewProjection = new Float32Array(16), viewProjectionNoRotation = new Float32Array(16);
    var eyePosition = new Float32Array(3), lightWorldPos = new Float32Array(3), up = new Float32Array([0, 1, 0]);
    var v3t0 = new Float32Array(3), v3t1 = new Float32Array(3);
    var m4t0 = new Float32Array(16), m4t1 = new Float32Array(16), m4t2 = new Float32Array(16), m4t3 = new Float32Array(16);
    var one4 = new Float32Array([1, 1, 1, 1]), ambient = new Float32Array(4), fogColor = new Float32Array([1, 1, 1, 1]);
    var genericConst = { viewInverse: viewInverse, viewProjection: viewProjection, lightWorldPos: lightWorldPos, lightColor: one4, specular: one4, shininess: 50, specularFactor: 1, ambient: ambient };
    var genericPer = { world: world, worldInverse: worldInverse, worldInverseTranspose: worldInverseTranspose };
    var outsideConst = { viewInverse: viewInverse, viewProjection: viewProjection, lightWorldPos: lightWorldPos, lightColor: one4, specular: one4, shininess: 50, specularFactor: 0, ambient: ambient };
    var seaweedConst = { viewInverse: viewInverse, viewProjection: viewProjection, lightWorldPos: lightWorldPos, lightColor: one4, specular: one4, shininess: 50, specularFactor: 1, ambient: ambient };
    var laserConst = { viewProjection: viewProjection };
    var laserPer = { world: world };
    var innerConst = { viewInverse: viewInverse, viewProjection: viewProjection, lightWorldPos: lightWorldPos, lightColor: one4, specular: one4, shininess: 50, specularFactor: 1, refractionFudge: 0, eta: 0, tankColorFudge: 0 };
    var fishConst = { viewProjection: viewProjection, viewInverse: viewInverse, lightWorldPos: lightWorldPos, lightColor: one4, specular: one4, shininess: 5, specularFactor: 0.3, ambient: ambient };
    var fishPer = { worldPosition: new Float32Array(3), nextPosition: new Float32Array(3), scale: 1 };
    var lightRayConst = { viewProjection: viewProjectionNoRotation };
    var lightRayPer = { world: world, colorMult: new Float32Array([1, 1, 1, 1]) };

    function drawGroup(group, constUniforms, perUniforms) {
      var currentModel;
      for (var ii = 0; ii < group.length; ++ii) {
        var object = group[ii];
        var scene = scenes[object.name];
        var info = sceneInfoByName[object.name];
        if (!scene || !scene.loaded || scene.bad) continue;
        if (info && info.blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
        for (var jj = 0; jj < scene.models.length; ++jj) {
          var model = scene.models[jj];
          if (model !== currentModel) { currentModel = model; model.drawPrep(constUniforms); }
          fast.matrix4.copy(world, object.worldMatrix);
          fast.matrix4.inverse(worldInverse, world);
          fast.matrix4.transpose(worldInverseTranspose, worldInverse);
          perUniforms.time = clock + ii;
          model.draw(perUniforms);
        }
      }
    }
    function setShaders() {
      var s = shadingSettings();
      for (var name in scenes) scenes[name].models.forEach(function (m) { m.setProgram(m.programSet.getProgram(s)); });
      laser.setProgram(laser.programSet.getProgram(s));
      lightRay.setProgram(lightRay.programSet.getProgram(s));
    }

    /** Set the host's settings; returns nothing. Shader variants are rebuilt on the next render when needed. */
    function setSettings(s) {
      var opts = s.options || {};
      var needShaders = false;
      for (var k in settings.options) {
        if (typeof opts[k] === "boolean" && opts[k] !== settings.options[k]) {
          settings.options[k] = opts[k];
          if (k === "fog" || k === "normalMaps" || k === "reflection") needShaders = true;
        }
      }
      if (typeof s.fishSetting === "number" && s.fishSetting !== settings.fishSetting) {
        settings.fishSetting = Math.max(0, Math.min(fishCounts.length - 1, s.fishSetting | 0));
        fishNum = splitFish(fishCounts[settings.fishSetting]);
      }
      if (typeof s.speed === "number") settings.speed = s.speed;
      if (typeof s.view === "string" && viewSettings[s.view]) settings.view = s.view;
      if (typeof s.drawLasers === "boolean") settings.drawLasers = s.drawLasers;
      if (needShaders) shadersNeedUpdate = true;
    }

    /** Advance the effects to cluster time t (seconds). Deterministic: no random, no deltas. */
    function update(t) {
      time = t;
      clock = t * settings.speed;
      for (var ii = 0; ii < lightRayInfo.length; ++ii) {
        var info = lightRayInfo[ii];
        var cycles = clock / info.duration;
        var cycle = Math.floor(cycles);
        info.lerp = 1 - (cycles - cycle);
        info.rot = hash(ii, cycle) * lightRayRotRange;
        info.x = (hash(ii, cycle) - 0.5) * lightRayPosRange;
      }
      if (settings.options.bubbles) {
        // Fire every scheduled burst up to now, skipping bursts that would already have faded (a node joining late).
        while (nextBubbleTime <= clock) {
          if (clock - nextBubbleTime < 40) {
            var radius = hash(nextBubble, 11) * 50, angle = hash(nextBubble, 13) * Math.PI * 2;
            fast.matrix4.translation(bubbleWorld, [Math.sin(angle) * radius, 0, Math.cos(angle) * radius]);
            window.gl = gl;
            bubbleSets[nextBubble % numBubbleSets].trigger(bubbleWorld);
          }
          nextBubble++;
          nextBubbleTime += 2 + hash(nextBubble, 17) * 8;
        }
      }
    }

    /**
     * Draw one eye. `projectionMatrix` and `viewInverseMatrix` are column-major
     * Float32Array(16) in the aquarium's units; the framebuffer and viewport
     * are already set by the host. Clears colour and depth first.
     */
    function render(projectionMatrix, viewInverseMatrix) {
      window.gl = gl;
      if (shadersNeedUpdate) { shadersNeedUpdate = false; setShaders(); }
      var vs = viewSettings[settings.view];
      var f = fishDefaults;
      ambient[0] = vs.ambientRed; ambient[1] = vs.ambientGreen; ambient[2] = vs.ambientBlue;
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.colorMask(true, true, true, true);
      gl.clearColor(0, 0.8, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      fast.matrix4.copy(projection, projectionMatrix);
      fast.matrix4.copy(viewInverse, viewInverseMatrix);
      fast.matrix4.inverse(view, viewInverse);
      fast.matrix4.mul(viewProjection, view, projection);
      eyePosition[0] = viewInverse[12]; eyePosition[1] = viewInverse[13]; eyePosition[2] = viewInverse[14];
      fast.matrix4.getAxis(v3t0, viewInverse, 0);
      fast.matrix4.getAxis(v3t1, viewInverse, 1);
      fast.mulScalarVector(v3t0, 20, v3t0);
      fast.mulScalarVector(v3t1, 30, v3t1);
      fast.addVector(lightWorldPos, eyePosition, v3t0);
      fast.addVector(lightWorldPos, lightWorldPos, v3t1);
      gl.disable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.blendEquation(gl.FUNC_ADD);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.frontFace(gl.CCW);
      math.resetPseudoRandom();
      var pseudoRandom = math.pseudoRandom;
      gl.depthMask(true);
      innerConst.eta = vs.eta; innerConst.tankColorFudge = vs.tankColorFudge; innerConst.refractionFudge = vs.refractionFudge;
      [genericConst, fishConst, innerConst, seaweedConst].forEach(function (c) {
        c.fogPower = vs.fogPower; c.fogMult = vs.fogMult; c.fogOffset = vs.fogOffset; c.fogColor = fogColor;
      });
      fogColor[0] = vs.fogRed; fogColor[1] = vs.fogGreen; fogColor[2] = vs.fogBlue;

      if (sceneGroups.base) drawGroup(sceneGroups.base, genericConst, genericPer);

      // Fish: pure functions of the clock and the per-frame pseudo-random sequence.
      gl.enable(gl.BLEND);
      for (var ff = 0; ff < fishTable.length; ++ff) {
        var fishInfo = fishTable[ff];
        var numFish = fishNum[fishInfo.name] || 0;
        var scene = scenes[fishInfo.name];
        if (!(scene && scene.loaded && !scene.bad && scene.models.length)) continue;
        var fish = scene.models[0];
        for (var p in fishInfo.constUniforms) fishConst[p] = fishInfo.constUniforms[p];
        fish.drawPrep(fishConst);
        var fishBaseClock = clock * f.fishSpeed;
        var fishTailSpeed = fishInfo.tailSpeed * f.fishTailSpeed;
        var fishHeight = f.fishHeight + fishInfo.heightOffset;
        var fishHeightRange = f.fishHeightRange * fishInfo.heightRange;
        var fishPosition = fishPer.worldPosition, fishNextPosition = fishPer.nextPosition;
        for (var ii = 0; ii < numFish; ++ii) {
          var fishClock = fishBaseClock + ii * f.fishOffset;
          var speed = fishInfo.speed + pseudoRandom() * fishInfo.speedRange;
          var scale = 1.0 + pseudoRandom() * 1;
          var xRadius = fishInfo.radius + pseudoRandom() * fishInfo.radiusRange;
          var yRadius = 2.0 + pseudoRandom() * fishHeightRange;
          var zRadius = fishInfo.radius + pseudoRandom() * fishInfo.radiusRange;
          var fishSpeedClock = fishClock * speed;
          var xClock = fishSpeedClock * f.fishXClock, yClock = fishSpeedClock * f.fishYClock, zClock = fishSpeedClock * f.fishZClock;
          fishPosition[0] = Math.sin(xClock) * xRadius;
          fishPosition[1] = Math.sin(yClock) * yRadius + fishHeight;
          fishPosition[2] = Math.cos(zClock) * zRadius;
          fishNextPosition[0] = Math.sin(xClock - 0.04) * xRadius;
          fishNextPosition[1] = Math.sin(yClock - 0.01) * yRadius + fishHeight;
          fishNextPosition[2] = Math.cos(zClock - 0.04) * zRadius;
          fishPer.scale = scale;
          fishPer.time = ((clock + ii) * fishTailSpeed * speed) % (Math.PI * 2);
          fish.draw(fishPer);
          if (settings.drawLasers && fishInfo.lasers) {
            fishInfo.fishData = fishInfo.fishData || [];
            fishInfo.fishData[ii] = { position: [fishPosition[0], fishPosition[1], fishPosition[2]], target: [fishNextPosition[0], fishNextPosition[1], fishNextPosition[2]], scale: scale, time: fishPer.time };
          }
        }
      }

      if (settings.options.tank && sceneGroups.inner) drawGroup(sceneGroups.inner, innerConst, genericPer);
      if (sceneGroups.seaweed) drawGroup(sceneGroups.seaweed, seaweedConst, genericPer);

      if (settings.drawLasers) drawLasers(false);

      if (settings.options.museum && sceneGroups.outside) drawGroup(sceneGroups.outside, outsideConst, genericPer);

      fast.matrix4.translation(world, [0, 0, 0]);
      if (settings.options.bubbles) particleSystem.draw(viewProjection, world, viewInverse, false);

      gl.enable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      if (settings.options.lightRays) {
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        fast.matrix4.translation(m4t1, [view[12], view[13], view[14]]);
        fast.matrix4.mul(viewProjectionNoRotation, m4t1, projection);
        lightRay.drawPrep(lightRayConst);
        for (var li = 0; li < lightRayInfo.length; ++li) {
          var info = lightRayInfo[li];
          var y = Math.max(70, Math.min(120, lightRayY + 7.5));
          fast.matrix4.mul(m4t1, fast.matrix4.rotationZ(m4t0, info.rot + info.lerp * lightRayRotLerp), fast.matrix4.translation(m4t2, [info.x, y, 0]));
          fast.matrix4.mul(world, fast.matrix4.scaling(m4t0, [10, -100, 10]), m4t1);
          lightRayPer.colorMult[3] = Math.sin(info.lerp * Math.PI);
          lightRay.draw(lightRayPer);
        }
      }
      gl.depthMask(true);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.blendEquation(gl.FUNC_ADD);
      if (settings.options.tank && sceneGroups.outer) drawGroup(sceneGroups.outer, innerConst, genericPer);
      if (settings.drawLasers) drawLasers(true);
      gl.disable(gl.BLEND);
      gl.enable(gl.CULL_FACE);
      gl.depthMask(true);
    }

    function drawLasers(outside) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      laser.drawPrep(laserConst);
      var c = 0.5 + (Math.floor(time * 60) % 2) + 0.5;
      laserConst.colorMult = [c * 1, c * 0.1, c * 0.1, c];
      var center = [0, tankHeight, 0];
      for (var ff = 0; ff < fishTable.length; ++ff) {
        var fishInfo = fishTable[ff];
        if (!fishInfo.lasers || !fishInfo.fishData) continue;
        var scene = scenes[fishInfo.name];
        if (!(scene && scene.loaded && !scene.bad && scene.models.length)) continue;
        var fish = scene.models[0];
        var numFish = fishNum[fishInfo.name] || 0;
        var mult = fish.extents.max[2] / fishInfo.constUniforms.fishLength;
        for (var ii = 0; ii < numFish; ++ii) {
          var data = fishInfo.fishData[ii];
          if (!data) continue;
          if (!outside) {
            var s = Math.sin(data.time + mult * fishInfo.constUniforms.fishWaveLength);
            var off = [mult * mult * s * fishInfo.constUniforms.fishBendAmount, fishInfo.laserOff[1], fishInfo.laserOff[2]];
            fast.matrix4.mul(world, fast.matrix4.scaling(m4t1, [1, 1, 1]), fast.matrix4.cameraLookAt(m4t2, data.position, data.target, up));
            fast.matrix4.mul(m4t2, fast.matrix4.rotationY(m4t3, s * fishInfo.laserRot), fast.matrix4.translation(m4t1, off));
            fast.matrix4.mul(world, m4t2, world);
            var laserDir = math.normalize([world[8], world[9], world[10]]);
            var point1 = [world[12], world[13], world[14]];
            var point2 = math.addVector(point1, math.mulVectorScalar(laserDir, 1000));
            var intersection = raySphereIntersection(point1, point2, center, tankRadius);
            data.laser = null;
            if (intersection) {
              var len = math.length(math.subVector(intersection, point1));
              fast.matrix4.mul(world, fast.matrix4.scaling(m4t0, [fishInfo.laserScale[0], fishInfo.laserScale[1], len]), world);
              laser.draw(laserPer);
              var newDir = refract(math.negativeVector(laserDir), math.normalize(intersection), laserEta);
              data.laser = { position: intersection, target: newDir ? math.addVector(intersection, newDir) : undefined };
            }
          } else if (data.laser && data.laser.target) {
            fast.matrix4.mul(world, fast.matrix4.scaling(m4t1, [0.5, 0.5, 200]), fast.matrix4.cameraLookAt(m4t0, data.laser.position, data.laser.target, up));
            laser.draw(laserPer);
          }
        }
      }
      gl.disable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.CULL_FACE);
      gl.depthMask(true);
    }

    return {
      gl: gl,
      settings: settings,
      setSettings: setSettings,
      update: update,
      render: render,
      fishCounts: fishCounts,
      loaded: function () { return { models: loadedCount, total: sceneInfo.length, placement: !!sceneGroups.base }; },
    };
  }

  window.AquariumCore = { create: create, fishCounts: fishCounts, views: Object.keys(viewSettings) };
})();
