---
name: maps
display_name: "地图路线规划 — 高德 / OSM 双后端"
description: 规划交通路线：地理编码、驾车/步行/骑行/公交路径、POI 搜索、天气。配高德 Key 时走高德 Web 服务 API（国内准确、支持公交地铁换乘）；没有 Key 时自动降级到 OSM（Nominatim + OSRM），只能算驾车。用户问怎么走、多远、多久、附近有什么、某天天气时使用。触发词：路线、怎么去、多远、多久、导航、换乘、地铁公交、附近、周边、地图、高德、百度地图、天气。
metadata:
  version: 1.1.0
  agent:
    type: tool
    runtime: node
    context_isolation: execution
    parent_context_access: read-only
---

# 地图路线规划

## 调用

```powershell
dsh-travel maps <命令> [参数]
```

| 命令 | 说明 | 需要 Key |
|---|---|---|
| `geocode "地址"` | 地址 → 经纬度 | 否（OSM 可用） |
| `route --from A --to B --mode driving` | 驾车路线 | 否 |
| `route ... --via "P1;P2"` | 途经点（仅驾车，最多 16 个） | **是** |
| `route ... --mode walking` | 步行路线 | **是** |
| `route ... --mode bicycling` | 骑行路线 | **是** |
| `route ... --mode transit --city 上海` | 公交/地铁换乘 | **是** |
| `poi --keywords "咖啡馆" --city 上海` | 周边 POI | **是** |
| `poi ... --business` | POI + 营业时间/评分（前 5 条） | **是** |
| `detail --from "故宫博物院"` / `--id <poiId>` | 单点详情，含 `open_parsed`（闭馆日/时段） | **是** |
| `weather --city 上海` | 天气预报 | **是** |
| `matrix --hotels "A\|B" --pois "X\|Y"` | 通勤矩阵：每家酒店到每个景点的耗时 | **是** |
| `schedule --from "酒店" --pois "X\|Y\|Z"` | 时间轴 + 可行性校验 | **是** |
| `ics --from "酒店" --pois "X\|Y\|Z" --date 2026-11-25` | 生成 .ics 日历文件 | **是** |
| `config set AMAP_MAPS_API_KEY <key>` | 配 Key | — |
| `config get` | 看当前后端 | — |
| `doctor` | 实测 Key 是否可用，翻译错误码 | — |

输出统一单行 JSON。

## 编排层（matrix / schedule）

这两个命令把「查」变成「排」，是路书的核心。

**matrix**：算每家酒店到每个景点的耗时，输出 `cells` 矩阵 + 每家酒店走遍全部景点的 `total_duration_s`，并标出 `best`（最优酒店）和 `saving_vs_worst`。用来回答「住哪家每天少折腾」。

**schedule**：给起点 + 景点列表，输出完整时间轴：

- 顺序用**直线距离启发式**（最近邻 + 2-opt）排定，段与段之间**距离和耗时是高德实测**
- 每个景点可配 `--stay` 停留分钟数，`--start` 出发时刻
- `--business` 会额外查营业时间，做**闭馆日校验**（如故宫周一闭馆）
- `--date` 传日期，用于判断星期几

返回里 `checks` 是可行性告警，`incomplete: true` 表示有段没排通。

### 自动兜底

短距离（<2 km）无公交方案时，会自动改按步行计算，并在 `checks` 里注明「已改按步行 N 分钟计」，不会让整条时间轴断掉。

## .ics 日历导出（ics）

跑一遍 `schedule` 的编排，把结果写成标准 iCalendar 文件：

```powershell
dsh-travel maps ics --city 上海 --date 2026-11-25 --start 09:00 --stay 90 `
  --from "上海外滩333酒店" --pois "豫园|南京东路|上海博物馆" `
  --out trip.ics --title "上海一日"
```

每个景点生成两条事件：`前往 X`（交通段，提前 10 分钟提醒）+ `游览 X`（停留段，提前 15 分钟提醒）。`LOCATION` 填地址，`DESCRIPTION` 带耗时/距离/票价/营业时间。

**补充车次、酒店**：`--file extra.json`，格式：

```json
[
  {"title":"G35 北京南→上海虹桥","start":"2026-11-25T19:24","end":"2026-11-25T23:51",
   "location":"北京南站","description":"二等座 598 元，余 21 张"},
  {"title":"入住 上海外滩333酒店","start":"2026-11-25T15:00","end":"2026-11-25T23:00",
   "location":"南苏州路333号","description":"424 元/晚"}
]
```

**实现要点**（改代码时别踩）：

