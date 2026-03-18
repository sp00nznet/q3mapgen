#!/usr/bin/env node
// q3mapgen - Compiles arena .map files through the q3map2 pipeline: BSP -> VIS -> LIGHT -> AAS
//
// https://github.com/sp00nznet/q3mapgen

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// --- Configuration ---
// Override with environment variables or edit these defaults
const Q3MAP2 = process.env.Q3MAP2_PATH || "q3map2";
const MBSPC = process.env.MBSPC_PATH || "mbspc";
const ASSETS_DIR = process.env.ASSETS_DIR || path.join(__dirname, "..", "assets");
const MAPS_DIR = path.join(ASSETS_DIR, "maps");
const COMPILE_DIR = process.env.OUTPUT_DIR
  ? path.join(process.env.OUTPUT_DIR, "maps")
  : path.join(__dirname, "..", "compile", "baseq3", "maps");

const ARENA_MAPS = ["arena1", "arena2", "arena3", "arena4", "arena5"];

function run(cmd) {
  console.log(`  > ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    console.error(`Command failed with exit code ${err.status}`);
    process.exit(1);
  }
}

function main() {
  // Check that q3map2 is available
  try {
    execSync(`"${Q3MAP2}" -help`, { stdio: "pipe" });
  } catch (e) {
    // q3map2 -help exits non-zero, but that's fine — it means it exists
    if (e.status === null) {
      console.error(`q3map2 not found at: ${Q3MAP2}`);
      console.error("");
      console.error("Set Q3MAP2_PATH environment variable to your q3map2 binary:");
      console.error("  export Q3MAP2_PATH=/path/to/q3map2");
      console.error("");
      console.error("You can get q3map2 from NetRadiant-custom:");
      console.error("  https://github.com/Garux/netradiant-custom/releases");
      process.exit(1);
    }
  }

  fs.mkdirSync(COMPILE_DIR, { recursive: true });

  for (const name of ARENA_MAPS) {
    const mapFile = path.join(MAPS_DIR, `${name}.map`);
    if (!fs.existsSync(mapFile)) {
      console.error(`Map file not found: ${mapFile}`);
      console.error("Run 'npm run generate' first.");
      process.exit(1);
    }

    console.log(`\n=== Compiling ${name} ===`);

    // BSP stage (-meta merges coplanar faces, reduces draw calls)
    console.log("Stage 1: BSP");
    run(`"${Q3MAP2}" -fs_basepath "${ASSETS_DIR}" -meta "${mapFile}"`);

    // VIS stage (precomputes potentially visible sets)
    console.log("Stage 2: VIS");
    run(`"${Q3MAP2}" -fs_basepath "${ASSETS_DIR}" -vis "${mapFile}"`);

    // LIGHT stage (-fast for quick compile, -samples 2 for decent quality)
    console.log("Stage 3: LIGHT");
    run(`"${Q3MAP2}" -fs_basepath "${ASSETS_DIR}" -light -fast -samples 2 "${mapFile}"`);

    // AAS stage (bot navigation mesh)
    // -forcesidesvisible is the trick that makes bots actually work on procedural maps.
    // Without it, mbspc often can't figure out the reachability between areas.
    console.log("Stage 4: AAS (bot navigation)");
    try {
      const bspFile = mapFile.replace(".map", ".bsp");
      const aasCmd = `"${MBSPC}" -bsp2aas "${bspFile}" -forcesidesvisible -optimize`;
      console.log(`  > ${aasCmd}`);
      execSync(aasCmd, { stdio: "inherit" });
    } catch (e) {
      console.warn("AAS generation had warnings - continuing (bots may be confused)...");
    }

    // Move compiled BSP + AAS to compile dir
    const bspSrc = mapFile.replace(".map", ".bsp");
    const bspDst = path.join(COMPILE_DIR, `${name}.bsp`);
    if (fs.existsSync(bspSrc)) {
      fs.copyFileSync(bspSrc, bspDst);
      console.log(`Copied BSP to ${bspDst}`);
    }

    const aasSrc = mapFile.replace(".map", ".aas");
    const aasDst = path.join(COMPILE_DIR, `${name}.aas`);
    if (fs.existsSync(aasSrc)) {
      fs.copyFileSync(aasSrc, aasDst);
      console.log(`Copied AAS to ${aasDst}`);
    }
  }

  console.log("\nArena compilation complete!");
  console.log("Next: npm run package");
}

main();
