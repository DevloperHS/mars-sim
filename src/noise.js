/**
 * Deterministic 2D & 3D Simplex / Value-Gradient Noise and Dune Terrain Math
 * Everything generated in code - zero external assets.
 */

export function createRNG(seed = 1337) {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const perm = new Uint8Array(512);
const grad2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

(function initPerm() {
  const rng = createRNG(42069);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
})();

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + t * (b - a);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0.0, Math.min(1.0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3.0 - 2.0 * t);
}

// Polynomial smooth minimum for C1-continuous dune brink & basal apron transitions
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0.0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// Polynomial smooth maximum
function smax(a, b, k) {
  return -smin(-a, -b, k);
}

/**
 * 2D Perlin/Gradient noise in [-1, 1]
 */
export function noise2D(x, y) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);

  const aa = perm[perm[X] + Y] & 7;
  const ab = perm[perm[X] + Y + 1] & 7;
  const ba = perm[perm[X + 1] + Y] & 7;
  const bb = perm[perm[X + 1] + Y + 1] & 7;

  const gAA = grad2[aa][0] * xf + grad2[aa][1] * yf;
  const gBA = grad2[ba][0] * (xf - 1) + grad2[ba][1] * yf;
  const gAB = grad2[ab][0] * xf + grad2[ab][1] * (yf - 1);
  const gBB = grad2[bb][0] * (xf - 1) + grad2[bb][1] * (yf - 1);

  const x1 = lerp(gAA, gBA, u);
  const x2 = lerp(gAB, gBB, u);
  return lerp(x1, x2, v);
}

/**
 * 3D Gradient noise in [-1, 1] for rock sculpting
 */
export function noise3D(x, y, z) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const Z = Math.floor(z) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const zf = z - Math.floor(z);
  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);

  const A = perm[X] + Y;
  const AA = perm[A] + Z;
  const AB = perm[A + 1] + Z;
  const B = perm[X + 1] + Y;
  const BA = perm[B] + Z;
  const BB = perm[B + 1] + Z;

  const grad3 = (hash, dx, dy, dz) => {
    const h = hash & 15;
    const gu = h < 8 ? dx : dy;
    const gv = h < 4 ? dy : h === 12 || h === 14 ? dx : dz;
    return ((h & 1) === 0 ? gu : -gu) + ((h & 2) === 0 ? gv : -gv);
  };

  return lerp(
    lerp(
      lerp(grad3(perm[AA], xf, yf, zf), grad3(perm[BA], xf - 1, yf, zf), u),
      lerp(grad3(perm[AB], xf, yf - 1, zf), grad3(perm[BB], xf - 1, yf - 1, zf), u),
      v
    ),
    lerp(
      lerp(grad3(perm[AA + 1], xf, yf, zf - 1), grad3(perm[BA + 1], xf - 1, yf, zf - 1), u),
      lerp(grad3(perm[AB + 1], xf, yf - 1, zf - 1), grad3(perm[BB + 1], xf - 1, yf - 1, zf - 1), u),
      v
    ),
    w
  );
}

/**
 * Fractal Brownian Motion (2D)
 */
export function fbm2D(x, y, octaves = 5, lacunarity = 2.03, gain = 0.5) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  const c = 0.8660254;
  const s = 0.5;
  let px = x;
  let py = y;

  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2D(px * freq, py * freq);
    const nx = c * px - s * py;
    const ny = s * px + c * py;
    px = nx;
    py = ny;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum;
}

/**
 * Soft-peaked Ridged Multifractal 2D (avoids razor-needle spikes)
 */
export function ridged2D(x, y, octaves = 4, lacunarity = 2.05, gain = 0.48) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  let weight = 1.0;
  let px = x;
  let py = y;

  for (let i = 0; i < octaves; i++) {
    const raw = noise2D(px * freq, py * freq);
    let n = 1.0 - Math.sqrt(raw * raw + 0.02);
    n = Math.max(0.0, n);
    n = n * weight;
    weight = Math.max(0.15, Math.min(1.0, n * 1.35));
    sum += n * amp;
    const nx = 0.8 * px - 0.6 * py;
    const ny = 0.6 * px + 0.8 * py;
    px = nx;
    py = ny;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum;
}

