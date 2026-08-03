// start.js — Dylan Heartbeat 合一入口（Zeabur 兼容版）
// Zeabur 需要主进程直接监听 PORT；这里直接加载 server.js，
// 同时以独立子进程拉起 wake_up.js，崩溃自动重启。
const { spawn } = require('child_process');
const path = require('path');

function startWakeUp() {
  const child = spawn(process.execPath, [path.join(__dirname, 'wake_up.js')], {
    stdio: 'inherit',
    env: process.env
  });
  child.on('error', (err) => console.error('[start] wake_up 启动失败:', err.message));
  child.on('exit', (code, signal) => {
    console.log(`[start] wake_up 退出 code=${code} signal=${signal}，5秒后自动重启`);
    setTimeout(startWakeUp, 5000);
  });
}

function startWakeOmb() {
  const child = spawn(process.execPath, [path.join(__dirname, 'wake_omb.js')], { stdio: 'inherit', env: process.env });
  child.on('error', (err) => console.error('[start] wake_omb 启动失败:', err.message));
  child.on('exit', (code, signal) => {
    console.log(`[start] wake_omb 退出 code=${code} signal=${signal}，5秒后自动重启`);
    setTimeout(startWakeOmb, 5000);
  });
}
startWakeOmb();

startWakeUp();

// 主进程直接加载 server.js（它自己会 listen PORT，Zeabur 才能探测到）
require('./server.js');
