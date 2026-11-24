import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const preload = fileURLToPath(
  new URL("../../src-tauri/src/commands/code_server/session.cjs", import.meta.url)
);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wtm-editor-session-"));
  temporary.push(root);
  const generation = "a".repeat(48);
  const directory = join(root, generation);
  await mkdir(directory);
  await writeFile(join(directory, "active.json"), JSON.stringify({ taskId: "task-a" }));
  const child = join(root, "child.cjs");
  await writeFile(
    child,
    "process.send({ taskId: process.env.WTM_TASK_ID }); setInterval(() => {}, 1000);"
  );
  return { root, generation, directory, child };
}

describe("shared editor process ownership", () => {
  it("starts extension hosts in their own recorded process group with the task environment", async () => {
    const data = await fixture();
    const script = `
      const cp = require('node:child_process');
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      const { once } = require('node:events');
      const fixture = ${JSON.stringify(data)};
      (async () => {
        const child = cp.fork(fixture.child, ['--type=extensionHost'], {
          execArgv: [],
          env: { ...process.env, WTM_TASK_ID: 'task-a', WTM_EDITOR_SESSION: fixture.generation }
        });
        try {
          const [message] = await once(child, 'message');
          assert.equal(message.taskId, 'task-a');
          assert.equal(fs.readFileSync(fixture.directory + '/groups', 'utf8'), child.pid + '\\n');
          process.kill(-child.pid, 0);
          console.log('owned');
        } finally {
          const exited = once(child, 'exit');
          process.kill(-child.pid, 'SIGKILL');
          await exited;
          assert.equal(fs.readFileSync(fixture.directory + '/groups', 'utf8'), '');
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = await execute(process.execPath, ["--require", preload, "-e", script], {
      env: { ...process.env, WTM_EDITOR_CONTROL: data.root },
      timeout: 5000,
    });
    expect(result.stdout.trim()).toBe("owned");
  });

  it("tracks terminal groups separately and releases the idle blocker after exit", async () => {
    const data = await fixture();
    const script = `
      const cp = require('node:child_process');
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      const { once } = require('node:events');
      const fixture = ${JSON.stringify(data)};
      (async () => {
        const env = { ...process.env, WTM_TASK_ID: 'task-a', WTM_EDITOR_SESSION: fixture.generation };
        const child = globalThis.__wtmSpawnPty(
          (file, args, options) => cp.spawn(file, args, { ...options, detached: true }),
          process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env }
        );
        try {
          assert.equal(fs.readFileSync(fixture.directory + '/terminals', 'utf8'), child.pid + '\\n');
          assert.equal(fs.readFileSync(fixture.directory + '/groups', 'utf8'), child.pid + '\\n');
        } finally {
          const exited = once(child, 'exit');
          process.kill(-child.pid, 'SIGKILL');
          await exited;
        }
        assert.equal(fs.readFileSync(fixture.directory + '/terminals', 'utf8'), '');
        assert.equal(fs.readFileSync(fixture.directory + '/groups', 'utf8'), '');
        console.log('released');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = await execute(process.execPath, ["--require", preload, "-e", script], {
      env: { ...process.env, WTM_EDITOR_CONTROL: data.root },
      timeout: 5000,
    });
    expect(result.stdout.trim()).toBe("released");
  });

  // node-pty on Windows reports the shell's pid only once its console connects.
  const latePidTerminal = `
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const { once } = require('node:events');
    const until = async (condition) => {
      for (const deadline = Date.now() + 4000; !condition(); ) {
        if (Date.now() > deadline) throw new Error('condition not met');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const read = (name) => fs.existsSync(fixture.directory + '/' + name)
      ? fs.readFileSync(fixture.directory + '/' + name, 'utf8') : null;
    const startShell = () => {
      const shell = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: process.platform !== 'win32'
      });
      const exits = [];
      shell.on('exit', () => exits.forEach((listener) => listener()));
      const pty = { pid: 0, onExit: (listener) => exits.push(listener), kill: () => shell.kill() };
      const env = { ...process.env, WTM_TASK_ID: 'task-a', WTM_EDITOR_SESSION: fixture.generation };
      assert.equal(globalThis.__wtmSpawnPty(() => pty, 'shell', [], { env }), pty);
      assert.equal(read('terminals'), null);
      return { shell, pty, exited: once(shell, 'exit') };
    };
  `;

  it("records a terminal whose pid is reported after it starts", async () => {
    const data = await fixture();
    const script = `
      const fixture = ${JSON.stringify(data)};
      ${latePidTerminal}
      (async () => {
        const { shell, pty, exited } = startShell();
        pty.pid = shell.pid;
        await until(() => read('terminals') === shell.pid + '\\n');
        assert.equal(read('groups'), shell.pid + '\\n');
        shell.kill();
        await exited;
        await until(() => read('terminals') === '' && read('groups') === '');
        console.log('recorded');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = await execute(process.execPath, ["--require", preload, "-e", script], {
      env: { ...process.env, WTM_EDITOR_CONTROL: data.root },
      timeout: 10000,
    });
    expect(result.stdout.trim()).toBe("recorded");
  });

  it("ends a terminal whose session closed before its pid was reported", async () => {
    const data = await fixture();
    const script = `
      const fixture = ${JSON.stringify(data)};
      ${latePidTerminal}
      (async () => {
        const { shell, pty, exited } = startShell();
        fs.unlinkSync(fixture.directory + '/active.json');
        pty.pid = shell.pid;
        await exited;
        assert.equal(read('terminals'), null);
        assert.equal(read('groups'), null);
        assert.equal(fs.existsSync(fixture.directory + '/lock'), false);
        console.log('ended');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = await execute(process.execPath, ["--require", preload, "-e", script], {
      env: { ...process.env, WTM_EDITOR_CONTROL: data.root },
      timeout: 10000,
    });
    expect(result.stdout.trim()).toBe("ended");
  });

  it("rejects closed, mismatched and missing sessions before spawning", async () => {
    const data = await fixture();
    const script = `
      const cp = require('node:child_process');
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      const fixture = ${JSON.stringify(data)};
      const spawn = env => cp.fork(fixture.child, ['--type=extensionHost'], { execArgv: [], env });
      assert.throws(() => spawn({ WTM_TASK_ID: 'task-a' }), /Missing WTM/);
      assert.throws(() => spawn({ WTM_TASK_ID: 'task-b', WTM_EDITOR_SESSION: fixture.generation }), /mismatch/);
      fs.unlinkSync(fixture.directory + '/active.json');
      assert.throws(() => spawn({ WTM_TASK_ID: 'task-a', WTM_EDITOR_SESSION: fixture.generation }), /ENOENT/);
      assert.equal(fs.existsSync(fixture.directory + '/groups'), false);
      assert.equal(fs.existsSync(fixture.directory + '/lock'), false);
      console.log('rejected');
    `;
    const result = await execute(process.execPath, ["--require", preload, "-e", script], {
      env: { ...process.env, WTM_EDITOR_CONTROL: data.root },
      timeout: 5000,
    });
    expect(result.stdout.trim()).toBe("rejected");
  });
});
