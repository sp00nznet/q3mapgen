#!/usr/bin/env node
// q3mapgen - Packages compiled arena BSPs + AAS + arena file into a pk3 (ZIP with Q3 directory structure)
//
// https://github.com/sp00nznet/q3mapgen

const archiver = require("archiver");
const fs = require("fs");
const path = require("path");

// --- Configuration ---
// Override with environment variables or edit these defaults
const COMPILE_DIR = process.env.OUTPUT_DIR
  ? path.join(process.env.OUTPUT_DIR, "maps")
  : path.join(__dirname, "..", "compile", "baseq3", "maps");
const SCRIPT_DIR = process.env.ASSETS_DIR
  ? path.join(process.env.ASSETS_DIR, "scripts")
  : path.join(__dirname, "..", "assets", "scripts");
const OUTPUT = process.env.OUTPUT_DIR
  ? path.join(process.env.OUTPUT_DIR, "arenas.pk3")
  : path.join(__dirname, "..", "dist", "arenas.pk3");

// Auto-detect arena maps from compile directory
const ARENA_MAPS = fs.existsSync(COMPILE_DIR)
  ? fs.readdirSync(COMPILE_DIR)
      .filter(f => f.startsWith("arena") && f.endsWith(".bsp"))
      .map(f => f.replace(".bsp", ""))
      .sort()
  : [];

function main() {
  if (ARENA_MAPS.length === 0) {
    console.error("No compiled arena*.bsp files found in " + COMPILE_DIR);
    console.error("Run 'npm run compile' first.");
    process.exit(1);
  }

  console.log(`Found ${ARENA_MAPS.length} maps to package: ${ARENA_MAPS.join(", ")}`);

  const distDir = path.dirname(OUTPUT);
  fs.mkdirSync(distDir, { recursive: true });

  const output = fs.createWriteStream(OUTPUT);
  const archive = archiver("zip", { zlib: { level: 9 } });

  output.on("close", () => {
    console.log(`\nCreated ${OUTPUT} (${(archive.pointer() / 1024).toFixed(1)} KB)`);
    console.log("\nDrop this pk3 into your baseq3/ directory and frag away!");
  });

  archive.on("error", (err) => { throw err; });
  archive.pipe(output);

  // Add compiled BSPs and AAS files
  for (const name of ARENA_MAPS) {
    const bspPath = path.join(COMPILE_DIR, `${name}.bsp`);
    if (fs.existsSync(bspPath)) {
      archive.file(bspPath, { name: `maps/${name}.bsp` });
      console.log(`  + maps/${name}.bsp`);
    } else {
      console.error(`ERROR: ${name}.bsp not found at ${bspPath}`);
      console.error("Run 'npm run compile' first.");
      process.exit(1);
    }
    const aasPath = path.join(COMPILE_DIR, `${name}.aas`);
    if (fs.existsSync(aasPath)) {
      archive.file(aasPath, { name: `maps/${name}.aas` });
      console.log(`  + maps/${name}.aas`);
    }
  }

  // Add arena definition file (tells Q3 about the maps)
  const arenaPath = path.join(SCRIPT_DIR, "arena.arena");
  if (fs.existsSync(arenaPath)) {
    archive.file(arenaPath, { name: "scripts/arena.arena" });
    console.log("  + scripts/arena.arena");
  }

  archive.finalize();
}

main();
