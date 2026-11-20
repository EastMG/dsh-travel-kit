#!/usr/bin/env node
/**
 * 离线自测 —— 不联网、不需要任何 API Key。
 *
 * 覆盖：语法、CLI 基本行为、无 Key 时的降级与报错、安装/幂等、包内容约束。
 * 用法：npm test
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failures.push({ name, message: e.message });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** 在一个干净的 HOME 下运行（确保读不到本机真实凭证） */
function runClean(args, opts = {}) {
  const home = opts.home || mkTmpHome();
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AMAP_MAPS_API_KEY: '',
    WENDAO_API_KEY: '',
  };
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-travel-test-'));
let homeSeq = 0;
function mkTmpHome() {
  const h = path.join(tmpRoot, `home-${homeSeq++}`);
  fs.mkdirSync(h, { recursive: true });
  return h;
}

const MAPS = path.join(ROOT, 'skills', 'maps', 'scripts', 'maps.cjs');
const WENDAO = path.join(ROOT, 'skills', 'wendao', 'scripts', 'wendao.cjs');
const BIN = path.join(ROOT, 'bin', 'dsh-travel.js');
const INSTALL = path.join(ROOT, 'scripts', 'install.js');

console.log('\n[dsh-travel-kit] 离线自测\n');

/* ------------------------- 1. 语法 ------------------------- */

console.log('语法：');
for (const f of [BIN, INSTALL, MAPS, WENDAO, __filename]) {
  test(path.relative(ROOT, f), () => {
    execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
}

/* ------------------------- 2. CLI 基本行为 ------------------------- */

console.log('\nCLI：');
test('--version 与 package.json 一致', () => {
  const r = runClean([BIN, '--version']);
  assert(r.code === 0, `退出码 ${r.code}`);
  assert(r.stdout.trim() === PKG.version, `版本不一致：输出 ${r.stdout.trim()}，期望 ${PKG.version}`);
});

test('--help 列出全部子命令', () => {
  const r = runClean([BIN, '--help']);
  assert(r.code === 0, `退出码 ${r.code}`);
  for (const kw of ['maps', 'wendao', 'install', 'doctor', 'where']) {
    assert(r.stdout.includes(kw), `帮助里缺少 ${kw}`);
  }
});

test('未知命令返回非零并打印用法', () => {
  const r = runClean([BIN, 'nonsense-command']);
  assert(r.code !== 0, '未知命令应返回非零');
  assert(r.stderr.includes('未知命令'), '未提示未知命令');
});

/* ------------------------- 3. 无 Key 的降级行为 ------------------------- */

console.log('\n无 Key 降级：');
test('maps doctor 在无 Key 时正常返回 ok:false（不联网）', () => {
  const r = runClean([MAPS, 'doctor']);
  assert(r.code === 0, `退出码 ${r.code}，stderr=${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert(j.ok === false, 'doctor 应返回 ok:false');
  assert(typeof j.reason === 'string' && j.reason.length > 0, '缺少 reason');
  assert(/未配置/.test(j.reason), `reason 内容异常：${j.reason}`);
});

test('poi 在无 Key 时退出码非零且提示配 Key', () => {
  const r = runClean([MAPS, 'poi', '--keywords', '咖啡馆']);
  assert(r.code !== 0, '应返回非零');
  assert(/AMAP_MAPS_API_KEY/.test(r.stderr), `stderr 未提示 Key：${r.stderr}`);
});

test('detail 在无 Key 时退出码非零', () => {
  const r = runClean([MAPS, 'detail', '--id', 'B000A8UIN8']);
  assert(r.code !== 0, '应返回非零');
});

test('wendao config get 在无 Token 时返回 configured:false', () => {
  const r = runClean([WENDAO, 'config', 'get']);
  assert(r.code === 0, `退出码 ${r.code}`);
  const j = JSON.parse(r.stdout);
  assert(j.configured === false, '应为未配置状态');
  assert(/\.wendao/.test(j.configFile), `configFile 路径异常：${j.configFile}`);
});

test('wendao 无参数时打印用法并返回非零', () => {
  const r = runClean([WENDAO]);
  assert(r.code !== 0, '应返回非零');
});

/* ------------------------- 4. 安装与幂等 ------------------------- */

console.log('\n安装：');
const targetDir = path.join(tmpRoot, 'skills');
test('install --dir 复制出两个技能', () => {
  const r = runClean([INSTALL, '--dir', targetDir]);
  assert(r.code === 0, `退出码 ${r.code}`);
  for (const rel of ['maps/SKILL.md', 'maps/scripts/maps.cjs', 'wendao/SKILL.md', 'wendao/scripts/wendao.cjs']) {
    assert(fs.existsSync(path.join(targetDir, rel)), `缺少 ${rel}`);
  }
});

test('install 输出标注 wendao 为实验性', () => {
  const r = runClean([INSTALL, '--dir', path.join(tmpRoot, 'skills2')]);
  assert(/实验性/.test(r.stdout), '安装输出未标注实验性');
});

test('install 重复执行不覆盖（幂等）', () => {
  const r = runClean([INSTALL, '--dir', targetDir]);
  assert(/skipped-exists/.test(r.stdout), '重复安装应跳过');
});

test('install --force 覆盖成功', () => {
  const r = runClean([INSTALL, '--dir', targetDir, '--force']);
  assert(/installed/.test(r.stdout), 'force 安装应成功');
});

test('install 不复制任何凭证文件', () => {
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/config\.json$|\.env$|token/i.test(e.name)) found.push(path.relative(targetDir, p));
    }
  })(targetDir);
  assert(found.length === 0, `发现疑似凭证文件：${found.join(', ')}`);
});

/* ------------------------- 5. 包内容约束 ------------------------- */

console.log('\n打包：');
test('files 字段包含 CHANGELOG 与安装脚本', () => {
  const files = PKG.files || [];
  assert(files.includes('CHANGELOG.md'), 'files 缺少 CHANGELOG.md');
  assert(files.includes('scripts/install.js'), 'files 缺少 scripts/install.js');
});

test('files 字段不包含测试脚本本身', () => {
  const files = PKG.files || [];
  assert(!files.includes('scripts'), '不应整体包含 scripts 目录（会把 test.js 打进包）');
});

test('技能目录结构与 SKILL.md frontmatter 完整', () => {
  for (const name of ['maps', 'wendao']) {
    const md = fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
    assert(md.startsWith('---'), `${name}/SKILL.md 缺少 frontmatter`);
    assert(/^name:\s*\S+/m.test(md), `${name}/SKILL.md 缺少 name`);
    assert(/^description:\s*\S+/m.test(md), `${name}/SKILL.md 缺少 description`);
  }
});

test('源码中不含硬编码凭证', () => {
  const suspicious = [];
  const files = [BIN, INSTALL, MAPS, WENDAO];
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    if (/sk-[A-Za-z0-9]{16,}/.test(t)) suspicious.push(`${path.basename(f)}: sk- 令牌`);
    if (/\b[0-9a-f]{32}\b/.test(t)) suspicious.push(`${path.basename(f)}: 32 位 hex 疑似 Key`);
  }
  assert(suspicious.length === 0, `疑似硬编码凭证：${suspicious.join('; ')}`);
});

/* ------------------------- 汇总 ------------------------- */

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n结果：${passed} 通过，${failures.length} 失败\n`);
if (failures.length) {
  for (const f of failures) console.log(`  \u2717 ${f.name}\n      ${f.message}`);
  process.exit(1);
}
process.exit(0);