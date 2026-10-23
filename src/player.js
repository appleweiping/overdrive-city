// The player: on-foot controller, vehicle enter/exit, and the third-person
// orbit camera. Movement is camera-relative on foot; while driving the camera
// eases in behind the car's heading with the mouse adding a temporary offset.
import * as THREE from 'three';

export class Player {
  constructor(world, x, z) {
    this.world = world;
    this.pos = new THREE.Vector3(x, 0, z);
    this.heading = 0;
    this.velX = 0; this.velZ = 0;
    this.hp = world.cfg.PLAYER_HP;
    this.armor = 0;
    this.vehicle = null;
    this.camYaw = 0;
    this.camPitch = 0.32;
    this.camDist = world.cfg.CAM_DIST_FOOT;
    this.recoilT = 0;
    this.walkPhase = 0;
    this.buildMesh();
  }

  buildMesh() {
    const g = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.64, 0.3),
      new THREE.MeshLambertMaterial({ color: 0xe8e4da })); // white jacket — you, the trouble
    torso.position.y = 1.08;
    torso.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 7),
      new THREE.MeshLambertMaterial({ color: 0xd9a98c }));
    head.position.y = 1.6;
    this.legL = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.78, 0.19),
      new THREE.MeshLambertMaterial({ color: 0x2b3540 }));
    this.legL.position.set(-0.12, 0.39, 0);
    this.legR = this.legL.clone(); this.legR.position.x = 0.12;
    this.armL = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.56, 0.15),
      new THREE.MeshLambertMaterial({ color: 0xe8e4da }));
    this.armL.position.set(-0.33, 1.1, 0);
    this.armR = this.armL.clone(); this.armR.position.x = 0.33;
    this.gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.4),
      new THREE.MeshLambertMaterial({ color: 0x16181c }));
    this.gun.position.set(0.33, 1.32, 0.26);
    g.add(torso, head, this.legL, this.legR, this.armL, this.armR, this.gun);
    g.position.copy(this.pos);
    this.mesh = g;
    this.world.scene.add(g);
  }

  recoil(amount) { this.recoilT = Math.min(1, this.recoilT + amount * 0.12); }

  damage(amount, source) {
    if (this.world.state !== 'play') return;
    const absorbed = Math.min(this.armor, amount * 0.6);
    this.armor -= absorbed;
    this.hp -= amount - absorbed;
    this.world.hud.hurtFlash();
    if (this.hp <= 0) this.world.onDeath(source);
  }

  heal() { this.hp = this.world.cfg.PLAYER_HP; this.armor = 0; }

  tryEnterExit() {
    const w = this.world;
    if (this.vehicle) {                       // exit
      const v = this.vehicle;
      if (v.speed > 8) return;                // no bailing at speed (roadmap: stunt bail)
      this.vehicle = null;
      v.controls.throttle = 0; v.controls.steer = 0; v.controls.handbrake = true;
      if (v.driver === 'player') v.driver = null;
      const [fx, fz] = v.fwd;
      const ex = v.pos.x + (-fz) * -2.2, ez = v.pos.z + fx * -2.2; // step out left
      const fixed = w.city.collideCircle(ex, ez, w.cfg.PLAYER_RADIUS);
      this.pos.set(fixed.x, 0, fixed.z);
      this.mesh.visible = true;
      w.hud.setWeapon(w.weapons.weapon.name);
      w.missions?.onEvent('exitVehicle', { car: v });
      return;
    }
    // enter: nearest usable car
    let best = null, bestD = w.cfg.ENTER_RANGE;
    for (const v of w.allVehicles()) {
      if (v.wrecked) continue;
      const d = Math.hypot(v.pos.x - this.pos.x, v.pos.z - this.pos.z) - v.radius * 0.4;
      if (d < bestD) { best = v; bestD = d; }
    }
    if (!best) return;
    if (best.driver && best.driver !== 'player') w.traffic.carjack(best);
    best.driver = 'player';
    best.asleep = false;
    best.controls.handbrake = false;
    this.vehicle = best;
    this.mesh.visible = false;
    w.hud.setWeapon(null);
    w.missions?.onEvent('enterVehicle', { car: best });
  }

  update(dt) {
    const w = this.world, inp = w.input, cfg = w.cfg;

    // ---- camera orbit from mouse (both modes) ----
    this.camYaw -= inp.mouseDX * 0.0026;
    this.camPitch = Math.min(1.15, Math.max(-0.15, this.camPitch + inp.mouseDY * 0.0022));

    if (this.vehicle) {
      // ---- driving ----
      const v = this.vehicle;
      v.controls.throttle = inp.axis('s', 'w');
      v.controls.steer = inp.axis('d', 'a'); // heading increase = screen-left, so A is +
      v.controls.handbrake = inp.held.has('Space');
      this.pos.copy(v.pos);
      this.velX = v.vx; this.velZ = v.vz;
      this.heading = v.heading;

      // chase cam eases toward the car's rear
      let target = v.heading + Math.PI;
      let dyaw = target - this.camYaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const mouseActive = Math.abs(inp.mouseDX) > 2;
      this.camYaw += dyaw * (mouseActive ? 0.5 : 4.5) * dt;
      this.camDist += (cfg.CAM_DIST_CAR - this.camDist) * 4 * dt;

      if (v.drifting && Math.random() < 0.5) {
        w.effects.skid(v.pos.x - v.fwd[0], v.pos.z - v.fwd[1]);
      }
    } else {
      // ---- on foot: camera-relative movement ----
      const ix = inp.axis('a', 'd'), iz = inp.axis('s', 'w');
      const sprint = inp.held.has('ShiftLeft') || inp.held.has('ShiftRight');
      const speed = sprint ? cfg.SPRINT_SPEED : cfg.WALK_SPEED;
      let mx = 0, mz = 0;
      if (ix || iz) {
        // camera forward on the ground plane
        const fY = this.camYaw + Math.PI; // camera looks at player from behind
        const fx = Math.sin(fY), fz = Math.cos(fY);
        const rx2 = -fz, rz2 = fx;
        mx = fx * iz + rx2 * ix;
        mz = fz * iz + rz2 * ix;
        const l = Math.hypot(mx, mz) || 1;
        mx /= l; mz /= l;
        this.heading = Math.atan2(mx, mz);
      }
      this.velX = mx * speed; this.velZ = mz * speed;
      const fixed = w.city.collideCircle(
        this.pos.x + this.velX * dt, this.pos.z + this.velZ * dt, cfg.PLAYER_RADIUS);
      this.pos.set(fixed.x, 0, fixed.z);
      this.camDist += (cfg.CAM_DIST_FOOT - this.camDist) * 4 * dt;

      // walk cycle
      this.walkPhase += dt * Math.hypot(this.velX, this.velZ) * 1.6;
      const s = Math.sin(this.walkPhase) * Math.min(1, Math.hypot(this.velX, this.velZ) / 4) * 0.7;
      this.legL.rotation.x = s; this.legR.rotation.x = -s;
      this.armL.rotation.x = -s * 0.7;

      // holding a gun: right arm + gun aim along camera
      const aiming = w.weapons.key !== 'fist';
      this.gun.visible = aiming;
      this.armR.rotation.x = aiming ? -1.35 - this.camPitch * 0.5 : s * 0.7;
      if (ix || iz) { /* body faces run direction */ }
      else if (aiming) this.heading = this.camYaw + Math.PI;

      this.mesh.position.copy(this.pos);
      this.mesh.rotation.y = this.heading;
    }

    // ---- place the camera ----
    this.recoilT = Math.max(0, this.recoilT - dt * 4);
    const pitch = this.camPitch + this.recoilT * 0.1;
    const cd = this.camDist;
    const cx = this.pos.x + Math.sin(this.camYaw) * Math.cos(pitch) * cd;
    const cz = this.pos.z + Math.cos(this.camYaw) * Math.cos(pitch) * cd;
    const cy = cfg.CAM_HEIGHT + Math.sin(pitch) * cd;

    // pull the camera in if a building is between it and the player
    let fx3 = cx - this.pos.x, fz3 = cz - this.pos.z;
    const cdist = Math.hypot(fx3, fz3) || 1;
    const wallD = w.city.rayWallDist(this.pos.x, this.pos.z, fx3 / cdist, fz3 / cdist, cdist);
    const k = wallD < cdist ? Math.max(0.25, wallD / cdist) : 1;

    const cam = w.camera;
    const tx = this.pos.x + fx3 * k, tz = this.pos.z + fz3 * k;
    const ty = Math.max(1.2, cfg.CAM_HEIGHT + Math.sin(pitch) * cd * k);
    const lerp = 1 - Math.exp(-cfg.CAM_LERP * dt);
    cam.position.x += (tx - cam.position.x) * lerp;
    cam.position.y += (ty - cam.position.y) * lerp;
    cam.position.z += (tz - cam.position.z) * lerp;
    cam.lookAt(this.pos.x, 1.5, this.pos.z);
  }
}
