import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// The project's one settings file is the .env in the repository root (see ../.env.example).
// Only its VITE_* settings reach the app; outside Docker it is optional (defaults below).
const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * App version MAJOR.MINOR.PATCH, shown in the footer:
 *   MAJOR  set by the developers: the first number of "version" in package.json
 *   MINOR  number of merges (pull requests) into main
 *   PATCH  commits made after the last merge into main, on main itself or on the branch
 *          being built (0 right after a merge; merges of main into a branch don't count)
 * Example: v1.4.0 just after the 4th pull request is merged; one more commit on main or on
 * the branch gives v1.4.1. Counted from git at build time against main (origin/main, else
 * main): without either, or without git (e.g. a source zip), it is MAJOR.0.0.
 * VITE_APP_VERSION overrides it all.
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
    // Not the branch's own history: merges of main into a branch would count as pull requests.
    const main = ["origin/main", "main"].find((ref) => {
      try {
        git("rev-parse", "--verify", "--quiet", ref);
        return true;
      } catch {
        return false;
      }
    });
    if (!main) return `${major}.0.0`;
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
    // Commits the last merge doesn't already contain: work done since the version changed.
    const since = git(
      "rev-list",
      "--count",
      "--no-merges",
      lastMerge ? `${lastMerge}..HEAD` : "HEAD",
    );
    return `${major}.${merges}.${since}`;
  } catch {
    return `${major}.0.0`;
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, ROOT_DIR, "VITE_"), ...process.env };
  return {
    envDir: ROOT_DIR,
    plugins: [react()],
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion()),
    },
    server: {
      // `npm run dev`: forward /api to the backend API (backend-module, published on 127.0.0.1:8100)
      // and /stream-hub to stream-hub (published on 127.0.0.1:9000). Separate override
      // variables, so redirecting one proxy (e.g. VITE_API_PROXY to a remote backend) never
      // silently drags the other along with it.
      proxy: {
        "/api": {
          target: env.VITE_API_PROXY ?? "http://localhost:8000",
          changeOrigin: true,
          xfwd: true, // X-Forwarded-Host: the API's same-origin check and email links
        },
        "/stream-hub": {
          target: env.VITE_STREAM_PROXY ?? "http://localhost:9000",
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
