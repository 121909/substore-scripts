/**
 * Sub-Store 节点连通性筛选脚本 (Node.js 后端 / HTTP-META 版)
 *
 * 作用: 逐个真实发起连接测试, 只保留可以连通的节点, 其余丢弃。
 * 缓存: 每个节点的测试结果缓存 24 小时, 24 小时内再次执行直接复用, 不重复测试。
 *
 * 环境: 已内置/部署 HTTP-META 的 Sub-Store 后端
 *   - Docker: 使用 xream/sub-store 的 http-meta tag 镜像 (本地且端口 9876 时无需额外设置)
 *   - Android 模块版: 已内置 HTTP-META
 * 参考官方节点测活脚本: https://t.me/zhetengsha/1210
 *
 * 用法:
 *   节点操作 -> 脚本操作 -> 链接(或粘贴脚本内容)
 *
 * HTTP-META 参数:
 *   - http_meta_protocol      协议, 默认 http
 *   - http_meta_host          服务地址, 默认 127.0.0.1
 *   - http_meta_port          端口, 默认 9876
 *   - http_meta_authorization Authorization, 默认无
 *   - http_meta_start_delay   初始启动延时(毫秒), 默认 3000
 *   - http_meta_ready_timeout 核心就绪等待超时(毫秒), 默认 30000
 *       启动后探测核心端口是否真正可连, 避免 /start 返回时核心尚未绑定导致 ECONNREFUSED
 *   - http_meta_proxy_timeout 每个节点耗时(毫秒), 默认 10000
 *       总超时 = start_delay + 节点数 * proxy_timeout, 用于防止脚本异常退出时核心过早退出
 *
 * 检测参数(均为可选):
 *   - timeout        请求超时(毫秒), 默认 5000
 *   - retries        重试次数, 默认 1
 *   - retry_delay    重试延时(毫秒), 默认 1000
 *   - concurrency    并发数, 默认 10
 *   - url            检测地址, 默认 http://connectivitycheck.platform.hicloud.com/generate_204
 *                    URL query 传参需 encodeURIComponent, 前端可视化参数编辑则不需要
 *   - status         合法状态码正则, 默认 204 (URL 传参需 encodeURIComponent)
 *   - method         head / get, 默认 head (检测地址不支持 head 时改 get)
 *   - show_latency   节点名前显示延迟, 默认不显示 (不开启也会写入 _latency 字段)
 *   - keep_incompatible  保留当前客户端不兼容的协议, 默认不保留
 *   - include_unsupported_proxy  包含官方/商店版不支持的协议, 默认不包含
 *   - cache          是否启用缓存, 默认 true (传 cache=false 关闭)
 *   - cache_ttl      缓存时长(毫秒), 默认 86400000 (24 小时)
 *   - disable_failed_cache  不缓存失败结果, 失败节点每次重新测试, 默认关闭
 */

