// Data-driven missions. Every archetype is assembled from the same primitives:
// a random point / target vehicle / target NPC, a timer, heat, and a reward
// that scales with distance, stars and time of day. Crime payouts "bank on
// evade": they sit as pending cash until the wanted level returns to zero.
import * as THREE from 'three';
import { pick, irange, range } from './rng.js';

const TYPES = {
  courier:  { name: 'COURIER',      color: 0xf2c230, blurb: 'Timed delivery' },
  multidrop:{ name: 'RUSH HOUR',    color: 0xf2953a, blurb: 'Multi-drop, any order' },
  taxi:     { name: 'ROGUE CAB',    color: 0x30c8f2, blurb: 'Take a fare across town' },
  ghost:    { name: 'GHOST RUN',    color: 0xb58af2, blurb: 'Deliver without heat' },
  boost:    { name: 'BOOST',        color: 0x7ef29a, blurb: 'Steal a marked car, deliver it clean' },
  getaway:  { name: 'GETAWAY',      color: 0xf25a5a, blurb: 'Start hot. Vanish.' },
  circuit:  { name: 'STREET CIRCUIT', color: 0x5a8af2, blurb: 'Checkpoint time trial' },
  drift:    { name: 'SIDEWAYS',     color: 0xf25ad0, blurb: 'Drift score in the zone' },
  holdout:  { name: 'TURF HOLDOUT', color: 0xff8844, blurb: 'Hold the corner, clear the waves' },
  bounty:   { name: 'BOUNTY',       color: 0xe23c3c, blurb: 'A guarded target. No refunds.' },
};
const TYPE_KEYS = Object.keys(TYPES);

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// glowing column used for mission start points and objective targets
function makeBeacon(scene, color, r = 1.4) {
  const g = new THREE.Group();
  const cyl = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, 14, 20, 1, true),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.26, side: THREE.DoubleSide, depthWrite: false,
    }));
  cyl.position.y = 7;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(r, 0.12, 8, 24).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color }));
  ring.position.y = 0.25;
  g.add(cyl, ring);
  scene.add(g);
  return g;
}

export class Missions {
  constructor(world) {
    this.world = world;
    this.rng = world.rng;
    this.markers = [];
    this.active = null;
    this.completed = 0;
  }

  cssColor(type) { return '#' + TYPES[type].color.toString(16).padStart(6, '0'); }

  refillMarkers() {
    const w = this.world;
    while (this.markers.length < w.cfg.MISSION_MARKERS) {
      const type = TYPE_KEYS[(this.rng() * TYPE_KEYS.length) | 0];
      const p = w.city.randomSidewalkPoint(this.rng,
        { from: w.player.pos, min: w.cfg.MISSION_MIN_DIST, max: 500 });
      if (this.markers.some((m) => dist2(m, p) < 70)) continue;
      const mesh = makeBeacon(w.scene, TYPES[type].color);
      mesh.position.set(p.x, 0, p.z);
      this.markers.push({ x: p.x, z: p.z, type, mesh });
    }
  }

  update(dt) {
    const w = this.world;
    this.refillMarkers();
    this.spin = (this.spin || 0) + dt;
    for (const m of this.markers) {
      m.mesh.rotation.y = this.spin;
      m.mesh.children[1].position.y = 0.25 + Math.sin(this.spin * 2 + m.x) * 0.15;
    }

    if (!this.active) {
      // near a marker? show a hint; stand in it to start
      let near = null;
      for (const m of this.markers) if (dist2(m, w.player.pos) < 26) { near = m; break; }
      if (near && dist2(near, w.player.pos) < 3.2) {
        this.start(near);
      } else if (near) {
        w.hud.hint(`${TYPES[near.type].name} — ${TYPES[near.type].blurb}`);
      } else w.hud.hint(this.completed === 0 ? 'Follow a colored blip to find work' : '');
      return;
    }

    const a = this.active;
    if (a.timeLimit != null) {
      a.timer -= dt;
      if (a.timer <= 0) return this.fail('Out of time');
    }
    a.update(dt);
  }

  start(marker) {
    const w = this.world;
    this.markers.splice(this.markers.indexOf(marker), 1);
    w.scene.remove(marker.mesh);
    w.hud.hint('');

    const gen = this['gen_' + marker.type].bind(this);
    this.active = gen(marker);
    this.active.type = marker.type;
    w.audio.ding();
    w.hud.toast(`${TYPES[marker.type].name} started`);
  }

