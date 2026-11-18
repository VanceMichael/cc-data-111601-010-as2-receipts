# as2-receipts

合作方电子交付的原件收件与异步回执相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

包含普通 HTTP 原件持久接收及摘要查询，并在约定范围内提供未签名、未加密的 AS2 收件，支持同步 MDN 与异步 MDN（含退避重试、重启恢复和操作员重投）。

`src/reader.mjs` 提供现有单件读取契约；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要和解释结果。`src/as2.mjs` 按真实接收的 MIME 实体解析、传输解码并计算 MIC，构造 multipart/report MDN；`src/as2-store.mjs` 以 (AS2-From, AS2-To, Message-ID) 为身份键持久化 AS2 原件与回执尝试；`src/receipt-delivery.mjs` 负责异步 MDN 投递；`src/as2-client.mjs` 是按 `/delivery` 元数据构造合法 AS2 请求的联调助手。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品，先演示普通 HTTP 领取，再演示同步 AS2 收件与含两次 503 重试的异步 MDN 投递，最后打印操作员总览并清理临时目录。演示没有固定等待、外网访问或人工操作，通常数秒结束。不要以打印预先保存的结果替代运行。

直接 `npm start` 即可启动产品，默认自动在临时回环端口创建本地合成来源，产品默认监听 127.0.0.1:4102。退出产品时同步关闭自带来源。需要联调独立来源时先运行 `npm run source`，再设置 SOURCE_URL=http://127.0.0.1:4101 运行 `npm start`；显式来源不会由产品关闭。DATA_DIR 可设置资料目录，PORT 可覆盖产品监听端口。RECEIPT_ORIGINS 可覆盖异步 MDN 允许投递的来源 origin 白名单（逗号分隔，默认仅 SOURCE_URL 同源）；RETRY_BASE_MS、RETRY_MAX_MS、RETRY_MAX_ATTEMPTS 控制退避重试。构建产物位于 dist，启动、测试与演示均不需要外部服务或下载。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。

前四项是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。收件记录当前只包含单件 raw 对象，不代表关联资料已完整。

## AS2 接口（约定范围内的未签名 profile）

- POST /as2/inbox：接收 AS2 HTTP 消息。按真实收到的 MIME 实体字节持久化原件（不重新序列化，外层 CRLF 与 Content-Transfer-Encoding 原样保留），MIC 仅对传输解码后的消息内容按 sha-256 计算，原件摘要与 MIC 分别可定位。无 Receipt-Delivery-Option 时在同一 HTTP 响应返回同步 MDN；有时先返回 200，再向该地址独立投递异步 MDN。
- GET /as2/messages：操作员查询全部 AS2 收件、状态与每次回执尝试（含 HTTP 状态、错误、时间）。
- GET /as2/messages/{id}：查询单条收件与回执尝试链。
- GET /as2/objects/{digest}：读取已落地的原始 MIME 实体字节。
- POST /as2/messages/{id}/redrive：对未送达的异步消息重新排队 MDN 投递，历史尝试保留。

身份与重投规则：身份键为 AS2-From、AS2-To 与 Message-ID。同身份同原件摘要的重投复用原记录，不重复登记，并再次给出 MDN；同身份但摘要或 MIC 变化不视为重投，原记录不被覆盖，冲突留痕并返回/投递 failed MDN。未签名模式下 MIC 只证明接收内容完整性，不构成发送方身份认证。异步回执地址必须在 RECEIPT_ORIGINS 白名单内，否则在持久化前拒绝。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复，其中 /receipts 在阶段 1 返回 503。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应，并覆盖 AS2 实体解析、MIC 两层依据、同步/异步 MDN、重投与冲突、退避重试、redrive 和重启恢复；领域读取行为在 test/domain.test.mjs，AS2 领域行为在 test/as2-domain.test.mjs，AS2 端到端行为在 test/as2-integration.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t as2-receipts:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
