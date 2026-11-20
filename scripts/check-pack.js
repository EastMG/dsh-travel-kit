#!/usr/bin/env node
/**
 * 校验 npm 打包内容 —— 该进的都在，不该进的一个都没有。
 * 用法：node scripts/check-pack.js
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const MUST_INCLUDE = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'bin/dsh-travel.js',
  'scripts/install.js',
  'skills/maps/SKILL.md',
  'skills/maps/scripts/maps.cjs',
  'skills/wendao/SKILL.md',
  'skills/wendao/scripts/wendao.cjs',
];

const MUST_EXCLUDE = [
  'scripts/test.js',
  'scripts/check-pack.js',
  '.gitignore',
  '.gitattributes',
  '.github/',
  'node_modules/',
];

function main() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const info = JSON.parse(raw)[0];
  const files = info.files.map((f) => f.path.replace(/\\/g, '/'));

  const missing = MUST_INCLUDE.filter((m) => !files.includes(m));
  const leaked = MUST_EXCLUDE.filter((m) => files.some((f) => f === m || f.startsWith(m)));

  console.log(`文件数：${files.length}，打包体积：${(info.size / 1024).toFixed(1)} KB`);
  files.forEach((f) => console.log('  ' + f));

  if (missing.length) {
    console.error(`\n\u2717 缺少必需文件：${missing.join(', ')}`);
    process.exit(1);
  }
  if (leaked.length) {
    console.error(`\n\u2717 不应打包的文件混入：${leaked.join(', ')}`);
    process.exit(1);
  }

  console.log('\n\u2713 包内容校验通过');
  process.exit(0);
}

main();