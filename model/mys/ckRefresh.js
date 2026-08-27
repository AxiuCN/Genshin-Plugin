/** CK 自动刷新 — 自 Axiu-Plugin apps/ckAutoRefresh.js 迁移至 genshin 原生实现
 *
 *  当米游社 API 返回 retcode 10001（CK 过期）时：
 *    1. 从 cookie 中提取 ltuid
 *    2. 遍历 stoken 目录下的 YAML，匹配 stuid === ltuid
 *    3. 用匹配到的 stoken 调 passport bbsGetCookie 获取新 cookie_token
 *    4. 更新账号级 MysUser 的 ck 数据（仅写库，不修改 QQ↔账号 归属）
 *    5. 用新 cookie 重试原请求
 *
 *  成功 → 通知触发查询者 "先前ck已失效，米游社ck自动刷新成功"
 *  失败 → 通知触发查询者 "sk已失效，请重新扫码登陆" → 返回原始错误（走 checkCode 原 delCk 逻辑）
 *
 *  说明：刷新只更新该账号（stuid）的 ck 数据，**不做 bing/归属绑定**——
 *  绑定关系（QQ↔ltuid）保持不变，避免把账号写进与查询无关的用户名下
 *  （历史 bug：刷新时 bing 到 stoken 条目 userId 会造成"绑定上别人的账号"）。
 *
 *  stoken 数据目录通过配置 mys.set.stokenPath 指定（默认 Axiu-Plugin），
 *  可指向任意插件的 stoken 目录。
 *
 *  接入方式：model/mys/mysApi.js 的 getData 末尾调用 tryRefreshCk，
 *  覆盖 genshin 自身查询、miao-plugin 包装器及 Axiu-Plugin 直连 MysApi 的所有请求
 */

import md5 from "md5"
import fetch from "node-fetch"
import fs from "node:fs"
import YAML from "yaml"

/** passport 常量（对齐 Axiu-Plugin model/mys/passportTool.js） */
const PASS_HOST = "https://passport-api.mihoyo.com"
const PASS_SALT = "JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS"
const APP_VERSION = "2.70.1"
const DEVICE_ID = randomString(32).toUpperCase()
const DEVICE_NAME = randomString(12)

/** 默认 stoken 数据目录（可通过 mys.set.stokenPath 配置指向其他插件） */
const DEFAULT_STOKEN_PATH = "plugins/Axiu-Plugin/data/stoken/"

/** 互斥锁：Map<ltuid, Promise<string|null>>，同一 ltuid 并发请求仅第一个刷新 */
const _refreshLocks = new Map()

/** 生成随机字符串（设备指纹/设备名使用） */
function randomString(length = 16) {
  const characters = "abcdefghijklmnopqrstuvwxyz0123456789"
  let result = ""
  for (let i = 0; i < length; i++) {
    result += characters[Math.floor(Math.random() * characters.length)]
  }
  return result
}

/** 从 cookie 字符串中提取指定字段 */
function getCookieField(cookie, field) {
  if (!cookie) return null
  const match = cookie.match(new RegExp(`${field}=([^;]*)`))
  return match ? match[1] : null
}

/**
 * stoken 数据目录（读 mys.set.stokenPath 配置）
 * 动态 import gsCfg 避免循环依赖（gsCfg → mysInfo → mysApi → ckRefresh）
 * @returns {Promise<string>}
 */
async function getStokenDir() {
  try {
    const gsCfg = (await import("../gsCfg.js")).default
    const conf = gsCfg.getConfig("mys", "set") || {}
    return conf.stokenPath || DEFAULT_STOKEN_PATH
  } catch (err) {
    logger.error("[CK自动刷新] 读取stoken目录配置失败:", err)
    return DEFAULT_STOKEN_PATH
  }
}

/**
 * 遍历所有 stoken YAML 文件，查找 stuid 匹配 ltuid 的记录
 * 同一 stuid 出现多条目时（数据异常）仅告警，仍返回首个（stoken 为账号级凭证，任意条目可刷新）
 * @param {string} ltuid 米游社通行证 ID
 * @returns {Promise<{stoken: object} | null>}
 */
async function findStokenByLtuid(ltuid) {
  const dir = await getStokenDir()
  try {
    if (!fs.existsSync(dir)) return null
    const files = fs.readdirSync(dir).filter(file => file.endsWith(".yaml"))
    let first = null
    let count = 0
    for (const file of files) {
      const data = YAML.parse(fs.readFileSync(`${dir}${file}`, "utf8")) || {}
      for (const st of Object.values(data)) {
        if (st && String(st.stuid) === String(ltuid)) {
          count++
          if (!first) first = { stoken: st }
        }
      }
    }
    if (count > 1) {
      logger.warn(`[CK自动刷新] stuid:${ltuid} 存在多个stoken条目（${count}处），请检查stoken数据归属`)
    }
    return first
  } catch (err) {
    logger.error("[CK自动刷新] 搜索stoken失败:", err)
  }
  return null
}

