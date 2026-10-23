// Turns city data into Three.js meshes. Everything static is merged or
// instanced: the whole city renders in ~10 draw calls.
import * as THREE from 'three';
import { T, DIR } from './city.js';

export function buildCityMeshes(city) {
  const group = new THREE.Group();
  const { N, TILE } = city;

  // ---- ground: one plane per tile type via merged BufferGeometry ----
  const GROUND_COLORS = {
    [T.GRASS]: 0x4d7a3a, [T.ROAD]: 0x33363b, [T.SIDEWALK]: 0x8f9499,
    [T.PARK]: 0x3f7a44, [T.LOT]: 0x5b5f66, [T.BUILDING]: 0x3a3d42,
  };
  const positions = [], colors = [], col = new THREE.Color();
  for (let tz = 0; tz < N; tz++) for (let tx = 0; tx < N; tx++) {
    const t = city.tiles[tx + tz * N];
    col.setHex(GROUND_COLORS[t]);
    // tiny per-tile shade variation breaks up the flatness (subtle on asphalt)
    const amp = t === T.ROAD ? 0.012 : 0.06;
    const v = ((tx * 31 + tz * 17) % 7) / 7 * amp - amp / 2;
    const r = col.r + v, g = col.g + v, b = col.b + v;
    const x0 = tx * TILE, z0 = tz * TILE, x1 = x0 + TILE, z1 = z0 + TILE;
    positions.push(x0, 0, z0, x0, 0, z1, x1, 0, z1, x0, 0, z0, x1, 0, z1, x1, 0, z0);
    for (let i = 0; i < 6; i++) colors.push(r, g, b);
  }
  const groundGeo = new THREE.BufferGeometry();
  groundGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo,
    new THREE.MeshLambertMaterial({ vertexColors: true }));
  ground.receiveShadow = true;
  group.add(ground);

  // ---- road center dashes (lane divider between the 2-tile pairs) ----
  const dashGeo = new THREE.PlaneGeometry(0.35, 2.4).rotateX(-Math.PI / 2);
  const dashes = [];
  for (const x of city.vRoads) for (let z = 2; z < N - 2; z += 2) {
    if (city.lane[x + z * N] === DIR.ANY) continue;
    dashes.push([( x + 1) * TILE, (z + 0.5) * TILE, 0]);
  }
  for (const z of city.hRoads) for (let x = 2; x < N - 2; x += 2) {
    if (city.lane[x + z * N] === DIR.ANY) continue;
    dashes.push([(x + 0.5) * TILE, (z + 1) * TILE, Math.PI / 2]);
  }
  const dashMesh = new THREE.InstancedMesh(dashGeo,
    new THREE.MeshBasicMaterial({ color: 0xd8d8c8 }), dashes.length);
  const m4 = new THREE.Matrix4(), e = new THREE.Euler(), q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  dashes.forEach(([x, z, ry], i) => {
    q.setFromEuler(e.set(0, ry, 0));
    m4.compose(p.set(x, 0.02, z), q, one);
    dashMesh.setMatrixAt(i, m4);
  });
  group.add(dashMesh);

  // ---- buildings: one instanced box, per-instance color/scale/style ----
  // Facades come from a small canvas-drawn window atlas; the shader tiles it
  // in meters so a 50 m tower and a 6 m house get the same window size.
  const bGeo = new THREE.BoxGeometry(1, 1, 1);
  const style = new Float32Array(city.buildings.length);
  city.buildings.forEach((b, i) => { style[i] = b.district; });
  bGeo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(style, 1));
  const facade = makeFacadeMaterial();
  const bMesh = new THREE.InstancedMesh(bGeo, facade.material, city.buildings.length);
  bMesh.castShadow = bMesh.receiveShadow = true;
  const s = new THREE.Vector3();
  city.buildings.forEach((b, i) => {
    m4.compose(p.set(b.x, b.h / 2, b.z), q.identity(), s.set(b.w, b.h, b.d));
    bMesh.setMatrixAt(i, m4);
    bMesh.setColorAt(i, col.setHex(b.color));
  });
  bMesh.instanceColor.needsUpdate = true;
  group.add(bMesh);

  // roof caps in a darker shade give silhouettes a "cornice" line
  const roofGeo = new THREE.BoxGeometry(1, 1, 1);
  const roofMesh = new THREE.InstancedMesh(roofGeo,
    new THREE.MeshLambertMaterial({ color: 0x2e3238 }), city.buildings.length);
  city.buildings.forEach((b, i) => {
    m4.compose(p.set(b.x, b.h + 0.35, b.z), q.identity(), s.set(b.w * 0.94, 0.7, b.d * 0.94));
    roofMesh.setMatrixAt(i, m4);
  });
  group.add(roofMesh);

  // ---- street lamps: pole + head; head glows at night ----
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 5.2, 6);
  const poleMesh = new THREE.InstancedMesh(poleGeo,
    new THREE.MeshLambertMaterial({ color: 0x3c4148 }), city.lamps.length);
  const headGeo = new THREE.SphereGeometry(0.26, 8, 6);
  const headMat = new THREE.MeshBasicMaterial({ color: 0x332e20 });
  const headMesh = new THREE.InstancedMesh(headGeo, headMat, city.lamps.length);
  city.lamps.forEach((l, i) => {
    m4.compose(p.set(l.x, 2.6, l.z), q.identity(), one);
    poleMesh.setMatrixAt(i, m4);
    m4.compose(p.set(l.x, 5.3, l.z), q.identity(), one);
    headMesh.setMatrixAt(i, m4);
  });
  poleMesh.castShadow = true;
  group.add(poleMesh, headMesh);

  // a soft pool of light on the pavement under each lamp (additive decal,
  // faded in at night) instead of hundreds of real point lights
  const poolGeo = new THREE.PlaneGeometry(11, 11).rotateX(-Math.PI / 2);
  const poolMat = new THREE.MeshBasicMaterial({
    map: radialTexture(), color: 0xffc977, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const poolMesh = new THREE.InstancedMesh(poolGeo, poolMat, city.lamps.length);
  city.lamps.forEach((l, i) => {
    m4.compose(p.set(l.x, 0.05, l.z), q.identity(), one);
    poolMesh.setMatrixAt(i, m4);
  });
  poolMesh.renderOrder = 1;
  group.add(poolMesh);

  // ---- trees: trunk + cone canopy ----
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 1.6, 5);
  const trunkMesh = new THREE.InstancedMesh(trunkGeo,
    new THREE.MeshLambertMaterial({ color: 0x5d4630 }), city.trees.length);
  const canopyGeo = new THREE.ConeGeometry(1.5, 3.2, 7);
  const canopyMesh = new THREE.InstancedMesh(canopyGeo,
    new THREE.MeshLambertMaterial({ color: 0x2f6b34 }), city.trees.length);
  city.trees.forEach((t, i) => {
    m4.compose(p.set(t.x, 0.8 * t.s, t.z), q.identity(), s.set(t.s, t.s, t.s));
    trunkMesh.setMatrixAt(i, m4);
    m4.compose(p.set(t.x, (1.6 + 1.4) * t.s, t.z), q.identity(), s.set(t.s, t.s, t.s));
    canopyMesh.setMatrixAt(i, m4);
    canopyMesh.setColorAt?.(i, col.setHex(0x2f6b34).offsetHSL(0, 0, ((i * 37) % 10) / 100 - 0.05));
  });
  canopyMesh.castShadow = true;
  group.add(trunkMesh, canopyMesh);

  // night dial: 0 = day, 1 = night — fades window/lamp emissives in
  function setNight(f) {
    facade.uniforms.uNight.value = f;
    poolMat.opacity = f * 0.5;
    poolMesh.visible = f > 0.01;
    headMat.color.setHex(f > 0.4 ? 0xffe9b0 : 0x332e20);
  }

  return { group, setNight };
}

