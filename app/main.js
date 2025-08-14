// --- add near the top with other requires ---
const { app, BrowserWindow, Menu, globalShortcut, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let py;
let windows = new Set();
const replyQueue = []; // pending requests awaiting a non-event reply

function startPython() {
  const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
  const servicePath = path.join(__dirname, 'python', 'service.py');
  py = spawn(pyCmd, [servicePath], { stdio: ['pipe', 'pipe', 'pipe'] });

  // ---- line-by-line reader over stdout ----
  let buf = '';
  py.stdout.on('data', chunk => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      handlePythonLine(line);
    }
  });

  // (optional) comment next line if stderr is noisy
  // py.stderr.on('data', d => process.stderr.write(`[py] ${d}`));
}

function handlePythonLine(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch { console.warn('Bad JSON from python:', line); return; }

  // Event lines: { "event": "progress", ... }
  if (msg.event) {
    for (const w of windows) w.webContents.send('py:event', msg);
    return;
  }

  // Reply lines: resolve the oldest pending request
  const waiter = replyQueue.shift();
  if (waiter) waiter.resolve(msg);
  else console.warn('Unmatched python reply:', msg);
}

function pyRequest(payload) {
  return new Promise((resolve, reject) => {
    replyQueue.push({ resolve, reject });
    py.stdin.write(JSON.stringify(payload) + '\n');
  });
}

// keep your createWindow but register the window
function createWindow() {
  const win = new BrowserWindow({
    width: 1055,
    height: 450,
    backgroundColor: '#121212',
    autoHideMenuBar: true,
    icon: path.join(__dirname,'assets',
      process.platform === 'win32' ? 'icon.ico' :
      process.platform === 'darwin' ? 'icon.icns' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  windows.add(win);
  win.on('closed', () => windows.delete(win));

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (!app.isPackaged) {
    globalShortcut.register('Control+Shift+I', () => {
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools({ mode: 'detach' });
    });
  }
}

// keep your temp writer
ipcMain.handle('py:saveTemp', async (_evt, { arrayBuffer, ext = 'mp4' }) => {
  const safeExt = String(ext).replace(/^\./, '') || 'mp4';
  const tmpPath = path.join(os.tmpdir(), `autotrim-${Date.now()}.${safeExt}`);
  const buf = Buffer.from(new Uint8Array(arrayBuffer));
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
});

// NEW: renderer → python request using the queue
ipcMain.handle('py:send', async (_evt, payload) => {
  if (!py) return { ok: false, error: 'Python service not running' };
  try { return await pyRequest(payload); }
  catch (e) { return { ok: false, error: String(e) }; }
});

// boot
app.whenReady().then(() => {
  startPython();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('will-quit', () => { if (!app.isPackaged) globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('quit', () => { try { if (py && !py.killed) py.kill(); } catch {} });
