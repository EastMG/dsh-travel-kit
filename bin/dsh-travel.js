#!/usr/bin/env node
/**
 * dsh-travel —— 旅行工具链统一入口
 *
 *   dsh-travel maps   <子命令> ...   高德路线 / POI / 矩阵 / 时间轴 / ICS
 *   dsh-travel wendao --query "..."  携程问道
 *   dsh-travel install [--dir <skills目录>] [--force]
 *   dsh-travel where                 打印技能目录与配置路径
 *   dsh-travel doctor                检查两套 Key 是否可用
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));

const SKILLS = {
  maps: path.join(ROOT, 'skills', 'maps', 'scripts', 'maps.cjs'),
  wendao: path.join(ROOT, 'skills', 'wendao', 'scripts', 'wendao.cjs'),
};

function usage() {
  process.stdout.write(
    [
      `dsh-travel ${PKG.version}`,
      '',
      '用法:',
      '  dsh-travel maps <子命令> [...]        高德：geocode/route/poi/detail/weather/matrix/schedule/ics',
      '  dsh-travel wendao --query "..."        携程问道：一句话问行程',
      '  dsh-travel install [--dir DIR] [--force]  把技能装进 agent 的 skills 目录',
      '  dsh-travel where                       打印路径与 Key 配置位置',
      '  dsh-travel doctor                      检查两套 Key',
      '',
      '例:',
      '  dsh-travel maps route --from "北京南站" --to "天安门" --mode driving',
      '  dsh-travel maps schedule --from "酒店" --pois "豫园|外滩" --date 2026-11-25',
      '  dsh-travel maps ics --from "酒店" --pois "豫园|外滩" --date 2026-11-25 --out trip.ics',
      '  dsh-travel wendao --query "11月25日北京到上海高铁，二等座"',
      '',
      '首次使用请先配 Key:',
      '  dsh-travel maps doctor                                  # 看高德 Key 状态',
      '  dsh-travel maps config set AMAP_MAPS_API_KEY <key>',
      '  dsh-travel wendao config set WENDAO_API_KEY <token>',
      '',
    ].join('\n')
  );
}

function run(file, args) {
  if (!require('fs').existsSync(file)) {
    process.stderr.write(`内部错误：找不到 ${file}\n`);
    process.exit(1);
  }
  // stdio: 'inherit' —— 避免在受限沙箱里走管道导致 EPERM
  const r = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`执行失败：${r.error.message}\n`);
    process.exit(1);
  }
  process.exit(r.status == null ? 1 : r.status);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    process.stdout.write(PKG.version + '\n');
    process.exit(0);
  }
  if (cmd === 'maps' || cmd === 'wendao') {
    run(SKILLS[cmd], rest);
    return;
  }
  if (cmd === 'install') {
    run(path.join(ROOT, 'scripts', 'install.js'), rest);
    return;
  }
  if (cmd === 'where') {
    run(path.join(ROOT, 'scripts', 'install.js'), ['--where']);
    return;
  }
  if (cmd === 'doctor') {
    const r1 = spawnSync(process.execPath, [SKILLS.maps, 'doctor'], { encoding: 'utf8' });
    const r2 = spawnSync(process.execPath, [SKILLS.wendao, 'config', 'get'], { encoding: 'utf8' });
    process.stdout.write('高德  : ' + (r1.stdout || r1.stderr || '').trim() + '\n');
    process.stdout.write('携程  : ' + (r2.stdout || r2.stderr || '').trim() + '\n');
    process.exit(0);
  }

  process.stderr.write(`未知命令: ${cmd}\n\n`);
  usage();
  process.exit(2);
}

main();