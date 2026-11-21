// 审批卡 owner 的单测：真实代码 + 假 DOM。
//
// 为什么不用等待真审批卡：审批卡什么时候出现不由插件决定，而且这个会话的
// 权限策略会自动放行大部分调用。owner 的逻辑本身是纯的（查面板、列按钮、
// 移动、点击），给它一个假 DOM 就能把每条分支走一遍。
//
// 注意：sync() 只在"面板元素换了一个"时重新读按钮（真 DOM 里换卡就会换元素），
// 所以每个场景都要给一个新的 panel 对象，不能只换按钮数组。

import { pathToFileURL } from 'node:url';

const clicks = [];
let panel = null;

function makeButton(text) {
  return {
    textContent: ' ' + text + ' ',
    disabled: false,
    style: {},
    click() { clicks.push(text); },
  };
}

function newPanel(labels) {
  const buttons = labels.map(makeButton);
  return { checkVisibility: () => true, querySelectorAll: () => buttons };
}

const hiddenPanel = { checkVisibility: () => false, querySelectorAll: () => [] };

globalThis.window = { __ModuleLoader__: { load: (mod) => { globalThis.__mod = mod; } } };
globalThis.document = { querySelectorAll: () => (panel ? [panel] : []) };
globalThis.fetch = () => Promise.resolve({ ok: true });

const link = new URL('../lib/client.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
await import(pathToFileURL(link).href);

const mod = globalThis.__mod.factory(() => ({ createElement: () => null, useState: () => [null, () => {}], useEffect: () => {} }));
const owner = mod.createApprovalOwner();

const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(name + ': got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
  console.log((ok ? 'ok   ' : 'FAIL ') + name + ' -> ' + JSON.stringify(actual));
}

// 1. 面板可见 → active；不可见 → 不接管
panel = newPanel(['拒绝', '允许一次']);
check('active when panel visible', owner.active(), true);
panel = hiddenPanel;
check('inactive when panel hidden', owner.active(), false);

// 2. 默认停在最后一个（允许一次），确定 = 点击它
panel = newPanel(['拒绝', '允许一次']);
check('select default', owner.commands.SELECT(), '已点击：允许一次');
check('click recorded', clicks, ['允许一次']);

// 3. 上下移动：从默认（last）往上走到第一个
panel = newPanel(['拒绝', '允许一次']);
check('nav up', owner.commands.NAV_UP(), '审批 1/2：拒绝');
check('select after nav', owner.commands.SELECT(), '已点击：拒绝');
check('click recorded 2', clicks, ['允许一次', '拒绝']);

// 4. 下移回绕到第一个（last 的下一个是 first）
panel = newPanel(['拒绝', '允许一次']);
check('nav down wraps', owner.commands.NAV_DOWN(), '审批 1/2：拒绝');

// 5. 单按钮面板：不移动，直接给提示
panel = newPanel(['允许']);
check('single button nav', owner.commands.NAV_UP(), '审批：允许（确定执行）');
check('single button select', owner.commands.SELECT(), '已点击：允许');

// 6. 返回键只提示，不点击
panel = newPanel(['拒绝', '允许一次']);
const before = clicks.length;
check('back only hints', owner.commands.BACK(), '审批等待中：上下选择，确定执行');
check('back did not click', clicks.length, before);

// 7. 面板消失后，命令不接管
panel = null;
check('select with no panel', owner.commands.SELECT(), '');
check('back with no panel', owner.commands.BACK(), '');

console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILURES:\n' + failures.join('\n'));
process.exit(failures.length === 0 ? 0 : 1);
