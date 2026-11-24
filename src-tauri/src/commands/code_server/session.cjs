const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const controlRoot = process.env.WTM_EDITOR_CONTROL;
// Unix tracks each child as the leader of its own process group; Windows has no groups, so it
// tracks the child's process tree, which the app ends with `taskkill /T`.
const windows = process.platform === "win32";
const group = (pid) => (windows ? pid : -pid);

function killGroup(pid) {
  if (!windows) return process.kill(-pid, "SIGKILL");
  childProcess.spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true });
}

function forgetExitedGroup(directory, pid) {
  const retry = () => setTimeout(() => forgetExitedGroup(directory, pid), 1000).unref();
  try {
    process.kill(group(pid), 0);
    retry();
    return;
  } catch (error) {
    if (error.code !== "ESRCH") return;
  }
  const lock = path.join(directory, "lock");
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code === "EEXIST") retry();
    return;
  }
  try {
    if (!fs.existsSync(path.join(directory, "active.json"))) return;
    for (const name of ["groups", "terminals"]) {
      const file = path.join(directory, name);
      if (!fs.existsSync(file)) continue;
      const remaining = fs.readFileSync(file, "utf8").split("\n")
        .filter((line) => line !== String(pid));
      fs.writeFileSync(file, remaining.join("\n"));
    }
  } catch {
    retry();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {}
  }
}

const started = (pid) => Number.isInteger(pid) && pid > 1;

function locked(directory, action) {
  const lock = path.join(directory, "lock");
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    fs.rmdirSync(lock);
  }
}

function checkSession(directory, env) {
  const session = JSON.parse(fs.readFileSync(path.join(directory, "active.json"), "utf8"));
  if (session.taskId !== env.WTM_TASK_ID) throw new Error("WTM editor session mismatch");
}

function record(directory, child, terminal) {
  try {
    fs.appendFileSync(path.join(directory, "groups"), `${child.pid}\n`);
    if (terminal) fs.appendFileSync(path.join(directory, "terminals"), `${child.pid}\n`);
  } catch (error) {
    try {
      killGroup(child.pid);
    } catch {}
    throw error;
  }
  const exited = () => forgetExitedGroup(directory, child.pid);
  if (typeof child.onExit === "function") child.onExit(exited);
  else child.once("exit", exited);
}

// node-pty on Windows learns the shell's pid only once its console connects, after spawn
// returns. Record the terminal then, if its session is still open; otherwise end it.
function recordWhenStarted(directory, env, child) {
  let ended = false;
  child.onExit(() => (ended = true));
  const deadline = Date.now() + 10000;
  const poll = () => {
    if (ended) return;
    if (!started(child.pid)) {
      if (Date.now() < deadline) setTimeout(poll, 10);
      else child.kill();
      return;
    }
    try {
      locked(directory, () => {
        checkSession(directory, env);
        record(directory, child, true);
      });
    } catch {
      try {
        killGroup(child.pid);
      } catch {}
    }
  };
  setTimeout(poll, 10);
}

function track(env, spawn, terminal = false) {
  const generation = env?.WTM_EDITOR_SESSION;
  if (!controlRoot) return spawn();
  if (!/^[a-f0-9]{48}$/.test(generation ?? "")) {
    throw new Error("Missing WTM editor session");
  }
  const directory = path.join(controlRoot, generation);
  return locked(directory, () => {
    checkSession(directory, env);
    const child = spawn();
    if (started(child.pid)) record(directory, child, terminal);
    else if (terminal && child.pid === 0) recordWhenStarted(directory, env, child);
    else throw new Error("Editor process did not start");
    return child;
  });
}

if (controlRoot) {
  const fork = childProcess.fork;
  childProcess.fork = function (modulePath, args, options) {
    if (!Array.isArray(args) || !args.includes("--type=extensionHost")) {
      return fork.call(this, modulePath, args, options);
    }
    return track(options?.env, () =>
      fork.call(this, modulePath, args, { ...options, detached: !windows })
    );
  };
  syncBuiltinESMExports();
}

globalThis.__wtmSpawnPty = (spawn, file, args, options) =>
  track(options?.env, () => spawn(file, args, options), true);
