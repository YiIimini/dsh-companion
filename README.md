# dsh-companion

> 一个桌宠，替掉五个。 / One desk companion instead of five.
> DeepSeek Harness 插件 · 零依赖 · 零构建 · MIT

---

## 为什么有它

DSH 生态里的宠物插件已经足够多了，而它们各自只做对一半：

| 已有插件 | 它做对的 | 它缺的 |
|---|---|---|
| `dsh-pet`（大肥鱼） | 真的按会话事件换姿态 | 只有一个角色，状态机塞在 host 里 |
| `dsh-bigfish` | 角色包可替换（rig + 关键帧） | 引擎重、资产多，改角色要写 rig |
| `dsh-pet-indesktop` | 位置持久化 + 8 套皮肤，纯 SVG 轻量 | 客户端 inject 写了不存在的包名，`slot occupant active: false`，画不出来（那些皮肤图现在可以原样搬进本插件的 skins 目录） |
| `dsh-whale-widget` / wallpaper-engine mascot | 余额、气泡、玻璃质感 | 是挂件，不是会动的伙伴 |

**dsh-companion 把这四件事拆开重新组合**：一个很小的核心（状态 + 存在感 + 两个座位），角色是纯内联 SVG（换角色不改代码），位置真的记得住，状态来自 host 的真实 `session/event` 而不是客户端猜。

## 它做什么

- **三个内置角色**：像素鲸（whale，默认）、像素肥鱼（fish）、小方块（pixel）。同一套 200×150 方块网格、整数坐标、硬边、每只两个主色 + 肚白 + 一枚腮红——这套约束是为了在 104px 上还看得清轮廓。没有任何图片资产、没有外部请求。想要立绘级的好看，用下面的图片皮肤。
- **图片皮肤（v2 新增）**：把任意 PNG / WebP / GIF / SVG 丢进 `$DSH_HOME/companion/skins/`，侧栏 `伙伴` 菜单里立刻就能选。图片由 host 的 allow-list 路由提供：文件名必须匹配白名单正则、解析后的真实路径必须仍在 skins 目录内（挡符号链接逃逸）、单文件上限 4 MiB。想用哪张图由你决定，插件不替你的审美做主。
- **拖到哪记住哪**：位置写进 `$DSH_HOME/companion/state.json`（原子写：临时文件 + 同目录 rename），刷新、重启、换机器都能恢复；窗口变小会自动把宠物挪回可见区域。
- **存在感来自真实事件**：host 侧 `ctx.on('session/event')` 每来一个事件就盖一个时间戳，客户端只读 `mood`。**活干着 → 摇摆加速 + WORKING 角标；闲下来 → 慢呼吸。** 客户端不推导 agent 状态。
- **点一下说话**：每个角色有自己的台词池，点击出气泡，不刷屏（4.2s 自动消失）。
- **藏起来也能找回来**：不是只放一个可隐藏的浮层——侧边栏底部还有 `伙伴` 按钮，负责显示/隐藏和换角色。隐藏时不渲染宠物，但按钮永远在。
- **可选的人设预设 `伙伴模式`**：它是官方 `standard` 预设的**逐字拷贝**，只改了 persona 一行。切过去不丢任何工具、技能和限制；不想用就不切，插件本身照常工作。

## 安装

还没上 npm，用源码装（bundle 自带 `dsh.bundle.patch`，装完即挂载）：

```bash
git clone https://github.com/YiIimini/dsh-companion
dsh plugin --profile <你的 profile> add file:$PWD/dsh-companion
```

在本仓库的 harness 里，也可以直接把目录交给插件管理器（绝对路径）：

```
plugin_manager install_bundle target=/绝对路径/dsh-companion
```

装完重启（或让插件管理器热应用），桌面上出现小蓝，侧边栏底部出现 `伙伴` 按钮。

## 用法

| 操作 | 结果 |
|---|---|
| 拖动 | 移动位置，松手后 450ms 落盘 |
| 单击 | 说一句台词（不移动） |
| 侧栏 `伙伴` → 显示/隐藏伙伴 | 收起或放回宠物 |
| 侧栏 `伙伴` → 像素鲸 / 像素肥鱼 / 小方块 | 换内置角色，立即生效并记住 |
| 侧栏 `伙伴` → 我的皮肤 → 某个文件 | 换成 `~/.dsh/companion/skins/` 里的图；加载失败会自动退回内置角色 |