/**
 * C1-Continuous Asymmetric Barchan / Transverse Dune Profile:
 * Uses polynomial smooth-min (smin) and smooth-max (smax) to blend the windward ramp,
 * crest brink, planar leeward slip-face, and interdune floor with a mesh-resolvable rounding radius
 * (~3.5m across the 560x560 grid) so there are zero sawtooth polygon kinks or Laplacian spikes.
 */
export function evaluateBarchanDune(phase) {
  const p = phase - Math.floor(phase);
  const floorEnd = 0.10;
  const brink = 0.68;
  const slipEnd = 0.98;

  // Windward rise from floorEnd to brink (extended past brink so smin rounds the brink smoothly)
  const tWind = Math.max(0.0, (p - floorEnd) / (brink - floorEnd));
  const windwardCurve = 0.45 * tWind + 0.62 * (tWind * tWind);

  // Leeward avalanche slip-face drop from brink to slipEnd
  const tSlip = (p - brink) / (slipEnd - brink);
  const slipLine = 1.04 - 1.08 * tSlip;

  // Round the brink across k = 0.18 (~5m width on the mesh) for a crisp, alias-free crest
  const arch = smin(windwardCurve, slipLine, 0.18);

  // Smoothly meet the interdune floor at y = 0 across k = 0.12
  const h = Math.max(0.0, smax(0.0, arch, 0.12));

  const isSlipFace = smoothstep(brink - 0.02, brink + 0.05, p) * (1.0 - smoothstep(slipEnd - 0.06, slipEnd, p));
  const duneMask = smoothstep(floorEnd - 0.04, floorEnd + 0.16, p) * (1.0 - smoothstep(slipEnd - 0.06, slipEnd + 0.02, p));

  return { height: h, isSlipFace, duneMask };
}

/**
 * Evaluate full geological breakdown at world coordinates (x, z)
 */
