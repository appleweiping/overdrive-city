// Procedural city. The Uint8 tile map is the single source of truth: rendering,
// collision, line-of-sight, lane directions and mission placement all read it.
import { makeRNG, pick, irange, chance } from './rng.js';

export const T = { GRASS: 0, ROAD: 1, SIDEWALK: 2, BUILDING: 3, PARK: 4, LOT: 5 };
// lane direction codes stored per road tile
export const DIR = { E: 0, W: 1, S: 2, N: 3, ANY: 4 }; // +x, -x, +z, -z, intersection
export const DIR_VEC = [[1, 0], [-1, 0], [0, 1], [0, -1]];
export const DISTRICT = { DOWNTOWN: 0, MIDTOWN: 1, RESIDENTIAL: 2, INDUSTRIAL: 3, PARK: 4 };

const PALETTES = [
  // downtown: glass towers — cool greys/blues
  [0x8a9bb0, 0x7c8fa6, 0x9fb2c8, 0x6f7f95, 0xa8b8c8, 0x5d6d84],
  // midtown: mixed offices
  [0xb08968, 0x9c8aa5, 0x8fa98f, 0xb0a08a, 0x94a3b3, 0xa89078],
  // residential: warm plaster
  [0xc9a882, 0xbf9273, 0xd4b896, 0xb3937a, 0xc4a58e, 0xaa8866],
  // industrial: sheet metal
  [0x7d8288, 0x8d9298, 0x6e7378, 0x9aa0a6, 0x757a80, 0x888e94],
];

