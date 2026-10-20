/**
 * exec.js 的測試（NFR-7：子行程原語「一定會解決」）。
 *
 * 逾時與找不到執行檔都必須是回傳值，不是例外——上層才可能把它們寫進 UI。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileText, searchPath, splitPathDirs } from '../lib/exec.js';

/**
 * 建立「bash 先退出、sleep 孫行程接手 stdout/stderr」的情境。
 *
 * 這個孫行程會讓 ChildProcess 的 `close` 事件延後到 sleep 結束才出現；測試用
 * pid 檔在收尾時把它殺掉，避免每次跑測試都留一個 30 秒的孤兒行程。
 *
 * @param {object} t - node:test 的 TestContext。
 * @returns {Promise<{args: string[], pidFile: string}>} bash 參數與孫行程 pid 檔。
 */
async function makeGrandchildHolder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-exec-holder-'));
  const pidFile = join(dir, 'grandchild.pid');
  const args = [
    '-c',
    'sleep 30 & echo $! > "$1"; printf held-out; printf held-err >&2; exit 0',
    'exec-test-holder',
    pidFile,
  ];
  t.after(async function () {
    try {
      const text = await readFile(pidFile, 'utf8');
      const pid = Number.parseInt(text.trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 已經結束就沒有可殺的目標。
        }
      }
    } catch {
      // pid 檔可能還沒寫出來（spawn 失敗或測試極早中斷）。
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { args: args, pidFile: pidFile };
}

/**
 * 等孫行程的 pid 檔出現：確保 abort 時 sleep 已經接手 stdout/stderr。
 *
 * @param {string} pidFile - 孫行程 pid 檔。
 * @param {number} timeoutMs - 上限毫秒。
 * @returns {Promise<void>} pid 檔可讀時完成。
 */
async function waitForHolderPid(pidFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(pidFile, 'utf8');
      if (text.trim().length > 0) return;
    } catch {
      // 還沒寫出來，稍後再試。
    }
    await new Promise(function (resolve) { setTimeout(resolve, 10); });
  }
  throw new Error('等待孫行程 pid 檔逾時：' + pidFile);
}

/**
 * 等 promise 解決，但最多等 timeoutMs；用來把「永不 settle」變成可斷言的失敗。
 *
 * @param {Promise<object>} promise - 待測的 promise。
 * @param {number} timeoutMs - 上限毫秒。
 * @param {number} startedAt - Date.now() 起點。
 * @returns {Promise<{result: object|undefined, elapsedMs: number, timedOut: boolean}>} 結果。
 */