// ---------------------------------------------------------------------------
// Facade atlas: five window "bays" drawn once into a canvas, one per style.
// Channels: R = wall shading, G = glass mask, B = glass reflection gradient.
// Columns: 0 downtown curtain wall, 1 midtown office, 2 residential,
// 3 industrial, 4 ground-floor shopfront.
const CELL = 128;
const STYLES = 5;

function makeFacadeAtlas() {
  const c = document.createElement('canvas');
  c.width = CELL * STYLES;
  c.height = CELL;
  const g = c.getContext('2d');
  const rgb = (r, gg, b) => `rgb(${r},${gg},${b})`;

  // glass panes: G=255 marks glass, B carries a vertical sky-reflection ramp
  const glass = (x, y, w, h) => {
    const grad = g.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, rgb(0, 255, 230));
    grad.addColorStop(1, rgb(0, 255, 40));
    g.fillStyle = grad;
    g.fillRect(x, y, w, h);
  };
  const wall = (x, v) => { g.fillStyle = rgb(v, 0, 0); g.fillRect(x, 0, CELL, CELL); };
  const line = (x, y, w, h, v) => { g.fillStyle = rgb(v, 0, 0); g.fillRect(x, y, w, h); };

  // 0: downtown curtain wall — almost all glass, thin mullions, spandrel band
  let x = 0;
  wall(x, 205);
  glass(x + 6, 14, CELL - 12, CELL - 30);
  line(x + CELL / 2 - 2, 14, 4, CELL - 30, 175);
  line(x, CELL - 16, CELL, 16, 150);

  // 1: midtown office — punched windows with a lintel
  x = CELL;
  wall(x, 235);
  glass(x + 18, 26, CELL - 36, 70);
  line(x + 14, 20, CELL - 28, 6, 200);
  line(x + 14, 96, CELL - 28, 5, 255);

  // 2: residential — smaller window, sill, a little plaster texture
  x = CELL * 2;
  wall(x, 240);
  for (let i = 0; i < 260; i++) {
    const v = 225 + ((i * 97) % 30);
    g.fillStyle = rgb(v, 0, 0);
    g.fillRect(x + (i * 53) % CELL, (i * 29) % CELL, 2, 2);
  }
  glass(x + 34, 34, CELL - 68, 62);
  line(x + CELL / 2 - 2, 34, 4, 62, 215);
  line(x + 28, 96, CELL - 56, 7, 255);

  // 3: industrial — ribbed sheet metal with a high strip window
  x = CELL * 3;
  wall(x, 215);
  for (let i = 0; i < CELL; i += 8) line(x + i, 0, 3, CELL, 185);
  glass(x + 8, 18, CELL - 16, 26);

  // 4: shopfront — big display window above a dark kick plate
  x = CELL * 4;
  wall(x, 120);
  glass(x + 8, 22, CELL - 16, 82);
  line(x + CELL / 2 - 2, 22, 4, 82, 90);
  line(x, 0, CELL, 12, 160);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace; // data, not color
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

