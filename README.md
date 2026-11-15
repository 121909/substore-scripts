# substore-scripts

Sub-Store (Node.js 后端 / 自带 HTTP-META) 脚本集合。

## baidu-cloudnproxy.js

解析 `cloudnproxy.baidu.com` 的 DNS A 记录，每个入口 IP 生成一个百度 T5 直连 http 节点；**用自带 HTTP-META 实测每个节点的真实落地（出口）IP**，按「入口省份+运营商|出口省份+运营商」命名，丢弃测活失败的节点，缓存 12 小时。

### 为什么必须用 HTTP-META 测出口

`Host: 153.3.236.22:443` 是百度 T5 协议必需的鉴权头，**不是出口 IP**。它与 `X-T5-Auth` 是配对鉴权：只改 Host、只改 auth、或把 Host 填成入口 IP，上游都会返回 `ERR_ACCESS_DENIED`。真实出口 IP 只能通过节点发请求后由服务商看到的 IP 反查得到，而且不同入口 IP 会得到不同落地 IP：

| 入口 IP | 实测落地 IP | 落地归属 |
| --- | --- | --- |
| `183.240.98.84` | `14.215.185.54` | 广东电信 |
| `153.3.237.117` | `180.101.52.70` | 江苏电信 |
| `110.242.70.68` | `157.0.147.158` | 江苏联通 |
| `220.181.7.1` | `180.101.52.4` | 江苏电信 |

脚本启动 HTTP-META 的 mihomo 核心，逐节点经本地 proxy 端口请求 `ip-api.com/json?fields=...&query`，`query` 即该节点的落地 IP，再查它的省份+运营商。mihomo 的 http 出站会原样转发 `Host` / `X-T5-Auth` / `Meng` 自定义头（已用真实 mihomo 二进制端到端验证），所以测量请求能拿到真实落地。

实测「Host 写成和入口 IP 一样」是否可用（14 个入口 IP × 3 次重试，curl 直连 + 真实 mihomo 复核）：

| Host 写法 | 结果 |
| --- | --- |
| 模板值 `153.3.236.22:443` + `X-T5-Auth: 683556433` | 14/14 成功，HTTP 200 + 落地 IP |
| `入口IP:443` + `X-T5-Auth: 683556433` | 0/14 成功，HTTP 403 `ERR_ACCESS_DENIED`（mihomo 下为 502） |
| `入口IP` + `X-T5-Auth: 683556433` | 0/14 成功，HTTP 403 `ERR_ACCESS_DENIED` |
| 换成任意其它 IP（`8.8.8.8:443`）或只换 auth | HTTP 403 `ERR_ACCESS_DENIED` |
| 另一套已知配对 `ascdn.baidu.com` + `X-T5-Auth: 1951164069` | HTTP 200 + 落地 IP |

结论：**Host 不能写成入口 IP**，必须是与 `X-T5-Auth` 配对的鉴权值。脚本默认已用可用的配对，无需改动。

### 生成规则

- `server`：DoH 解析得到的入口 IP（实测 14 个）
- `port` / `type` / `udp`：`443` / `http` / `false`
- `headers`：按给定模板固定
  - `Host`：`153.3.236.22:443`（T5 鉴权头，非出口 IP；见上方配对说明，勿改成入口 IP）
  - `User-Agent`：模板里的 `baiduboxapp` UA
  - `X-T5-Auth`：`683556433`
  - `Meng`：`dm.toutiao.com`
- 名称：`入口省份+运营商|出口省份+运营商`，例如 `广东移动|江苏电信`；同名节点自动加 `01`/`02` 序号
- 入口归属地：`api-v3.speedtest.cn/ip`（中文省份+运营商），失败兜底 `ip-api.com`
- 出口归属地：对**实测落地 IP** 查同一个归属地接口
- 测活：落地测量失败/超时的节点默认丢弃（`keep_failed=true` 可保留，出口名用「未知」）

### 使用

脚本原始链接（固定版本）：

