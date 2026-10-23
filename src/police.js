// Wanted system: crimes add "heat" (capped per second); 20 heat = one star.
// Heat only decays after the player has been out of every cop's line of sight
// for a grace period — the map itself (tile DDA) decides what cops can see.
// Escalation: foot patrols → cruisers → rammers. Pursuit units never despawn
// by distance: the cops you earned stay earned until you actually lose them.
import { Vehicle } from './vehicle.js';
import { range } from './rng.js';

export class Police {
  constructor(world) {
    this.world = world;
    this.heat = 0;
    this.gainThisSecond = 0;
    this.gainWindow = 0;
    this.noLosT = 0;
    this.bustT = 0;
    this.cruisers = [];
    this.spawnT = 0;
    this.survivalT = 0;
    this.flashT = 0;
  }

  get stars() { return Math.min(5, Math.floor(this.heat / this.world.cfg.HEAT_STAR) + (this.heat > 0 ? 1 : 0)) | 0; }

  addHeat(amount) {
    const cfg = this.world.cfg;
    const room = Math.max(0, cfg.HEAT_GAIN_CAP - this.gainThisSecond);
    const applied = Math.min(amount, room);
    if (applied <= 0) return;
    this.gainThisSecond += applied;
    const before = this.stars;
    this.heat = Math.min(100, this.heat + applied);
    this.noLosT = 0; // fresh crime resets the cooldown
    if (this.stars !== before) {
      this.flashT = 1.2;
      this.world.missions?.onEvent('heatChanged', { stars: this.stars });
      if (this.stars > before) this.world.audio.sirenBlip();
    }
  }

  clearHeat() {
    this.heat = 0;
    this.world.missions?.onEvent('heatChanged', { stars: 0 });
  }

  footCops() { return this.world.peds.list.filter((p) => p.kind === 'cop' && p.state !== 'downed'); }

  update(dt) {
    const w = this.world, cfg = w.cfg;
    const stars = this.stars;
    const player = w.player;

    // per-second heat gain cap window
    this.gainWindow += dt;
    if (this.gainWindow >= 1) { this.gainWindow = 0; this.gainThisSecond = 0; }
    if (this.flashT > 0) this.flashT -= dt;

    // ---------- LOS + decay ----------
    let seen = false;
    if (stars > 0) {
      for (const c of this.footCops()) {
        if (Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) < 70 &&
            w.city.hasLOS(c.pos.x, c.pos.z, player.pos.x, player.pos.z)) { seen = true; break; }
      }
      if (!seen) for (const v of this.cruisers) {
        if (!v.wrecked &&
            Math.hypot(v.pos.x - player.pos.x, v.pos.z - player.pos.z) < 90 &&
            w.city.hasLOS(v.pos.x, v.pos.z, player.pos.x, player.pos.z)) { seen = true; break; }
      }
      this.noLosT = seen ? 0 : this.noLosT + dt;
      if (this.noLosT > cfg.HEAT_LOS_GRACE) {
        this.heat = Math.max(0, this.heat - cfg.HEAT_DECAY[stars] * dt);
        if (this.heat === 0) {
          this.retire();
          w.missions?.onEvent('heatChanged', { stars: 0 });
          w.missions?.onEvent('evaded', {});
        }
      }
    }
    this.playerSeen = seen;

    // ---------- spawning by star budget ----------
    this.spawnT -= dt;
    if (stars > 0 && this.spawnT <= 0) {
      this.spawnT = range(Math.random, 2.5, 5);
      const foot = this.footCops().length;
      if (foot < cfg.COP_FOOT_MAX[stars]) this.spawnFootCop();
      const cars = this.cruisers.filter((v) => !v.wrecked).length;
      if (cars < cfg.COP_CAR_MAX[stars]) this.spawnCruiser();
    }

    // ---------- cruiser AI: pursue / ram ----------
    for (let i = this.cruisers.length - 1; i >= 0; i--) {
      const v = this.cruisers[i];
      if (v.wrecked) {
        v.wreckAge = (v.wreckAge || 0) + dt;
        if (v.wreckAge > 20) { v.dispose(); this.cruisers.splice(i, 1); }
        continue;
      }
      if (stars === 0 || v.driver === 'player') continue; // stolen cruisers are yours
      this.pursue(v, dt, stars);
    }

