#!/usr/bin/env node
// q3mapgen - Procedural arena map generator for Quake III Arena
// Generates 7 map styles: dungeon, vertical, platform, ctf, tourney, atrium
// Seeded PRNG means same seed = same map, every time.
//
// https://github.com/sp00nznet/q3mapgen

const fs = require("fs");
const path = require("path");

// --- Configuration ---
// Override with environment variables or edit these defaults
const OUTPUT_DIR = process.env.ASSETS_DIR
  ? path.join(process.env.ASSETS_DIR, "maps")
  : path.join(__dirname, "..", "assets", "maps");
const SCRIPT_DIR = process.env.ASSETS_DIR
  ? path.join(process.env.ASSETS_DIR, "scripts")
  : path.join(__dirname, "..", "assets", "scripts");

// --- Seeded PRNG (Mulberry32) ---
// Same seed = same map, every time. Deterministic chaos.
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Constants ---
const GRID = 32;
const CELL = 192; // Q3 units per grid cell
const ROOM_HEIGHT = 320;
const WALL_THICK = 16;
const BOX_PAD = 256; // padding for outer sealing box

const CELL_SOLID = 0;
const CELL_ROOM = 1;
const CELL_CORRIDOR = 2;

// --- Texture themes (Q3 demo pak0 textures) ---
// You can add your own themes here — just follow the same structure.
// Each theme needs walls[], floors[], ceilings[], trim, light, and sky.
const THEMES = [
  {
    name: "gothic",
    walls: [
      "gothic_block/blocks18c",
      "gothic_block/blocks17",
      "gothic_block/blocks15",
      "gothic_block/blocks11b",
      "gothic_wall/streetbricks10",
      "gothic_wall/streetbricks11",
    ],
    floors: [
      "gothic_floor/largeblockfloor3",
      "gothic_floor/largerblock3b",
      "gothic_floor/q1metal7_99",
      "gothic_floor/xstepborder3",
    ],
    ceilings: [
      "gothic_ceiling/woodceiling1a",
      "gothic_ceiling/ceilingtechplain",
      "gothic_ceiling/stucco7top",
    ],
    trim: "gothic_trim/baseboard09_1",
    light: "gothic_light/gothic_light3",
    sky: "skies/killsky",
  },
  {
    name: "base",
    walls: [
      "base_wall/metaltech12final",
      "base_wall/metaltech06final",
      "base_wall/metalfloor_wall_15",
      "base_wall/c_met5_2",
      "base_wall/patch10_beatup2",
      "base_wall/metalblack03",
    ],
    floors: [
      "base_wall/metfloor_block_3",
      "gothic_floor/largeblockfloor3",
      "gothic_floor/q1metal7_99",
      "base_floor/pjgrate2",
    ],
    ceilings: [
      "gothic_ceiling/ceilingtechplain",
      "gothic_ceiling/ceilingtech01_f",
      "base_wall/metaltech13final",
    ],
    trim: "base_trim/basemetalsupport",
    light: "base_light/ceil1_38",
    sky: "skies/killsky",
  },
];

// --- Weapons available in demo ---
const WEAPONS = [
  "weapon_rocketlauncher",
  "weapon_railgun",
  "weapon_lightning",
  "weapon_plasmagun",
  "weapon_shotgun",
];

const AMMO_FOR = {
  weapon_rocketlauncher: "ammo_rockets",
  weapon_railgun: "ammo_slugs",
  weapon_lightning: "ammo_lightning",
  weapon_plasmagun: "ammo_cells",
  weapon_shotgun: "ammo_shells",
};

// --- Powerups ---
const POWERUPS = ["item_quad", "item_enviro", "item_haste"];

// --- Jump pad entity pair ---
// Creates a visible pad brush + trigger_push + target_position
// Returns { map, count, worldBrushes } — worldBrushes must be added inside entity 0
function jumpPadEntities(entNum, x, y, z, targetX, targetY, targetZ, padSize) {
  const ps = padSize || 64;
  const hs = ps / 2;
  let map = "";
  const targetName = `jpad_${entNum}`;

  // Visible pad platform (goes in worldspawn — caller must add before closing worldspawn)
  // Thick bright pedestal so players can see where the jump pad is
  const worldBrushes =
    // Base pedestal
    block(x - hs, y - hs, z - 32, x + hs, y + hs, z, {
      top: "base_floor/diamond2c",
      bottom: "common/caulk",
      north: "base_trim/border11light",
      south: "base_trim/border11light",
      east: "base_trim/border11light",
      west: "base_trim/border11light",
    }) +
    // Arrow marker on top (smaller raised center)
    block(x - hs / 2, y - hs / 2, z, x + hs / 2, y + hs / 2, z + 4, {
      top: "sfx/launchpad_arrow",
      bottom: "common/caulk",
      north: "common/caulk",
      south: "common/caulk",
      east: "common/caulk",
      west: "common/caulk",
    });

  // trigger_push brush entity (invisible trigger on top of pad)
  map += `// entity ${entNum} - jump pad\n{\n"classname" "trigger_push"\n"target" "${targetName}"\n`;
  map += block(x - hs, y - hs, z, x + hs, y + hs, z + 16, "common/trigger");
  map += "}\n";

  // target_position (landing spot)
  map += `// entity ${entNum + 1} - jump pad target\n{\n"classname" "target_position"\n"targetname" "${targetName}"\n"origin" "${targetX} ${targetY} ${targetZ}"\n}\n`;

  return { map, count: 2, worldBrushes };
}

// --- Teleporter entity pair ---
function teleporterEntities(entNum, x, y, z, destX, destY, destZ, destAngle) {
  let map = "";
  const targetName = `tele_${entNum}`;
  const ps = 48;

  // trigger_teleport brush entity
  map += `// entity ${entNum} - teleporter\n{\n"classname" "trigger_teleport"\n"target" "${targetName}"\n`;
  map += block(x - ps, y - ps, z, x + ps, y + ps, z + 64, "common/trigger");
  map += "}\n";

  // misc_teleporter_dest
  map += `// entity ${entNum + 1} - teleporter dest\n{\n"classname" "misc_teleporter_dest"\n"targetname" "${targetName}"\n"origin" "${destX} ${destY} ${destZ + 32}"\n"angle" "${destAngle || 0}"\n}\n`;

  return { map, count: 2 };
}

// --- Lava pit brush (for worldspawn) ---
function lavaPit(x1, y1, z1, x2, y2, z2) {
  return block(x1, y1, z1, x2, y2, z2, "liquids/lavahell");
}

// --- Q3 brush helpers ---

function brush(planes) {
  let out = "{\n";
  for (const p of planes) {
    const [p1, p2, p3, tex, xoff, yoff, rot, xs, ys] = p;
    out += `( ${p1.join(" ")} ) ( ${p2.join(" ")} ) ( ${p3.join(" ")} ) ${tex} ${xoff} ${yoff} ${rot} ${xs} ${ys} 0 0 0\n`;
  }
  out += "}\n";
  return out;
}

function block(x1, y1, z1, x2, y2, z2, faceTex) {
  const caulk = "common/caulk";
  const t =
    typeof faceTex === "string"
      ? { top: faceTex, bottom: faceTex, north: faceTex, south: faceTex, east: faceTex, west: faceTex }
      : { top: caulk, bottom: caulk, north: caulk, south: caulk, east: caulk, west: caulk, ...faceTex };

  const texP = [0, 0, 0, 0.5, 0.5];

  return brush([
    [[x1, y1, z1], [x2, y2, z1], [x1, y2, z1], t.bottom, ...texP],
    [[x1, y1, z2], [x1, y2, z2], [x2, y2, z2], t.top, ...texP],
    [[x1, y1, z1], [x1, y1, z2], [x2, y1, z1], t.south, ...texP],
    [[x1, y2, z1], [x2, y2, z1], [x2, y2, z2], t.north, ...texP],
    [[x1, y1, z1], [x1, y2, z1], [x1, y1, z2], t.west, ...texP],
    [[x2, y1, z1], [x2, y1, z2], [x2, y2, z1], t.east, ...texP],
  ]);
}

// Generate 6 sealing box brushes (overlapping shell to guarantee AAS sealing)
function sealingBox(x1, y1, z1, x2, y2, z2, tex, thick) {
  let out = "";
  const T = thick || 64;
  // All faces overlap at corners to ensure no gaps
  // Bottom
  out += block(x1 - T, y1 - T, z1 - T, x2 + T, y2 + T, z1, tex);
  // Top
  out += block(x1 - T, y1 - T, z2, x2 + T, y2 + T, z2 + T, tex);
  // South (-Y)
  out += block(x1 - T, y1 - T, z1 - T, x2 + T, y1, z2 + T, tex);
  // North (+Y)
  out += block(x1 - T, y2, z1 - T, x2 + T, y2 + T, z2 + T, tex);
  // West (-X)
  out += block(x1 - T, y1 - T, z1 - T, x1, y2 + T, z2 + T, tex);
  // East (+X)
  out += block(x2, y1 - T, z1 - T, x2 + T, y2 + T, z2 + T, tex);
  return out;
}

// --- Shared entity placement ---

