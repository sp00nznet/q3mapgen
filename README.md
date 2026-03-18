# q3mapgen

Procedural map generator for Quake III Arena. Feed it a seed number, get a playable `.bsp` with bot support. No editor required, no hand-placed brushes — just math and rockets.

This is the map generator behind [sp00.nz](https://sp00.nz) — click the **tilde (~)** in the top right corner for a live demo running in your browser. After two minutes in the resume room, a portal opens and drops you into a randomly generated arena with a bot. The maps you'll fight in were all made by this code.

## What it makes

Seven distinct map styles, all from the same generator:

### Dungeon
Flat enclosed corridor-based rooms. The generator places 5-8 rooms on a 32x32 grid, then connects them with Prim's minimum spanning tree plus a few extra edges for loops. L-shaped corridors, per-room texture variety, and enough health packs to keep things moving. Classic deathmatch in a procedural dungeon crawl.

### Vertical
Same room/corridor layout as dungeon, but each room gets assigned one of four floor heights (0, 128, 256, or 384 units). Corridors between rooms at different heights automatically generate staircases — step by step, 16 units at a time. Larger rooms have a chance of spawning raised platforms inside them. Two light sources per room because vertical spaces need illumination at multiple levels or you're just fighting in a dark pit.

### Platform
q3dm17-style floating platforms suspended in a killsky void. Think The Longest Yard but procedural. Platforms snap to a 64-unit grid (critical for AAS bot navigation — more on that later). L-shaped bridges connect them via MST, with 2-3 extra bridges for loops. Varying heights give you verticality. Some platforms get corner pillars. Fall off and you die.

### CTF
Symmetric two-base capture the flag map. Red base on one end, blue base on the other, big open middle arena between them. Side corridors for flanking routes so you're not just running down the middle like a lemming. Raised platform in the center with quad damage because every CTF map needs a high-risk power position. Jump pads launch you up to it from opposite corners.

**Note:** CTF maps require the retail Q3 `pak0.pk3` — the demo doesn't include the flag models (`team_CTF_redflag` / `team_CTF_blueflag`). FFA maps work fine with just the demo pak0.

### Tourney
Small, tight 1v1 maps. Only 3-4 rooms on a compact 16x16 grid. Deliberate weapon placement — one rocket launcher, one lightning gun, that's it. Yellow armor in the middle room. And a lava pit in the largest room because every good tourney map has at least one way to die that isn't a rocket. Built for `g_gametype 1`.

### Atrium
One massive central room with three levels of action. Ground floor, balconies at height 192 (with gaps for jumping across), and corner platforms at height 384. A central pillar/platform at ground level holds the quad damage. Jump pads in all four corners launch you from ground to balcony level. Teleporters connect opposite upper corner platforms. Red armor sits on one of the upper platforms — exposed and risky, just like it should be. Five weapons spread across all three levels so you're constantly moving up and down.

### Platform (again)
The style rotation is `dungeon, platform, vertical, platform, ctf, tourney, atrium, platform` — platform appears three times because floating-in-the-void maps are endlessly replayable and every seed makes a completely different layout.

## Gameplay features

The generator doesn't just make geometry — it populates maps with the stuff that makes Q3 actually fun:

- **Jump pads** — `trigger_push` with a visible pedestal and `launchpad_arrow` texture on top. Connect lower platforms to higher ones so you're not stuck at ground level.
- **Teleporters** — `trigger_teleport` pairs connecting the two most distant platforms. Instant cross-map rotation.
- **Lava pits** — `liquids/lavahell` with `trigger_hurt` doing 50 damage per tick. Tourney maps only, because 1v1 needs environmental hazards.
- **Quad damage** — placed on the highest/most exposed platform. High risk, high reward.
- **Red armor** — on the smallest platform. You want it? You're going to be a visible target getting it.
- **Yellow armor** — middle of the map, accessible but contested.
- **Strategic weapon placement** — tourney maps get only RL + LG (the two weapons that matter in 1v1). Atrium maps spread all five weapons across three height levels. CTF puts weapons in the middle and along corridors.
- **Kill triggers** — below every map. Fall into the void, fall through the floor, whatever — you die. No floating around in noclip space.
- **12-16 spawn points** — Q3 picks the spawn farthest from all players, so more spawns = fewer telefrag loops. Spawns are placed with minimum distance checks so they don't cluster.

## The grid

The generator works on a 32x32 grid where each cell is 192 Q3 units. When it runs, it prints an ASCII visualization of the layout:

```
  ................................
  ................................
  .....######.....................
  .....######.....................
  .....######.....................
  .....#.++++++++++++.............
  ..........++.....+######.......
  ..........++.....+######.......
  ..........++.....+######.......
  ......#####++....+######.......
  ......#####++....................
  ......#####.+....................
  ......#####.++++++..............
  ..............+.+...............
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

Share a seed with a friend, they get the exact same map. Compete for the best frag count on arena4 seed 777. Argue about whether seed 42 is better than seed 999.

## CLI usage

### Basic generation

```bash
npm run generate
```

Creates 8 `.map` files in `assets/maps/` and an arena definition in `assets/scripts/`.

### Custom seeds

```bash
node src/generate-arena.js 42 137 256 999 777 555 888 333
```

Eight seeds, eight maps (`arena1` through `arena8`). Default seeds are `42 137 256 999 777 555 888 333` if you don't specify any.

### Control the count

```bash
node src/generate-arena.js --count=4 42 137 256 999
```

Generate exactly 4 maps instead of the default 8.

### Complexity modes

```bash
node src/generate-arena.js --complexity=simple   # only dungeon + platform styles
node src/generate-arena.js --complexity=normal    # all 7 styles (default)
```

`simple` mode restricts to just dungeon and platform — good if you only have the demo pak0 and don't want CTF maps that need flag models.

### Full pipeline

```bash
npm run build
```

Generate, compile, package. One command. Output is `dist/arenas.pk3`.

## Prerequisites

You need three things:

1. **Node.js** (v16+) — for the generator and packager
2. **q3map2** — BSP compiler. Get it from [NetRadiant-custom releases](https://github.com/Garux/netradiant-custom/releases)
3. **mbspc** — AAS (bot navigation) compiler. Part of the Q3 SDK tools, also bundled with some NetRadiant builds

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

## Compilation pipeline

```bash
npm run compile
```

Auto-detects all `arena*.map` files in the assets directory and runs each through:

1. **BSP** (`-meta`) — converts brushes to optimized geometry
2. **VIS** — precomputes potentially visible sets (what can see what)
3. **LIGHT** (`-fast -samples 2`) — bounce lighting, decent quality without waiting forever
4. **AAS** (`-forcesidesvisible -optimize`) — bot navigation mesh via mbspc

Then:

```bash
npm run package
```

Auto-detects all compiled `arena*.bsp` and `arena*.aas` files, bundles them with the arena definition into `dist/arenas.pk3`. Drop it in your `baseq3/` folder and the maps show up in the skirmish menu.

## Configuration

All paths are configurable via environment variables:

| Variable | Default | What it does |
|----------|---------|-------------|
| `Q3MAP2_PATH` | `q3map2` (on PATH) | Path to q3map2 binary |
| `MBSPC_PATH` | `mbspc` (on PATH) | Path to mbspc binary |
| `ASSETS_DIR` | `./assets` | Where .map files and scripts go |
| `OUTPUT_DIR` | `./dist` | Where the pk3 output goes |

## Texture themes

Two built-in themes using textures from the Q3 demo pak0:

**Gothic** — stone blocks, wooden ceilings, warm lighting. `streetbricks`, `blocks18c`, `largeblockfloor3`. The textures that say "someone built a cathedral and then filled it with rocket launchers."

**Base** — metal panels, tech ceilings, cold blue corridor lights. `metaltech12final`, `metfloor_block_3`, `pjgrate2`. The textures that say "this military installation was definitely not up to code."

Each room gets its own random wall/floor/ceiling combination from the theme palette, so you get per-room texture variety without monotony.

Adding your own theme is easy — just add an entry to the `THEMES` array in `generate-arena.js`:

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

Getting bots to work on procedural maps is an adventure. Here's what makes it work:

- **mbspc** generates `.aas` files that tell bots where they can walk, jump, and rocket-jump
- **`-forcesidesvisible`** is essential — without it, mbspc often fails to compute reachability between areas in procedural geometry. This flag makes it treat all brush sides as visible during the AAS compilation
- **`-optimize`** reduces the number of AAS areas, which helps with the `AAS_MAX_PLANES` overflow that procedural maps love to trigger
- **Grid-snapping** matters for platform maps — platforms snap to 64-unit boundaries so the AAS reachability calculations don't break on tiny misalignments
- **Sealing box** — all maps use thick overlapping brush boxes (6 brushes with extra thickness at corners) to guarantee the map is sealed for both BSP and AAS. Dungeons use caulk, platforms use killsky
- Bots will sometimes be dumb on bridges. That's life. The MST guarantees they can at least reach every area

## How it works (the nerdy bits)

1. **Room placement** — random rooms with overlap rejection on the grid
2. **Prim's MST** — minimum spanning tree guarantees all rooms are reachable
3. **Extra edges** — 1-2 random additional corridors create loops (no dead-end-only layouts)
4. **L-shaped corridors** — corridors always go horizontal-then-vertical or vice versa (randomly chosen)
5. **Brush generation** — each grid cell becomes floor + ceiling + conditional walls (only where adjacent to solid)
6. **Entity placement** — 12-16 spawns, 3-5 weapons with ammo, health packs, armor, quad damage, jump pads, teleporters — all placed on room/platform surfaces using the same seeded PRNG
7. **The sealing box trick** — 6 overlapping box brushes with 512-unit thickness and extra overlap at corners to guarantee no BSP leaks

The Q3 `.map` format is just text — three points per plane, texture name, UV params. The generator writes it directly, no intermediate format. A typical dungeon map is around 50-100KB of plaintext brush definitions.

## CTF notes

CTF maps (`g_gametype 4`) have some specific design choices:

- Symmetric layout — red base at -X, blue base at +X
- `team_CTF_redspawn` / `team_CTF_bluespawn` entities on correct sides (8 per team)
- Also includes `info_player_deathmatch` spawns as FFA fallback
- Side corridors for flanking routes — you can go around instead of through
- Raised middle platform with quad damage — the "do I go for it?" decision every good CTF map needs
- Jump pads to reach the middle platform from ground level
- **Requires retail Q3 pak0.pk3** — the demo doesn't include the flag models. Use `--complexity=simple` to skip CTF if you only have the demo

## Inspiration

This project was inspired by [quake-mapgen](https://gitlab.com/hemebond/quake-mapgen) by hemebond, a procedural map generator for Quake 1. That project demonstrated that seeded PRNG and simple grid-based room placement could produce surprisingly playable maps without any manual editing. q3mapgen adapts the idea for Quake III Arena, with Q3-specific brush formats, bot navigation (AAS), jump pads, teleporters, lava, CTF, and seven distinct map styles.

## License

MIT. Go make weird maps.