  // reward helpers ---------------------------------------------------------
  nightMult() { return this.world.daynight.isNight ? 1.2 : 1; }
  starMult() { return 1 + this.world.police.stars * 0.15; }

  objective(text, frac = null) {
    const a = this.active;
    this.world.hud.objective(TYPES[a.type].name, text,
      a.timeLimit != null ? a.timer / a.timeLimit : frac);
  }

  complete(reward, { bank = false } = {}) {
    const w = this.world;
    reward = Math.round(reward);
    this.cleanup();
    this.completed++;
    if (bank && w.police.stars > 0) {
      w.pendingCash += reward;
      w.hud.banner('passed', 'JOB DONE', `$${reward} banks when you lose the heat`);
    } else {
      w.addCash(reward);
      w.hud.banner('passed', 'JOB DONE', `+$${reward}`);
    }
    w.audio.jingle();
  }

  fail(why) {
    this.cleanup();
    this.world.hud.banner('failed', 'JOB FAILED', why);
    this.world.audio.fail();
  }

  cleanup() {
    const a = this.active;
    if (!a) return;
    a.cleanup?.();
    this.world.hud.objective(null);
    this.active = null;
  }

  onEvent(name, data) {
    if (name === 'evaded' && this.world.pendingCash > 0) {
      const p = this.world.pendingCash;
      this.world.pendingCash = 0;
      this.world.addCash(p);
      this.world.hud.toast(`Heat's off — $${Math.round(p)} banked`);
      this.world.audio.cash();
    }
    this.active?.onEvent?.(name, data);
  }

  blips() {
    const out = this.markers.map((m) => ({ x: m.x, z: m.z, color: this.cssColor(m.type), size: 4 }));
    if (this.active?.blips) out.push(...this.active.blips());
    return out;
  }

  // ---- shared scaffolding --------------------------------------------------
  makeTarget(color, x, z, r) {
    const beam = makeBeacon(this.world.scene, color, r || 1.6);
    beam.position.set(x, 0, z);
    return beam;
  }

  pointRunner({ marker, color, destOpts, arriveR = 4.5, needStopped = false }) {
    // the courier/taxi/ghost core: one destination, arrive (maybe stopped)
    const w = this.world;
    const dest = w.city.randomSidewalkPoint(this.rng, destOpts);
    const beam = this.makeTarget(color, dest.x, dest.z);
    return {
      dest,
      dist: dist2(marker, dest),
      arrived() {
        if (dist2(dest, w.player.pos) > arriveR) return false;
        if (!needStopped) return true;
        return !w.player.vehicle || Math.abs(w.player.vehicle.speed) < 2;
      },
      cleanup: () => w.scene.remove(beam),
      blips: () => [{ x: dest.x, z: dest.z, color: '#ffffff', size: 5, ring: true }],
    };
  }

  // ---- archetypes ----------------------------------------------------------
  gen_courier(marker) {
    const w = this.world;
    const run = this.pointRunner({
      marker, color: TYPES.courier.color,
      destOpts: { from: marker, min: 220, max: 520 },
    });
    const timeLimit = run.dist / 11 + 16;
    return {
      ...run, timeLimit, timer: timeLimit,
      update: () => {
        this.objective(`Deliver the package — ${Math.round(dist2(run.dest, w.player.pos))} m`);
        if (run.arrived()) this.complete((70 + run.dist * 0.5) * this.nightMult());
      },
    };
  }

  gen_multidrop(marker) {
    const w = this.world;
    const n = irange(this.rng, 3, 5);
    const drops = [];
    let prev = marker, total = 0;
    for (let i = 0; i < n; i++) {
      const p = w.city.randomSidewalkPoint(this.rng, { from: prev, min: 130, max: 300 });
      const beam = this.makeTarget(TYPES.multidrop.color, p.x, p.z);
      drops.push({ ...p, beam });
      total += dist2(prev, p);
      prev = p;
    }
    const timeLimit = total / 9.5 + 20;
    return {
      timeLimit, timer: timeLimit,
      update: () => {
        for (let i = drops.length - 1; i >= 0; i--) {
          if (dist2(drops[i], w.player.pos) < 5) {
            w.scene.remove(drops[i].beam);
            drops.splice(i, 1);
            w.audio.ding();
            w.hud.toast(`Drop off — ${drops.length} left`);
          }
        }
        this.objective(`${drops.length} package${drops.length > 1 ? 's' : ''} left — any order`);
        if (!drops.length) this.complete((n * 65 + total * 0.35) * this.nightMult());
      },
      cleanup: () => drops.forEach((d) => w.scene.remove(d.beam)),
      blips: () => drops.map((d) => ({ x: d.x, z: d.z, color: '#ffffff', size: 5, ring: true })),
    };
  }

