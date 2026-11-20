#!/usr/bin/env node
/**
 * 携程问道 CLI — 调用携程官方问道接口，返回 markdown。
 *
 * 用法:
 *   node wendao.cjs --query "2026-11-25 北京到上海高铁"
 *   node wendao.cjs config set WENDAO_API_KEY <token>
 *   node wendao.cjs config get
 *
 * Token 来源优先级: 环境变量 WENDAO_API_KEY > ~/.wendao/config.json
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const API_URL = 'https://wendao-skill-prod.ctrip.com/skill/query';
const SOURCE = 'dsh-wendao-skill';
const CONFIG_DIR = path.join(os.homedir(), '.wendao');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function readToken() {
  const env = process.env.WENDAO_API_KEY;
  if (env && env.trim()) return env.trim();
  const cfg = readConfig();
  return typeof cfg.WENDAO_API_KEY === 'string' ? cfg.WENDAO_API_KEY.trim() : '';
}

function saveToken(key) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const cfg = readConfig();
  cfg.WENDAO_API_KEY = key;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  return CONFIG_FILE;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--query' || a === '-q') out.query = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function usage() {
  process.stdout.write(
    [
      'Usage: node wendao.cjs --query "<自然语言旅行问题>" [--timeout 90]',
      '       node wendao.cjs config set WENDAO_API_KEY <token>',
      '       node wendao.cjs config get',
      '',
      '示例:',
      '  node wendao.cjs --query "11月25日北京到上海高铁，二等座"',
      '  node wendao.cjs --query "上海外滩附近每晚800以内的酒店，两个人"',
      '  node wendao.cjs --query "广州去张家界4天，往返交通+住宿+门票"',
      '',
    ].join('\n')
  );
}

async function main() {
  const argv = process.argv.slice(2);

  // config 子命令
  if (argv[0] === 'config') {
    const action = argv[1];
    if (action === 'set' && argv[2] === 'WENDAO_API_KEY' && argv[3]) {
      const p = saveToken(argv[3].trim());
      process.stdout.write(JSON.stringify({ ok: true, key: 'WENDAO_API_KEY', savedTo: p }) + '\n');
      return 0;
    }
    if (action === 'get') {
      const t = readToken();
      const masked = t ? t.slice(0, 4) + '...' + t.slice(-4) : '';
      process.stdout.write(JSON.stringify({ configured: Boolean(t), token: masked, configFile: CONFIG_FILE }) + '\n');
      return 0;
    }
    process.stderr.write('error: usage: config set WENDAO_API_KEY <token> | config get\n');
    return 2;
  }

  const args = parseArgs(argv);
  if (args.help || !args.query) {
    usage();
    return args.query ? 0 : 2;
  }

  const token = readToken();
  const body = { query: args.query, source: SOURCE };
  if (token) body.token = token;

  const timeoutMs = (args.timeout || 90) * 1000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      process.stderr.write(`HTTP ${res.status} ${res.statusText}\n${text}\n`);
      return 1;
    }
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    if (!token) {
      process.stderr.write('hint: 未配置 WENDAO_API_KEY，本次为匿名调用，可能被限流。\n');
    }
    return 0;
  } catch (e) {
    process.stderr.write('request failed: ' + (e && e.message ? e.message : String(e)) + '\n');
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  process.stderr.write('fatal: ' + (e && e.stack ? e.stack : String(e)) + '\n');
  process.exit(1);
});