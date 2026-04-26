# NVIDIA NIM MCP & Playground

Bộ công cụ sử dụng mô hình AI của NVIDIA (DeepSeek, Llama 3.1,...) tích hợp vào Antigravity IDE thông qua MCP.

## 🚀 Cách Setup trên máy tính mới (Máy tính công ty)

### Bước 1: Cài đặt Node.js
Đảm bảo máy tính đã cài đặt Node.js (phiên bản 18 trở lên).

### Bước 2: Clone project và Cài đặt thư viện
```bash
git clone <url-repo-cua-ban>
cd Nvidia
npm install
```

### Bước 3: Thiết lập biến môi trường (Environment Variables)
Bạn cần thiết lập API Key của NVIDIA vào máy tính. 
- **Windows (PowerShell)**:
  ```powershell
  [System.Environment]::SetEnvironmentVariable('NVIDIA_API_KEY', 'nvapi-YOUR_KEY_HERE', 'User')
  ```
- **Hoặc tạo file `.env`** trong thư mục gốc (không khuyến khích đẩy lên GitHub).

### Bước 4: Cấu hình MCP trong Antigravity IDE
Mở file `mcp_config.json` của IDE (thường ở `C:\Users\<User>\.gemini\antigravity\mcp_config.json`) và thêm:

```json
"nvidia-nim": {
  "command": "node",
  "args": ["D:/Path/To/Your/Project/tools/nvidia_mcp.mjs"],
  "env": {
    "NVIDIA_API_KEY": "nvapi-YOUR_ACTUAL_KEY_HERE"
  }
}
```

## 🛠 Các công cụ có sẵn

1. **Agent Chat**: Gõ `@nvidia` trong IDE sau khi cấu hình MCP.
2. **Playground UI**: 
   - Chạy: `npm start`
   - Truy cập: `http://localhost:3000`
3. **CLI Tool**:
   - Chạy: `node tools/nvidia-cli.mjs "Câu hỏi của bạn"`

---
*Ghi chú: Đừng bao giờ commit file có chứa API Key thực của bạn lên GitHub Public.*