function placeEntities(platforms, rng, zOffset) {
  // platforms: array of { x, y, z, w, h } in world coords
  // zOffset: height above platform surface to place entities
  // Returns { map, entNum, worldBrushes } — worldBrushes go in entity 0
  let map = "";
  let entNum = 1;
  let worldBrushes = ""; // visible jump pad brushes to add to worldspawn
  const jumpPadPositions = []; // track pad positions to avoid spawns on them

  // Shuffle platforms
  const shuffled = [...platforms];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // Spawn points (12-16) — lots of spawns to avoid telefrag loops
  // Q3 picks the spawn farthest from all players, so more = better
  const numSpawns = Math.min(16, Math.max(12, platforms.length * 2));
  const spawnPositions = [];
  let spawnAttempts = 0;
  const minSpawnDist = 192; // minimum distance between spawns
  while (spawnPositions.length < numSpawns && spawnAttempts < 500) {
    spawnAttempts++;
    const p = platforms[spawnPositions.length % platforms.length];
    // Spread spawns across the platform — use grid positions for even coverage
    const gridX = Math.floor(rng() * 3); // 0, 1, 2 across platform width
    const gridY = Math.floor(rng() * 3);
    const sx = p.x + CELL / 2 + Math.floor(gridX * (p.w - CELL) / 2);
    const sy = p.y + CELL / 2 + Math.floor(gridY * (p.h - CELL) / 2);
    const sz = p.z + zOffset;
    // Check minimum distance from existing spawns and jump pads
    let tooClose = false;
    for (const sp of spawnPositions) {
      const dx = sx - sp[0], dy = sy - sp[1], dz = sz - sp[2];
      if (dx * dx + dy * dy + dz * dz < minSpawnDist * minSpawnDist) { tooClose = true; break; }
    }
    if (!tooClose) {
      for (const jp of jumpPadPositions) {
        const dx = sx - jp[0], dy = sy - jp[1];
        if (dx * dx + dy * dy < 128 * 128) { tooClose = true; break; }
      }
    }
    if (tooClose) continue;
    spawnPositions.push([sx, sy, sz]);
    const angle = Math.floor(rng() * 360);
    map += `// entity ${entNum++}\n{\n"classname" "info_player_deathmatch"\n"origin" "${sx} ${sy} ${sz}"\n"angle" "${angle}"\n}\n`;
  }

  // Weapons (3-4)
  const availableWeapons = [...WEAPONS];
  for (let i = availableWeapons.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [availableWeapons[i], availableWeapons[j]] = [availableWeapons[j], availableWeapons[i]];
  }
  const numWeapons = 3 + Math.floor(rng() * 2);
  const chosenWeapons = availableWeapons.slice(0, numWeapons);

  for (let i = 0; i < chosenWeapons.length; i++) {
    const p = platforms[i % platforms.length];
    const wx = p.x + Math.floor(p.w / 2);
    const wy = p.y + Math.floor(p.h / 2);
    map += `// entity ${entNum++}\n{\n"classname" "${chosenWeapons[i]}"\n"origin" "${wx} ${wy} ${p.z + 16}"\n}\n`;
    const ammo = AMMO_FOR[chosenWeapons[i]];
    if (ammo) {
      map += `// entity ${entNum++}\n{\n"classname" "${ammo}"\n"origin" "${wx + 48} ${wy} ${p.z + 16}"\n}\n`;
    }
  }

  // Health (6-8)
  const numHealth = 6 + Math.floor(rng() * 3);
  for (let i = 0; i < numHealth; i++) {
    const p = shuffled[i % shuffled.length];
    const hx = p.x + CELL / 4 + Math.floor(rng() * (p.w - CELL / 2));
    const hy = p.y + CELL / 4 + Math.floor(rng() * (p.h - CELL / 2));
    map += `// entity ${entNum++}\n{\n"classname" "item_health"\n"origin" "${hx} ${hy} ${p.z + 16}"\n}\n`;
  }

  // Large health
  for (let i = 0; i < Math.min(2, platforms.length); i++) {
    const p = platforms[platforms.length - 1 - i];
    const lx = p.x + Math.floor(p.w / 2);
    const ly = p.y + Math.floor(p.h / 2) + 64;
    map += `// entity ${entNum++}\n{\n"classname" "item_health_large"\n"origin" "${lx} ${ly} ${p.z + 16}"\n}\n`;
  }

  // Yellow armor in middle area
  if (platforms.length >= 3) {
    const p = platforms[Math.floor(platforms.length / 2)];
    const ax = p.x + Math.floor(p.w / 2);
    const ay = p.y + Math.floor(p.h / 2);
    map += `// entity ${entNum++}\n{\n"classname" "item_armor_combat"\n"origin" "${ax} ${ay} ${p.z + 16}"\n}\n`;
  }

  // Red armor — on the smallest platform (risky exposed spot)
  if (platforms.length >= 4) {
    let smallest = 0;
    for (let i = 1; i < platforms.length; i++) {
      if (platforms[i].w * platforms[i].h < platforms[smallest].w * platforms[smallest].h) smallest = i;
    }
    const p = platforms[smallest];
    map += `// entity ${entNum++}\n{\n"classname" "item_armor_body"\n"origin" "${p.x + Math.floor(p.w / 2)} ${p.y + Math.floor(p.h / 2)} ${p.z + 16}"\n}\n`;
  }

  // Quad damage — in a hard-to-reach or exposed spot
  if (platforms.length >= 3) {
    // Place on the highest platform
    let highest = 0;
    for (let i = 1; i < platforms.length; i++) {
      if (platforms[i].z > platforms[highest].z) highest = i;
    }
    const p = platforms[highest];
    map += `// entity ${entNum++}\n{\n"classname" "item_quad"\n"origin" "${p.x + Math.floor(p.w / 2)} ${p.y + Math.floor(p.h / 2) - 64} ${p.z + 16}"\n}\n`;
  }

  // Jump pads — connect lower platforms to higher ones (2-3)
  const sortedByZ = [...platforms].sort((a, b) => a.z - b.z);
  const numJumpPads = Math.min(3, Math.floor(platforms.length / 2));
  for (let i = 0; i < numJumpPads; i++) {
    const low = sortedByZ[i];
    const high = sortedByZ[sortedByZ.length - 1 - i];
    if (!high || high.z <= low.z) continue;

    const padX = low.x + Math.floor(low.w / 2) + Math.floor(rng() * 128) - 64;
    const padY = low.y + Math.floor(low.h / 2) + Math.floor(rng() * 128) - 64;
    const landX = high.x + Math.floor(high.w / 2);
    const landY = high.y + Math.floor(high.h / 2);

    const jp = jumpPadEntities(entNum, padX, padY, low.z, landX, landY, high.z + 64, 64);
    map += jp.map;
    worldBrushes += `// jump pad visual\n${jp.worldBrushes}`;
    jumpPadPositions.push([padX, padY, low.z]);
    entNum += jp.count;
  }

  // Teleporter pair — connect two distant platforms
  if (platforms.length >= 4) {
    // Find the two most distant platforms
    let maxDist = 0, teleA = 0, teleB = 1;
    for (let i = 0; i < platforms.length; i++) {
      for (let j = i + 1; j < platforms.length; j++) {
        const dx = (platforms[i].x + platforms[i].w / 2) - (platforms[j].x + platforms[j].w / 2);
        const dy = (platforms[i].y + platforms[i].h / 2) - (platforms[j].y + platforms[j].h / 2);
        const d = dx * dx + dy * dy;
        if (d > maxDist) { maxDist = d; teleA = i; teleB = j; }
      }
    }
    const pA = platforms[teleA], pB = platforms[teleB];
    const axc = pA.x + Math.floor(pA.w / 2), ayc = pA.y + Math.floor(pA.h / 2);
    const bxc = pB.x + Math.floor(pB.w / 2), byc = pB.y + Math.floor(pB.h / 2);

    // Teleporter A -> B
    const t1 = teleporterEntities(entNum, axc - 80, ayc, pA.z, bxc, byc, pB.z, 0);
    map += t1.map; entNum += t1.count;
    // Teleporter B -> A
    const t2 = teleporterEntities(entNum, bxc + 80, byc, pB.z, axc, ayc, pA.z, 180);
    map += t2.map; entNum += t2.count;
  }

  return { map, entNum, worldBrushes };
}

// =============================================
// DUNGEON STYLE (enclosed rooms + corridors)
// =============================================

