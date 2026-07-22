const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, screen, session, desktopCapturer, shell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createLLM } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { rms16 } = require('./src/wav');
const { saveRecap } = require('./src/recap-export');

let win = null;
let tray = null;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts }
const FLUSH_MS = 2200;
const MIN_BYTES = Math.floor(16000 * 2 * 0.6); // ~0.6s
const RMS_GATE = 240;
let flushTimer = null;
let captureGeneration = 0;
const STOP_DRAIN_MS = 300;
let finalizingGeneration = null;
const pendingTranscriptions = { you: null, them: null };
const ASSIST_IDLE_MS = 700;
let assistActive = false;
let assistTimer = null;
let assistQueued = false;
let assistTurnCount = 0;

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

const SCREEN_HINTS = ['экран', 'скрин', 'код', 'задач', 'leetcode', 'ошибк', 'сайт', 'страниц', 'кнопк', 'таблиц', 'консол', 'терминал', 'интерфейс', 'формул', 'график'];
function shouldCaptureScreen(mode, userText) {
  if (mode === 'leetcode') return true;
  if (mode !== 'assist' && mode !== 'ask') return false;
  if (mode === 'assist' && !userText) return false;
  const context = [userText || '', ...transcript.slice(-6).map((turn) => turn.text)].join(' ').toLowerCase();
  return SCREEN_HINTS.some((hint) => context.includes(hint));
}

const DUPLICATE_WINDOW_MS = 12000;
function normalizeSpeech(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function isDuplicateTurn(channel, text) {
  const normalized = normalizeSpeech(text);
  if (normalized.length < 6) return false;
  const words = new Set(normalized.split(' '));
  return transcript.slice(-12).some((previous) => {
    if (Date.now() - previous.ts > DUPLICATE_WINDOW_MS) return false;
    const previousNormalized = normalizeSpeech(previous.text);
    if (normalized === previousNormalized) return true;
    const previousWords = new Set(previousNormalized.split(' '));
    if (words.size < 4 || previousWords.size < 4) return false;
    let intersection = 0;
    words.forEach((word) => { if (previousWords.has(word)) intersection += 1; });
    const similarity = intersection / (words.size + previousWords.size - intersection);
    const shorter = Math.min(normalized.length, previousNormalized.length);
    if (channel === previous.channel && shorter >= 18 && (normalized.includes(previousNormalized) || previousNormalized.includes(normalized))) return true;
    return similarity >= (channel === previous.channel ? 0.55 : 0.78);
  });
}

function needsReply(text) {
  const value = text.trim().toLowerCase();
  return value.includes('?') || /^(что|как|где|когда|почему|зачем|кто|какой|можешь|можно|нужно|будешь|ты\s)/i.test(value) || /\b(подскажи|объясни|помоги|выбери|реши|ответь|что думаешь|как считаешь)\b/i.test(value);
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide();
  else { win.showInactive(); win.focus(); }
  updateTrayMenu();
}

function hideToTray() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const visible = !!(win && !win.isDestroyed() && win.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? 'Скрыть cue' : 'Показать cue', click: toggleWindow },
    { label: 'Настройки', click: () => { if (win && !win.isDestroyed()) { win.showInactive(); send('settings:open'); } } },
    { type: 'separator' },
    { label: 'Выйти', click: () => app.quit() }
  ]));
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAUklEQVR4nM2TwQoAIAhDXf//z+uc6ZIocFfnc6CadRNUkSQXM5D6UQF4RUAoiG+gqG2QU5rMN+y1WEyT+Z8lGu1A/baGaNrNQeLbi5gAyrdopwlK7E/hnNmM7QAAAABJRU5ErkJggg==')
    .resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('cue');
  tray.on('click', toggleWindow);
  tray.on('right-click', updateTrayMenu);
  updateTrayMenu();
}

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;
  win = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: workArea.y + 6,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Invisibility + overlay behavior. Set CUE_NO_PROTECT=1 to disable for debugging.
  win.setContentProtection(!process.env.CUE_NO_PROTECT);            // excluded from screen capture (best-effort)
  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'floating', 1);
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => win.showInactive());
  win.webContents.on('render-process-gone', (_e, d) => console.log('[cue] renderer gone', JSON.stringify(d)));
}

