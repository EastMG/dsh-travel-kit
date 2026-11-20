#!/usr/bin/env node
/**
 * maps — 交通路线规划 CLI
 *
 * 双后端：
 *   1) 高德 Web 服务 API（需 AMAP_MAPS_API_KEY）：地理编码 / 驾车 / 步行 / 骑行 / 公交 / POI / 天气
 *   2) OSM 兜底（无需 Key）：Nominatim 地理编码 + OSRM 驾车路径
 *
 * 用法:
 *   node maps.cjs geocode "上海外滩"
 *   node maps.cjs route --from "上海外滩" --to "豫园" --mode driving
 *   node maps.cjs route --from "北京南站" --to "天安门" --mode transit --city 北京
 *   node maps.cjs poi --keywords "咖啡馆" --city 上海
 *   node maps.cjs weather --city 上海
 *   node maps.cjs config set AMAP_MAPS_API_KEY <key>
 *   node maps.cjs config get
 *
 * 所有命令输出单行 JSON 到 stdout，错误到 stderr。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.dsh-maps');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
// Nominatim 的使用政策要求带可识别的 User-Agent，这里带上包名与仓库地址
const UA = 'dsh-travel-kit (+https://github.com/EastMG/dsh-travel-kit)';

const AMAP_BASE = 'https://restapi.amap.com';

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function getKey() {
  const env = process.env.AMAP_MAPS_API_KEY;
  if (env && env.trim()) return env.trim();
  const cfg = readConfig();
  return typeof cfg.AMAP_MAPS_API_KEY === 'string' ? cfg.AMAP_MAPS_API_KEY.trim() : '';
}

function saveKey(key) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const cfg = readConfig();
  cfg.AMAP_MAPS_API_KEY = key;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  return CONFIG_FILE;
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    if (a === '--from') o.from = take();
    else if (a === '--to') o.to = take();
    else if (a === '--via') o.via = take();
    else if (a === '--mode') o.mode = take();
    else if (a === '--city') o.city = take();
    else if (a === '--city2') o.city2 = take();
    else if (a === '--hotels') o.hotels = take();
    else if (a === '--pois') o.pois = take();
    else if (a === '--start') o.start = take();
    else if (a === '--stay') o.stay = take();
    else if (a === '--date') o.date = take();
    else if (a === '--id') o.id = take();
    else if (a === '--out') o.out = take();
    else if (a === '--file') o.file = take();
    else if (a === '--title') o.title = take();
    else if (a === '--business' || a === '--check-hours') o.business = true;
    else if (a === '--keywords' || a === '-k') o.keywords = take();
    else if (a === '--key') o.key = take();
    else if (a === '--timeout') o.timeout = Number(take());
    else if (a === '--help' || a === '-h') o.help = true;
    else o._.push(a);
  }
  return o;
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function die(msg, code) {
  process.stderr.write(String(msg) + '\n');
  process.exit(code || 1);
}

async function getJSON(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || 25000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0, 300)}`);
    return JSON.parse(txt);
  } finally {
    clearTimeout(t);
  }
}

/* ----------------------------- 高德后端 ----------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 高德请求封装：免费额度有 QPS 限制（CUQPS_HAS_EXCEEDED_THE_LIMIT / infocode 10021），
 * 批量查多个点时必然撞上。这里做退避重试，避免把限流当成真错误抛给调用方。
 */
async function amapGet(u, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const j = await getJSON(u);
    if (j.status === '1') return j;
    const info = String(j.info || '');
    const code = String(j.infocode || '');
    last = new Error('amap: ' + (info || 'error') + (code ? ` (${code})` : ''));
    const isQps = info.includes('CUQPS') || code === '10021';
    if (isQps && i < attempts - 1) {
      await sleep(700 * (i + 1));
      continue;
    }
    throw last;
  }
  throw last;
}

async function amapGeocode(key, address, city) {
  const u = new URL(`${AMAP_BASE}/v3/geocode/geo`);
  u.searchParams.set('key', key);
  u.searchParams.set('address', address);
  if (city) u.searchParams.set('city', city);
  const j = await amapGet(u.toString());
  const g = (j.geocodes || [])[0];
  if (!g) return null;
  return {
    name: g.formatted_address,
    lng: Number(g.location.split(',')[0]),
    lat: Number(g.location.split(',')[1]),
    adcode: g.adcode,
    city: g.city,
  };
}

const AMAP_ROUTE_PATHS = {
  driving: '/v5/direction/driving',
  walking: '/v5/direction/walking',
  bicycling: '/v5/direction/bicycling',
};