function generateDungeon(rng) {
  const grid = Array.from({ length: GRID }, () => new Array(GRID).fill(CELL_SOLID));
  const rooms = [];

  const numRooms = 5 + Math.floor(rng() * 4);
  let attempts = 0;

  while (rooms.length < numRooms && attempts < 200) {
    attempts++;
    const w = 4 + Math.floor(rng() * 5);
    const h = 4 + Math.floor(rng() * 5);
    const x = 1 + Math.floor(rng() * (GRID - w - 2));
    const y = 1 + Math.floor(rng() * (GRID - h - 2));

    let overlap = false;
    for (const r of rooms) {
      if (x < r.x + r.w + 1 && x + w + 1 > r.x && y < r.y + r.h + 1 && y + h + 1 > r.y) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;

    rooms.push({ x, y, w, h });
    for (let gy = y; gy < y + h; gy++) {
      for (let gx = x; gx < x + w; gx++) {
        grid[gy][gx] = CELL_ROOM;
      }
    }
  }

  const centers = rooms.map((r) => ({
    x: Math.floor(r.x + r.w / 2),
    y: Math.floor(r.y + r.h / 2),
  }));

  // Prim's MST
  const n = rooms.length;
  const inMST = new Array(n).fill(false);
  const edges = [];
  inMST[0] = true;
  let mstCount = 1;

  while (mstCount < n) {
    let bestDist = Infinity, bestFrom = -1, bestTo = -1;
    for (let i = 0; i < n; i++) {
      if (!inMST[i]) continue;
      for (let j = 0; j < n; j++) {
        if (inMST[j]) continue;
        const dist = Math.abs(centers[i].x - centers[j].x) + Math.abs(centers[i].y - centers[j].y);
        if (dist < bestDist) { bestDist = dist; bestFrom = i; bestTo = j; }
      }
    }
    if (bestTo === -1) break;
    inMST[bestTo] = true;
    edges.push([bestFrom, bestTo]);
    mstCount++;
  }

  const extraEdges = 1 + Math.floor(rng() * 2);
  for (let e = 0; e < extraEdges; e++) {
    const i = Math.floor(rng() * n);
    const j = Math.floor(rng() * n);
    if (i !== j) edges.push([i, j]);
  }

  for (const [from, to] of edges) {
    const a = centers[from];
    const b = centers[to];
    if (rng() < 0.5) {
      for (let gx = Math.min(a.x, b.x); gx <= Math.max(a.x, b.x); gx++) {
        if (grid[a.y][gx] === CELL_SOLID) grid[a.y][gx] = CELL_CORRIDOR;
        if (a.y + 1 < GRID && grid[a.y + 1][gx] === CELL_SOLID) grid[a.y + 1][gx] = CELL_CORRIDOR;
      }
      for (let gy = Math.min(a.y, b.y); gy <= Math.max(a.y, b.y); gy++) {
        if (grid[gy][b.x] === CELL_SOLID) grid[gy][b.x] = CELL_CORRIDOR;
        if (b.x + 1 < GRID && grid[gy][b.x + 1] === CELL_SOLID) grid[gy][b.x + 1] = CELL_CORRIDOR;
      }
    } else {
      for (let gy = Math.min(a.y, b.y); gy <= Math.max(a.y, b.y); gy++) {
        if (grid[gy][a.x] === CELL_SOLID) grid[gy][a.x] = CELL_CORRIDOR;
        if (a.x + 1 < GRID && grid[gy][a.x + 1] === CELL_SOLID) grid[gy][a.x + 1] = CELL_CORRIDOR;
      }
      for (let gx = Math.min(a.x, b.x); gx <= Math.max(a.x, b.x); gx++) {
        if (grid[b.y][gx] === CELL_SOLID) grid[b.y][gx] = CELL_CORRIDOR;
        if (b.y + 1 < GRID && grid[b.y + 1][gx] === CELL_SOLID) grid[b.y + 1][gx] = CELL_CORRIDOR;
      }
    }
  }

  return { grid, rooms, centers };
}

function dungeonToMap(grid, rooms, centers, theme, rng) {
  let map = "";
  let brushNum = 0;

  const roomTextures = rooms.map(() => ({
    wall: theme.walls[Math.floor(rng() * theme.walls.length)],
    floor: theme.floors[Math.floor(rng() * theme.floors.length)],
    ceiling: theme.ceilings[Math.floor(rng() * theme.ceilings.length)],
  }));

  const cellRoom = Array.from({ length: GRID }, () => new Array(GRID).fill(-1));
  for (let ri = 0; ri < rooms.length; ri++) {
    const r = rooms[ri];
    for (let gy = r.y; gy < r.y + r.h; gy++) {
      for (let gx = r.x; gx < r.x + r.w; gx++) {
        cellRoom[gy][gx] = ri;
      }
    }
  }

  function texForCell(gy, gx) {
    const ri = cellRoom[gy][gx];
    if (ri >= 0) return roomTextures[ri];
    let bestDist = Infinity, bestRi = 0;
    for (let i = 0; i < centers.length; i++) {
      const d = Math.abs(gx - centers[i].x) + Math.abs(gy - centers[i].y);
      if (d < bestDist) { bestDist = d; bestRi = i; }
    }
    return roomTextures[bestRi];
  }

  map += `// entity 0\n{\n"classname" "worldspawn"\n"message" "q3mapgen arena"\n`;

  const ox = -(GRID * CELL) / 2;
  const oy = -(GRID * CELL) / 2;

  // Find map bounds for sealing box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      if (grid[gy][gx] !== CELL_SOLID) {
        minX = Math.min(minX, ox + gx * CELL - WALL_THICK);
        minY = Math.min(minY, oy + gy * CELL - WALL_THICK);
        maxX = Math.max(maxX, ox + (gx + 1) * CELL + WALL_THICK);
        maxY = Math.max(maxY, oy + (gy + 1) * CELL + WALL_THICK);
      }
    }
  }

  // Sealing box (caulk for dungeon — invisible, just seals the map for AAS)
  const bx1 = minX - BOX_PAD, by1 = minY - BOX_PAD;
  const bx2 = maxX + BOX_PAD, by2 = maxY + BOX_PAD;
  const bz1 = -WALL_THICK - BOX_PAD, bz2 = ROOM_HEIGHT + WALL_THICK + BOX_PAD;
  map += `// sealing box\n`;
  for (let bi = 0; bi < 6; bi++) brushNum++;
  map += sealingBox(bx1, by1, bz1, bx2, by2, bz2, "common/caulk", 512);

  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      if (grid[gy][gx] === CELL_SOLID) continue;

      const tex = texForCell(gy, gx);
      const x1 = ox + gx * CELL;
      const y1 = oy + gy * CELL;
      const x2 = x1 + CELL;
      const y2 = y1 + CELL;

      map += `// brush ${brushNum++}\n`;
      map += block(x1, y1, -WALL_THICK, x2, y2, 0, { top: tex.floor });

      map += `// brush ${brushNum++}\n`;
      map += block(x1, y1, ROOM_HEIGHT, x2, y2, ROOM_HEIGHT + WALL_THICK, { bottom: tex.ceiling });

      if (gy === 0 || grid[gy - 1][gx] === CELL_SOLID) {
        map += `// brush ${brushNum++}\n`;
        map += block(x1, y1 - WALL_THICK, 0, x2, y1, ROOM_HEIGHT, { north: tex.wall });
      }
      if (gy === GRID - 1 || grid[gy + 1][gx] === CELL_SOLID) {
        map += `// brush ${brushNum++}\n`;
        map += block(x1, y2, 0, x2, y2 + WALL_THICK, ROOM_HEIGHT, { south: tex.wall });
      }
      if (gx === 0 || grid[gy][gx - 1] === CELL_SOLID) {
        map += `// brush ${brushNum++}\n`;
        map += block(x1 - WALL_THICK, y1, 0, x1, y2, ROOM_HEIGHT, { east: tex.wall });
      }
      if (gx === GRID - 1 || grid[gy][gx + 1] === CELL_SOLID) {
        map += `// brush ${brushNum++}\n`;
        map += block(x2, y1, 0, x2 + WALL_THICK, y2, ROOM_HEIGHT, { west: tex.wall });
      }
    }
  }

  // Build platform list for entity placement (each room as a platform)
  const platforms = rooms.map(r => ({
    x: ox + r.x * CELL,
    y: oy + r.y * CELL,
    z: 0,
    w: r.w * CELL,
    h: r.h * CELL,
  }));

  const { map: entMap, entNum, worldBrushes } = placeEntities(platforms, rng, 32);
  map += worldBrushes; // jump pad visuals in worldspawn
  map += "}\n"; // end worldspawn
  map += entMap;

  // Kill trigger below the floor
  let eNum = entNum;
  map += `// entity ${eNum++} - kill trigger\n{\n"classname" "trigger_hurt"\n"dmg" "1000"\n`;
  map += `// brush 0\n`;
  map += block(bx1, by1, bz1 - 64, bx2, by2, bz1 + 64, "common/trigger");
  map += "}\n";

  // Room lights
  for (const room of rooms) {
    const lx = ox + (room.x + Math.floor(room.w / 2)) * CELL + CELL / 2;
    const ly = oy + (room.y + Math.floor(room.h / 2)) * CELL + CELL / 2;
    const intensity = 400 + room.w * room.h * 12;
    map += `// entity ${eNum++}\n{\n"classname" "light"\n"origin" "${lx} ${ly} ${ROOM_HEIGHT - 16}"\n"light" "${intensity}"\n"_color" "1.0 0.9 0.8"\n}\n`;
  }

  // Corridor lights
  let corridorCount = 0;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      if (grid[gy][gx] === CELL_CORRIDOR) {
        corridorCount++;
        if (corridorCount % 4 === 0) {
          const cx = ox + gx * CELL + CELL / 2;
          const cy = oy + gy * CELL + CELL / 2;
          map += `// entity ${eNum++}\n{\n"classname" "light"\n"origin" "${cx} ${cy} ${ROOM_HEIGHT - 16}"\n"light" "250"\n"_color" "0.8 0.8 1.0"\n}\n`;
        }
      }
    }
  }

  return map;
}

// =============================================
// VERTICAL DUNGEON STYLE (multi-level rooms with stairs)
// =============================================

const VERT_HEIGHT = 512; // taller ceiling for vertical maps
const FLOOR_HEIGHTS = [0, 128, 256, 384]; // possible room floor levels
const STEP_SIZE = 16; // stair step height
const STEP_DEPTH = 32; // stair step depth

