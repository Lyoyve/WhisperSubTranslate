const path = require('path');
const { spawn } = require('child_process');
const { dialog, shell } = require('electron');
const C = require('../../shared/ipc-channels');
const fs = require('fs/promises');

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'huggingface.co',
  'platform.openai.com',
  'openai.com',
  'ai.google.dev',
  'aistudio.google.com',
  'deepl.com',
  'www.deepl.com',
]);

function isAllowedExternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || !ALLOWED_EXTERNAL_HOSTS.has(url.hostname.toLowerCase())) return false;
    if (url.hostname.toLowerCase() === 'github.com') {
      const pathname = url.pathname.replace(/\/$/, '');
      if (!/^\/[\w.-]+\/[\w.-]+(\/[\w./+-]*)?$/.test(pathname) || pathname.split('/').includes('..')) return false;
    }
    return true;
  } catch (_error) {
    return false;
  }
}

function isSafeLocalPath(candidate) {
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length < 4096 && !candidate.includes('\0');
}

function openWithXdg(targetPath) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => done(false), 5000);
    timer.unref?.();
    try {
      const process = spawn('xdg-open', [targetPath], { stdio: 'ignore', detached: true });
      process.on('error', () => done(false));
      process.on('exit', (code) => done(code === 0));
      process.unref();
    } catch (_error) {
      done(false);
    }
  });
}

async function openPathSafely(targetPath) {
  const timedOut = Symbol('timeout');
  let timer;
  try {
    const result = await Promise.race([
      shell.openPath(targetPath),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timedOut), 3000);
        timer.unref?.();
      }),
    ]);
    if (result !== timedOut && !result) return true;
    return process.platform === 'linux' ? openWithXdg(targetPath) : false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function registerFileHandlers(ipcMain, getMainWindow) {
  ipcMain.handle(C.SHOW_OPEN_DIALOG, (_event, options) => dialog.showOpenDialog(getMainWindow(), options));
  ipcMain.handle(C.SCAN_VIDEO_FILES_RECURSIVE, async (_event, folderPath) => {
    try {
      if (typeof folderPath !== 'string' || !folderPath.trim()) {
        return { success: false, error: '文件夹路径无效' };
      }

      const stat = await fs.stat(folderPath);

      if (!stat.isDirectory()) {
        return { success: false, error: '所选路径不是文件夹' };
      }

      const filePaths = await scanVideoFilesRecursive(folderPath);

      return {
        success: true,
        filePaths,
        count: filePaths.length,
      };
    } catch (error) {
      console.error('[FolderScan] Failed:', error);
      return {
        success: false,
        error: error.message || '扫描文件夹失败',
      };
    }
  });
  ipcMain.handle(C.OPEN_FILE_LOCATION, async (_event, filePath) => {
    if (!isSafeLocalPath(filePath)) return { success: false, error: 'invalid path' };
    try {
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (error) {
      if (process.platform === 'linux' && (await openWithXdg(path.dirname(filePath)))) return { success: true };
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle(C.OPEN_FOLDER, async (_event, folderPath) => {
    if (!isSafeLocalPath(folderPath)) return { success: false, error: 'invalid path' };
    try {
      return (await openPathSafely(folderPath)) ? { success: true } : { success: false, error: 'no handler available' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle(C.OPEN_EXTERNAL, async (_event, url) => {
    if (!isAllowedExternalUrl(url)) return { success: false, error: 'URL not allowed' };
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm',
  '.m4v', '.ts', '.mts', '.m2ts', '.mpg', '.mpeg', '.3gp',
]);

async function scanVideoFilesRecursive(folderPath) {
  const results = [];

  async function walk(currentPath) {
    let entries;

    try {
      entries = await fs.readdir(currentPath, {
        withFileTypes: true,
      });
    } catch (error) {
      // 个别子目录无法访问时跳过，继续扫描其他目录
      console.warn('[FolderScan] Cannot read directory:', currentPath, error.message);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (
        entry.isFile() &&
        SUPPORTED_VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        results.push(fullPath);
      }
    }
  }

  await walk(folderPath);

  results.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
  );

  return results;
}

module.exports = { isAllowedExternalUrl, openPathSafely, registerFileHandlers };
