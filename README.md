# as2-receipts

合作方电子交付的原件收件与异步回执相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

普通 HTTP 原件持久接收及摘要查询；另支持约定范围（见 docs/upstream.md）内的未签名、未加密 AS2 收件，含同步与异步 MDN 回执通道。

`src/reader.mjs` 提供现有单件读取契约；`src/as2.mjs` 核对 AS2 消息身份并按真实接收的 MIME 实体计算 MIC；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、解释结果、收件记录与回执尝试。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、读取已保存结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。AS2_ID 设置本端身份（默认 benefit-inbox），AS2_PARTNER 可限定约定发送方。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /as2：AS2 收件。按真实接收的 MIME 实体核对消息身份（AS2-From/To、Message-ID）并计算 MIC（sha-256，对传输解码后的内容，不含 MIME 头，不做换行正规化）；实体与外层声明不一致或超出约定范围（内容类型、传输编码、MIC 算法、回执目标跨源）即拒绝。无 Receipt-Delivery-Option 时随响应返回同步 MDN（multipart/report），有时向该同源地址投递异步 MDN。原件与收件记录先持久保存，再发送任何回执；同一 AS2-From/To/Message-ID 且原件摘要一致视为重投，不重复登记，仅追加一次回执尝试；摘要不同不算重投，返回 409 并记录冲突。
- GET /as2/receptions：收件记录列表，含 messageId、状态（received/mdn-sent/mdn-failed）、关联 recordId 与 digest。
- GET /as2/receptions/{id}：单件收件详情，含全部回执尝试（方式、目标、结果）与冲突记录。

以上接口保持兼容，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。收件记录当前只包含单件 raw 对象，不代表关联资料已完整。

无签名联调仅核对内容完整性：MIC 与原件摘要用于确认接收字节与发送内容一致，不构成发送方身份认证。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs，AS2 收件与回执行为在 test/as2.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t as2-receipts:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