function verticalDungeonToMap(grid, rooms, centers, theme, rng) {
  let map = "";
  let brushNum = 0;

  // Assign each room a random floor height and textures
  const roomData = rooms.map((r) => ({
    z: FLOOR_HEIGHTS[Math.floor(rng() * FLOOR_HEIGHTS.length)],
    wall: theme.walls[Math.floor(rng() * theme.walls.length)],
    floor: theme.floors[Math.floor(rng() * theme.floors.length)],
    ceiling: theme.ceilings[Math.floor(rng() * theme.ceilings.length)],
  }));

  // Cell-to-room lookup
  const cellRoom = Array.from({ length: GRID }, () => new Array(GRID).fill(-1));
  for (let ri = 0; ri < rooms.length; ri++) {
    const r = rooms[ri];
    for (let gy = r.y; gy < r.y + r.h; gy++) {
      for (let gx = r.x; gx < r.x + r.w; gx++) {
        cellRoom[gy][gx] = ri;
      }
    }
  }

  // Get floor height for any cell (corridors interpolate between nearest rooms)
  function cellHeight(gy, gx) {
    const ri = cellRoom[gy][gx];
    if (ri >= 0) return roomData[ri].z;
    // Corridor — find nearest room
    let bestDist = Infinity, bestRi = 0;
    for (let i = 0; i < centers.length; i++) {
      const d = Math.abs(gx - centers[i].x) + Math.abs(gy - centers[i].y);
      if (d < bestDist) { bestDist = d; bestRi = i; }
    }
    return roomData[bestRi].z;
  }

  function texForCell(gy, gx) {
    const ri = cellRoom[gy][gx];
    if (ri >= 0) return roomData[ri];
    let bestDist = Infinity, bestRi = 0;
    for (let i = 0; i < centers.length; i++) {
      const d = Math.abs(gx - centers[i].x) + Math.abs(gy - centers[i].y);
      if (d < bestDist) { bestDist = d; bestRi = i; }
    }
    return roomData[bestRi];
  }

  map += `// entity 0\n{\n"classname" "worldspawn"\n"message" "q3mapgen arena"\n`;

  const ox = -(GRID * CELL) / 2;
  const oy = -(GRID * CELL) / 2;

  // Find map bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      if (grid[gy][gx] !== CELL_SOLID) {
        minX = Math.min(minX, ox + gx * CELL - WALL_THICK);
        minY = Math.min(minY, oy + gy * CELL - WALL_THICK);
        maxX = Math.max(maxX, ox + (gx + 1) * CELL + WALL_THICK);
        maxY = Math.max(maxY, oy + (gy + 1) * CELL + WALL_THICK);
      }
    }
  }

  // Sealing box
  const bx1 = minX - BOX_PAD, by1 = minY - BOX_PAD;
  const bx2 = maxX + BOX_PAD, by2 = maxY + BOX_PAD;
  const bz1 = -WALL_THICK - BOX_PAD, bz2 = VERT_HEIGHT + 384 + WALL_THICK + BOX_PAD;
  map += `// sealing box\n`;
  for (let bi = 0; bi < 6; bi++) brushNum++;
  map += sealingBox(bx1, by1, bz1, bx2, by2, bz2, "common/caulk", 512);

  // Generate room/corridor geometry
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      if (grid[gy][gx] === CELL_SOLID) continue;

      const tex = texForCell(gy, gx);
      const floorZ = cellHeight(gy, gx);
      const x1 = ox + gx * CELL;
      const y1 = oy + gy * CELL;
      const x2 = x1 + CELL;
      const y2 = y1 + CELL;
      const ceilZ = floorZ + VERT_HEIGHT;

      // Floor — extends all the way down to seal gaps between heights
      map += `// brush ${brushNum++}\n`;
      map += block(x1, y1, -128, x2, y2, floorZ, { top: tex.floor, north: tex.wall, south: tex.wall, east: tex.wall, west: tex.wall });

      // Ceiling
      map += `// brush ${brushNum++}\n`;
      map += block(x1, y1, ceilZ, x2, y2, ceilZ + WALL_THICK, { bottom: tex.ceiling });

      // Walls — extend from lowest possible neighbor floor to ceiling
      const adjFloors = [];
      if (gy > 0 && grid[gy-1][gx] !== CELL_SOLID) adjFloors.push(cellHeight(gy-1, gx));
      if (gy < GRID-1 && grid[gy+1][gx] !== CELL_SOLID) adjFloors.push(cellHeight(gy+1, gx));
      if (gx > 0 && grid[gy][gx-1] !== CELL_SOLID) adjFloors.push(cellHeight(gy, gx-1));
      if (gx < GRID-1 && grid[gy][gx+1] !== CELL_SOLID) adjFloors.push(cellHeight(gy, gx+1));
      const wallBase = Math.min(floorZ, ...adjFloors, 0);

      if (gy === 0 || grid[gy - 1][gx] === CELL_SOLID) {
        map += `// brush ${brushNum++}\n`;
        map += block(x1, y1 - WALL_THICK, wallBase, x2, y1, ceilZ, { north: tex.wall });
      }
      if (gy === GRID - 1 || grid[gy + 1][gx] === CELL_SOLID) {
        map += `// brush ${brushNum++}\n`;
        map += block(x1, y2, wallBase, x2, y2 + WALL_THICK, ceilZ, { south: tex.wall });
      }
      if (gx === 0 || grid[gy][gx - 1] === CELL_SOLID) {
        map += `// brush ${brushNum++}\n`;
        map += block(x1 - WALL_THICK, y1, wallBase, x1, y2, ceilZ, { east: tex.wall });
      }
      if (gx === GRID - 1 || grid[gy][gx + 1] === CELL_SOLID) {
        map += `// brush ${brushNum++}\n`;
        map += block(x2, y1, wallBase, x2 + WALL_THICK, y2, ceilZ, { west: tex.wall });
      }

      // Stairs where corridor cells transition between heights
      if (grid[gy][gx] === CELL_CORRIDOR) {
        const neighbors = [
          [gy - 1, gx, "y", y1],
          [gy + 1, gx, "y", y2],
          [gy, gx - 1, "x", x1],
          [gy, gx + 1, "x", x2],
        ];

        for (const [ny, nx, axis, edge] of neighbors) {
          if (ny < 0 || ny >= GRID || nx < 0 || nx >= GRID) continue;
          if (grid[ny][nx] === CELL_SOLID) continue;

          const neighborZ = cellHeight(ny, nx);
          const dz = neighborZ - floorZ;
          if (Math.abs(dz) < STEP_SIZE) continue;

          const numSteps = Math.abs(Math.round(dz / STEP_SIZE));
          const stepH = dz / numSteps;

          if (axis === "y") {
            const stairDepth = CELL / numSteps;
            for (let s = 0; s < numSteps; s++) {
              const sz = floorZ + s * stepH;
              const nextZ = floorZ + (s + 1) * stepH;
              const topZ = Math.max(sz, nextZ);
              let sy1, sy2;
              if (dz > 0 === (ny > gy)) {
                sy1 = y1 + s * stairDepth;
                sy2 = sy1 + stairDepth;
              } else {
                sy2 = y2 - s * stairDepth;
                sy1 = sy2 - stairDepth;
              }
              map += `// stair ${brushNum++}\n`;
              map += block(x1, sy1, floorZ - 64, x2, sy2, topZ, { top: tex.floor, north: tex.wall, south: tex.wall, east: tex.wall, west: tex.wall });
            }
          } else {
            const stairDepth = CELL / numSteps;
            for (let s = 0; s < numSteps; s++) {
              const sz = floorZ + s * stepH;
              const nextZ = floorZ + (s + 1) * stepH;
              const topZ = Math.max(sz, nextZ);
              let sx1, sx2;
              if (dz > 0 === (nx > gx)) {
                sx1 = x1 + s * stairDepth;
                sx2 = sx1 + stairDepth;
              } else {
                sx2 = x2 - s * stairDepth;
                sx1 = sx2 - stairDepth;
              }
              map += `// stair ${brushNum++}\n`;
              map += block(sx1, y1, floorZ - 64, sx2, y2, topZ, { top: tex.floor, north: tex.wall, south: tex.wall, east: tex.wall, west: tex.wall });
            }
          }
        }
      }
    }
  }

  // Raised platforms inside larger rooms (50% chance for rooms >= 5 cells)
  for (let ri = 0; ri < rooms.length; ri++) {
    const r = rooms[ri];
    if (r.w * r.h < 20 || rng() < 0.5) continue;

    const tex = roomData[ri];
    const platW = Math.floor(r.w / 2) * CELL;
    const platH = Math.floor(r.h / 2) * CELL;
    const px = ox + (r.x + Math.floor((r.w - r.w / 2) / 2)) * CELL;
    const py = oy + (r.y + Math.floor((r.h - r.h / 2) / 2)) * CELL;
    const platZ = tex.z + 128 + Math.floor(rng() * 2) * 64;

    map += `// raised platform room ${ri}\n// brush ${brushNum++}\n`;
    map += block(px, py, platZ - 32, px + platW, py + platH, platZ, {
      top: tex.floor,
      bottom: tex.wall,
      north: tex.wall,
      south: tex.wall,
      east: tex.wall,
      west: tex.wall,
    });
  }

  // Build platform list for entity placement
  const platforms = rooms.map((r, ri) => ({
    x: ox + r.x * CELL,
    y: oy + r.y * CELL,
    z: roomData[ri].z,
    w: r.w * CELL,
    h: r.h * CELL,
  }));

  const { map: entMap, entNum, worldBrushes } = placeEntities(platforms, rng, 32);
  map += worldBrushes;
  map += "}\n"; // end worldspawn
  map += entMap;

  // Kill trigger below lowest floor
  let eNum = entNum;
  const killZ = -128;
  map += `// entity ${eNum++} - kill trigger\n{\n"classname" "trigger_hurt"\n"dmg" "1000"\n`;
  map += `// brush 0\n`;
  map += block(bx1, by1, killZ - CELL, bx2, by2, killZ, "common/trigger");
  map += "}\n";

  // Lights — scale intensity with room size and height
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const floorZ = roomData[ri].z;
    const lx = ox + (room.x + Math.floor(room.w / 2)) * CELL + CELL / 2;
    const ly = oy + (room.y + Math.floor(room.h / 2)) * CELL + CELL / 2;
    const intensity = 500 + room.w * room.h * 10;
    map += `// entity ${eNum++}\n{\n"classname" "light"\n"origin" "${lx} ${ly} ${floorZ + VERT_HEIGHT - 16}"\n"light" "${intensity}"\n"_color" "1.0 0.9 0.8"\n}\n`;
    // Second light lower for vertical illumination
    map += `// entity ${eNum++}\n{\n"classname" "light"\n"origin" "${lx} ${ly} ${floorZ + VERT_HEIGHT / 2}"\n"light" "${Math.floor(intensity * 0.5)}"\n"_color" "0.9 0.85 0.8"\n}\n`;
  }

  // Corridor lights
  let corridorCount = 0;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      if (grid[gy][gx] === CELL_CORRIDOR) {
        corridorCount++;
        if (corridorCount % 3 === 0) {
          const floorZ = cellHeight(gy, gx);
          const cx = ox + gx * CELL + CELL / 2;
          const cy = oy + gy * CELL + CELL / 2;
          map += `// entity ${eNum++}\n{\n"classname" "light"\n"origin" "${cx} ${cy} ${floorZ + VERT_HEIGHT - 16}"\n"light" "300"\n"_color" "0.8 0.8 1.0"\n}\n`;
        }
      }
    }
  }

  return map;
}

// =============================================
// PLATFORM STYLE (q3dm17 floating platforms in void)
// =============================================

