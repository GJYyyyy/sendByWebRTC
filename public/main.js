
class FileTransferApp {
    constructor() {
        this.clientId = this.generateId();
        this.ws = null;
        this.peerConnection = null;
        this.dataChannel = null;
        this.connectedUser = null;
        this.users = [];
        this.pendingFiles = new Map();
        this.receivedFiles = new Map();

        this.initializeElements();
        this.connectWebSocket();
        this.setupEventListeners();
    }

    /**
     * 生成随机ID
     * @returns {string}
     */
    generateId() {
        return Math.random().toString(36).substring(2) + Date.now().toString(36);
    }

    initializeElements() {
        this.myId = document.getElementById('myId');
        this.statusElement = document.getElementById('status');
        this.userListElement = document.getElementById('userList');
        this.connectBtn = document.getElementById('connectBtn');
        this.sendSection = document.getElementById('sendSection');
        this.waitingConnection = document.getElementById('waitingConnection');
        this.fileInput = document.getElementById('fileInput');
        this.sendBtn = document.getElementById('sendBtn');
        this.sendProgress = document.getElementById('sendProgress');
        this.sendProgressBar = document.getElementById('sendProgressBar');
        this.sendStatus = document.getElementById('sendStatus');
        this.receiveList = document.getElementById('receiveList');
        this.connectionInfo = document.getElementById('connectionInfo');
        this.connectedUserSpan = document.getElementById('connectedUser');
    }

