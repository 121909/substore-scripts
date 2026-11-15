/**
 * 百度 cloudnproxy 节点生成脚本 (Sub-Store Node.js 版)
 *
 * 作用:
 *   解析 cloudnproxy.baidu.com 的全部 A 记录 (DoH), 每个入口 IP 生成一个 http 节点;
 *   按「入口省份+运营商|出口省份+运营商」命名 (如 广东移动|江苏联通)。
 *   节点模板、请求头完全按百度 T5 直连模板填写:
 *     server                入口 IP (DNS A 记录)
 *     port                  443
 *     type                  http
 *     udp                   false
 *     headers.Host          出口 IP:443 (默认 153.3.236.22:443)
 *     headers.X-T5-Auth     鉴权值 (默认 683556433)
 *     headers.User-Agent    baiduboxapp UA
 *     headers.Meng          dm.toutiao.com
 *
 * 用法:
 *   1. 脚本订阅: Sub-Store -> 订阅 -> + -> 类型「脚本」/ 本地脚本内容粘贴本文件
 *      (脚本订阅下 operator 收到的 proxies 为空, 返回即生成的节点)
 *   2. 节点操作: 在任意订阅 -> 节点操作 -> 脚本操作 粘贴本文件 URL,
 *      会把生成的节点追加到原订阅节点之后 (传 append=false 可改为替换)
 *   脚本链接参数以 # 开头, 多个用 & 连接:
 *     #host=153.3.236.22:443&auth=683556433&cache_ttl=43200000
 *
 * 关于「我使用的 substore 自带 httpmeta」:
 *   本脚本只做「节点生成 + 归属信息查询」, 不测活、不启动 HTTP-META 核心,
 *   因此不需要任何 httpmeta 参数即可运行。按仓库惯例仍保留下面全套参数,
 *   方便在同一条流水线里与其它 httpmeta 脚本 (如可用性筛选) 共用同一套配置:
 *     - http_meta_protocol      协议, 默认 http
 *     - http_meta_host          服务地址, 默认 127.0.0.1
 *     - http_meta_port          端口, 默认 9876
 *     - http_meta_authorization Authorization, 默认无
 *     - http_meta_start_delay   初始启动延时(毫秒), 默认 3000
 *     - http_meta_ready_timeout 核心就绪等待超时(毫秒), 默认 30000
 *     - http_meta_proxy_timeout 每个节点耗时(毫秒), 默认 10000
 *
 * 参数 (均为可选):
 *   - domain          解析的域名, 默认 cloudnproxy.baidu.com
 *   - dns_server      DoH JSON 接口, 默认 https://223.5.5.5/resolve
 *                     (也支持 dns.alidns.com / dns.google 等返回 {Answer:[...]} 的接口)
 *   - host            出口地址 IP:端口, 默认 153.3.236.22:443
 *   - auth            X-T5-Auth, 默认 683556433
 *   - ua              User-Agent, 默认模板里的 baiduboxapp UA
 *   - meng            Meng 头, 默认 dm.toutiao.com
 *   - port            节点端口, 默认 443
 *   - prefix          节点名前缀, 默认空
 *   - separator       入口/出口名分隔符, 默认 |
 *   - append          节点操作模式下是否追加到原节点, 默认 true
 *   - cache           是否启用缓存, 默认 true
 *   - cache_ttl       缓存时长(毫秒), 默认 43200000 (12 小时)
 *                     ⚠ 同时把 Sub-Store 里该订阅的「缓存」设为 12 小时(43200 秒),
 *                       否则前端缓存可能与脚本缓存不一致
 *   - geo_provider    归属地接口, 默认 speedtest (api-v3.speedtest.cn, 中文省份/运营商)
 *                     可选 ipapi (ip-api.com 兜底, 英文 isp 自动映射)
 *   - concurrency     归属地查询并发数, 默认 5
 *   - timeout         单次 HTTP 超时(毫秒), 默认 5000
 *   - retries         单次 HTTP 重试次数, 默认 1
 *   - retry_delay     重试延时(毫秒), 默认 1000
 *   - debug           调试日志
 */

