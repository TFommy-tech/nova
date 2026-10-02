const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const { startServer } = require('./server/server');

let mainWindow = null;
let apiServer = null;

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

  await mainWindow.loadURL('http://127.0.0.1:3000/');

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action:'deny' };
  });
}

async function bootstrap(){
  try{
    apiServer = await startServer({host:'127.0.0.1',port:3000});
    await createWindow();
  }catch(error){
    console.error('[NOVA] startup failed:', error);
    app.quit();
  }
}

app.whenReady().then(bootstrap);
app.on('activate', () => { if(BrowserWindow.getAllWindows().length===0)bootstrap(); });
app.on('before-quit', () => { if(apiServer){ try{apiServer.close();}catch(_){} apiServer=null; } });
app.on('window-all-closed', () => { if(process.platform!=='darwin')app.quit(); });
