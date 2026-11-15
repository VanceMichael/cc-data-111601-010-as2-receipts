# 来源约定

## 产品交换范围

此处只联调未签名、未加密的 AS2 profile：Content-Type、Content-Transfer-Encoding(binary/base64)、AS2-From/To、Message-ID、Disposition-Notification-To、Receipt-Delivery-Option、Disposition-Notification-Options。以 /delivery 元数据构造合法 HTTP 收件，双方约定 MIC 算法 sha-256。按 RFC 4130 §7.3.1，未签名且未加密时 MIC 对传输解码后的消息内容计算，不包含 MIME 或其他 RFC 2822 头；原始 MIME 实体摘要与 MIC 是不同依据，均须可定位，不能用 JSON 重新生成正文。当前内容类型为二进制 application/edi-x12，不做正文换行正规化；不实现已签名/加密路径。MDN 按 multipart/report、message/disposition-notification 表达 Original-Message-ID、Final-Recipient、Disposition 和 Received-content-MIC。同一发送方/接收方/Message-ID 重投须比较原件摘要；异步 /receipts 为独立目标，阶段 1 返回 503。无签名不提供来源身份认证。

## 当前来源路由

- `/primary`：application/edi-x12
- `/delivery`：application/json
- `/conflicting`：application/octet-stream
- `/base64`：application/octet-stream

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://www.rfc-editor.org/rfc/rfc4130

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
