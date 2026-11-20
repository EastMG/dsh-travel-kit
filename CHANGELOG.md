# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added

- `CHANGELOG.md`
- GitHub Actions CI：ubuntu × Node 18/20/22 + windows × Node 22
- `scripts/test.js` 离线自测（22 项）：语法、CLI 行为、无 Key 降级、安装幂等、凭证泄露防护
- `scripts/check-pack.js` 打包内容校验：必需文件都在、测试脚本不外泄
- README 增加 CI 与 npm 版本徽章

## [1.0.1] - 2026-11-20

合规与免责修正，不改变功能。

### Added

- README 顶部免责声明：非官方项目、与高德/携程/飞猪及其关联公司无关联、不代发凭证、合规责任自负
- `wendao` 顶部使用警告：接口无公开文档、可能随时失效、不保证符合携程服务条款
- `package.json` 增加 `dshTravel.experimentalModules` 字段，供工具读取实验性模块清单
- `dsh-travel install` 输出对实验性模块打 `[实验性]` 标签并给出一句风险提示

### Fixed

- OSM 公共服务合规：Nominatim / OSRM 请求加 1.1 秒串行节流，`User-Agent` 改为带包名与仓库地址
  （此前触发重试时会连发两个 Nominatim 请求，超出其「不超过 1 请求/秒」的政策）

### Changed

- `skills/wendao` 的 `display_name` 与标题标注为实验性

## [1.0.0] - 2026-11-20

首次发布。

### Added

- **`maps`** —— 基于高德 Web 服务 API 的路线规划
  - 地理编码、驾车 / 步行 / 骑行 / 公交地铁路径、POI 搜索、行政天气
  - `route --via` 途经点（仅驾车，最多 16 个）
  - `poi --business` / `detail` 返回营业时间与闭馆日，`open_parsed` 结构化为 `closedWeekdays` / `open` / `close`
  - `matrix` 通勤矩阵：多家酒店 × 多个景点的耗时矩阵，给出最优酒店与差值
  - `schedule` 时间轴：最近邻 + 2-opt 排序，逐段使用高德实测耗时，附 6 项可行性校验
    （闭馆日、到达时距闭馆不足 1 小时、步行段超 3 km、公交段超 1 小时、绕行超直线 3.5 倍、结束晚于 21:00 或全天超 12 小时）
  - `ics` iCalendar 导出：按 RFC 5545 折叠长行、转义特殊字符、内置 `VTIMEZONE`，交通段与游览段分两条事件
  - `doctor` Key 自检，把高德错误码翻译成可操作的中文提示
- **`wendao`** —— 携程问道接入，单次问答式自然语言旅行查询
- **`bin/dsh-travel`** —— 统一入口：`maps` / `wendao` / `install` / `doctor` / `where`
- 零依赖，仅使用 Node 内置模块

### Notes

- 无高德 Key 时自动降级到 OSM（Nominatim + OSRM），仅支持驾车，结果带 `confidence` 与 `warnings`
- 不具备下单与支付能力：飞猪、携程、高德对个人 Agent 均未开放
- `.ics` 仅通过 RFC 5545 结构校验（CRLF、75 字节行宽、VEVENT 配平），未在真机 iOS / Android 日历导入验证

[Unreleased]: https://github.com/EastMG/dsh-travel-kit/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/EastMG/dsh-travel-kit/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/EastMG/dsh-travel-kit/releases/tag/v1.0.0