```
https://raw.githubusercontent.com/121909/substore-scripts/main/baidu-cloudnproxy.js
```

**前置条件**：Sub-Store 后端必须已内置/部署 HTTP-META（Docker `xream/sub-store` 的 http-meta 镜像、Android 模块版等）。本脚本必须启动 HTTP-META 核心，无核心会报错。本地且端口 `9876` 时无需额外配置。

**方式一 · 脚本订阅（推荐，只输出生成节点）**

Sub-Store → 订阅 → 新建 → 类型选「脚本」/ 粘贴本文件内容 → 保存、预览。此时 `operator` 收到的 `proxies` 为空，返回值即生成的节点。

**方式二 · 节点操作（追加到已有订阅）**

任意订阅 → 节点操作 → 脚本操作 → 粘贴上面的链接 → 生成的节点会追加到原节点之后（传 `append=false` 改为替换）。

**缓存 12h**

`scriptResourceCache` 默认按 12h（`cache_ttl=43200000`）缓存 DNS 结果、入口/落地归属地、以及每个入口的落地 IP。落地测量失败不写缓存，下次执行会重试。若希望整条订阅也按 12h 更新，把该订阅在前端的「缓存」设为 `43200` 秒（Sub-Store 对订阅来源另有一层默认 1 小时的远程缓存）。

### HTTP-META 生命周期

按本仓库历史脚本的惯例：`POST {http-meta}/start`（提交 `ProxyUtils.produce(..., 'ClashMeta', 'internal')` 节点）→ 等待核心就绪 → 逐节点 `$.http.get({ proxy: http://{host}:{port[i]}, url: 查IP接口 })` → `POST {http-meta}/stop`。`http_meta_proxy_timeout` 用于计算核心自动关闭总超时。

### 参数

链接参数以 `#` 开头，多个用 `&` 连接，例如：

```
https://raw.githubusercontent.com/121909/substore-scripts/main/baidu-cloudnproxy.js#host=153.3.236.22:443&auth=683556433&debug=true
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `domain` | `cloudnproxy.baidu.com` | 解析的域名 |
| `dns_server` | `https://223.5.5.5/resolve` | DoH JSON 接口（支持 `short=1` 数组或 `Answer` 结构） |
| `host` | `153.3.236.22:443` | `Host` 头（T5 鉴权，非出口 IP；须与 `auth` 配对，勿改成入口 IP） |
| `auth` | `683556433` | `X-T5-Auth` |
| `ua` | 模板 UA | `User-Agent` |
| `meng` | `dm.toutiao.com` | `Meng` 头 |
| `port` | `443` | 节点端口 |
| `prefix` | 空 | 节点名前缀 |
| `separator` | `\|` | 入口/出口名分隔符 |
| `append` | `true` | 节点操作模式是否追加到原节点 |
| `cache` | `true` | 是否启用缓存 |
| `cache_ttl` | `43200000` | 缓存时长（毫秒，12 小时） |
| `keep_failed` | `false` | 保留落地测活失败的节点（出口名用「未知」） |
| `geo_provider` | `speedtest` | 归属地接口，可选 `ipapi` |
| `lookup_url` | `http://ip-api.com/json?lang=zh-CN&fields=status,message,query` | 测落地 IP 的接口，需返回 `query`/`ip` 字段 |
| `concurrency` | `10` | 落地/归属查询并发数 |
| `timeout` | `5000` | 单次 HTTP 超时（毫秒） |
| `retries` | `1` | 单次 HTTP 重试次数 |
| `retry_delay` | `1000` | 重试延时（毫秒） |
| `include_unsupported_proxy` | `false` | 传给核心时包含官方/商店版不支持的协议 |
| `debug` | `false` | 调试日志 |

HTTP-META 相关：`http_meta_protocol` / `http_meta_host` / `http_meta_port` / `http_meta_authorization` / `http_meta_start_delay` / `http_meta_ready_timeout` / `http_meta_proxy_timeout`。本地 `9876` 端口一般无需改动。
