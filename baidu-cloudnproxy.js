/**
 * 百度 cloudnproxy 节点生成脚本 (Sub-Store Node.js 版 / HTTP-META 实测落地)
 *
 * 作用:
 *   1. DoH 解析 cloudnproxy.baidu.com 的全部 A 记录, 每个入口 IP 生成一个 http 节点,
 *      节点头按百度 T5 直连模板填写 (Host / X-T5-Auth / User-Agent / Meng)。
 *   2. 通过自带 HTTP-META 启动 mihomo 核心, 逐节点真实发起请求测「落地 IP」,
 *      再查落地 IP 的省份+运营商。
 *   3. 按「入口省份+运营商|出口省份+运营商」命名 (如 广东移动|江苏电信)。
 *      测不到落地 IP 的节点直接丢弃 (测活)。
 *   4. DNS / 入口归属 / 落地 IP / 落地归属 全部缓存 12 小时。
 *
 * 关于「出口」:
 *   出口不是 Host 头里的 IP。Host: 153.3.236.22:443 是 T5 协议必需的鉴权头
 *   (实测改成别的 Host 会被上游 ERR_ACCESS_DENIED 拒绝), 它自身的归属地是固定的。
 *   真实出口 IP 必须用 HTTP-META 把节点跑起来、发一个查 IP 的请求才能拿到,
 *   不同入口 IP 实测会得到不同落地 IP。本脚本正是这么做的。
 *
 * 用法:
 *   1. 脚本订阅: Sub-Store -> 订阅 -> 新建 -> 类型「脚本」/ 粘贴本文件内容
 *      (脚本订阅下 operator 收到的 proxies 为空, 返回即生成的节点)
 *   2. 节点操作: 任意订阅 -> 节点操作 -> 脚本操作 粘贴本文件 URL,
 *      会把生成的节点追加到原订阅节点之后 (传 append=false 改为替换)
 *   脚本链接参数以 # 开头, 多个用 & 连接:
 *     #host=153.3.236.22:443&auth=683556433&cache_ttl=43200000
 *
 * 环境: 已内置/部署 HTTP-META 的 Sub-Store 后端 (Docker xream/sub-store 的 http-meta
 *   镜像、Android 模块版等)。本脚本必须启动 HTTP-META 核心, 无核心会报错。
 *
 * HTTP-META 参数:
 *   - http_meta_protocol      协议, 默认 http
 *   - http_meta_host          服务地址, 默认 127.0.0.1
 *   - http_meta_port          端口, 默认 9876
 *   - http_meta_authorization Authorization, 默认无
 *   - http_meta_start_delay   初始启动延时(毫秒), 默认 3000
 *   - http_meta_ready_timeout 核心就绪等待超时(毫秒), 默认 30000
 *   - http_meta_proxy_timeout 每个节点耗时(毫秒), 默认 10000
 *       总超时 = start_delay + 节点数 * proxy_timeout, 防止脚本异常退出时核心过早退出
 *
 * 节点/模板参数:
 *   - domain          解析的域名, 默认 cloudnproxy.baidu.com
 *   - dns_server      DoH JSON 接口, 默认 https://223.5.5.5/resolve
 *                     (支持 short=1 数组或 {Answer:[...]} 结构)
 *   - host            Host 头 (T5 鉴权, 非出口 IP), 默认 153.3.236.22:443
 *                     ⚠ 与 auth 成对: 实测改成入口 IP / 其它 IP / 单独换 auth
 *                       都会被上游 403 ERR_ACCESS_DENIED 拒绝, 勿随意改
 *   - auth            X-T5-Auth, 默认 683556433 (须与 host 配对)
 *   - ua              User-Agent, 默认模板里的 baiduboxapp UA
 *   - meng            Meng 头, 默认 dm.toutiao.com
 *   - port            节点端口, 默认 443
 *   - prefix          节点名前缀, 默认空
 *   - separator       入口/出口名分隔符, 默认 |
 *   - append          节点操作模式下是否追加到原节点, 默认 true
 *
 * 缓存/测活参数:
 *   - cache           是否启用缓存, 默认 true
 *   - cache_ttl       缓存时长(毫秒), 默认 43200000 (12 小时)
 *                     ⚠ 同时把 Sub-Store 里该订阅的「缓存」设为 12 小时(43200 秒),
 *                       否则前端缓存可能与脚本缓存不一致
 *   - keep_failed     保留落地测活失败的节点(名字用「未知」占位), 默认 false 丢弃
 *   - geo_provider    归属地接口, 默认 speedtest (api-v3.speedtest.cn, 中文省份/运营商)
 *                     可选 ipapi (ip-api.com, 英文 isp 自动映射)
 *   - lookup_url      测落地 IP 的接口, 默认 ip-api.com/json?fields=status,message,query
 *                     (需返回 query 字段 = 调用方看到的出口 IP)
 *   - concurrency     落地/归属查询并发数, 默认 10
 *   - timeout         单次 HTTP 超时(毫秒), 默认 5000
 *   - retries         单次 HTTP 重试次数, 默认 1
 *   - retry_delay     重试延时(毫秒), 默认 1000
 *   - include_unsupported_proxy  传给核心时包含官方/商店版不支持的协议, 默认不包含
 *   - debug           调试日志
 */

