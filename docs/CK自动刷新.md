# CK自动刷新

> CK 失效（`retcode=10001` + login）时的自动刷新链路、通知口径与边界。

`MysApi.getData` 原生拦截 `retcode=10001` 且 message 含「登录/login」的响应（`model/mys/ckRefresh.js`，自 Axiu-Plugin 猴子补丁迁移）：

```
原请求 → 10001
  → 从 this.cookie 提取 ltuid（或 account_id）
  → findStokenByLtuid：遍历 stoken 目录（mys.set.stokenPath）匹配 stuid === ltuid
  → 命中：
      → 互斥锁 Map<ltuid, Promise>：并发仅首请求刷新，其余 await 其结果
      → doRefreshCk：passport bbsGetCookie 换 cookie_token → user.js bing() 绑定
      → 新 cookie 重试原请求（_ckRefreshing 防递归标志）
  → 未命中/刷新失败：返回原始错误，走 checkCode 原 delCk 逻辑
```

- **stoken 数据源**：`defSet/mys/set.yaml` 的 `stokenPath`，默认 `plugins/Axiu-Plugin/data/stoken/`（扫码登录绑定产物），可指向任意插件的 stoken 目录；stoken 为账号级凭证（同 stuid 多游戏角色通用）
- **通知**：成功「先前ck已失效，米游社ck自动刷新成功」/失败「sk已失效，请重新扫码登陆」，对象 = stoken 条目 `userId`（触发查询在群内且绑定者即查询者时群内@）；成功通知无群上下文时私聊兜底，**失败通知禁用私聊兜底**（防止风控，无群上下文或@失败时跳过）
- **边界**：公共 CK 无 stoken 绑定不触发刷新；星铁走 Axiu-Plugin `MysSrApi` 自实现，不经此 hook；`checkCode` 的 `ckUser` null 守卫保证公共 CK 空 ck 场景不崩溃