async function settleWithin(promise, timeoutMs, startedAt) {
  let timer;
  const outcome = await Promise.race([
    promise.then(function (result) {
      return { result: result, elapsedMs: Date.now() - startedAt, timedOut: false };
    }),
    new Promise(function (resolve) {
      timer = setTimeout(function () {
        resolve({ result: undefined, elapsedMs: Date.now() - startedAt, timedOut: true });
      }, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome;
}

test('searchPath：先目錄後檔名，命中即回傳', async function () {
  const seen = [];
  /**
   * 記錄探測順序的假探針。
   * @param {string} candidate - 候選路徑。
   * @returns {Promise<boolean>} 是否視為可執行。
   */
  async function probe(candidate) {
    seen.push(candidate);
    return candidate.endsWith('/codebase-memory-mcp');
  }
  const found = await searchPath(['codebase-memory-mcp', 'codebase-memory-mcp.exe'], '/a:/b', probe);
  assert.equal(found, '/a/codebase-memory-mcp');
  assert.deepEqual(seen, ['/a/codebase-memory-mcp'], '第一個目錄命中就不該再探測');
});

test('searchPath：同目錄內先試第一個檔名，落空才試第二個', async function () {
  const seen = [];
  /**
   * 只認 .exe 的假探針。
   * @param {string} candidate - 候選路徑。
   * @returns {Promise<boolean>} 是否視為可執行。
   */
  async function probe(candidate) {
    seen.push(candidate);
    return candidate.endsWith('.exe');
  }
  const found = await searchPath(['cbm', 'cbm.exe'], '/only', probe);
  assert.equal(found, '/only/cbm.exe');
  assert.deepEqual(seen, ['/only/cbm', '/only/cbm.exe']);
});

test('searchPath：全部落空回 undefined，並容納多餘斜線與空目錄項', async function () {
  const seen = [];
  /**
   * 什麼都不認的假探針。
   * @param {string} candidate - 候選路徑。
   * @returns {Promise<boolean>} 永遠 false。
   */
  async function probe(candidate) {
    seen.push(candidate);
    return false;
  }
  const found = await searchPath(['cbm'], '/a//:/b/', probe);
  assert.equal(found, undefined);
  assert.deepEqual(seen, ['/a/cbm', '/b/cbm'], '空目錄項與尾斜線都要被收斂');
  assert.equal(await searchPath(['cbm'], '', probe), undefined);
  assert.equal(await searchPath(['cbm'], undefined, probe), undefined);
});

test('execFileText：捕捉 stdout、stderr 與退出碼', async function () {
  const result = await execFileText(process.execPath, [
    '-e',
    'process.stdout.write("out-line");process.stderr.write("err-line");process.exit(7);',
  ], { timeoutMs: 20000 });
  assert.equal(result.stdout, 'out-line');
  assert.equal(result.stderr, 'err-line');
  assert.equal(result.code, 7);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.equal(result.spawnError, undefined);
});

test('execFileText：逾時會解決而不是 reject，且 timedOut 為 true', async function () {
  const result = await execFileText(process.execPath, ['-e', 'setTimeout(function () {}, 60000);'], {
    timeoutMs: 300,
    killGraceMs: 200,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.equal(result.code !== 0 || result.signal !== null, true, '逾時的子行程不該是正常結束');
});

test('execFileText：找不到執行檔時 spawnError 有值且 Promise 照樣解決', async function () {
  const missing = join('/nonexistent-cbm-dir', 'definitely-not-here');
  const result = await execFileText(missing, [], { timeoutMs: 5000 });
  assert.equal(typeof result.spawnError, 'string');
  assert.equal(result.spawnError.length > 0, true);
  assert.equal(result.code, null);
  assert.equal(result.stdout, '');
  assert.equal(result.timedOut, false);
});

test('execFileText：AbortSignal 取消時 aborted 為 true 且不 reject', async function () {
  const controller = new AbortController();
  const pending = execFileText(process.execPath, ['-e', 'setTimeout(function () {}, 60000);'], {
    timeoutMs: 30000,
    killGraceMs: 200,
    signal: controller.signal,
  });
  controller.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});

test('execFileText：孫行程接手 stdout 時，逾時仍在 killGrace+1s 後 settle', async function (t) {
  const holder = await makeGrandchildHolder(t);
  const startedAt = Date.now();
  const pending = execFileText('bash', holder.args, { timeoutMs: 300, killGraceMs: 100 });
  const outcome = await settleWithin(pending, 5000, startedAt);

  assert.equal(outcome.result !== undefined, true, '5 秒內必須 settle，不能卡在 close 事件');
  assert.equal(outcome.elapsedMs >= 1000, true, 'fallback 不得早於 killGrace+1s');
  assert.equal(outcome.elapsedMs < 4000, true, 'fallback 必須在 killGrace+1s 附近收尾（CI 負載下留餘裕）');
  const result = outcome.result;
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL', 'fallback 是強制收尾，signal 要能分辨');
  assert.equal(result.spawnError, undefined);
  assert.equal(result.stdout.includes('held-out'), true, 'fallback 前收到的 stdout 不能丟');
  assert.equal(result.stderr.includes('held-err'), true, 'fallback 前收到的 stderr 不能丟');
});

test('execFileText：孫行程接手 stdout 時，abort 仍在 killGrace+1s 後 settle', async function (t) {
  const holder = await makeGrandchildHolder(t);
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = execFileText('bash', holder.args, {
    timeoutMs: 30000,
    killGraceMs: 100,
    signal: controller.signal,
  });
  // 先確定 sleep 已接手 pipe 再 abort；否則 abort 可能早於 fork，
  // 變成「直接殺掉 bash」的普通案例，測不到孫行程持有 pipe 的路徑。
  await waitForHolderPid(holder.pidFile, 2000);
  controller.abort();
  const outcome = await settleWithin(pending, 5000, startedAt);

  assert.equal(outcome.result !== undefined, true, 'abort 後 5 秒內必須 settle');
  assert.equal(outcome.elapsedMs >= 1000, true, 'fallback 不得早於 killGrace+1s');
  assert.equal(outcome.elapsedMs < 4000, true, 'fallback 必須在 killGrace+1s 附近收尾（CI 負載下留餘裕）');
  const result = outcome.result;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL', 'fallback 是強制收尾，signal 要能分辨');
  assert.equal(result.spawnError, undefined);
  assert.equal(result.stdout.includes('held-out'), true, 'fallback 前收到的 stdout 不能丟');
  assert.equal(result.stderr.includes('held-err'), true, 'fallback 前收到的 stderr 不能丟');
});

test('D5：splitPathDirs 用平台分隔符切 PATH（Windows 是分號）', function () {
  assert.deepEqual(splitPathDirs(['/a', '/b'].join(delimiter)), ['/a', '/b']);
  assert.deepEqual(splitPathDirs(''), []);
  assert.deepEqual(splitPathDirs(undefined), []);
  assert.deepEqual(splitPathDirs(delimiter + '/a' + delimiter + delimiter), ['/a'], '空目錄項要濾掉');
  // 另一個平台的符號不得被當成分隔符：'a:b' 在 POSIX 上是兩個目錄，
  // 在 Windows 上必須是**一個**（目錄名裡有冒號）。這條斷言跟著平台走。
  const other = delimiter === ':' ? ';' : ':';
  assert.deepEqual(
    splitPathDirs('/a' + other + '/b'),
    delimiter === ':' ? ['/a' + other + '/b'] : ['/a', '/b'],
    '只有本平台的分隔符能切開 PATH',
  );
});