function generatePlatforms(rng) {
  const platforms = [];
  const numPlatforms = 6 + Math.floor(rng() * 4); // 6-9 platforms
  let attempts = 0;

  // Tighter placement area for denser layouts (like q3dm17)
  const span = Math.floor(GRID * CELL * 0.5);

  while (platforms.length < numPlatforms && attempts < 300) {
    attempts++;
    // Platform size: 3-6 cells
    const pw = (3 + Math.floor(rng() * 4)) * CELL;
    const ph = (3 + Math.floor(rng() * 4)) * CELL;
    // Snap to 64-unit grid for clean AAS
    const px = Math.round((-span / 2 + Math.floor(rng() * (span - pw))) / 64) * 64;
    const py = Math.round((-span / 2 + Math.floor(rng() * (span - ph))) / 64) * 64;
    // Varying heights for verticality (like q3dm17)
    const pz = Math.floor(rng() * 3) * 128; // 0, 128, 256

    // Check overlap (smaller gap = denser layout)
    const minGap = CELL;
    let overlap = false;
    for (const p of platforms) {
      if (
        px < p.x + p.w + minGap && px + pw + minGap > p.x &&
        py < p.y + p.h + minGap && py + ph + minGap > p.y &&
        Math.abs(pz - p.z) < 192
      ) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;

    platforms.push({ x: px, y: py, z: pz, w: pw, h: ph });
  }

  return platforms;
}

function platformsToMap(platforms, theme, rng) {
  let map = "";
  let brushNum = 0;

  map += `// entity 0\n{\n"classname" "worldspawn"\n"message" "q3mapgen arena"\n`;

  // Compute bounds
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of platforms) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
    maxZ = Math.max(maxZ, p.z);
  }

  // Sky box enclosing everything (tight to keep AAS manageable)
  const skyPad = CELL * 2;
  const bx1 = minX - skyPad, by1 = minY - skyPad;
  const bx2 = maxX + skyPad, by2 = maxY + skyPad;
  const bz1 = minZ - CELL * 3; // void below for falling
  const bz2 = maxZ + ROOM_HEIGHT + skyPad;

  map += `// sky box\n`;
  for (let bi = 0; bi < 6; bi++) brushNum++;
  map += sealingBox(bx1, by1, bz1, bx2, by2, bz2, theme.sky, 64);

  // Per-platform textures
  const platTextures = platforms.map(() => ({
    wall: theme.walls[Math.floor(rng() * theme.walls.length)],
    floor: theme.floors[Math.floor(rng() * theme.floors.length)],
    trim: theme.walls[Math.floor(rng() * theme.walls.length)],
  }));

  // Generate platform brushes
  for (let pi = 0; pi < platforms.length; pi++) {
    const p = platforms[pi];
    const tex = platTextures[pi];
    const platThick = 64; // thick platforms like q3dm17

    // Platform top surface (walkable)
    map += `// platform ${pi} floor\n// brush ${brushNum++}\n`;
    map += block(p.x, p.y, p.z - platThick, p.x + p.w, p.y + p.h, p.z, {
      top: tex.floor,
      bottom: tex.wall,
      north: tex.wall,
      south: tex.wall,
      east: tex.wall,
      west: tex.wall,
    });

    // Optional railings/pillars on some platforms (25% chance)
    if (rng() < 0.25) {
      const pillarSize = 32;
      const pillarHeight = 96;
      const corners = [
        [p.x, p.y],
        [p.x + p.w - pillarSize, p.y],
        [p.x, p.y + p.h - pillarSize],
        [p.x + p.w - pillarSize, p.y + p.h - pillarSize],
      ];
      for (const [cx, cy] of corners) {
        map += `// brush ${brushNum++}\n`;
        map += block(cx, cy, p.z, cx + pillarSize, cy + pillarSize, p.z + pillarHeight, tex.trim);
      }
    }
  }

  // Generate bridges using Prim's MST to guarantee all platforms connected
  const bridgeWidth = 160;
  const bridgeThick = 32;
  const edges = [];

  // Prim's MST
  const n = platforms.length;
  const inMST = new Array(n).fill(false);
  inMST[0] = true;
  let mstCount = 1;

  while (mstCount < n) {
    let bestDist = Infinity, bestFrom = -1, bestTo = -1;
    for (let i = 0; i < n; i++) {
      if (!inMST[i]) continue;
      for (let j = 0; j < n; j++) {
        if (inMST[j]) continue;
        const dx = (platforms[i].x + platforms[i].w / 2) - (platforms[j].x + platforms[j].w / 2);
        const dy = (platforms[i].y + platforms[i].h / 2) - (platforms[j].y + platforms[j].h / 2);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) { bestDist = dist; bestFrom = i; bestTo = j; }
      }
    }
    if (bestTo === -1) break;
    inMST[bestTo] = true;
    edges.push([bestFrom, bestTo]);
    mstCount++;
  }

  // Add 2-3 extra edges for loops
  const extraBridges = 2 + Math.floor(rng() * 2);
  for (let e = 0; e < extraBridges; e++) {
    const i = Math.floor(rng() * n);
    const j = Math.floor(rng() * n);
    if (i !== j) edges.push([i, j]);
  }

  // Build L-shaped bridges for each edge
  for (const [from, to] of edges) {
    const a = platforms[from], b = platforms[to];
    const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
    const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
    const bridgeZ = Math.min(a.z, b.z);
    const bTex = {
      top: platTextures[from].floor, bottom: platTextures[from].wall,
      north: platTextures[from].wall, south: platTextures[from].wall,
      east: platTextures[from].wall, west: platTextures[from].wall,
    };
    const hw = bridgeWidth / 2;

    const midX = bcx, midY = acy;

    const hx1 = Math.min(acx, midX), hx2 = Math.max(acx, midX);
    if (hx2 - hx1 > 16) {
      map += `// bridge ${from}-${to} horiz\n// brush ${brushNum++}\n`;
      map += block(hx1, acy - hw, bridgeZ - bridgeThick, hx2, acy + hw, bridgeZ, bTex);
    }

    const vy1 = Math.min(acy, bcy), vy2 = Math.max(acy, bcy);
    if (vy2 - vy1 > 16) {
      map += `// bridge ${from}-${to} vert\n// brush ${brushNum++}\n`;
      map += block(bcx - hw, vy1, bridgeZ - bridgeThick, bcx + hw, vy2, bridgeZ, bTex);
    }
  }

  // Entities
  const { map: entMap, entNum, worldBrushes } = placeEntities(platforms, rng, 32);
  map += worldBrushes;
  map += "}\n"; // end worldspawn
  map += entMap;

  // trigger_hurt at the bottom of the void (kills fallers)
  let eNum = entNum;
  const killZ = minZ - CELL * 2;
  map += `// entity ${eNum++} - kill trigger\n{\n"classname" "trigger_hurt"\n"dmg" "1000"\n`;
  map += `// brush 0\n`;
  map += block(bx1, by1, killZ - CELL, bx2, by2, killZ, "common/trigger");
  map += "}\n";

  // Lights — one above each platform + ambient from sky
  for (let pi = 0; pi < platforms.length; pi++) {
    const p = platforms[pi];
    const lx = p.x + Math.floor(p.w / 2);
    const ly = p.y + Math.floor(p.h / 2);
    const intensity = 300 + Math.floor((p.w * p.h) / 500);
    map += `// entity ${eNum++}\n{\n"classname" "light"\n"origin" "${lx} ${ly} ${p.z + 256}"\n"light" "${intensity}"\n"_color" "1.0 0.95 0.9"\n}\n`;
  }

  return map;
}

// =============================================
// CTF STYLE (symmetric two-base map)
// =============================================

