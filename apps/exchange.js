import plugin from "../../../lib/plugins/plugin.js"
import common from "../../../lib/common/common.js"
import fetch from "node-fetch"
import MysInfo from "../model/mys/mysInfo.js"

/**
 * 兑换码过期时间兜底规则（官方文案 codeTipText 缺失/解析失败时，按直播结束日推算）
 * key = 官方米游社账号 uid
 * 说明：优先使用官方文案，本表仅在兜底时生效；实际以官方公告为准
 */
const CODE_EXPIRE_FALLBACK = {
  "75276539": { days: 3, time: "12:00:00" }, // 原神
  "80823548": { days: 1, time: "23:59:59" }, // 星铁
  "73565430": { days: 1, time: "23:59:59" }, // 崩三
  "152039148": { days: 2, time: "23:59:59" }, // 绝区零
}

/** 两位补零 */
function pad2(num) {
  return String(num).padStart(2, "0")
}

export class exchange extends plugin {
  constructor() {
    super({
      name: "兑换码",
      dsc: "前瞻直播兑换码",
      event: "message",
      priority: 1000,
      rule: [
        {
          reg: /^(#|\*)?(原神|星铁|崩铁|崩三|崩坏三|崩坏3|绝区零)?(直播|前瞻)?兑换码$/,
          fnc: "getCode",
        },
        {
          reg: "^#(原神|星铁|绝区零)?(兑换码使用|cdk-u).+",
          fnc: "useCode",
        },
      ],
    })
  }

  async getCode() {
    let reg = this.e.msg.match(
      /^(#|\*)?(原神|星铁|崩铁|崩三|崩坏三|崩坏3|绝区零)?(直播|前瞻)?兑换码$/,
    )
    this.uid = "75276539"
    this.gid = "2"
    if (reg[1] == "*" || ["星铁", "崩铁"].includes(reg[2])) {
      this.uid = "80823548"
      this.gid = "6"
    }
    if (["崩三", "崩坏三", "崩坏3"].includes(reg[2])) {
      this.uid = "73565430"
      this.gid = "1"
    }
    if (reg[2] == "绝区零") {
      this.uid = "152039148"
      this.gid = "8"
    }
    this.now = parseInt(Date.now() / 1000)
    let actid = await this.getActId()
    if (!actid) {
      actid = await this.getBackupActId()
    }
    if (!actid) {
      logger.info("[兑换码] 未获取到actId")
      return true
    }

    this.actId = actid

    /** index info */
    let index = await this.getData("index")
    if (!index || !index.data) {
      return true
    }

    if (index.data === null) {
      return await this.reply(`错误：\n${index.message}`)
    }

    let index_data = index.data.live
    let title = index_data["title"]
    this.code_ver = index_data["code_ver"]
    /** 官方模板：codeTipText 内含兑换码过期文案（如「兑换码将于9月15日12:00过期」） */
    let template = {}
    try {
      template = JSON.parse(index.data.template || "{}") || {}
    } catch (err) {
      logger.warn(`[兑换码] template 解析失败: ${err.message}`)
    }
    if (index_data.remain > 0) {
      return await this.reply(`暂无${title}直播兑换码`, true)
    }

    let code = await this.getData("code")
    /** 过期时间：官方文案优先，直播结束日推算兜底 */
    let time = this.getExpireTime(template, index_data, code)
    if (!code || !code.data?.code_list) {
      logger.info("[兑换码] 未获取到兑换码")
      return true
    }
    let codes = []

    for (let val of code.data.code_list) {
      if (val.code) {
        codes.push([
          val.code,
          segment.button([{ text: "兑换", callback: `#兑换码使用${val.code}` }]),
        ])
      }
    }

    let msg = [`兑换码过期时间: \n${time}`, ...codes]
    msg = await common.makeForwardMsg(this.e, msg, `${title}-直播兑换码`)
    await this.reply(msg)
  }

  async getData(type) {
    let url = {
      index: `https://api-takumi.mihoyo.com/event/miyolive/index`,
      code: `https://api-takumi-static.mihoyo.com/event/miyolive/refreshCode?version=${this.code_ver}&time=${this.now}`,
      actId: `https://bbs-api.mihoyo.com/painter/api/user_instant/list?offset=0&size=20&uid=${this.uid}`,
      nav: `https://bbs-api.miyoushe.com/apihub/api/home/new?gids=${this.gid}&parts=1%2C3%2C4`,
    }

    let response
    try {
      response = await fetch(url[type], {
        method: "get",
        headers: {
          "x-rpc-act_id": this.actId,
        },
      })
    } catch (error) {
      logger.error(error.toString())
      return false
    }

    if (!response.ok) {
      logger.error(`[兑换码接口错误][${type}] ${response.status} ${response.statusText}`)
      return false
    }
    const res = await response.json()
    return res
  }

  // 获取 "act_id"（帖子仅用于提取直播活动链接；过期时间不再以帖子发布时间推算）
  async getActId() {
    let ret = await this.getData("actId")
    if (ret.error || ret.retcode !== 0) {
      return ""
    }

    for (const p of ret.data.list) {
      // Not every posts have post.post
      let post = p?.post?.post
      if (!post) {
        continue
      }
      let structured_content = post.structured_content
      let result = structured_content.match(
        /{\"link\":\"https:\/\/webstatic.mihoyo.com\/bbs\/event\/live\/index.html\?act_id=(.*?)\\/,
      )
      if (result) {
        return result[1]
      }
    }
  }

  // 兑换码使用
  async useCode() {
    const cdkCode = this.e.msg.replace(/#(原神|星铁|绝区零)?(兑换码使用|cdk-u)/, "").trim()
    const res = await MysInfo.get(this.e, "useCdk", { cdk: cdkCode })
    if (res.retcode == 0) {
      this.e.reply(`${res.data.msg}`)
    }
  }

  async getBackupActId() {
    const res = await this.getData("nav")
    if (res.retcode !== 0) return null
    const navMatch = res.data?.navigator?.find(
      item => item.name.match(/前瞻|特别节目/) && item.app_path.includes("act_id="),
    )

    if (navMatch) {
      const actId = navMatch.app_path.match(/act_id=([a-zA-Z0-9]+)/)[1]
      return actId
    }
  }

  /**
   * 获取兑换码过期时间：官方文案优先，其次按直播结束日推算兜底
   * @param {object} template 官方模板（codeTipText 含「兑换码将于9月15日12:00过期」）
   * @param {object} live 直播信息（含 start/end）
   * @param {object} code refreshCode 返回（code_list[].to_get_time 兜底）
   * @returns {string} 过期时间 YYYY-MM-DD HH:MM:SS，无法获取时返回「未知」
   */
  getExpireTime(template = {}, live = {}, code = {}) {
    // ① 官方文案（最权威：不受直播改期影响）
    let tip = template?.codeTipText || ""
    let m = tip.match(/将于\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})/)
    if (m) {
      let year = this.getExpireYear(Number(m[1]), Number(m[2]), live)
      return `${year}-${pad2(m[1])}-${pad2(m[2])} ${pad2(m[3])}:${m[4]}:00`
    }
    if (tip) {
      logger.warn(`[兑换码] codeTipText 解析失败: ${tip}`)
    }

    // ② 直播结束日 + 各游戏兜底天数
    let rule = CODE_EXPIRE_FALLBACK[this.uid]
    let base =
      this.parseDate(live?.end) ||
      this.parseDate(live?.start) ||
      this.parseDate(code?.data?.code_list?.[0]?.to_get_time)
    if (rule && base) {
      base.setDate(base.getDate() + rule.days)
      return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())} ${rule.time}`
    }

    logger.warn(`[兑换码] 过期时间无法获取（uid:${this.uid}）`)
    return "未知"
  }

  /**
   * 过期年份推断：以直播时间为基准，解析出的月日若明显早于直播则视为次年（跨年保护）
   * @param {number} mon 文案中的月
   * @param {number} day 文案中的日
   * @param {object} live 直播信息
   * @returns {number} 年份
   */
  getExpireYear(mon, day, live = {}) {
    let base = this.parseDate(live?.end) || this.parseDate(live?.start) || new Date()
    let year = base.getFullYear()
    // 早于直播 30 天以上 → 判定为次年（如 12 月直播、文案写 1 月）
    if (new Date(year, mon - 1, day).getTime() < base.getTime() - 30 * 24 * 3600 * 1000) {
      year += 1
    }
    return year
  }

  /**
   * 解析日期：支持「2026-09-12 21:16:10」与秒级时间戳
   * @param {string|number} val
   * @returns {Date|null}
   */
  parseDate(val) {
    if (!val) return null
    let date = /^\d{9,10}$/.test(String(val))
      ? new Date(Number(val) * 1000)
      : new Date(String(val).replace(/-/g, "/"))
    return isNaN(date.getTime()) ? null : date
  }
}
