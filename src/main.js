// Boot + game loop. Fixed 60 Hz simulation with an accumulator: physics are
// identical on a 144 Hz monitor and a struggling laptop.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { makeRNG } from './rng.js';
import { generateCity } from './city.js';
import { buildCityMeshes } from './citymesh.js';
import { DayNight } from './daynight.js';
import { Effects } from './effects.js';
import { AudioSys } from './audio.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { Minimap } from './minimap.js';
import { Player } from './player.js';
import { Traffic } from './traffic.js';
import { Peds } from './peds.js';
import { Police } from './police.js';
import { Weapons } from './weapons.js';
import { Missions } from './missions.js';
import { resolveVehicleCollisions } from './vehicle.js';

const STEP = 1 / 60;

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 900);

const world = {
  cfg: CONFIG,
  rng: makeRNG(CONFIG.SEED + 1), // runtime rng — city gen has its own stream
  scene, camera, renderer,
  cash: 0,
  pendingCash: 0,
  state: 'title',
  stats: { missions: 0, busts: 0, deaths: 0 },
  addCash(v) {
    world.cash += v;
    if (v > 0) world.audio.cash();
  },
  allVehicles() {
    return [...world.traffic.cars, ...world.traffic.parked, ...world.police.cruisers];
  },
  events: {
    gunshot(pos) { world.peds.panic(pos); },
  },
  onDeath() {
    if (world.state !== 'play') return;
    world.state = 'dead';
    world.stats.deaths++;
    world.hud.banner('down', 'FLATLINED', `-${Math.round(CONFIG.DEATH_TAX * 100)}% cash`);
    world.audio.death();
    world.cash *= 1 - CONFIG.DEATH_TAX;
    setTimeout(() => respawn(), 3200);
  },
  onArrest() {
    if (world.state !== 'play') return;
    world.state = 'dead';
    world.stats.busts++;
    world.hud.banner('cuffed', 'CUFFED', `-${Math.round(CONFIG.BUST_TAX * 100)}% cash`);
    world.audio.fail();
    world.cash *= 1 - CONFIG.BUST_TAX;
    setTimeout(() => respawn(), 3200);
  },
};

// ---------- build the world ----------
world.city = generateCity(CONFIG);
const cityMesh = buildCityMeshes(world.city);
scene.add(cityMesh.group);

world.effects = new Effects(scene);
world.audio = new AudioSys();
world.input = new Input(canvas);
world.hud = new HUD();
world.minimap = new Minimap(world.city, document.getElementById('minimap'));
world.daynight = new DayNight(scene, CONFIG);
world.player = new Player(world, world.city.spawn.x, world.city.spawn.z);
world.traffic = new Traffic(world);
world.peds = new Peds(world);
world.police = new Police(world);
world.weapons = new Weapons(world);
world.missions = new Missions(world);

camera.position.set(world.player.pos.x, 4, world.player.pos.z + 9);

// headlights: two real spotlights that ride the player's current car at night
const headL = new THREE.SpotLight(0xfff2cc, 0, 45, 0.42, 0.4, 1.2);
const headR = headL.clone();
scene.add(headL, headL.target, headR, headR.target);

// ---------- title screen ----------
const titleEl = document.getElementById('title');
const best = Number(localStorage.getItem('oc_best') || 0);
titleEl.innerHTML = `
  <h1>OVERDRIVE<br>CITY</h1>
  <div class="sub">one city · five stars · zero rules</div>
  <div class="start">CLICK TO DRIVE</div>
  <div class="controls">
    <b>W A S D</b> move / drive &nbsp; <b>Mouse</b> camera + aim &nbsp; <b>Click</b> shoot<br>
    <b>F</b> enter / steal car &nbsp; <b>Space</b> handbrake &nbsp; <b>Shift</b> sprint &nbsp;
    <b>1 2 3</b>/<b>Q</b> weapons &nbsp; <b>M</b> mute &nbsp; <b>Esc</b> pause
  </div>
  ${best > 0 ? `<div class="best">Best run: $${Math.floor(best).toLocaleString('en-US')}</div>` : ''}
  <div class="foot">An original open-world homage. Not affiliated with any game publisher.
    · <a href="https://github.com/appleweiping/overdrive-city" target="_blank">source</a></div>`;
titleEl.querySelector('.start').addEventListener('click', () => {
  world.audio.init();
  titleEl.style.display = 'none';
  world.hud.show();
  world.hud.setWeapon(world.weapons.weapon.name);
  world.state = 'play';
  world.input.lock();
});

const pauseEl = document.getElementById('pause');
function setPause(on) {
  if (world.state !== 'play' && world.state !== 'pause') return;
  world.state = on ? 'pause' : 'play';
  pauseEl.style.display = on ? 'flex' : 'none';
  if (!on) world.input.lock();
}
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && world.state === 'play') setPause(true);
});
pauseEl.addEventListener('click', () => setPause(false));