async function amapRoute(key, from, to, mode, city, city2, via) {
  if (mode === 'transit') {
    // 实测：v5 公交规划只认 adcode，传城市名会报 INVALID_PARAMS(20000)
    if (!from.adcode || !to.adcode) {
      throw new Error('amap: 公交规划需要起终点的 adcode，请用地址（而非坐标）作为起终点');
    }
    const u = new URL(`${AMAP_BASE}/v5/direction/transit/integrated`);
    u.searchParams.set('key', key);
    u.searchParams.set('origin', `${from.lng},${from.lat}`);
    u.searchParams.set('destination', `${to.lng},${to.lat}`);
    u.searchParams.set('city1', from.adcode);
    u.searchParams.set('city2', to.adcode);
    u.searchParams.set('show_fields', 'cost');
    const j = await amapGet(u.toString());
    const p = (j.route && j.route.transits && j.route.transits[0]) || null;
    if (!p) return null;
    return {
      provider: 'amap',
      mode,
      distance_m: Number(p.distance || 0),
      duration_s: Number((p.cost && p.cost.duration) || 0),
      walking_distance_m: Number(p.walking_distance || 0),
      fare: (p.cost && p.cost.transit_fee) || null,
      segments: (p.segments || []).map((s) => ({
        walk: s.walking
          ? {
              distance_m: Number(s.walking.distance || 0),
              duration_s: Number((s.walking.cost && s.walking.cost.duration) || 0),
              steps: (s.walking.steps || []).map((x) => x.instruction).slice(0, 4),
            }
          : null,
        bus: ((s.bus && s.bus.buslines) || []).map((b) => ({
          line: b.name,
          from: b.departure_stop && b.departure_stop.name,
          to: b.arrival_stop && b.arrival_stop.name,
          stops: Number(b.via_num || 0),
        })),
      })),
    };
  }

  const p = AMAP_ROUTE_PATHS[mode];
  if (!p) throw new Error(`unsupported mode for amap: ${mode} (driving|walking|bicycling|transit)`);
  const u = new URL(AMAP_BASE + p);
  u.searchParams.set('key', key);
  u.searchParams.set('origin', `${from.lng},${from.lat}`);
  u.searchParams.set('destination', `${to.lng},${to.lat}`);
  // 途经点：高德 v5 仅驾车支持 waypoints，最多 16 个
  if (via && via.length && mode === 'driving') {
    u.searchParams.set('waypoints', via.slice(0, 16).map((p) => `${p.lng},${p.lat}`).join(';'));
  }
  u.searchParams.set('show_fields', 'cost');
  const j = await amapGet(u.toString());
  const r = (j.route && j.route.paths && j.route.paths[0]) || null;
  if (!r) return null;
  return {
    provider: 'amap',
    mode,
    distance_m: Number(r.distance || 0),
    // 骑行接口不返回 cost.duration，这里允许为 0，由上层显示「未知」
    duration_s: Number((r.cost && r.cost.duration) || 0),
    tolls: r.cost && r.cost.tolls,
    steps: (r.steps || []).slice(0, 20).map((s) => ({
      instruction: s.instruction,
      road: s.road_name || s.road,
      distance_m: Number(s.step_distance || 0),
    })),
  };
}

async function amapPoi(key, keywords, city) {
  const u = new URL(`${AMAP_BASE}/v5/place/text`);
  u.searchParams.set('key', key);
  u.searchParams.set('keywords', keywords);
  if (city) u.searchParams.set('region', city);
  u.searchParams.set('page_size', '10');
  const j = await amapGet(u.toString());
  return (j.pois || []).map((p) => ({
    id: p.id,
    name: p.name,
    address: p.address,
    lng: Number(p.location.split(',')[0]),
    lat: Number(p.location.split(',')[1]),
    type: p.type,
    tel: p.tel,
  }));
}

async function amapWeather(key, city) {
  const u = new URL(`${AMAP_BASE}/v3/weather/weatherInfo`);
  u.searchParams.set('key', key);
  u.searchParams.set('city', city);
  u.searchParams.set('extensions', 'all');
  const j = await amapGet(u.toString());
  const c = (j.forecasts || [])[0] || {};
  return {
    city: c.city,
    casts: (c.casts || []).map((d) => ({
      date: d.date,
      dayweather: d.dayweather,
      nightweather: d.nightweather,
      daytemp: d.daytemp,
      nighttemp: d.nighttemp,
      daywind: d.daywind + d.daypower,
    })),
  };
}

/* --------------------- POI 详情 / 编排层公用 --------------------- */

/** v5 的 place/detail 才返回 business（v3 返回 null）。含营业时间、评分、电话。 */
async function amapPoiDetail(key, id) {
  const u = new URL(`${AMAP_BASE}/v5/place/detail`);
  u.searchParams.set('key', key);
  u.searchParams.set('id', id);
  u.searchParams.set('show_fields', 'business');
  const j = await amapGet(u.toString());
  const p = (j.pois || [])[0];
  if (!p) return null;
  const b = p.business || {};
  return {
    id: p.id,
    name: p.name,
    address: p.address,
    type: p.type,
    lng: p.location ? Number(p.location.split(',')[0]) : null,
    lat: p.location ? Number(p.location.split(',')[1]) : null,
    rating: b.rating || null,
    tel: b.tel || null,
    keytag: b.keytag || null,
    opentime: b.opentime_week || b.opentime_today || null,
  };
}

/** 统一取点：优先高德（带 adcode），Key 不可用时降级 OSM */
async function resolvePoint(key, name, city) {
  if (key) {
    try {
      const g = await amapGeocode(key, name, city);
      if (g) return { ...g, label: name, source: 'amap' };
    } catch (e) {
      if (!isKeyProblem(e)) throw e;
    }
  }
  const g = await osmGeocode(name);
  if (!g) return null;
  return { ...g, label: name, source: 'osm' };
}

