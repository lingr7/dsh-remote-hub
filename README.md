遥控器命令总线：**单一监听者 + 上下文栈 + owner 注册**。

原来每个插件各自 `keydown` 抢键，谁先注册谁说话。这个插件把按键统一收进一个入口，
再按上下文路由给「此刻该管这件事」的 owner：

- 媒体键（音量 ±、双击确定、左右）→ 音乐卡片
- 上下/确定/返回，且页面上有审批卡 → 审批 owner（高优先级）
- 没有任何 owner 认领 → 直接放行，页面原有行为不变（上下翻页、左右移光标）

owner 的命令处理函数**返回一句字符串**就等于回执，hub 在屏幕底部弹一个胶囊提示；
返回空则静默。遥控器没有屏幕，没有反馈用户就不知道按到没有。

## 安装

把整个目录放到工作区，然后在 DSH 里：

```powershell
plugin_manager install_bundle target=<这个目录的绝对路径>
```

宿主重启后生效。

## 其它插件怎么接入

```js
window.__DSH_REMOTE_HUB__.register({
  id: 'my-plugin',
  priority: 20,                 // 越大越先拿到；同优先级按注册顺序
  active: () => true,           // 返回 false 时本 owner 不参与路由
  commands: {
    VOLUME_UP: () => { /* ... */ return '音量 20%'; },
  },
});
```

命令名见 `lib/client.js` 的 `BINDINGS` 表。
