import { app, BrowserWindow } from 'electron';
import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let serverProcess;
const SERVER_PORT = Number(process.env.PORT || 3000);
const SERVER_HOST = process.env.HOST || process.env.NVIDIA_SERVER_HOST || '127.0.0.1';
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;

async function createWindow() {
    // 1. Kiểm tra xem Server đã chạy chưa bằng cách thử kết nối
    const net = await import('net');
    const checkPort = (port) => new Promise(res => {
        const s = new net.Socket();
        s.once('error', () => res(false));
        s.once('connect', () => { s.end(); res(true); });
        s.connect(port, '127.0.0.1');
    });

    const isRunning = await checkPort(SERVER_PORT);
    
    if (!isRunning) {
        console.log("Khởi động server mới...");
        serverProcess = fork(path.join(__dirname, 'tools', 'nvidia-server.mjs'), [], {
            cwd: __dirname,
            silent: true
        });
        serverProcess.stdout.on('data', (data) => console.log(`[Server]: ${data}`));
        serverProcess.stderr.on('data', (data) => console.error(`[Server Error]: ${data}`));
    } else {
        console.log("Phát hiện server đang chạy, sử dụng server hiện có.");
    }

    // 2. Tạo cửa sổ ứng dụng
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        title: "NVIDIA NIM Agent IDE - Desktop v3.3",
        backgroundColor: '#0b0e14',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Bỏ thanh menu mặc định để trông "xịn" hơn
    win.setMenuBarVisibility(false);

    // 3. Đợi server khởi động xong rồi mới load trang
    const startApp = () => {
        win.loadURL(SERVER_URL).catch(() => {
            console.log("Đang chờ server...");
            setTimeout(startApp, 1000);
        });
    };

    setTimeout(startApp, 2000);

    win.on('closed', () => {
        if (serverProcess) serverProcess.kill();
        app.quit();
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (serverProcess) serverProcess.kill();
        app.quit();
    }
});
