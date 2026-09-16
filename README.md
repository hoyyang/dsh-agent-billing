# dsh-agent-billing

![banner](assets/banner.svg)

**Agent 计费与用量可观测插件** — 多账号计费档案 + 玻璃拟态双层 UI（实时徽标 + 详细面板）+ 中转站余额实查 + 预算告警。

**Agent billing & usage observability for DeepSeek Harness** — multi-account billing profiles, glassmorphism dual-layer UI (live badge + full dashboard), relay-station balance queries, and budget alerts.

![version](https://img.shields.io/badge/version-0.2.3-blue) ![platform](https://img.shields.io/badge/platform-dsh%20web-lightgrey) ![license](https://img.shields.io/badge/license-BSD--3--Clause-green)

## 功能 / Features

- **实时记账**：会话日志直扫通道（zstd 解压 → 逐事件按自带时间戳入账，水位 + lastSeq 双防双计），按 `provider + model` 双归属落账（Node 内建 SQLite），零额外模型请求
- **Per-window「本会话」**：徽标经 React fiber 读取所在窗口的会话唯一 id（标题重复/改名免疫），`?session=` 精确账单——多窗口各自显示自己的成本，切会话实时更新
- **多账号计费档案**：每个 provider 路由（公司 API / 中转站 / Kiro / 官方）独立一套四档费率（输入 / 输出 / 缓存读 / 缓存写，每 Mtok）+ 币种 + 折扣 + 按模型覆盖（mini-glob）
- **双层 UI**：
  - **实时徽标**（侧栏底部）：本会话/今日花费实时跳动 + 预算状态色点，点击开面板
  - **详细面板**（全屏玻璃拟态）：概览（四统计卡 + 14 天趋势 sparkline + 预算条）/ 明细（按账号·按模型）/ 会话 / 设置 四页签，今日·本月·累计三窗口
- **余额实查**：DeepSeek 官方（`/user/balance`）与 New API 兼容中转站（`/v1/dashboard/billing/*`）两种适配器，按档案配置
- **预算告警**：日/月预算，80% 预警（黄）、超限（红）反映在徽标色点与预算条
- **展示可定制**：档案、费率、预算、刷新频率全部设置页驱动（存 `settings.json`），无需改代码
- **模型计费规则库**：内置 Catalog 全量 332 模型官方计费（每日 2 次自动刷新）；按模型手动配置；**智能配置**（Agent 模型解析网页/描述/截图自动生成规则）
- **币种体系**：CNY / USD / credit（Kiro 类积分，估算系数，全链路积分显示不折人民币）
- **导入导出**：一键导出全量 JSON（档案 + 规则 + 账本）；导入合并 / 替换

## 安装 / Install

```sh
# 本机开发（super-injector 快路径）
dev_build_plugin { dir: "<本插件目录>" }   # host tsc + client tsdown
dev_inject_plugin { dir: "<本插件目录>" }  # 免重启热注入

# 打包安装（bundle 形态）
dsh plugin add <tgz 或仓库地址>
```

要求 / Requirements：DSH web 实例（host 需含 `webServer` 服务）；Node ≥ 22（内建 `node:sqlite`）。

## 快速开始 / Quick start

1. 点击侧栏底部徽标打开面板 → **设置** 页签
2. **＋ 新建档案**：填名称、Provider 匹配（如 `kiro*`、`zhipuai`、`relay-*`）、币种、四档费率（每 1M token）→ **保存档案**
3. 费用立即按 `Σ(tokens × 费率) × 折扣` 重算历史与实时；未匹配档案的用量按 0 计费并在「(未匹配)」行提示
4. 可选：档案内配置**余额查询**（适配器 + Base URL + API Key）→ **查询余额** 按钮
5. 可选：设置日/月预算 → 徽标色点与预算条进入预警/超限状态

## 费率档案 Schema / Profile schema

```jsonc
{
  "id": "zhipuai-direct",            // 稳定唯一 id
  "label": "智谱直连",                // 展示名
  "providerMatch": "zhipuai",        // 精确 / * / 前缀* / *后缀 / *含*（大小写不敏感）
  "currency": "CNY",
  "discount": 0.9,                   // 可选，1 = 原价
  "rates": { "input": 2, "output": 8, "cacheRead": 0.5, "cacheWrite": 2 },  // 每 1M token
  "byModel": { "glm-4.7*": { "input": 2, "output": 6, "cacheRead": 0.2, "cacheWrite": 2 } },
  "balance": {                        // 可选
    "adapter": "deepseek",            // 'deepseek' | 'openai-billing'
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "sk-..."                // 仅存本地 settings
  }
}
```

## 数据与存储 / Data & storage

| 文件 | 内容 |
|---|---|
| `DSH_HOME/dsh-agent-billing/ledger.sqlite` | 用量样本（ts/session/provider/model/四档 tokens）+ 水位表（防重放/重启双计） |
| `DSH_HOME/dsh-agent-billing/profiles.json` | 费率档案（原子写） |
| `DSH_HOME/dsh-agent-billing/settings.json` | 预算、刷新频率、汇率、智能配置 |
| `DSH_HOME/dsh-agent-billing/model-rules.json` | 模型计费规则（手动 + 智能生成） |
| `DSH_HOME/dsh-agent-billing/smart-log.jsonl` | 智能配置运行日志 |

**卸载不删数据**：卸载插件后上述文件保留，重装即恢复历史账本。彻底清除请手动删除 `DSH_HOME/dsh-agent-billing/` 目录。

## 安全 / Security

- 本地优先：除余额查询外**零网络外发**；账本/档案全部本地
- HTTP 路由仅服务 loopback 对端 + 变更请求同源校验（先例：dsh-session-manager）
- 余额 API Key 仅存本地文件、仅在按下「查询余额」时向你配置的 Base URL 发起请求
- 不碰 DSH 凭据库、不注册任何 Agent 工具（上下文经济：零 tools schema 负担）

## 卸载 / Uninstall

```sh
# super-injector 快路径
dev_uninject_plugin { match: "dsh-agent-billing" }

# bundle 安装
dsh plugin remove dsh-agent-billing
```

从 profile 的 `cordis.patch.yml` 移除 `dsh-agent-billing-patch` 条目并删除对应 junction 后重启 dsh web 即净；账本数据 `~/.dsh/dsh-agent-billing/` 保留，可手动删除。

卸载即净：loader entry / junction / 注入清单 / client 模块全部移除，profile patch 写入 disabled 阻断条目防自装配加回。

## 已知边界 / Known limits

- 预算为各档案花费**数值直加**：混合币种场景请统一档案币种口径（UI 有提示）
- 装插件之前的历史用量不可回补（水位从安装时刻起算）；重装不丢（水位持久化）
- usage chunk 早样本无 provider 归属，沿用该会话最近一次已知的 provider/model
- 中转站余额依赖其 OpenAI billing 兼容接口；不兼容的站点会得到点名失败的 502
- Kiro credit 为任务级封装，插件按估算系数（credit/1M token，用户可配）显示『积分（估算）』，非精确账单
- 非 token 计量维度（搜索按次/机器时/音频时长/生图张数）DSH usage 不上报，规则中仅存展示单价不参与合计

## License

BSD-3-Clause
