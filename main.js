const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
// E3 (аудит): БД в userData — в собранном .exe/.dmg программная папка только для чтения (asar),
// server.js:21 читает process.env.DATA_DIR до своего require (dotenv его не затирает)
process.env.DATA_DIR = process.env.DATA_DIR || app.getPath('userData');
const { startServer } = require('./server/server');

let mainWindow = null;
let apiServer = null;
const UI_PORT = 3000;

async function createWindow(){
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    title: 'NOVA',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);

  // E2: подписка ДО loadURL — иначе ready-to-show может пролететь и окно останется скрытым
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadURL('http://127.0.0.1:' + UI_PORT + '/');
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // E4: наружу уходят только http/https/mailto (файл/скриптовые/custom схемы — блок)
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action:'deny' };
  });
  // E4 (аудит): навигация страницы только по своему UI (+ OAuth Discord — 302 с /api/auth/discord
  // уводит на discord.com, иначе логин в Electron сломается); всё остальное — наружу/блок
  mainWindow.webContents.on('will-navigate', (e, url) => {
    let u; try { u = new URL(url); } catch { e.preventDefault(); return; }
    const isSelf = u.origin === 'http://127.0.0.1:' + UI_PORT;
    const isDiscordOAuth = u.origin === 'https://discord.com';
    if(!isSelf && !isDiscordOAuth){
      e.preventDefault();
      if(/^(https?:|mailto:)/i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });
}

async function bootstrap(){
  try{
    apiServer = await startServer({host:'127.0.0.1',port:UI_PORT});
    await createWindow();
  }catch(error){
    console.error('[NOVA] startup failed:', error);
    dialog.showErrorBox('NOVA — ошибка запуска',
      'Не удалось запустить приложение:\n' + ((error && error.message) || error));
    app.quit();
  }
}

// E5: вторая копия не стучится в занятый порту, а фокусирует первое окно
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if(!gotSingleInstanceLock){
  app.quit();
}else{
  app.on('second-instance', () => {
    if(mainWindow){
      if(mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(bootstrap);
}
// E1: на macOS activate только восстанавливает окно — сервер уже работает,
// повторный startServer дал бы EADDRINUSE и app.quit()
app.on('activate', () => { if(BrowserWindow.getAllWindows().length===0)createWindow().catch(() => {}); });
app.on('before-quit', () => { if(apiServer){ try{apiServer.close();}catch(_){} apiServer=null; } });
app.on('window-all-closed', () => { if(process.platform!=='darwin')app.quit(); });
