import { execSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";

execSync("esbuild src/main.ts --bundle --outfile=dist/main.js --format=iife --minify", { stdio: "inherit" });
mkdirSync("dist/assets", { recursive: true });
cpSync("src/index.html", "dist/index.html");
cpSync("src/styles.css", "dist/styles.css");
cpSync("assets/shirin-hesab-logo-transparent.png", "dist/assets/logo.png");
cpSync("assets/pdf-logo.jpg", "dist/assets/pdf-logo.jpg");
cpSync("node_modules/jspdf/dist/jspdf.umd.min.js", "dist/assets/jspdf.umd.min.js");
console.log("frontend built -> dist/");
