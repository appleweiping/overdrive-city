# OVERDRIVE CITY — design & tuning reference

Everything gameplay-related is a constant in [`src/config.js`](../src/config.js).
This document explains what the numbers mean and how the systems interlock.
All values below are the shipped defaults.

## World

| Constant | Value | Meaning |
|---|---|---|
| `TILE` | 8 m | one tile of the city grid |
| `N` | 96 | city is N×N tiles → **768 × 768 m** |
| `SEED` | 20260717 | city-generation seed — same seed, same city |
| `DAY_LENGTH` | 480 s | one full day/night cycle |
| `DAY_START` | 0.35 | clock at the start of a session (08:24) |

The generator lays 2-tile-wide roads on jittered lines (5–8 tile gaps), marks
every road-adjacent tile as sidewalk, and fills each block interior with
buildings via recursive binary splits (downtown splits finer, max 4-tile
footprints → slender towers). Districts are assigned by distance from the map
center: **downtown** (towers, 18–58 m + 1.6× landmarks), **midtown** (10–26 m),
**residential** (5–12 m, 22% of footprints become yards), **industrial**
(southeast corner, wide 6–11 m sheds, 25% parking lots), plus a central
**park** and three random park blocks.

One `Uint8Array` tile map backs four systems:

1. **Collision** — circle-vs-tile with slide response (`collideCircle`)
2. **Line of sight** — DDA ray over tiles, buildings block (`hasLOS`)
3. **Lanes** — every road tile stores a direction code; right-hand traffic
   (southbound lane on the west column, eastbound on the south row)
4. **Placement** — samplable tile lists for missions, spawns, parking

## Drive model

Per fixed step (1/60 s), a vehicle's world velocity is decomposed into
forward `vF` and lateral `vL` components relative to its heading:

```
vF += throttle · accel · (1 − 0.55·vF/maxF) · dt      // tapered acceleration
vF −= vF · drag · dt                                   // 0.55 (×3.2 off-road)
heading += steer · steerRate · clamp(vF/9, −1, 1) · dt // speed-scaled steering
vL *= exp(−grip · dt)                                  // lateral grip
```

**The handbrake simply swaps `grip` (5.2–7.4 by car) for `1.4`.** That one
substitution is the entire drift system: lateral speed stops decaying, the
rear steps out, and body roll + skid marks + drift score all key off `|vL|`.

| Car | maxF (m/s) | accel | grip | steer | HP |
|---|---|---|---|---|---|
| sedan | 26 | 9 | 6.2 | 2.1 | 100 |
| hatch | 23 | 10 | 6.8 | 2.4 | 85 |
| sports | 37 | 15 | 7.4 | 2.5 | 90 |
| pickup | 24 | 8 | 5.6 | 1.8 | 130 |
| van | 22 | 7 | 5.2 | 1.7 | 140 |
| taxi | 27 | 10 | 6.4 | 2.2 | 100 |
| police | 32 | 13 | 7.0 | 2.3 | 120 |

