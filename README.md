# dsh-travel-kit

给 AI Agent 用的旅行工具链。把「查票 → 选酒店 → 排路线 → 导日历」串成一条可执行的链路。

零依赖，只用 Node 内置模块。技能用 `SKILL.md` 格式，DSH / Claude Code / OpenClaw 等读同一套。

> ## 免责声明
>
> - 本项目是**个人开源项目，与高德、携程、飞猪及其关联公司没有任何关系**，未获授权、未获背书。
> - 本项目**不包含也不分发**上述公司的任何代码、SDK、数据或文档。它只是一个调用公开 HTTP 接口的客户端。
> - **API Key 由使用者自行申请和保管**。本项目不代管凭证，包内不含任何 Key。
> - 使用各家 API 须遵守各自的《服务条款》与配额政策，**使用者自行承担合规责任**。
> - 商标（高德、携程、飞猪等）仅用于说明互操作对象，属于指名性使用。
>
> **`wendao` 模块标记为实验性**：它调用的接口没有公开文档，是通过第三方客户端反推的，可能随时失效，也可能不符合携程服务条款。详见 [skills/wendao/SKILL.md](skills/wendao/SKILL.md) 顶部警告。

## 能力

| 模块 | 提供方 | 能做什么 |
|---|---|---|
| `maps` | 高德 Web 服务 API | 地理编码、驾车/步行/骑行/公交地铁、POI 搜索、营业时间、天气 |
| | | **通勤矩阵**：多家酒店 × 多个景点，算出住哪家每天少折腾 |
| | | **时间轴编排**：多点排序 + 每段耗时 + 6 项可行性校验 |
| | | **iCalendar 导出**：直接进手机日历 |
| `wendao` ⚠️ 实验性 | 携程问道 | 一句话问行程、攻略、多方案对比（中文语境强） |
| （外部） | 飞猪 flyai | 机票/酒店/门票结构化查询，需另装 `@fly-ai/flyai-cli` |

## 快速开始

```bash
# 全局安装
npm i -g dsh-travel-kit

# 或者不安装，直接用
npx dsh-travel-kit maps doctor
```

把技能装进你的 agent：

```bash
dsh-travel install                      # 默认 ~/.dsh/skills
dsh-travel install --dir ~/.claude/skills
dsh-travel install --force              # 覆盖已存在的同名技能
```

## 配 Key

**高德（必需，否则只能算驾车）**

1. 打开 <https://console.amap.com/dev/key/app>
2. 创建应用 → 添加 Key → **服务平台选「Web服务」**
3. ```bash
   dsh-travel maps config set AMAP_MAPS_API_KEY <key>
   ```

> 平台选错会报 `USERKEY_PLAT_NOMATCH`，而且 Key 的类型创建后改不了，只能新建。用 `dsh-travel maps doctor` 可自检。

**携程问道（可选，不配也能用，但会限流）**

1. 打开 <https://www.ctrip.com/wendao/openclaw>，用个人携程账号申请 API Token
2. ```bash
   dsh-travel wendao config set WENDAO_API_KEY <token>
   ```

## 用法

```bash
# 路线
dsh-travel maps route --from "北京南站" --to "天安门" --mode driving
dsh-travel maps route --from "外滩" --to "南京东路" --via "豫园" --mode driving

# 营业时间 / 闭馆日
dsh-travel maps detail --from "故宫博物院" --city 北京

# 通勤矩阵：三家酒店到三个景点
dsh-travel maps matrix --city 上海 --mode transit \
  --hotels "外滩333酒店|尚运铂金酒店|滨江欣景大酒店" \
  --pois "豫园|南京东路步行街|上海博物馆"

# 一天的时间轴
dsh-travel maps schedule --city 北京 --date 2026-11-25 --start 09:00 --stay 120 \
  --business --from "天安门东地铁站" --pois "故宫博物院|景山公园|北海公园"

# 导出日历
dsh-travel maps ics --city 上海 --date 2026-11-25 --start 09:00 \
  --from "上海外滩333酒店" --pois "豫园|南京东路" --out trip.ics

# 携程问道
dsh-travel wendao --query "五一从广州去张家界玩4天，整理往返交通、住宿和门票"
```

所有命令输出单行 JSON（`wendao` 输出 markdown），方便管道处理。

## 设计上的几个取舍

**为什么通勤矩阵用「一次性走遍全部景点」而不是「每天」**
因为住宿天数还没定，先给出总量，除以天数即可。返回里同时给了 `total_duration_s` 和 `avg_per_trip_s`。

**为什么时间轴的顺序是启发式的**
排序用直线距离（最近邻 + 2-opt），因为真实算路是 O(n²) 次 API 调用，排 6 个点要 36 次，撞 QPS 且慢。**排序之后每一段的距离和耗时都是高德实测**，只有先后顺序是近似。这个在返回的 `note` 里写明了。

**短距离无公交方案会自动改步行**
相邻景点（<2 km）高德经常返回空方案。此时自动改按步行计算并在 `checks` 里注明，避免整条时间轴断掉。

## 安全

- 包内**不含任何凭证**。Key 只在运行时从以下位置读：
  - 高德：环境变量 `AMAP_MAPS_API_KEY` > `~/.dsh-maps/config.json`
  - 携程：环境变量 `WENDAO_API_KEY` > `~/.wendao/config.json`
- 两个 config.json 都是**明文**，这是工具自己的行为。共享机器上自己注意权限。
- `install` 只复制 `SKILL.md` 和 `scripts/`，不会碰凭证文件。
- OSM 兜底遵守公共服务政策：Nominatim 限 **1 请求/秒**且要求可识别 UA，OSRM 公共 demo 仅限轻量测试。脚本已做 1.1 秒串行节流。**不要拿它跑批量任务**，生产场景请配高德 Key。

## 已知边界

- **不能下单、不能支付**。飞猪/携程/高德对个人 Agent 只开放查询，这是个死线，不是没做。
- **无 Key 时降级到 OSM**，只能算驾车，且中文 POI 地理编码不可靠（脚本已加境内偏置 + 词尾校验 + 置信度标注）。
- **营业时间不是每个 POI 都有**（高德 v5 才有该字段）。
- **`.ics` 只做过 RFC 5545 结构校验**，没在真机 iOS/Android 日历里导入验证过。

## 目录结构

```
bin/dsh-travel.js          统一入口，转发到各技能脚本
skills/maps/SKILL.md       技能说明（agent 读这个决定何时调用）
skills/maps/scripts/       实现
skills/wendao/
scripts/install.js         复制技能到 agent 目录
```

## License

MIT