async function operator(proxies = [], targetPlatform, env) {
  const $ = $substore
  const args = $arguments || {}
  const cache = typeof scriptResourceCache !== 'undefined' ? scriptResourceCache : null

  const arg = (key, fallback) =>
    args[key] === undefined || args[key] === '' ? fallback : args[key]

  const DOMAIN = decodeURIComponent(arg('domain', 'cloudnproxy.baidu.com'))
  const DNS_SERVER = decodeURIComponent(
    arg('dns_server', 'https://223.5.5.5/resolve')
  )
  const HOST = decodeURIComponent(arg('host', '153.3.236.22:443'))
  const AUTH = decodeURIComponent(arg('auth', '683556433'))
  const UA = decodeURIComponent(
    arg(
      'ua',
      'okhttp/3.11.0 Dalvik/2.1.0 (Linux; Build/RKQ1.200826.002) baiduboxapp/11.0.5.12 (Baidu; P1 11)'
    )
  )
  const MENG = decodeURIComponent(arg('meng', 'dm.toutiao.com'))
  const PORT = parseInt(arg('port', 443), 10)
  const PREFIX = decodeURIComponent(arg('prefix', ''))
  const SEPARATOR = decodeURIComponent(arg('separator', '|'))
  const APPEND = String(arg('append', true)) !== 'false'
  const CACHE = String(arg('cache', true)) !== 'false'
  const CACHE_TTL = parseFloat(arg('cache_ttl', 12 * 3600 * 1000))
  const GEO_PROVIDER = arg('geo_provider', 'speedtest')
  const CONCURRENCY = parseInt(arg('concurrency', 5), 10)
  const TIMEOUT = parseFloat(arg('timeout', 5000))
  const RETRIES = parseFloat(arg('retries', 1))
  const RETRY_DELAY = parseFloat(arg('retry_delay', 1000))
  const DEBUG = String(arg('debug', false)) === 'true' || arg('debug') === true

  // httpmeta 参数: 本脚本不启动核心, 仅为与同仓库其它 httpmeta 脚本共用配置而声明
  const http_meta_protocol = arg('http_meta_protocol', 'http')
  const http_meta_host = arg('http_meta_host', '127.0.0.1')
  const http_meta_port = arg('http_meta_port', 9876)
  const http_meta_authorization = arg('http_meta_authorization', '')
  const http_meta_start_delay = parseFloat(arg('http_meta_start_delay', 3000))
  const http_meta_ready_timeout = parseFloat(arg('http_meta_ready_timeout', 30000))
  const http_meta_proxy_timeout = parseFloat(arg('http_meta_proxy_timeout', 10000))

  const log = (...a) => $.info('[cloudnproxy] ' + a.join(' '))
  const dlog = (...a) => DEBUG && $.info('[cloudnproxy][debug] ' + a.join(' '))
  dlog('httpmeta:', http_meta_protocol, http_meta_host, http_meta_port,
    'delay', http_meta_start_delay, 'ready', http_meta_ready_timeout,
    'proxyTimeout', http_meta_proxy_timeout,
    'authorization', http_meta_authorization ? 'set' : 'none')

  // ---------------------------------------------------------------- HTTP
  // $.http.get 本身不缓存; 12h 缓存完全由下面的 scriptResourceCache 控制。
  // 注意: Sub-Store 对「订阅/文件来源」还有一层 1 小时的远程缓存, 与脚本内请求无关。
  //       若要整体按 12h 更新, 把该订阅的缓存(前端)也设为 43200 秒即可。
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
  // 兼容两类返回:
  //   short=1 -> ["1.2.3.4", ...]
  //   完整 JSON -> { Answer: [{ type: 1, data: "1.2.3.4" }, ...] }
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
  // 返回 { province, isp }  例如 { province: '江苏', isp: '联通' }
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
    if (/广电|广电网络/i.test(t)) return '广电'
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
        log(`${ip} 归属地查询失败, 使用 IP 兜底命名: ${e2.message}`)
        info = { province: '', isp: '' }
      }
    }
    if (!info.province && !info.isp) {
      // 查询失败不写缓存, 下次执行重试
      return info
    }
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
          task()
            .catch(() => {})
            .finally(() => {
              running--
              next()
            })
        }
        if (running === 0) resolve()
      }
      next()
    })
  }

  // ------------------------------------------------------------ 节点构造
  function buildNode(ip, label) {
    return {
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
  }

  function entryLabel(info) {
    return info.province && info.isp
      ? `${info.province}${info.isp}`
      : info.province || info.isp || '未知'
  }

  // --------------------------------------------------------------- main
  const entryIps = await resolveDomain(DOMAIN)

  // 出口 IP 取 Host 头的 host 部分; 若不是 IP(域名)则跳过出口查询, 用「出口」占位
  const hostOnly = HOST.replace(/:\d+$/, '')
  const exitIp = isIPv4(hostOnly) ? hostOnly : null
  let exitLabel = '出口'
  if (exitIp) {
    const exitInfo = await queryGeo(exitIp)
    exitLabel = entryLabel(exitInfo)
  }

  const geoMap = new Map()
  await executeAsyncTasks(
    entryIps.map(ip => async () => {
      geoMap.set(ip, await queryGeo(ip))
    }),
    { concurrency: CONCURRENCY }
  )

  // 同名(同省同运营商)节点加序号: 广东电信 01 / 广东电信 02
  const baseCounts = new Map()
  const seq = new Map()
  for (const ip of entryIps) {
    const base = entryLabel(geoMap.get(ip) || {})
    baseCounts.set(base, (baseCounts.get(base) || 0) + 1)
  }

  const generated = entryIps.map(ip => {
    const info = geoMap.get(ip) || {}
    const base = entryLabel(info)
    let name
    if (baseCounts.get(base) > 1) {
      const n = (seq.get(base) || 0) + 1
      seq.set(base, n)
      name = `${base} ${String(n).padStart(2, '0')}`
    } else {
      name = base
    }
    const node = buildNode(ip, `${name}${SEPARATOR}${exitLabel}`)
    dlog(`${ip} -> ${node.name}`)
    return node
  })

  log(`生成 ${generated.length} 个节点, 出口 ${HOST} -> ${exitLabel}`)
  if (APPEND) return [...proxies, ...generated]
  return generated
}