function makeFacadeMaterial() {
  const uniforms = {
    uFacade: { value: makeFacadeAtlas() },
    uNight: { value: 0 },
  };
  const material = new THREE.MeshLambertMaterial();
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aStyle;
        varying vec2 vCell;
        varying float vStyle;
        varying float vSeed;
        varying float vSide;
        varying float vY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          // instance matrices are translate+scale only, so the box normal
          // tells us which facade we are on
          vec3 ctr = instanceMatrix[3].xyz;
          vec3 size = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz),
                           length(instanceMatrix[2].xyz));
          vec3 wp = (instanceMatrix * vec4(position, 1.0)).xyz;
          bool xFace = abs(normal.x) > 0.5;
          float faceW = xFace ? size.z : size.x;
          float u = xFace ? wp.z - (ctr.z - size.z * 0.5) : wp.x - (ctr.x - size.x * 0.5);
          // per-style bay width / floor height in meters
          float bayW = aStyle < 0.5 ? 3.0 : aStyle < 1.5 ? 3.4 : aStyle < 2.5 ? 3.6 : 4.5;
          float floorH = aStyle < 0.5 ? 3.6 : aStyle < 1.5 ? 3.5 : aStyle < 2.5 ? 3.0 : 4.4;
          float bays = max(1.0, floor(faceW / bayW + 0.5));
          vCell = vec2(u / faceW * bays, wp.y / floorH);
          vStyle = aStyle;
          vSide = abs(normal.y) > 0.5 ? 0.0 : 1.0;
          vY = wp.y;
          vSeed = fract(sin(dot(ctr.xz, vec2(12.9898, 78.233))) * 43758.5453);
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uFacade;
        uniform float uNight;
        varying vec2 vCell;
        varying float vStyle;
        varying float vSeed;
        varying float vSide;
        varying float vY;
        float facadeHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7)) + vSeed * 91.7) * 43758.5453);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float fGlass = 0.0;
        vec2 fCell = floor(vCell);
        if (vSide > 0.5) {
          // downtown/midtown buildings get shopfronts on the ground floor
          float col = (vCell.y < 1.0 && vStyle < 1.5) ? 4.0 : vStyle;
          vec2 f = fract(vCell);
          vec2 auv = vec2((col + f.x) / ${STYLES}.0, f.y);
          // gradients from the continuous coordinate avoid seams at bay edges
          vec2 dx = dFdx(vCell) * vec2(1.0 / ${STYLES}.0, 1.0);
          vec2 dy = dFdy(vCell) * vec2(1.0 / ${STYLES}.0, 1.0);
          vec3 t = textureGrad(uFacade, auv, dx, dy).rgb;
          fGlass = t.g;
          // contact darkening near the street
          float ao = mix(0.72, 1.0, smoothstep(0.0, 5.0, vY));
          vec3 wallCol = diffuseColor.rgb * t.r * ao;
          float shade = 0.75 + 0.5 * facadeHash(fCell + 7.0);
          vec3 glassCol = mix(vec3(0.07, 0.09, 0.12), vec3(0.42, 0.52, 0.62), t.b * 0.75) * shade;
          diffuseColor.rgb = mix(wallCol, glassCol, fGlass);
        } else {
          diffuseColor.rgb *= 0.82;
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (uNight > 0.0 && fGlass > 0.5) {
          float h = facadeHash(fCell);
          float lit = step(h, 0.38) * step(1.0, vCell.y + 0.001);
          vec3 warm = mix(vec3(1.0, 0.78, 0.45), vec3(0.85, 0.9, 1.0), step(0.8, facadeHash(fCell + 3.1)));
          totalEmissiveRadiance += warm * lit * fGlass * uNight * (0.55 + 0.45 * facadeHash(fCell + 1.7));
        }`);
  };
  return { material, uniforms };
}

// soft radial falloff used for the lamp light pools
function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
