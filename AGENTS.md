# AGENTS.md

This file provides project-level guidance to AI coding agents (DSH / Claude Code) when working with code in this repository.

## 项目概况

Genshin-Plugin — TRSS-Yunzai v3 框架级插件，覆盖原神 / 星铁 / 绝区零的米游社数据查询、抽卡记录、Cookie 管理、兑换码。ESM（`"type": "module"`）。

- **独立仓库** — 提取自 [Miao-Yunzai](https://github.com/yoimiya-kokomi/Miao-Yunzai) 的 `plugins/genshin`，现为独立 git 仓库（`AxiuCN/Genshin-Plugin`，分支 `master`）。与官方**提交历史无共同祖先**，不做 merge / subtree 同步，详见 [`docs/上游同步.md`](docs/上游同步.md)
- **单入口** — `index.js` 用 `Promise.allSettled` 载入 `apps/*.js`，导出 `{ apps }`；单个 app 失败不影响其他模块
- **分层** — `apps/`（命令与事件）→ `model/`（米游社 API、数据库、数据组装）→ `resources/`（HTML 模板与图片）；细节见 [`docs/架构.md`](docs/架构.md)
- **硬依赖** — `miao-plugin`（`#miao` / `#miao.models` 导入别名、puppeteer 渲染）、Redis（CK 分配池与 API 缓存）、Sequelize/SQLite（用户库）
- **CK 自动刷新** — 米游社返回 `retcode=10001` + login 时，用已绑定 stoken 换新 cookie 后重试原请求，见 [`docs/CK自动刷新.md`](docs/CK自动刷新.md)
- **无回归套件** — 本仓库没有 `test/`；改动靠真实 bot 验证，打点日志验证后**必须还原**
- **Bot 侧命令** — `cd app && node .`（前台）/ `node . dev`（开发模式）/ `node . stop`

新会话开工顺序：`git log --oneline -5` → 读「快速参考」→ 改代码前读「硬约束速查」→ 按需打开 [`docs/`](docs/) 对应册。

### 快速参考

| 功能 | 入口（优先级） | 触发 | 说明 |
|------|---------------|------|------|
| 七圣召唤 | `apps/sevenSaints.js`（0） | `#七圣查询卡组` / `#七圣查询角色牌` | 卡组与行动牌查询 |
| 米游社攻略 | `apps/strategy.js`（50） | `#刻晴攻略` / `#攻略说明` / `#设置默认攻略` | 攻略图，含默认来源设置 |
| 十连 | `apps/gacha.js`（100） | `#十连` / `#十连武器` / `#定轨` | 模拟抽卡，每日一次（4 点刷新） |
| 角色查询 | `apps/role.js`（200） | `#角色` / `#刻晴`（`accept()`） / `#深渊` / `#武器` / `#探索` | 面板、深渊、宝箱成就、剧诗 |
| 充值记录 | `apps/payLog.js`（299） | `#充值记录` / `#消费统计` / `#充值帮助` | 米游社充值/消费账单 |
| 体力查询 | `apps/dailyNote.js`（300） | `#体力` | 原神 / 星铁实时便笺 |
| 绝区零体力 | `apps/noteZzz.js`（300） | `#绝区零体力` | 绝区零便笺 |
| 用户绑定 | `apps/user.js`（300） | `#绑定cookie` / `#绑定uid` / `#我的ck` / `#删除ck` | CK、UID 绑定与解绑、ck 状态检查、导入 |
| 抽卡记录 | `apps/gcLog.js`（300） | `#抽卡记录` / `#导出记录` / `authkey=` 链接 | 记录导入导出、按池统计、`#记录帮助` |
| 札记查询 | `apps/ledger.js`（300） | `#原石` / `#原石统计` / `#星琼任务` | 原石 / 星琼收支 |
| 用户管理 | `apps/userAdmin.js`（300） | `#用户统计` / `#刷新用户缓存` / `#删除失效ck` | CK 用户侧维护 |
| 邦布查询 | `apps/buddy.js`（300） | `#邦布` / `#绝区零邦布` | 绝区零邦布 |
| 角色素材 | `apps/material.js`（500） | `#刻晴突破` / `#刻晴材料` | 养成突破素材图 |
| 别名设置 | `apps/abbrSet.js`（600） | `#设置刻晴别名` / `#删除别名` / `#刻晴别名` | 角色别名读写（含星铁） |
| 养成计算 | `apps/calculator.js`（700） | `#刻晴养成计算` / `#角色养成` | 升级所需材料 |
| 配置 | `apps/setPubCk.js`（700） | `#配置ck` / `#使用用户ck` | 公共查询 CK 池 |
| 兑换码 | `apps/exchange.js`（1000） | `#兑换码` / `#兑换码使用 <cdk>` | 前瞻直播码（国服）与使用 |
| 留影叙佳期 | `apps/takeBirthdayPhoto.js`（5000） | `#留影` / `#生日` | 角色生日立牌 |
| 米游社公告 | `apps/mysNews.js`（7000） | `#公告` / `#资讯` / `#米游社xxx` / `#开启公告推送` | 公告资讯、帖子搜索、到期活动预警 |

星铁 / 绝区零走同一套 app，靠消息前缀与 `e.game` 分流（见 [`docs/多游戏支持.md`](docs/多游戏支持.md)）。

## 文档索引（按需阅读，别一次全读）

| 想了解 / 要改的东西 | 先读 |
|---|---|
| 目录结构、入口加载、分层职责、import 路径、`e` 扩展、`accept()`、关键类、配置系统 | [`docs/架构.md`](docs/架构.md) |
| 查询请求链路、CK 分配池（Redis ZSet）、NoteUser / MysUser 层级 | [`docs/数据流与用户模型.md`](docs/数据流与用户模型.md) |
| CK 失效自动刷新：stoken 来源、互斥与重试、通知口径、边界 | [`docs/CK自动刷新.md`](docs/CK自动刷新.md) |
| 三游戏的前缀 / 资源 / UID / server 区分 | [`docs/多游戏支持.md`](docs/多游戏支持.md) |
| 与官方的关系、按提交挑选的同步流程、冲突处理 | [`docs/上游同步.md`](docs/上游同步.md) |
| ESM、渲染、路径等硬约定，插件 class 注册方式 | [`docs/编码约定.md`](docs/编码约定.md) |
| 待验证项与长期观察 | [`docs/待办与规划.md`](docs/待办与规划.md) |
| 盘符、部署机、本机工作区、文档站本地路径（**不入库**） | `docs/private/`（新克隆上不存在） |

## 约定

1. **ESM** — 全部 `import` / `export`，不用 `require`
2. **日志** — `logger.info/warn/error`；**没有 `logger.debug`**（框架等级是 info，debug 等于不输出）；排查用的临时日志**验证完必须还原**
3. **中文** — 注释、`name` / `dsc`、用户可见文案一律简体中文
4. **容错加载** — `index.js` 用 `Promise.allSettled`，单个 app 失败不影响整体
5. **import 路径** — 同层 `./`、框架 `../../../lib/`、miao-plugin `#miao` / `#miao.models`；不写绝对路径，根目录用 `process.cwd()`
6. **优先级** — 数值越小越先执行；改 `rule` 前先看「快速参考」里同前缀邻居的优先级
7. **文档入库范围** — `AGENTS.md` 与 `docs/`（除 `docs/private/`）**入库**，与代码一同评审提交；`docs/private/` 放盘符、部署机与本机工作区，**不入库**，因此入库文档只写占位（`<插件根>` / `<bot根>` / `<文档站根>`）且**不得依赖**它（新克隆上没有）；`CLAUDE.md` / `.claude/` / `.dsh/` 仍忽略
8. **文档必须同步** — 功能 / 命令 / 配置变更时同批更新：`docs/` 对应册、`README.md`（面向使用者）、本文件「快速参考」、文档站 `guide/yunzai/plugins/genshin.md`
9. **不擅自扩大改动** — 数据口径与命令行为变更先给方案；[`docs/待办与规划.md`](docs/待办与规划.md) 里标「待验证 / 已定结论」的条目按原结论执行

## 硬约束速查（改前必读；细节见各册）

1. **一个 CK 只能对应一个账号** — `NoteUser.addMysUser()` 有归属校验：已归属他人时只 `logger.warn` 跳过，不覆盖、不静默转移；要转移须先让原主 `#删除ck`
2. **CK 刷新只更新账号级数据** — `ckRefresh.doRefreshCk()` 只做 `MysUser.setCkData()` + `save()`，**不得**再走 `bing()` / `addMysUser()`（会把账号挂到本次触发查询的人头上，双归属就是这么来的）
3. **失效通知不发私聊** — 刷新失败只在群内 @（防风控）；成功通知无群上下文时才私聊兜底
4. **上游同步不能 merge / subtree** — 与官方零公共祖先；只能 `git fetch miao` 后按提交挑文件，见 [`docs/上游同步.md`](docs/上游同步.md)
5. **二进制资源别用 PowerShell 重定向** — `git show ... > file` 在 PS 里会按文本转码；二进制走 `cmd /c`
6. **不要 push 镜像仓库的 `origin`** — 那是官方仓库
7. **格式化提交不纳入同步** — 全量 `pnpm lint` 类提交跳过，无功能价值且会污染自有代码风格
8. **`stokenPath` 是跨插件外挂依赖** — 默认指向 Axiu-Plugin 的 stoken 目录；改路径要同时改 `defSet/mys/set.yaml` 与文档
9. **`checkCode` 的 `ckUser` 可能为 `null`** — 公共 CK 空 ck 场景；新增逻辑必须守卫
10. **兑换码过期时间以官方文案为准** — 解析 `miyolive index` 的 `template.codeTipText`；**不要**退回「预告帖发布时间 + 固定天数」推算（避讳延播必算错）
11. **卡池时间以 miao-plugin 为准** — 原神角色限定池（301）/武器池（302）的卡池时间取自 miao-plugin `resources/meta-gs/info/pool.js`，经 `model/poolData.js` 适配；**不要**手工补 `defSet/pool/301|302.yaml`（仅作回退）。星铁 11/12、集录 500 仍读 YAML

## 待办（摘要）

- **兑换码过期时间待验证** — 星铁 / 崩三 / 绝区零的 `template.codeTipText` 与兜底天数需在某期前瞻活动窗口实测；崩三 / 绝区零的 `act_id` 获取路径疑似失效
- **双归属修复观察** — `f8cc0bc` 上线后观察一段时间，日志出现「防双归属」`warn` 即为复发信号
- **卡池数据** — 原神 301/302 已改由 miao-plugin 提供；星铁 11/12 停更（已确认不重要）、集录 500 仍是 YAML、上游 luck 图资源缺失
- 详见 [`docs/待办与规划.md`](docs/待办与规划.md)
