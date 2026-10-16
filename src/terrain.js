import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  color,
  mix,
  smoothstep,
  pow,
  clamp,
  sin,
  cos,
  abs,
  fract,
  floor,
  dot,
  normalize,
  max,
  min,
  output,
  positionWorld,
  normalWorld,
  cameraPosition,
  vertexColor,
} from 'three/tsl';
import { sampleMarsSurfaceInfo, fbm2D } from './noise.js';
import { evalMarsAtmosphereRadiance } from './sky.js';

/**
 * Generates a high-density variable-resolution procedural Martian terrain mesh
 * with custom TSL node shader (compatible with both WebGPURenderer and WebGL backend).
 */
export function createMarsTerrain(sunDirUniform, fogHorizonColorUniform, fogZenithColorUniform) {
  const size = 1200;
  const segments = 560; // 560x560 = 313,600 quads (~627k triangles)

  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const posAttr = geometry.attributes.position;
  const vertexCount = posAttr.count;

  // Store geological attributes in vertex color:
  // R = ambient occlusion (cavity/trough darkening)
  // G = active sand cover vs exposed bedrock (0 = bedrock outcrop, 1 = rippled aeolian sand)
  // B = slip-face / dark mafic basaltic sand sorting factor
  const colors = new Float32Array(vertexCount * 3);

  const halfSize = size * 0.5;
  for (let i = 0; i < vertexCount; i++) {
    let x = posAttr.getX(i);
    let z = posAttr.getZ(i);

    const nx = x / halfSize;
    const nz = z / halfSize;
    const r = Math.hypot(nx, nz);
    if (r > 0.0001) {
      const warpedR = Math.pow(r, 1.32);
      const scale = warpedR / r;
      x *= scale;
      z *= scale;
    }

    const info = sampleMarsSurfaceInfo(x, z, 0.5);
    posAttr.setXYZ(i, x, info.height, z);

    // Smooth cavity AO
    const ao = Math.max(0.38, Math.min(1.0, 0.82 + info.curvature * 0.30 + info.ny * 0.14));

    // Smooth regional sand mask (avoids noisy high-frequency slope blotches)
    const patchNoise = fbm2D(x * 0.012 + 7.2, z * 0.012 - 3.8, 3);
    const rawSand = info.activeSandCover - info.slope * 0.45 + patchNoise * 0.15;
    const sandMask = Math.max(0.0, Math.min(1.0, rawSand));

    // Basaltic dark sand sorting on leeward slip-faces and active barchan flanks
    const streakNoise = 0.5 + 0.5 * fbm2D(x * 0.014 - 14.0, z * 0.014 + 9.0, 3);
    const basaltFactor = Math.max(
      0.0,
      Math.min(1.0, info.slipFaceFactor * 0.62 + streakNoise * 0.48 * info.activeSandCover)
    );

    colors[i * 3 + 0] = ao;
    colors[i * 3 + 1] = sandMask;
    colors[i * 3 + 2] = basaltFactor;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardNodeMaterial();

  const hash2D = Fn(([p]) => {
    const h = dot(p, vec2(127.1, 311.7));
    return fract(sin(h).mul(43758.5453123));
  });

  const valueNoise2D = Fn(([p]) => {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));

    const a = hash2D(i);
    const b = hash2D(i.add(vec2(1.0, 0.0)));
    const c = hash2D(i.add(vec2(0.0, 1.0)));
    const d = hash2D(i.add(vec2(1.0, 1.0)));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  });

  // 2-octave FBM in shader for organic domain warping & Y-junction ripple bifurcations
  const fbmShader = Fn(([p]) => {
    const n1 = valueNoise2D(p).sub(0.5);
    const rotP = vec2(p.x.mul(0.8).sub(p.y.mul(0.6)), p.x.mul(0.6).add(p.y.mul(0.8))).mul(2.07);
    const n2 = valueNoise2D(rotP).sub(0.5).mul(0.5);
    return n1.add(n2);
  });

  /**
   * Evaluates pure world-space wind ripple & micro-relief height at coordinate `xz`.
   * Uses strictly clamped polynomial wave shaping (no fractional `pow` calls that can produce NaN in WGSL)
   * and physically bounded wave amplitudes so surface normal derivatives stay natural and never smear.
   */
  const evalRippleWaveField = Fn(([xz]) => {
    // Smooth world-space domain warp so ripples curve naturally around topography
    const warpLarge = vec2(
      fbmShader(xz.mul(0.085)),
      fbmShader(xz.mul(0.085).add(vec2(31.7, 19.3)))
    ).mul(1.25);

    const wXZ = xz.add(warpLarge);
    const phaseWarp = fbmShader(wXZ.mul(0.32).add(vec2(11.4, 27.8))).mul(2.2);

    // 1. Megaripples (~1.85m wavelength, 3.4 rad/m) — clamped polynomial profile (NaN-proof in WGSL)
    const megaPhase = wXZ.x.mul(0.80).add(wXZ.y.mul(0.60)).mul(3.4).add(phaseWarp.mul(0.65));
    const megaSin = sin(megaPhase);
    const megaU = clamp(megaSin.add(sin(megaPhase.mul(2.0)).mul(0.24)).mul(0.42).add(0.5), 0.0, 1.0);
    const megaWave = megaU.mul(megaU).mul(float(1.35).sub(megaU.mul(0.35)));

    // 2. Primary wind-carved impact ripples (~0.68m wavelength, 9.2 rad/m) with Y-junction bifurcations
    const phaseA = wXZ.x.mul(0.82).add(wXZ.y.mul(0.57)).mul(9.2).add(phaseWarp);
    const phaseB = wXZ.x.mul(0.68).add(wXZ.y.mul(0.73)).mul(8.6).sub(phaseWarp.mul(0.75));
    const branchMask = smoothstep(-0.32, 0.32, fbmShader(wXZ.mul(0.24).add(vec2(43.0, 17.0))));

    // Asymmetric sharp crest wave profile via clamped polynomial sharpening
    const uA = clamp(sin(phaseA).add(sin(phaseA.mul(2.0)).mul(0.26)).mul(0.42).add(0.5), 0.0, 1.0);
    const uB = clamp(sin(phaseB).add(sin(phaseB.mul(2.0)).mul(0.26)).mul(0.42).add(0.5), 0.0, 1.0);
    const waveA = uA.mul(uA).mul(float(1.4).sub(uA.mul(0.4)));
    const waveB = uB.mul(uB).mul(float(1.4).sub(uB.mul(0.4)));
    const primaryWave = mix(waveA, waveB, branchMask);

    // 3. Meso-scale dune undulations (~4.6m wavelength, 1.35 rad/m) for mid-ground geological detail (40m–240m)
    const mesoPhase = wXZ.x.mul(0.78).add(wXZ.y.mul(0.62)).mul(1.35).add(phaseWarp.mul(0.35));
    const mesoU = clamp(sin(mesoPhase).mul(0.48).add(0.5), 0.0, 1.0);
    const mesoWave = mesoU.mul(mesoU).mul(float(1.3).sub(mesoU.mul(0.3)));

    return vec3(primaryWave, megaWave, mesoWave);
  });

  const evalFineSurfaceHeight = Fn(([xz, sandFactor, slipFactor, dist]) => {
    const primaryFade = float(1.0).sub(smoothstep(18.0, 58.0, dist));
    const megaFade = float(1.0).sub(smoothstep(35.0, 145.0, dist));
    const mesoFade = smoothstep(22.0, 60.0, dist).mul(float(1.0).sub(smoothstep(130.0, 260.0, dist)));
    const microFade = float(1.0).sub(smoothstep(3.0, 14.0, dist));
    const grainFade = float(1.0).sub(smoothstep(1.5, 9.0, dist));

    const waves = evalRippleWaveField(xz);
    const primaryRipple = waves.x.mul(0.11).mul(primaryFade);
    const megaRipple = waves.y.mul(0.10).mul(megaFade);
    const mesoRipple = waves.z.mul(0.035).mul(mesoFade);

    // 4. Secondary cross-wind micro-ripples (~0.22m wavelength) in primary ripple troughs at close range
    const microWarp = fbmShader(xz.mul(0.85)).mul(1.2);
    const microPhase = xz.x.mul(-0.45).add(xz.y.mul(0.89)).mul(26.0).add(microWarp);
    const microU = clamp(sin(microPhase).mul(0.5).add(0.5), 0.0, 1.0);
    const troughWeight = float(1.0).sub(waves.x.mul(0.75));
    const microRipple = microU.mul(microU).mul(0.016).mul(troughWeight).mul(microFade);

    // Suppress ripples on steep slopes & active avalanche slip-faces so ripples never stretch into vertical teeth
    const slopeSuppression = float(1.0).sub(smoothstep(0.12, 0.28, float(1.0).sub(normalWorld.y)));
    const rippleEnvelope = smoothstep(0.10, 0.48, sandFactor)
      .mul(float(1.0).sub(slipFactor.mul(0.78)))
      .mul(slopeSuppression);
    const sandRelief = primaryRipple.add(megaRipple).add(mesoRipple).add(microRipple).mul(rippleEnvelope);

    // Non-periodic multi-octave polygonal fracture & wind-scour relief on exposed bedrock (NO periodic sine waves!)
    const rockFade = float(1.0).sub(smoothstep(30.0, 140.0, dist));
    const fracture1 = float(1.0).sub(abs(fbmShader(xz.mul(0.65)).mul(2.0)));
    const fracture2 = float(1.0).sub(abs(fbmShader(xz.mul(2.1).add(vec2(8.3, 14.1))).mul(2.0)));
    const bedrockRelief = fracture1.mul(0.65).add(fracture2.mul(0.35)).mul(float(1.0).sub(sandFactor)).mul(0.12).mul(rockFade);

    // Close-up coarse sand grain micro-relief
    const grain = valueNoise2D(xz.mul(52.0)).sub(0.5).mul(0.008).mul(grainFade);

    return sandRelief.add(bedrockRelief).add(grain);
  });

  // Adaptive finite-difference normal perturbation
  material.normalNode = Fn(() => {
    const xz = positionWorld.xz;
    const vCol = vertexColor();
    const sandFactor = vCol.g;
    const slipFactor = vCol.b;

    const dist = cameraPosition.sub(positionWorld).length();
    const eps = mix(float(0.025), float(0.30), clamp(dist.div(110.0), 0.0, 1.0));

    const h0 = evalFineSurfaceHeight(xz, sandFactor, slipFactor, dist);
    const hx = evalFineSurfaceHeight(xz.add(vec2(eps, 0.0)), sandFactor, slipFactor, dist);
    const hz = evalFineSurfaceHeight(xz.add(vec2(0.0, eps)), sandFactor, slipFactor, dist);

    const dHdx = hx.sub(h0).div(eps);
    const dHdz = hz.sub(h0).div(eps);

    // Wave heights in evalFineSurfaceHeight are physically scaled (max |∇h| ~ 1.25), fading out at 250m
    const overallFade = float(1.0).sub(smoothstep(65.0, 250.0, dist));
    const bumpStrength = float(1.0).mul(overallFade);

    const perturbed = normalWorld.add(
      vec3(dHdx.negate().mul(bumpStrength), float(0.0), dHdz.negate().mul(bumpStrength))
    );
    return normalize(vec3(perturbed.x, max(perturbed.y, float(0.28)), perturbed.z));
  })();

  // Cohesive, realistic NASA Curiosity / Perseverance Martian palette (no camo contrast blotches!)
  const rustOchre = color(0xb35731);
  const burntTerracotta = color(0x994323);
  const dustyButterscotch = color(0xc97b4d);
  const basaltCharcoal = color(0x523428);
  const basaltUmber = color(0x6b4130);
  const bedrockBuff = color(0xb57952);
  const bedrockSienna = color(0x8c4f32);

  material.colorNode = Fn(() => {
    const xz = positionWorld.xz;
    const vCol = vertexColor();
    const ao = vCol.r;
    const sandFactor = vCol.g;
    const basaltFactor = vCol.b;
    const slipFactor = vCol.b;

    const dist = cameraPosition.sub(positionWorld).length();
    const closeGrainFade = float(1.0).sub(smoothstep(2.0, 11.0, dist));
    const closeRippleFade = float(1.0).sub(smoothstep(8.0, 35.0, dist));

    const macroPatch = valueNoise2D(xz.mul(0.012));
    const medPatch = valueNoise2D(xz.mul(0.065).add(vec2(5.2, 13.7)));
    const fineTex = valueNoise2D(xz.mul(1.4));
    const microGrain = valueNoise2D(xz.mul(38.0)).sub(0.5).mul(closeGrainFade);

    // Oxidized ferric sand base
    const oxidizedSand = mix(burntTerracotta, rustOchre, macroPatch.mul(0.65).add(medPatch.mul(0.35)));
    const dustySand = mix(oxidizedSand, dustyButterscotch, smoothstep(0.35, 0.85, macroPatch).mul(0.38));

    // Active dark basaltic sand sorting across dune flanks & slip faces
    const darkSandTone = mix(basaltUmber, basaltCharcoal, medPatch);
    const basaltBlend = smoothstep(0.25, 0.82, basaltFactor.add(medPatch.sub(0.5).mul(0.18)));
    const activeSandColor = mix(dustySand, darkSandTone, basaltBlend.mul(0.58));

    // Close-range ripple trough micro-AO & mid-range meso dust sorting (zero distant corduroy!)
    const waves = evalRippleWaveField(xz);
    const slopeSuppression = float(1.0).sub(smoothstep(0.12, 0.28, float(1.0).sub(normalWorld.y)));
    const rippleEnvelope = smoothstep(0.10, 0.48, sandFactor)
      .mul(float(1.0).sub(slipFactor.mul(0.78)))
      .mul(slopeSuppression);
    const mesoAlbedoFade = float(1.0).sub(smoothstep(50.0, 210.0, dist));
    const rippleCrest = waves.x.mul(closeRippleFade).add(waves.z.mul(0.35).mul(mesoAlbedoFade)).mul(rippleEnvelope);
    const rippleTroughAO = float(1.0).sub(float(1.0).sub(waves.x).mul(0.06).mul(rippleEnvelope).mul(closeRippleFade));
    const rippledSandColor = mix(activeSandColor, dustyButterscotch, rippleCrest.mul(0.08)).mul(rippleTroughAO);

    // Exposed bedrock color: horizontal strata variation gated STRICTLY by steep terrain slope AND low sandFactor
    // so sandy hills and gently sloping plains never get vertical or horizontal contour stripes!
    const slopeAmount = clamp(float(1.0).sub(normalWorld.y), 0.0, 1.0);
    const steepScarpMask = smoothstep(0.18, 0.38, slopeAmount).mul(float(1.0).sub(smoothstep(0.15, 0.45, sandFactor)));
    const strataNoise = fbmShader(vec2(positionWorld.y.mul(0.55), xz.x.add(xz.y).mul(0.04))).add(0.5);
    const bedrockFlatTone = mix(bedrockSienna, bedrockBuff, medPatch.mul(0.6).add(fineTex.mul(0.4)));
    const bedrockScarpTone = mix(bedrockSienna.mul(0.92), bedrockBuff.mul(1.04), clamp(strataNoise, 0.0, 1.0));
    const bedrockColor = mix(bedrockFlatTone, bedrockScarpTone, steepScarpMask);

    // Feathered transition between bedrock pavements and wind-blown sand sheets
    const windFeather = fbmShader(xz.mul(0.14)).mul(0.22);
    const rockToSand = smoothstep(0.15, 0.82, sandFactor.add(windFeather));
    const baseAlbedo = mix(bedrockColor, rippledSandColor, rockToSand);

    // Close-up granular regolith texture
    const grainFactor = float(1.0).add(fineTex.sub(0.5).mul(0.08)).add(microGrain.mul(0.12));

    // Analytic distant self-shadowing beyond the shadow map frustum
    const distShadowFade = smoothstep(130.0, 185.0, dist);
    const nDotL = dot(normalWorld, sunDirUniform);
    const analyticShadow = mix(float(1.0), smoothstep(-0.08, 0.22, nDotL).mul(0.68).add(0.32), distShadowFade);

    const cavityDark = color(0x38190f);
    return mix(cavityDark, baseAlbedo.mul(grainFactor), ao).mul(analyticShadow);
  })();

  // POST-LIGHTING Atmospheric Aerial Perspective via outputNode
  material.outputNode = Fn(() => {
    const toSurface = positionWorld.sub(cameraPosition);
    const dist = toSurface.length();
    const viewDir = normalize(toSurface);

    const heightFactor = clamp(float(1.0).sub(positionWorld.y.add(10.0).div(65.0)), 0.0, 1.0);
    const distFog = smoothstep(55.0, 640.0, dist);
    const fogFactor = clamp(distFog.mul(float(0.74).add(heightFactor.mul(0.26))), 0.0, 0.93);

    const skyRad = evalMarsAtmosphereRadiance(
      viewDir,
      sunDirUniform,
      fogHorizonColorUniform,
      fogZenithColorUniform,
      false
    );

    const finalRGB = mix(output.rgb, skyRad, fogFactor);
    return vec4(finalRGB, output.a);
  })();

  material.roughnessNode = Fn(() => {
    const vCol = vertexColor();
    return mix(float(0.87), float(0.95), vCol.g);
  })();

  material.metalnessNode = float(0.0);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = true;

  return mesh;
}
