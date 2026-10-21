/**
 * Sub-Store 节点连通性筛选脚本
 *
 * 作用: 逐个真实发起连接测试, 只保留可以连通的节点, 其余丢弃。
 * 缓存: 每个节点的测试结果缓存 24 小时, 24 小时内再次执行直接复用, 不重复测试。
 *
 * 环境: Loon / Surge / Egern
 * 参考官方节点测活脚本: https://t.me/zhetengsha/1210
 *
 * 用法:
 *   节点操作 -> 脚本操作 -> 链接(或粘贴脚本内容)
 *   参数通过链接 # 后追加, 例如:
 *   .../availability.js#show_latency=true&timeout=3000
 *
 * 参数(均为可选):
 *   - timeout        请求超时(毫秒), 默认 5000
 *   - retries        重试次数, 默认 1
 *   - retry_delay    重试延时(毫秒), 默认 1000
 *   - concurrency    并发数, 默认 10
 *   - url            检测地址, 默认 https://www.apple.com/library/test/success.html
 *                    URL query 传参需 encodeURIComponent, 前端可视化参数编辑则不需要
 *   - status         合法状态码正则, 默认 200 (URL 传参需 encodeURIComponent)
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
  const { isLoon, isSurge, isEgern } = $.env
  if (!isLoon && !isSurge && !isEgern) {
    throw new Error('仅支持 Loon、Surge、Egern 环境; Node.js 后端请使用 http_meta_availability.js')
  }

  const cache = scriptResourceCache
  // 缓存默认开启; 传 cache=false 关闭
  const cacheEnabled = !($arguments.cache === 'false' || $arguments.cache === false)
  // 缓存时长(毫秒), 默认 24 小时
  const cacheTTL = parseFloat($arguments.cache_ttl || 24 * 3600 * 1000)
  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error

  const method = $arguments.method || 'head'
  const keepIncompatible = $arguments.keep_incompatible
  const includeUnsupportedProxy = $arguments.include_unsupported_proxy
  const validStatus = new RegExp($arguments.status || '200')
  const url = decodeURIComponent($arguments.url || 'https://www.apple.com/library/test/success.html')
  const ua = decodeURIComponent(
    $arguments.ua ||
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1'
  )

  const target = isLoon ? 'Loon' : isEgern ? 'Egern' : 'Surge'
  const validProxies = []
  const failedProxies = []

  if (!proxies.length) return proxies

  const concurrency = parseInt($arguments.concurrency || 10)
  await executeAsyncTasks(proxies.map(proxy => () => check(proxy)), { concurrency })

  $.info(`[连通性筛选] 有效 ${validProxies.length}/${proxies.length}, 失败 ${failedProxies.length}`)
  return validProxies

  async function check(proxy) {
    // 缓存 key: 只取与连接参数相关的字段, 忽略名称/ID/下划线字段, 避免改名导致缓存失效
    const id = cacheEnabled
      ? `availability:${url}:${method}:${validStatus}:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
          )
        )}`
      : undefined

    try {
      let node
      if (isEgern) {
        node = JSON.stringify(
          ProxyUtils.produce([proxy], target, 'internal', {
            'include-unsupported-proxy': includeUnsupportedProxy,
          })[0]
        )
      } else {
        node = ProxyUtils.produce([proxy], target, undefined, {
          'include-unsupported-proxy': includeUnsupportedProxy,
        })
      }

      if (node) {
        if (cacheEnabled) {
          const cached = cache.get(id)
          if (cached) {
            if (cached.latency) {
              validProxies.push({
                ...proxy,
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

        // 真实发起连接测试
        const startedAt = Date.now()
        const res = await http({
          method,
          headers: { 'User-Agent': ua },
          url,
          'policy-descriptor': node,
          node,
        })
        const status = parseInt(res.status || res.statusCode || 200)
        const latency = `${Date.now() - startedAt}`
        $.info(`[${proxy.name}] status: ${status}, latency: ${latency}`)

        if (validStatus.test(status)) {
          validProxies.push({
            ...proxy,
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
          failedProxies.push(proxy)
        }
      } else {
        // 当前客户端不兼容的协议
        if (keepIncompatible) {
          validProxies.push(proxy)
        }
      }
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`)
      if (cacheEnabled) {
        cache.set(id, {}, cacheTTL)
      }
      failedProxies.push(proxy)
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
}