## 状态文件

`$DSH_HOME/companion/state.json`（默认 `~/.dsh/companion/state.json`）：

```json
{
  "version": 1,
  "visible": true,
  "x": 1180,
  "y": 640,
  "character": "skin:my-whale.png",
  "name": "小蓝",
  "clicks": 3
}
```

`character` 取内置名（`whale` / `fish` / `pixel`）或 `skin:<文件名>`。

`x`/`y` 为 `null` 表示"还没拖过，用默认右下角"。手改坏了不会崩：读取时逐字段净化，超范围夹回、类型不对回落默认，并把修好的状态写回去。

## HTTP 接口（同源，只读为主）

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/dsh-companion/status.json` | 构建信息、角色白名单、mood、状态文件路径与自愈记录 |
| `GET` | `/dsh-companion/state.json` | 当前状态 + `activityAt` + `mood` |
| `POST` | `/dsh-companion/state.json/state` | 局部更新（严格校验：字段类型不对返回 400，不会静默接受） |
| `GET` | `/dsh-companion/skins.json` | 列出 skins 目录里可用的皮肤 |
| `GET` | `/dsh-companion/skins/<file>` | 取一张皮肤图（白名单 + realpath 边界 + 4 MiB 上限） |

写路由挂在读路由下面（`/state.json/state`），因为 webServer 按前缀匹配：一个注册点同时答读和写，后缀由常量派生而不是手打两次。请求体上限 8 KiB，角色 id 只做白名单比较，永远不进文件路径。

## 与旧插件共存

它们都是往 `shell.overlay` 加东西，所以能装在一起，但**会叠**。建议只留一个：

- 想要一个会动、能换角色、记得住位置的伙伴 → 留本插件，关掉 `dsh-pet` / `dsh-bigfish` / `dsh-pet-indesktop`。
- 想要余额挂件、Live2D 立绘、玻璃质感挂件 → 那些是不同物种，可以一起用。

`dsh-pet-indesktop` 单独的一个坑（与本插件无关，但顺手记下来）：它的 `package.json` 里 `dsh.client.inject` 写了 `@deepseek-ai/dsh-client-ui-slots`，而这个包在 DSH 0.2.1-rc.5 里**不存在**（slots 由 `@deepseek-ai/dsh-client-modules` 提供）。inject 指向一个解析不到的包，客户端模块就停在未激活状态——表现是「装好了、路由 200、但页面上什么都没有」。本插件只用真实存在的包名，`immediately: true`。

## 开发

```bash
node scripts/sync-preset.mjs          # 升级 DSH 后重新对齐 preset 的 plugins 列表
node scripts/sync-preset.mjs --check  # CI 用：不同步就退出 1
node --check index.js && node --check client.js
```

`cordis.patch.yml` 是**生成文件**：`preset-companion` 的 22 个 plugin 是从安装目录里的 `standard.patch.yml` 原样拷贝的，手改会在下次同步时被覆盖。

## 设计取舍

- **不用 `window.__ModuleLoader__` 之外的机制**：client 半边就是 `factory(require)` 里拿 React，返回 `{ inject: ['slots'], apply }`。没有静态 `inject` 依赖，服务没到就安静待着，绝不把 GUI 拖成 pending。
- **mood 在 host 算**：客户端只有"读 + 显示"，没有第二套状态机。换客户端、换页面都不用改协议。
- **不碰别的插件的数据**：不读 `dsh-pet` 的配置，不写别人的目录，只拥有 `$DSH_HOME/companion/`。
- **每个失败都只是降级**：fetch 失败保留上次状态，`require('react')` 之外没有共享全局，样式用 `document.head` 里带 id 的 `<style>` 并在卸载时移除。

## 灵感与出处

架构上参考了同生态的 MIT 项目（各自解决过其中一块）：

- [`dsh-pet-indesktop`](https://github.com/Gjs9178U/dsh-pet-indesktop) — 状态文件原子写 + 自愈读取 + slot 两座位的取舍
- [`dsh-pet`](https://www.npmjs.com/package/dsh-pet) — 用 `session/event` 做存在感
- [`dsh-bigfish`](https://www.npmjs.com/package/dsh-bigfish) — 角色可替换的产品思路

代码是重写的，没有复制上述项目的实现；保留署名是因为思路值得记。

## 许可

MIT © 2026 YiIimini