  gen_taxi(marker) {
    const w = this.world;
    const fare = w.peds.spawnVIP(marker.x + 1, marker.z + 1);
    const run = this.pointRunner({
      marker, color: TYPES.taxi.color,
      destOpts: { from: marker, min: 180, max: 420 }, needStopped: true, arriveR: 5,
    });
    const timeLimit = run.dist / 9 + 25;
    let boarded = false;
    return {
      ...run, timeLimit, timer: timeLimit,
      update: () => {
        if (!boarded) {
          this.objective('Pick up the fare — stop next to them in any car');
          if (w.player.vehicle && Math.abs(w.player.vehicle.speed) < 2 &&
              dist2(fare.pos, w.player.pos) < 6) {
            boarded = true;
            fare.remove = true;
            w.audio.ding();
          }
          return;
        }
        this.objective(`Drop the fare — ${Math.round(dist2(run.dest, w.player.pos))} m`);
        if (!w.player.vehicle) return; // they wait in the car
        if (run.arrived()) {
          const tip = 1 + (this.active.timer / timeLimit) * 0.8;
          this.complete((60 + run.dist * 0.4) * tip);
        }
      },
      cleanup: () => { run.cleanup(); fare.remove = true; },
      blips: () => (boarded ? run.blips() : [{ x: fare.pos.x, z: fare.pos.z, color: '#30c8f2', size: 5, ring: true }]),
    };
  }

  gen_ghost(marker) {
    const w = this.world;
    const run = this.pointRunner({
      marker, color: TYPES.ghost.color,
      destOpts: { from: marker, min: 300, max: 620 },
    });
    let maxStars = w.police.stars;
    return {
      ...run,
      update: () => {
        maxStars = Math.max(maxStars, w.police.stars);
        if (maxStars >= 3) return this.fail('Way too loud');
        const mult = maxStars === 0 ? 2 : maxStars === 1 ? 1 : 0.5;
        this.objective(`Deliver quietly — 0★ pays double (now ×${mult})`);
        if (run.arrived()) this.complete((110 + run.dist * 0.45) * mult);
      },
    };
  }

  gen_boost(marker) {
    const w = this.world;
    // a marked car cruising the city with a driver
    const p = w.city.randomRoadPoint(this.rng, { from: marker, min: 200, max: 500 });
    const type = pick(this.rng, ['sports', 'sedan', 'van']);
    const car = w.traffic.spawnMissionCar(type, p.x, p.z);
    const garage = w.city.randomTile(this.rng, w.city.lotTiles.length ? w.city.lotTiles : w.city.roadTiles,
      { from: p, min: 250, max: 600 });
    const beam = this.makeTarget(TYPES.boost.color, garage.x, garage.z);
    const hp0 = car.hp;
    let stolen = false;
    return {
      update: () => {
        if (car.wrecked) return this.fail('The merchandise is scrap');
        if (!stolen) {
          this.objective(`Steal the marked ${type} — keep it clean`);
          if (w.player.vehicle === car) { stolen = true; w.audio.ding(); }
          return;
        }
        if (w.player.vehicle !== car) this.objective('Get back in the marked car');
        else this.objective(`Deliver it — ${Math.round(dist2(garage, w.player.pos))} m · condition ${Math.round(car.hp / hp0 * 100)}%`);
        if (w.player.vehicle === car && dist2(garage, w.player.pos) < 6 && Math.abs(car.speed) < 2) {
          const cond = Math.max(0.3, car.hp / hp0);
          this.complete((240 + dist2(p, garage) * 0.3) * cond, { bank: true });
        }
      },
      cleanup: () => w.scene.remove(beam),
      blips: () => [
        stolen ? { x: garage.x, z: garage.z, color: '#ffffff', size: 5, ring: true }
               : { x: car.pos.x, z: car.pos.z, color: '#7ef29a', size: 5, ring: true },
      ],
    };
  }