async function operator(proxies = [], targetPlatform, env) {
  const $ = $substore
  const cache = scriptResourceCache
  // 缓存默认开启; 传 cache=false 关闭
  const cacheEnabled = !($arguments.cache === 'false' || $arguments.cache === false)
  // 缓存时长(毫秒), 默认 24 小时
  const cacheTTL = parseFloat($arguments.cache_ttl || 24 * 3600 * 1000)
  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error

  const http_meta_host = $arguments.http_meta_host ?? '127.0.0.1'
  const http_meta_port = $arguments.http_meta_port ?? 9876
  const http_meta_protocol = $arguments.http_meta_protocol ?? 'http'
  const http_meta_authorization = $arguments.http_meta_authorization ?? ''
  const http_meta_api = `${http_meta_protocol}://${http_meta_host}:${http_meta_port}`

  const http_meta_start_delay = parseFloat($arguments.http_meta_start_delay ?? 3000)
  const http_meta_proxy_timeout = parseFloat($arguments.http_meta_proxy_timeout ?? 10000)

  const method = $arguments.method || 'head'
  const keepIncompatible = $arguments.keep_incompatible
  const includeUnsupportedProxy = $arguments.include_unsupported_proxy
  const validStatus = new RegExp($arguments.status || '204')
  const url = decodeURIComponent($arguments.url || 'http://connectivitycheck.platform.hicloud.com/generate_204')
  const ua = decodeURIComponent(
    $arguments.ua ||
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1'
  )

  const validProxies = []
  const incompatibleProxies = []
  const internalProxies = []

  // 转成 mihomo 内部格式, 供 HTTP-META 核心启动
  proxies.map((proxy, index) => {
    try {
      // 剥离交叉引用字段: HTTP-META 会把节点重命名为 proxy-N, 但不会重映射
      // dialer-proxy / underlying-proxy 指向的 outbound, 引用悬空会导致 mihomo
      // 解析配置 fatal 退出(端口永不绑定, 表现为 ECONNREFUSED).
      // 连通性测试无需这些拨号跳板, 直接测节点自身连通性.
      const cleanedProxy = { ...proxy }
      delete cleanedProxy['dialer-proxy']
      delete cleanedProxy['underlying-proxy']
      const node = ProxyUtils.produce([cleanedProxy], 'ClashMeta', 'internal', {
        'include-unsupported-proxy': includeUnsupportedProxy,
      })?.[0]
      if (node) {
        for (const key in proxy) {
          if (/^_/i.test(key)) {
            node[key] = proxy[key]
          }
        }
        internalProxies.push({ ...node, _proxies_index: index })
      } else if (keepIncompatible) {
        incompatibleProxies.push(proxy)
      }
    } catch (e) {
      $.error(e)
    }
  })

  $.info(`核心支持节点数: ${internalProxies.length}/${proxies.length}`)
  if (!internalProxies.length) return proxies

  const http_meta_timeout = http_meta_start_delay + internalProxies.length * http_meta_proxy_timeout

  let http_meta_pid
  let http_meta_ports = []

  // 启动 HTTP-META 核心
  const res = await http({
    retries: 0,
    method: 'post',
    url: `${http_meta_api}/start`,
    headers: {
      'Content-type': 'application/json',
      Authorization: http_meta_authorization,
    },
    body: JSON.stringify({ proxies: internalProxies, timeout: http_meta_timeout }),
  })
  let body = res.body
  try {
    body = JSON.parse(body)
  } catch (e) {}
  const { ports, pid } = body
  if (!pid || !ports) {
    throw new Error(`======== HTTP-META 启动失败 ====\n${body}`)
  }
  http_meta_pid = pid
  http_meta_ports = ports
  $.info(`\n======== HTTP-META 启动 ====\n[端口] ${ports}\n[PID] ${pid}\n`)
  $.info(`等待 ${http_meta_start_delay / 1000} 秒后开始检测`)
  await $.wait(http_meta_start_delay)

  // 等待 mihomo 核心真正绑定监听端口, 防止 /start 返回后核心尚未就绪导致 ECONNREFUSED
  const http_meta_ready_timeout = parseFloat($arguments.http_meta_ready_timeout ?? 30000)
  await waitForCoreReady(http_meta_host, http_meta_ports[0], http_meta_ready_timeout)

  const concurrency = parseInt($arguments.concurrency || 10)
  await executeAsyncTasks(internalProxies.map(proxy => () => check(proxy)), { concurrency })

  // 关闭 HTTP-META 核心
  try {
    await http({
      method: 'post',
      url: `${http_meta_api}/stop`,
      headers: {
        'Content-type': 'application/json',
        Authorization: http_meta_authorization,
      },
      body: JSON.stringify({ pid: [http_meta_pid] }),
    })
    $.info(`\n======== HTTP-META 关闭 ====\n`)
  } catch (e) {
    $.error(e)
  }

  $.info(`[连通性筛选] 有效 ${validProxies.length}/${proxies.length}`)
  return keepIncompatible ? [...validProxies, ...incompatibleProxies] : validProxies

  async function check(proxy) {
    // 缓存 key: 只取与连接参数相关的字段, 忽略名称/ID/下划线字段, 避免改名导致缓存失效
    const id = cacheEnabled
      ? `http-meta:availability:${url}:${method}:${validStatus}:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
          )
        )}`
      : undefined

    try {
      if (cacheEnabled) {
        const cached = cache.get(id)
        if (cached) {
          if (cached.latency) {
            validProxies.push({
              ...ProxyUtils.parse(JSON.stringify(proxy))[0],
              name: `${$arguments.show_latency ? `[${cached.latency}] ` : ''}${proxy.name}`,
              _latency: cached.latency,
            })
            $.info(`[${proxy.name}] 使用成功缓存`)
            return
          } else if (!disableFailedCache) {
            $.info(`[${proxy.name}] 使用失败缓存`)
            return
          }
          $.info(`[${proxy.name}] 不使用失败缓存`)
        }
      }

      const index = internalProxies.indexOf(proxy)
      const startedAt = Date.now()
      const res = await http({
        proxy: `http://${http_meta_host}:${http_meta_ports[index]}`,
        method,
        headers: { 'User-Agent': ua },
        url,
      })
      const status = parseInt(res.status || res.statusCode || 200)
      const latency = `${Date.now() - startedAt}`
      $.info(`[${proxy.name}] status: ${status}, latency: ${latency}`)

      if (validStatus.test(status)) {
        validProxies.push({
          ...ProxyUtils.parse(JSON.stringify(proxy))[0],
          name: `${$arguments.show_latency ? `[${latency}] ` : ''}${proxy.name}`,
          _latency: latency,
        })
        if (cacheEnabled) {
          cache.set(id, { latency }, cacheTTL)
        }
      } else {
        if (cacheEnabled) {
          cache.set(id, {}, cacheTTL)
        }
      }
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`)
      if (cacheEnabled) {
        cache.set(id, {}, cacheTTL)
      }
    }
  }

  async function http(opt = {}) {
    const METHOD = opt.method || $arguments.method || 'get'
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000)
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1)
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000)

    let count = 0
    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        if (count < RETRIES) {
          count++
          const delay = RETRY_DELAY * count
          await $.wait(delay)
          return await fn()
        }
        throw e
      }
    }
    return await fn()
  }

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

  // 探测核心端口是否可连, 直到就绪或超时
  async function waitForCoreReady(host, port, timeoutMs) {
    const net = typeof require === 'function' ? require('net') : null
    if (!net) {
      // 无 net 模块时退化为固定延时
      await $.wait(timeoutMs)
      return
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await canConnect(net, host, port, 2000)) {
        $.info(`核心就绪: ${host}:${port}`)
        return
      }
      await $.wait(500)
    }
    $.error(`核心就绪等待超时 ${timeoutMs}ms, 端口 ${host}:${port} 仍不可连接`)
  }

  function canConnect(net, host, port, timeoutMs) {
    return new Promise(resolve => {
      let socket
      let settled = false
      const finish = ok => {
        if (settled) return
        settled = true
        try {
          socket && socket.destroy()
        } catch (e) {}
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
}
