#!/usr/bin/env node
/**
 * docs:check — 文件事實漂移守門。
 *
 * 只依賴 `node:` 內建模組與 repo 內的檔案；不連 live GUI、不呼叫 CBM CLI。
 *
 * 1. 實際跑一次 `node --test`，取 TAP 的 pass/fail/skipped 數，比對 README.md、
 *    README.en.md、CONTRIBUTING.md、docs/DEVELOPMENT.md 的
 *    `**N tests / N pass / 0 fail**`，以及三處「N 項單元測試」註解。
 *    少數測試需要本機 DSH 或平台後端，CI 會明確 skip；文件寫的是完整套件的
 *    總數，因此用 `pass + skipped` 比對，且只允許 fail=0。
 * 2. verify-client / verify-keeper 的 `**N/N**` 只做文件互比
 *    （README 兩份 + DEVELOPMENT）：重跑前者需要 `dsh web`，後者需要
 *    CBM CLI；這裡不假裝能重跑 live。
 * 3. 相容表要有目前 major.minor.x，且 DSH 下限字串等於
 *    `package.json` 的 `engines.dsh`。
 * 4. README.en.md 除語言切換行外不得有 CJK。
 * 5. README / docs 的相對連結與圖片目標必須存在。
 *
 * 刻意不提供 --write：文件是手改的，CI 只負責紅燈。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let checks = 0;

function fail(message) {
  failures.push(message);
}

function ok(message) {
  checks += 1;
  console.log('  ok  ' + message);
}

function read(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function singleLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function listMarkdownFiles() {
  const files = ['README.md', 'README.en.md', 'CONTRIBUTING.md'];
  const docsDir = path.join(ROOT, 'docs');
  const names = readdirSync(docsDir).filter(function (name) {
    return name.endsWith('.md');
  }).sort();
  let i;
  for (i = 0; i < names.length; i += 1) {
    files.push(path.join('docs', names[i]));
  }
  return files;
}

function lastNumber(lines) {
  if (lines.length === 0) return undefined;
  return Number(lines[lines.length - 1].replace(/\D+/g, ''));
}

function runUnitTests() {
  const testDir = path.join(ROOT, 'test');
  const files = readdirSync(testDir).filter(function (name) {
    return name.endsWith('.test.js');
  }).sort().map(function (name) {
    return path.join('test', name);
  });
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap'].concat(files),
    { cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 },
  );
  const stdout = result.stdout === null || result.stdout === undefined ? '' : result.stdout;
  const stderr = result.stderr === null || result.stderr === undefined ? '' : result.stderr;
  return {
    error: result.error,
    status: result.status,
    pass: lastNumber(stdout.match(/^# pass (\d+)$/gm) || []),
    failed: lastNumber(stdout.match(/^# fail (\d+)$/gm) || []),
    skipped: lastNumber(stdout.match(/^# skipped (\d+)$/gm) || []),
    cancelled: lastNumber(stdout.match(/^# cancelled (\d+)$/gm) || []),
    todo: lastNumber(stdout.match(/^# todo (\d+)$/gm) || []),
    tests: lastNumber(stdout.match(/^# tests (\d+)$/gm) || []),
    stdout: stdout,
    stderr: stderr,
  };
}

function checkTestCounts(total, pass, skipped) {
  const before = failures.length;
  if (pass + skipped !== total) {
    fail('node --test 的 pass(' + pass + ') + skipped(' + skipped + ') 不等於 tests('
      + total + ')；有測試沒有回報結果');
  }
  const rowFiles = ['README.md', 'README.en.md', 'CONTRIBUTING.md', 'docs/DEVELOPMENT.md'];
  let spots = 0;
  let i;
  for (i = 0; i < rowFiles.length; i += 1) {
    const file = rowFiles[i];
    const text = read(file);
    const pattern = /\*\*(\d+) tests \/ (\d+) pass \/ 0 fail/g;
    let match;
    let found = 0;
    while ((match = pattern.exec(text)) !== null) {
      found += 1;
      spots += 1;
      const tests = Number(match[1]);
      const passed = Number(match[2]);
      if (tests !== total || passed !== total) {
        fail(file + ':' + lineOf(text, match.index) + ' 寫 tests=' + tests + ' pass=' + passed
          + '，實際 tests=' + total + ' pass=' + pass + ' skipped=' + skipped);
      }
    }
    if (found === 0) {
      fail(file + ' 找不到 `**N tests / N pass / 0 fail**`');
    }
  }

  const commentSpecs = [
    { file: 'README.md', pattern: /# (\d+) 項單元測試/g },
    { file: 'README.en.md', pattern: /# (\d+) unit tests/g },
    { file: 'docs/DEVELOPMENT.md', pattern: /# 單元測試（(\d+) 項/g },
  ];
  for (i = 0; i < commentSpecs.length; i += 1) {
    const spec = commentSpecs[i];
    const text = read(spec.file);
    let match;
    let found = 0;
    while ((match = spec.pattern.exec(text)) !== null) {
      found += 1;
      spots += 1;
      if (Number(match[1]) !== total) {
        fail(spec.file + ':' + lineOf(text, match.index) + ' 的註解寫 ' + match[1]
          + '，實際 tests=' + total + ' pass=' + pass + ' skipped=' + skipped);
      }
    }
    spec.pattern.lastIndex = 0;
    if (found === 0) {
      fail(spec.file + ' 找不到單元測試數量的註解');
    }
  }

  if (failures.length === before) {
    ok('單元測試 ' + total + ' 與 ' + spots + ' 處文件一致'
      + (skipped > 0 ? '（本輪 ' + pass + ' pass / ' + skipped + ' 項因環境跳過）' : ''));
  }
}

function checkVerifiedCounts() {
  const tools = [
    { name: 'verify-client', marker: 'verify-client.mjs', files: ['README.md', 'README.en.md', 'docs/DEVELOPMENT.md'] },
    { name: 'verify-keeper', marker: 'verify-keeper.mjs', files: ['README.md', 'README.en.md', 'docs/DEVELOPMENT.md'] },
  ];
  let t;
  for (t = 0; t < tools.length; t += 1) {
    const tool = tools[t];
    const before = failures.length;
    const values = [];
    let spots = 0;
    let f;
    for (f = 0; f < tool.files.length; f += 1) {
      const file = tool.files[f];
      const lines = read(file).split('\n');
      let found = 0;
      let i;
      for (i = 0; i < lines.length; i += 1) {
        if (lines[i].indexOf(tool.marker) === -1) continue;
        const match = lines[i].match(/\*\*(\d+)\/(\d+)\*\*/);
        if (match === null) continue;
        found += 1;
        spots += 1;
        if (match[1] !== match[2]) {
          fail(file + ':' + (i + 1) + ' 的 ' + tool.name + ' 分子分母不同：' + match[0]);
        }
        values.push(Number(match[1]));
      }
      if (found === 0) {
        fail(file + ' 找不到 ' + tool.name + ' 的 `**N/N**`');
      }
    }
    const unique = Array.from(new Set(values));
    if (unique.length !== 1) {
      fail(tool.name + ' 文件間數字不一致：' + unique.join(', '));
    } else if (spots > 0 && failures.length === before) {
      ok(tool.name + ' ' + unique[0] + '/' + unique[0] + ' 在 ' + spots
        + ' 處文件一致（未重跑 live）');
    }
  }
}

