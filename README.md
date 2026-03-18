# q3mapgen

Procedural map generator for Quake III Arena. Feed it a seed number, get a playable `.bsp` with bot support. No editor required, no hand-placed brushes, just math and vibes.

This is the map generator behind [sp00.nz](https://sp00.nz) -- click the **tilde (~)** in the top right corner for a live demo running in your browser.

## What it makes

Three distinct map styles, all from the same generator:

### Dungeon (corridor-based)
Classic enclosed dungeon crawl. Rooms of varying size connected by L-shaped corridors via Prim's minimum spanning tree, plus a few extra edges for loops so you're not just running back and forth in a tree. Caulk-sealed exterior, textured interior.

### Vertical (multi-level)
Same room/corridor layout as dungeon, but each room gets a random floor height (0, 128, 256, or 384 units). Corridors between rooms at different heights automatically generate staircases. Larger rooms have a chance of spawning raised platforms inside them. Two light sources per room for proper vertical illumination.

### Platform (q3dm17-style void)
Floating platforms suspended in a skybox, connected by L-shaped bridges. Think The Longest Yard but procedural. Platforms snap to a 64-unit grid (important for AAS -- more on that later). Varying heights give you verticality. Some platforms get corner pillars.

## The grid

The generator works on a 32x32 grid where each cell is 192 Q3 units. When it runs, it prints an ASCII visualization of the layout:

```
  ................................
  ................................
  ................................
  .....######.....................
  .....######.....................
  .....######.....................
  .....######.....................
  .....#.++++++++++++.............
  ..........++.....+######.......
  ..........++.....+######.......
  ..........++.....+######.......
  ..........++.....+######.......
  ......#####++....+######.......
  ......#####++....................
  ......#####++....................
  ......#####.+....................
  ......#####.++++++..............
  ..............+.+...............
  ..............+.+...............
  ..............+.####............
  ..............+.####............
  ..............+.####............
  ..............+.####............
  ................................
```

- `#` = room
- `+` = corridor
- `.` = solid (void)

## Seeded PRNG

Every map is deterministic. Same seed = same map, forever. The generator uses Mulberry32, a fast 32-bit PRNG that fits in a few lines of JS:

```
seed 42  -> always the same dungeon
seed 137 -> always the same platform map
seed 256 -> always the same vertical arena
```

Pass seeds as CLI arguments:

```bash
node src/generate-arena.js 42 137 256 999 777
```

Five seeds, five maps (`arena1` through `arena5`). Default seeds are `42 137 256 999 777` if you don't specify any.

The style rotation is: dungeon, platform, vertical, platform, platform. Themes alternate between `gothic` and `base`.

## Prerequisites

You need three things:

1. **Node.js** (v16+) -- for the generator and packager
2. **q3map2** -- BSP compiler. Get it from [NetRadiant-custom releases](https://github.com/Garux/netradiant-custom/releases)
3. **mbspc** -- AAS (bot navigation) compiler. Part of the Q3 SDK tools, also bundled with some NetRadiant builds

## Setup

```bash
git clone https://github.com/sp00nznet/q3mapgen.git
cd q3mapgen
npm install
```

Tell the scripts where your tools live:

```bash
# Linux/Mac
export Q3MAP2_PATH=/path/to/q3map2
export MBSPC_PATH=/path/to/mbspc

# Windows (PowerShell)
$env:Q3MAP2_PATH = "C:\path\to\q3map2.exe"
$env:MBSPC_PATH = "C:\path\to\mbspc.exe"
```

Or just put `q3map2` and `mbspc` on your PATH.

## Usage

### Generate maps

```bash
npm run generate
```

This creates `.map` files in `assets/maps/` and an arena definition in `assets/scripts/`.

With custom seeds:

```bash
node src/generate-arena.js 1337 8675309 31337 42069 12345
```

### Compile maps

```bash
npm run compile
```

Runs each map through the full pipeline:
1. **BSP** (`-meta`) -- converts brushes to optimized geometry
2. **VIS** -- precomputes potentially visible sets (what can see what)
3. **LIGHT** (`-fast -samples 2`) -- bounce lighting, decent quality without waiting forever
4. **AAS** (`-forcesidesvisible -optimize`) -- bot navigation mesh

### Package into pk3

```bash
npm run package
```

Creates `dist/arenas.pk3` -- a ZIP file with Q3 directory structure. Drop it in your `baseq3/` folder and the maps show up in the skirmish menu.

### Do everything at once

```bash
npm run build
```

Generate, compile, package. One command.

## Configuration

All paths are configurable via environment variables:

| Variable | Default | What it does |
|----------|---------|-------------|
| `Q3MAP2_PATH` | `q3map2` (on PATH) | Path to q3map2 binary |
| `MBSPC_PATH` | `mbspc` (on PATH) | Path to mbspc binary |
| `ASSETS_DIR` | `./assets` | Where .map files and scripts go |
| `OUTPUT_DIR` | `./compile/baseq3` | Where compiled BSPs go / pk3 output |

## Texture themes

Two built-in themes using textures from the Q3 demo pak0:

**Gothic** -- stone blocks, wooden ceilings, warm lighting. The textures that say "someone built a cathedral and then filled it with rocket launchers."

**Base** -- metal panels, tech ceilings, cold blue corridor lights. The textures that say "this military installation was definitely not up to code."

Adding your own theme is easy -- just add an entry to the `THEMES` array in `generate-arena.js`:

```javascript
{
  name: "mytheme",
  walls: ["textures/my_wall1", "textures/my_wall2"],
  floors: ["textures/my_floor"],
  ceilings: ["textures/my_ceiling"],
  trim: "textures/my_trim",
  light: "textures/my_light",
  sky: "skies/my_sky",
}
```

## Bot navigation (AAS)

Getting bots to work on procedural maps is... an adventure. Here's what you need to know:

- **mbspc** generates `.aas` files that tell bots where they can walk, jump, and rocket-jump
- **`-forcesidesvisible`** is essential -- without it, mbspc often fails to compute reachability between areas in procedural geometry. This flag makes it treat all brush sides as visible during the AAS compilation
- **Grid-snapping** matters for platform maps -- platforms snap to 64-unit boundaries so the AAS reachability calculations don't break on tiny misalignments
- **Sealing box** -- dungeon maps use an oversized caulk box around the whole level. Platform maps use a sky box. Both are needed for AAS to not bail out with "map not sealed" errors
- Bots will sometimes be dumb on bridges. That's life. The MST guarantees they can at least reach every area

## How it works (the nerdy bits)

1. **Room placement** -- random rooms with overlap rejection on the 32x32 grid
2. **Prim's MST** -- minimum spanning tree guarantees all rooms are reachable
3. **Extra edges** -- 1-2 random additional corridors create loops (no dead-end-only layouts)
4. **L-shaped corridors** -- corridors always go horizontal-then-vertical or vice versa (randomly chosen)
5. **Brush generation** -- each grid cell becomes floor + ceiling + conditional walls (only where adjacent to solid)
6. **Entity placement** -- 6-8 spawns, 3-4 weapons with ammo, health packs, armor, all placed on room/platform surfaces using the same seeded PRNG
7. **The sealing box trick** -- 6 overlapping box brushes with extra thickness at corners to guarantee no BSP leaks

The Q3 .map format is just text -- three points per plane, texture name, UV params. The generator writes it directly, no intermediate format.

## Inspiration

This project was inspired by [quake-mapgen](https://gitlab.com/hemebond/quake-mapgen) by hemebond, a procedural map generator for Quake 1. That project demonstrated that seeded PRNG and simple grid-based room placement could produce surprisingly playable maps without any manual editing. q3mapgen adapts the idea for Quake III Arena, with Q3-specific brush formats, bot navigation (AAS), and multiple map styles.

## License

MIT. Go make weird maps.
