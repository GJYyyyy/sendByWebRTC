
class FileTransferApp {
    wsPort = 60999;
    ws = null;
    peer = null;
    CHUNK_SIZE = 16 * 1024;
    _id = undefined;
    _targetId = undefined;
    _userList = [];
    _status = 'offline';
    _seFiles = new Map(); // 需要发送的文件
    _reFiles = new Map(); // 接收的文件

    $id = null;
    $status = null;
    $userList = null;
    $transferArea = null;
    $fileInput = null;
    $sendList = null;
    $receiveList = null;

    /**
     * 状态中文映射
     */
    statusChineseMap = new Map([
        ['online', '在线'],
        ['offline', '离线'],
        ['reconnecting', '重连中'],
        ['connected', '已连接'],
    ]);

    constructor() {
        this.initElement();
        this.generateId();
        this.register();
        this.initPeer();
    }

    /**
     * 生成随机ID
     * @returns {string}
     */
    generateId() {
        const min = 10000;
        const max = 99999;
        const decimal = 0;
        this.clientId = (Math.random() * (max - min) + min).toFixed(decimal);
    }

    initElement() {
        this.$id = this.$('id');
        this.$status = this.$('status');
        this.$userList = this.$('userList');
        this.$transferArea = this.$('transferArea');
        this.$fileInput = this.$('fileInput');
        this.$sendList = this.$('sendList');
        this.$receiveList = this.$('receiveList');
        this.$sendBtn = this.$('sendBtn');

        this.$id.addEventListener('blur', (ev) => {
            this.ws.send(JSON.stringify({
                type: 'rename',
                from: this.clientId,
                newFrom: ev.target.value,
            }))
        })

        this.$fileInput.addEventListener('change', (ev) => {
            let map = new Map();
            for (let file of ev.target.files) {
                map.set(this.calcFileId(file), file)
            }
            this.seFiles = map;
        })

        this.$sendBtn.addEventListener('click', (ev) => {
            this.sendFiles();
        })
    }

