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
  fract,
  floor,
  dot,
  normalize,
  max,
  positionWorld,
  normalWorld,
  cameraPosition,
} from 'three/tsl';

/**
 * Shared TSL helper: evaluates exact Martian atmospheric sky / aerial perspective radiance
 * along any world-space view direction `viewDir` (unit vector from camera toward pixel).
 */
export function evalMarsAtmosphereRadiance(viewDir, sunDirUniform, fogHorizonColorUniform, fogZenithColorUniform, includeSolarDisc = true) {
  const elevation = clamp(viewDir.y, 0.0, 1.0);

  // Vertical dust aerosol gradient: luminous salmon-butterscotch horizon -> warm rust-sienna zenith
  const verticalCurve = pow(elevation, 0.55);
  const skyBase = mix(fogHorizonColorUniform, fogZenithColorUniform, verticalCurve);

  // Horizon dust belt intensification
  const horizonBelt = pow(float(1.0).sub(elevation), 4.5);
  const skyWithBelt = mix(skyBase, fogHorizonColorUniform.mul(1.06), horizonBelt.mul(0.5));

  // Forward Mie scattering phase function from suspended ~1.5 micron iron-oxide dust aerosols
  const cosTheta = max(dot(viewDir, sunDirUniform), 0.0);
  const outerHalo = pow(cosTheta, 7.0).mul(0.28);
  const innerAureole = pow(cosTheta, 64.0).mul(0.36);

  const haloColor = color(0xffc89b);
  const aureoleColor = color(0xffe8d6);

  let finalRad = skyWithBelt
    .add(haloColor.mul(outerHalo))
    .add(aureoleColor.mul(innerAureole));

  if (includeSolarDisc) {
    // Authentic small Martian solar disc (~0.35 deg angular diameter)
    const sunDisc = smoothstep(0.99994, 0.999985, cosTheta).mul(5.5);
    const discColor = color(0xfff9f0);
    finalRad = finalRad.add(discColor.mul(sunDisc));
  }

  return finalRad;
}

/**
 * Procedural Martian Atmosphere Sky Dome
 */
export function createMarsSky(sunDirUniform, fogHorizonColorUniform, fogZenithColorUniform) {
  const skyGeo = new THREE.SphereGeometry(1800, 96, 64);
  const skyMat = new THREE.MeshBasicNodeMaterial();
  skyMat.side = THREE.BackSide;
  skyMat.depthWrite = false;

  skyMat.colorNode = Fn(() => {
    const viewDir = normalize(positionWorld.sub(cameraPosition));
    return evalMarsAtmosphereRadiance(viewDir, sunDirUniform, fogHorizonColorUniform, fogZenithColorUniform, true);
  })();

  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.frustumCulled = false;
  return skyMesh;
}
