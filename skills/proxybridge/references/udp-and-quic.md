# UDP/QUIC 限制与排查

## UDP 支持限制

### SOCKS5 代理
- SOCKS5 协议支持 UDP ASSOCIATE 扩展
- 但需要代理服务器本身实现 UDP ASSOCIATE
- 大多数公共 SOCKS5 服务器不支持 UDP 转发
- UDP 流量可能被丢弃或回退到 TCP

### HTTP 代理
- HTTP 代理**完全不支持** UDP
- UDP 流量会被强制直连
- 这是协议层面的限制，无法通过配置绕过

### 建议
- 对于需要 UDP 转发的场景，使用支持 UDP ASSOCIATE 的 SOCKS5 服务器
- 在生成规则时注意警告：`RULE_UDP_REQUIRES_SOCKS5`
- 定期测试 UDP 连通性，确认代理服务器支持

## QUIC 协议

### 概述
- QUIC 基于 UDP 实现
- 大部分现代 HTTP/3 流量使用 QUIC
- 如果 UDP 被旁路，QUIC 流量也会被旁路

### 影响
- Chrome、Firefox 等浏览器的 HTTP/3 功能可能受到影响
- 某些应用（如 Discord、Slack）的 QUIC 流量可能无法走代理

### 排查建议
1. 检查规则中是否有 UDP/BOTH 协议的 PROXY 规则
2. 确认引用的代理类型是 socks5
3. 测试 QUIC 流量是否走代理：
   ```
   # 使用 curl 测试 HTTP/3
   curl --http3 -v https://example.com
   ```

## HTTP/3

### 概述
- HTTP/3 基于 QUIC
- 如果 QUIC 流量被旁路，HTTP/3 无法使用

### 规避方案
1. 禁用应用的 HTTP/3 功能（如 Chrome 的 `h3` flag）
2. 确保 UDP 流量可以通过代理
3. 使用支持 HTTP/3 的代理服务器

## 常见问题排查

### 症状：UDP 流量直连
1. 检查代理类型是否为 socks5
2. 检查规则中 Protocol 是否包含 UDP 或 BOTH
3. 检查是否有强制直连段命中

### 症状：QUIC 连接失败
1. 确认 UDP 代理是否正常工作
2. 检查代理服务器是否支持 HTTP/3
3. 尝试禁用 QUIC 测试是否正常

### 症状：特定应用无法走代理
1. 检查进程名匹配是否正确
2. 检查目标主机/端口是否匹配
3. 检查是否有更高优先级的规则拦截

## 测试方法

### TCP 连通性测试
使用 `proxybridge_test_proxy` 工具测试 TCP 连接：
```
proxybridge_test_proxy(host="proxy.example.com", port=1080)
```

### UDP 连通性测试
由于 UDP 无连接状态，需使用应用层测试：
- DNS 查询测试
- NTP 同步测试
- 应用内测试（如游戏、视频通话）
