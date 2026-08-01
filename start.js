// start.js — Dylan Heartbeat 合一入口
// Zeabur / Railway 等平台通常只跑一个 start 命令，
// 这里同时拉起 gateway(server.js) 和 wake-up(wake_up.js) 两个进程。
const { fork } = require('child_process');
const path = require('path');

const gateway = fork(path.join(__dirname, 'server.js'), { stdio: 'inherit' });
const wakeup = fork(path.join(__dirname, 'wake_up.js'), { stdio: 'inherit' });

function shutdown(signal) {
  console.log(`\n[start] 收到 ${signal}，正在关闭子进程...`);
  try { gateway.kill(signal); } catch (e) { /* ignore */ }
  try { wakeup.kill(signal); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 500);
}

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(sig => {
  process.on(sig, () => shutdown(sig));
});

process.on('uncaughtException', (err) => {
  console.error('[start] 未捕获异常（子进程各自存活，不退出）:', err.message);
});
