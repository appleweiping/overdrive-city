// Checks that run without a browser (Node 22+):
//   node --test test/city.test.mjs
// Every module except main.js (which needs the DOM) must load with its
// imports resolved, and the generator must still build the same connected
// city from the default seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readdirSync } from 'node:fs';

register('./three-alias.mjs', import.meta.url);

const SRC = new URL('../src/', import.meta.url);
const { CONFIG } = await import(new URL('config.js', SRC));
const { generateCity, T, DIR } = await import(new URL('city.js', SRC));
const city = generateCity(CONFIG);

test('every module except main.js loads', async () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.js') && f !== 'main.js');
  assert.ok(files.length > 10);
  for (const f of files) await import(new URL(f, SRC));
});

test('the same seed gives the same city, a new seed a new one', () => {
  const again = generateCity(CONFIG);
  assert.deepEqual(again.tiles, city.tiles);
  assert.deepEqual(again.buildings, city.buildings);
  const other = generateCity({ ...CONFIG, SEED: CONFIG.SEED + 1 });
  assert.notDeepEqual(other.tiles, city.tiles);
});

test('the map is 768 m across and the player starts on a sidewalk', () => {
  assert.equal(city.size, 768);
  assert.equal(city.tileAt(city.spawn.x, city.spawn.z), T.SIDEWALK);
});

test('every building footprint sits on building tiles', () => {
  assert.ok(city.buildings.length > 0);
  for (const b of city.buildings) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = b.x + sx * (b.w / 2 - 0.05), z = b.z + sz * (b.d / 2 - 0.05);
      assert.equal(city.tileAt(x, z), T.BUILDING, `building at ${b.x},${b.z}`);
    }
  }
});

test('every road tile has a lane and all roads are connected', () => {
  const { N, lane } = city;
  const isRoad = (x, z) => x >= 0 && z >= 0 && x < N && z < N && city.tiles[x + z * N] === T.ROAD;
  for (const [x, z] of city.roadTiles) {
    const d = lane[x + z * N];
    assert.ok(d >= DIR.E && d <= DIR.ANY, `road tile ${x},${z} has no lane`);
  }
  const seen = new Uint8Array(N * N);
  const stack = [city.roadTiles[0]];
  seen[stack[0][0] + stack[0][1] * N] = 1;
  let reached = 0;
  while (stack.length) {
    const [x, z] = stack.pop();
    reached++;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (isRoad(nx, nz) && !seen[nx + nz * N]) { seen[nx + nz * N] = 1; stack.push([nx, nz]); }
    }
  }
  assert.equal(reached, city.roadTiles.length);
});

test('line of sight runs down a road and stops at a building', () => {
  const x = (city.vRoads[1] + 0.5) * city.TILE;
  assert.equal(city.hasLOS(x, 4, x, city.size - 4), true);
  const b = city.buildings[0];
  assert.equal(city.hasLOS(b.x - b.w, b.z, b.x + b.w, b.z), false);
});