/** 统一算路：高德优先，失败降级 OSM；公交无降级能力时给出明确错误 */
async function resolveRoute(key, a, b, mode) {
  if (key) {
    try {
      const r = await amapRoute(key, a, b, mode);
      if (r) return r;
      // 高德返回空不是 Key 问题：短距离、末班车后都可能没有公交方案
      throw new Error(`未找到 ${mode} 方案（高德返回空，常见于距离过近或该时段无班次），建议改步行或打车`);
    } catch (e) {
      if (!isKeyProblem(e)) throw e;
    }
  }
  if (mode !== 'driving') {
    throw new Error(`OSM 兜底只支持 driving，无法规划 ${mode}（需要可用的高德 Key）`);
  }
  return osmRoute(a, b, mode);
}

const parseHM = (s) => {
  const m = String(s || '09:00').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`时间格式应为 HH:MM，收到: ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
};
const fmtHM = (min) => {
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/** 最近邻排序（用直线距离近似，避免为排序付出 O(n²) 次真实算路） */
function orderNearest(points) {
  const rest = points.slice(1);
  const order = [points[0]];
  while (rest.length) {
    const last = order[order.length - 1];
    let bi = 0;
    let bd = Infinity;
    rest.forEach((p, i) => {
      const d = haversine(last, p);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    order.push(rest.splice(bi, 1)[0]);
  }
  return order;
}

/** 2-opt 局部优化，消除最近邻常见的交叉往返 */
function twoOpt(order) {
  const cost = (o) => {
    let s = 0;
    for (let i = 1; i < o.length; i++) s += haversine(o[i - 1], o[i]);
    return s;
  };
  let best = order.slice();
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 1; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        if (cost(cand) < cost(best) - 1) {
          best = cand;
          improved = true;
        }
      }
    }
  }
  return best;
}

/** 从 opentime 文本里尽量抽出闭馆日与开放时段 */
function parseOpenTime(text) {
  const out = { raw: text || null, closedWeekdays: [], open: null, close: null };
  if (!text) return out;
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  wk.forEach((w, i) => {
    // 高德的措辞多种多样：关闭 / 不开放 / 闭馆，都要认
    if (new RegExp(`${w}[^，。;；]{0,12}?(全天)?(关闭|不开放|闭馆)`).test(text)) out.closedWeekdays.push(i);
  });
  const m = text.match(/(\d{1,2}:\d{2})\s*[-–—~至]\s*(\d{1,2}:\d{2})/);
  if (m) {
    out.open = m[1];
    out.close = m[2];
  }
  return out;
}

/* ----------------------------- OSM 兜底 ----------------------------- */

/**
 * Nominatim 使用政策：绝对不超过 1 请求/秒，且必须带可识别的 UA。
 * 同一进程内串行节流，避免重试逻辑连发。
 */
let lastOsmAt = 0;
async function osmThrottle() {
  const wait = 1100 - (Date.now() - lastOsmAt);
  if (wait > 0) await sleep(wait);
  lastOsmAt = Date.now();
}

async function osmSearch(q, limit) {
  await osmThrottle();
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', q);
  u.searchParams.set('format', 'json');
  u.searchParams.set('limit', String(limit || 5));
  u.searchParams.set('countrycodes', 'cn');
  u.searchParams.set('accept-language', 'zh-CN,zh');
  const j = await getJSON(u.toString());
  return Array.isArray(j) ? j : [];
}

/**
 * OSM 地理编码（兜底用）。
 * Nominatim 对中文「城市+景点」极易跑偏（实测「上海豫园」→ 上海体育大学，
 * 「上海豫园」甚至能命中纽约的同名餐馆）。策略：
 *   1. 先查全串，取 5 个候选；
 *   2. 用词尾 2 字（通常是 POI 本名）校验，命中即采用；
 *   3. 没命中就用词尾再查一次；
 *   4. 输出 confidence，低置信度时明确报警，不做无声猜测。
 */
async function osmGeocode(address) {
  const term = address.length > 2 ? address.slice(-2) : address;

  let cands = await osmSearch(address, 5);
  let hit = cands.find((c) => (c.display_name || '').includes(term));
  let retried = false;

  if (!hit && term !== address) {
    retried = true;
    cands = await osmSearch(term, 5);
    hit = cands.find((c) => (c.display_name || '').includes(term));
  }
  if (!hit && cands.length) hit = cands[0];
  if (!hit) return null;

  return {
    name: hit.display_name,
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    confidence: (hit.display_name || '').includes(term) ? 'high' : 'low',
    matched_term: term,
    retried,
    candidates: cands.slice(0, 3).map((c) => c.display_name),
  };
}

/** 粗略球面距离（米），用于校验地理编码是否明显跑偏 */
function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function osmRoute(from, to, mode) {
  if (mode !== 'driving') {
    throw new Error(
      `OSM 兜底只支持 driving（当前 mode=${mode}）。要 ${mode}，请配 AMAP_MAPS_API_KEY 走高德。`
    );
  }
  // OSRM 公共 demo server 仅限轻量测试，同样按 1 请求/秒节流
  await osmThrottle();
  const u = new URL(
    `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}`
  );
  u.searchParams.set('overview', 'false');
  const j = await getJSON(u.toString());
  if (j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error('osrm: no route');
  const r = j.routes[0];
  return { provider: 'osm', mode: 'driving', distance_m: Math.round(r.distance), duration_s: Math.round(r.duration) };
}

/* ----------------------------- 主流程 ----------------------------- */

function fmtDur(s) {
  if (!s || !Number.isFinite(s) || s <= 0) return '未知（接口未返回耗时）';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}
function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

/* ---------------------- 高德 Key 诊断 ---------------------- */

const AMAP_KEY_ERRORS = {
  USERKEY_PLAT_NOMATCH:
    'Key 的平台类型不对（infocode 10009）。当前这个 Key 是「Web端(JS API)」或 SDK 类型，本工具走的是「Web服务」接口。' +
    '高德的 Key 分 JS API / Web服务 / iOS / Android 四类，互不通用，且已创建的 Key 改不了类型——请到 https://console.amap.com/dev/key/app 新建一个，服务平台选「Web服务」。',
  INVALID_USER_KEY:
    'Key 无效或已被删除（infocode 10001）。请确认复制完整，或到 https://console.amap.com/dev/key/app 重新申请「Web服务」类型的 Key。',
  INVALID_USER_SCODE:
    '缺少或错误的安全密钥（infocode 10008）。Web服务类型的 Key 一般不需要安全密钥，若你启用了，请改用标准 Web服务 Key。',
  USER_DAILY_QUERY_OVER_LIMIT:
    '当日调用量超限（infocode 10003）。等次日恢复，或在控制台提额。',
  SERVICE_NOT_AVAILABLE:
    '该 Key 未开通此服务（infocode 10012）。在控制台给这个 Key 勾选对应服务。',
};

function isKeyProblem(err) {
  const m = err && err.message ? err.message : String(err);
  return Object.keys(AMAP_KEY_ERRORS).some((k) => m.includes(k));
}

function explainAmapError(err) {
  const m = err && err.message ? err.message : String(err);
  for (const [code, hint] of Object.entries(AMAP_KEY_ERRORS)) {
    if (m.includes(code)) return { code, hint };
  }
  return { code: 'UNKNOWN', hint: m };
}

/* ----------------------------- ICS 日历导出 ----------------------------- */

function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545：每行不超过 75 字节，续行以单个空格开头。中文是 3 字节，必须按字节折叠 */
function icsFold(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const l = Buffer.byteLength(ch, 'utf8');
    if (len + l > 74) {
      out.push(cur);
      cur = ' ';
      len = 1;
    }
    cur += ch;
    len += l;
  }
  out.push(cur);
  return out.join('\r\n');
}

function icsLocal(dateStr, minutes) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`ICS 需要 YYYY-MM-DD 格式的日期，收到: ${dateStr}`);
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const total = Math.round(minutes);
  const shift = Math.floor(total / 1440);
  const rem = ((total % 1440) + 1440) % 1440;
  const d = new Date(base + shift * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(Math.floor(rem / 60))}${p(rem % 60)}00`;
}

