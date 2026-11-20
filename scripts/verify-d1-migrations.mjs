// Applies every migration to a throwaway local D1 and queries the dependency view.
// The tests run on plain SQLite, which does not enforce D1's limits (five SELECT terms per
// compound statement, 50-byte LIKE/GLOB patterns, 100 bound parameters). A migration can
// pass the tests and still stop `npm run deploy`, so this runs the real D1 engine locally.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const database = readFileSync(join(root, "wrangler.toml"), "utf8").match(/^database_name\s*=\s*"([^"]+)"/m)?.[1];
if (!database) throw new Error("wrangler.toml has no D1 database_name");

const persist = mkdtempSync(join(tmpdir(), "aelios-d1-"));

function wrangler(args) {
  const result = spawnSync("npx", ["wrangler", "d1", ...args, "--local", "--persist-to", persist], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }
  });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

// Same shape as the withdrawal closure: the view expanded inside a recursive CTE.
const closure = `WITH RECURSIVE reach(ref) AS (SELECT 'message:check'
  UNION SELECT d.entity FROM memory_derivations d JOIN reach ON d.input = reach.ref)
  SELECT COUNT(*) AS refs FROM reach`;

try {
  wrangler(["migrations", "apply", database]);
  wrangler(["execute", database, "--command", closure]);
  console.log("d1-migrations: every migration applies on local D1 and the dependency view resolves");
} finally {
  rmSync(persist, { recursive: true, force: true });
}
