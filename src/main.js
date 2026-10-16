import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createMarsTerrain } from './terrain.js';
import { createMarsRocks } from './rocks.js';
import { createMarsSky } from './sky.js';
import { sampleMarsElevation } from './noise.js';

/**
 * Build the 6 fixed camera presets so each angle frames authentic Martian geological features:
 * barchanoid dunes, wind-carved ripples, rocky interdune pavements, and distant stratified mesas.
 */
function buildCameraPresets() {
  // 1. Wide establishing view: overlooking sweeping barchan dunes, rocky interdune troughs, and distant mountains
  const widePos = { x: -38, z: 54 };
  const wideH = sampleMarsElevation(widePos.x, widePos.z);

  // 2. Low-angle dune view: dramatic low rover-mast perspective looking across wind-rippled sand and rocks up a barchan dune crest
  const lowPos = { x: -24, z: 38 };
  const lowH = sampleMarsElevation(lowPos.x, lowPos.z);
  const lowTargetH = sampleMarsElevation(10, -6);

  // 3. Close-up of wind ripples: 1.15m above sweeping wind-carved sand ripples & megaripples
  const ripplePos = { x: -18, z: 32 };
  const rippleH = sampleMarsElevation(ripplePos.x, ripplePos.z);
  const rippleTargetH = sampleMarsElevation(8, 12);

  // 4. Side-lit ridge view: grazing angle across sharp wind-carved dune crests and eroded outcrops
  const ridgePos = { x: 34, z: 28 };
  const ridgeH = sampleMarsElevation(ridgePos.x, ridgePos.z);
  const ridgeTargetH = sampleMarsElevation(-8, -18);

  // 5. Elevated terrain view: high reconnaissance vantage overlooking multi-scale dune trains & bedrock pavements
  const elevPos = { x: -58, z: 62 };
  const elevLocalMaxH = Math.max(
    sampleMarsElevation(elevPos.x, elevPos.z),
    sampleMarsElevation(-35, 35),
    sampleMarsElevation(-15, 10)
  );

  // 6. Distant horizon view: framing foreground ridges fading into dusty salmon sky and Mount Sharp-like mesas
  const horPos = { x: 20, z: 45 };
  const horH = sampleMarsElevation(horPos.x, horPos.z);
  const horTargetH = sampleMarsElevation(-140, -180);

  return {
    wide: {
      code: '1:WIDE',
      name: 'Wide Establishing View',
      position: new THREE.Vector3(widePos.x, wideH + 13.5, widePos.z),
      target: new THREE.Vector3(18, sampleMarsElevation(18, -24) + 1.5, -24),
      insight: 'WIDE PANORAMA OF BAGNOLD BARCHANOID DUNES. IRON-OXIDE DUST COATS WINDWARD SLOPES; MAFIC BASALT GRAINS COLLECT ON LEE SLIP-FACES.',
    },
    low_dune: {
      code: '2:DUNE',
      name: 'Low-Angle Dune View',
      position: new THREE.Vector3(lowPos.x, lowH + 1.65, lowPos.z),
      target: new THREE.Vector3(10, lowTargetH + 1.8, -6),
      insight: 'ROVER MAST PERSPECTIVE (+1.65M). BARCHAN CREST SEPARATES RIPPLED WINDWARD RAMP FROM 31 DEG AVALANCHE SLIP-FACE.',
    },
    ripples: {
      code: '3:RIPPLES',
      name: 'Close-Up Wind Ripples',
      position: new THREE.Vector3(ripplePos.x, rippleH + 1.15, ripplePos.z),
      target: new THREE.Vector3(8, rippleTargetH + 0.6, 12),
      insight: 'CLOSE-RANGE IMPACT RIPPLES (0.68M WAVELENGTH) WITH Y-JUNCTION BIFURCATIONS AND SECONDARY 0.22M CROSS-RIPPLES.',
    },
    ridge: {
      code: '4:RIDGE',
      name: 'Side-Lit Ridge View',
      position: new THREE.Vector3(ridgePos.x, ridgeH + 6.2, ridgePos.z),
      target: new THREE.Vector3(-8, ridgeTargetH + 1.2, -18),
      insight: 'CROSS-LIT RIDGE GEOMETRY HIGHLIGHTING WIND-SCOURED YARDANGS, FRACTURED BEDROCK OUTCROPS, AND DIRECTIONAL RELIEF SHADOWS.',
    },
    elevated: {
      code: '5:ELEVATED',
      name: 'Elevated Terrain View',
      position: new THREE.Vector3(elevPos.x, elevLocalMaxH + 38.0, elevPos.z),
      target: new THREE.Vector3(12, sampleMarsElevation(12, -16) - 2.0, -16),
      insight: 'INGENUITY RECONNAISSANCE VANTAGE (+38M) SHOWING DUNE SINUOSITY, INTERDUNE BEDROCK PAVEMENTS, AND VENTIFACT FLOAT CLUSTERS.',
    },
    horizon: {
      code: '6:HORIZON',
      name: 'Distant Horizon View',
      position: new THREE.Vector3(horPos.x, horH + 5.2, horPos.z),
      target: new THREE.Vector3(-140, horTargetH + 14.0, -180),
      insight: 'DISTANT GALE CRATER RIM MESAS FADING INTO SUSPENDED FERRIC AEROSOL HAZE VIA OPTICAL DEPTH AND FORWARD MIE SCATTERING.',
    },
  };
}