function icsFromISO(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) throw new Error(`extra 事件的 start/end 需要 2026-11-25T07:30 格式，收到: ${iso}`);
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}00`;
}

function icsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function icsEvent(ev, stamp) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${ev.uid}-${stamp}@dsh-maps`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=Asia/Shanghai:${ev.start}`,
    `DTEND;TZID=Asia/Shanghai:${ev.end}`,
    `SUMMARY:${icsEscape(ev.summary)}`,
  ];
  if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${icsEscape(ev.description)}`);
  if (ev.alarm) {
    lines.push(
      'BEGIN:VALARM',
      `TRIGGER:-PT${ev.alarm}M`,
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsEscape(ev.summary)}`,
      'END:VALARM'
    );
  }
  lines.push('END:VEVENT');
  return lines;
}

function writeIcs(result, a) {
  const date = result.date || new Date().toISOString().slice(0, 10);
  const tl = result.timeline || [];
  const stamp = icsStamp();
  const events = [];
  let n = 0;

  for (let i = 0; i < tl.length; i++) {
    const it = tl[i];
    if (it.kind !== 'arrive' || it.time == null) continue;
    const prev = tl[i - 1];
    const next = tl[i + 1];
    const legStart = prev && typeof prev.min === 'number' ? prev.min : it.min;
    const legFrom = (it.leg && it.leg.from) || (prev && prev.name) || '';

    events.push(
      icsEvent(
        {
          uid: `leg-${n++}`,
          start: icsLocal(date, legStart),
          end: icsLocal(date, it.min),
          summary: `前往 ${it.name}`,
          location: legFrom,
          description: [it.leg.duration_text, it.leg.distance_text, it.leg.fare ? `票价 ¥${it.leg.fare}` : null]
            .filter(Boolean)
            .join(' · '),
          alarm: 10,
        },
        stamp
      )
    );

    if (next && next.kind === 'depart' && typeof next.min === 'number') {
      events.push(
        icsEvent(
          {
            uid: `visit-${n++}`,
            start: icsLocal(date, it.min),
            end: icsLocal(date, next.min),
            summary: `游览 ${it.name}`,
            location: it.name,
            description: [it.opentime ? `营业时间：${it.opentime}` : null, it.leg ? `从 ${legFrom} 过来 ${it.leg.duration_text}` : null]
              .filter(Boolean)
              .join('\n'),
            alarm: 15,
          },
          stamp
        )
      );
    }
  }

  // 额外事件：--file 指向的 JSON 数组，[{title,start,end,location,description}]
  if (a.file) {
    const raw = JSON.parse(fs.readFileSync(a.file, 'utf8'));
    const extras = Array.isArray(raw) ? raw : raw.events || [];
    for (const e of extras) {
      if (!e || !e.start || !e.end) continue;
      events.push(
        icsEvent(
          {
            uid: `extra-${n++}`,
            start: icsFromISO(e.start),
            end: icsFromISO(e.end),
            summary: e.title || e.summary || '行程',
            location: e.location || '',
            description: e.description || '',
            alarm: e.alarm === 0 ? 0 : e.alarm || 15,
          },
          stamp
        )
      );
    }
  }

  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//dsh-maps//trip plan//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    icsFold(`X-WR-CALNAME:${icsEscape(a.title || `行程 ${date}`)}`),
    'X-WR-TIMEZONE:Asia/Shanghai',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];

  const body = events.flat().map((l) => icsFold(l));
  const content = head.concat(body, ['END:VCALENDAR']).join('\r\n') + '\r\n';

  const outPath = a.out || path.join(process.cwd(), `trip-${date}.ics`);
  fs.writeFileSync(outPath, content, 'utf8');

  return out({
    ok: true,
    file: outPath,
    event_count: n,
    start: result.start,
    end: result.end,
    incomplete: result.incomplete,
    first: events.length && events[0] ? events[0].find((l) => l.startsWith('SUMMARY:')).slice(8) : null,
    checks: result.checks,
    note: '已写入 iCalendar 文件，导入手机日历即可；出发前 10 分钟、游览前 15 分钟有提醒',
  });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === 'config') {
    if (argv[1] === 'set' && argv[2] === 'AMAP_MAPS_API_KEY' && argv[3]) {
      return out({ ok: true, key: 'AMAP_MAPS_API_KEY', savedTo: saveKey(argv[3].trim()) });
    }
    if (argv[1] === 'get') {
      const k = getKey();
      return out({
        configured: Boolean(k),
        key: k ? k.slice(0, 4) + '...' + k.slice(-4) : '',
        configFile: CONFIG_FILE,
        backend: k ? 'amap' : 'osm',
      });
    }
    return die('usage: config set AMAP_MAPS_API_KEY <key> | config get', 2);
  }

  const a = parseArgs(argv);
  const cmd = a._[0];

  // Key 体检：实际打一次高德地理编码，翻译错误码
  if (cmd === 'doctor') {
    const k = getKey();
    if (!k) return out({ ok: false, backend: 'osm', reason: '未配置 AMAP_MAPS_API_KEY，当前只能驾车（OSM）' });
    try {
      const r = await amapGeocode(k, '天安门', '北京');
      return out({ ok: true, backend: 'amap', key: k.slice(0, 4) + '...' + k.slice(-4), probe: r });
    } catch (e) {
      const { code, hint } = explainAmapError(e);
      return out({ ok: false, backend: 'amap(unusable)', code, hint, configFile: CONFIG_FILE });
    }
  }

  if (a.help || !cmd) {
    process.stdout.write(
      [
        'Usage:',
        '  node maps.cjs geocode "<address>" [--city 上海]',
        '  node maps.cjs route --from "A" --to "B" [--via "P1;P2"] [--mode driving|walking|bicycling|transit] [--city 上海]',
        '  node maps.cjs poi --keywords "咖啡馆" [--city 上海] [--business]',
        '  node maps.cjs detail --id <poiId> | --from "<地点名>"',
        '  node maps.cjs weather --city 上海',
        '  node maps.cjs matrix --hotels "A|B" --pois "X|Y|Z" [--mode transit] [--city 上海]',
        '  node maps.cjs schedule --from "酒店" --pois "X|Y|Z" [--start 09:00] [--stay 90] [--mode transit] [--date 2026-11-25] [--business]',
        '  node maps.cjs ics --from "酒店" --pois "X|Y|Z" --date 2026-11-25 [--out trip.ics] [--file extra.json] [--title "上海三日"]',
        '  node maps.cjs doctor',
        '  node maps.cjs config set AMAP_MAPS_API_KEY <key>',
        '',
        '无 Key、或 Key 平台类型不匹配时自动降级到 OSM（仅驾车）。',
        '',
      ].join('\n')
    );
    return a.help ? 0 : 2;
  }

  const key = a.key || getKey();

  if (cmd === 'geocode') {
    const addr = a.from || a._[1];
    if (!addr) return die('geocode 需要地址参数', 2);
    if (key) {
      try {
        const r = await amapGeocode(key, addr, a.city);
        if (r) return out({ ok: true, provider: 'amap', query: addr, ...r });
      } catch (e) {
        if (!isKeyProblem(e)) throw e;
        const { hint } = explainAmapError(e);
        const r = await osmGeocode(addr);
        if (!r) return die(`未找到地址: ${addr}`, 3);
        return out({ ok: true, provider: 'osm', query: addr, ...r, fallback_reason: hint });
      }
    }
    const r = await osmGeocode(addr);
    if (!r) return die(`未找到地址: ${addr}`, 3);
    return out({ ok: true, provider: 'osm', query: addr, ...r });
  }

  if (cmd === 'route') {
    if (!a.from || !a.to) return die('route 需要 --from 和 --to', 2);
    const mode = a.mode || 'driving';

    // 后端选择：高德优先；Key 有平台/无效问题时自动降级 OSM（并记录原因）
    let backend = key ? 'amap' : 'osm';
    let fallback_reason;
    let fallback_code;

    const geo = async (q, city) => {
      if (backend === 'amap') {
        try {
          const r = await amapGeocode(key, q, city);
          if (r) return r;
        } catch (e) {
          if (!isKeyProblem(e)) throw e;
          const fe = explainAmapError(e);
          fallback_code = fe.code;
          fallback_reason = fe.hint;
          backend = 'osm';
        }
      }
      return osmGeocode(q);
    };

    const from = await geo(a.from, a.city);
    if (!from) return die(`起点未找到: ${a.from}`, 3);
    const to = await geo(a.to, a.city2 || a.city);
    if (!to) return die(`终点未找到: ${a.to}`, 3);

    // 途经点
    const viaNames = (a.via || '').split(';').map((s) => s.trim()).filter(Boolean);
    const viaPts = [];
    for (const name of viaNames) {
      const p = await geo(name, a.city);
      if (!p) return die(`途经点未找到: ${name}`, 3);
      viaPts.push({ ...p, label: name });
      await sleep(400);
    }

    let r;
    if (backend === 'amap') {
      try {
        r = await amapRoute(key, from, to, mode, a.city, a.city2 || a.city, viaPts);
      } catch (e) {
        if (!isKeyProblem(e)) throw e;
        const fe = explainAmapError(e);
        fallback_code = fe.code;
        fallback_reason = fe.hint;
        backend = 'osm';
      }
    }
    if (!r && fallback_reason && mode !== 'driving') {
      return die(
        `高德不可用（${fallback_code}），且 OSM 兜底只支持驾车，无法规划 ${mode} 路线。\n\n${fallback_reason}`,
        4
      );
    }
    if (!r) r = await osmRoute(from, to, mode);
    if (!r) return die('未找到路线', 3);

    // 地理编码跑偏校验：直线距离远超路线距离，或直线距离本身离谱，就提示
    const straight = haversine(from, to);
    const warnings = [];
    if (from.confidence === 'low' || to.confidence === 'low') {
      warnings.push(
        `地理编码置信度低（起点=${from.confidence || 'n/a'}，终点=${to.confidence || 'n/a'}），请核对地点名称`
      );
    }
    if (straight > 500000) {
      warnings.push(
        `起点与终点直线距离 ${fmtDist(Math.round(straight))}，疑似地理编码错误，请核对起终点名称`
      );
    }
    if (r.distance_m > 0 && straight > 0 && r.distance_m > straight * 6) {
      warnings.push('路线距离约为直线距离的 6 倍以上，可能绕行或坐标有误');
    }
    if (fallback_reason) warnings.push('高德不可用，已降级为 OSM 驾车，结果只作参考（详情见 fallback_reason）');

    return out({
      ok: true,
      ...r,
      backend,
      from: { name: from.name, lng: from.lng, lat: from.lat },
      to: { name: to.name, lng: to.lng, lat: to.lat },
      ...(viaPts.length ? { via: viaPts.map((p) => ({ name: p.name })) } : {}),
      straight_m: Math.round(straight),
      distance_text: fmtDist(r.distance_m),
      duration_text: fmtDur(r.duration_s),
      ...(fallback_reason ? { fallback_code, fallback_reason } : {}),
      ...(warnings.length ? { warnings } : {}),
    });
  }

  if (cmd === 'poi') {
    if (!key) return die('POI 搜索需要 AMAP_MAPS_API_KEY（高德）。', 2);
    if (!a.keywords) return die('poi 需要 --keywords', 2);
    try {
      let list = await amapPoi(key, a.keywords, a.city);
      if (a.business) {
        const enriched = [];
        for (const p of list.slice(0, 5)) {
          const d = p.id ? await amapPoiDetail(key, p.id) : null;
          enriched.push({ ...p, ...(d ? { rating: d.rating, opentime: d.opentime, tel: d.tel, keytag: d.keytag } : {}) });
          await sleep(420);
        }
        list = enriched;
      }
      return out({ ok: true, provider: 'amap', keywords: a.keywords, count: list.length, items: list });
    } catch (e) {
      if (!isKeyProblem(e)) throw e;
      const { code, hint } = explainAmapError(e);
      return out({ ok: false, provider: 'amap', code, hint });
    }
  }

  if (cmd === 'detail') {
    if (!key) return die('详情需要 AMAP_MAPS_API_KEY（高德）。', 2);
    let id = a.id;
    if (!id) {
      const q = a.from || a._[1];
      if (!q) return die('detail 需要 --id <poiId> 或 --from "<地点名>"', 2);
      const found = await amapPoi(key, q, a.city);
      if (!found || !found.length) return die(`未搜到 POI: ${q}`, 3);
      id = found[0].id;
    }
    const d = await amapPoiDetail(key, id);
    if (!d) return die('未取到 POI 详情', 3);
    const oh = parseOpenTime(d.opentime);
    return out({ ok: true, provider: 'amap', ...d, open_parsed: oh });
  }

  if (cmd === 'weather') {
    if (!key) return die('天气需要 AMAP_MAPS_API_KEY（高德）。', 2);
    if (!a.city) return die('weather 需要 --city', 2);
    try {
      return out({ ok: true, provider: 'amap', ...(await amapWeather(key, a.city)) });
    } catch (e) {
      if (!isKeyProblem(e)) throw e;
      const { code, hint } = explainAmapError(e);
      return out({ ok: false, provider: 'amap', code, hint });
    }
  }

  /* ---------------- 通勤矩阵：酒店 × 景点 ---------------- */

  if (cmd === 'matrix') {
    const hotels = (a.hotels || '').split('|').map((s) => s.trim()).filter(Boolean);
    const pois = (a.pois || '').split('|').map((s) => s.trim()).filter(Boolean);
    if (!hotels.length || !pois.length) return die('matrix 需要 --hotels "A|B" 和 --pois "X|Y"', 2);
    const mode = a.mode || 'transit';

    const H = [];
    const P = [];
    for (const h of hotels) {
      const g = await resolvePoint(key, h, a.city);
      if (!g) return die(`酒店未找到: ${h}`, 3);
      H.push(g);
      await sleep(250);
    }
    for (const p of pois) {
      const g = await resolvePoint(key, p, a.city);
      if (!g) return die(`景点未找到: ${p}`, 3);
      P.push(g);
      await sleep(250);
    }

    const cells = [];
    for (const h of H) {
      const row = [];
      for (const p of P) {
        try {
          const r = await resolveRoute(key, h, p, mode);
          row.push(
            r
              ? { duration_s: r.duration_s || null, distance_m: r.distance_m || null, text: fmtDur(r.duration_s) }
              : { error: '未找到路线' }
          );
        } catch (e) {
          row.push({ error: e.message });
        }
        await sleep(450);
      }
      cells.push(row);
    }

    const rows = H.map((h, i) => {
      const ok = cells[i].filter((c) => !c.error && c.duration_s);
      const total = ok.reduce((s, c) => s + c.duration_s, 0);
      return {
        hotel: h.label,
        address: h.name,
        stops_ok: ok.length,
        total_duration_s: total,
        total_text: fmtDur(total),
        avg_per_trip_s: ok.length ? Math.round(total / ok.length) : null,
        avg_per_trip_text: ok.length ? fmtDur(Math.round(total / ok.length)) : null,
      };
    });

    const ranked = rows
      .filter((r) => r.stops_ok === P.length)
      .sort((x, y) => x.total_duration_s - y.total_duration_s);

    return out({
      ok: true,
      mode,
      pois: P.map((p) => p.label),
      hotels: rows,
      cells,
      best: ranked.length
        ? { hotel: ranked[0].hotel, total_text: ranked[0].total_text, saving_vs_worst: fmtDur(ranked[ranked.length - 1].total_duration_s - ranked[0].total_duration_s) }
        : null,
      note: '通勤时间为一次性走遍全部景点的合计；排序启发式仅供参考，实际以出发时段路况为准',
    });
  }

  /* ---------------- 时间轴 + 可行性校验 ---------------- */

  if (cmd === 'schedule' || cmd === 'ics') {
    const names = (a.pois || '').split('|').map((s) => s.trim()).filter(Boolean);
    if (!a.from || !names.length) return die('schedule 需要 --from "起点" 和 --pois "A|B|C"', 2);
    const mode = a.mode || 'transit';
    const stay = Number(a.stay || 90);
    const startMin = parseHM(a.start || '09:00');

    const origin = await resolvePoint(key, a.from, a.city);
    if (!origin) return die(`起点未找到: ${a.from}`, 3);
    const pts = [];
    for (const n of names) {
      const g = await resolvePoint(key, n, a.city);
      if (!g) return die(`景点未找到: ${n}`, 3);
      pts.push(g);
      await sleep(250);
    }

    // 排序：从起点出发的最近邻，再用 2-opt 消除交叉
    const seq = (() => {
      const rest = pts.slice();
      const out = [];
      let cur = origin;
      while (rest.length) {
        let bi = 0;
        let bd = Infinity;
        rest.forEach((p, i) => {
          const d = haversine(cur, p);
          if (d < bd) {
            bd = d;
            bi = i;
          }
        });
        cur = rest.splice(bi, 1)[0];
        out.push(cur);
      }
      return twoOpt(out);
    })();

    const checks = [];
    const timeline = [{ kind: 'start', name: origin.label, time: fmtHM(startMin), min: Math.round(startMin) }];
    let t = startMin;
    let prev = origin;
    let incomplete = false;

    for (let i = 0; i < seq.length; i++) {
      const target = seq[i];
      let r = null;
      try {
        r = await resolveRoute(key, prev, target, mode);
      } catch (e) {
        // 短距离无公交方案是常态（相邻景点），自动改按步行计，别让整条时间轴断掉
        const gap = haversine(prev, target);
        if (gap < 2000 && mode !== 'walking') {
          try {
            const w = await resolveRoute(key, prev, target, 'walking');
            if (w) {
              r = { ...w, fell_back_to: 'walking' };
              checks.push(
                `ℹ️ ${prev.label} → ${target.label} 无${mode}方案（直线仅 ${fmtDist(Math.round(gap))}），已改按步行 ${fmtDur(w.duration_s)} 计`
              );
            }
          } catch (_) {
            /* 步行也失败则走下面的失败分支 */
          }
        }
        if (!r) checks.push(`❌ ${prev.label} → ${target.label} 无法规划：${e.message}`);
      }
      if (!r) {
        incomplete = true;
        timeline.push({ kind: 'arrive', name: target.label, time: null, leg: { from: prev.label, error: '无路线' } });
        prev = target;
        continue;
      }

      const straightM = haversine(prev, target);
      if (!r.duration_s) {
        checks.push(`⚠️ ${prev.label} → ${target.label} 接口未返回耗时，时间轴按 0 分钟计，需人工确认`);
      }
      if (mode === 'walking' && r.distance_m > 3000) {
        checks.push(`⚠️ 步行段 ${prev.label}→${target.label} 有 ${fmtDist(r.distance_m)}，建议改打车或公交`);
      }
      if (mode === 'transit' && r.duration_s > 3600) {
        checks.push(`⚠️ 公交段 ${prev.label}→${target.label} 需 ${fmtDur(r.duration_s)}，考虑打车`);
      }
      if (straightM > 400 && r.distance_m > straightM * 3.5) {
        checks.push(
          `⚠️ ${prev.label}→${target.label} 实际 ${fmtDist(r.distance_m)}，直线仅 ${fmtDist(Math.round(straightM))}，绕行明显`
        );
      }

      t += r.duration_s / 60;
      const arrive = t;
      timeline.push({
        kind: 'arrive',
        name: target.label,
        time: fmtHM(arrive),
        min: Math.round(arrive),
        leg: {
          from: prev.label,
          duration_text: fmtDur(r.duration_s),
          distance_text: fmtDist(r.distance_m),
          ...(r.fare ? { fare: r.fare } : {}),
        },
      });

      // 营业时间校验（--business 开启，额外 2 次请求/景点）
      if (a.business) {
        try {
          const found = await amapPoi(key, target.label, a.city);
          if (found && found[0]) {
            const d = await amapPoiDetail(key, found[0].id);
            if (d) {
              const oh = parseOpenTime(d.opentime);
              const wd = a.date ? new Date(`${a.date}T00:00:00`).getDay() : null;
              if (wd !== null && oh.closedWeekdays.includes(wd)) {
                checks.push(`❌ ${target.label} 每逢周${'日一二三四五六'[wd]}闭馆，但排在了这天`);
              }
              if (oh.close) {
                const closeMin = parseHM(oh.close);
                if (arrive > closeMin - 60) {
                  checks.push(
                    `❌ ${target.label} 预计 ${fmtHM(arrive)} 到，${oh.close} 闭馆，剩余游览时间不足 1 小时`
                  );
                }
              }
              timeline[timeline.length - 1].opentime = d.opentime || null;
            }
          }
        } catch (_) {
          /* 营业时间查不到不影响主流程 */
        }
        await sleep(450);
      }

      t = arrive + stay;
      timeline.push({ kind: 'depart', name: target.label, time: fmtHM(t), min: Math.round(t), stay_min: stay });
      prev = target;
      await sleep(450);
    }

    const totalMin = t - startMin;
    if (t > 21 * 60) checks.push(`⚠️ 预计 ${fmtHM(t)} 才结束，超过 21:00，考虑删减一个点`);
    if (totalMin > 12 * 60) checks.push(`⚠️ 全天跨度 ${fmtDur(totalMin * 60)}，超过 12 小时，体力压力大`);

    const result = {
      ok: true,
      mode,
      date: a.date || null,
      incomplete,
      start: fmtHM(startMin),
      end: fmtHM(t),
      total_minutes: Math.round(totalMin),
      total_text: fmtDur(totalMin * 60),
      order: seq.map((p) => p.label),
      timeline,
      checks,
      note: '顺序由直线距离启发式排定（最近邻 + 2-opt），各段耗时与距离为高德实测',
    };

    if (cmd === 'schedule') return out(result);
    return writeIcs(result, a);
  }

  return die(`未知命令: ${cmd}`, 2);
}

main()
  .then((c) => process.exit(typeof c === 'number' ? c : 0))
  .catch((e) => die('error: ' + (e && e.message ? e.message : String(e)), 1));