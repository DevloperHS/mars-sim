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
  fract,
  floor,
  dot,
  normalize,
  max,
  output,
  positionWorld,
  normalWorld,
  cameraPosition,
} from 'three/tsl';
import { createRNG, noise3D, sampleDuneSurfaceInfo } from './noise.js';
import { evalDuneAtmosphereRadiance } from './sky.js';

/**
 * Sculpt an indexed, angular wind-faceted Dune ventifact or stratified mudstone block.
 * Uses plane-clipping + ridged 3D noise on an indexed SphereGeometry so rocks have
 * crisp angular geological faces with smooth vertex normals across shared vertices.
 */
function createSculptedRockGeometry(seedOffset, widthSegs = 28, heightSegs = 20, flatness = 0.62) {
  const rng = createRNG(Math.floor(seedOffset * 1000) + 17);
  const geo = new THREE.SphereGeometry(1.0, widthSegs, heightSegs);
  const pos = geo.attributes.position;

  // Generate 9 deterministic fracture planes to carve crisp angular ventifact / cleavage faces
  const planes = [];
  for (let p = 0; p < 9; p++) {
    const theta = rng() * Math.PI * 2.0;
    const phi = Math.acos(2.0 * rng() - 1.0);
    const px = Math.sin(phi) * Math.cos(theta);
    const py = Math.cos(phi);
    const pz = Math.sin(phi) * Math.sin(theta);
    const dist = 0.44 + rng() * 0.18;
    planes.push({ nx: px, ny: py, nz: pz, d: dist });
  }

  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);

    const len = Math.hypot(vx, vy, vz) || 1.0;
    const nx = vx / len;
    const ny = vy / len;
    const nz = vz / len;

    // 3D noise for natural fracture irregularity
    const n1 = noise3D(nx * 1.35 + seedOffset, ny * 1.35 - seedOffset, nz * 1.35 + seedOffset * 0.5);
    const n2 = noise3D(nx * 2.8 - seedOffset * 1.3, ny * 2.8 + seedOffset, nz * 2.8);

    let r = 0.84 + n1 * 0.16 + (1.0 - Math.abs(n2)) * 0.10;

    // Crisp bevel-clip radius against fracture planes for angular Dune ventifact morphology
    for (let p = 0; p < planes.length; p++) {
      const pl = planes[p];
      const proj = nx * pl.nx + ny * pl.ny + nz * pl.nz;
      if (proj > 0.12) {
        const planeR = pl.d / proj;
        // Tight bevel (0.06) so fracture planes carve flat angular faces and crisp geological edges
        const diff = r - planeR;
        if (diff > -0.03) {
          const t = Math.max(0.0, Math.min(1.0, (diff + 0.03) / 0.06));
          r = r - t * t * (3.0 - 2.0 * t) * Math.max(0.0, diff);
        }
      }
    }

    let px = nx * r * 1.15;
    let py = ny * r * flatness;
    let pz = nz * r * 0.95;

    // Taper lower root downward so rocks stay firmly anchored in sloped sand
    if (ny < -0.15) {
      const rootFactor = Math.min(1.0, (-ny - 0.15) / 0.85);
      const horizontalTaper = 1.0 - rootFactor * 0.18;
      px *= horizontalTaper;
      pz *= horizontalTaper;
      py -= rootFactor * 0.22 * flatness;
    }

    pos.setXYZ(i, px, py, pz);
  }

  geo.computeVertexNormals();
  return geo;
}

/**
 * Generates geologically clustered Dune boulders, fractured bedrock slabs, and cobble lag
 * concentrated in interdune troughs, bedrock pavements, and rocky talus aprons.
 */
