// dsh-remote-hub — 遥控器命令总线（客户端半）。
//
// 为什么要有它：遥控器只有一个信道（前台窗口的键盘事件），但被控对象有多个
// （对话输入框、音乐卡片、审批卡、将来的侧栏/面板）。不设路由的话，每个插件
// 都去 document 上抢 keydown，就成了"谁先监听谁赢"，加一个功能多一处 if。
//
// 这里只做三件事：
//   1. 单一监听者：window 捕获阶段只监听一次，把物理键翻成领域命令；
//   2. 命令分发：按 priority 询问 active 的 owner，谁声明了这个命令就归谁；
//      认领者可以返回一句字符串，hub 会当成"给用户看的回执"弹一条提示；
//   3. 无主放行：没人认领的命令不做 preventDefault，原行为原样保留。
//
// 所以本插件装上但没人注册时，行为与没装一致 —— 这是它的可回滚性来源。
//
// 对外契约（挂 window，避免跨 plugin bundle 的 service 注入复杂度）：
//   window.__DSH_REMOTE_HUB__.register(owner) -> unregister
//     owner = {
//       id: string,
//       priority?: number,              // 大者先
//       active?: () => boolean,         // 默认 true；卡片用它表达"我开着"
//       commands: { [command]: (payload) => string | void }
//     }
//   window.__DSH_REMOTE_HUB__.dispatch(command) -> { handled, ownerId }
//   window.__DSH_REMOTE_HUB__.notify(text)       // 主动弹一条回执
//   window.__DSH_REMOTE_HUB__.state() -> { owners, commands, bindings }
//
// 为什么回执在 hub 里：遥控器没有屏幕，也不看光标。用户按下去之后必须有个
// "收到了"的信号，否则他只能猜。这条提示是所有 owner 共用的公共设施，所以
// 放在路由层，而不是每个插件各弹各的。

