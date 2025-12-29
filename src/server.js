const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// HTTP服务器配置
const HTTP_PORT = 60888;
const WS_PORT = 60999;

// 存储所有连接的客户端
const clients = new Map();

// 创建HTTP服务器
const httpServer = http.createServer((req, res) => {
    if (req.url === '/index.html' || req.url === '/') {
        // 服务index.html文件
        fs.readFile(path.join(__dirname, '../public/index.html'), (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('File not found');
                return;
            }
            
            res.writeHead(200, {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-cache'
            });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not found');
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
            
            switch (message.type) {
                case 'join':
                    // 新用户加入
                    clientId = message.clientId;
                    clients.set(clientId, { ws, id: clientId });
                    
                    // 通知所有客户端更新用户列表
                    broadcastUserList();
                    break;
                    
                case 'offer':
                    // 转发offer给目标客户端
                    forwardMessage(message.target, {
                        type: 'offer',
                        from: message.from,
                        offer: message.offer
                    });
                    break;
                    
                case 'answer':
                    // 转发answer给目标客户端
                    forwardMessage(message.target, {
                        type: 'answer',
                        from: message.from,
                        answer: message.answer
                    });
                    break;
                    
                case 'ice-candidate':
                    // 转发ICE候选给目标客户端
                    forwardMessage(message.target, {
                        type: 'ice-candidate',
                        from: message.from,
                        candidate: message.candidate
                    });
                    break;
                    
                case 'file-info':
                    // 转发文件信息
                    forwardMessage(message.target, {
                        type: 'file-info',
                        from: message.from,
                        fileId: message.fileId,
                        fileName: message.fileName,
                        fileSize: message.fileSize,
                        fileType: message.fileType
                    });
                    break;
                    
                case 'file-chunk':
                    // 转发文件块
                    forwardMessage(message.target, {
                        type: 'file-chunk',
                        from: message.from,
                        fileId: message.fileId,
                        chunk: message.chunk,
                        isLast: message.isLast
                    });
                    break;
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
        const userList = Array.from(clients.values()).map(client => ({
            id: client.id,
            connected: client.ws.readyState === WebSocket.OPEN
        }));
        
        clients.forEach(client => {
            if (client.ws.readyState === WebSocket.OPEN) {
                // 发送除自己外的用户列表
                const otherUsers = userList.filter(user => user.id !== client.id);
                client.ws.send(JSON.stringify({
                    type: 'user-list',
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