function checkCompatTable() {
  const pkg = JSON.parse(read('package.json'));
  const parts = String(pkg.version).split('.');
  const expected = '`' + parts[0] + '.' + parts[1] + '.x`';
  const dsh = pkg.engines === undefined ? undefined : pkg.engines.dsh;
  if (typeof dsh !== 'string') {
    fail('package.json 缺少 engines.dsh');
    return;
  }
  const files = ['README.md', 'README.en.md'];
  let f;
  for (f = 0; f < files.length; f += 1) {
    const file = files[f];
    const before = failures.length;
    const lines = read(file).split('\n');
    let found = 0;
    let i;
    for (i = 0; i < lines.length; i += 1) {
      if (lines[i].indexOf(expected) === -1) continue;
      found += 1;
      if (lines[i].indexOf('`' + dsh + '`') === -1) {
        fail(file + ':' + (i + 1) + ' 的 DSH 下限不是 `' + dsh + '`');
      }
    }
    if (found !== 1) {
      fail(file + ' 的相容表應有且只有一列 ' + expected + '，實際 ' + found + ' 列');
    }
    if (failures.length === before) {
      ok(file + ' 相容表為 ' + expected + ' / ' + dsh);
    }
  }
}

function checkEnglishCjk() {
  const file = 'README.en.md';
  const lines = read(file).split('\n');
  let bad = 0;
  let i;
  for (i = 0; i < lines.length; i += 1) {
    if (!/[\u4e00-\u9fff]/.test(lines[i])) continue;
    if (lines[i].indexOf('[中文](README.md)') !== -1) continue;
    bad += 1;
    fail(file + ':' + (i + 1) + ' 仍有 CJK：' + singleLine(lines[i]));
  }
  if (bad === 0) {
    ok('README.en 除語言切換行外零 CJK');
  }
}

