#!/usr/bin/env node
/**
 * 把 skills/ 下的技能目录复制到 agent 的 skills 目录。
 *
 * 默认目标 ~/.dsh/skills（DeepSeek Harness / Claude Code 风格布局）。
 * 用 --dir 指定其他位置，例如 Claude Code: --dir ~/.claude/skills
 *
 * 只复制 SKILL.md 与 scripts/，永远不复制任何凭证文件。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILL_NAMES = [
  { name: 'maps', experimental: false },
  { name: 'wendao', experimental: true },
];

const MAPS_KEY_FILE = path.join(os.homedir(), '.dsh-maps', 'config.json');
const WENDAO_KEY_FILE = path.join(os.homedir(), '.wendao', 'config.json');

function defaultTarget() {
  if (process.env.DSH_SKILLS_DIR) return process.env.DSH_SKILLS_DIR;
  return path.join(os.homedir(), '.dsh', 'skills');
}

function readFlag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function main(argv) {
  const force = hasFlag(argv, '--force');
  const quiet = hasFlag(argv, '--quiet');
  const target = path.resolve(readFlag(argv, '--dir') || defaultTarget());

  if (hasFlag(argv, '--where')) {
    process.stdout.write(
      JSON.stringify(
        {
          package: ROOT,
          skillsTarget: target,
          mapsKeyFile: MAPS_KEY_FILE,
          wendaoKeyFile: WENDAO_KEY_FILE,
          mapsKeyConfigured: fs.existsSync(MAPS_KEY_FILE),
          wendaoKeyConfigured: fs.existsSync(WENDAO_KEY_FILE),
          node: process.version,
        },
        null,
        2
      ) + '\n'
    );
    return 0;
  }

  fs.mkdirSync(target, { recursive: true });
  const results = [];

  for (const entry of SKILL_NAMES) {
    const { name, experimental } = entry;
    const src = path.join(ROOT, 'skills', name);
    const dst = path.join(target, name);
    if (!fs.existsSync(src)) {
      results.push({ skill: name, experimental, status: 'missing-source' });
      continue;
    }
    if (fs.existsSync(dst)) {
      if (!force) {
        results.push({ skill: name, experimental, status: 'skipped-exists', path: dst });
        continue;
      }
      fs.rmSync(dst, { recursive: true, force: true });
    }
    fs.cpSync(src, dst, { recursive: true });
    results.push({ skill: name, experimental, status: 'installed', path: dst });
  }

  if (quiet) return 0;

  for (const r of results) {
    const icon = r.status === 'installed' ? '✓' : r.status === 'skipped-exists' ? '·' : '✗';
    const tag = r.experimental ? '  [实验性]' : '';
    process.stdout.write(`${icon} ${r.skill.padEnd(8)} ${r.status}${tag}${r.path ? '  ' + r.path : ''}\n`);
  }

  if (results.some((r) => r.experimental && r.status === 'installed')) {
    process.stdout.write(
      '\n注意：wendao 是实验性模块 —— 它调用的接口没有公开文档，可能随时失效，也可能不符合携程服务条款。\n'
    );
  }

  if (results.some((r) => r.status === 'skipped-exists')) {
    process.stdout.write('\n已存在同名技能，未覆盖。要覆盖请加 --force\n');
  }

  process.stdout.write(
    [
      '',
      '下一步：',
      '  1) 配高德 Key（Web服务类型）：',
      '     dsh-travel maps config set AMAP_MAPS_API_KEY <key>',
      '  2) 配携程问道 Token（可选）：',
      '     dsh-travel wendao config set WENDAO_API_KEY <token>',
      '  3) 自检：',
      '     dsh-travel doctor',
      '',
      `技能已复制到：${target}`,
      '新开的 agent 会话才会加载到新技能；当前会话需要重启才可见。',
      '',
    ].join('\n')
  );
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main };