const { app, BrowserWindow, Menu, globalShortcut, ipcMain, dialog, screen, shell } = require('electron');

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let py;
let windows = new Set();
const replyQueue = []; 

// --- simple JSON settings persisted in userData ---
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings(){
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch { return {}; }
}
function writeSettings(next){
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

function startPython() {
  const isPackaged = app.isPackaged;
  let pyCmd;
  let args = [];

  if (isPackaged) {
    const exePath = path.join(process.resourcesPath, 'python', 'service.exe');
    pyCmd = exePath;
  } else {
    pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    args = [path.join(__dirname, 'python', 'service.py')];
  }

  py = spawn(pyCmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

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

  if (!isPackaged) {
    py.stderr.on('data', d => process.stderr.write(`[py] ${d}`));
    py.on('close', code => console.warn(`[py] exited with code ${code}`));
  }
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

function createWindow() {
  const win = new BrowserWindow({
    useContentSize: true,
    show: false,
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
  win.webContents.once('did-finish-load', async () => {
    try {
      const { w, h } = await win.webContents.executeJavaScript(`(() => {
        const grid = document.querySelector('.content-grid');
        const pad = 0; // offsetWidth/Height already include padding
        if (grid) {
          return { w: Math.ceil(grid.offsetWidth + pad), h: Math.ceil(grid.offsetHeight + pad) };
        }
        return { w: Math.ceil(document.documentElement.scrollWidth), h: Math.ceil(document.documentElement.scrollHeight) };
      })();`);
      const display = screen.getDisplayMatching(win.getBounds());
      const maxH = Math.floor(display.workArea.height * 0.9);
      const maxW = Math.floor(display.workArea.width * 0.95);
      const EXTRA_W = 45;   // breathing room around cards
      const EXTRA_H = 40;   // account for status bar + spacing
      const MIN_W = 1030;   // ensure comfortable default width
      const MIN_H = 350;    // ensure comfortable default height
      const targetH = Math.max(MIN_H, Math.min(h + EXTRA_H, maxH));
      const targetW = Math.min(Math.max(MIN_W, w + EXTRA_W), maxW);
      win.setMinimumSize(MIN_W, MIN_H);
      win.setContentSize(targetW, targetH);
      win.center();
      win.show();
    } catch {}
  });
  if (!app.isPackaged) {
    globalShortcut.register('Control+Shift+I', () => {
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools({ mode: 'detach' });
    });
  }
}

ipcMain.handle('sys:showInFolder', (_evt, path) => {
  if (path) shell.showItemInFolder(path);
});

ipcMain.handle('sys:openFile', (_evt, path) => {
  if (path) shell.openPath(path);
});


ipcMain.handle('py:saveTemp', async (_evt, { arrayBuffer, ext = 'mp4' }) => {
  const safeExt = String(ext).replace(/^\./, '') || 'mp4';
  const tmpPath = path.join(os.tmpdir(), `autotrim-${Date.now()}.${safeExt}`);
  const buf = Buffer.from(new Uint8Array(arrayBuffer));
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
});

ipcMain.handle('py:send', async (_evt, payload) => {
  if (!py) return { ok: false, error: 'Python service not running' };
  try { return await pyRequest(payload); }
  catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('sys:chooseSave', async (_evt, opts = {}) => {
  try {
    const suggested = String(opts.suggestedName || 'trimmed.mp4');
    const st = readSettings();
    const baseDir = typeof st.defaultOutputDir === 'string' && st.defaultOutputDir ? st.defaultOutputDir : app.getPath('downloads');
    const defPath = path.join(baseDir, suggested);
    const res = await dialog.showSaveDialog({
      title: 'Choose output file',
      defaultPath: defPath,
      filters: [ { name: 'MP4 Video', extensions: ['mp4'] }, { name: 'All Files', extensions: ['*'] } ]
    });
    if (res.canceled) return { ok: false, cancelled: true };
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('sys:chooseOpen', async (_evt, opts = {}) => {
  try {
    const st = readSettings();
    const baseDir = typeof opts.defaultPath === 'string' && opts.defaultPath ? opts.defaultPath
                   : (typeof st.defaultInputDir === 'string' && st.defaultInputDir ? st.defaultInputDir : app.getPath('downloads'));
    const res = await dialog.showOpenDialog({
      title: 'Select video',
      defaultPath: baseDir,
      properties: ['openFile'],
      filters: [ { name: 'Video Files', extensions: ['mp4','mov','mkv','avi','webm'] }, { name: 'All Files', extensions: ['*'] } ]
    });
    if (res.canceled || !res.filePaths?.[0]) return { ok: false, cancelled: true };
    return { ok: true, path: res.filePaths[0] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('sys:chooseDir', async (_evt, opts = {}) => {
  try {
    const res = await dialog.showOpenDialog({
      title: String(opts.title || 'Select folder'),
      defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths?.[0]) return { ok: false, cancelled: true };
    return { ok: true, path: res.filePaths[0] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('sys:getSettings', async () => {
  const st = readSettings();
  return { ok: true, settings: st };
});
ipcMain.handle('sys:setSettings', async (_evt, partial = {}) => {
  const current = readSettings();
  const next = { ...current, ...partial };
  return { ok: writeSettings(next), settings: next };
});

ipcMain.handle('sys:pathJoin', async (_evt, a, b) => {
  try { return { ok: true, path: path.join(String(a||''), String(b||'')) }; }
  catch (e) { return { ok: false, error: String(e) }; }
});
ipcMain.handle('sys:fsStat', async (_evt, targetPath) => {
  try {
    const st = fs.statSync(String(targetPath));
    return { ok: true, size: st.size, isFile: st.isFile(), isDir: st.isDirectory() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

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