// -------- STT flushing --------
async function flushChannel(channel, options = {}) {
  if (pendingTranscriptions[channel]) return pendingTranscriptions[channel];
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const generation = options.generation === undefined ? captureGeneration : options.generation;
  const allowStopped = options.allowStopped === true;
  const allowShort = options.allowShort === true;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES && !allowShort) return;
  if (rms16(pcm) < RMS_GATE) return; // silence gate

  state.transcribing[channel] = true;
  const task = (async () => {
    try {
      const settings = store.getSettings();
      const stt = createSTT(settings);
      if (!stt.available) {
        if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription key set. Add an OpenAI (Whisper) or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
        return;
      }
      const res = await stt.transcribe(pcm);
      if (res.error) {
        if (generation === captureGeneration && (state.capturing || allowStopped)) handleSttError(res.error, settings);
        return;
      }
      if ((!state.capturing && !allowStopped) || generation !== captureGeneration) return;
      const text = res.text && res.text.trim();
      if (text && !isDuplicateTurn(channel, text)) {
        const turn = { channel, text, ts: Date.now() };
        transcript.push(turn);
        send('transcript', turn);
        if (channel === 'them' && needsReply(text)) scheduleAutoAssist();
      }
    } catch (e) {
      console.log('[stt] error', e && e.message);
    }
  })();
  pendingTranscriptions[channel] = task;
  try {
    await task;
  } finally {
    if (pendingTranscriptions[channel] === task) pendingTranscriptions[channel] = null;
    state.transcribing[channel] = false;
  }
}

async function waitForTranscriptions() {
  const pending = Object.values(pendingTranscriptions).filter(Boolean);
  if (pending.length) await Promise.all(pending);
}

function scheduleAutoAssist() {
  clearTimeout(assistTimer);
  if (!assistActive || !state.capturing) return;
  assistTimer = setTimeout(() => {
    assistTimer = null;
    if (!assistActive || !state.capturing || transcript.length <= assistTurnCount) return;
    if (state.busy) {
      assistQueued = true;
      return;
    }
    assistTurnCount = transcript.length;
    runFeature('assist', '');
  }, ASSIST_IDLE_MS);
}

function setAssistActive(active) {
  assistActive = active;
  assistQueued = false;
  clearTimeout(assistTimer);
  assistTimer = null;
  if (active) {
    assistTurnCount = transcript.length;
    send('status', { message: 'Помощь в реальном времени включена.' });
  } else {
    send('status', { message: 'Помощь в реальном времени выключена.' });
  }
  return active;
}

async function finalizeCapture(generation) {
  try {
    await new Promise((resolve) => setTimeout(resolve, STOP_DRAIN_MS));
    await waitForTranscriptions();
    if (state.capturing || generation !== captureGeneration) return;

    await Promise.all([
      flushChannel('you', { generation, allowStopped: true, allowShort: true }),
      flushChannel('them', { generation, allowStopped: true, allowShort: true })
    ]);
    if (state.capturing || generation !== captureGeneration) return;

    if (!transcript.length) {
      send('status', { message: 'Не удалось распознать речь для итогов созвона.' });
      return;
    }
    send('status', { message: 'Транскрипция готова. Готовлю итог созвона...' });
    await runFeature('recap', '');
  } finally {
    if (finalizingGeneration === generation) finalizingGeneration = null;
  }
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  if (sttDisabled) return;
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found';
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: 'Transcription off: your ' + err.provider + ' key has no access to a speech-to-text model (403). Screen + LeetCode still work. To enable listening: give the key Whisper/transcription access, or add a Gemini key in Settings and reopen.' });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