async function operator(proxies = [], targetPlatform, env) {
  const $ = $substore
  const args = $arguments || {}
  const cache = typeof scriptResourceCache !== 'undefined' ? scriptResourceCache : null

  const arg = (key, fallback) =>
    args[key] === undefined || args[key] === '' ? fallback : args[key]

  const DOMAIN = decodeURIComponent(arg('domain', 'cloudnproxy.baidu.com'))
  const DNS_SERVER = decodeURIComponent(arg('dns_server', 'https://223.5.5.5/resolve'))
  const HOST = decodeURIComponent(arg('host', '153.3.236.22:443'))
  const AUTH = decodeURIComponent(arg('auth', '683556433'))
  const UA = decodeURIComponent(
    arg('ua', 'okhttp/3.11.0 Dalvik/2.1.0 (Linux; Build/RKQ1.200826.002) baiduboxapp/11.0.5.12 (Baidu; P1 11)')
  )
  const MENG = decodeURIComponent(arg('meng', 'dm.toutiao.com'))
  const PORT = parseInt(arg('port', 443), 10)
  const PREFIX = decodeURIComponent(arg('prefix', ''))
  const SEPARATOR = decodeURIComponent(arg('separator', '|'))
  const APPEND = String(arg('append', true)) !== 'false'
  const CACHE = String(arg('cache', true)) !== 'false'
  const CACHE_TTL = parseFloat(arg('cache_ttl', 12 * 3600 * 1000))
  const KEEP_FAILED = String(arg('keep_failed', false)) === 'true' || arg('keep_failed') === true
  const GEO_PROVIDER = arg('geo_provider', 'speedtest')
  const LOOKUP_URL = decodeURIComponent(
    arg('lookup_url', 'http://ip-api.com/json?lang=zh-CN&fields=status,message,query')
  )
  const CONCURRENCY = parseInt(arg('concurrency', 10), 10)
  const TIMEOUT = parseFloat(arg('timeout', 5000))
  const RETRIES = parseFloat(arg('retries', 1))
  const RETRY_DELAY = parseFloat(arg('retry_delay', 1000))
  const INCLUDE_UNSUPPORTED = arg('include_unsupported_proxy', false)
  const DEBUG = String(arg('debug', false)) === 'true' || arg('debug') === true

  const http_meta_protocol = arg('http_meta_protocol', 'http')
  const http_meta_host = arg('http_meta_host', '127.0.0.1')
  const http_meta_port = arg('http_meta_port', 9876)
  const http_meta_authorization = arg('http_meta_authorization', '')
  const http_meta_api = `${http_meta_protocol}://${http_meta_host}:${http_meta_port}`
  const http_meta_start_delay = parseFloat(arg('http_meta_start_delay', 3000))
  const http_meta_ready_timeout = parseFloat(arg('http_meta_ready_timeout', 30000))
  const http_meta_proxy_timeout = parseFloat(arg('http_meta_proxy_timeout', 10000))

  const log = (...a) => $.info('[cloudnproxy] ' + a.join(' '))
  const dlog = (...a) => DEBUG && $.info('[cloudnproxy][debug] ' + a.join(' '))

  // ---------------------------------------------------------------- HTTP
  // $.http.get 本身不缓存; 12h 缓存完全由 scriptResourceCache 控制。
  async function http(opt = {}) {
    const METHOD = opt.method || 'get'
    const T = parseFloat(opt.timeout ?? TIMEOUT)
    const R = parseFloat(opt.retries ?? RETRIES)
    const RD = parseFloat(opt.retry_delay ?? RETRY_DELAY)
    let count = 0
    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: T })
      } catch (e) {
        if (count < R) {
          count++
          await $.wait(RD * count)
          return fn()
        }
        throw e
      }
    }
    return fn()
  }

  function parseJson(body) {
    if (body && typeof body === 'object') return body
    try {
      return JSON.parse(body)
    } catch (e) {
      throw new Error('JSON 解析失败: ' + String(body).slice(0, 120))
    }
  }

  function cacheGet(key) {
    if (!CACHE || !cache) return undefined
    try {
      return cache.get(key)
    } catch (e) {
      dlog('cache.get', e.message ?? e)
      return undefined
    }
  }

  function cacheSet(key, value, ttl) {
    if (!CACHE || !cache) return
    try {
      // 写入 { _v, _e }: self-enforced 过期, 保证恰好 12h, 不受用户
      // scriptCacheTtl 设置影响; 第三参数 ttl 作为新版后端的兜底清理时间。
      cache.set(key, { _v: value, _e: Date.now() + ttl }, ttl)
    } catch (e) {
      dlog('cache.set', e.message ?? e)
    }
  }

  function unwrap(entry) {
    if (entry && typeof entry === 'object' && '_v' in entry) {
      return entry._e && Date.now() > entry._e ? undefined : entry._v
    }
    return entry
  }

  // ------------------------------------------------------------ DNS 解析
  async function resolveDomain(domain) {
    const key = `cloudnproxy:dns:${DNS_SERVER}:${domain}`
    const cached = unwrap(cacheGet(key))
    if (Array.isArray(cached) && cached.length) {
      log(`DNS 使用缓存: ${cached.length} 个 IP`)
      return cached
    }
    const sep = DNS_SERVER.includes('?') ? '&' : '?'
    const url = `${DNS_SERVER}${sep}name=${encodeURIComponent(domain)}&type=A&short=1`
    dlog('DoH', url)
    const res = await http({ url })
    const data = parseJson(res.body)
    let ips = []
    if (Array.isArray(data)) {
      ips = data
    } else if (Array.isArray(data.Answer)) {
      ips = data.Answer.filter(a => a.type === 1 || a.type === 'A').map(a => a.data)
    }
    ips = [...new Set(ips.filter(ip => isIPv4(ip)))]
    if (!ips.length) throw new Error(`DoH 未解析到 A 记录: ${url}`)
    cacheSet(key, ips, CACHE_TTL)
    log(`DoH 解析 ${domain} -> ${ips.length} 个 IP`)
    return ips
  }

  function isIPv4(s) {
    return typeof s === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(s) &&
      s.split('.').every(n => Number(n) >= 0 && Number(n) <= 255)
  }

  // ------------------------------------------------------- IP 归属地查询
  function normalizeProvince(p) {
    if (!p) return ''
    return String(p)
      .replace(/省|市|自治区|壮族|回族|维吾尔|特别行政区/g, '')
      .replace(/北京市?|上海市?|天津市?|重庆市?/, m => m.slice(0, 2))
      .trim()
  }

  function normalizeIsp(s) {
    if (!s) return ''
    const t = String(s)
    if (/移动|Mobile|CMCC/i.test(t)) return '移动'
    if (/联通|Unicom/i.test(t)) return '联通'
    if (/电信|Telecom|Chinanet/i.test(t)) return '电信'
    if (/广电/i.test(t)) return '广电'
    if (/教育网|CERNET/i.test(t)) return '教育网'
    return t.replace(/中国/g, '').slice(0, 6) || '未知'
  }

  async function geoFromSpeedtest(ip) {
    const res = await http({ url: `https://api-v3.speedtest.cn/ip?ip=${ip}` })
    const d = parseJson(res.body)
    if (d.code !== 0 || !d.data) throw new Error('speedtest: ' + (d.msg || 'no data'))
    return {
      province: normalizeProvince(d.data.province || d.data.city),
      isp: normalizeIsp(d.data.isp || d.data.operator),
    }
  }

  async function geoFromIpApi(ip) {
    const res = await http({
      url: `http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,message,country,regionName,city,isp`,
    })
    const d = parseJson(res.body)
    if (d.status !== 'success') throw new Error('ip-api: ' + (d.message || 'fail'))
    return {
      province: normalizeProvince(d.regionName || d.city),
      isp: normalizeIsp(d.isp),
    }
  }

  async function queryGeo(ip) {
    const key = `cloudnproxy:geo:${GEO_PROVIDER}:${ip}`
    const cached = unwrap(cacheGet(key))
    if (cached) {
      dlog(`${ip} 归属地使用缓存`, JSON.stringify(cached))
      return cached
    }
    let info
    try {
      info = GEO_PROVIDER === 'ipapi' ? await geoFromIpApi(ip) : await geoFromSpeedtest(ip)
    } catch (e) {
      dlog(`${ip} 主接口失败(${e.message}), 尝试兜底`)
      try {
        info = await (GEO_PROVIDER === 'ipapi' ? geoFromSpeedtest(ip) : geoFromIpApi(ip))
      } catch (e2) {
        log(`${ip} 归属地查询失败, 使用「未知」命名: ${e2.message}`)
        info = { province: '', isp: '' }
      }
    }
    if (!info.province && !info.isp) return info // 查询失败不写缓存, 下次重试
    cacheSet(key, info, CACHE_TTL)
    return info
  }

  // ------------------------------------------------------------ 并发执行
  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise(resolve => {
      let running = 0
      let index = 0
      function next() {
        while (index < tasks.length && running < concurrency) {
          const task = tasks[index++]
          running++
          task().catch(() => {}).finally(() => { running--; next() })
        }
        if (running === 0) resolve()
      }
      next()
    })
  }

  // -------------------------------------------------- HTTP-META 核心生命周期
  // 等 mihomo 真正绑定监听端口, 避免 /start 返回后核心尚未就绪导致 ECONNREFUSED
  async function waitForCoreReady(host, port, timeoutMs) {
    const net = typeof require === 'function' ? require('net') : null
    if (!net) {
      await $.wait(timeoutMs)
      return
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await canConnect(net, host, port, 2000)) {
        log(`核心就绪: ${host}:${port}`)
        return
      }
      await $.wait(500)
    }
    throw new Error(`核心就绪等待超时 ${timeoutMs}ms, 端口 ${host}:${port} 仍不可连接`)
  }

  function canConnect(net, host, port, timeoutMs) {
    return new Promise(resolve => {
      let socket, settled = false
      const finish = ok => {
        if (settled) return
        settled = true
        try { socket && socket.destroy() } catch (e) {}
        resolve(ok)
      }
      try {
        socket = net.connect({ host, port })
        socket.setTimeout(timeoutMs)
        socket.once('connect', () => finish(true))
        socket.once('timeout', () => finish(false))
        socket.once('error', () => finish(false))
      } catch (e) {
        finish(false)
      }
    })
  }

  // ------------------------------------------------------------ 节点构造
  function buildNode(ip, label) {
    const node = {
      name: `${PREFIX}${label}`,
      server: ip,
      port: PORT,
      type: 'http',
      udp: false,
      headers: {
        Host: HOST,
        'User-Agent': UA,
        'X-T5-Auth': AUTH,
        Meng: MENG,
      },
    }
    return node
  }

  function label(info) {
    return info.province && info.isp
      ? `${info.province}${info.isp}`
      : info.province || info.isp || '未知'
  }

  // --------------------------------------------------------------- main
  const entryIps = await resolveDomain(DOMAIN)

  // 1) 入口归属地 (入口 IP 自身的省份+运营商)
  const entryGeoMap = new Map()
  await executeAsyncTasks(
    entryIps.map(ip => async () => { entryGeoMap.set(ip, await queryGeo(ip)) }),
    { concurrency: CONCURRENCY }
  )

  // 2) 构造节点, 交给 HTTP-META 核心 (转成 mihomo 内部格式, 保留 headers)
  const internalProxies = []
  entryIps.forEach((ip, index) => {
    try {
      const node = buildNode(ip, `cloudnproxy-${index}`)
      // 剥离交叉引用字段, 避免悬空引用导致 mihomo 解析配置 fatal
      const cleaned = { ...node }
      delete cleaned['dialer-proxy']
      delete cleaned['underlying-proxy']
      const internal = ProxyUtils.produce([cleaned], 'ClashMeta', 'internal', {
        'include-unsupported-proxy': INCLUDE_UNSUPPORTED,
      })?.[0]
      if (internal) {
        internalProxies.push({ ...internal, _entry_ip: ip, _proxies_index: index })
      }
    } catch (e) {
      $.error(`[${ip}] produce 失败: ${e.message ?? e}`)
    }
  })

  if (!internalProxies.length) {
    throw new Error('没有可供 HTTP-META 核心使用的节点')
  }

  // 3) 启动核心
  const http_meta_timeout = http_meta_start_delay + internalProxies.length * http_meta_proxy_timeout
  const startRes = await http({
    retries: 0,
    method: 'post',
    url: `${http_meta_api}/start`,
    headers: {
      'Content-type': 'application/json',
      Authorization: http_meta_authorization,
    },
    body: JSON.stringify({ proxies: internalProxies, timeout: http_meta_timeout }),
  })
  let startBody = startRes.body
  try { startBody = JSON.parse(startBody) } catch (e) {}
  const { ports, pid } = startBody || {}
  if (!pid || !ports || !ports.length) {
    throw new Error(`======== HTTP-META 启动失败 ========\n${JSON.stringify(startBody)}`)
  }
  log(`\n======== HTTP-META 启动 ====\n[端口] ${ports}\n[PID] ${pid}`)
  log(`等待 ${http_meta_start_delay / 1000} 秒后开始测落地`)
  await $.wait(http_meta_start_delay)
  await waitForCoreReady(http_meta_host, ports[0], http_meta_ready_timeout)

  // 4) 逐节点经核心端口请求「查 IP」接口, 拿真实落地 IP
  const landingMap = new Map()
  await executeAsyncTasks(
    internalProxies.map((proxy, index) => async () => {
      const entryIp = proxy._entry_ip
      const cacheKey = `cloudnproxy:landing:${HOST}:${AUTH}:${entryIp}`
      const cached = unwrap(cacheGet(cacheKey))
      if (cached && cached.query) {
        landingMap.set(entryIp, cached)
        dlog(`${entryIp} 落地使用缓存 ${cached.query}`)
        return
      }
      try {
        const res = await http({
          proxy: `http://${http_meta_host}:${ports[index]}`,
          url: LOOKUP_URL,
          headers: { 'User-Agent': UA },
        })
        const d = parseJson(res.body)
        const query = d.query || d.ip || (d.data && d.data.ip)
        if (d.status === 'success' && query && isIPv4(String(query))) {
          const landing = { query: String(query) }
          landingMap.set(entryIp, landing)
          cacheSet(cacheKey, landing, CACHE_TTL)
          log(`[${entryIp}] 落地 IP ${landing.query}`)
        } else {
          log(`[${entryIp}] 落地查询无效: ${JSON.stringify(d).slice(0, 160)}`)
        }
      } catch (e) {
        log(`[${entryIp}] 落地测活失败: ${e.message ?? e}`)
      }
    }),
    { concurrency: CONCURRENCY }
  )

  // 5) 关闭核心 (无论成功失败都要关)
  try {
    await http({
      method: 'post',
      url: `${http_meta_api}/stop`,
      headers: {
        'Content-type': 'application/json',
        Authorization: http_meta_authorization,
      },
      body: JSON.stringify({ pid: [pid] }),
    })
    log('======== HTTP-META 关闭 ====')
  } catch (e) {
    $.error('HTTP-META 关闭失败: ' + (e.message ?? e))
  }

  // 6) 落地 IP 归属地查询
  const exitGeoMap = new Map()
  await executeAsyncTasks(
    [...new Set([...landingMap.values()].map(v => v.query))].map(ip => async () => {
      exitGeoMap.set(ip, await queryGeo(ip))
    }),
    { concurrency: CONCURRENCY }
  )

  // 7) 组装: 丢弃测不到落地的节点 (keep_failed=true 时保留, 出口名「未知」)
  const survivors = entryIps.filter(ip => landingMap.has(ip) || KEEP_FAILED)
  // 同名(同入口名+同出口名)节点加序号: 广东移动|江苏电信 01 / 02
  const baseCounts = new Map()
  const seq = new Map()
  for (const ip of survivors) {
    const landing = landingMap.get(ip)
    const exitName = landing ? label(exitGeoMap.get(landing.query) || {}) : '未知'
    const base = `${label(entryGeoMap.get(ip) || {})}${SEPARATOR}${exitName}`
    baseCounts.set(base, (baseCounts.get(base) || 0) + 1)
  }

  const generated = survivors.map(ip => {
    const landing = landingMap.get(ip)
    const exitName = landing ? label(exitGeoMap.get(landing.query) || {}) : '未知'
    const base = `${label(entryGeoMap.get(ip) || {})}${SEPARATOR}${exitName}`
    let name = base
    if (baseCounts.get(base) > 1) {
      const n = (seq.get(base) || 0) + 1
      seq.set(base, n)
      name = `${base} ${String(n).padStart(2, '0')}`
    }
    const node = buildNode(ip, name)
    dlog(`${ip} -> ${node.name}${landing ? ' (落地 ' + landing.query + ')' : ' (未测到落地)'}`)
    return node
  })

  log(`测活通过 ${generated.length}/${entryIps.length} 个节点 (落地 IP 各不相同)`)
  if (APPEND) return [...proxies, ...generated]
  return generated
}