function generateCTF(rng, theme) {
  let map = "";
  let brushNum = 0;
  const halfLen = CELL * 12; // half the map length (bigger for team play)
  const mapW = CELL * 8; // map width
  const hw = mapW / 2;

  map += `// entity 0\n{\n"classname" "worldspawn"\n"message" "q3mapgen ctf"\n`;

  // Sealing box
  const bx1 = -halfLen - CELL * 2, by1 = -hw - CELL * 2;
  const bx2 = halfLen + CELL * 2, by2 = hw + CELL * 2;
  const bz1 = -128, bz2 = ROOM_HEIGHT + 128;
  map += sealingBox(bx1, by1, bz1, bx2, by2, bz2, "common/caulk", 512);
  brushNum += 6;

  const wallTex = theme.walls[Math.floor(rng() * theme.walls.length)];
  const floorTex = theme.floors[Math.floor(rng() * theme.floors.length)];
  const ceilTex = theme.ceilings[Math.floor(rng() * theme.ceilings.length)];
  const wallTex2 = theme.walls[Math.floor(rng() * theme.walls.length)];
  const floorTex2 = theme.floors[Math.floor(rng() * theme.floors.length)];

  // Build symmetric map: red base (-X) | middle | blue base (+X)
  const sections = [
    { x1: -halfLen, y1: -CELL * 2, x2: -halfLen + CELL * 3, y2: CELL * 2, z: 0, ft: floorTex, wt: wallTex },
    { x1: -halfLen + CELL * 3, y1: -CELL, x2: -CELL * 2, y2: CELL, z: 0, ft: floorTex2, wt: wallTex2 },
    { x1: -CELL * 2, y1: -hw, x2: CELL * 2, y2: hw, z: 0, ft: floorTex, wt: wallTex },
    { x1: CELL * 2, y1: -CELL, x2: halfLen - CELL * 3, y2: CELL, z: 0, ft: floorTex2, wt: wallTex2 },
    { x1: halfLen - CELL * 3, y1: -CELL * 2, x2: halfLen, y2: CELL * 2, z: 0, ft: floorTex, wt: wallTex },
  ];

  // Side corridors (flanking routes)
  sections.push(
    { x1: -halfLen + CELL * 2, y1: -hw, x2: -CELL * 2, y2: -hw + CELL * 2, z: 0, ft: floorTex2, wt: wallTex },
    { x1: -halfLen + CELL * 2, y1: hw - CELL * 2, x2: -CELL * 2, y2: hw, z: 0, ft: floorTex2, wt: wallTex },
    { x1: CELL * 2, y1: -hw, x2: halfLen - CELL * 2, y2: -hw + CELL * 2, z: 0, ft: floorTex2, wt: wallTex },
    { x1: CELL * 2, y1: hw - CELL * 2, x2: halfLen - CELL * 2, y2: hw, z: 0, ft: floorTex2, wt: wallTex },
  );

  // Raised platform in middle
  sections.push(
    { x1: -CELL, y1: -CELL, x2: CELL, y2: CELL, z: 128, ft: floorTex, wt: wallTex },
  );

  // Base floor covering entire map
  map += `// base floor\n// brush ${brushNum++}\n`;
  map += block(-halfLen, -hw, -128, halfLen, hw, 0, { top: floorTex });
  map += `// base ceiling\n// brush ${brushNum++}\n`;
  map += block(-halfLen, -hw, ROOM_HEIGHT, halfLen, hw, ROOM_HEIGHT + WALL_THICK, { bottom: ceilTex });

  // Generate brushes for raised sections
  for (const s of sections) {
    if (s.z <= 0) continue;
    map += `// brush ${brushNum++}\n`;
    map += block(s.x1, s.y1, 0, s.x2, s.y2, s.z, { top: s.ft, north: s.wt, south: s.wt, east: s.wt, west: s.wt });
    map += `// brush ${brushNum++}\n`;
    map += block(s.x1, s.y1, s.z + ROOM_HEIGHT, s.x2, s.y2, s.z + ROOM_HEIGHT + WALL_THICK, { bottom: ceilTex });
  }

  // Outer walls
  let minSX = Infinity, minSY = Infinity, maxSX = -Infinity, maxSY = -Infinity;
  for (const s of sections) {
    minSX = Math.min(minSX, s.x1); minSY = Math.min(minSY, s.y1);
    maxSX = Math.max(maxSX, s.x2); maxSY = Math.max(maxSY, s.y2);
  }
  map += `// brush ${brushNum++}\n`; map += block(minSX, minSY - WALL_THICK, 0, maxSX, minSY, ROOM_HEIGHT, { north: wallTex });
  map += `// brush ${brushNum++}\n`; map += block(minSX, maxSY, 0, maxSX, maxSY + WALL_THICK, ROOM_HEIGHT, { south: wallTex });
  map += `// brush ${brushNum++}\n`; map += block(minSX - WALL_THICK, minSY, 0, minSX, maxSY, ROOM_HEIGHT, { east: wallTex });
  map += `// brush ${brushNum++}\n`; map += block(maxSX, minSY, 0, maxSX + WALL_THICK, maxSY, ROOM_HEIGHT, { west: wallTex });

  // Jump pad visual brushes (must be in worldspawn)
  const ctfJp1 = jumpPadEntities(9990, -CELL, -CELL, 0, 0, 0, 192, 64);
  const ctfJp2 = jumpPadEntities(9992, CELL, CELL, 0, 0, 0, 192, 64);
  map += `// jump pad visuals\n${ctfJp1.worldBrushes}${ctfJp2.worldBrushes}`;

  map += "}\n"; // end worldspawn

  let entNum = 1;

  // CTF Flags
  const redFlagX = -halfLen + CELL;
  const blueFlagX = halfLen - CELL;
  map += `// entity ${entNum++}\n{\n"classname" "team_CTF_redflag"\n"origin" "${redFlagX} 0 16"\n}\n`;
  map += `// entity ${entNum++}\n{\n"classname" "team_CTF_blueflag"\n"origin" "${blueFlagX} 0 16"\n}\n`;

  // Red team spawns
  const redSpawnSpots = [
    [redFlagX + CELL, CELL * 1.5, 0],
    [redFlagX + CELL, -CELL * 1.5, 0],
    [redFlagX + CELL * 2, CELL, 0],
    [redFlagX + CELL * 2, -CELL, 0],
    [redFlagX + CELL * 3, 0, 0],
    [redFlagX + CELL * 3, CELL * 2, 0],
    [redFlagX + CELL * 3, -CELL * 2, 0],
    [redFlagX + CELL * 4, CELL, 45],
  ];
  for (const [sx, sy, angle] of redSpawnSpots) {
    map += `// entity ${entNum++}\n{\n"classname" "team_CTF_redspawn"\n"origin" "${sx} ${sy} 32"\n"angle" "${angle}"\n}\n`;
    map += `// entity ${entNum++}\n{\n"classname" "info_player_deathmatch"\n"origin" "${sx} ${sy} 32"\n"angle" "${angle}"\n}\n`;
  }

  // Blue team spawns
  const blueSpawnSpots = [
    [blueFlagX - CELL, CELL * 1.5, 180],
    [blueFlagX - CELL, -CELL * 1.5, 180],
    [blueFlagX - CELL * 2, CELL, 180],
    [blueFlagX - CELL * 2, -CELL, 180],
    [blueFlagX - CELL * 3, 0, 180],
    [blueFlagX - CELL * 3, CELL * 2, 180],
    [blueFlagX - CELL * 3, -CELL * 2, 180],
    [blueFlagX - CELL * 4, -CELL, 225],
  ];
  for (const [sx, sy, angle] of blueSpawnSpots) {
    map += `// entity ${entNum++}\n{\n"classname" "team_CTF_bluespawn"\n"origin" "${sx} ${sy} 32"\n"angle" "${angle}"\n}\n`;
    map += `// entity ${entNum++}\n{\n"classname" "info_player_deathmatch"\n"origin" "${sx} ${sy} 32"\n"angle" "${angle}"\n}\n`;
  }

  // Weapons
  const midWeapons = [...WEAPONS].sort(() => rng() - 0.5).slice(0, 4);
  const positions = [
    [0, hw - CELL, 16], [0, -hw + CELL, 16],
    [-CELL * 3, 0, 16], [CELL * 3, 0, 16],
  ];
  for (let i = 0; i < midWeapons.length; i++) {
    const [wx, wy, wz] = positions[i];
    map += `// entity ${entNum++}\n{\n"classname" "${midWeapons[i]}"\n"origin" "${wx} ${wy} ${wz}"\n}\n`;
    const ammo = AMMO_FOR[midWeapons[i]];
    if (ammo) map += `// entity ${entNum++}\n{\n"classname" "${ammo}"\n"origin" "${wx + 48} ${wy} ${wz}"\n}\n`;
  }

  // Quad damage on the raised middle platform
  map += `// entity ${entNum++}\n{\n"classname" "item_quad"\n"origin" "0 0 ${128 + 16}"\n}\n`;

  // Health along corridors
  for (let i = 0; i < 8; i++) {
    const hx = -halfLen + CELL * 2 + Math.floor(rng() * (halfLen * 2 - CELL * 4));
    const hy = Math.floor(rng() * mapW) - hw;
    map += `// entity ${entNum++}\n{\n"classname" "item_health"\n"origin" "${hx} ${hy} 16"\n}\n`;
  }

  // Yellow armor in each base approach
  map += `// entity ${entNum++}\n{\n"classname" "item_armor_combat"\n"origin" "${-CELL * 3} ${-CELL} 16"\n}\n`;
  map += `// entity ${entNum++}\n{\n"classname" "item_armor_combat"\n"origin" "${CELL * 3} ${CELL} 16"\n}\n`;

  // Jump pad trigger entities
  const jp1r = jumpPadEntities(entNum, -CELL, -CELL, 0, 0, 0, 192, 64);
  map += jp1r.map; entNum += jp1r.count;
  const jp2r = jumpPadEntities(entNum, CELL, CELL, 0, 0, 0, 192, 64);
  map += jp2r.map; entNum += jp2r.count;

  // Lights
  const lightPositions = [
    [redFlagX, 0], [blueFlagX, 0], [0, 0],
    [-CELL * 4, 0], [CELL * 4, 0],
    [0, hw - CELL], [0, -hw + CELL],
  ];
  for (const [lx, ly] of lightPositions) {
    map += `// entity ${entNum++}\n{\n"classname" "light"\n"origin" "${lx} ${ly} ${ROOM_HEIGHT - 16}"\n"light" "1000"\n"_color" "1.0 0.95 0.9"\n}\n`;
    map += `// entity ${entNum++}\n{\n"classname" "light"\n"origin" "${lx} ${ly} ${ROOM_HEIGHT / 2}"\n"light" "500"\n"_color" "1.0 0.95 0.9"\n}\n`;
  }

  // Kill trigger
  map += `// entity ${entNum++} - kill trigger\n{\n"classname" "trigger_hurt"\n"dmg" "1000"\n`;
  map += block(-halfLen - CELL, -hw - CELL, -256, halfLen + CELL, hw + CELL, -130, "common/trigger");
  map += "}\n";

  return map;
}

// =============================================
// TOURNEY STYLE (small tight 1v1 map)
// =============================================

