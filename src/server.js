const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// HTTP服务器配置
const HTTP_PORT = 60888;
const WS_PORT = 60999;

// 存储所有连接的客户端
const clients = new Map();

// 对不同文件类型返回不同的响应头
const fileTypeResponseHeaders = new Map([
    [
        'html',
        {
            'Content-Type': 'text/html',
            'Cache-Control': 'max-age=86400',
        }
    ],
    [
        'ico',
        {
            'Content-Type': 'image/x-icon',
            'Cache-Control': 'max-age=86400'
        }
    ],
    [
        'css',
        {
            'Content-Type': 'text/css',
            'Cache-Control': 'max-age=86400'
        }
    ],
    [
        'js',
        {
            'Content-Type': 'application/x-javascript',
            'Cache-Control': 'max-age=86400'
        }
    ],
])

// 创建HTTP服务器
const httpServer = http.createServer((req, res) => {
    let { url } = req;
    if (url === '/') url = '/index.html';
    let filePath = path.join(__dirname, `../public${url}`);

    if (fs.existsSync(filePath)) {
        let extName = path.extname(filePath).replace(/^\.{1}/, '');

        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('File not found');
                return;
            }

            res.writeHead(200, fileTypeResponseHeaders.get(extName));
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('404 Not found');
    }
});

// 创建WebSocket服务器
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (ws) => {
    let clientId = null;
    console.log('新的客户端连接');

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log('收到消息:', message.type, '来自:', message.from);

            if (message.type === 'register') {
                // 新用户加入
                let { from, status } = message;
                clientId = from;
                clients.set(from, { ws, id: from, status: status });
                broadcastUserList();
            } else if (message.type === 'update-status') {
                // 更新用户状态
                let { from, status } = message;
                let client = clients.get(from);
                client.status = status;
                clients.set(from, client);
                broadcastUserList();
            } else if (message.type === 'rename') {
                // 用户重命名
                let { from, newFrom } = message;
                let client = clients.get(from);
                if (clients.has(newFrom)) {
                    // 用户名已存在
                    client.ws.send(JSON.stringify({
                        type: 'rename-error',
                        message: '用户名已存在',
                    }));
                } else {
                    // 更新用户名
                    clients.delete(from);
                    client.id = newFrom;
                    clients.set(newFrom, client);
                    client.ws.send(JSON.stringify({
                        type: 'rename-success',
                        newFrom,
                    }));

                    broadcastUserList();
                }
            } else if (message.type === 'peer-handshake') {
                // 转发peer-handshake给目标客户端
                forwardMessage(message.target, message);
            }

        } catch (error) {
            console.error('消息处理错误:', error);
        }
    });

    ws.on('close', () => {
        console.log('客户端断开连接:', clientId);
        if (clientId) {
            clients.delete(clientId);
            broadcastUserList();
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket错误:', error);
    });

    // 转发消息给指定客户端
    function forwardMessage(targetId, message) {
        const targetClient = clients.get(targetId);
        if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
            targetClient.ws.send(JSON.stringify(message));
        }
    }

    // 广播用户列表给所有客户端
    function broadcastUserList() {
        const userList = Array.from(clients.values())
            .filter(client => client.ws.readyState === WebSocket.OPEN)
            .map(client => ({
                ...client,
                ws: undefined,
            }));

        clients.forEach(client => {
            if (client.ws.readyState === WebSocket.OPEN) {
                // 发送除自己外的用户列表
                const otherUsers = userList.filter(user => user.id !== client.id);
                client.ws.send(JSON.stringify({
                    type: 'update-user-list',
                    users: otherUsers
                }));
            }
        });
    }
});

// 启动服务器
httpServer.listen(HTTP_PORT, () => {
    console.log(`HTTP服务器运行在 http://localhost:${HTTP_PORT}`);
});

wss.on('listening', () => {
    console.log(`WebSocket服务器运行在端口 ${WS_PORT}`);
});

console.log('服务器启动完成');