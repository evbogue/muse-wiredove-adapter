// Subprocess fixture for lock recovery and cross-process exclusion tests.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { acquireLock, lockPath } from "../../src/lock.js";

const [mode, directory, results] = process.argv.slice(2);
if (!["killself", "race"].includes(mode) || !directory || !results) {
  throw new Error("Expected lock-child.mjs <killself|race> <directory> <results>");
}
const release = await acquireLock(directory, { timeoutMs: 30000, pollMs: 10 });
if (mode === "killself") {
  await writeFile(`${results}.ready`, "locked\n");
  process.kill(process.pid, "SIGKILL");
} else {
  try {
    const { token } = JSON.parse(await readFile(lockPath(directory), "utf8"));
    await appendFile(results, `start ${process.pid} ${token} ${Date.now()}\n`);
    await new Promise(resolve => setTimeout(resolve, 50));
    await appendFile(results, `end ${process.pid} ${token} ${Date.now()}\n`);
  } finally {
    await release();
  }
}