function generateTourney(rng, theme) {
  const TG = 16;
  const grid = Array.from({ length: TG }, () => new Array(TG).fill(CELL_SOLID));
  const rooms = [];

  // 3-4 small rooms
  const numRooms = 3 + Math.floor(rng() * 2);
  let attempts = 0;
  while (rooms.length < numRooms && attempts < 100) {
    attempts++;
    const w = 3 + Math.floor(rng() * 3);
    const h = 3 + Math.floor(rng() * 3);
    const x = 1 + Math.floor(rng() * (TG - w - 2));
    const y = 1 + Math.floor(rng() * (TG - h - 2));
    let overlap = false;
    for (const r of rooms) {
      if (x < r.x + r.w + 1 && x + w + 1 > r.x && y < r.y + r.h + 1 && y + h + 1 > r.y) { overlap = true; break; }
    }
    if (overlap) continue;
    rooms.push({ x, y, w, h });
    for (let gy = y; gy < y + h; gy++) for (let gx = x; gx < x + w; gx++) grid[gy][gx] = CELL_ROOM;
  }

  const centers = rooms.map(r => ({ x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) }));

  // MST connectivity
  const n = rooms.length;
  const inMST = new Array(n).fill(false);
  const edges = [];
  inMST[0] = true;
  let mstCount = 1;
  while (mstCount < n) {
    let bestDist = Infinity, bestFrom = -1, bestTo = -1;
    for (let i = 0; i < n; i++) {
      if (!inMST[i]) continue;
      for (let j = 0; j < n; j++) {
        if (inMST[j]) continue;
        const dist = Math.abs(centers[i].x - centers[j].x) + Math.abs(centers[i].y - centers[j].y);
        if (dist < bestDist) { bestDist = dist; bestFrom = i; bestTo = j; }
      }
    }
    if (bestTo === -1) break;
    inMST[bestTo] = true;
    edges.push([bestFrom, bestTo]);
    mstCount++;
  }
  edges.push([Math.floor(rng() * n), Math.floor(rng() * n)]);

  for (const [from, to] of edges) {
    const a = centers[from], b = centers[to];
    for (let gx = Math.min(a.x, b.x); gx <= Math.max(a.x, b.x); gx++) {
      if (grid[a.y][gx] === CELL_SOLID) grid[a.y][gx] = CELL_CORRIDOR;
    }
    for (let gy = Math.min(a.y, b.y); gy <= Math.max(a.y, b.y); gy++) {
      if (grid[gy][b.x] === CELL_SOLID) grid[gy][b.x] = CELL_CORRIDOR;
    }
  }

  let map = "";
  let brushNum = 0;
  const ox = -(TG * CELL) / 2, oy = -(TG * CELL) / 2;

  const roomTextures = rooms.map(() => ({
    wall: theme.walls[Math.floor(rng() * theme.walls.length)],
    floor: theme.floors[Math.floor(rng() * theme.floors.length)],
    ceiling: theme.ceilings[Math.floor(rng() * theme.ceilings.length)],
  }));

  const cellRoom = Array.from({ length: TG }, () => new Array(TG).fill(-1));
  for (let ri = 0; ri < rooms.length; ri++) {
    const r = rooms[ri];
    for (let gy = r.y; gy < r.y + r.h; gy++) for (let gx = r.x; gx < r.x + r.w; gx++) cellRoom[gy][gx] = ri;
  }

  function texForCell(gy, gx) {
    const ri = cellRoom[gy][gx];
    if (ri >= 0) return roomTextures[ri];
    let bestDist = Infinity, bestRi = 0;
    for (let i = 0; i < centers.length; i++) {
      const d = Math.abs(gx - centers[i].x) + Math.abs(gy - centers[i].y);
      if (d < bestDist) { bestDist = d; bestRi = i; }
    }
    return roomTextures[bestRi];
  }

  map += `// entity 0\n{\n"classname" "worldspawn"\n"message" "q3mapgen tourney"\n`;

  // Sealing box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let gy = 0; gy < TG; gy++) for (let gx = 0; gx < TG; gx++) {
    if (grid[gy][gx] !== CELL_SOLID) {
      minX = Math.min(minX, ox + gx * CELL); minY = Math.min(minY, oy + gy * CELL);
      maxX = Math.max(maxX, ox + (gx + 1) * CELL); maxY = Math.max(maxY, oy + (gy + 1) * CELL);
    }
  }
  map += sealingBox(minX - BOX_PAD, minY - BOX_PAD, -128 - BOX_PAD, maxX + BOX_PAD, maxY + BOX_PAD, ROOM_HEIGHT + BOX_PAD, "common/caulk", 512);
  brushNum += 6;

  for (let gy = 0; gy < TG; gy++) {
    for (let gx = 0; gx < TG; gx++) {
      if (grid[gy][gx] === CELL_SOLID) continue;
      const tex = texForCell(gy, gx);
      const x1 = ox + gx * CELL, y1 = oy + gy * CELL, x2 = x1 + CELL, y2 = y1 + CELL;
      map += `// brush ${brushNum++}\n`;
      map += block(x1, y1, -WALL_THICK, x2, y2, 0, { top: tex.floor });
      map += `// brush ${brushNum++}\n`;
      map += block(x1, y1, ROOM_HEIGHT, x2, y2, ROOM_HEIGHT + WALL_THICK, { bottom: tex.ceiling });
      if (gy === 0 || grid[gy-1][gx] === CELL_SOLID) { map += `// brush ${brushNum++}\n`; map += block(x1, y1 - WALL_THICK, 0, x2, y1, ROOM_HEIGHT, { north: tex.wall }); }
      if (gy === TG-1 || grid[gy+1][gx] === CELL_SOLID) { map += `// brush ${brushNum++}\n`; map += block(x1, y2, 0, x2, y2 + WALL_THICK, ROOM_HEIGHT, { south: tex.wall }); }
      if (gx === 0 || grid[gy][gx-1] === CELL_SOLID) { map += `// brush ${brushNum++}\n`; map += block(x1 - WALL_THICK, y1, 0, x1, y2, ROOM_HEIGHT, { east: tex.wall }); }
      if (gx === TG-1 || grid[gy][gx+1] === CELL_SOLID) { map += `// brush ${brushNum++}\n`; map += block(x2, y1, 0, x2 + WALL_THICK, y2, ROOM_HEIGHT, { west: tex.wall }); }
    }
  }

  // Lava pit in the largest room
  const largestRoom = rooms.reduce((a, b) => a.w * a.h > b.w * b.h ? a : b);
  const lavaX = ox + (largestRoom.x + 1) * CELL;
  const lavaY = oy + (largestRoom.y + 1) * CELL;
  map += `// lava pit\n// brush ${brushNum++}\n`;
  map += lavaPit(lavaX, lavaY, -32, lavaX + CELL * 2, lavaY + CELL * 2, -2);

  map += "}\n"; // end worldspawn

  let entNum = 1;

  // Tourney spawns
  for (let i = 0; i < Math.min(4, rooms.length); i++) {
    const room = rooms[i];
    const sx = ox + (room.x + Math.floor(room.w / 2)) * CELL + CELL / 2;
    const sy = oy + (room.y + Math.floor(room.h / 2)) * CELL + CELL / 2 + (i % 2 === 0 ? 64 : -64);
    map += `// entity ${entNum++}\n{\n"classname" "info_player_deathmatch"\n"origin" "${sx} ${sy} 32"\n"angle" "${i * 90}"\n}\n`;
  }

  // Deliberate item placement: 1 RL, 1 LG, 1 YA, health
  const weps = ["weapon_rocketlauncher", "weapon_lightning"];
  for (let i = 0; i < weps.length; i++) {
    const room = rooms[i % rooms.length];
    const wx = ox + (room.x + Math.floor(room.w / 2)) * CELL + CELL / 2;
    const wy = oy + (room.y + Math.floor(room.h / 2)) * CELL + CELL / 2;
    map += `// entity ${entNum++}\n{\n"classname" "${weps[i]}"\n"origin" "${wx} ${wy} 16"\n}\n`;
    map += `// entity ${entNum++}\n{\n"classname" "${AMMO_FOR[weps[i]]}"\n"origin" "${wx + 48} ${wy} 16"\n}\n`;
  }

  // Yellow armor
  const midRoom = rooms[Math.floor(rooms.length / 2)];
  const ax = ox + (midRoom.x + Math.floor(midRoom.w / 2)) * CELL + CELL / 2;
  const ay = oy + (midRoom.y + Math.floor(midRoom.h / 2)) * CELL + CELL / 2;
  map += `// entity ${entNum++}\n{\n"classname" "item_armor_combat"\n"origin" "${ax} ${ay} 16"\n}\n`;

  // Health
  for (let i = 0; i < 4; i++) {
    const room = rooms[i % rooms.length];
    const hx = ox + (room.x + 1) * CELL + Math.floor(rng() * (room.w - 1)) * CELL / 2;
    const hy = oy + (room.y + 1) * CELL + Math.floor(rng() * (room.h - 1)) * CELL / 2;
    map += `// entity ${entNum++}\n{\n"classname" "item_health"\n"origin" "${hx} ${hy} 16"\n}\n`;
  }

  // Lava trigger_hurt
  map += `// entity ${entNum++} - lava damage\n{\n"classname" "trigger_hurt"\n"dmg" "50"\n`;
  map += block(lavaX, lavaY, -32, lavaX + CELL * 2, lavaY + CELL * 2, 0, "common/trigger");
  map += "}\n";

  // Kill trigger below map
  map += `// entity ${entNum++}\n{\n"classname" "trigger_hurt"\n"dmg" "1000"\n`;
  map += block(minX - BOX_PAD, minY - BOX_PAD, -128 - BOX_PAD - 64, maxX + BOX_PAD, maxY + BOX_PAD, -128 - BOX_PAD, "common/trigger");
  map += "}\n";

  // Lights
  for (const room of rooms) {
    const lx = ox + (room.x + Math.floor(room.w / 2)) * CELL + CELL / 2;
    const ly = oy + (room.y + Math.floor(room.h / 2)) * CELL + CELL / 2;
    const tIntensity = 600 + room.w * room.h * 15;
    map += `// entity ${entNum++}\n{\n"classname" "light"\n"origin" "${lx} ${ly} ${ROOM_HEIGHT - 16}"\n"light" "${tIntensity}"\n"_color" "1.0 0.9 0.8"\n}\n`;
    map += `// entity ${entNum++}\n{\n"classname" "light"\n"origin" "${lx} ${ly} ${ROOM_HEIGHT / 2}"\n"light" "${Math.floor(tIntensity * 0.5)}"\n"_color" "1.0 0.95 0.9"\n}\n`;
  }

  return map;
}

// =============================================
// ATRIUM STYLE (one big central room with balconies)
// =============================================

