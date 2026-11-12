# WebSearch / WebFetch 工具契约

两个工具由 Proma 主进程直连 Proma Cloud 完成，模型只需一次工具调用：凭据、超时、错误映射都在客户端处理，不要自己发 HTTP 请求。

## WebSearch

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 1–128 字符；支持 `site:`、`-site:`、`-词`、`"精确短语"`、`lang:`、`after:`、`before:` |
| `count` | number | 否 | 1–50，默认 10；不影响价格 |
| `need_content` | boolean | 否 | 是否内联返回正文，默认 false；通常先看 snippet/summary |
| `ori_question` | string | 否 | 触发这次搜索的用户原始问题（1–128 字符），提升检索理解 |
| `localization` | string | 否 | 用于结果本地化的 IP 地址 |

返回（JSON）：

```json
{
  "ok": true,
  "query": "…",
  "resultCount": 10,
  "results": [
    {
      "title": "…",
      "url": "https://…",
      "snippet": "100–200 字，供快速判断",
      "summary": "600–800 字，供模型阅读",
      "date": "2026-10-01T00:00:00+00:00",
      "siteName": "…",
      "authority": 3,
      "score": 2.4
    }
  ],
  "note": "空结果时给出的调整建议"
}
```

- `score` 即上游 `rerank_score`：0–3，**≥1.5 才算相关**。
- `authority`：0–4，`null` 表示未知，**≥3 才算权威**。
- `date` 未知时为 `null`；`content` 仅在 `need_content=true` 时出现。
- 空结果是 `200` + 空数组 + `note`，不计费。

失败时返回 `{ ok: false, status?, error, hint? }`，`hint` 已写明该重试、换来源还是停止。

## WebFetch

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 绝对 http(s) URL，不含用户名/密码；通常来自上一次 `WebSearch` 结果 |

返回：`# 标题` + 来源 URL + Markdown 正文。正文超过 40,000 字符会截断并标注。

- 抓取失败返回 `{ ok: false, status?, error, hint? }`。
- 页面无正文（`content` 为空）按 `404` 处理：换来源，不要重试同一 URL。
- JS 渲染、登录态、交互页面不属于该工具范围，改用受管浏览器。

## 并发

- 两个工具都是只读、无状态：同一轮里发出的多个调用由 Pi runtime **并行执行**，不需要自己排队。
- 推荐一次并发 2–4 个查询或 URL；超过 4 个容易触发 `429`（用户级限流约搜索 2 请求/秒、抓取 1 请求/秒）。
- 并发只降低等待时间，不降低费用：3 个查询仍是 3 次计费。
- 有数据依赖时先 `WebSearch` 再并行 `WebFetch`，不要反过来。

## 计费与限流

- 每次成功请求 0.0059 积分；`count`、返回条数、正文长度都不影响价格。
- 空结果、失败、超时不计费。
- 用户级限流：搜索约 2 请求/秒、抓取约 1 请求/秒（每进程，生产 4 进程）；超限返回 `429` + `Retry-After`。
- 上游按账号共用的配额由 Proma 统一排队，客户端不需要也不再自行并发。

## 底层接口（排障用）

主进程调用的是 proma-api 的以下端点；只有在需要核对平台行为时才看这一节，正常使用不要直接调用。

- `POST ${API_ROOT}/api/v1/tools/search`，body：`query`、`count`、`need_content`、`ori_question`、`localization`
- `POST ${API_ROOT}/api/v1/tools/fetch`，body：`url`
- 认证：`Authorization: Bearer <Proma API Key>`（客户端使用 Agent Inner Key）
- 上游状态码 `400/403/404/408/413/429` 原样透传，`401/402/5xx` 在服务端映射为 `502`

## 与受管浏览器的分工

| 场景 | 选择 |
| --- | --- |
| 时效性事实、跨站发现、批量核实 | `WebSearch` |
| 自动任务、委派会话、无用户交互 | `WebSearch` |
| 已给 URL 或需要引用正文 | `WebFetch` |
| 登录、点击、填写、翻页、下载 | `Browser*` |
| JS 渲染后才有内容、需要截图或视觉核验 | `Browser*` |
| 高风险事实或来源冲突，需要原文互验 | `WebSearch` → `WebFetch`/`Browser*` 核对原文 |