    connectWebSocket() {
        const wsUrl = `ws://${window.location.hostname}:60999`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this.updateStatus('connected', '✅ 已连接到服务器');
            this.ws.send(JSON.stringify({
                type: 'join',
                from: this.clientId,
            }));
            this.myId.value = this.clientId;
        };

        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            this.handleMessage(message);
        };

        this.ws.onclose = () => {
            this.updateStatus('disconnected', '❌ 连接断开，正在重连...');
            setTimeout(() => this.connectWebSocket(), 3000);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket错误:', error);
        };
    }

    handleMessage(message) {
        switch (message.type) {
            case 'rename-success':
                this.clientId = message.newClientId;
                break;
            case 'rename-error':
                alert(message.message);
                this.myId.value = message.clientId;
                break;
            case 'user-list':
                this.updateUserList(message.users);
                break;
            case 'offer':
                this.handleOffer(message);
                break;
            case 'answer':
                this.handleAnswer(message);
                break;
            case 'ice-candidate':
                this.handleIceCandidate(message);
                break;
            case 'file-info':
                this.handleFileInfo(message);
                break;
            case 'file-chunk':
                this.handleFileChunk(message);
                break;
        }
    }

    updateUserList(users) {
        this.users = users;
        this.userListElement.innerHTML = '';

        if (users.length === 0) {
            this.userListElement.innerHTML = '<li>暂无其他在线用户</li>';
            this.connectBtn.disabled = true;
            this.connectBtn.textContent = '选择用户连接';
            return;
        }

        users.forEach(user => {
            const li = document.createElement('li');
            li.className = 'user-item';
            li.innerHTML = `
                        <span>用户 ${user.id}</span>
                        <span style="color: #28a745;">● 在线</span>
                    `;

            li.onclick = () => this.connectToUser(user.id);

            this.userListElement.appendChild(li);
        });

        this.connectBtn.disabled = false;
        this.connectBtn.textContent = '选择用户连接';
    }

    async connectToUser(targetId) {
        if (this.connectedUser) {
            if (confirm('已连接到其他用户，是否断开当前连接？')) {
                this.disconnect();
            } else {
                return;
            }
        }

        this.connectedUser = targetId;
        this.setupPeerConnection();

        try {
            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);

            this.ws.send(JSON.stringify({
                type: 'offer',
                from: this.clientId,
                target: targetId,
                offer: offer
            }));

            this.updateConnectionInfo(targetId);
        } catch (error) {
            console.error('创建offer失败:', error);
        }
    }

    setupPeerConnection() {
        // 局域网内不需要STUN服务器
        this.peerConnection = new RTCPeerConnection({
            iceServers: [] // 空配置，仅使用本地候选
        });

        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.connectedUser) {
                this.ws.send(JSON.stringify({
                    type: 'ice-candidate',
                    from: this.clientId,
                    target: this.connectedUser,
                    candidate: event.candidate
                }));
            }
        };

        this.peerConnection.ondatachannel = (event) => {
            this.setupDataChannel(event.channel);
        };

        // 创建数据通道
        this.dataChannel = this.peerConnection.createDataChannel('fileTransfer', {
            ordered: true,
            maxRetransmits: 10, // 最大重传次数
        });
        this.setupDataChannel(this.dataChannel);

        this.peerConnection.onconnectionstatechange = () => {
            console.log('连接状态:', this.peerConnection.connectionState);
            if (this.peerConnection.connectionState === 'connected') {
                this.updateStatus('connected', '✅ P2P连接已建立');
                this.sendSection.classList.remove('hidden');
                this.waitingConnection.classList.add('hidden');
            } else if (this.peerConnection.connectionState === 'disconnected') {
                this.disconnect();
            }
        };
    }

    setupDataChannel(channel) {
        this.dataChannel = channel;

        channel.onopen = () => {
            console.log('数据通道已打开');
        };

        channel.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this.handleDataChannelMessage(message);
            } catch (error) {
                console.error('数据通道消息解析错误:', error);
            }
        };

        channel.onclose = () => {
            console.log('数据通道关闭');
        };
    }

    handleDataChannelMessage(message) {
        switch (message.type) {
            case 'file-info':
                this.handleReceivedFileInfo(message);
                break;
            case 'file-chunk':
                this.handleReceivedFileChunk(message);
                break;
        }
    }

    async handleOffer(message) {
        if (this.connectedUser) {
            // 已连接其他用户，拒绝新连接
            return;
        }

        this.connectedUser = message.from;
        this.setupPeerConnection();

        try {
            await this.peerConnection.setRemoteDescription(message.offer);
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);

            this.ws.send(JSON.stringify({
                type: 'answer',
                from: this.clientId,
                target: message.from,
                answer: answer
            }));

            this.updateConnectionInfo(message.from);
        } catch (error) {
            console.error('处理offer失败:', error);
        }
    }

    async handleAnswer(message) {
        if (!this.peerConnection) return;

        try {
            await this.peerConnection.setRemoteDescription(message.answer);
        } catch (error) {
            console.error('处理answer失败:', error);
        }
    }

    async handleIceCandidate(message) {
        if (!this.peerConnection) return;

        try {
            await this.peerConnection.addIceCandidate(message.candidate);
        } catch (error) {
            console.error('处理ICE候选失败:', error);
        }
    }

    setupEventListeners() {
        this.myId.addEventListener('blur', () => {
            if (this.myId.value === this.clientId) return;
            this.ws.send(JSON.stringify({
                type: 'rename',
                from: this.clientId,
                newClientId: this.myId.value,
            }));
        });

        this.connectBtn.addEventListener('click', () => {
            // 点击按钮时显示用户列表，由用户点击具体用户连接
        });

        this.fileInput.addEventListener('change', () => {
            this.sendBtn.disabled = !this.fileInput.files.length;
        });

        this.sendBtn.addEventListener('click', () => {
            this.sendFiles();
        });

        // 页面关闭时清理连接
        window.addEventListener('beforeunload', () => {
            this.disconnect();
        });
    }

    async sendFiles() {
        const files = this.fileInput.files;
        if (!files.length || !this.dataChannel || this.dataChannel.readyState !== 'open') {
            alert('请先选择文件并确保连接正常');
            return;
        }

        this.sendProgress.classList.remove('hidden');

        for (let file of files) {
            await this.sendFile(file);
        }

        this.sendProgress.classList.add('hidden');
        this.fileInput.value = '';
        this.sendBtn.disabled = true;
    }

    async sendFile(file) {
        return new Promise((resolve) => {
            const fileId = this.generateId();
            const chunkSize = 16 * 1024;
            let offset = 0;
            let isPaused = false;

            // 设置缓冲区阈值
            this.dataChannel.bufferedAmountLowThreshold = 1024 * 1024;

            // 缓冲区恢复事件
            this.dataChannel.onbufferedamountlow = () => {
                if (isPaused) {
                    isPaused = false;
                    readNextChunk();
                }
            };

            // 发送文件信息
            this.sendWithFlowControl(JSON.stringify({
                type: 'file-info',
                fileId: fileId,
                fileName: file.name,
                fileSize: file.size,
                fileType: file.type
            }));

            const sendChunk = async (chunk, isLast) => {
                // 等待缓冲区有足够空间
                while (this.dataChannel.bufferedAmount > this.dataChannel.bufferedAmountLowThreshold) {
                    isPaused = true;
                    await new Promise(resolve => setTimeout(resolve, 10));
                }

                this.dataChannel.send(JSON.stringify({
                    type: 'file-chunk',
                    fileId: fileId,
                    chunk: Array.from(new Uint8Array(chunk)),
                    isLast: isLast
                }));

                // 更新进度
                const progress = Math.min(100, Math.round((offset + chunkSize) / file.size * 100));
                this.sendProgressBar.style.width = progress + '%';
                this.sendStatus.textContent = `发送中: ${file.name} (${progress}%)`;
            };

            const readNextChunk = () => {
                if (offset >= file.size) {
                    resolve();
                    return;
                }

                const slice = file.slice(offset, Math.min(offset + chunkSize, file.size));
                const reader = new FileReader();

                reader.onload = async (e) => {
                    const chunk = e.target.result;
                    const isLast = offset + chunkSize >= file.size;

                    await sendChunk(chunk, isLast);
                    offset += chunkSize;

                    if (!isLast && !isPaused) {
                        readNextChunk();
                    }
                };

                reader.readAsArrayBuffer(slice);
            };

            // 开始传输
            readNextChunk();
        });
    }

    // 封装的流量控制发送方法
    sendWithFlowControl(data) {
        return new Promise((resolve) => {
            const checkBuffer = () => {
                if (this.dataChannel.bufferedAmount <= this.dataChannel.bufferedAmountLowThreshold) {
                    this.dataChannel.send(data);
                    resolve();
                } else {
                    setTimeout(checkBuffer, 10);
                }
            };
            checkBuffer();
        });
    }

    handleReceivedFileInfo(message) {
        const fileId = message.fileId;
        this.receivedFiles.set(fileId, {
            fileName: message.fileName,
            fileSize: message.fileSize,
            fileType: message.fileType,
            chunks: [],
            receivedSize: 0
        });

        this.addFileToReceiveList(fileId, message.fileName, message.fileSize, 0);
    }

    handleReceivedFileChunk(message) {
        const fileInfo = this.receivedFiles.get(message.fileId);
        if (!fileInfo) return;

        fileInfo.chunks.push(new Uint8Array(message.chunk));
        fileInfo.receivedSize += message.chunk.length;

        const progress = Math.min(100, Math.round(fileInfo.receivedSize / fileInfo.fileSize * 100));
        this.updateFileProgress(message.fileId, progress);

        if (message.isLast) {
            this.completeFileDownload(message.fileId);
        }
    }

    addFileToReceiveList(fileId, fileName, fileSize, progress) {
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';
        fileItem.id = `file-${fileId}`;
        fileItem.innerHTML = `
                    <div><strong>${fileName}</strong></div>
                    <div class="file-info">
                        <span>${this.formatFileSize(fileSize)}</span>
                        <span>${progress}%</span>
                    </div>
                    <div class="progress">
                        <div class="progress-bar" style="width: ${progress}%"></div>
                    </div>
                `;

        this.receiveList.appendChild(fileItem);
    }

    updateFileProgress(fileId, progress) {
        const fileElement = document.getElementById(`file-${fileId}`);
        if (fileElement) {
            const progressBar = fileElement.querySelector('.progress-bar');
            const progressText = fileElement.querySelector('.file-info span:last-child');
            progressBar.style.width = progress + '%';
            progressText.textContent = progress + '%';
        }
    }

    completeFileDownload(fileId) {
        const fileInfo = this.receivedFiles.get(fileId);
        if (!fileInfo) return;

        // 合并所有chunks
        const totalLength = fileInfo.chunks.reduce((total, chunk) => total + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;

        for (const chunk of fileInfo.chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        // 创建下载链接
        const blob = new Blob([result], { type: fileInfo.fileType });
        const url = URL.createObjectURL(blob);

        const fileElement = document.getElementById(`file-${fileId}`);
        if (fileElement) {
            const downloadBtn = document.createElement('button');
            downloadBtn.className = 'btn btn-primary';
            downloadBtn.textContent = '下载';
            downloadBtn.onclick = () => {
                const a = document.createElement('a');
                a.href = url;
                a.download = fileInfo.fileName;
                a.click();
                URL.revokeObjectURL(url);
            };

            fileElement.appendChild(downloadBtn);
        }

        this.updateFileProgress(fileId, 100);
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    updateConnectionInfo(userId) {
        this.connectionInfo.classList.remove('hidden');
        this.connectedUserSpan.textContent = userId;
        this.connectBtn.textContent = '断开连接';
        this.connectBtn.onclick = () => this.disconnect();
    }

    disconnect() {
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

        this.dataChannel = null;
        this.connectedUser = null;

        this.connectionInfo.classList.add('hidden');
        this.sendSection.classList.add('hidden');
        this.waitingConnection.classList.remove('hidden');

        this.connectBtn.textContent = '选择用户连接';
        this.connectBtn.onclick = null;
        this.connectBtn.addEventListener('click', () => {
            // 重新绑定点击事件
        });

        this.updateStatus('connected', '✅ 已连接到服务器');
    }

    updateStatus(type, message) {
        this.statusElement.textContent = message;
        this.statusElement.className = `status ${type}`;
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    new FileTransferApp();
});