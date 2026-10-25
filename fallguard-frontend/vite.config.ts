import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * App version MAJOR.MINOR.PATCH, shown in the footer:
 *   MAJOR  set by the developers: the first number of "version" in package.json
 *   MINOR  number of merges (pull requests) into main
 *   PATCH  commits since the last merge into main (back to 0 after the next merge)
 * MINOR and PATCH are counted from git at build time. VITE_APP_VERSION overrides it all;
 * without git (e.g. a source zip) it is MAJOR.0.0.
 */
function appVersion(): string {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION;
  const pkg = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const major = pkg.version.split(".")[0];
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const main =
      ["origin/main", "main"].find((ref) => {
        try {
          git("rev-parse", "--verify", "--quiet", ref);
          return true;
        } catch {
          return false;
        }
      }) ?? "HEAD";
    const merges = git(
      "rev-list",
      "--count",
      "--first-parent",
      "--merges",
      main,
    );
    const lastMerge = git(
      "rev-list",
      "-n",
      "1",
      "--first-parent",
      "--merges",
      main,
    );
    const since = git(
      "rev-list",
      "--count",
      lastMerge ? `${lastMerge}..HEAD` : "HEAD",
    );
    return `${major}.${merges}.${since}`;
  } catch {
    return `${major}.0.0`;
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion()),
  },
  server: {
    // `npm run dev`: forward /api to the backend API (backend-module, published on 127.0.0.1:8100).
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY ?? "http://localhost:8000",
        changeOrigin: true,
      },
      "/stream-hub": {
        target: process.env.VITE_API_PROXY ?? "http://localhost:9000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