export function generateCity(cfg) {
  const rng = makeRNG(cfg.SEED);
  const N = cfg.N, TILE = cfg.TILE;
  const tiles = new Uint8Array(N * N).fill(T.GRASS);
  const lane = new Int8Array(N * N).fill(-1);
  const district = new Uint8Array(N * N).fill(DISTRICT.RESIDENTIAL);
  const idx = (tx, tz) => tx + tz * N;

  // ---- road lines (each road = 2 tiles wide, right-hand traffic) ----
  const lineCoords = () => {
    const out = [1];
    let x = 1;
    while (x + 2 + 5 < N - 3) { x += 2 + irange(rng, 5, 8); out.push(x); }
    return out;
  };
  const vRoads = lineCoords(); // column indices (left column of each pair)
  const hRoads = lineCoords(); // row indices  (north row of each pair)

  for (const x of vRoads) for (let z = 0; z < N; z++) {
    tiles[idx(x, z)] = T.ROAD;     lane[idx(x, z)] = DIR.S;     // west lane → southbound
    tiles[idx(x + 1, z)] = T.ROAD; lane[idx(x + 1, z)] = DIR.N; // east lane → northbound
  }
  for (const z of hRoads) for (let x = 0; x < N; x++) {
    if (tiles[idx(x, z)] === T.ROAD) { lane[idx(x, z)] = DIR.ANY; lane[idx(x, z + 1)] = DIR.ANY; }
    else {
      tiles[idx(x, z)] = T.ROAD;     lane[idx(x, z)] = DIR.W;     // north lane → westbound
      tiles[idx(x, z + 1)] = T.ROAD; lane[idx(x, z + 1)] = DIR.E; // south lane → eastbound
    }
  }
  // mark full 2×2 intersections as ANY
  for (const x of vRoads) for (const z of hRoads)
    for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++)
      lane[idx(x + dx, z + dz)] = DIR.ANY;

  // ---- sidewalks: every non-road tile touching a road ----
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    if (tiles[idx(x, z)] !== T.GRASS) continue;
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of nb) {
      const nx = x + dx, nz = z + dz;
      if (nx >= 0 && nz >= 0 && nx < N && nz < N && tiles[idx(nx, nz)] === T.ROAD) {
        tiles[idx(x, z)] = T.SIDEWALK; break;
      }
    }
  }

  // ---- blocks between roads (interior only: the sidewalk ring is excluded,
  // so building footprints always sit on solid BUILDING tiles) ----
  const blocks = [];
  const vAll = [-1, ...vRoads, N]; // sentinels
  const hAll = [-1, ...hRoads, N];
  for (let i = 0; i < vAll.length - 1; i++) {
    for (let j = 0; j < hAll.length - 1; j++) {
      const x0 = vAll[i] + 3, x1 = vAll[i + 1] - 2;
      const z0 = hAll[j] + 3, z1 = hAll[j + 1] - 2;
      if (x1 - x0 < 2 || z1 - z0 < 2) continue;
      blocks.push({ x0, z0, x1, z1 });
    }
  }

  // ---- districts per block ----
  const c = N / 2;
  const parkBlocks = new Set();
  // central park: the block nearest the center
  let best = 0, bestD = 1e9;
  blocks.forEach((b, i) => {
    const d = Math.hypot((b.x0 + b.x1) / 2 - c, (b.z0 + b.z1) / 2 - c);
    if (d < bestD) { bestD = d; best = i; }
  });
  parkBlocks.add(best);
  for (let k = 0; k < 3; k++) parkBlocks.add(irange(rng, 0, blocks.length - 1));

  const blockDistrict = blocks.map((b, i) => {
    if (parkBlocks.has(i)) return DISTRICT.PARK;
    const bx = (b.x0 + b.x1) / 2, bz = (b.z0 + b.z1) / 2;
    const d = Math.hypot(bx - c, bz - c) / c;
    if (d < 0.30) return DISTRICT.DOWNTOWN;
    if (d < 0.55) return DISTRICT.MIDTOWN;
    if (bx > c * 1.2 && bz > c * 1.2) return DISTRICT.INDUSTRIAL;
    return DISTRICT.RESIDENTIAL;
  });

  // ---- fill block interiors ----
  const buildings = [];  // {x,z,w,d,h,color,district} in WORLD units (centers)
  const trees = [];      // {x,z,s}
  const HEIGHTS = [[18, 58], [10, 26], [5, 12], [6, 11]]; // per district [min,max] m

  const fillRect = (x0, z0, x1, z1, t) => {
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      if (tiles[idx(x, z)] === T.SIDEWALK || tiles[idx(x, z)] === T.ROAD) continue;
      tiles[idx(x, z)] = t;
    }
  };

  blocks.forEach((b, bi) => {
    const dist = blockDistrict[bi];
    for (let z = b.z0 - 1; z <= b.z1 + 1; z++) for (let x = b.x0 - 1; x <= b.x1 + 1; x++)
      if (x >= 0 && z >= 0 && x < N && z < N) district[idx(x, z)] = dist;

    if (dist === DISTRICT.PARK) {
      fillRect(b.x0, b.z0, b.x1, b.z1, T.PARK);
      for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++)
        if (chance(rng, 0.16)) trees.push({
          x: (x + 0.5) * TILE, z: (z + 0.5) * TILE, s: 0.8 + rng() * 0.9,
        });
      return;
    }

    // subdivide interior into footprints with alley gaps
    // (downtown splits finer → slender towers instead of one squat slab)
    const maxFoot = dist === DISTRICT.DOWNTOWN ? 4 : 6;
    const rects = [{ x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 }];
    const foots = [];
    while (rects.length) {
      const r = rects.pop();
      const w = r.x1 - r.x0 + 1, d = r.z1 - r.z0 + 1;
      if (w <= maxFoot && d <= maxFoot) { foots.push(r); continue; }
      if (w >= d) {
        const cut = r.x0 + irange(rng, 2, w - 3);
        rects.push({ x0: r.x0, z0: r.z0, x1: cut, z1: r.z1 });
        rects.push({ x0: cut + 1, z0: r.z0, x1: r.x1, z1: r.z1 });
      } else {
        const cut = r.z0 + irange(rng, 2, d - 3);
        rects.push({ x0: r.x0, z0: r.z0, x1: r.x1, z1: cut });
        rects.push({ x0: r.x0, z0: cut + 1, x1: r.x1, z1: r.z1 });
      }
    }

    for (const f of foots) {
      // some footprints become parking lots / yards instead of buildings
      if (dist === DISTRICT.RESIDENTIAL && chance(rng, 0.22)) {
        fillRect(f.x0, f.z0, f.x1, f.z1, T.GRASS);
        if (chance(rng, 0.7)) trees.push({
          x: (f.x0 + (f.x1 - f.x0 + 1) / 2) * TILE, z: (f.z0 + (f.z1 - f.z0 + 1) / 2) * TILE,
          s: 0.7 + rng() * 0.7,
        });
        continue;
      }
      if (chance(rng, dist === DISTRICT.INDUSTRIAL ? 0.25 : 0.10)) {
        fillRect(f.x0, f.z0, f.x1, f.z1, T.LOT);
        continue;
      }
      fillRect(f.x0, f.z0, f.x1, f.z1, T.BUILDING);
      const [hmin, hmax] = HEIGHTS[dist];
      let h = hmin + rng() * (hmax - hmin);
      if (dist === DISTRICT.DOWNTOWN && chance(rng, 0.15)) h *= 1.6; // landmark towers
      const w = (f.x1 - f.x0 + 1) * TILE, dd = (f.z1 - f.z0 + 1) * TILE;
      buildings.push({
        x: f.x0 * TILE + w / 2, z: f.z0 * TILE + dd / 2,
        w: w - 1.2, d: dd - 1.2, h, // slight inset so walls don't kiss the sidewalk
        color: pick(rng, PALETTES[dist]), district: dist,
      });
    }
  });

  // ---- street lamps along sidewalks facing roads ----
  const lamps = [];
  for (let z = 1; z < N - 1; z++) for (let x = 1; x < N - 1; x++) {
    if (tiles[idx(x, z)] !== T.SIDEWALK) continue;
    if ((x * 7 + z * 13) % 9 !== 0) continue; // deterministic spacing, no rng drift
    lamps.push({ x: (x + 0.5) * TILE, z: (z + 0.5) * TILE });
  }

  // (lit windows are drawn by the facade shader in citymesh.js)

  // ---- samplable tile lists + intersection graph ----
  const roadTiles = [], sidewalkTiles = [], lotTiles = [];
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const t = tiles[idx(x, z)];
    if (t === T.ROAD) roadTiles.push([x, z]);
    else if (t === T.SIDEWALK) sidewalkTiles.push([x, z]);
    else if (t === T.LOT) lotTiles.push([x, z]);
  }
  // intersection nodes: (vRoad, hRoad) crossings, world center of the 2×2
  const nodes = [];
  const nodeAt = new Map();
  vRoads.forEach((x, i) => hRoads.forEach((z, j) => {
    nodeAt.set(i + ',' + j, nodes.length);
    nodes.push({ x: (x + 1) * TILE, z: (z + 1) * TILE, nb: [] });
  }));
  vRoads.forEach((x, i) => hRoads.forEach((z, j) => {
    const n = nodeAt.get(i + ',' + j);
    if (i + 1 < vRoads.length) { nodes[n].nb.push(nodeAt.get((i + 1) + ',' + j)); nodes[nodeAt.get((i + 1) + ',' + j)].nb.push(n); }
    if (j + 1 < hRoads.length) { nodes[n].nb.push(nodeAt.get(i + ',' + (j + 1))); nodes[nodeAt.get(i + ',' + (j + 1))].nb.push(n); }
  }));

  const city = {
    N, TILE, tiles, lane, district, buildings, trees, lamps,
    roadTiles, sidewalkTiles, lotTiles, nodes, vRoads, hRoads,
    size: N * TILE,

    tileAt(wx, wz) {
      const tx = Math.floor(wx / TILE), tz = Math.floor(wz / TILE);
      if (tx < 0 || tz < 0 || tx >= N || tz >= N) return T.BUILDING; // map edge = wall
      return tiles[tx + tz * N];
    },
    laneAt(wx, wz) {
      const tx = Math.floor(wx / TILE), tz = Math.floor(wz / TILE);
      if (tx < 0 || tz < 0 || tx >= N || tz >= N) return -1;
      return lane[tx + tz * N];
    },
    districtAt(wx, wz) {
      const tx = Math.floor(wx / TILE), tz = Math.floor(wz / TILE);
      if (tx < 0 || tz < 0 || tx >= N || tz >= N) return DISTRICT.RESIDENTIAL;
      return district[tx + tz * N];
    },
    isSolid(wx, wz) { return city.tileAt(wx, wz) === T.BUILDING; },

    // circle vs solid tiles; returns corrected {x,z} (slide response)
    collideCircle(x, z, r) {
      for (let pass = 0; pass < 2; pass++) {
        const tx0 = Math.floor((x - r) / TILE), tx1 = Math.floor((x + r) / TILE);
        const tz0 = Math.floor((z - r) / TILE), tz1 = Math.floor((z + r) / TILE);
        for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
          const solid = tx < 0 || tz < 0 || tx >= N || tz >= N || tiles[tx + tz * N] === T.BUILDING;
          if (!solid) continue;
          const cx = Math.max(tx * TILE, Math.min(x, (tx + 1) * TILE));
          const cz = Math.max(tz * TILE, Math.min(z, (tz + 1) * TILE));
          const dx = x - cx, dz = z - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 < r * r && d2 > 1e-9) {
            const d = Math.sqrt(d2), push = (r - d) / d;
            x += dx * push; z += dz * push;
          } else if (d2 <= 1e-9) { x += r; } // dead-center: nudge out
        }
      }
      return { x, z };
    },

    // tile DDA — true if nothing solid between the two points (cops' eyes, bullets)
    hasLOS(x0, z0, x1, z1) {
      let tx = Math.floor(x0 / TILE), tz = Math.floor(z0 / TILE);
      const tx1 = Math.floor(x1 / TILE), tz1 = Math.floor(z1 / TILE);
      const dx = x1 - x0, dz = z1 - z0;
      const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
      const tdx = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
      const tdz = dz !== 0 ? Math.abs(TILE / dz) : Infinity;
      let mx = dx !== 0 ? Math.abs(((dx > 0 ? (tx + 1) * TILE - x0 : x0 - tx * TILE)) / dx) : Infinity;
      let mz = dz !== 0 ? Math.abs(((dz > 0 ? (tz + 1) * TILE - z0 : z0 - tz * TILE)) / dz) : Infinity;
      for (let i = 0; i < 200; i++) {
        if (tx === tx1 && tz === tz1) return true;
        if (mx < mz) { tx += sx; mx += tdx; } else { tz += sz; mz += tdz; }
        if (tx < 0 || tz < 0 || tx >= N || tz >= N) return false;
        if (tiles[tx + tz * N] === T.BUILDING) return false;
      }
      return true;
    },

    // distance along ray until a solid tile (bullet stop), capped at maxD
    rayWallDist(x0, z0, dirX, dirZ, maxD) {
      const step = TILE * 0.5;
      for (let d = step; d <= maxD; d += step) {
        if (city.isSolid(x0 + dirX * d, z0 + dirZ * d)) return d - step * 0.5;
      }
      return maxD;
    },

    randomTile(rngf, list, opts = {}) {
      const { from = null, min = 0, max = Infinity } = opts;
      for (let i = 0; i < 80; i++) {
        const [tx, tz] = list[(rngf() * list.length) | 0];
        const x = (tx + 0.5) * TILE, z = (tz + 0.5) * TILE;
        if (from) {
          const d = Math.hypot(x - from.x, z - from.z);
          if (d < min || d > max) continue;
        }
        return { x, z };
      }
      const [tx, tz] = list[(rngf() * list.length) | 0];
      return { x: (tx + 0.5) * TILE, z: (tz + 0.5) * TILE };
    },
    randomRoadPoint(rngf, opts) { return city.randomTile(rngf, roadTiles, opts); },
    randomSidewalkPoint(rngf, opts) { return city.randomTile(rngf, sidewalkTiles, opts); },
  };

  // spawn: a sidewalk tile near the center
  city.spawn = city.randomSidewalkPoint(rng, { from: { x: c * TILE, z: c * TILE }, min: 0, max: 80 });

  return city;
}
