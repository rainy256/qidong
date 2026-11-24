# 启动 / 约局车票 (`qidong`)

面向 **微信 / QQ 熟人群与游戏开黑车队** 的免登录约玩时间同步网站。  
点开群链接即可直接填自己有空的时段，实时同步所有人进度，并按「全程连续可玩人数交集」自动算出最靠谱的开局时间。

> **架构路线：方案 A**（React + Vite + Fastify + SQLite WAL + SSE + Nginx 单机同域部署）  
> **当前进度：Phase 1 前端与 Phase 2 Fastify + SQLite (WAL) + SSE 后端均已实现并完成联调。**

---

## 快速开始

```bash
npm install

# 联调模式（默认连接 Fastify + SQLite 真实后端）：
npm run dev:server  # 启动后端，监听 http://127.0.0.1:3000
npm run dev         # 启动前端，监听 http://127.0.0.1:5173（自动代理 /api -> 127.0.0.1:3000）

# 纯前端演示模式（使用内存 Mock 与演示控制台）：
npm run dev:mock    # 监听 http://127.0.0.1:5173

# 测试与构建：
npm test            # 运行 Vitest 领域推荐算法 + 后端 API/SSE/并发集成测试
npm run build       # TypeScript 类型检查（前端 + 后端）+ Vite 生产打包
npm run start:server
```

### 本地预览入口（Mock 演示模式 `npm run dev:mock` 可直接访问）

- **建房页：** `http://127.0.0.1:5173/`（狂奔小黄豆横幅 + `Apex` / `GTA` / `塔科夫` / `自定义` 贴纸墙 + 撕页日历）
- **主推演示车票（差 1 人凑齐）：** `http://127.0.0.1:5173/r/demo-almost`
- **算法防误报反例（甲乙丙丁戊中途换人）：** `http://127.0.0.1:5173/r/demo-counterexample`
- **其他内置场景：** `/r/demo-ready`、`/r/demo-midnight`、`/r/demo-closed`、`/r/demo-empty`（也可点击右下角 / 页面底部的「演示切换」自由切换身份、断网、剪贴板受限与 409 冲突）

---

## 目录结构

```text
.
├── deploy/
│   ├── nginx.conf               # 生产 Nginx 同域反代与 SSE 防缓冲配置
│   └── yueju.service            # systemd 单进程托管配置
├── docs/
│   ├── PROJECT_PLAN.md          # 完整产品设计、视觉定稿、推荐算法与方案 A 架构规划
│   ├── API_CONTRACT.md          # SQLite DDL、5 个同源 API + SSE 契约与 Nginx 配置
│   └── HANDOFF.md               # 给新对话 / 接力开发的上下文与 Phase 2 实施清单
├── server/
│   ├── index.ts                 # 后端服务启动入口与过期房间定期清理
│   ├── app.ts                   # Fastify 路由、Origin 校验、HttpOnly Cookie 与 SSE 接入
│   ├── db.ts                    # SQLite (WAL) 事务持久化与双版本并发控制
│   ├── sseHub.ts                # 房间级 SSE 订阅广播与 25s 心跳
│   ├── security.ts              # 高熵 ID/Token 生成、SHA-256 + Pepper 哈希与同源校验
│   ├── validation.ts            # 请求体合法性校验
│   ├── config.ts                # 环境变量配置解析
│   └── server.test.ts           # Vitest 后端并发、409/410、SSE、CSRF 与反例集成测试
├── public/art/                  # 确认保留的 5 张小黄豆系列美术资源（严禁绿色）
│   ├── hero-runner.png          # 顶部狂奔小黄豆（240×352）
│   ├── game-apex.png            # Apex 变幻小黄豆（850×850）
│   ├── game-gta.png             # GTA 金条粉钻小黄豆（1254×1254）
│   ├── game-tarkov.png          # 塔科夫 Killa 显卡金币小黄豆（1254×1254）
│   └── game-custom.png          # 自定义卫衣耳机手柄小黄豆（1254×1254）
└── src/
    ├── api/
    │   ├── repository.ts        # 唯一仓库抽象 RoomRepository 与错误类型
    │   ├── mockClient.ts        # Phase 1 本地内存 Mock 实现（带幂等、SSE 推送模拟）
    │   └── httpSseClient.ts     # Phase 2 真实同源 HTTP + SSE 客户端（待接入后端）
    ├── domain/
    │   ├── types.ts             # Slot / Span / Night / Pick / RoomSnapshot 等共享类型
    │   ├── time.ts              # Asia/Shanghai 半小时格点转换与「次日」跨午夜格式化
    │   ├── recommend.ts         # 纯函数交集推荐引擎、分布条统计、草稿反馈、群通知文案
    │   └── recommend.test.ts    # Vitest 核心用例与反例测试
    ├── mocks/scenarios.ts       # 6 个隔离的开黑演示房间种子数据
    ├── components/              # Boarding Pass 车票、波浪分布条、原生 <select> 时段选择器、弹窗等
    ├── pages/                   # CreateRoomPage (/) & RoomPage (/r/:id)
    └── styles/                  # 无绿色奶油手账配色 tokens.css & global.css
```

---

## 下一步怎么继续？

请在新对话中先阅读以下三份文档即可直接接力开发 Phase 2（Fastify + SQLite WAL + SSE 后端）：

1. [`docs/HANDOFF.md`](./docs/HANDOFF.md) — **新对话首读**：现状盘点、不可违背的用户偏好约束、Phase 2 分步任务清单
2. [`docs/PROJECT_PLAN.md`](./docs/PROJECT_PLAN.md) — **产品与技术总纲**：与 Codex (`gpt-6.2-astra`) 收敛的核心产品决策、算法规则与交付路线
3. [`docs/API_CONTRACT.md`](./docs/API_CONTRACT.md) — **前后端接口契约**：SQLite 表结构、5 个 `/api/rooms` 接口、`EventSource` 协议与 Nginx SSE 配置