function generateAtrium(rng, theme) {
  let map = "";
  let brushNum = 0;

  const atriumW = CELL * 10;
  const atriumH = CELL * 10;
  const atriumZ = 512; // tall ceiling
  const hw = atriumW / 2, hh = atriumH / 2;

  const wallTex = theme.walls[Math.floor(rng() * theme.walls.length)];
  const wallTex2 = theme.walls[Math.floor(rng() * theme.walls.length)];
  const floorTex = theme.floors[Math.floor(rng() * theme.floors.length)];
  const ceilTex = theme.ceilings[Math.floor(rng() * theme.ceilings.length)];

  map += `// entity 0\n{\n"classname" "worldspawn"\n"message" "q3mapgen atrium"\n`;

  // Sealing box
  const bx1 = -hw - BOX_PAD, by1 = -hh - BOX_PAD;
  const bx2 = hw + BOX_PAD, by2 = hh + BOX_PAD;
  map += sealingBox(bx1, by1, -128 - BOX_PAD, bx2, by2, atriumZ + BOX_PAD, "common/caulk", 512);
  brushNum += 6;

  // Main floor
  map += `// brush ${brushNum++}\n`;
  map += block(-hw, -hh, -64, hw, hh, 0, { top: floorTex });
  // Ceiling
  map += `// brush ${brushNum++}\n`;
  map += block(-hw, -hh, atriumZ, hw, hh, atriumZ + WALL_THICK, { bottom: ceilTex });
  // 4 walls
  map += `// brush ${brushNum++}\n`; map += block(-hw, -hh - WALL_THICK, 0, hw, -hh, atriumZ, { north: wallTex });
  map += `// brush ${brushNum++}\n`; map += block(-hw, hh, 0, hw, hh + WALL_THICK, atriumZ, { south: wallTex });
  map += `// brush ${brushNum++}\n`; map += block(-hw - WALL_THICK, -hh, 0, -hw, hh, atriumZ, { east: wallTex });
  map += `// brush ${brushNum++}\n`; map += block(hw, -hh, 0, hw + WALL_THICK, hh, atriumZ, { west: wallTex });

  // Balconies on all 4 walls at height 192
  const balcZ = 192;
  const balcD = CELL * 2;
  const balcGap = CELL * 3;
  map += `// brush ${brushNum++}\n`; map += block(-hw, -hh, balcZ - 32, -balcGap / 2, -hh + balcD, balcZ, { top: floorTex, south: wallTex2, east: wallTex2, west: wallTex2 });
  map += `// brush ${brushNum++}\n`; map += block(balcGap / 2, -hh, balcZ - 32, hw, -hh + balcD, balcZ, { top: floorTex, south: wallTex2, east: wallTex2, west: wallTex2 });
  map += `// brush ${brushNum++}\n`; map += block(-hw, hh - balcD, balcZ - 32, -balcGap / 2, hh, balcZ, { top: floorTex, north: wallTex2, east: wallTex2, west: wallTex2 });
  map += `// brush ${brushNum++}\n`; map += block(balcGap / 2, hh - balcD, balcZ - 32, hw, hh, balcZ, { top: floorTex, north: wallTex2, east: wallTex2, west: wallTex2 });
  map += `// brush ${brushNum++}\n`; map += block(-hw, -hh + balcD, balcZ - 32, -hw + balcD, hh - balcD, balcZ, { top: floorTex, east: wallTex2 });
  map += `// brush ${brushNum++}\n`; map += block(hw - balcD, -hh + balcD, balcZ - 32, hw, hh - balcD, balcZ, { top: floorTex, west: wallTex2 });

  // Upper corner platforms at height 384
  const upZ = 384;
  const upD = CELL;
  const corners = [[-hw, -hh], [hw - upD * 2, -hh], [-hw, hh - upD * 2], [hw - upD * 2, hh - upD * 2]];
  for (const [cx, cy] of corners) {
    map += `// brush ${brushNum++}\n`;
    map += block(cx, cy, upZ - 32, cx + upD * 2, cy + upD * 2, upZ, { top: floorTex, north: wallTex, south: wallTex, east: wallTex, west: wallTex });
  }

  // Central pillar/platform
  const pillarSize = CELL * 2;
  map += `// brush ${brushNum++}\n`;
  map += block(-pillarSize / 2, -pillarSize / 2, 0, pillarSize / 2, pillarSize / 2, 96, { top: floorTex, north: wallTex, south: wallTex, east: wallTex, west: wallTex });

  // Pre-create jump pad visuals for worldspawn
  const atriumJpCorners = [
    [-hw + CELL, -hh + CELL, hw - CELL * 2, -hh + CELL],
    [hw - CELL, -hh + CELL, -hw + CELL * 2, -hh + CELL],
    [-hw + CELL, hh - CELL, hw - CELL * 2, hh - CELL],
    [hw - CELL, hh - CELL, -hw + CELL * 2, hh - CELL],
  ];
  for (const [jx, jy, lx, ly] of atriumJpCorners) {
    const jpPre = jumpPadEntities(9900, jx, jy, 0, lx, ly, balcZ + 64, 64);
    map += `// jump pad visual\n${jpPre.worldBrushes}`;
  }

  map += "}\n"; // end worldspawn

  let entNum = 1;

  // Spawns
  const spawnSpots = [
    [-hw + CELL, -hh + CELL, 32], [hw - CELL, hh - CELL, 32],
    [-hw + CELL, hh - CELL, 32], [hw - CELL, -hh + CELL, 32],
    [-hw + CELL, 0, balcZ + 32], [hw - CELL, 0, balcZ + 32],
    [0, -hh + CELL, balcZ + 32], [0, hh - CELL, balcZ + 32],
  ];
  for (const [sx, sy, sz] of spawnSpots) {
    map += `// entity ${entNum++}\n{\n"classname" "info_player_deathmatch"\n"origin" "${sx} ${sy} ${sz}"\n"angle" "${Math.floor(rng() * 360)}"\n}\n`;
  }

  // Weapons — spread across levels
  const weps = [...WEAPONS].sort(() => rng() - 0.5);
  const wepSpots = [
    [0, -hh + CELL, 16], [0, hh - CELL, 16],
    [-hw + CELL, 0, balcZ + 16], [hw - CELL, 0, balcZ + 16],
    [0, 0, 96 + 16],
  ];
  for (let i = 0; i < Math.min(weps.length, wepSpots.length); i++) {
    const [wx, wy, wz] = wepSpots[i];
    map += `// entity ${entNum++}\n{\n"classname" "${weps[i]}"\n"origin" "${wx} ${wy} ${wz}"\n}\n`;
    const ammo = AMMO_FOR[weps[i]];
    if (ammo) map += `// entity ${entNum++}\n{\n"classname" "${ammo}"\n"origin" "${wx + 48} ${wy} ${wz}"\n}\n`;
  }

  // Quad damage on central pillar top
  map += `// entity ${entNum++}\n{\n"classname" "item_quad"\n"origin" "0 0 ${96 + 16}"\n}\n`;
  // Red armor on upper corner platform (risky)
  map += `// entity ${entNum++}\n{\n"classname" "item_armor_body"\n"origin" "${-hw + upD} ${-hh + upD} ${upZ + 16}"\n}\n`;
  // Yellow armor on balcony
  map += `// entity ${entNum++}\n{\n"classname" "item_armor_combat"\n"origin" "${hw - CELL} ${0} ${balcZ + 16}"\n}\n`;

  // Health scattered
  for (let i = 0; i < 8; i++) {
    const hx = Math.floor(rng() * atriumW) - hw;
    const hy = Math.floor(rng() * atriumH) - hh;
    map += `// entity ${entNum++}\n{\n"classname" "item_health"\n"origin" "${hx} ${hy} 16"\n}\n`;
  }

  // Jump pads from ground to balcony level (4 corners)
  const jpCorners = [
    [-hw + CELL, -hh + CELL, hw - CELL * 2, -hh + CELL],
    [hw - CELL, -hh + CELL, -hw + CELL * 2, -hh + CELL],
    [-hw + CELL, hh - CELL, hw - CELL * 2, hh - CELL],
    [hw - CELL, hh - CELL, -hw + CELL * 2, hh - CELL],
  ];
  for (let i = 0; i < jpCorners.length; i++) {
    const [jx, jy, lx, ly] = jpCorners[i];
    const jp = jumpPadEntities(entNum, jx, jy, 0, lx, ly, balcZ + 64, 64);
    map += jp.map; entNum += jp.count;
  }

  // Teleporters between opposite upper corners
  const t1 = teleporterEntities(entNum, -hw + upD, -hh + upD, upZ, hw - upD, hh - upD, upZ, 135);
  map += t1.map; entNum += t1.count;
  const t2 = teleporterEntities(entNum, hw - upD, hh - upD, upZ, -hw + upD, -hh + upD, upZ, -45);
  map += t2.map; entNum += t2.count;

  // Lights
  for (let z = ROOM_HEIGHT / 3; z < atriumZ; z += ROOM_HEIGHT / 3) {
    map += `// entity ${entNum++}\n{\n"classname" "light"\n"origin" "0 0 ${z}"\n"light" "800"\n"_color" "1.0 0.95 0.9"\n}\n`;
  }
  for (const [cx, cy] of [[-hw + CELL, -hh + CELL], [hw - CELL, -hh + CELL], [-hw + CELL, hh - CELL], [hw - CELL, hh - CELL]]) {
    map += `// entity ${entNum++}\n{\n"classname" "light"\n"origin" "${cx} ${cy} ${ROOM_HEIGHT - 16}"\n"light" "500"\n"_color" "0.9 0.85 0.8"\n}\n`;
    map += `// entity ${entNum++}\n{\n"classname" "light"\n"origin" "${cx} ${cy} ${balcZ + 64}"\n"light" "400"\n"_color" "0.9 0.85 0.8"\n}\n`;
  }
  for (const bx of [-hw + balcD, hw - balcD]) {
    map += `// entity ${entNum++}\n{\n"classname" "light"\n"origin" "${bx} 0 ${balcZ + 64}"\n"light" "400"\n"_color" "0.8 0.8 1.0"\n}\n`;
  }

  // Kill trigger
  map += `// entity ${entNum++}\n{\n"classname" "trigger_hurt"\n"dmg" "1000"\n`;
  map += block(bx1, by1, -128 - BOX_PAD - 64, bx2, by2, -128 - BOX_PAD, "common/trigger");
  map += "}\n";

  return map;
}

// --- Debug print ---

function printGrid(grid, size) {
  const g = size || GRID;
  for (let gy = 0; gy < g; gy++) {
    let row = "";
    for (let gx = 0; gx < g; gx++) {
      row += grid[gy][gx] === CELL_SOLID ? "." : grid[gy][gx] === CELL_ROOM ? "#" : "+";
    }
    console.log("  " + row);
  }
}

// --- Arena file generation ---

function generateArenaFile(mapNames, styles) {
  let content = "";
  for (let i = 0; i < mapNames.length; i++) {
    const name = mapNames[i];
    const type = (styles && styles[i] === "ctf") ? "ctf" : "ffa";
    content += `{\nmap "${name}"\nlongname "q3mapgen - ${name}"\ntype "${type}"\nbots "Sarge"\n}\n`;
  }
  return content;
}

// --- Main ---

function main() {
  const args = process.argv.slice(2);

  // Parse --count and --complexity flags
  let mapCount = 8;
  let complexity = "normal"; // simple, normal, complex
  const seeds = [];
  for (const arg of args) {
    if (arg.startsWith("--count=")) { mapCount = parseInt(arg.split("=")[1]) || 8; continue; }
    if (arg.startsWith("--complexity=")) { complexity = arg.split("=")[1]; continue; }
    const n = parseInt(arg);
    if (!isNaN(n)) seeds.push(n);
  }

  // Default seeds
  const defaultSeeds = [42, 137, 256, 999, 777, 555, 888, 333];
  while (seeds.length < mapCount) seeds.push(defaultSeeds[seeds.length] || Math.floor(Math.random() * 10000));

  // Cycle through all styles
  const allStyles = ["dungeon", "platform", "vertical", "platform", "ctf", "tourney", "atrium", "platform"];
  const mapNames = [];
  const styles = [];
  for (let i = 0; i < mapCount; i++) {
    mapNames.push(`arena${i + 1}`);
    styles.push(allStyles[i % allStyles.length]);
  }

  // Adjust for complexity
  if (complexity === "simple") {
    for (let i = 0; i < mapCount; i++) styles[i] = ["dungeon", "platform"][i % 2];
  }

  console.log(`Generating ${mapCount} maps (complexity: ${complexity})`);
  console.log(`Styles: ${styles.join(", ")}`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });

  for (let i = 0; i < mapCount; i++) {
    const rng = mulberry32(seeds[i]);
    rng(); // consume one value
    const theme = THEMES[i % THEMES.length];
    const style = styles[i];

    let mapContent;

    if (style === "dungeon" || style === "vertical") {
      const { grid, rooms, centers } = generateDungeon(rng);
      console.log(`Arena ${i + 1} (seed=${seeds[i]}, theme=${theme.name}, style=${style}): ${rooms.length} rooms`);
      printGrid(grid);
      if (style === "vertical") {
        mapContent = verticalDungeonToMap(grid, rooms, centers, theme, rng);
      } else {
        mapContent = dungeonToMap(grid, rooms, centers, theme, rng);
      }
    } else if (style === "ctf") {
      console.log(`Arena ${i + 1} (seed=${seeds[i]}, theme=${theme.name}, style=ctf)`);
      mapContent = generateCTF(rng, theme);
    } else if (style === "tourney") {
      console.log(`Arena ${i + 1} (seed=${seeds[i]}, theme=${theme.name}, style=tourney)`);
      mapContent = generateTourney(rng, theme);
    } else if (style === "atrium") {
      console.log(`Arena ${i + 1} (seed=${seeds[i]}, theme=${theme.name}, style=atrium)`);
      mapContent = generateAtrium(rng, theme);
    } else {
      const platforms = generatePlatforms(rng);
      console.log(`Arena ${i + 1} (seed=${seeds[i]}, theme=${theme.name}, style=platform): ${platforms.length} platforms`);
      for (const p of platforms) {
        console.log(`  platform at (${p.x}, ${p.y}) z=${p.z} size=${p.w}x${p.h}`);
      }
      mapContent = platformsToMap(platforms, theme, rng);
    }

    const mapPath = path.join(OUTPUT_DIR, `${mapNames[i]}.map`);
    fs.writeFileSync(mapPath, mapContent);
    console.log(`Wrote ${mapPath}`);
  }

  const arenaContent = generateArenaFile(mapNames, styles);
  const arenaPath = path.join(SCRIPT_DIR, "arena.arena");
  fs.writeFileSync(arenaPath, arenaContent);
  console.log(`Wrote ${arenaPath}`);

  console.log(`\nArena generation complete! (${mapCount} maps)`);
  console.log("Next: npm run compile");
}

main();
