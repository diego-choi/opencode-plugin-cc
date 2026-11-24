import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";

const STATE = pathToFileURL(path.resolve(import.meta.dirname, "../plugins/opencode/scripts/lib/state.mjs")).href;

function writer(dataDir, workspace, tag, count) {
  const code = `
    const { upsertJob } = await import(${JSON.stringify(STATE)});
    for (let i = 0; i < ${count}; i++) {
      upsertJob(${JSON.stringify(workspace)}, { id: "${tag}-" + i, status: "queued", pad: "x".repeat(20000) });
      upsertJob(${JSON.stringify(workspace)}, { id: "${tag}-" + i, status: "completed" });
    }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, OPENCODE_COMPANION_DATA: dataDir },
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${c}`))));
  });
}

describe("state lock", () => {
  it("keeps every job record under concurrent writers", async () => {
    const dataDir = createTmpDir("state-lock");
    const workspace = "/tmp/state-lock-workspace";
    try {
      await Promise.all(["a", "b", "c"].map((tag) => writer(dataDir, workspace, tag, 15)));
      process.env.OPENCODE_COMPANION_DATA = dataDir;
      const { loadState } = await import(STATE);
      const jobs = loadState(workspace).jobs;
      assert.equal(jobs.length, 45);
      assert.ok(jobs.every((j) => j.status === "completed"));
    } finally {
      delete process.env.OPENCODE_COMPANION_DATA;
      cleanupTmpDir(dataDir);
    }
  });
});