export function sampleDuneGeology(x, z) {
  // 1. Domain warp for organic barchanoid crescent curvature
  const warpX = fbm2D(x * 0.0022 + 3.1, z * 0.0022 - 1.7, 3);
  const warpZ = fbm2D(x * 0.0022 - 5.4, z * 0.0022 + 4.2, 3);

  const wx = x + warpX * 48.0;
  const wz = z + warpZ * 44.0;

  // 2. Primary Bagnold Barchanoid Dune Train
  const windCoord = (wx * 0.82 + wz * 0.57) * 0.0112;
  const crossCoord = (-wx * 0.57 + wz * 0.82) * 0.0082;

  const crestSinuosity =
    Math.sin(crossCoord * 3.0 + warpX * 2.1) * 0.35 +
    noise2D(wx * 0.0058, wz * 0.0058) * 0.40;

  const d1 = evaluateBarchanDune(windCoord + crestSinuosity);

  // Secondary oblique dune lobes
  const secCoord = (wx * 0.42 - wz * 0.91) * 0.0135 + warpZ * 0.6;
  const d2 = evaluateBarchanDune(secCoord);

  // Regional sand supply envelope (keeps foreground dune field well-supplied with sand)
  const duneEnvelope = Math.max(
    0.35,
    0.68 + 0.32 * Math.sin(x * 0.0040 - z * 0.0030 + warpX * 1.2)
  );

  const rawDuneHeight = (d1.height * 11.5 + d2.height * 3.5) * duneEnvelope;

  // Regional bedrock exposure mask: exposes coherent Murray/Stimson bedrock pavements only in
  // low interdune troughs where regional bedrock noise is high, keeping sandy sheets continuous
  // without abrupt elevation jumps or blister-mounds
  const regionalBedrockPatch = fbm2D(x * 0.009 + 5.2, z * 0.009 - 8.4, 3);
  const interduneFloor = (1.0 - d1.duneMask) * (1.0 - d2.duneMask * 0.6);
  const bedrockExposure = smoothstep(0.08, 0.85, interduneFloor * (0.50 + regionalBedrockPatch * 0.60));
  const activeSandCover = 1.0 - bedrockExposure;

  const slipFaceFactor = Math.min(1.0, d1.isSlipFace + d2.isSlipFace * 0.45);

  // 3. Eroded Murray/Stimson Bedrock Outcrops & Low-Relief Benches
  // Kept independent of narrow bedrockExposure steps so interdune bedrock forms realistic low-relief pavements
  const rawBedrock = fbm2D(x * 0.0062 - 12.0, z * 0.0062 + 19.0, 4);
  const bedrockTerraces = rawBedrock * 2.2;

  // Medium wind-scoured yardang ridges (smooth regional relief)
  const yardangRidges = ridged2D(wx * 0.014 + 11.0, wz * 0.014 - 7.0, 4) * 1.65;

  // Subtle low-relief outcrop texture in bedrock zones
  const mesoOutcrop = ridged2D(x * 0.024 - 4.5, z * 0.024 + 8.1, 3) * 0.32 * bedrockExposure;

  // 4. Distant Gale Crater Rim & Mount Sharp (Aeolis Mons) Stratified Mesas / Buttes
  const distFromCenter = Math.hypot(x, z);
  const rimStart = smoothstep(185.0, 520.0, distFromCenter);

  const angle = Math.atan2(z, x);
  const mountainSector =
    0.58 +
    0.32 * Math.cos(angle + 2.15) +
    0.22 * Math.sin(angle * 2.0 - 0.85);

  const broadMass = 0.5 + 0.5 * fbm2D(x * 0.0021 + 17.0, z * 0.0021 - 9.0, 4);
  const ridgeShoulders = ridged2D(x * 0.0026 + 31.0, z * 0.0026 - 14.0, 3);
  let mesaProfile = broadMass * 0.65 + ridgeShoulders * 0.35;

  // Smooth plateau capping (no sharp corner or periodic sine rings)
  mesaProfile = smin(mesaProfile, 0.64, 0.12);
  const gulleyErosion = ridged2D(x * 0.0075, z * 0.0075, 3) * 0.075;

  const distantMountains =
    rimStart *
    Math.max(0.15, mountainSector) *
    (mesaProfile + gulleyErosion) *
    64.0;

  const height = rawDuneHeight + bedrockTerraces + yardangRidges + mesoOutcrop + distantMountains - 7.5;

  return {
    height,
    activeSandCover,
    slipFaceFactor,
    bedrockMask: bedrockExposure,
    rimStart,
  };
}

/**
 * Master Dune Elevation Function
 */
export function sampleDuneElevation(x, z) {
  return sampleDuneGeology(x, z).height;
}

/**
 * Compute analytical/finite-difference surface normal, slope, curvature, and geology at (x, z)
 */
export function sampleDuneSurfaceInfo(x, z, eps = 0.45) {
  const geoC = sampleDuneGeology(x, z);
  const hC = geoC.height;
  const hR = sampleDuneElevation(x + eps, z);
  const hL = sampleDuneElevation(x - eps, z);
  const hF = sampleDuneElevation(x, z + eps);
  const hB = sampleDuneElevation(x, z - eps);

  const dx = (hR - hL) / (2.0 * eps);
  const dz = (hF - hB) / (2.0 * eps);

  const invLen = 1.0 / Math.hypot(dx, 1.0, dz);
  const nx = -dx * invLen;
  const ny = 1.0 * invLen;
  const nz = -dz * invLen;

  const laplacian = (hR + hL + hF + hB - 4.0 * hC) / (eps * eps);

  return {
    height: hC,
    nx,
    ny,
    nz,
    slope: 1.0 - ny,
    curvature: laplacian,
    activeSandCover: geoC.activeSandCover,
    slipFaceFactor: geoC.slipFaceFactor,
    bedrockMask: geoC.bedrockMask,
  };
}
