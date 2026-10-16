const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const http = require('http');
const crypto = require('crypto');

const SOURCE_ROOT = path.resolve(__dirname, '../..');
let mainWindow = null;
let cleaningUp = false;
let quitRequested = false;
let externalApiServer = null;
let externalJobActive = false;

const EXTERNAL_API_HOST = '127.0.0.1';
const EXTERNAL_API_PORT = 32145;
const EXTERNAL_API_TOKEN = crypto.randomBytes(32).toString('hex');

function sendJson(res, statusCode, data) {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function startExternalApi() {
  if (externalApiServer) return;

  const tokenFile = path.join(app.getPath('userData'), 'external-api-token.txt');
  fs.writeFileSync(tokenFile, EXTERNAL_API_TOKEN, { encoding: 'utf8' });

  externalApiServer = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/process') {
      sendJson(res, 404, { success: false, error: 'Not found' });
      return;
    }

    if (req.headers.authorization !== `Bearer ${EXTERNAL_API_TOKEN}`) {
      sendJson(res, 401, { success: false, error: 'Unauthorized' });
      return;
    }

    if (externalJobActive) {
      sendJson(res, 409, {
        success: false,
        error: 'Another external job is running',
      });
      return;
    }

    let rawBody = '';
    try {
      for await (const chunk of req) {
        rawBody += chunk.toString('utf8');
        if (Buffer.byteLength(rawBody, 'utf8') > 64 * 1024) {
          sendJson(res, 413, { success: false, error: 'Request too large' });
          return;
        }
      }

      const payload = JSON.parse(rawBody);
      const filePath = typeof payload.filePath === 'string' ? payload.filePath.trim() : '';

      if (!filePath || !path.isAbsolute(filePath)) {
        sendJson(res, 400, {
          success: false,
          error: 'filePath must be an absolute path',
        });
        return;
      }

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(res, 400, {
          success: false,
          filePath,
          error: 'Video file does not exist',
        });
        return;
      }

      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
        sendJson(res, 503, {
          success: false,
          error: 'Application window is not ready',
        });
        return;
      }

      externalJobActive = true;
      const jobId = crypto.randomUUID();

      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            ipcMain.removeListener('external-process-result', onResult);
            reject(new Error('Processing timed out after 2 hours'));
          }, 2 * 60 * 60 * 1000);

          function onResult(_event, message) {
            if (!message || message.jobId !== jobId) return;

            clearTimeout(timeout);
            ipcMain.removeListener('external-process-result', onResult);
            resolve(message.result);
          }

          ipcMain.on('external-process-result', onResult);

          mainWindow.webContents.send('external-process-request', {
            jobId,
            filePath,
          });
        });

        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, {
          success: false,
          filePath,
          error: error.message || String(error),
        });
      } finally {
        externalJobActive = false;
      }
    } catch (error) {
      sendJson(res, 400, {
        success: false,
        error: `Invalid request: ${error.message}`,
      });
    }
  });

  externalApiServer.on('error', (error) => {
    console.error('[External API] Server error:', error);
  });

  externalApiServer.listen(EXTERNAL_API_PORT, EXTERNAL_API_HOST, () => {
    console.log(
      `[External API] Listening on http://${EXTERNAL_API_HOST}:${EXTERNAL_API_PORT}/process`
    );
    console.log(`[External API] Token file: ${tokenFile}`);
  });
}

try {
  app.setName('WhisperSubTranslate');
  app.setAppUserModelId('com.whispersubtranslate.app');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
} catch (error) {
  console.warn('[App] Failed to apply desktop identity:', error.message);
}

function resolvePortableUserData() {
  if (process.env.WHISPER_PORTABLE_DATA) return process.env.WHISPER_PORTABLE_DATA;
  const executableDirectory = app.isPackaged ? path.dirname(process.execPath) : SOURCE_ROOT;
  const marker = path.join(executableDirectory, 'portable-data');
  return fs.existsSync(marker) ? marker : null;
}

try {
  const portableDirectory = resolvePortableUserData();
  if (portableDirectory) {
    fs.mkdirSync(portableDirectory, { recursive: true });
    app.setPath('userData', portableDirectory);
  }
} catch (error) {
  console.warn('[Portable] Failed to redirect userData:', error.message);
}

// Portable userData must be selected before loading services: translator and model
// modules resolve their persistent paths during initialization.
const transcription = require('./services/transcription');
const errLogger = require('./services/error-logger');
const { createWindow } = require('./window');
const { registerTranscriptionHandlers } = require('./ipc/transcription');
const { registerTranslationHandlers } = require('./ipc/translation');
const { registerModelHandlers, cleanupModels } = require('./ipc/models');
const { registerFileHandlers } = require('./ipc/files');
const { registerHistoryHandlers } = require('./ipc/history');
const { checkForUpdates, registerSettingsHandlers } = require('./ipc/settings');

errLogger.setElectronApp(app);
registerTranscriptionHandlers(ipcMain, transcription);
registerTranslationHandlers(ipcMain, transcription.translator);
registerModelHandlers(ipcMain, transcription, () => mainWindow);
registerFileHandlers(ipcMain, () => mainWindow);
registerHistoryHandlers(ipcMain, app);
registerSettingsHandlers(ipcMain, app, transcription);

process.on('uncaughtException', (error) => {
  errLogger.logError('main:uncaughtException', error?.message || String(error), error);
  console.error('[uncaughtException]', error);
});
process.on('unhandledRejection', (reason) => {
  errLogger.logError('main:unhandledRejection', reason?.message || String(reason), reason);
  console.error('[unhandledRejection]', reason);
});

function openMainWindow() {
  mainWindow = createWindow(app, transcription, checkForUpdates);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  if (!app.isPackaged) {
    app.commandLine.appendSwitch('js-flags', '--expose-gc');
    try {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData();
    } catch (error) {
      console.log('[Cache] Failed to clear cache:', error.message);
    }
  }
  // 로컬 번역(CUDA)이 처음 초기화되기 전에 저장된 GPU 지정을 적용한다.
  try {
    transcription.applyGpuSelection(transcription.translator.loadApiKeys()?.selectedDevice);
  } catch (error) {
    console.warn('[GPU] Failed to apply saved GPU selection:', error.message);
  }
  openMainWindow();
  startExternalApi();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
});
app.on('child-process-gone', (_event, details) => {
  if (details?.reason && details.reason !== 'clean-exit') {
    console.error('[child-process-gone]', JSON.stringify(details));
    errLogger.logError('main:child-process-gone', `${details.type}:${details.reason}`, details);
  }
});
app.on('before-quit', (event) => {
  if (quitRequested) return;
  event.preventDefault();
  if (cleaningUp) return;
  cleaningUp = true;
  transcription.stop();
  if (externalApiServer) {
    externalApiServer.close();
    externalApiServer = null;
  }
  Promise.allSettled([cleanupModels(), transcription.forceMemoryCleanup('cuda', true)]).finally(() => {
    cleaningUp = false;
    quitRequested = true;
    app.quit();
  });
});

process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