  gen_getaway(marker) {
    const w = this.world;
    const stars = irange(this.rng, 2, 4);
    w.police.heat = stars * w.cfg.HEAT_STAR - 1;
    w.police.noLosT = 0;
    const safe = w.city.randomSidewalkPoint(this.rng, { from: marker, min: 350, max: 650 });
    const beam = this.makeTarget(TYPES.getaway.color, safe.x, safe.z);
    return {
      update: () => {
        if (w.police.stars > 0) {
          this.objective(`Lose the ${w.police.stars}★ heat first — then the safehouse`);
        } else {
          this.objective(`Clean. Get to the safehouse — ${Math.round(dist2(safe, w.player.pos))} m`);
          if (dist2(safe, w.player.pos) < 4.5)
            this.complete(150 * Math.pow(stars, 1.5) + dist2(marker, safe) * 0.2);
        }
      },
      cleanup: () => w.scene.remove(beam),
      blips: () => (w.police.stars === 0
        ? [{ x: safe.x, z: safe.z, color: '#ffffff', size: 5, ring: true }] : []),
    };
  }

  gen_circuit(marker) {
    const w = this.world;
    // random walk over the intersection graph
    const nodes = w.city.nodes;
    let cur = 0, best = Infinity;
    nodes.forEach((n, i) => {
      const d = dist2(n, w.player.pos);
      if (d < best) { best = d; cur = i; }
    });
    const K = irange(this.rng, 6, 9);
    const cps = [];
    let prev = -1, pathLen = 0, prevPos = nodes[cur];
    for (let i = 0; i < K; i++) {
      const nbs = nodes[cur].nb.filter((n) => n !== prev);
      const nxt = nbs.length ? pick(this.rng, nbs) : prev;
      prev = cur; cur = nxt;
      const n = nodes[cur];
      const beam = this.makeTarget(TYPES.circuit.color, n.x, n.z, 3.2);
      beam.visible = i === 0;
      cps.push({ x: n.x, z: n.z, beam });
      pathLen += dist2(prevPos, n);
      prevPos = n;
    }
    const par = pathLen / 13 + K * 1.3;
    const timeLimit = par * 1.18;
    return {
      timeLimit, timer: timeLimit,
      update: () => {
        const cp = cps[0];
        if (!cp) return;
        this.objective(`Checkpoint ${K - cps.length + 1}/${K} — gold under ${Math.round(par * 0.85)} s`);
        if (dist2(cp, w.player.pos) < 7) {
          w.scene.remove(cp.beam);
          cps.shift();
          w.audio.ding();
          if (cps.length) cps[0].beam.visible = true;
          else {
            const used = timeLimit - this.active.timer;
            const mult = used < par * 0.85 ? 2.2 : used < par ? 1.5 : 1;
            const medal = mult === 2.2 ? 'GOLD' : mult === 1.5 ? 'SILVER' : 'BRONZE';
            w.hud.toast(`${medal} — ${used.toFixed(1)} s`);
            this.complete(pathLen * 0.4 * mult);
          }
        }
      },
      cleanup: () => cps.forEach((c) => w.scene.remove(c.beam)),
      blips: () => (cps[0] ? [{ x: cps[0].x, z: cps[0].z, color: '#ffffff', size: 5, ring: true }] : []),
    };
  }

