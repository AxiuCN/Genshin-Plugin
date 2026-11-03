import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import gsCfg from "./gsCfg.js"

/**
 * 卡池数据适配层。
 *
 * 原神角色限定池（301）/ 武器限定池（302）以 miao-plugin 的
 * `resources/meta-gs/info/pool.js` 为权威数据源（miao 每期维护，含最新卡池时间），
 * 其余池子类型（星铁 11/12、集录 500、常驻/新手、联动）miao 无数据，仍读 `defSet/pool/<type>.yaml`。
 */

const poolFile = path.join(process.cwd(), "plugins", "miao-plugin", "resources", "meta-gs", "info", "pool.js")

/** 由 miao 数据提供的池子类型 */
const MIAO_TYPE = { 301: "char", 302: "weapon" }

/** 武器限定池名称固定 */
const WEAPON_POOL_NAME = "神铸赋形"

let poolName = {}
let poolDetail = []

/** miao 数据偶有年份手误（如 22026-11-24），规范为 4 位年份，避免 moment 解析失败 */
function normalizeTime(val) {
  if (typeof val !== "string") return val
  return val.replace(/^(\d{5,})(-\d{2}-\d{2})/, (all, year, rest) => {
    const fixed = year.slice(-4) + rest
    logger?.warn(`[genshin] miao 卡池时间年份异常：${all}，按 ${fixed} 处理`)
    return fixed
  })
}

if (fs.existsSync(poolFile)) {
  try {
    const mod = await import(pathToFileURL(poolFile).href)
    poolName = mod.poolName || {}
    poolDetail = (mod.poolDetail || [])
      .filter(v => v.from && v.to)
      .map(v => ({ ...v, from: normalizeTime(v.from), to: normalizeTime(v.to) }))
  } catch (err) {
    logger?.warn(`[genshin] 读取 miao-plugin 卡池数据失败，回退 defSet/pool：${err.message}`)
  }
}

/** 当前时间，与 miao 卡池时间同格式（YYYY-MM-DD HH:mm:ss），可直接字符串比较 */
function nowStr() {
  const d = new Date()
  const pad = n => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 按开始时间升序 */
function byFrom(list) {
  return [...list].sort((a, b) => (a.from > b.from ? 1 : -1))
}

export default class PoolData {
  /** miao 卡池数据是否可用 */
  static get enabled() {
    return poolDetail.length > 0
  }

  /**
   * 卡池区间列表，供按池归类（logCount）
   * @param {number|string} type 池子类型
   * @returns {object[]} [{ from, to, name, five, four }]
   */
  static getPoolCfg(type) {
    if (!MIAO_TYPE[type] || !this.enabled) return gsCfg.getdefSet("pool", type)
    const isRole = type == 301
    return byFrom(poolDetail).map(val => ({
      from: val.from,
      to: val.to,
      name: isRole ? this.rolePoolName(val) : WEAPON_POOL_NAME,
      five: [...(isRole ? val.char5 || [] : val.weapon5 || [])],
      four: [...(isRole ? val.char4 || [] : val.weapon4 || [])],
    }))
  }

  /**
   * 当期卡池，供抽卡模拟（gachaData）
   * @returns {object|null} { from, to, endTime, up5, up5_2, up4, weapon5, weapon4, name }
   */
  static getNowPool() {
    if (!this.enabled) return null
    const now = nowStr()
    const list = byFrom(poolDetail.filter(val => val.to >= val.from))
    /** 优先当前所处卡池，其次最近一个已开始的卡池 */
    const pool = list.filter(val => now >= val.from && now <= val.to).pop() || list.filter(val => val.from <= now).pop()
    if (!pool) return null
    const char5 = pool.char5 || []
    return {
      from: pool.from,
      to: pool.to,
      endTime: pool.to,
      up5: char5.slice(0, 1),
      up5_2: char5.slice(1, 2),
      up4: [...(pool.char4 || [])],
      weapon5: [...(pool.weapon5 || [])],
      weapon4: [...(pool.weapon4 || [])],
      name: this.rolePoolName(pool),
    }
  }

  /** 角色池名：按 UP 角色在 miao poolName 里的池名拼接，如 饫宴角戏|云府鹤行 */
  static rolePoolName(pool) {
    const names = (pool.char5 || []).map(name => poolName[name]).filter(Boolean)
    return names.length ? names.join("|") : "限定角色池"
  }
}
