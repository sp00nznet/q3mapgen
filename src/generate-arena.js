#!/usr/bin/env node
// q3mapgen - Procedural arena map generator for Quake III Arena
// Generates three styles: enclosed dungeons, multi-level vertical, and q3dm17-style floating platforms
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
  out += block(x1 - T, y1 - T, z1 - T, x2 + T, y2 + T, z1, tex);
  out += block(x1 - T, y1 - T, z2, x2 + T, y2 + T, z2 + T, tex);
  out += block(x1 - T, y1 - T, z1 - T, x2 + T, y1, z2 + T, tex);
  out += block(x1 - T, y2, z1 - T, x2 + T, y2 + T, z2 + T, tex);
  out += block(x1 - T, y1 - T, z1 - T, x1, y2 + T, z2 + T, tex);
  out += block(x2, y1 - T, z1 - T, x2 + T, y2 + T, z2 + T, tex);
  return out;
}

// --- Shared entity placement ---

function placeEntities(platforms, rng, zOffset) {
  let map = "";
  let entNum = 1;

  const shuffled = [...platforms];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // Spawn points (6-8)
  const numSpawns = Math.min(8, Math.max(6, platforms.length));
  for (let i = 0; i < numSpawns; i++) {
    const p = shuffled[i % shuffled.length];
    const sx = p.x + CELL / 2 + Math.floor(rng() * (p.w - CELL));
    const sy = p.y + CELL / 2 + Math.floor(rng() * (p.h - CELL));
    const angle = Math.floor(rng() * 360);
    map += `// entity ${entNum++}\n{\n"classname" "info_player_deathmatch"\n"origin" "${sx} ${sy} ${p.z + zOffset}"\n"angle" "${angle}"\n}\n`;
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

  // Yellow armor
  if (platforms.length >= 3) {
    const p = platforms[Math.floor(platforms.length / 2)];
    const ax = p.x + Math.floor(p.w / 2);
    const ay = p.y + Math.floor(p.h / 2);
    map += `// entity ${entNum++}\n{\n"classname" "item_armor_combat"\n"origin" "${ax} ${ay} ${p.z + 16}"\n}\n`;
  }

  return { map, entNum };
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

  // Prim's MST for guaranteed connectivity
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

  // Extra edges for loops (more interesting navigation)
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

  map += "}\n";

  const platforms = rooms.map(r => ({
    x: ox + r.x * CELL,
    y: oy + r.y * CELL,
    z: 0,
    w: r.w * CELL,
    h: r.h * CELL,
  }));

  const { map: entMap, entNum } = placeEntities(platforms, rng, 32);
  map += entMap;

  let eNum = entNum;
  map += `// entity ${eNum++} - kill trigger\n{\n"classname" "trigger_hurt"\n"dmg" "1000"\n`;
  map += `// brush 0\n`;
  map += block(bx1, by1, bz1 - 64, bx2, by2, bz1 + 64, "common/trigger");
  map += "}\n";

  for (const room of rooms) {
    const lx = ox + (room.x + Math.floor(room.w / 2)) * CELL + CELL / 2;
    const ly = oy + (room.y + Math.floor(room.h / 2)) * CELL + CELL / 2;
    const intensity = 400 + room.w * room.h * 12;
    map += `// entity ${eNum++}\n{\n"classname" "light"\n"origin" "${lx} ${ly} ${ROOM_HEIGHT - 16}"\n"light" "${intensity}"\n"_color" "1.0 0.9 0.8"\n}\n`;
  }

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

const VERT_HEIGHT = 512;
const FLOOR_HEIGHTS = [0, 128, 256, 384];
const STEP_SIZE = 16;

function verticalDungeonToMap(grid, rooms, centers, theme, rng) {
  let map = "";
  let brushNum = 0;

  const roomData = rooms.map((r) => ({
    z: FLOOR_HEIGHTS[Math.floor(rng() * FLOOR_HEIGHTS.length)],
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

  function cellHeight(gy, gx) {
    const ri = cellRoom[gy][gx];
    if (ri >= 0) return roomData[ri].z;
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

  const bx1 = minX - BOX_PAD, by1 = minY - BOX_PAD;
  const bx2 = maxX + BOX_PAD, by2 = maxY + BOX_PAD;
  const bz1 = -WALL_THICK - BOX_PAD, bz2 = VERT_HEIGHT + 384 + WALL_THICK + BOX_PAD;
  map += `// sealing box\n`;
  for (let bi = 0; bi < 6; bi++) brushNum++;
  map += sealingBox(bx1, by1, bz1, bx2, by2, bz2, "common/caulk", 512);

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

      map += `// brush ${brushNum++}\n`;
      map += block(x1, y1, -128, x2, y2, floorZ, { top: tex.floor, north: tex.wall, south: tex.wall, east: tex.wall, west: tex.wall });

      map += `// brush ${brushNum++}\n`;
      map += block(x1, y1, ceilZ, x2, y2, ceilZ + WALL_THICK, { bottom: tex.ceiling });

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
              const nextZ = floorZ + (s + 1) * stepH;
              const topZ = Math.max(floorZ + s * stepH, nextZ);
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
              const nextZ = floorZ + (s + 1) * stepH;
              const topZ = Math.max(floorZ + s * stepH, nextZ);
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

  // Raised platforms inside larger rooms
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
      top: tex.floor, bottom: tex.wall,
      north: tex.wall, south: tex.wall, east: tex.wall, west: tex.wall,
    });
  }

  map += "}\n";

  const platforms = rooms.map((r, ri) => ({
    x: ox + r.x * CELL,
    y: oy + r.y * CELL,
    z: roomData[ri].z,
    w: r.w * CELL,
    h: r.h * CELL,
  }));

  const { map: entMap, entNum } = placeEntities(platforms, rng, 32);
  map += entMap;

  let eNum = entNum;
  const killZ = -128;
  map += `// entity ${eNum++} - kill trigger\n{\n"classname" "trigger_hurt"\n"dmg" "1000"\n`;
  map += `// brush 0\n`;
  map += block(bx1, by1, killZ - CELL, bx2, by2, killZ, "common/trigger");
  map += "}\n";

  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const floorZ = roomData[ri].z;
    const lx = ox + (room.x + Math.floor(room.w / 2)) * CELL + CELL / 2;
    const ly = oy + (room.y + Math.floor(room.h / 2)) * CELL + CELL / 2;
    const intensity = 500 + room.w * room.h * 10;
    map += `// entity ${eNum++}\n{\n"classname" "light"\n"origin" "${lx} ${ly} ${floorZ + VERT_HEIGHT - 16}"\n"light" "${intensity}"\n"_color" "1.0 0.9 0.8"\n}\n`;
    map += `// entity ${eNum++}\n{\n"classname" "light"\n"origin" "${lx} ${ly} ${floorZ + VERT_HEIGHT / 2}"\n"light" "${Math.floor(intensity * 0.5)}"\n"_color" "0.9 0.85 0.8"\n}\n`;
  }

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
// PLATFORM STYLE (q3dm17-style floating platforms in void)
// =============================================

function generatePlatforms(rng) {
  const platforms = [];
  const numPlatforms = 6 + Math.floor(rng() * 4);
  let attempts = 0;

  const span = Math.floor(GRID * CELL * 0.5);

  while (platforms.length < numPlatforms && attempts < 300) {
    attempts++;
    const pw = (3 + Math.floor(rng() * 4)) * CELL;
    const ph = (3 + Math.floor(rng() * 4)) * CELL;
    // Snap to 64-unit grid for clean AAS
    const px = Math.round((-span / 2 + Math.floor(rng() * (span - pw))) / 64) * 64;
    const py = Math.round((-span / 2 + Math.floor(rng() * (span - ph))) / 64) * 64;
    const pz = Math.floor(rng() * 3) * 128; // 0, 128, 256

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

  const skyPad = CELL * 2;
  const bx1 = minX - skyPad, by1 = minY - skyPad;
  const bx2 = maxX + skyPad, by2 = maxY + skyPad;
  const bz1 = minZ - CELL * 3;
  const bz2 = maxZ + ROOM_HEIGHT + skyPad;

  map += `// sky box\n`;
  for (let bi = 0; bi < 6; bi++) brushNum++;
  map += sealingBox(bx1, by1, bz1, bx2, by2, bz2, theme.sky, 64);

  const platTextures = platforms.map(() => ({
    wall: theme.walls[Math.floor(rng() * theme.walls.length)],
    floor: theme.floors[Math.floor(rng() * theme.floors.length)],
    trim: theme.walls[Math.floor(rng() * theme.walls.length)],
  }));

  for (let pi = 0; pi < platforms.length; pi++) {
    const p = platforms[pi];
    const tex = platTextures[pi];
    const platThick = 64;

    map += `// platform ${pi} floor\n// brush ${brushNum++}\n`;
    map += block(p.x, p.y, p.z - platThick, p.x + p.w, p.y + p.h, p.z, {
      top: tex.floor, bottom: tex.wall,
      north: tex.wall, south: tex.wall, east: tex.wall, west: tex.wall,
    });

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

  // Bridges via Prim's MST
  const n = platforms.length;
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

  const extraBridges = 2 + Math.floor(rng() * 2);
  for (let e = 0; e < extraBridges; e++) {
    const i = Math.floor(rng() * n);
    const j = Math.floor(rng() * n);
    if (i !== j) edges.push([i, j]);
  }

  const bridgeWidth = 160;
  const bridgeThick = 32;

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
    const midX = bcx;

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

  map += "}\n";

  const { map: entMap, entNum } = placeEntities(platforms, rng, 32);
  map += entMap;

  let eNum = entNum;
  const killZ = minZ - CELL * 2;
  map += `// entity ${eNum++} - kill trigger\n{\n"classname" "trigger_hurt"\n"dmg" "1000"\n`;
  map += `// brush 0\n`;
  map += block(bx1, by1, killZ - CELL, bx2, by2, killZ, "common/trigger");
  map += "}\n";

  for (let pi = 0; pi < platforms.length; pi++) {
    const p = platforms[pi];
    const lx = p.x + Math.floor(p.w / 2);
    const ly = p.y + Math.floor(p.h / 2);
    const intensity = 300 + Math.floor((p.w * p.h) / 500);
    map += `// entity ${eNum++}\n{\n"classname" "light"\n"origin" "${lx} ${ly} ${p.z + 256}"\n"light" "${intensity}"\n"_color" "1.0 0.95 0.9"\n}\n`;
  }

  return map;
}

// --- Generate arena files ---

function generateArenaFile(mapNames) {
  let content = "";
  for (const name of mapNames) {
    content += `{\nmap "${name}"\nlongname "q3mapgen - ${name}"\ntype "ffa"\nbots "Sarge"\n}\n`;
  }
  return content;
}

// --- Debug grid printer ---

function printGrid(grid) {
  for (let gy = 0; gy < GRID; gy++) {
    let row = "";
    for (let gx = 0; gx < GRID; gx++) {
      row += grid[gy][gx] === CELL_SOLID ? "." : grid[gy][gx] === CELL_ROOM ? "#" : "+";
    }
    console.log("  " + row);
  }
}

// --- Main ---

function main() {
  const args = process.argv.slice(2);
  const seeds = [
    parseInt(args[0]) || 42,
    parseInt(args[1]) || 137,
    parseInt(args[2]) || 256,
    parseInt(args[3]) || 999,
    parseInt(args[4]) || 777,
  ];
  const mapNames = ["arena1", "arena2", "arena3", "arena4", "arena5"];
  // Styles: dungeon, platform, vertical, platform, platform
  const styles = ["dungeon", "platform", "vertical", "platform", "platform"];

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });

  for (let i = 0; i < mapNames.length; i++) {
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

  const arenaContent = generateArenaFile(mapNames);
  const arenaPath = path.join(SCRIPT_DIR, "arena.arena");
  fs.writeFileSync(arenaPath, arenaContent);
  console.log(`Wrote ${arenaPath}`);

  console.log("\nArena generation complete!");
  console.log("Next: npm run compile");
}

main();