  gen_drift(marker) {
    const w = this.world;
    const zoneR = 34;
    const target = 1600 + irange(this.rng, 0, 800);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(zoneR, 0.35, 8, 48).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: TYPES.drift.color }));
    ring.position.set(marker.x, 0.3, marker.z);
    w.scene.add(ring);
    const timeLimit = 60;
    let score = 0, combo = 1, comboT = 0;
    return {
      timeLimit, timer: timeLimit,
      update: (dt) => {
        const v = w.player.vehicle;
        const inZone = dist2(marker, w.player.pos) < zoneR;
        if (v && inZone && v.drifting) {
          const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
          const vL = Math.abs(v.vx * -fz + v.vz * fx);
          score += vL * v.speed * dt * 0.45 * combo;
          comboT = 2;
          combo = Math.min(3, combo + dt * 0.35);
        } else {
          comboT -= dt;
          if (comboT <= 0) combo = 1;
        }
        this.objective(v ? `Drift score ${Math.round(score)}/${target} · combo ×${combo.toFixed(1)}`
          : 'You need a car to drift', Math.min(1, score / target));
        if (score >= target) this.complete(180 * Math.min(2.5, score / target) * this.nightMult());
      },
      onEvent: (name) => { if (name === 'carDamaged') combo = 1; },
      cleanup: () => w.scene.remove(ring),
      blips: () => [{ x: marker.x, z: marker.z, color: '#f25ad0', size: 8, ring: true }],
    };
  }

  gen_holdout(marker) {
    const w = this.world;
    const zoneR = 26;
    const waves = irange(this.rng, 3, 4);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(zoneR, 0.35, 8, 48).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: TYPES.holdout.color }));
    ring.position.set(marker.x, 0.3, marker.z);
    w.scene.add(ring);
    let wave = 0, goons = [], between = 2, outT = 0, totalGoons = 0;
    return {
      update: (dt) => {
        goons = goons.filter((g) => g.state !== 'downed' && !g.remove);
        if (!goons.length) {
          if (wave >= waves) return this.complete(140 * waves + 32 * totalGoons, { bank: true });
          between -= dt;
          this.objective(`Wave ${wave + 1}/${waves} incoming…`);
          if (between <= 0) {
            wave++;
            between = 4;
            const n = 1 + wave;
            totalGoons += n;
            for (let i = 0; i < n; i++) {
              const a = this.rng() * Math.PI * 2;
              const gx = marker.x + Math.cos(a) * (zoneR + 6);
              const gz = marker.z + Math.sin(a) * (zoneR + 6);
              const fixed = w.city.collideCircle(gx, gz, 0.4);
              goons.push(w.peds.spawnHostile(fixed.x, fixed.z, 'gang'));
            }
          }
          return;
        }
        const inZone = dist2(marker, w.player.pos) < zoneR;
        outT = inZone ? 0 : outT + dt;
        if (outT > 10) return this.fail('You abandoned the turf');
        this.objective(`Wave ${wave}/${waves} — ${goons.length} left` +
          (inZone ? '' : ` · GET BACK (${Math.ceil(10 - outT)})`));
      },
      cleanup: () => { w.scene.remove(ring); goons.forEach((g) => { g.remove = true; }); },
      blips: () => [
        { x: marker.x, z: marker.z, color: '#ff8844', size: 8, ring: true },
        ...goons.map((g) => ({ x: g.pos.x, z: g.pos.z, color: '#e23c3c', size: 3 })),
      ],
    };
  }

  gen_bounty(marker) {
    const w = this.world;
    const p = w.city.randomSidewalkPoint(this.rng, { from: marker, min: 220, max: 520 });
    const fixed = w.city.collideCircle(p.x, p.z, 0.4);
    const target = w.peds.spawnVIP(fixed.x, fixed.z);
    target.hp = 80;
    const nGuards = irange(this.rng, 2, 3);
    const guards = [];
    for (let i = 0; i < nGuards; i++) {
      const g = w.peds.spawnHostile(p.x + Math.cos(i * 2.1) * 3, p.z + Math.sin(i * 2.1) * 3, 'gang');
      g.state = 'idle'; g.stateT = 1e9; // stand guard until provoked
      guards.push(g);
    }
    let provoked = false;
    return {
      update: () => {
        if (target.state === 'downed')
          return this.complete(300 + nGuards * 70, { bank: true });
        if (target.remove) return this.fail('Lost the target');
        const d = dist2(target.pos, w.player.pos);
        if (!provoked && d < 26) {
          provoked = true;
          guards.forEach((g) => { g.state = 'hostile'; g.hostileTarget = 'player'; });
          target.flee(w.player.pos);
        }
        this.objective(`Take out the target — ${nGuards} bodyguards`, null);
      },
      onEvent: (name, data) => {
        if (name === 'shotPed' && (data.ped === target || guards.includes(data.ped)) && !provoked) {
          provoked = true;
          guards.forEach((g) => { g.state = 'hostile'; g.hostileTarget = 'player'; });
          target.flee(w.player.pos);
        }
      },
      cleanup: () => { target.remove = true; guards.forEach((g) => { g.remove = true; }); },
      blips: () => [{ x: target.pos.x, z: target.pos.z, color: '#e23c3c', size: 5, ring: true }],
    };
  }
}
