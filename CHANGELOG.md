# Changelog

## 0.2.0 (2026-09-03)

### 新功能

- **模型计费规则库（per-model）**：配置粒度从 provider 档案升级为模型级规则；官方内置库覆盖 Catalog 模型网关全量 332 个模型（17 provider），开箱即得，发给同事也无需重复配置
- **计费引擎 v2**：七维费率（input / cacheRead / cacheWrite5m / cacheWrite1h / output / reasoning 展示）+ **时段错峰分档**（DeepSeek 闲忙时精确计价，按样本时间自动选档）+ 免费模型标识；上下文区间分档 v1 展示不精确计量
- **币种体系**：每模型独立币种 CNY / USD / **credit**；credit（如 Kiro，任务级封装）显示"积分（估算）"，全链路（徽标/面板/预算）不折人民币；估算系数（credit/1M token）用户可配
- **智能配置**：默认关闭；开启后选择 Agent 模型（DSH 已配置模型中选，标注读图能力），三种规则源——网页源（可开「每日自动更新」）/ 文字描述 / 截图上传（多张，Agent 模型支持读图才可用）；Agent 抓取解析 → 结构化规则 → 校验落库；「立即执行」+ 每日 03:00 后定时执行 + 运行日志
- **官方计费自动刷新**：Catalog 数据源每 12h 自动刷新（≥2 次/天）+ 设置页手动「立即刷新」，变更计数反馈
- **设置页重构**：四子页签——模型计费（搜索 + 本机在用 + Catalog 全量目录 + 三种配置方式）/ 账号档案（余额实查/折扣）/ 预算·汇率 / 导入导出
- **状态接口扩展**：`byCurrency` 分币种合计、`byRule` 按规则维度、`recentSession`、`costCredit` 全链路

### 变更

- 徽标双段金额升级：今日（人民币口径，credit 不计入）+ 本会话（credit 模型显示 ⊙ 积分）
- 切换会话徽标零闪烁（挂载后同步渲染，修复 isConnected 时序导致的节点脱管）
- 轮询默认 3s → 1s（host 聚合缓存 800ms 支撑，账本变更即时置脏）
- 预算口径升级为人民币（USD 按 fx 折算；credit 不参与预算）
- 样式表自愈：head 被外部清理后 3s 内自动重注入；overlay 显隐改 inline style，杜绝"幽灵面板"
- `model-rules.json` / `smart-log.jsonl` 新增持久化文件（stateDir 内，卸载保留）

### 兼容

- v0.1.0 的 profiles.json / ledger.sqlite / settings.json 全部兼容，升级无迁移动作
- 投影 stateVersion 未变（账本 schema 不动）；新增字段均为增量
