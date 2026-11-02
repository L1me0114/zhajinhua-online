# 云端部署：不用本地电脑当服务器

## 为什么会卡

现在的远程模式是：

```text
朋友的浏览器  →  Cloudflare 隧道  →  你的电脑
```

你的电脑既是服务器，又要通过校园网上传所有房间状态。校园网上行慢/抖动时，整桌都会卡，这是架构问题，不是代码问题。

把 `server.js` 放到一台公网云主机后：

```text
朋友的浏览器  →  云端 Node 服务
你的浏览器    →  云端 Node 服务
```

本地电脑和校园网只负责你自己的浏览器流量，不再承担服务器和隧道。

---

## 方案 A：Render 免费 Web Service（最省事）

适合：不想买服务器，朋友间临时玩。

### 1. 先放上 GitHub

Render 免费版需要一个 Git 仓库：

1. 解压 `zhajinhua-cloud.zip`。
2. GitHub 右上角 **New repository**，建一个空仓库（Public/Private 都行）。
3. 进入仓库 → **Add file → Upload files**，把解压出来的 `server.js`、`src/`、`public/`、`package.json`、`render.yaml` 等一起拖进去。
4. Commit。

> 不想用网页上传，也可以装 GitHub Desktop，把解压目录 Add local repository 后 Publish。

### 2. 在 Render 建服务

1. 打开 [Render](https://render.com/)，用 GitHub 登录。
2. **New → Web Service**，连接这个仓库。
3. 配置：
   - Runtime：**Node**
   - Build Command：`npm install --omit=dev`
   - Start Command：`node server.js`
   - Health Check Path：`/api/health`
   - Region：**Singapore**（离国内近）
   - Instance Type：**Free**
4. Deploy，等待生成 `https://xxxx.onrender.com`。
5. 把这个地址发给朋友；游戏里的「远程联机」会自动使用当前云端域名。

> Render 免费实例 15 分钟无活动会休眠，下一次访问冷启动约 30 秒；服务重启会清空内存房间。正在玩的时候有请求，不会中途休眠。
>
> 如果 Render 要求绑定付款方式，可以改用方案 B 的 VPS，或使用你已有的云服务器。

`render.yaml` 已经写好，Render 可以按 Blueprint 自动读取。

---

## 方案 B：自己的 VPS（最稳，推荐长期）

一台 1 核 512MB～1GB 的 Ubuntu 云服务器即可，国内/香港/新加坡都行。

### 1. 装 Node

```bash
sudo apt update
sudo apt install -y nodejs npm
node -v   # 需要 >= 18
```

如果系统源里的 Node 太旧，用 NodeSource 或 nvm 装 Node 22。

### 2. 上传项目

把 `zhajinhua` 目录（或 `zhajinhua-cloud.zip`）上传到服务器：

```bash
scp -r zhajinhua root@你的服务器IP:/opt/zhajinhua
```

### 3. 先手动跑一次

```bash
cd /opt/zhajinhua
PORT=8787 HOST=0.0.0.0 node server.js
```

浏览器访问 `http://服务器IP:8787`，能打开就说明服务正常。

### 4. 用 systemd 常驻

```bash
sudo tee /etc/systemd/system/zhajinhua.service >/dev/null <<'EOF'
[Unit]
Description=Zha Jin Hua
After=network.target

[Service]
WorkingDirectory=/opt/zhajinhua
ExecStart=/usr/bin/node server.js
Environment=PORT=8787
Environment=HOST=0.0.0.0
Environment=PUBLIC_URL=https://你的域名.com
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now zhajinhua
sudo systemctl status zhajinhua
```

### 5. 配 HTTPS 域名（推荐）

直接 `http://IP:8787` 也能玩，但部分手机浏览器对剪贴板、音效有限制。建议用 Caddy 自动 HTTPS：

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
你的域名.com {
    reverse_proxy 127.0.0.1:8787
}
EOF
sudo systemctl reload caddy
```

把域名 A 记录指向服务器 IP 即可。没有域名也可以先用 `IP.sslip.io` 这类泛解析域名配 HTTPS。

> 自定义 VPS 记得把 `PUBLIC_URL` 设成最终公网地址（`https://你的域名.com`），这样游戏里的「远程联机」会显示云端地址，而不是本地 LAN 地址。Render/Fly/Railway 会自动识别，不需要手动设。

### 6. 防火墙

只开放 22、80、443；8787 不需要对公网开放：

```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

---

## 方案 C：Docker / Railway / Fly.io

项目已经带：

- `Dockerfile`
- `Procfile`
- `fly.toml`

支持 Docker 的平台可以直接构建运行；容器内监听 `0.0.0.0:8787`，平台注入 `PORT` 时会自动使用平台端口。

---

## 部署后检查

1. 打开 `https://你的域名/api/health`，应返回 `{"ok":true,...}`。
2. 打开首页，创建房间。
3. 点「远程联机」，面板应该显示云端域名，而不是 `trycloudflare.com`。
4. 用手机流量打开链接，确认能加入。
5. 打一局，确认积分结算正常。

---

## 重要说明

- 房间在**内存**里，云端服务重启/休眠会清空；要长期保留需要数据库。
- 房间号 6 位、默认私密；公网部署后仍然只把链接发给朋友。
- 如果部署在 Render 免费实例，第一次打开可能冷启动 30 秒，等页面出来即可。
- 部署到云端后，**不需要** `start-remote.bat`、Cloudflare 隧道或本地电脑常开。