window.__ModuleLoader__.load({
  id: 'dsh-remote-hub',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const HUB_VERSION = 2;
    const NOTICE_MS = 1600;

    // 物理键 -> 领域命令。这里只做"最无语义"的那层翻译。
    const BINDINGS = [
      { command: 'VOLUME_UP', match: (e) => e.altKey && e.key === 'PageUp' },
      { command: 'VOLUME_DOWN', match: (e) => e.altKey && e.key === 'PageDown' },
      { command: 'PLAY_TOGGLE', match: (e) => e.altKey && e.key === 'Enter' },
      { command: 'PREV', match: (e) => e.altKey && e.key === 'ArrowLeft' },
      { command: 'NEXT', match: (e) => e.altKey && e.key === 'ArrowRight' },
      { command: 'NAV_LEFT', match: (e) => !e.altKey && e.key === 'ArrowLeft' },
      { command: 'NAV_RIGHT', match: (e) => !e.altKey && e.key === 'ArrowRight' },
      { command: 'NAV_UP', match: (e) => !e.altKey && e.key === 'ArrowUp' },
      { command: 'NAV_DOWN', match: (e) => !e.altKey && e.key === 'ArrowDown' },
      { command: 'SELECT', match: (e) => !e.altKey && e.key === 'Enter' },
      { command: 'BACK', match: (e) => !e.altKey && e.key === 'Escape' },
    ];

    // 遥控器没有屏幕，页面 console 也看不到 —— 诊断只能靠宿主那头的日志文件。
    // 这里发一条就忘，失败静默：日志永远不该影响按键。
    function trace(text) {
      try {
        fetch('/dsh-remote-hub/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-remote-hub': '1' },
          body: JSON.stringify({ at: new Date().toISOString(), text }),
          keepalive: true,
        }).catch(() => {});
      } catch {
        // ignore
      }
    }

    // ---- 回执（所有 owner 共用的一条提示） ----
    const noticeListeners = new Set();
    let notice = { id: 0, text: '' };
    let noticeTimer = 0;

    function emitNotice() {
      for (const fn of noticeListeners) {
        try { fn(notice); } catch { /* 单个订阅者出错不影响别人 */ }
      }
    }

    function notify(text) {
      const value = String(text == null ? '' : text).trim();
      if (!value) return;
      const id = notice.id + 1;
      notice = { id, text: value };
      emitNotice();
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        if (notice.id === id) {
          notice = { id: id + 1, text: '' };
          emitNotice();
        }
      }, NOTICE_MS);
    }

    // 静态样式：遥控器场景下提示不能抢焦点，所以 always pointer-events:none。
    const NOTICE_STYLE = {
      position: 'fixed',
      left: '50%',
      bottom: '84px',
      transform: 'translateX(-50%)',
      zIndex: 70,
      padding: '8px 14px',
      borderRadius: '999px',
      background: 'rgba(24, 24, 27, 0.92)',
      color: '#fff',
      font: '13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
      letterSpacing: '0.01em',
      boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28)',
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
      transition: 'opacity 160ms ease',
    };

    function RemoteNotice() {
      const [text, setText] = React.useState(notice.text);
      React.useEffect(() => {
        const fn = (next) => setText(next.text);
        noticeListeners.add(fn);
        return () => noticeListeners.delete(fn);
      }, []);
      if (!text) return null;
      return h('div', { style: NOTICE_STYLE, role: 'status', 'aria-live': 'polite' }, text);
    }

    // 审批卡：DSH 自带的 Enter/Esc 只在焦点不在输入框时生效，而遥控器场景下
    // 焦点几乎总在输入框里。这里把它变成「上下选、确定执行」。
    const APPROVAL_PANEL = '[data-approval-key]';
    const APPROVAL_BUTTONS = 'button:not([data-hotkey="none"])';

    function visibleApprovalPanel() {
      const panels = document.querySelectorAll(APPROVAL_PANEL);
      for (const panel of panels) {
        const shown = typeof panel.checkVisibility === 'function'
          ? panel.checkVisibility()
          : panel.getClientRects().length > 0;
        if (shown) return panel;
      }
      return null;
    }

    function createApprovalOwner() {
      let panel = null;
      let buttons = [];
      let index = -1;

      function labelOf(button) {
        const text = (button.textContent || '').trim().replace(/\s+/g, ' ');
        return text ? text.slice(0, 24) : '（无文字按钮）';
      }

      function paint() {
        buttons.forEach((button, i) => {
          button.style.outline = i === index ? '2px solid #2f6fed' : '';
          button.style.outlineOffset = i === index ? '2px' : '';
        });
      }

      // 默认停在最后一个按钮（「允许一次」）：确定 = 允许，按下再确定 = 拒绝。
      function sync(force) {
        const next = visibleApprovalPanel();
        if (!next) {
          panel = null;
          buttons = [];
          index = -1;
          return false;
        }
        if (force || next !== panel) {
          panel = next;
          buttons = [...next.querySelectorAll(APPROVAL_BUTTONS)].filter((button) => !button.disabled);
          index = buttons.length - 1;
          paint();
          trace('approval panel buttons=' + buttons.length
            + ' [' + buttons.map(labelOf).join(' | ') + ']'
            + ' default=' + (index >= 0 ? labelOf(buttons[index]) : 'none'));
        }
        return buttons.length > 0;
      }

      function move(step) {
        if (!sync()) return '';
        if (buttons.length < 2) return '审批：' + labelOf(buttons[0]) + '（确定执行）';
        index = (index + step + buttons.length) % buttons.length;
        paint();
        return '审批 ' + (index + 1) + '/' + buttons.length + '：' + labelOf(buttons[index]);
      }

      function run() {
        if (!sync()) return '';
        const button = buttons[index];
        if (!button) return '';
        const text = labelOf(button);
        panel = null;
        buttons = [];
        index = -1;
        button.click();
        return '已点击：' + text;
      }

      return {
        id: 'approval',
        priority: 100,
        active: () => visibleApprovalPanel() !== null,
        commands: {
          NAV_UP: () => move(-1),
          NAV_DOWN: () => move(1),
          SELECT: run,
          BACK: () => (sync() ? '审批等待中：上下选择，确定执行' : ''),
        },
      };
    }

    function createHub() {
      const owners = new Map();

      function register(owner) {
        if (!owner || !owner.id || !owner.commands) throw new Error('remote hub: owner needs id and commands');
        owners.set(owner.id, {
          id: owner.id,
          priority: Number(owner.priority) || 0,
          active: typeof owner.active === 'function' ? owner.active : () => true,
          commands: owner.commands,
        });
        trace('register ' + owner.id + ' priority=' + (Number(owner.priority) || 0)
          + ' commands=' + Object.keys(owner.commands).join(','));
        return () => {
          if (owners.delete(owner.id)) trace('unregister ' + owner.id);
        };
      }

      function candidates() {
        return [...owners.values()].sort((a, b) => b.priority - a.priority);
      }

      function dispatch(command) {
        for (const owner of candidates()) {
          const handler = owner.commands[command];
          if (typeof handler !== 'function') continue;
          let active = true;
          try { active = owner.active() !== false; } catch { active = true; }
          if (!active) continue;
          let feedback = '';
          try {
            feedback = handler({ command, owner: owner.id });
          } catch (error) {
            console.error('[dsh-remote-hub] owner ' + owner.id + ' failed on ' + command + ':', error);
            trace('owner-error ' + owner.id + ' ' + command + ': ' + (error && error.message ? error.message : String(error)));
            continue;
          }
          trace('dispatch ' + command + ' -> ' + owner.id);
          // 认领者可以返回一句给用户看的话；不返回就不打扰。
          // owner 也可能返回 Promise（要展开界面、等一帧之类），这种就自己用 hub.notify
          // 报进度，这里只负责把它的异常吃掉，别变成 unhandled rejection。
          if (typeof feedback === 'string' && feedback) notify(feedback);
          else if (feedback && typeof feedback.then === 'function') {
            feedback.then(
              (later) => { if (typeof later === 'string' && later) notify(later); },
              (error) => {
                console.error('[dsh-remote-hub] owner ' + owner.id + ' async failure on ' + command + ':', error);
                trace('owner-async-error ' + owner.id + ' ' + command + ': ' + (error && error.message ? error.message : String(error)));
              },
            );
          }
          return { handled: true, ownerId: owner.id };
        }
        trace('dispatch ' + command + ' -> (nobody)');
        return { handled: false, ownerId: '' };
      }

      function commandOf(event) {
        if (event.isComposing || event.keyCode === 229) return '';
        if (event.ctrlKey || event.metaKey) return '';
        for (const binding of BINDINGS) {
          if (binding.match(event)) return binding.command;
        }
        return '';
      }

      function state() {
        return {
          version: HUB_VERSION,
          owners: candidates().map((owner) => {
            let active = true;
            try { active = owner.active() !== false; } catch { active = true; }
            return { id: owner.id, priority: owner.priority, active, commands: Object.keys(owner.commands) };
          }),
          commands: [...new Set(candidates().flatMap((owner) => Object.keys(owner.commands)))],
          bindings: BINDINGS.map((binding) => binding.command),
          notice: notice.text,
        };
      }

      const api = { version: HUB_VERSION, register, dispatch, notify, state };

      // 单一监听者：只在这里读物理键。没人认领就不拦，原行为保留。
      // 挂在 window 的捕获阶段 —— 比 document 更早，任何插件在 document 上
      // stopPropagation 都拦不住我们。
      const onKeyDown = (event) => {
        const command = commandOf(event);
        if (!command) return;
        const result = dispatch(command);
        if (result.handled) {
          event.preventDefault();
          event.stopPropagation();
        }
      };

      return { api, onKeyDown };
    }

    function apply(ctx) {
      const { api, onKeyDown } = createHub();
      window.__DSH_REMOTE_HUB__ = api;
      window.addEventListener('keydown', onKeyDown, true);
      trace('hub ready');

      // 内建 owner：审批卡。别人没有需要注册，hub 自己就管。
      const unregisterApproval = api.register(createApprovalOwner());

      // 审批卡什么时候出现不由我们决定，所以留一条"它出现了"的证据：
      // 下次真的弹卡时，%TEMP%\dsh-remote-hub.log 里会有按钮清单，
      // 不用再靠猜 DSH 给卡片加了什么属性、按钮长什么样。
      const approvalWatch = typeof MutationObserver === 'function'
        ? new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node instanceof Element && (node.matches(APPROVAL_PANEL) || node.querySelector(APPROVAL_PANEL))) {
                const panels = [...document.querySelectorAll(APPROVAL_PANEL)];
                const buttons = panels.flatMap((panel) => [...panel.querySelectorAll(APPROVAL_BUTTONS)]);
                trace('approval appeared panels=' + panels.length + ' buttons='
                  + buttons.map((button) => (button.textContent || '').trim()).join(' | '));
              }
            }
          }
        })
        : null;
      if (approvalWatch) approvalWatch.observe(document.body, { childList: true, subtree: true });

      // 回执和零尺寸标记各占一个槽位：前者是真实 UI，后者只用于在
      // cordis inspect 的 slot 树里确认本插件挂载成功。
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'remote-hub-notice', order: 39.5 },
        RemoteNotice,
      ));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'remote-hub', order: 39 },
        () => null,
      ));

      ctx.effect(() => () => {
        window.removeEventListener('keydown', onKeyDown, true);
        if (approvalWatch) approvalWatch.disconnect();
        unregisterApproval();
        if (window.__DSH_REMOTE_HUB__ === api) delete window.__DSH_REMOTE_HUB__;
        clearTimeout(noticeTimer);
        noticeListeners.clear();
      }, 'dsh-remote-hub: dispatcher');
    }

    // createApprovalOwner 也导出一份：Node 里用假 DOM 做的单测要直接拿到它，
    // 否则只能靠"等一张真审批卡出现"，而审批卡什么时候出现不由我们决定。
    return { name: 'dsh-remote-hub', inject: ['slots'], apply, createApprovalOwner };
  },
});
