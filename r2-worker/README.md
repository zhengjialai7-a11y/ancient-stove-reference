# 母图 R2 存储服务

这个 Worker 只负责原始母图。账号、收藏队列、作品、分类和草稿仍留在现有 Supabase 项目；旧 Supabase 母图继续使用原地址。此目录是待接入的部署源码，不代表 Cloudflare 已开通或已部署。

## 部署

需要在用户自己的 Cloudflare 账号启用 R2，再部署 Worker。Cloudflare 可能要求提供付款方式；免费额度之外按实际使用计费。代码不会开通账单、升级 Supabase 或删除旧云端母图。

在本目录执行：

```sh
npx wrangler login
npx wrangler r2 bucket create art-originals
npx wrangler deploy
npx wrangler secret put R2_HMAC_SECRET
```

`R2_HMAC_SECRET` 使用随机生成的 64 位小写十六进制密钥文本（32 字节随机值的十六进制表示），通过交互输入或安全管道传入 Wrangler；不要写入源码、聊天、浏览器或本机插件。数据库的 R2 接入配置必须使用完全相同的 UTF-8 密钥字符串。双方使用该文本的 UTF-8 字节，不进行十六进制解码。

Supabase 验证地址和公开客户端 key 已在源码固定为现有项目，不接受客户端指定账号服务。Worker 使用 R2 binding，不需要向插件分发 R2/S3 密钥。浏览器来源默认只允许现有 GitHub Pages 域名；原图公开读取接口只读并提供匿名 CORS，和现有公开母图的展示方式一致。

部署后访问 `https://<worker-host>/health`，应返回 `configured: true`。将这个 **HTTPS origin** 和共享签名密钥配置到数据库，再启用 R2 上传。数据库会检查签名、账号、对象路径、完整 SHA-256、字节数和签名时间。不要把临时预览地址或带路径的地址作为存储 origin。

也可以使用 Cloudflare 控制台：在 R2 Object Storage 建立私有 `art-originals` bucket；在 Workers & Pages 建立 Worker 并将 `worker.mjs` 作为模块代码部署；给该 Worker 添加名称为 `BUCKET` 的 R2 binding 指向该 bucket。在 Worker 的 Settings → Variables and Secrets 中添加类型为 **Secret** 的 `R2_HMAC_SECRET`，以及普通变量 `ALLOWED_ORIGIN=https://zhengjialai7-a11y.github.io` 和 `MAX_ORIGINAL_BYTES=5368709120`，部署设置后再检查 `/health`。无需启用 bucket 的 `r2.dev` 公网访问，公开图片由只读 Worker 路由提供。