function respawn() {
  const w = world;
  w.pendingCash = 0;
  if (w.player.vehicle) {
    if (w.player.vehicle.driver === 'player') w.player.vehicle.driver = null;
    w.player.vehicle = null;
    w.player.mesh.visible = true;
  }
  w.police.clearHeat();
  w.police.retire();
  w.police.bustT = 0;
  if (w.missions.active) w.missions.fail('You went down');
  const p = w.city.randomSidewalkPoint(Math.random, { from: w.player.pos, min: 80, max: 220 });
  w.player.pos.set(p.x, 0, p.z);
  w.player.heal();
  w.hud.setWeapon(w.weapons.weapon.name);
  w.state = 'play';
}

// ---------- per-frame global keys ----------
function handleKeys() {
  const inp = world.input;
  if (inp.pressed.has('Escape') || inp.pressed.has('p'))
    setPause(world.state === 'play');
  if (world.state !== 'play') { inp.consume(); return; }
  if (inp.pressed.has('f') || inp.pressed.has('e') || inp.pressed.has('Enter'))
    world.player.tryEnterExit();
  if (inp.pressed.has('q')) world.weapons.cycle();
  if (inp.pressed.has('1')) world.weapons.select(0);
  if (inp.pressed.has('2')) world.weapons.select(1);
  if (inp.pressed.has('3')) world.weapons.select(2);
  if (inp.pressed.has('m')) {
    const muted = world.audio.toggleMute();
    world.hud.toast(muted ? 'Muted' : 'Sound on');
  }
}

// ---------- simulation step ----------
let lightT = 0;
function update(dt) {
  const w = world;

  w.player.update(dt);
  w.weapons.update(dt);
  w.traffic.update(dt);
  w.police.update(dt);

  for (const v of w.allVehicles()) v.update(dt);
  resolveVehicleCollisions(w, w.allVehicles());

  w.peds.update(dt);
  w.missions.update(dt);
  w.effects.update(dt);
  w.daynight.update(dt, w.player.pos);

  // night dressing at ~2 Hz: emissives + everyone's headlights
  lightT -= dt;
  if (lightT <= 0) {
    lightT = 0.5;
    const nf = w.daynight.nightFactor;
    cityMesh.setNight(nf);
    const lightsOn = nf > 0.35;
    for (const v of w.allVehicles())
      if (!v.wrecked && (v.driver || !v.asleep)) v.setHeadlights(lightsOn);
    const pv = w.player.vehicle;
    headL.intensity = headR.intensity = (lightsOn && pv && !pv.wrecked) ? 110 : 0;
    if (pv) {
      const [fx, fz] = pv.fwd;
      const rx = -fz, rz = fx;
      headL.position.set(pv.pos.x + fx * 2 + rx * 0.6, 0.8, pv.pos.z + fz * 2 + rz * 0.6);
      headR.position.set(pv.pos.x + fx * 2 - rx * 0.6, 0.8, pv.pos.z + fz * 2 - rz * 0.6);
      headL.target.position.set(pv.pos.x + fx * 30 + rx * 0.6, 0.2, pv.pos.z + fz * 30 + rz * 0.6);
      headR.target.position.set(pv.pos.x + fx * 30 - rx * 0.6, 0.2, pv.pos.z + fz * 30 - rz * 0.6);
    }
  }

  // engine audio
  const pv = w.player.vehicle;
  w.audio.engine(pv ? Math.min(1, pv.speed / pv.spec.maxF) : 0,
    pv ? pv.controls.throttle !== 0 : false, !!pv);

  // HUD
  w.hud.setStars(w.police.stars, w.police.flashT > 0 || w.police.bustT > 0.3);
  w.hud.setCash(w.cash, w.pendingCash);
  w.hud.setVitals(w.player.hp, w.cfg.PLAYER_HP, w.player.armor);
  w.hud.setSpeed(pv ? pv.speed * 3.6 : 0);
  w.hud.setClock(w.daynight.clockText());

  // minimap blips: missions + police
  const blips = w.missions.blips();
  if (w.police.stars > 0) {
    for (const c of w.police.footCops())
      blips.push({ x: c.pos.x, z: c.pos.z, color: '#4d9fff', size: 3 });
    for (const v of w.police.cruisers)
      if (!v.wrecked) blips.push({ x: v.pos.x, z: v.pos.z, color: '#4d9fff', size: 4 });
  }
  w.minimap.draw(w.player.pos.x, w.player.pos.z, w.player.camYaw + Math.PI, blips);

  if (w.cash > best) localStorage.setItem('oc_best', String(Math.floor(w.cash)));
}

// ---------- loop ----------
let last = performance.now(), acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  handleKeys();
  if (world.state === 'play' || world.state === 'dead') {
    acc += dt;
    while (acc >= STEP) { update(STEP); acc -= STEP; }
  }
  world.input.consume();
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// expose for smoke tests (and the curious)
window.__oc = world;