Wall impacts above 3 m/s of closing speed deal `2.2×` damage and spark;
car-vs-car deals `(closing − 4) × 2.0` (×0.35 when neither car is the
player's — AI fender-benders must not cascade into explosion chains).
At 0 HP a car detonates: 42-particle burst, 65 damage at the epicenter
falling off over 6 m, then a blackened husk.

## Wanted system

Crimes add **heat** (0–100). Every 20 heat = one star, five stars max.

| Crime | Heat |
|---|---|
| gunshot fired in public | +2 |
| punch landed | +3 |
| carjacking an occupied car | +8 |
| civilian downed | +13 |
| officer downed | +22 |
| wrecking a car (as player) | +10 (+22 police) |
| heavy wall slam / car hit | +1 – +3 |

Gain is capped at **40 heat/second** so a rampage escalates over seconds, not
frames. Decay only begins after **4 s outside every cop's line of sight**
(70 m foot / 90 m cruiser, tile-DDA checked) and runs at
`[2.2, 1.8, 1.5, 1.2, 1.0]` heat/s for 1★–5★ — higher stars stick longer.

Response budget by stars: foot officers `[2,3,4,4,5]`, cruisers `[0,1,2,3,4]`.
Below 3★ cruisers pull up near you and drop an officer; from 3★ they **ram**
at full throttle. Standing still (or stopped in a car) for **1.6 s** with an
officer within 3.4 m and eye contact gets you **cuffed** (−20% cash). Death
(**flatlined**) costs 30%. Surviving at 3★+ pays **$100 per 30 s** — chaos is a valid career.

When heat returns to zero all units stand down and leave; wrecks remain.

## Weapons

| Weapon | Damage | Interval | Range | Spread | Auto |
|---|---|---|---|---|---|
| Fists | 12 | 0.42 s | 1.9 m | — | no |
| Pistol | 26 | 0.34 s | 60 m | 0.012 rad | no |
| SMG | 11 | 0.085 s | 45 m | 0.045 rad | yes |

Hitscan: one ray from the camera through the crosshair, sphere tests against
every ped (r 0.55) and vehicle (r ≈ 1.5), clamped by a wall-distance probe on
the tile map. Tracers are pooled `Line` objects that fade in 90 ms.

**Tone rule:** civilians only flee (dust poof, tumble, fade — no gore);
everything that shoots back — cops, gang members, bodyguards — is armed.
There are no missions that target civilians.

## Missions

Ten archetypes, all generated from the same primitives: a random point /
target vehicle / target NPC, a timer, heat, and a reward scaled by distance,
stars and night (×1.2). Crime payouts **bank on evade** — they sit as pending
cash and pay out when heat hits zero.

| Archetype | Objective | Reward sketch | Banked? |
|---|---|---|---|
| COURIER | timed delivery | 70 + 0.5/m | no |
| RUSH HOUR | 3–5 drops, any order | 65/drop + 0.35/m | no |
| ROGUE CAB | fare across town, stop to drop | (60 + 0.4/m) × tip(time) | no |
| GHOST RUN | deliver at 0★ (soft-fail per star) | (110 + 0.45/m) × [2 / 1 / 0.5] | no |
| BOOST | steal marked car, deliver clean | (240 + 0.3/m) × condition% | yes |
| GETAWAY | spawn at 2–4★, evade, reach safehouse | 150 · stars^1.5 + 0.2/m | no |
| STREET CIRCUIT | 6–9 checkpoints vs par | 0.4/m × medal (2.2/1.5/1.0) | no |
| SIDEWAYS | drift score in a 34 m zone, 60 s | 180 × score/target (≤2.5×) | no |
| TURF HOLDOUT | 3–4 goon waves, stay in zone | 140/wave + 32/goon | yes |
| BOUNTY | guarded target | 300 + 70/guard | yes |

Circuit checkpoints are a random walk over the intersection graph; par time =
`pathLen/13 + 1.3·K` seconds, gold at 85% of par. Drift score accrues
`|vL| · speed · 0.45 · combo` per second inside the zone; the combo (≤3×)
resets 2 s after the last drift or on any collision.

## Day/night

Time-of-day lerps through 9 keyframes (midnight → dawn → noon → golden hour →
dusk → night) driving sky, fog color/distance, sun color/intensity and
hemisphere fill. The `nightFactor` ramp lights a random share of the facade
windows (in the building shader), fades in the lamp heads and their light
pools on the pavement, and turns on every awake vehicle's head/tail lights and
two real spotlights on the player's car. The sun (one shadow-casting directional
light) orbits the player with a 140 m shadow box so shadows stay crisp
anywhere on the map.

## Performance budget

- Static city = **9 meshes**: merged vertex-colored ground, one
  `InstancedMesh` each for buildings, roofs, lamp poles, lamp heads, lamp
  light pools, trunks, canopies, lane dashes. That is 9 draw calls in the
  main pass, plus 3 in the sun's shadow pass (buildings, lamp poles and
  canopies cast shadows).
- Particles: one 600-slot `Points` cloud, CPU-simulated, preallocated.
- Tracers: 24 pooled lines. No allocation in the frame loop.
- Simulation is a fixed 60 Hz accumulator — physics identical at any refresh
  rate; rendering is uncapped.
- All spatial queries are O(1) tile lookups or short DDA walks. No physics
  engine, no navmesh, no pathfinding graph beyond the intersection list.

## Facades

Buildings are unit boxes scaled per instance, so a normal UV map would stretch
one window across a whole tower. Instead `citymesh.js` draws a 640×128 canvas
atlas once at startup: five 128 px window "bays" (downtown curtain wall,
midtown office, residential, industrial, ground-floor shopfront). The red
channel is wall shading, green marks glass, blue is a sky-reflection ramp.

A patched `MeshLambertMaterial` (`onBeforeCompile`) works out which face it is
on from the box normal, measures the face in meters from the instance matrix,
and tiles the atlas so every building gets bays of about 3–4.5 m and floors of
3–4.4 m depending on its district. Downtown and midtown get shopfronts on the
ground floor. At night a hash of (building, bay, floor) decides which windows
are lit and whether they are warm or cool, so each tower has its own pattern
and it stays stable from frame to frame.