async function initMarsSim() {
  const container = document.getElementById('canvas-container');
  const rendererBadge = document.getElementById('renderer-badge');
  const roverHud = document.getElementById('rover-hud');
  const loadingScreen = document.getElementById('loading-screen');
  const loadingBarFill = document.getElementById('loading-bar-fill');
  const loadingPercent = document.getElementById('loading-percent');
  const loadingStage = document.getElementById('loading-stage');
  const loadingStep = document.getElementById('loading-step');

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  async function updateLoadingProgress(pct, stageText, stepText) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    if (loadingBarFill) loadingBarFill.style.width = `${clamped}%`;
    if (loadingPercent) loadingPercent.textContent = `${String(clamped).padStart(3, '0')}%`;
    if (loadingStage && stageText) loadingStage.textContent = stageText;
    if (loadingStep && stepText) loadingStep.textContent = stepText;
    await nextFrame();
  }

  await updateLoadingProgress(12, 'INITIALIZING WEBGPU / WEGL2 RENDER PIPELINE...', 'STEP 01/05');

  // Scene & Camera
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.2, 2400);

  // Initialize Three.js WebGPURenderer (automatically falls back to WebGL2 backend when WebGPU is unavailable)
  let renderer;
  let backendName = 'WebGPU';

  try {
    renderer = new THREE.WebGPURenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    await renderer.init();

    const isWebGPU = Boolean(renderer.backend && renderer.backend.isWebGPUBackend);
    backendName = isWebGPU ? 'WebGPU' : 'WebGL2 Fallback';
  } catch (err) {
    console.warn('WebGPURenderer init encountered an error, retrying with forceWebGL:', err);
    renderer = new THREE.WebGPURenderer({
      antialias: true,
      forceWebGL: true,
    });
    await renderer.init();
    backendName = 'WebGL Fallback';
  }

  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  container.appendChild(renderer.domElement);
  if (rendererBadge) {
    rendererBadge.textContent = backendName.toUpperCase();
  }

  await updateLoadingProgress(32, 'SYNTHESIZING MIE AEROSOL SKY & SOLAR OPTICS...', 'STEP 02/05');

  // Shared TSL Uniforms for Sun & Atmospheric Haze
  const sunDirUniform = uniform(new THREE.Vector3(0.75, 0.4, -0.52).normalize());
  const fogHorizonColorUniform = uniform(new THREE.Color(0xdba07c)); // Dusty salmon-butterscotch horizon
  const fogZenithColorUniform = uniform(new THREE.Color(0x8c472b));  // Deeper rust-sienna zenith

  // Directional Sunlight with Dynamic Shadow Map (calibrated normalBias to prevent grazing-angle slope acne)
  const sunLight = new THREE.DirectionalLight(0xffe6cc, 3.1);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 2048;
  sunLight.shadow.mapSize.height = 2048;
  const shadowExtent = 165;
  sunLight.shadow.camera.left = -shadowExtent;
  sunLight.shadow.camera.right = shadowExtent;
  sunLight.shadow.camera.top = shadowExtent;
  sunLight.shadow.camera.bottom = -shadowExtent;
  sunLight.shadow.camera.near = 5;
  sunLight.shadow.camera.far = 480;
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.048;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // Diffuse Martian Sky/Ground Hemisphere Fill Light (warm salmon sky + dark rust bounce)
  const hemiLight = new THREE.HemisphereLight(0xe5a582, 0x592616, 0.85);
  scene.add(hemiLight);

  // Subtle counter-bounce directional fill so deep shadow troughs still reveal granular normal detail
  const bounceLight = new THREE.DirectionalLight(0xc8744b, 0.38);
  bounceLight.position.set(-80, 45, 90);
  scene.add(bounceLight);

  // Build Procedural Sky, Terrain, and Rocks
  const skyMesh = createMarsSky(sunDirUniform, fogHorizonColorUniform, fogZenithColorUniform);
  scene.add(skyMesh);

  await updateLoadingProgress(58, 'GENERATING 560X560 BARCHAN DUNE & RIPPLE MESH...', 'STEP 03/05');

  const terrainMesh = createMarsTerrain(sunDirUniform, fogHorizonColorUniform, fogZenithColorUniform);
  scene.add(terrainMesh);

  await updateLoadingProgress(82, 'SCULPTING 1,920 FRACTURED BASALT VENTIFACTS...', 'STEP 04/05');

  const rocksGroup = createMarsRocks(sunDirUniform, fogHorizonColorUniform, fogZenithColorUniform);
  scene.add(rocksGroup);

  // Camera Controls (Orbit + Smooth Zoom + Ground Collision Protection)
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.rotateSpeed = 0.75;
  controls.zoomSpeed = 1.05;
  controls.panSpeed = 0.8;
  controls.minDistance = 0.9;   // Allow close-up wind ripple inspection
  controls.maxDistance = 320.0; // Allow wide landscape overview
  controls.maxPolarAngle = Math.PI * 0.495;

  // Camera Presets & Transition State
  const presets = buildCameraPresets();
  const presetKeys = Object.keys(presets);
  let currentPresetIndex = 0;

  let isTransitioning = false;
  const transitionStartPos = new THREE.Vector3();
  const transitionStartTarget = new THREE.Vector3();
  const transitionEndPos = new THREE.Vector3();
  const transitionEndTarget = new THREE.Vector3();
  let transitionProgress = 0;
  const transitionDuration = 1.1; // seconds

  // Track user interaction for subtle idle camera drift
  let lastInteractionTime = performance.now();
  let idleEnabled = true;

  const markInteracted = () => {
    lastInteractionTime = performance.now();
    isTransitioning = false;
  };

  controls.addEventListener('start', markInteracted);
  window.addEventListener('pointerdown', markInteracted, { passive: true });
  window.addEventListener('wheel', markInteracted, { passive: true });

  const hudPresetName = document.getElementById('hud-preset-name');
  const hudCoords = document.getElementById('hud-coords');
  const hudHeading = document.getElementById('hud-heading');
  const hudTau = document.getElementById('hud-tau');
  const hudLmst = document.getElementById('hud-lmst');

  function updatePresetButtons(activeKey) {
    document.querySelectorAll('.preset-indicator').forEach((el) => {
      el.classList.toggle('active', el.dataset.preset === activeKey);
    });
    const p = presets[activeKey];
    if (p) {
      if (hudPresetName) hudPresetName.textContent = p.code;
      const tooltipText = document.getElementById('ai-tooltip-text');
      if (tooltipText) tooltipText.textContent = p.insight;
    }
  }

  function applyPreset(key, immediate = false) {
    const p = presets[key];
    if (!p) return;
    currentPresetIndex = presetKeys.indexOf(key);
    updatePresetButtons(key);

    if (immediate) {
      isTransitioning = false;
      camera.position.copy(p.position);
      controls.target.copy(p.target);
      controls.update();
    } else {
      transitionStartPos.copy(camera.position);
      transitionStartTarget.copy(controls.target);
      transitionEndPos.copy(p.position);
      transitionEndTarget.copy(p.target);
      transitionProgress = 0;
      isTransitioning = true;
    }
  }

  // Start at Wide Establishing View
  applyPreset('wide', true);

  // Sun Angle Slider & Keyboard Logic
  const sunSlider = document.getElementById('sun-slider');
  const sunAngleLabel = document.getElementById('sun-angle-value');
  const sunAzimuth = -0.62;
  let currentSunElevation = 24;

  function setSunElevationDegrees(deg) {
    const clampedDeg = Math.max(4, Math.min(85, Number(deg)));
    currentSunElevation = clampedDeg;
    if (sunSlider) sunSlider.value = String(clampedDeg);
    if (sunAngleLabel) sunAngleLabel.textContent = `${clampedDeg.toFixed(1)}°`;

    const elevRad = THREE.MathUtils.degToRad(clampedDeg);
    const cosE = Math.cos(elevRad);
    const sinE = Math.sin(elevRad);

    const sx = Math.cos(sunAzimuth) * cosE;
    const sy = sinE;
    const sz = Math.sin(sunAzimuth) * cosE;

    sunDirUniform.value.set(sx, sy, sz).normalize();

    const dist = 220;
    sunLight.position.set(
      controls.target.x + sx * dist,
      controls.target.y + sy * dist,
      controls.target.z + sz * dist
    );
    sunLight.target.position.copy(controls.target);
    sunLight.target.updateMatrixWorld();

    const t = THREE.MathUtils.clamp((clampedDeg - 4) / 70, 0, 1);
    const lowSunColor = new THREE.Color(0xffad70);
    const highSunColor = new THREE.Color(0xfff0dd);
    sunLight.color.copy(lowSunColor).lerp(highSunColor, Math.pow(t, 0.65));
    sunLight.intensity = THREE.MathUtils.lerp(2.15, 3.55, Math.pow(t, 0.5));

    const lowHorizon = new THREE.Color(0xc97852);
    const highHorizon = new THREE.Color(0xe5b18c);
    fogHorizonColorUniform.value.copy(lowHorizon).lerp(highHorizon, t);

    const lowZenith = new THREE.Color(0x5e2816);
    const highZenith = new THREE.Color(0x9c5536);
    fogZenithColorUniform.value.copy(lowZenith).lerp(highZenith, t);

    hemiLight.color.copy(fogHorizonColorUniform.value);
    hemiLight.intensity = THREE.MathUtils.lerp(0.55, 0.98, t);

    if (hudTau) {
      const opticalDepth = (0.95 - t * 0.38).toFixed(2);
      hudTau.textContent = opticalDepth;
    }
    if (hudLmst) {
      // Map solar elevation (4°..85°) to afternoon Local Mean Solar Time (17:45 .. 12:30)
      const totalMinutes = Math.round(17 * 60 + 45 - t * 315);
      const hrs = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
      const mins = String(totalMinutes % 60).padStart(2, '0');
      hudLmst.textContent = `${hrs}:${mins}:14`;
    }
  }

  setSunElevationDegrees(24);

  if (sunSlider) {
    sunSlider.addEventListener('input', (e) => {
      lastInteractionTime = performance.now();
      setSunElevationDegrees(parseFloat(e.target.value));
    });
  }

  // Toggle HUD visibility via TAB key
  function setHudVisible(visible) {
    if (!roverHud) return;
    if (visible) {
      roverHud.removeAttribute('hidden');
    } else {
      roverHud.setAttribute('hidden', '');
    }
  }

  function toggleHudVisible() {
    if (!roverHud) return false;
    const isHidden = roverHud.hasAttribute('hidden');
    setHudVisible(isHidden);
    return isHidden;
  }

  // Keyboard-Only Navigation & Telemetry Controls
  // Camera movement to different angles/places is triggered strictly by keys 1, 2, 3, 4, 5, 6 (top row or numpad)
  const pressedKeys = new Set();
  const digitKeyMap = {
    Digit1: 0,
    Digit2: 1,
    Digit3: 2,
    Digit4: 3,
    Digit5: 4,
    Digit6: 5,
    Numpad1: 0,
    Numpad2: 1,
    Numpad3: 2,
    Numpad4: 3,
    Numpad5: 4,
    Numpad6: 5,
  };

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      toggleHudVisible();
      return;
    }

    lastInteractionTime = performance.now();

    // Camera Presets triggered exclusively by 1, 2, 3, 4, 5, 6 keys
    if (e.code in digitKeyMap) {
      const idx = digitKeyMap[e.code];
      if (presetKeys[idx]) {
        applyPreset(presetKeys[idx], false);
      }
      return;
    }
    if (e.key >= '1' && e.key <= '6') {
      const idx = parseInt(e.key, 10) - 1;
      if (presetKeys[idx]) {
        applyPreset(presetKeys[idx], false);
      }
      return;
    }

    // Sun Elevation Controls: - / + / [ / ]
    if (e.key === '-' || e.key === '_' || e.key === '[') {
      setSunElevationDegrees(currentSunElevation - 2.0);
      return;
    }
    if (e.key === '=' || e.key === '+' || e.key === ']') {
      setSunElevationDegrees(currentSunElevation + 2.0);
      return;
    }

    const code = e.code;
    if (
      code === 'KeyW' ||
      code === 'KeyS' ||
      code === 'KeyA' ||
      code === 'KeyD' ||
      code === 'KeyQ' ||
      code === 'KeyE' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight'
    ) {
      isTransitioning = false;
      pressedKeys.add(code);
    }
  });

  window.addEventListener('keyup', (e) => {
    pressedKeys.delete(e.code);
  });

  window.addEventListener('blur', () => {
    pressedKeys.clear();
  });

  function stepKeyboardNavigation(dt) {
    if (pressedKeys.size === 0) return;

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() > 0.0001) forward.normalize();

    const moveSpeed = 20.0 * dt;
    const rotSpeed = 1.05 * dt;
    const vertSpeed = 10.0 * dt;

    if (pressedKeys.has('KeyW') || pressedKeys.has('ArrowUp')) {
      camera.position.addScaledVector(forward, moveSpeed);
      controls.target.addScaledVector(forward, moveSpeed);
    }
    if (pressedKeys.has('KeyS') || pressedKeys.has('ArrowDown')) {
      camera.position.addScaledVector(forward, -moveSpeed);
      controls.target.addScaledVector(forward, -moveSpeed);
    }
    if (pressedKeys.has('KeyA') || pressedKeys.has('ArrowLeft')) {
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotSpeed);
      camera.position.copy(controls.target).add(offset);
    }
    if (pressedKeys.has('KeyD') || pressedKeys.has('ArrowRight')) {
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), -rotSpeed);
      camera.position.copy(controls.target).add(offset);
    }
    if (pressedKeys.has('KeyE')) {
      camera.position.y += vertSpeed;
      controls.target.y += vertSpeed;
    }
    if (pressedKeys.has('KeyQ')) {
      camera.position.y -= vertSpeed;
      controls.target.y -= vertSpeed;
    }
  }

  function updateDigitalTelemetryReadout() {
    if (!roverHud || roverHud.hasAttribute('hidden')) return;
    if (hudCoords) {
      const fmt = (n) => (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(1).padStart(5, '0') + 'm';
      hudCoords.textContent = `X:${fmt(camera.position.x)} Y:${fmt(camera.position.y)} Z:${fmt(camera.position.z)}`;
    }
    if (hudHeading) {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const deg = ((Math.round(THREE.MathUtils.radToDeg(Math.atan2(dir.x, -dir.z))) % 360) + 360) % 360;
      const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
      const compass = dirs[Math.round(deg / 45) % 8];
      hudHeading.textContent = `${String(deg).padStart(3, '0')}° ${compass}`;
    }
  }

  // Expose deterministic automation hooks for screenshot capture & verification
  window.__MARS_SIM__ = {
    presets,
    setCameraPreset(key, immediate = true) {
      idleEnabled = false;
      applyPreset(key, immediate);
      setSunElevationDegrees(currentSunElevation);
      updateDigitalTelemetryReadout();
      renderer.render(scene, camera);
    },
    setSunAngle(deg) {
      idleEnabled = false;
      setSunElevationDegrees(deg);
      updateDigitalTelemetryReadout();
      renderer.render(scene, camera);
    },
    setHudVisible(visible) {
      setHudVisible(Boolean(visible));
      updateDigitalTelemetryReadout();
      renderer.render(scene, camera);
    },
    toggleHud() {
      const vis = toggleHudVisible();
      updateDigitalTelemetryReadout();
      renderer.render(scene, camera);
      return vis;
    },
    setIdleEnabled(enabled) {
      idleEnabled = Boolean(enabled);
    },
    getDiagnostics() {
      return {
        backend: backendName,
        sunAngle: currentSunElevation,
        hudVisible: Boolean(roverHud && !roverHud.hasAttribute('hidden')),
        activePreset: presetKeys[currentPresetIndex],
        cameraPosition: camera.position.toArray(),
        cameraTarget: controls.target.toArray(),
        PresetKeys: presetKeys,
      };
    },
  };

  // Resize handler
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Compile TSL shaders & render first frame behind the blurred loading screen before dismissing
  await updateLoadingProgress(96, 'COMPILING TSL SHADERS & SHADOW MAPS...', 'STEP 05/05');
  renderer.render(scene, camera);
  await updateLoadingProgress(100, 'TELEMETRY LINK ESTABLISHED.', 'READY');

  if (loadingScreen) {
    setTimeout(() => {
      loadingScreen.classList.add('is-complete');
    }, 180);
  }

  // Main Animation Loop
  let prevTime = performance.now();
  function animate(now) {
    const dt = Math.min((now - prevTime) * 0.001, 0.1);
    prevTime = now;

    // Smooth camera preset transition
    if (isTransitioning) {
      transitionProgress = Math.min(1.0, transitionProgress + dt / transitionDuration);
      const ease = transitionProgress * transitionProgress * (3.0 - 2.0 * transitionProgress);
      camera.position.lerpVectors(transitionStartPos, transitionEndPos, ease);
      controls.target.lerpVectors(transitionStartTarget, transitionEndTarget, ease);
      if (transitionProgress >= 1.0) {
        isTransitioning = false;
      }
    }

    // Active keyboard navigation
    stepKeyboardNavigation(dt);

    // Subtle idle camera drift when user hasn't interacted for >2.5s
    const timeSinceInteraction = (now - lastInteractionTime) * 0.001;
    if (idleEnabled && !isTransitioning && pressedKeys.size === 0 && timeSinceInteraction > 2.5) {
      const offset = camera.position.clone().sub(controls.target);
      const slowOrbit = 0.028 * dt;
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), slowOrbit);
      camera.position.copy(controls.target).add(offset);
    }

    controls.update();

    // Prevent camera from clipping below procedural Martian terrain surface
    const groundY = sampleMarsElevation(camera.position.x, camera.position.z);
    if (camera.position.y < groundY + 0.65) {
      camera.position.y = groundY + 0.65;
    }

    // Keep directional shadow frustum anchored around current target
    const sx = sunDirUniform.value.x;
    const sy = sunDirUniform.value.y;
    const sz = sunDirUniform.value.z;
    sunLight.position.set(
      controls.target.x + sx * 220,
      controls.target.y + sy * 220,
      controls.target.z + sz * 220
    );
    sunLight.target.position.copy(controls.target);

    updateDigitalTelemetryReadout();
    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(animate);
}

initMarsSim();