现有项目的数据库兼容更新已应用，当前仍未启用 R2。账号持有人可以在 [Cloudflare 控制台](https://dash.cloudflare.com/) 完成 R2 开通，然后部署上述服务。桶保持私有，由 Worker 提供已核验母图的只读展示接口。

在现有 [Supabase SQL Editor](https://supabase.com/dashboard/project/otaokoencpoanxjjuqzv/sql/new) 以管理员身份读取已经生成的签名密钥：

```sql
select hmac_secret from original_storage_private.config where singleton;
```

将结果直接输入 `wrangler secret put R2_HMAC_SECRET` 的隐藏输入框。不要把结果发到聊天或保存在源码。确认 `/health` 返回 `configured: true` 后，将下面的地址替换成实际 Worker 的固定地址，再运行：

```sql
update original_storage_private.config
set endpoint = 'https://art-original-r2.<你的子域>.workers.dev', enabled = true
where singleton;
```

已经开始使用的 origin 应保持稳定；当前版本不会把旧 R2 母图改写到另一个地址。停止采集后更新插件和本机助手，再刷新收藏队列，应显示“R2 · 已接入”。用一张已经保留在本地的大母图做首次验收，无需再次消耗珍宝馆下载额度；确认上传、回读 SHA、关联和草稿打开正常后，再继续批量处理。原有问题可从“集中处理问题”选择重试，已完成分段会复用。

## 原始字节与断点续传

客户端按 8 MiB 分段上传原始字节，每个非末尾分段大小相同。上传 session 和分段回执保存在私有 `_uploads/`，中间母图保存在 `_staging/`；公开接口不能访问这些路径。

完成 multipart 后，Worker 将 staging 原始字节流传给 R2 的 `put`，指定完整 SHA-256 和 `If-None-Match: *`。R2 检验整张母图的实际字节；校验通过才建立 `masters/<账号>/<SHA-256>.<jpg|png|webp>` 不可覆盖对象，并产生 HMAC 回执。伪造 metadata、分段 ETag 或对象长度都不能代替 R2 完整 SHA-256 校验。客户端还必须重新下载完整最终母图计算 SHA-256，完成云端登记后才允许删除本地文件。

同一账号、同一原图的重复初始化返回现有 session 和已上传分段。已完成对象返回新的签名回执。完成响应丢失时再次完成不会覆盖原图。临时网络错误保留 session；已失效 multipart 返回 `410 UPLOAD_EXPIRED`，客户端可重新初始化。R2 默认七天回收未完成 multipart，本服务提前在第六天重新建立 session。

单文件上限为 5 GiB，可通过 `MAX_ORIGINAL_BYTES` 下调；这是完整 SHA-256 流式 promotion 的单次 `put` 上限。Worker 不将整张母图放入 JavaScript 内存，每次只暂存一个最大 8 MiB 分段。分段记录通过分页列表恢复，不按每个分段逐个请求，避免大文件超出 Worker 的子请求限额。

成功后清理 staging。发生网络中断时保留上传记录；完整字节校验失败时清理已证明损坏的中间字节，让下次重试重新上传，客户端仍保留本地原图和失败记录。部署者应为 `_staging/` 和 `_uploads/` 添加至少七天的过期生命周期，清理长期失败的中间对象。生命周期只作用于这些私有前缀，不能覆盖 `masters/`。校验阶段会暂时同时保留 staging 和最终对象，使用量和操作请求均计入 R2。

## 接口

所有 `/v1/` 接口需要 `Authorization: Bearer <Supabase access token>`，每次向固定 Supabase `/auth/v1/user` 验证。对象路径从验证后的账号派生。

| 操作 | 接口 | 输入与结果 |
| --- | --- | --- |
| 创建或恢复 | `POST /v1/uploads` | `{sha256,bytes,mime}` → `{uploadId,key,partSize,parts}`；已完成时另有 `completed:true,receipt` |
| 上传分段 | `PUT /v1/uploads/<id>/parts/<n>?key=<key>` | 原始分段 → `{partNumber,etag}` |
| 完成并校验 | `POST /v1/uploads/<id>/complete` | `{key,sha256,bytes,mime,parts}` → `{key,etag,bytes,receipt}` |
| 刷新回执 | `POST /v1/receipts` | `{key,sha256,bytes,mime}` → 回执对象本身 |
| 本人回读 | `GET/HEAD /v1/objects/<key>` | 最终原图，支持单一字节 Range |
| 公开展示 | `GET/HEAD /public/<key>` | 只允许完整校验后的最终原图，支持 Range；无公开写入、删除或列表接口 |

回执字段为 `owner,storage_origin,path,sha256,bytes,mime,etag,issued_at,signature`。HMAC-SHA256 输入为以下字段使用 `\n` 连接后的 UTF-8 字节：

```text
r2-v1
owner
storage_origin
path
sha256
bytes 的十进制字符串
mime
etag
issued_at 的 Unix 秒字符串
```

签名是小写十六进制。数据库通过 `record_r2_original_receipt({p_receipt: receipt})` 登记；有效时间窗口为 15 分钟，可重新获取回执，不能仅凭客户端状态登记。

## 验证

```sh
node --test ../tests/r2-worker.test.mjs
```

测试覆盖跨账号拒绝、来源限制、分段尺寸、断点恢复、失效 session、完整 SHA-256 不匹配、已有对象不可覆盖、完成响应丢失、只读公开接口和 Range。Cloudflare 实际账号部署、真实 R2 字节上传和本机 Windows 下载仍需在接入后执行验收。

接入后的实测先使用本机已下载的 60–80 MB 母图，不新增珍宝馆下载。确认上传能超过原先 50 MB 的限制；上传中断后恢复只补缺少的分段；完成后收藏队列自动显示相同作品和母图张数，工作台能打开原图且画布裁切无 CORS 错误；最后对比完整 SHA-256、字节数和原始尺寸。只有这些校验、云端登记和作品关联均成功且本地文件仍未变化，才验收自动清理本地母图。旧 Supabase 母图和已有草稿也应继续正常打开。

官方依据：

- [R2 Workers API 与完整 checksum](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 multipart 上传和默认七天回收](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [R2 错误码](https://developers.cloudflare.com/r2/api/error-codes/)
- [Workers FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/)
- [Worker 控制台 Secret 配置](https://developers.cloudflare.com/workers/configuration/secrets/)
- [R2 容量上限](https://developers.cloudflare.com/r2/platform/limits/)
- [R2 价格及免费额度](https://developers.cloudflare.com/r2/pricing/)