function checkRelativeLinks() {
  const before = failures.length;
  const files = listMarkdownFiles();
  let checked = 0;
  let f;
  for (f = 0; f < files.length; f += 1) {
    const file = files[f];
    const lines = read(file).split('\n');
    let inFence = false;
    let i;
    for (i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim().indexOf('```') === 0) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        let target = match[1].trim();
        if (target.indexOf('<') === 0 && target.lastIndexOf('>') === target.length - 1) {
          target = target.slice(1, -1).trim();
        }
        if (target === '' || target.indexOf('#') === 0
          || target.indexOf('http://') === 0 || target.indexOf('https://') === 0
          || target.indexOf('mailto:') === 0) {
          continue;
        }
        const hash = target.indexOf('#');
        if (hash !== -1) target = target.slice(0, hash);
        if (target === '') continue;
        checked += 1;
        const resolved = path.resolve(ROOT, path.dirname(file), target);
        if (!existsSync(resolved)) {
          fail(file + ':' + (i + 1) + ' 連結目標不存在：' + target);
        }
      }
    }
  }
  if (failures.length === before) {
    ok('相對連結／圖片 ' + checked + ' 個目標都存在');
  }
}

function main() {
  console.log('docs:check（不需要 live GUI 或 CBM CLI）');

  const tests = runUnitTests();
  if (tests.error !== undefined && tests.error !== null) {
    fail('node --test 無法執行：' + tests.error.message);
  }
  if (tests.failed !== 0) {
    fail('node --test 有 ' + String(tests.failed) + ' 個失敗');
  }
  if (tests.status !== 0) {
    fail('node --test exit code = ' + String(tests.status));
  }
  if (tests.pass === undefined || tests.pass === null) {
    fail('讀不到 node --test 的 TAP pass 數');
  } else {
    const skipped = tests.skipped === undefined ? 0 : tests.skipped;
    const summary = 'node --test：tests ' + String(tests.tests) + ' / pass '
      + String(tests.pass) + ' / skipped ' + String(skipped) + ' / fail ' + String(tests.failed);
    if (tests.status === 0 && tests.failed === 0) {
      ok(summary);
    } else {
      console.log('  run  ' + summary);
    }
    checkTestCounts(tests.tests, tests.pass, skipped);
  }

  checkVerifiedCounts();
  checkCompatTable();
  checkEnglishCjk();
  checkRelativeLinks();

  if (failures.length > 0) {
    console.error('');
    console.error('docs:check failed（' + failures.length + ' 項）：');
    let i;
    for (i = 0; i < failures.length; i += 1) {
      console.error('  - ' + failures[i]);
    }
    if (tests.status !== 0 && tests.stdout !== '') {
      const tail = tests.stdout.split('\n').slice(-20).join('\n');
      console.error('node --test 輸出尾段：');
      console.error(tail);
    }
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('docs:check passed（' + checks + ' 項）');
}

main();
