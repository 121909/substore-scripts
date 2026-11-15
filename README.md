# substore-scripts

Sub-Store (Node.js 后端 / 自带 HTTP-META) 脚本集合。

## baidu-cloudnproxy.js

解析 `cloudnproxy.baidu.com` 的 DNS A 记录，每个入口 IP 生成一个百度 T5 直连 http 节点，按「入口省份+运营商|出口省份+运营商」命名，缓存 12 小时。

### 生成规则

- `server`：DoH 解析得到的入口 IP（实测 14 个）
- `port` / `type` / `udp`：`443` / `http` / `false`
- `headers`：按给定模板固定
  - `Host`：`153.3.236.22:443`（出口 IP:端口，可改）
  - `User-Agent`：模板里的 `baiduboxapp` UA
  - `X-T5-Auth`：`683556433`
  - `Meng`：`dm.toutiao.com`
- 名称：`入口省份+运营商|出口省份+运营商`，例如 `广东移动|江苏联通`；同省同运营商的多个入口自动加 `01`/`02` 序号
- 归属地：`api-v3.speedtest.cn/ip`（中文省份+运营商），失败时兜底 `ip-api.com`；出口名同样按 `Host` 里的 IP 查询

### 使用

脚本原始链接（固定版本）：

```
https://raw.githubusercontent.com/121909/substore-scripts/main/baidu-cloudnproxy.js
```

**方式一 · 脚本订阅（推荐，只输出生成节点）**

Sub-Store → 订阅 → 新建 → 类型选「脚本」/ 粘贴本文件内容 → 保存、预览。此时 `operator` 收到的 `proxies` 为空，返回值即生成的节点。

**方式二 · 节点操作（追加到已有订阅）**

任意订阅 → 节点操作 → 脚本操作 → 粘贴上面的链接 → 生成的节点会追加到原节点之后（传 `append=false` 改为替换）。

**缓存 12h**

脚本内 `scriptResourceCache` 默认按 12h（`cache_ttl=43200000`）缓存 DNS 结果与 IP 归属地。若希望整条订阅也按 12h 更新，把该订阅在前端的「缓存」设为 `43200` 秒（Sub-Store 对订阅来源另有一层默认 1 小时的远程缓存）。

### 与自带 HTTP-META 的关系

本脚本只做节点生成与归属信息查询，**不测活、不启动 HTTP-META 核心**，因此无需任何 httpmeta 配置即可运行。仍按本仓库惯例保留了全套 `http_meta_*` 参数，方便与流水线里其它 httpmeta 脚本（如可用性筛选）共用同一套配置。若要做连通性筛选，可在本脚本后面再接一个 httpmeta 测活脚本。

### 参数

链接参数以 `#` 开头，多个用 `&` 连接，例如：

```
https://raw.githubusercontent.com/121909/substore-scripts/main/baidu-cloudnproxy.js#host=153.3.236.22:443&auth=683556433&debug=true
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `domain` | `cloudnproxy.baidu.com` | 解析的域名 |
| `dns_server` | `https://223.5.5.5/resolve` | DoH JSON 接口（支持 `short=1` 数组或 `Answer` 结构） |
| `host` | `153.3.236.22:443` | `Host` 头，出口 IP:端口 |
| `auth` | `683556433` | `X-T5-Auth` |
| `ua` | 模板 UA | `User-Agent` |
| `meng` | `dm.toutiao.com` | `Meng` 头 |
| `port` | `443` | 节点端口 |
| `prefix` | 空 | 节点名前缀 |
| `separator` | `\|` | 入口/出口名分隔符 |
| `append` | `true` | 节点操作模式是否追加到原节点 |
| `cache` | `true` | 是否启用缓存 |
| `cache_ttl` | `43200000` | 缓存时长（毫秒，12 小时） |
| `geo_provider` | `speedtest` | 归属地接口，可选 `ipapi` |
| `concurrency` | `5` | 归属地查询并发数 |
| `timeout` | `5000` | 单次 HTTP 超时（毫秒） |
| `retries` | `1` | 单次 HTTP 重试次数 |
| `retry_delay` | `1000` | 重试延时（毫秒） |
| `debug` | `false` | 调试日志 |

HTTP-META 相关（`http_meta_protocol` / `http_meta_host` / `http_meta_port` / `http_meta_authorization` / `http_meta_start_delay` / `http_meta_ready_timeout` / `http_meta_proxy_timeout`）本脚本不消费，仅为共用配置保留。
