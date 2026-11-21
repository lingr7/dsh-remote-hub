// dsh-remote-hub — 宿主侧：只提供一个诊断入口，不参与路由。
//
// 路由全部在页面里（lib/client.js）。这里开一条 /dsh-remote-hub/log 让页面把
// 「谁注册了、哪条命令被谁接走」写进 %TEMP%\dsh-remote-hub.log —— 遥控器没有
// 屏幕，出问题时唯一能看的就是这条日志。
//
// 入口不对外：只接受同源 POST，且必须带 x-dsh-remote-hub 标记（挡掉跨站页面
// 顺手往日志里写垃圾）。日志本身是诊断用的，内容再脏也不该被当成配置读。
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const inject = ['webServer'];

const ROUTE = '/dsh-remote-hub';
const LOG_PATH = join(tmpdir(), 'dsh-remote-hub.log');
const MAX_BODY = 8 * 1024;

function logPath() {
  return LOG_PATH;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function trace(text) {
  try {
    await appendFile(logPath(), new Date().toISOString() + ' ' + text + '\n', 'utf8');
  } catch {
    // 日志失败不能影响按键
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE + '/log',
    handler(req, res) {
      const json = (status, value) => {
        const body = JSON.stringify(value);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      };
      if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
      if (!sameOrigin(req) || req.headers['x-dsh-remote-hub'] !== '1') {
        return json(403, { ok: false, error: 'forbidden' });
      }
      let body = '';
      let overflow = false;
      req.on('data', (chunk) => {
        if (overflow) return;
        body += chunk;
        if (body.length > MAX_BODY) {
          overflow = true;
          body = '';
        }
      });
      req.on('end', () => {
        json(overflow ? 413 : 200, { ok: !overflow });
        const line = String(body || '').slice(0, 4000);
        if (line) trace(line);
      });
    },
  }), 'dsh-remote-hub: log route');
}