    /**
     * 在ws服务器上注册自己
     */
    register() {
        const wsUrl = `ws://${window.location.hostname}:${this.wsPort}`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this.status = 'online';
            this.ws.send(JSON.stringify({
                type: 'register',
                status: this.status,
                from: this.clientId,
            }));
        };

        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            this.handleWebSocketMessage(message);
        };

        this.ws.onclose = () => {
            this.status = 'reconnecting';
            this.ws.send(JSON.stringify({
                type: 'update-status',
                from: this.clientId,
                status: this.status,
            }))
            setTimeout(() => this.register(), 3000);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket错误:', error);
            this.status = 'offline';
            this.ws.send(JSON.stringify({
                type: 'update-status',
                from: this.clientId,
                status: this.status,
            }))
        };
    }

    /**
     * 处理WebSocket消息
     * @param {Object} message 
     */
    handleWebSocketMessage(message) {
        console.log('收到websocket消息:', message);

        switch (message.type) {
            case 'update-user-list':
                this.userList = message.users;
                break;
            case 'rename-error':
                alert(message.message);
                break;
            case 'rename-success':
                this.clientId = message.newFrom;
                break;
            case 'peer-handshake':
                this.targetId = message.from;
                this.peer.signal(message.data);
                break;
        }
    }

    initPeer(initiator = false) {
        this.peer = new SimplePeer({
            initiator,
            trickle: true,
            config: {
                iceServers: []
            }
        })

        this.peer.on('signal', (data) => {
            this.ws.send(JSON.stringify({
                type: 'peer-handshake',
                from: this.clientId,
                target: this.targetId,
                data,
            }));
        });

        this.peer.on('connect', () => {
            this.status = 'connected';
            this.ws.send(JSON.stringify({
                type: 'update-status',
                from: this.clientId,
                status: this.status,
            }))
        });

        this.peer.on('data', (data) => {
            const message = JSON.parse(data);
            this.handlePeerMessage(message);
        })

        this.peer.on('close', () => {
            this.initPeer();
        });

        this.peer.on('error', (error) => {
            console.error('Peer错误:', error);
            this.status = 'online';
            this.ws.send(JSON.stringify({
                type: 'update-status',
                from: this.clientId,
                status: this.status,
            }))

        });
    }

    /**
     * 处理Peer消息
     * @param {Object} message 
     */
    handlePeerMessage(message) {
        // console.log('收到peer消息:', message);

        switch (message.type) {
            case 'file-meta-start':
                this.receiveSingleFileMetaStart(message);
                break;
            case 'file-meta':
                this.receiveSingleFileMeta(message);
                break;
            case 'file-meta-end':
                this.receiveSingleFileMetaEnd(message);
                break;
            case 'file-chunk':
                this.receiveSingleFileChunk(message);
                break;
            case 'file-end':
                this.receiveSingleFileChunkEnd(message);
                break;
            case 'peer-handshake':

                break;
        }

    }

    /**
     * 发送文件
     * @returns {Promise}
     */
    async sendFiles() {

        // 发送所有文件元数据开始信号
        this.peer.write(JSON.stringify({
            type: 'file-meta-start',
        }));

        // 发送所有文件的元数据
        for (let [fileId, file] of this.seFiles.entries()) {
            // 发送文件元信息
            this.peer.write(JSON.stringify({
                type: 'file-meta',
                fileId,
                fileName: file.name,
                fileSize: file.size,
                fileType: file.type,
                fileLastModified: file.lastModified,
            }));
        }

        // 发送所有文件元数据结束信号
        this.peer.write(JSON.stringify({
            type: 'file-meta-end',
        }));

        for (let mapItem of this.seFiles.entries()) {
            await this.sendSingleFile(mapItem);
        }
    }

    /**
     * 发送单个文件
     * @param {[string, File]} mapItem 文件
     * @returns {Promise}
     */
    async sendSingleFile(mapItem) {
        let offset = 0;
        let chunkIndex = 0;

        const [fileId, file] = mapItem;

        while (offset < file.size) {
            const chunk = file.slice(offset, Math.min(offset + this.CHUNK_SIZE, file.size));
            const arrayBuffer = await chunk.arrayBuffer();

            // 发送文件分片，每个分片都携带fileId
            this.peer.write(JSON.stringify({
                type: 'file-chunk',
                fileId: fileId,
                chunkIndex,
                chunk: Array.from(new Uint8Array(arrayBuffer)),
            }))

            offset += this.CHUNK_SIZE;
            chunkIndex++;

            // 更新发送进度条
            this.$(fileId).querySelector('.percent').innerText = `${(offset / file.size * 100).toFixed(2)}%`;
        }

        // 发送文件结束信号
        this.peer.write(JSON.stringify({
            type: 'file-end',
            fileId,
            chunkIndex,
        }));

        this.$(fileId).querySelector('.percent').innerText = '100%';

    }

    /**
     * 接受所有文件元数据开始
     * @param {Object} message 
     */
    receiveSingleFileMetaStart(message) {

        this.reFiles = new Map();
    }

    /**
     * 接收单个文件元信息
     * @param {Object} message
     */
    receiveSingleFileMeta(message) {
        let { fileId, fileName, fileSize, fileType, fileLastModified } = message;
        console.log('文件元信息fileInfo', message);
        if (!this.reFiles.has(fileId)) this.reFiles.set(fileId, {
            fileId,
            fileName,
            fileSize,
            fileType,
            fileLastModified,
            chunks: new Map(),
        });
    }

    /**
     * 接受所有文件元数据结束
     * @param {Object} message 
     */
    receiveSingleFileMetaEnd(message) {

        this.reFiles = this.reFiles;
    }

    /**
     * 接收单个文件分片
     * @param {Object} message 
     */
    receiveSingleFileChunk(message) {
        const { fileId, chunkIndex, chunk } = message;
        let fileInfo = this.reFiles.get(fileId);
        if (!fileInfo) return;

        fileInfo.chunks.set(chunkIndex, chunk);
        // 更新发送进度条
        let offset = this.CHUNK_SIZE * fileInfo.chunks.size - 1;
        this.$(fileId).querySelector('.percent').innerText = `${(offset / fileInfo.fileSize * 100).toFixed(2)}%`;
    }

    /**
     * 接收单个文件结束信号
     * @param {Object} message 
     */
    receiveSingleFileChunkEnd(message) {
        const { fileId, chunkIndex } = message;
        let fileInfo = this.reFiles.get(fileId);
        console.log('结束信号fileInfo', fileInfo);
        const result = new Uint8Array(fileInfo.fileSize);

        // 校验文件完整性，并拼接文件
        for (let currentChunkIndex = 0; currentChunkIndex <= chunkIndex - 1; currentChunkIndex++) {
            let chunk = fileInfo.chunks.get(currentChunkIndex);
            if (!chunk) {
                console.warn(`文件不完整：第${currentChunkIndex}/${chunkIndex}文件块丢失`)
                return;
            }
            let pice = new Uint8Array(chunk);
            let offset = currentChunkIndex * this.CHUNK_SIZE;
            // console.log('pice', pice);
            // console.log('offset', offset);
            result.set(pice, offset);
        }

        this.$(fileId).querySelector('.percent').innerText = '100%';

        // 创建下载链接
        this.$(fileId).addEventListener('click', (ev) => {
            const blob = new Blob([result], { type: fileInfo.type });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = fileInfo.fileName;
            a.click();
            URL.revokeObjectURL(url);
        })
    }

    $(id) {
        return document.getElementById(id);
    }

    /**
     * 计算文件id
     * @param {File} file 
     * @returns 
     */
    calcFileId(file) {
        return `${file.name}${file.size}${file.type}${file.lastModified}`;
    }


    byteMap = new Map([
        ['B', 1024 ** 0],
        ['KB', 1024 ** 1],
        ['MB', 1024 ** 2],
        ['GB', 1024 ** 3],
        ['TB', 1024 ** 4],
    ])

    /**
     * 格式化字节
     * @param {number} bytes 字节数，例如1024
     * @returns {string} 字节数格式化后的字符串，例如1.00KB
     */
    formatBytes(bytes) {
        if (bytes < this.byteMap.get('KB')) {
            return (bytes / this.byteMap.get('B')).toFixed(2) + 'B';
        } else if (bytes < this.byteMap.get('MB')) {
            return (bytes / this.byteMap.get('KB')).toFixed(2) + 'KB';
        } else if (bytes < this.byteMap.get('GB')) {
            return (bytes / this.byteMap.get('MB')).toFixed(2) + 'MB';
        } else if (bytes < this.byteMap.get('TB')) {
            return (bytes / this.byteMap.get('GB')).toFixed(2) + 'GB';
        } else {
            return (bytes / this.byteMap.get('TB')).toFixed(2) + 'TB';
        }
    }

    get clientId() {
        return this._id;
    }

    set clientId(id) {
        this._id = id;
        this.$id.value = id;
    }

    get targetId() {
        return this._targetId;
    }

    set targetId(id) {
        this._targetId = id;
    }

    get status() {
        return this._status;
    }

    set status(status) {
        this._status = status;
        this.$status.className = 'status';
        this.$status.className += ' ' + status;
        this.$status.innerText = this.statusChineseMap.get(status);
        if (status === 'connected') {
            this.$transferArea.classList.add('active');
        } else {
            this.$transferArea.classList.remove('active');

        }
    }

    get userList() {
        return this._userList;
    }

    set userList(users) {
        this._userList = users;

        this.$userList.innerHTML = '';
        const $ul = document.createElement('ul');
        for (let user of users) {
            const $li = document.createElement('li');
            const $status = document.createElement('span');
            const $id = document.createElement('span');
            $status.className = 'status';
            $status.className += ' ' + user.status;
            $status.innerText = this.statusChineseMap.get(user.status);
            $id.className = 'id';
            $id.innerText = user.id;
            $li.appendChild($id);
            $li.appendChild($status);
            $ul.appendChild($li);

            $li.addEventListener('click', (ev) => {
                this.targetId = user.id;
                this.initPeer(true);
            })
        }
        this.$userList.appendChild($ul);
    }

    get seFiles() {
        return this._seFiles;
    }

    set seFiles(map) {
        this._seFiles = map;
        this.$sendList.innerHTML = '';
        const $ul = document.createElement('ul');
        for (let [fileId, file] of map.entries()) {
            const $li = document.createElement('li');
            $li.id = fileId;

            const $filename = document.createElement('span');
            $filename.className = 'filename';
            $filename.innerText = `${file.name} ${this.formatBytes(file.size)}`;
            $li.appendChild($filename);

            const $percent = document.createElement('span');
            $percent.className = 'percent';
            $percent.innerText = '等待发送';
            $li.appendChild($percent);

            $ul.appendChild($li);
        }
        this.$sendList.appendChild($ul);
    }

    get reFiles() {
        return this._reFiles;
    }

    set reFiles(map) {
        this._reFiles = map;
        this.$receiveList.innerHTML = '';
        const $ul = document.createElement('ul');
        for (let [fileId, fileInfo] of map.entries()) {
            const $li = document.createElement('li');
            $li.id = fileId;

            const $filename = document.createElement('span');
            $filename.className = 'filename';
            $filename.innerText = `${fileInfo.fileName} ${this.formatBytes(fileInfo.fileSize)}`;
            $li.appendChild($filename);

            const $percent = document.createElement('span');
            $percent.className = 'percent';
            $percent.innerText = '等待接受';
            $li.appendChild($percent);

            $ul.appendChild($li);
        }
        this.$receiveList.appendChild($ul);
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    new FileTransferApp();
});