    // ---------- busting ----------
    let buster = false;
    if (stars > 0) {
      const slow = player.vehicle ? Math.abs(player.vehicle.speed) < 1.8
        : Math.hypot(player.velX || 0, player.velZ || 0) < 2.2;
      if (slow) {
        for (const c of this.footCops()) {
          if (Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) < cfg.BUST_RANGE &&
              w.city.hasLOS(c.pos.x, c.pos.z, player.pos.x, player.pos.z)) { buster = true; break; }
        }
        if (!buster) for (const v of this.cruisers) {
          if (!v.wrecked && v.speed < 2 &&
              Math.hypot(v.pos.x - player.pos.x, v.pos.z - player.pos.z) < cfg.BUST_RANGE + 1.6)
            { buster = true; break; }
        }
      }
    }
    this.bustT = buster ? this.bustT + dt : Math.max(0, this.bustT - dt * 2);
    if (this.bustT >= cfg.BUST_TIME) w.onArrest();

    // ---------- survival payout at 3★+ ----------
    if (stars >= 3) {
      this.survivalT += dt;
      if (this.survivalT >= 30) {
        this.survivalT = 0;
        w.addCash(cfg.SURVIVAL_PAY);
        w.hud.toast(`+$${cfg.SURVIVAL_PAY} — still breathing at ${stars}★`);
      }
    } else this.survivalT = 0;

    // siren audio follows the nearest live cruiser
    let nearest = Infinity;
    for (const v of this.cruisers) if (!v.wrecked) {
      nearest = Math.min(nearest, Math.hypot(v.pos.x - player.pos.x, v.pos.z - player.pos.z));
      v.siren = true;
    }
    w.audio.siren(nearest < 120, Math.max(0, 1 - nearest / 120));
  }

  pursue(v, dt, stars) {
    const p = this.world.player;
    // aim at the player's predicted position
    const px = p.pos.x + (p.velX || 0) * 0.5;
    const pz = p.pos.z + (p.velZ || 0) * 0.5;
    const dx = px - v.pos.x, dz = pz - v.pos.z;
    const d = Math.hypot(dx, dz);
    const wantH = Math.atan2(dx, dz);
    let dh = wantH - v.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    v.controls.steer = Math.max(-1, Math.min(1, dh * 2.6));

    const ramming = stars >= 3;
    if (!ramming && d < 9) {
      v.controls.throttle = v.speed > 1 ? -1 : 0;   // pull up and hold (bust pressure)
    } else if (Math.abs(dh) > 1.9) {
      v.controls.throttle = -0.6;                    // reverse out of a bad angle
    } else {
      v.controls.throttle = 1;
    }
    v.controls.handbrake = Math.abs(dh) > 1.2 && v.speed > 10;

    // rammers drop a foot cop when they stop near the player
    if (!ramming && d < 8 && v.speed < 1 && !v.dropped) {
      v.dropped = true;
      const cfg = this.world.cfg;
      if (this.footCops().length < cfg.COP_FOOT_MAX[stars] + 1)
        this.world.peds.spawnHostile(v.pos.x + 1.6, v.pos.z, 'cop');
    }
    if (d > 14) v.dropped = false;
  }

  spawnFootCop() {
    const w = this.world;
    const p = w.city.randomSidewalkPoint(Math.random, { from: w.player.pos, min: 25, max: 60 });
    w.peds.spawnHostile(p.x, p.z, 'cop');
  }

  spawnCruiser() {
    const w = this.world;
    const p = w.city.randomRoadPoint(Math.random, { from: w.player.pos, min: 60, max: 120 });
    const v = new Vehicle(w, 'police', p.x, p.z, Math.random() * Math.PI * 2);
    v.asleep = false;
    v.driver = { kind: 'police' };
    v.keepAlive = true; // pursuit units are exempt from distance-despawn
    this.cruisers.push(v);
  }

  // heat hit zero: units stand down and leave the world
  retire() {
    for (const v of this.cruisers) {
      v.siren = false;
      if (!v.wrecked && v.driver !== 'player') v.dispose();
    }
    this.cruisers = this.cruisers.filter((v) => v.wrecked || v.driver === 'player');
    for (const c of this.footCops()) c.remove = true;
    this.world.audio.siren(false, 0);
    this.bustT = 0;
  }
}