- 已内置 `VTIMEZONE`（Asia/Shanghai，+0800 无 DST），剪贴板里粘出来也能被日历识别
- 按 RFC 5545 **按字节**折叠长行（中文 3 字节，按字符数折会超 75 字节上限）
- 文本转义：`\` `;` `,` 换行都处理了，否则带逗号的营业时间会截断

**未验证**：没有在真实手机日历（iOS/Android）里导入测试过，只做了 RFC 结构校验（CRLF、75 字节上限、VEVENT 配平）。导入出问题先查客户端的时区支持。

## Key 平台类型（最常见的坑）

高德的 Key 分 **JS API / Web服务 / iOS / Android** 四类，**互不通用，且创建后不能改类型**。

本工具只吃「**Web服务**」类型的 Key。用错了会报：

```json
{"ok": false, "code": "USERKEY_PLAT_NOMATCH", "hint": "..."}
```

看到 10009 只有一条路：去控制台**新建**一个 Key，服务平台选「Web服务」。在控制台「Key 管理」列表里，平台类型那一列必须显示「Web服务」。

## 自动降级

Key 缺失 / 类型不对 / 失效时，脚本**不会整体失败**：

- 地理编码、驾车 → 自动降级 OSM，结果里带 `backend: "osm"` + `fallback_code` + `fallback_reason`
- 步行 / 骑行 / 公交 / POI / 天气 → 无 OSM 等价能力，直接报错并附上修复指引

## 高德 Key（强烈建议配）

1. 打开 https://console.amap.com/dev/key/app
2. 创建应用 → 添加 Key → **服务平台必须选「Web服务」**（不是 Web端/Android/iOS，选错会报 `INVALID_USER_SCODE`）
3. `dsh-travel maps config set AMAP_MAPS_API_KEY <key>`

Key 存 `~/.dsh-maps/config.json`，也可用环境变量 `AMAP_MAPS_API_KEY` 覆盖。个人开发者有免费日额度，够日常用。

## 没有 Key 时的边界（必须向用户交代）

OSM 兜底只有 **驾车**，且有两个真实缺陷：

1. **中文 POI 地理编码不可靠**。实测「上海豫园」被匹配到「上海体育大学」，未加 `countrycodes=cn` 时甚至命中纽约法拉盛的同名餐馆。脚本已加境内偏置 + 词尾校验 + 二次重试，但仍有误判可能。
2. **路线绕行明显**。外滩→豫园直线 713 m，OSRM 给 4.7 km（因为外滩点位在步行区内）。

因此每次路线结果都带 `confidence` 和 `warnings` 字段。**看到 `confidence: low` 或 `warnings` 必须转告用户，不能把数字当准数报出去。**

## 国内行程要用高德的原因

公交/地铁换乘是最高德独有的能力，OSM 给不了。做「几点从酒店出发、坐几号线、在哪换乘」这种行程，没有高德 Key 只能靠携程问道的文字建议，不能算准。

## 已知接口差异（全部实测确认）

- **公交规划只认 adcode**。`city1` / `city2` 传城市名会报 `INVALID_PARAMS (20000)`，必须传 adcode（如上海 `310000`）。脚本已自动从地理编码结果里取 adcode，不用管。
- **骑行接口不返回耗时**。v5 bicycling 的 `cost.duration` 是空的，脚本显示「未知（接口未返回耗时）」，只给距离。
- **免费额度有 QPS 限制**。连续调用会报 `CUQPS_HAS_EXCEEDED_THE_LIMIT (10021)`，脚本已做 4 次指数退避重试。批量排路线时仍建议每次调用间隔 1 秒以上。
- 单位：`distance` 米，`cost.duration` 秒，公交 `cost.transit_fee` 是票价（元）不是换乘次数。
- **模糊景点名会偏**。实测「上海外滩」被定位到虹口区天潼路（北外滩），不是外滩核心区。地址写具体一点（「外滩·南京东路」「中山东一路」）结果更准。
- **营业时间用 v5 才有**。`/v3/place/detail` 的 `business` 返回 null，必须 `/v5/place/detail` + `show_fields=business`。且不是每个 POI 都有数据。
- **闭馆日措辞不统一**。「关闭 / 不开放 / 闭馆」三种写法都有，`open_parsed` 已全部覆盖；但「周二不开放」和「周二至周日 开放」只差一个字，正则靠逗号分隔避免误判。

## 已验证输出样例

```
北京南站 → 天安门   驾车 7.9 km / 23 分钟    步行 7.3 km / 98 分钟
上海外滩 → 豫园     公交 3.4 km / 36 分钟    地铁10号线 天潼路→豫园 票价 ¥3
                    步行 2.8 km / 37 分钟

通勤矩阵（上海，公交）：
  外滩333酒店  豫园 21分 | 南京东路 26分 | 上博 38分   合计 1h25  ← 最优
  滨江欣景     豫园 26分 | 南京东路 37分 | 上博 38分   合计 1h41

时间轴（北京，11-25 周三）：
  09:00 出发 → 09:49 故宫(49分/3.2km) → 12:23 景山(35分/1.8km)
  → 14:35 北海(步行12分/874m) → 16:35 结束，共 7h35
```