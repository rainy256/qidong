# 启动 / 约局车票 (`qidong`)

面向 **微信 / QQ 熟人群与游戏开黑车队** 的免登录约玩时间同步网站。  
点开群链接即可直接填自己有空的时段，实时同步所有人进度，并按「全程连续可玩人数交集」自动算出最靠谱的开局时间。

> **架构路线：方案 A**（React + Vite + Fastify + SQLite WAL + SSE + Nginx 单机同域部署）  
> **当前进度：Phase 1 手机端前端模板与核心领域引擎已完成并实机验收通过**；Phase 2 后端接口、SQLite 持久化与 SSE 实时广播等待接入（前端已预留统一 `RoomRepository` 契约与 `HttpSseRoomClient`）。

---

## 快速开始

```bash
npm install
npm run dev      # 默认监听 http://127.0.0.1:5173
npm test         # 运行 Vitest 纯领域推荐算法单测（5 项核心用例）
npm run build    # TypeScript 类型检查 + Vite 生产打包
```

### 本地预览入口（当前内置 Mock 数据 + 演示控制台）

- **建房页：** `http://127.0.0.1:5173/`（狂奔小黄豆横幅 + `Apex` / `GTA` / `塔科夫` / `自定义` 贴纸墙 + 撕页日历）
- **主推演示车票（差 1 人凑齐）：** `http://127.0.0.1:5173/r/demo-almost`
- **算法防误报反例（甲乙丙丁戊中途换人）：** `http://127.0.0.1:5173/r/demo-counterexample`
- **其他内置场景：** `/r/demo-ready`、`/r/demo-midnight`、`/r/demo-closed`、`/r/demo-empty`（也可点击右下角 / 页面底部的「演示切换」自由切换身份、断网、剪贴板受限与 409 冲突）

---

## 目录结构

```text
.
├── docs/
│   ├── PROJECT_PLAN.md          # 完整产品设计、视觉定稿、推荐算法与方案 A 架构规划
│   ├── API_CONTRACT.md          # SQLite DDL、5 个同源 API + SSE 契约与 Nginx 配置
│   └── HANDOFF.md               # 给新对话 / 接力开发的上下文与 Phase 2 实施清单
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