export function createDuneRocks(sunDirUniform, fogHorizonColorUniform, fogZenithColorUniform) {
  const rng = createRNG(90210);
  const group = new THREE.Group();

  const rockMaterial = new THREE.MeshStandardNodeMaterial();

  const hash2D = Fn(([p]) => {
    return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
  });

  const valueNoise2D = Fn(([p]) => {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
    return mix(
      mix(hash2D(i), hash2D(i.add(vec2(1.0, 0.0))), u.x),
      mix(hash2D(i.add(vec2(0.0, 1.0))), hash2D(i.add(vec2(1.0, 1.0))), u.x),
      u.y
    );
  });

  // Subtle, physically calibrated per-fragment micro-normal relief for weathered stone
  // (strength = 0.016 so derivative * strength ~ 0.35, preventing "brain-coral" normal flipping!)
  rockMaterial.normalNode = Fn(() => {
    const xz = positionWorld.xz;
    const dist = cameraPosition.sub(positionWorld).length();
    const fade = float(1.0).sub(smoothstep(8.0, 65.0, dist));

    const eps = float(0.025);
    const h0 = valueNoise2D(xz.mul(10.0)).mul(0.7).add(valueNoise2D(xz.mul(28.0)).mul(0.3));
    const hx = valueNoise2D(xz.add(vec2(eps, 0.0)).mul(10.0)).mul(0.7).add(valueNoise2D(xz.add(vec2(eps, 0.0)).mul(28.0)).mul(0.3));
    const hz = valueNoise2D(xz.add(vec2(0.0, eps)).mul(10.0)).mul(0.7).add(valueNoise2D(xz.add(vec2(0.0, eps)).mul(28.0)).mul(0.3));

    const dHdx = hx.sub(h0).div(eps);
    const dHdz = hz.sub(h0).div(eps);
    const strength = float(0.026).mul(fade);

    return normalize(
      normalWorld.add(vec3(dHdx.negate().mul(strength), float(0.0), dHdz.negate().mul(strength)))
    );
  })();

  // Cohesive Dune basalt & oxidized mudstone rock palette (no spotted leopard/sponge contrast!)
  const darkBasalt = color(0x4d3429);      // Weathered dark grey-brown Dune basalt
  const weatheredRind = color(0x754530);   // Oxidized iron-bearing rock rind
  const settledDust = color(0xb5673f);     // Fine ferric dust coat on upward-facing facets

  rockMaterial.colorNode = Fn(() => {
    const xz = positionWorld.xz;
    const n1 = valueNoise2D(xz.mul(1.6));
    const n2 = valueNoise2D(xz.mul(6.5));

    const baseRock = mix(darkBasalt, weatheredRind, n1.mul(0.7).add(n2.mul(0.3)));

    // Smooth dust accumulation on upward-facing facets
    const topDustMask = smoothstep(0.42, 0.90, normalWorld.y.add(n1.sub(0.5).mul(0.15)));
    return mix(baseRock, settledDust, topDustMask.mul(0.58));
  })();

  // Match terrain's post-lighting atmospheric aerial perspective
  rockMaterial.outputNode = Fn(() => {
    const toSurface = positionWorld.sub(cameraPosition);
    const dist = toSurface.length();
    const viewDir = normalize(toSurface);

    const heightFactor = clamp(float(1.0).sub(positionWorld.y.add(10.0).div(65.0)), 0.0, 1.0);
    const distFog = smoothstep(55.0, 640.0, dist);
    const fogFactor = clamp(distFog.mul(float(0.74).add(heightFactor.mul(0.26))), 0.0, 0.93);

    const skyRad = evalDuneAtmosphereRadiance(
      viewDir,
      sunDirUniform,
      fogHorizonColorUniform,
      fogZenithColorUniform,
      false
    );

    return vec4(mix(output.rgb, skyRad, fogFactor), output.a);
  })();

  rockMaterial.roughnessNode = float(0.90);
  rockMaterial.metalnessNode = float(0.02);

  // Pre-generate 65 geological outcrop / float cluster centers in interdune troughs & rocky benches
  const clusterCenters = [];
  let cAttempts = 0;
  while (clusterCenters.length < 65 && cAttempts < 500) {
    cAttempts++;
    const radialBias = Math.pow(rng(), 1.3);
    const radius = 5.0 + radialBias * 220.0;
    const theta = rng() * Math.PI * 2.0;
    const cx = Math.cos(theta) * radius;
    const cz = Math.sin(theta) * radius;

    const info = sampleDuneSurfaceInfo(cx, cz, 0.5);
    if (info.activeSandCover > 0.85 && rng() > 0.22) continue;
    clusterCenters.push({ x: cx, z: cz, spread: 3.5 + rng() * 9.5 });
  }

  const archetypes = [
    { geo: createSculptedRockGeometry(1.7, 28, 20, 0.68), count: 260, minScale: 0.26, maxScale: 1.35, castShadow: true },
    { geo: createSculptedRockGeometry(5.3, 28, 20, 0.38), count: 360, minScale: 0.32, maxScale: 1.75, castShadow: true },
    { geo: createSculptedRockGeometry(9.8, 18, 14, 0.58), count: 1300, minScale: 0.07, maxScale: 0.28, castShadow: false },
  ];

  const dummy = new THREE.Object3D();
  const upVec = new THREE.Vector3(0, 1, 0);
  const surfaceNormal = new THREE.Vector3();
  const alignQuat = new THREE.Quaternion();
  const yawQuat = new THREE.Quaternion();

  for (let aIdx = 0; aIdx < archetypes.length; aIdx++) {
    const arch = archetypes[aIdx];
    const instMesh = new THREE.InstancedMesh(arch.geo, rockMaterial, arch.count);
    instMesh.castShadow = arch.castShadow;
    instMesh.receiveShadow = true;

    let placed = 0;
    let attempts = 0;
    while (placed < arch.count && attempts < arch.count * 8) {
      attempts++;

      let x, z;
      if (rng() < 0.82 && clusterCenters.length > 0) {
        const c = clusterCenters[Math.floor(rng() * clusterCenters.length)];
        const spreadMult = aIdx === 2 ? 1.45 : 0.75;
        const r = Math.pow(rng(), 0.85) * c.spread * spreadMult;
        const ang = rng() * Math.PI * 2.0;
        x = c.x + Math.cos(ang) * r;
        z = c.z + Math.sin(ang) * r;
      } else {
        const radialBias = Math.pow(rng(), 1.45);
        const radius = 4.0 + radialBias * 240.0;
        const theta = rng() * Math.PI * 2.0;
        x = Math.cos(theta) * radius;
        z = Math.sin(theta) * radius;
      }

      const info = sampleDuneSurfaceInfo(x, z, 0.45);

      if (info.slipFaceFactor > 0.35 && aIdx < 2) continue;
      if (info.curvature > 0.12 && rng() > 0.15) continue;

      const s = arch.minScale + Math.pow(rng(), 2.3) * (arch.maxScale - arch.minScale);
      const sx = s * (0.82 + rng() * 0.42);
      const sy = s * (0.65 + rng() * 0.48);
      const sz = s * (0.82 + rng() * 0.42);

      surfaceNormal.set(info.nx, info.ny, info.nz).normalize();
      alignQuat.setFromUnitVectors(upVec, surfaceNormal);
      yawQuat.setFromEuler(
        new THREE.Euler(
          (rng() - 0.5) * 0.16,
          rng() * Math.PI * 2.0,
          (rng() - 0.5) * 0.16
        )
      );
      dummy.quaternion.copy(alignQuat).multiply(yawQuat);

      const maxHorizRadius = Math.max(sx, sz);
      const embedDepth = sy * 0.32 + info.slope * maxHorizRadius * 0.55;
      dummy.position.set(x, info.height - embedDepth, z);

      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();

      instMesh.setMatrixAt(placed, dummy.matrix);
      placed++;
    }

    instMesh.count = placed;
    instMesh.instanceMatrix.needsUpdate = true;
    group.add(instMesh);
  }

  return group;
}