/** pass 类型 DS 签名（对齐 passport api 的 getDs2，query/body 均为空） */
function getPassDs() {
  const t = Math.round(Date.now() / 1000)
  const r = 100001 + Math.floor(Math.random() * 100000)
  const DS = md5(`salt=${PASS_SALT}&t=${t}&r=${r}&b=&q=`)
  return `${t},${r},${DS}`
}

/**
 * 调 passport bbsGetCookie 换取新 cookie_token
 * @param {object} stoken stoken 条目（stuid/stoken/mid/ltoken）
 * @returns {Promise<object|false>} 接口响应，请求/解析失败返回 false
 */
async function bbsGetCookie(stoken) {
  let query = `uid=${stoken.stuid}&stoken=${stoken.stoken}`
  let cookie = `stuid=${stoken.stuid};stoken=${stoken.stoken}`
  if (stoken.mid) {
    query += `&mid=${stoken.mid}`
    cookie += `;mid=${stoken.mid}`
  }
  cookie += ";"

  const url = `${PASS_HOST}/account/auth/api/getCookieAccountInfoBySToken?${query}`
  const headers = {
    "x-rpc-device_id": DEVICE_ID,
    "x-rpc-app_id": "bll8iq97cem8",
    "x-rpc-device_name": DEVICE_NAME,
    "x-rpc-device_fp": "38d7ee0e96649",
    "x-rpc-device_model": randomString(16),
    "x-rpc-app_version": APP_VERSION,
    "x-rpc-game_biz": "bbs_cn",
    "x-rpc-sys_version": "11",
    "x-rpc-aigis": "",
    "Content-Type": "application/json;",
    "x-rpc-client_type": "2",
    DS: getPassDs(),
    "x-rpc-sdk_version": "1.3.1.2",
    "User-Agent": "okhttp/4.8.0",
    Connection: "Keep-Alive",
    "Accept-Encoding": "gzip, deflate, br",
    "x-rpc-channel": "appstore",
    Cookie: cookie,
  }

  let response = {}
  try {
    response = await fetch(url, { headers, method: "get", timeout: 10000 })
  } catch (error) {
    logger.error("[CK自动刷新] bbsGetCookie 请求失败:", error.toString())
    return false
  }

  if (!response.ok) {
    logger.error(`[CK自动刷新] bbsGetCookie ${response.status} ${response.statusText}`)
    return false
  }

  let text = await response.text()
  if (text.startsWith("(")) {
    text = text.replace(/^\(|\)$/g, "")
  }
  try {
    return JSON.parse(text)
  } catch {
    return false
  }
}

/**
 * 通知用户（优先群内 @；失败类通知禁用私聊兜底，防止风控）
 * @param {string|undefined} userId 通知对象（触发查询者 QQ；无效则跳过）
 * @param {string} message 通知内容
 * @param {{userId: any, groupId: any} | null} ctx 触发查询的上下文
 * @param {{private?: boolean}} option 通知选项，private:false 时无群上下文/群内@失败则跳过（不私聊）
 */
async function notifyUser(userId, message, ctx, option = {}) {
  if (!userId) {
    logger.warn("[CK自动刷新] 无通知对象（缺少触发者上下文），跳过通知")
    return
  }
  const uid = String(userId)
  // 群内 @：触发查询处于群聊时（通知对象即触发者）
  if (ctx?.groupId) {
    try {
      await Bot.pickGroup(ctx.groupId).sendMsg([segment.at(uid), " ", message])
      return
    } catch (err) {
      logger.debug("[CK自动刷新] 群内@通知失败:", err?.message)
    }
  }
  // 失败类通知禁止私聊（防风控），无群上下文或@失败时跳过
  if (option.private === false) return
  // 兜底：私聊
  try {
    await Bot.pickFriend(userId).sendMsg(message)
  } catch (err) {
    logger.warn("[CK自动刷新] 发送通知失败:", err)
  }
}

/**
 * 执行 CK 刷新（实际逻辑，由互斥锁保护）
 * 只更新账号级 ck 数据，不修改 QQ↔账号 归属（防止绑到与查询无关的用户）
 * @param {string} ltuid 失效 cookie 的账号 ID
 * @param {{stoken: object}} found 匹配到的 stoken
 * @param {{userId: any, groupId: any} | null} ctx 触发查询的上下文（通知对象）
 * @returns {Promise<string|null>} 成功返回完整 cookie，失败返回 null
 */
