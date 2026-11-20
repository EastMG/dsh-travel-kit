---
name: wendao
display_name: "携程问道 — 携程 AI 旅行助手（实验性）"
description: 通过携程问道接口回答旅行问题：酒店/机票/火车票/门票/景点/签证/多日行程规划。当用户问中国国内旅行、订酒店机票火车票、排行程、问攻略时使用；需要中文语境下的行程编排和多家酒店比价时优先用本技能。触发词：携程、问道、订酒店、查机票、火车票、行程规划、景点门票、攻略、签证。
homepage: https://www.ctrip.com/wendao/openclaw
metadata:
  version: 1.0.1
  stability: experimental
  agent:
    type: tool
    runtime: node
    context_isolation: execution
    parent_context_access: read-only
---

# 携程问道（实验性）

> ## ⚠️ 使用前必读
>
> 本模块调用的 `wendao-skill-prod.ctrip.com/skill/query` 接口**没有公开的 API 文档**，是通过第三方客户端反推得到的。携程官方对外提供的形态是「OpenClaw 连接器」。
>
> 因此：
> - **不保证长期可用**，携程随时可能改接口或封禁
> - **不保证符合携程的服务条款**，是否使用请自行判断
> - **本项目与携程无关联**，未获授权、未获背书
> - 出问题不要找携程客服，他们不知道这个用法
>
> 如果你需要稳定可用的携程能力，请走官方连接器或官方开放平台。

携程「问道」AI 旅行助手的接入层。**单次问答式**：你发一段完整的自然语言旅行问题，它返回一份 markdown 行程/清单。

## 调用方式

```bash
dsh-travel wendao --query "<完整问题>"
```

在 Windows 上的实际路径：

```powershell
dsh-travel wendao --query "11月25日北京到上海高铁，二等座"
```

## Token

- 优先级：环境变量 `WENDAO_API_KEY` > `~/.wendao/config.json`
- 配置：`dsh-travel wendao config set WENDAO_API_KEY <token>`
- 查询状态：`dsh-travel wendao config get`（只显示前后各 4 位）
- 匿名也能调，但会被限流。Token 申请页：https://www.ctrip.com/wendao/openclaw

## 提问要写全

问道只收一段话，信息越全一次命中越高。**必给**：出发地、目的地、日期、人数、预算、偏好。

好例子：
- `2026年11月25日 北京到上海 高铁 二等座 上午出发`
- `10月3日到5日，上海外滩附近，每晚800元以内，两个人住，按位置和价格比较`
- `五一从广州去张家界玩4天，整理往返交通、住宿区域、景点门票和每天的顺序`

坏例子：`查一下机票`（它还得反问日期、人数、时段）

## 输出处理

- 接口返回 `Content-Type: text/markdown`，正文就是 markdown，**直接呈现给用户**，不要二次转述成 JSON。
- 它是"问答"不是"结构化搜索"：没有稳定的字段，别试图从里面正则提价格做机器比价——要结构化数据用 `flyai` 技能。

## 能力边界（必须向用户交代）

1. **只有查询，没有下单和支付**。接口只有 `ask` 一个动作，没有订单读写、没有账号操作。用户要真正订，得自己点进携程 App/网页。
2. **没有稳定性保证**：返回是模型生成的文字，车次价格可能与你点进去看到的实时页面有出入，**下单前必须以携程页面为准**。
3. Beta 阶段，Token 有有效期，过期要重新申请。

## 什么时候用问道、什么时候用 flyai

| 场景 | 用哪个 |
|---|---|
| 需要精确车次/房价数字，做表格比价 | `flyai`（返回结构化 JSON） |
| 需要一段成型的行程叙事、多方案权衡、当地玩法建议 | `wendao`（返回 markdown） |
| 要交叉验证价格 | 两个都问，数字以携程/飞猪实际页面为准 |