function openRecapInMarkEdit(filePath) {
  if (process.platform !== 'darwin') {
    shell.openPath(filePath).catch((error) => console.log('[recap] open error', error && error.message));
    return;
  }

  execFile('/usr/bin/open', ['-a', 'MarkEdit', filePath], (error) => {
    if (!error) return;
    // MarkEdit may not be installed or may not be registered by its bundle name.
    // Opening through the default file association still makes the export useful.
    shell.openPath(filePath).catch((fallbackError) => console.log('[recap] open error', fallbackError && fallbackError.message));
  });
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
function setCapturing(active) {
  captureGeneration += 1;
  state.capturing = active;
  const stoppedGeneration = active ? null : captureGeneration;
  if (active) {
    finalizingGeneration = null;
    sttDisabled = false;
    transcript.length = 0;
    buffers.you = []; buffers.them = [];
    assistTurnCount = 0;
    assistQueued = false;
    startFlushLoop();
  } else {
    finalizingGeneration = stoppedGeneration;
    clearTimeout(assistTimer);
    assistTimer = null;
    assistQueued = false;
    stopFlushLoop();
  }
  send('capture:state', { active });
  if (stoppedGeneration !== null) {
    send('status', { message: 'Запись остановлена. Догружаю последние фразы...' });
    finalizeCapture(stoppedGeneration).catch((e) => console.log('[recap] error', e && e.message));
  }
  return active;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings, { fast: mode === 'assist', maxTokens: mode === 'assist' ? 450 : undefined });
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null);
    const appendResponse = (mode === 'assist' && assistActive) || mode === 'recap';
    send('llm:start', { userBubble, small: !!def.small, append: appendResponse, responseLabel: mode === 'recap' ? 'Итог' : 'Помощь' });

    if (!llm.ready) {
      send('llm:error', { message: 'Add your ' + settings.provider + ' API key in Settings (gear icon) to start. Model: ' + (llm.model || 'unset') + '.' });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen && shouldCaptureScreen(mode, userText)) {
      if (!state.capturing && !def.screenOptional) {
        send('llm:error', { message: 'Сначала включите запись, чтобы cue получил доступ к экрану.' });
        return;
      }
      if (state.capturing) {
        try { imageDataUrl = await captureScreenshot(); }
        catch (e) { send('status', { message: 'Screen capture needs permission — grant Screen Recording to cue in System Settings.' }); }
      }
    }

    const built = def.build({ transcript, userText: userText || '' });
    const output = await llm.stream({
      system: def.system,
      turns: [{ role: 'user', text: built }],
      imageDataUrl,
      onToken: (t) => send('llm:token', { text: t })
    });
    const suppress = mode === 'assist' && /^NO_ACTION[.!]?$/i.test(String(output || '').trim());
    let savedRecap = null;
    if (mode === 'recap' && output && String(output).trim()) {
      try {
        savedRecap = await saveRecap({
          documentsPath: app.getPath('documents'),
          summary: output,
          transcript: [...transcript]
        });
        send('status', { message: `Итог сохранён: ${savedRecap.fileName}` });
        openRecapInMarkEdit(savedRecap.filePath);
      } catch (error) {
        console.log('[recap] save error', error && error.message);
        send('status', { message: 'Итог готов, но не удалось сохранить Markdown-файл.' });
      }
    }
    send('llm:done', { suppress, recapFile: savedRecap && savedRecap.filePath });
  } catch (e) {
    send('llm:error', { message: 'Error: ' + (e && e.message ? e.message : String(e)) });
  } finally {
    state.busy = false;
    if (mode === 'assist' && assistActive && state.capturing && assistQueued) {
      assistQueued = false;
      scheduleAutoAssist();
    }
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => { sttDisabled = false; return store.setSettings(patch); });
ipcMain.handle('assist:toggle', () => setAssistActive(!assistActive));
ipcMain.handle('capture:toggle', () => setCapturing(!state.capturing));
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing || finalizingGeneration === captureGeneration) buffers.you.push(Buffer.from(arrayBuffer)); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing || finalizingGeneration === captureGeneration) buffers.them.push(Buffer.from(arrayBuffer)); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
ipcMain.on('open-pane', (_e, url) => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('settings:open', () => send('settings:open'));
ipcMain.on('window:hide-to-tray', hideToTray);
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));

// -------- shortcuts --------
function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Return', () => runFeature('assist', ''));
  globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  globalShortcut.register('CommandOrControl+Shift+T', hideToTray);
  globalShortcut.register('CommandOrControl+Shift+X', () => app.quit());
}

// -------- lifecycle --------
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length) callback({ video: sources[0], audio: 'loopback' });
      else callback();
    }).catch(() => callback());
  }, { useSystemPicker: false });

  createWindow();
  createTray();
  registerShortcuts();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => app.quit());