async function doRefreshCk(ltuid, found, ctx) {
  logger.info(`[CK自动刷新] 检测到ck失效 ltuid:${ltuid}，尝试从stoken刷新...`)
  const notifyId = ctx?.userId

  // 调 bbsGetCookie 获取新 cookie_token
  const refreshRes = await bbsGetCookie(found.stoken)

  if (!refreshRes?.data?.cookie_token) {
    logger.warn(
      `[CK自动刷新] 刷新失败 ltuid:${ltuid}:`,
      refreshRes?.message || refreshRes?.retcode,
    )
    await notifyUser(notifyId, "sk已失效，请重新扫码登陆", ctx, { private: false })
    return null
  }

  const fullCookie =
    `ltoken=${found.stoken.ltoken};ltuid=${found.stoken.stuid};` +
    `cookie_token=${refreshRes.data.cookie_token};account_id=${found.stoken.stuid};`

  // 更新账号级 ck 数据（动态 import 避免循环依赖：MysUser → mysApi → ckRefresh）
  // 不调用 user.js bing()：刷新不改变 QQ↔账号 归属，仅让所有引用该账号的查询/用户拿到新 ck
  try {
    const MysUser = (await import("./MysUser.js")).default
    const mys = await MysUser.create(found.stoken.stuid)
    if (!mys) {
      logger.warn(`[CK自动刷新] 无账号记录可更新 ltuid:${found.stoken.stuid}`)
      return null
    }
    mys.setCkData({ ck: fullCookie })
    await mys.save()
    logger.info(`[CK自动刷新] ck刷新成功 ltuid:${found.stoken.stuid}`)
  } catch (err) {
    logger.error(`[CK自动刷新] 账号ck写入失败: ${err.message}`)
    await notifyUser(notifyId, "sk已失效，请重新扫码登陆", ctx, { private: false })
    return null
  }

  await notifyUser(notifyId, "先前ck已失效，米游社ck自动刷新成功", ctx)
  return fullCookie
}

/**
 * MysApi.getData 钩子：拦截 CK 过期（retcode 10001 且 message 含 login）
 *
 * 并发语义：
 *   同一 ltuid 的多个并发请求中，只有第一个执行刷新，其余等待其结果。
 *   刷新成功 → 所有等待者用新 cookie 各自重试
 *   刷新失败 → 所有等待者返回原始错误
 *
 * 死锁保护：doRefreshCk 包在 try-catch 中，异常时 resolveLock(null) + finally 删锁
 *
 * @param {object} mysApi MysApi 实例
 * @param {string} type API 类型
 * @param {object} data 请求参数
 * @param {boolean} cached 是否写缓存
 * @param {object} res 原请求响应
 * @returns {Promise<object>} 重试后的响应或原响应
 */
export async function tryRefreshCk(mysApi, type, data, cached, res) {
  // 仅拦截 CK 过期（retcode 10001 且 message 含 login）
  if (!res || Number(res.retcode) !== 10001) return res
  if (!/(登录|login)/i.test(res.message)) return res

  // 防止递归：已刷新过一次不再重复
  if (mysApi._ckRefreshing) return res

  // 从当前 cookie 提取 ltuid
  const ltuid =
    getCookieField(mysApi.cookie, "ltuid") || getCookieField(mysApi.cookie, "account_id")
  if (!ltuid) return res

  // 查找匹配的 stoken（先查，无匹配则不走锁逻辑）
  const found = await findStokenByLtuid(ltuid)
  if (!found) return res

  const ctx = mysApi.ctx || null

  // === 并发保护：检查是否已有进行中的刷新 ===
  const existingLock = _refreshLocks.get(ltuid)
  if (existingLock) {
    // 已有其他请求在刷新，等待其结果
    logger.info(`[CK自动刷新] ltuid:${ltuid} 已有刷新进行中，等待...`)
    const newCookie = await existingLock
    if (newCookie) {
      mysApi.cookie = newCookie
      mysApi._ckRefreshing = true
      try {
        return await mysApi.getData(type, data, cached)
      } finally {
        delete mysApi._ckRefreshing
      }
    }
    return res
  }

  // === 无进行中刷新 → 当前请求负责刷新 ===
  let resolveLock
  const lockPromise = new Promise(resolve => {
    resolveLock = resolve
  })
  _refreshLocks.set(ltuid, lockPromise)

  try {
    const newCookie = await doRefreshCk(ltuid, found, ctx)
    resolveLock(newCookie) // 通知所有等待者

    if (newCookie) {
      // 用新 cookie 重试当前请求
      mysApi._ckRefreshing = true
      mysApi.cookie = newCookie
      try {
        return await mysApi.getData(type, data, cached)
      } finally {
        delete mysApi._ckRefreshing
      }
    }
    return res
  } catch (err) {
    // 防止死锁：doRefreshCk 异常时也要通知等待者
    logger.error("[CK自动刷新] 未预期异常:", err)
    resolveLock(null)
    return res
  } finally {
    _refreshLocks.delete(ltuid)
  }
}