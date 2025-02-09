// Initialize Notyf for notifications
const notyf = new Notyf({ duration: 1500, position: { x: 'center', y: 'top' } });

// PeerJS variables (Re-introduced)
let peer = null;
let connections = {}; // Store PeerJS DataConnections
let localStream = null;
const CHUNK_SIZE = 64 * 1024;
let isStreaming = false;
let isHost = false;
let player = null;
let allowEmit = true;
let mediaSource = null;
let sourceBuffer = null;
let pendingChunks = [];
let receivedChunks = [];
let isFirstChunk = true;
let isBuffering = false;
let receivedSize = 0;
let expectedSize = 0;
let videoType = 'video/webm; codecs="vp8, vorbis"';
let currentTimestamp = 0;
let lastAppendedEnd = 0;
let canvas = null;
let context = null;
let videoElementForCapture = null;

// UI elements (same as before)
const landingPage = document.getElementById("landing");
const createPage = document.getElementById("create");
const joinPage = document.getElementById("join");
const roomPage = document.getElementById("room");
const videoPlayer = document.getElementById("video-player");

// Initialize the application
function initializeApp() {
    console.log('Initializing app...');

    try {
        videojs.options.techOrder = ['html5'];
        videojs.options.html5 = {
            nativeVideoTracks: false,
            nativeAudioTracks: false,
            nativeTextTracks: false,
            hls: {
                overrideNative: true
            }
        };

        if (!player) {
            player = videojs('video-player', {
                controls: true,
                preload: 'auto',
                fluid: true,
                playsinline: true,
                autoplay: false,
                html5: {
                    vhs: {
                        overrideNative: true,
                        enableLowInitialPlaylist: true,
                    },
                    nativeVideoTracks: false,
                    nativeAudioTracks: false,
                    nativeTextTracks: false
                }
            });

            console.log('Video.js initialized');
            initializePlayerEvents();
            setupBufferMonitoring();
            if (player.controlBar && player.controlBar.playToggle) {
                player.controlBar.playToggle.disable();
            }
        }

        if (landingPage) {
            landingPage.style.display = "block";
            console.log('Landing page displayed');
        }

        canvas = document.createElement('canvas');
        context = canvas.getContext('2d');
        videoElementForCapture = document.createElement('video');
        videoElementForCapture.muted = true;
        videoElementForCapture.style.display = 'none';
        document.body.appendChild(videoElementForCapture);

    } catch (e) {
        console.error('Initialization error:', e);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

// Initialize PeerJS
function initializePeer(asHost) {
    const peerId = randomString(5, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
    isHost = asHost;
    localStorage.setItem("isHost", asHost.toString());

    peer = new Peer(peerId);

    peer.on('open', (id) => {
        console.log('Connected to PeerJS with ID:', id);
        if (isHost) {
            document.getElementById("roomCodeText").innerHTML = id;
            startWebcamStream(); // Start webcam stream for host
        }
    });

    peer.on('connection', (conn) => {
        console.log('Incoming connection from:', conn.peer);
        setupConnection(conn);
    });

    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        notyf.error("Connection error occurred");
    });
}

// Setup PeerJS connection
function setupConnection(conn) {
    connections[conn.peer] = conn;

    const dataChannel = conn.dataChannel = conn.peerConnection.createDataChannel('liveStream');
        dataChannel.onopen = () => { console.log(`Data channel opened to ${conn.peer}`); };
        dataChannel.onclose = () => { console.log(`Data channel closed to ${conn.peer}`); };
        dataChannel.onerror = (error) => { console.error(`Data channel error to ${conn.peer}:`, error); };
        dataChannel.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'live-video-chunk') {
                handleVideoChunk({ data: data.data });
            }
        };

    conn.on('open', () => {
        console.log('Connection opened to peer:', conn.peer);
        if (!isHost) {
            // Request stream from host if joining
        }
    });

    conn.on('close', () => {
        handleConnectionClose(conn);
    });

    conn.on('error', (err) => {
        handleConnectionError(conn, err);
    });
}

// Webcam stream functions
function startWebcamStream() {
    if (localStream) {
        startLiveStream();
        return;
    }
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        .then(stream => {
            localStream = stream;
            videoElementForCapture.srcObject = localStream;
            videoElementForCapture.play();
            startLiveStream();
        })
        .catch(error => {
            console.error("Error accessing media devices:", error);
            notyf.error("Could not access webcam/microphone. Live stream not started.");
            isStreaming = false;
        });
}

function startLiveStream() {
    if (isStreaming) return;
    isStreaming = true;
    console.log('Starting live video capture and streaming...');
    captureAndStreamFrame();
}

function stopLiveStream() {
    if (!isStreaming) return;
    isStreaming = false;
    console.log('Stopping live video streaming.');
}

function captureAndStreamFrame() {
    if (!isStreaming || !isHost) return;

    canvas.width = videoElementForCapture.videoWidth;
    canvas.height = videoElementForCapture.videoHeight;
    context.drawImage(videoElementForCapture, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(blob => {
        if (!isStreaming || !isHost) return;

        const reader = new FileReader();
        reader.onloadend = () => {
            const buffer = reader.result;
            sendFrameChunks(buffer);
        };
        reader.readAsArrayBuffer(blob);
    }, 'image/jpeg', 0.7);

    requestAnimationFrame(captureAndStreamFrame);
}

function sendFrameChunks(frameBuffer) {
    if (!isStreaming || !isHost) return;

    Object.values(connections).forEach(conn => {
        const dataChannel = conn.dataChannel;
        if (dataChannel && dataChannel.readyState === 'open') {
            const chunkSize = CHUNK_SIZE;
            for (let offset = 0; offset < frameBuffer.byteLength; offset += chunkSize) {
                const chunk = frameBuffer.slice(offset, offset + chunkSize);
                dataChannel.send(JSON.stringify({ type: 'live-video-chunk', data: chunk }));
            }
        } else {
            console.warn(`Data channel not ready for peer ${conn.peer}`);
        }
    });
}


const mediaQueue = {
    chunks: [],
    isProcessing: false,
    mediaSourceBuffer: null,

    async addChunk(chunk) {
        this.chunks.push(chunk);
        if (!this.isProcessing) {
            await this.processQueue();
        }
    },

    async processQueue() {
        if (this.isProcessing || this.chunks.length === 0) return;

        this.isProcessing = true;
        console.log(`Processing queue with ${this.chunks.length} chunks`);

        try {
            if (!mediaSource || mediaSource.readyState !== 'open') {
                console.log('Creating new MediaSource');
                mediaSource = new MediaSource();
                const videoElement = document.querySelector('#video-player_html5_api');
                videoElement.src = URL.createObjectURL(mediaSource);

                await new Promise(resolve => {
                    mediaSource.addEventListener('sourceopen', resolve, { once: true });
                });
            }

            if (!sourceBuffer) {
                let mimeCodec = videoType;
                console.log(`Creating SourceBuffer with MIME type: ${mimeCodec}`);
                sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
                sourceBuffer.mode = 'sequence';
            }

            while (this.chunks.length > 0) {
                const chunk = this.chunks[0];

                if (sourceBuffer.updating) {
                    await new Promise(resolve => {
                        sourceBuffer.addEventListener('updateend', resolve, { once: true });
                    });
                }

                try {
                    console.log(`Appending chunk of size ${chunk.byteLength}`);
                    sourceBuffer.appendBuffer(chunk);

                    await new Promise((resolve, reject) => {
                        const handleUpdateEnd = () => {
                            sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
                            sourceBuffer.removeEventListener('error', handleError);
                            resolve();
                        };

                        const handleError = (err) => {
                            sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
                            sourceBuffer.removeEventListener('error', handleError);
                            reject(err);
                        };

                        sourceBuffer.addEventListener('updateend', handleUpdateEnd);
                        sourceBuffer.addEventListener('error', handleError);
                    });

                    this.chunks.shift();

                } catch (e) {
                    console.error('Error appending chunk:', e);
                    console.error('DOMException Details:', e);
                    if (e.name === 'QuotaExceededError') {
                        await this.handleQuotaExceeded();
                        continue;
                    }
                    break;
                }
            }

        } catch (e) {
            console.error('Error in queue processing:', e);
        } finally {
            this.isProcessing = false;
            if (this.chunks.length > 0) {
                setTimeout(() => this.processQueue(), 100);
            }
        }
    },

    async handleQuotaExceeded() {
        if (!sourceBuffer || !sourceBuffer.buffered.length) return;

        const currentTime = player.currentTime();
        const start = sourceBuffer.buffered.start(0);
        const removeEnd = Math.max(start, currentTime - 10);

        await new Promise((resolve) => {
            sourceBuffer.remove(start, removeEnd);
            sourceBuffer.addEventListener('updateend', resolve, { once: true });
        });
    }
};

async function processAllChunks() {
    if (isProcessingChunks) return;
    isProcessingChunks = true;

    console.log(`Starting to process ${pendingChunks.length} chunks`);

    try {
        for (let i = 0; i < pendingChunks.length; i++) {
            if (!sourceBuffer || !mediaSource || mediaSource.readyState !== 'open') {
                console.error('Invalid source buffer or media source state');
                break;
            }
            while (sourceBuffer.updating) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            try {
                const chunk = pendingChunks[i];
                sourceBuffer.appendBuffer(chunk);

                await new Promise((resolve, reject) => {
                    sourceBuffer.addEventListener('updateend', resolve, { once: true });
                    sourceBuffer.addEventListener('error', reject, { once: true });
                });

                if (sourceBuffer.buffered.length > 0) {
                    const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
                    console.log(`Processed chunk ${i + 1}/${pendingChunks.length}, buffer end: ${end.toFixed(2)}s`);
                }

            } catch (e) {
                if (e.name === 'QuotaExceededError') {
                    if (sourceBuffer.buffered.length > 0) {
                        const currentTime = player.currentTime();
                        const start = sourceBuffer.buffered.start(0);
                        const removeEnd = Math.max(start, currentTime - 10);

                        await new Promise(resolve => {
                            sourceBuffer.remove(start, removeEnd);
                            sourceBuffer.addEventListener('updateend', resolve, { once: true });
                        });
                        i--;
                    }
                } else {
                    console.error(`Error processing chunk ${i + 1}:`, e);
                }
            }
        }
        pendingChunks = [];
    } catch (error) {
        console.error('Error in processAllChunks:', error);
    } finally {
        isProcessingChunks = false;
    }
}

function handleVideoChunk(data) {
    const chunk = new Uint8Array(data.data);
    pendingChunks.push(chunk);
    receivedSize += chunk.byteLength;

    if (!sourceBuffer.updating) {
        processNextSegment();
    }
}

async function processNextSegment() {
    if (!sourceBuffer || sourceBuffer.updating || pendingChunks.length === 0) {
        return;
    }

    try {
        const segment = pendingChunks[0];
        sourceBuffer.appendBuffer(segment);

        await new Promise((resolve, reject) => {
            const handleUpdate = () => {
                sourceBuffer.removeEventListener('updateend', handleUpdate);
                sourceBuffer.removeEventListener('error', handleError);
                resolve();
            };

            const handleError = (error) => {
                sourceBuffer.removeEventListener('updateend', handleUpdate);
                sourceBuffer.removeEventListener('error', handleError);
                reject(error);
            };

            sourceBuffer.addEventListener('updateend', handleUpdate);
            sourceBuffer.addEventListener('error', handleError);
        });

        pendingChunks.shift();

        if (sourceBuffer.buffered.length > 0) {
            const start = sourceBuffer.buffered.start(0);
            const end = sourceBuffer.buffered.end(0);
            console.log(`Buffer range: ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
        }

        if (pendingChunks.length > 0) {
            setTimeout(() => processNextSegment(), 0);
        }

    } catch (error) {
        if (error.name === 'QuotaExceededError') {
            if (sourceBuffer.buffered.length > 0) {
                const currentTime = player.currentTime();
                const start = sourceBuffer.buffered.start(0);
                const removeEnd = Math.max(start, currentTime - 10);

                try {
                    await new Promise(resolve => {
                        sourceBuffer.remove(start, removeEnd);
                        sourceBuffer.addEventListener('updateend', resolve, { once: true });
                    });
                    processNextSegment();
                } catch (e) {
                    console.error('Error removing old buffer:', e);
                }
            }
        } else {
            console.error('Error processing segment:', error);
        }
    }
}
async function processChunkBatch() {
    if (!sourceBuffer || sourceBuffer.updating) return;

    console.log(`Adding ${pendingChunks.length} chunks to queue...`);

    for (const chunk of pendingChunks) {
        await mediaQueue.addChunk(chunk);
    }
    pendingChunks = [];
}
async function appendChunkWithRetry(chunk, maxRetries = 3) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            await new Promise((resolve, reject) => {
                if (!sourceBuffer || mediaSource.readyState !== 'open') {
                    reject(new Error('Source buffer or media source not ready'));
                    return;
                }

                const handleUpdateEnd = () => {
                    sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
                    sourceBuffer.removeEventListener('error', handleError);
                    resolve();
                };

                const handleError = (err) => {
                    sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
                    sourceBuffer.removeEventListener('error', handleError);
                    reject(err);
                };

                sourceBuffer.addEventListener('updateend', handleUpdateEnd);
                sourceBuffer.addEventListener('error', handleError);

                sourceBuffer.appendBuffer(chunk);
            });

            return;
        } catch (e) {
            attempt++;
            if (e.name === 'QuotaExceededError') {
                await handleQuotaExceeded();
                continue;
            }
            if (attempt === maxRetries) throw e;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}
function setupSourceBuffer(mimeType) {
    if (!mediaSource || mediaSource.readyState !== 'open') return;

    try {
        if (mimeType === 'video/webm') {
            if (mimeType.includes('av01')) {
                mimeType = mimeType;
            } else {
                mimeType = 'video/webm;codecs="vp8,vorbis"';
            }
        }

        sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        sourceBuffer.mode = 'sequence';
        sourceBuffer.timestampOffset = 0;
        console.log('Created source buffer in segments mode');
        sourceBuffer.timestampOffset = 0;

        sourceBuffer.addEventListener('updateend', () => {
            if (sourceBuffer.buffered.length > 0) {
                for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                    console.log(`Buffer range ${i}: ${sourceBuffer.buffered.start(i).toFixed(3)}s to ${sourceBuffer.buffered.end(i).toFixed(3)}s`);
                }
            }
        });

        mediaState.isReady = true;
    } catch (e) {
        console.error('Error setting up source buffer:', e);
        mediaState.hasError = true;
    }
}
function handleVideoComplete() {
    console.log('Video transfer complete');

    const checkComplete = setInterval(() => {
        if (pendingChunks.length === 0 && !sourceBuffer.updating) {
            clearInterval(checkComplete);
            if (mediaSource && mediaSource.readyState === 'open') {
                setTimeout(() => {
                    mediaSource.endOfStream();
                }, 1000);
            }
        }
    }, 500);
}

function removeOldBufferData(currentTime) {
    if (!sourceBuffer || !sourceBuffer.buffered.length) return;

    const bufferedStart = sourceBuffer.buffered.start(0);
    const removeEnd = Math.max(bufferedStart, currentTime - 10);

    if (removeEnd > bufferedStart) {
        sourceBuffer.remove(bufferedStart, removeEnd);
    }
}

function initializePlayerEvents() {
    if (!player) return;

    player.on('waiting', () => {
        console.log('Video waiting for data');

        if (sourceBuffer && sourceBuffer.buffered.length > 0) {
            const currentTime = player.currentTime();

            console.log('Current source buffer state:', sourceBuffer.updating ? 'updating' : 'idle');
            console.log('Pending chunks:', pendingChunks.length);

            let hasValidRange = false;
            for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                const start = sourceBuffer.buffered.start(i);
                const end = sourceBuffer.buffered.end(i);
                console.log(`Buffer range ${i}: ${start.toFixed(3)}s to ${end.toFixed(3)}s`);

                if (currentTime >= start && currentTime <= end) {
                    hasValidRange = true;
                }
            }

            if (!hasValidRange && pendingChunks.length > 0) {
                console.log('Current time outside buffered ranges, processing more chunks');
                processChunkBatch();
            }
        } else {
            console.log('No buffered ranges available');
            if (pendingChunks.length > 0 && sourceBuffer && !sourceBuffer.updating) {
                console.log('Starting initial chunk processing...');
                processChunkBatch();
            }
        }
    });

    player.on('canplay', () => {
        console.log('Video can play - enabling play button');
        if (player.controlBar && player.controlBar.playToggle) {
            player.controlBar.playToggle.enable();
        }
    });

    player.on('error', (error) => {
        console.error('Player error:', error);
        console.log('Source buffer state:', sourceBuffer ? sourceBuffer.updating : 'no source buffer');
        console.log('Media source state:', mediaSource ? mediaSource.readyState : 'no media source');
    });

    player.on('timeupdate', () => {
        if (Math.floor(player.currentTime()) % 30 === 0) {
            removeOldBufferData(player.currentTime());
        }
    });

    player.on('dispose', () => {
        if (mediaSource && mediaSource.readyState === 'open') {
            mediaSource.endOfStream();
        }
        if (mediaState.mediaSourceUrl) {
            URL.revokeObjectURL(mediaState.mediaSourceUrl);
        }
    });

    player.on('play', () => {
        console.log('Play event triggered');
        if (pendingChunks.length > 0 && sourceBuffer && !sourceBuffer.updating) {
            console.log('Processing chunks on play');
            processChunkBatch();
        }
    });
}
function handleChatMessage(data) {
    append({
        name: data.username,
        content: data.message,
        pfp: data.pfp || '#f3dfbf'
    });
}

function handleConnectionClose(conn) {
    console.log('Connection closed:', conn.peer);
    delete connections[conn.peer];

    if (mediaState.mediaSourceUrl) {
        URL.revokeObjectURL(mediaState.mediaSourceUrl);
    }

    append({
        name: 'Local Party',
        content: 'A user has disconnected.',
        pfp: '#f3dfbf'
    });
}

function handleConnectionError(conn, err) {
    console.error('Connection error:', err);
    mediaState.hasError = true;
    notyf.error("Connection error occurred");

    delete connections[conn.peer];
    if (mediaState.mediaSourceUrl) {
        URL.revokeObjectURL(mediaState.mediaSourceUrl);
    }
}
const mediaState = {
    isReady: false,
    hasError: false,
    mediaSourceReady: false,
    sourceBufferReady: false,
    isInitializing: false,
    mediaSourceUrl: null,
    initComplete: false
};

async function setupMediaSource(videoElement, mimeType) {
    return new Promise((resolve, reject) => {
        try {
            mediaState.isReady = false;
            mediaState.hasError = false;
            mediaState.initComplete = false;

            if (mediaSource) {
                try {
                    if (mediaSource.readyState === 'open') {
                        mediaSource.endOfStream();
                    }
                } catch (e) {
                    console.warn('Error cleaning up old MediaSource:', e);
                }
                if (mediaState.mediaSourceUrl) {
                    URL.revokeObjectURL(mediaState.mediaSourceUrl);
                }
            }

            mediaSource = new MediaSource();
            mediaState.mediaSourceUrl = URL.createObjectURL(mediaSource);
            console.log('Created new MediaSource');

            let setupComplete = false;

            const handleSourceOpen = async () => {
                if (setupComplete) return;
                setupComplete = true;

                mediaSource.removeEventListener('sourceopen', handleSourceOpen);

                try {
                    console.log('MediaSource opened');

                    if (!sourceBuffer) {
                        let finalMimeType = mimeType;
                        if (mimeType === 'video/webm') {
                            if (mimeType.includes('av01')) {
                                finalMimeType = mimeType;
                            } else {
                                finalMimeType = 'video/webm;codecs="vp8,vorbis"';
                            }
                        }


                        sourceBuffer = mediaSource.addSourceBuffer(finalMimeType);
                        sourceBuffer.mode = 'sequence';
                        sourceBuffer.timestampOffset = 0;
                        console.log('SourceBuffer created');

                        sourceBuffer.addEventListener('updateend', () => {
                            if (pendingChunks.length > 0 && !sourceBuffer.updating) {
                                processNextChunk();
                            }
                        });
                    }

                    if (player && player.currentSrc() !== mediaState.mediaSourceUrl) {
                        player.src({
                            src: mediaState.mediaSourceUrl,
                            type: mimeType
                        });
                    }

                    mediaState.isReady = true;
                    resolve();
                } catch (error) {
                    console.error('Error in sourceopen:', error);
                    mediaState.hasError = true;
                    reject(error);
                }
            };

            mediaSource.addEventListener('sourceopen', handleSourceOpen, { once: true });
            videoElement.src = mediaState.mediaSourceUrl;

        } catch (error) {
            console.error('Error in setupMediaSource:', error);
            mediaState.hasError = true;
            reject(error);
        }
    });
}
function getVideoMimeType(file) {
    return 'video/webm; codecs="vp8, vorbis"';
}

async function startStreamingTo(conn) {
    try {
        if (!localStream) {
            throw new Error('No local webcam stream available');
        }

        console.log('Starting live video stream');
        const mimeType = getVideoMimeType();
        console.log(`MIME Type detected and being sent: ${mimeType}`);

        const metadata = {
            type: 'video-metadata',
            mimeType: mimeType,
            size: Infinity,
            name: 'live-stream'
        };

        console.log('Sending live stream metadata:', metadata);
        conn.send(metadata);

        await new Promise(resolve => setTimeout(resolve, 1000));
        startLiveStreamingTo(conn);

        notyf.success("Live stream started to peer");
    } catch (err) {
        console.error('Error starting live stream:', err);
        notyf.error("Error starting live stream: " + err.message);
    }
}

function handleVideoMetadata(data) {
    console.log('Processing metadata (live stream):', data);
    expectedSize = data.size || Infinity;

    pendingChunks = [];
    receivedSize = 0;

    try {
        if (mediaSource) {
            if (mediaSource.readyState === 'open') {
                mediaSource.endOfStream();
            }
            if (mediaState.mediaSourceUrl) {
                URL.revokeObjectURL(mediaState.mediaSourceUrl);
            }
        }

        mediaSource = new MediaSource();
        mediaState.mediaSourceUrl = URL.createObjectURL(mediaSource);
        videoElement.src = mediaState.mediaSourceUrl;

        mediaSource.addEventListener('sourceopen', () => {
            setupSourceBuffer(data.mimeType || 'video/webm; codecs="vp8, vorbis"');
        }, { once: true });

        return true;
    } catch (error) {
        console.error('Error in handleVideoMetadata (live stream):', error);
        mediaState.hasError = true;
        return false;
    }
}

async function processNextChunk() {
    if (!sourceBuffer || sourceBuffer.updating || pendingChunks.length === 0) {
        return;
    }

    try {
        const chunk = pendingChunks.shift();
        sourceBuffer.appendBuffer(chunk);
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            const currentTime = player.currentTime();
            await new Promise(resolve => {
                removeOldBufferData(currentTime);
                sourceBuffer.addEventListener('updateend', resolve, { once: true });
            });
            pendingChunks.unshift(chunk);
        } else {
            console.error('Error appending buffer:', e);
        }
    }
}
async function initializeMediaSource(videoElement, mimeType) {
    if (mediaState.isInitializing) {
        console.log('Already initializing media source');
        return false;
    }

    mediaState.isInitializing = true;
    console.log('Starting media source initialization');

    try {
        if (mediaSource) {
            try {
                if (mediaSource.readyState === 'open') {
                    mediaSource.endOfStream();
                }
            } catch (e) {
                console.warn('Error cleaning up old MediaSource:', e);
            }
            if (mediaState.mediaSourceUrl) {
                URL.revokeObjectURL(mediaState.mediaSourceUrl);
            }
        }

        sourceBuffer = null;
        mediaSource = new MediaSource();
        mediaState.mediaSourceUrl = URL.createObjectURL(mediaSource);

        await new Promise((resolve, reject) => {
            const sourceOpenHandler = () => {
                try {
                    console.log('MediaSource opened');

                    let finalMimeType = mimeType;
                    if (mimeType === 'video/webm') {
                        if (mimeType.includes('av01')) {
                            finalMimeType = mimeType;
                        } else {
                            finalMimeType = 'video/webm;codecs="vp8,vorbis"';
                        }
                    }

                    sourceBuffer = mediaSource.addSourceBuffer(finalMimeType);
                    sourceBuffer.mode = 'sequence';
                    sourceBuffer.timestampOffset = 0;
                    console.log('SourceBuffer created successfully');

                    sourceBuffer.addEventListener('updateend', () => {
                        if (pendingChunks.length > 0 && !sourceBuffer.updating) {
                            processNextChunk();
                        }
                    });

                    if (player) {
                        player.src({
                            src: mediaState.mediaSourceUrl,
                            type: finalMimeType
                        });
                    }

                    resolve();
                } catch (error) {
                    reject(error);
                }
            };

            mediaSource.addEventListener('sourceopen', sourceOpenHandler, { once: true });
            videoElement.src = mediaState.mediaSourceUrl;
        });

        mediaState.isInitializing = false;
        mediaState.isReady = true;
        console.log('Media source initialization complete');
        return true;

    } catch (error) {
        console.error('Media source initialization failed:', error);
        mediaState.hasError = true;
        mediaState.isInitializing = false;
        mediaState.isReady = false;
        throw error;
    }
}

async function retryInitialization(videoElement, mimeType, maxRetries = 3) {
    let attempts = 0;

    while (attempts < maxRetries) {
        try {
            console.log(`Attempt ${attempts + 1} of ${maxRetries} to initialize media source`);
            mediaState.isReady = false;
            mediaState.hasError = false;
            mediaState.isInitializing = false;
            pendingChunks = [];
            receivedSize = 0;

            const success = await initializeMediaSource(videoElement, mimeType);
            if (success) {
                console.log('Media source initialization succeeded');
                return true;
            }
        } catch (error) {
            console.error(`Attempt ${attempts + 1} failed:`, error);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        attempts++;
    }

    console.error('All initialization attempts failed');
    return false;
}
async function handleQuotaExceeded() {
    if (!sourceBuffer || !sourceBuffer.buffered.length) return;

    const currentTime = player.currentTime();
    const start = sourceBuffer.buffered.start(0);
    const removeEnd = Math.max(start, currentTime - 5);

    if (removeEnd > start) {
        await new Promise((resolve, reject) => {
            sourceBuffer.remove(start, removeEnd);
            sourceBuffer.addEventListener('updateend', resolve, { once: true });
            sourceBuffer.addEventListener('error', reject, { once: true });
        });
    }
}

function appendBufferAsync(chunk) {
    return new Promise((resolve, reject) => {
        if (!sourceBuffer || mediaSource.readyState !== 'open') {
            reject(new Error('Invalid source buffer state'));
            return;
        }

        try {
            const handleUpdate = () => {
                sourceBuffer.removeEventListener('updateend', handleUpdate);
                sourceBuffer.removeEventListener('error', handleError);
                resolve();
            };

            const handleError = (e) => {
                sourceBuffer.removeEventListener('updateend', handleUpdate);
                sourceBuffer.removeEventListener('error', handleError);
                reject(e);
            };

            sourceBuffer.addEventListener('updateend', handleUpdate);
            sourceBuffer.addEventListener('error', handleError);
            sourceBuffer.appendBuffer(chunk);

        } catch (e) {
            reject(e);
        }
    });
}

function isStreamComplete() {
    return (
        receivedSize >= expectedSize &&
        pendingChunks.length === 0 &&
        sourceBuffer &&
        !sourceBuffer.updating
    );
}

function setupBufferMonitoring() {
    if (!player) return;

    setInterval(() => {
        if (sourceBuffer && player) {
            const currentTime = player.currentTime();
            removeOldBufferData(currentTime);

            if (sourceBuffer.buffered.length > 0) {
                const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
                const bufferAhead = bufferedEnd - currentTime;

                console.log(`Buffer status: ${bufferAhead.toFixed(2)}s ahead, ` +
                    `${pendingChunks.length} chunks remaining, ` +
                    `${receivedSize}/${expectedSize} bytes received`);
            }
        }
    }, 500);

    player.on('waiting', () => {
        console.log('Video waiting for data');

        if (sourceBuffer && sourceBuffer.buffered.length > 0) {
            const currentTime = player.currentTime();

            let hasValidRange = false;
            for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                const start = sourceBuffer.buffered.start(i);
                const end = sourceBuffer.buffered.end(i);
                console.log(`Buffer range ${i}: ${start.toFixed(3)}s to ${end.toFixed(3)}s`);

                if (currentTime >= start && currentTime <= end) {
                    hasValidRange = true;
                }
            }

            if (!hasValidRange && pendingChunks.length > 0) {
                console.log('Current time outside buffered ranges, processing more chunks');
                processNextChunk();
            }
        }
    });

    player.on('dispose', () => {
        clearInterval(bufferInterval);
    });
}

function checkBuffer() {
    if (!mediaState.isReady || !sourceBuffer) return;

    try {
        if (sourceBuffer.buffered.length > 0) {
            const currentTime = player.currentTime();
            const bufferedEnd = sourceBuffer.buffered.end(0);
            const bufferAhead = bufferedEnd - currentTime;

            if (bufferAhead < 2 && pendingChunks.length > 0) {
                processNextChunk();
            }
        }
    } catch (e) {
        console.warn('Buffer check error:', e);
    }
}

function handleVideoChunk(data) {
    const chunk = new Uint8Array(data.data);
    pendingChunks.push(chunk);
    receivedSize += chunk.byteLength;

    const percentage = ((receivedSize / expectedSize) * 100).toFixed(1);
    console.log(`Received chunk: ${receivedSize}/${expectedSize} bytes (${percentage}%)`);

    if (mediaState.isReady && sourceBuffer && !sourceBuffer.updating) {
        processNextChunk();
    }
}

function initializePlayerControls() {
    if (!player) return;

    player.controlBar.playToggle.disable();

    player.on('canplay', () => {
        console.log('Video can play');
        player.controlBar.playToggle.enable();
    });

    player.on('playing', () => {
        console.log('Video started playing');
    });

    player.on('error', (e) => {
        console.error('Player error:', e);
    });
}
function handleVideoControl(data) {
    if (!allowEmit || !player) return;

    allowEmit = false;

    try {
        if (Math.abs(player.currentTime() - data.time) > 0.5) {
            console.log(`Syncing time from ${player.currentTime()} to ${data.time}`);
            player.currentTime(data.time);
        }

        if (data.action === 'play' && player.paused()) {
            console.log('Remote play command received');
            player.play().catch(e => console.error('Play failed:', e));
            const content = time("played", data.username || "Someone", data.time);
            append({
                name: "Local Party",
                content: content,
                pfp: "#f3dfbf"
            });
        } else if (data.action === 'pause' && !player.paused()) {
            console.log('Remote pause command received');
            player.pause();
            const content = time("paused", data.username || "Someone", data.time);
            append({
                name: "Local Party",
                content: content,
                pfp: "#f3dfbf"
            });
        }
    } catch (e) {
        console.error('Error handling video control:', e);
    }

    setTimeout(() => { allowEmit = true; }, 500);
}

function randomString(length, chars) {
    let result = '';
    for (let i = length; i > 0; --i) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

function time(state, username, context) {
    let hours = Math.floor(context / 3600);
    let minutes = Math.floor((context % 3600) / 60);
    let seconds = Math.floor(context % 60);

    hours = hours < 10 ? "0" + hours : hours;
    minutes = minutes < 10 ? "0" + minutes : minutes;
    seconds = seconds < 10 ? "0" + seconds : seconds;

    let contentString = `${username} ${state} the video at ${minutes}:${seconds}`;
    if (hours !== "00") {
        contentString = `${username} ${state} the video at ${hours}:${minutes}:${seconds}`;
    }
    return contentString;
}

function append(message) {
    const messagesBox = document.getElementById("messages-box");
    messagesBox.innerHTML += `
        <div class="col-12 mt-3" id="message">
            <span class="username" style="color: ${message.pfp}">${message.name}: </span>
            ${message.content}
        </div>
    `;
    messagesBox.scrollTop = messagesBox.scrollHeight;
}

function appendData(roomName, roomCode) {
    append({
        name: "Local Party",
        content: "Local Party allows you to watch live streams with your friends synchronously while chatting.",
        pfp: "#f3dfbf"
    });
    append({
        name: "Local Party",
        content: `Welcome to ${roomName}`,
        pfp: "#f3dfbf"
    });
    append({
        name: "Local Party",
        content: `Share the room code (${roomCode}) with others to invite them to the party.`,
        pfp: "#f3dfbf"
    });
    append({
        name: "Local Party",
        content: "The live stream will be automatically shared with others who join.",
        pfp: "#f3dfbf"
    });
}

function videoControlsHandler(e) {
    if (!allowEmit || !player || !mediaState.isReady) return;

    allowEmit = false;

    try {
        const currentTime = player.currentTime();
        console.log(`Sending ${e.type} command at time ${currentTime}`);

        const controlData = {
            type: 'control',
            action: e.type,
            time: currentTime,
            username: localStorage.getItem("username")
        };
    } catch (e) {
        console.error('Error in video controls handler:', e);
    }

    setTimeout(() => { allowEmit = true; }, 500);
}

function initializeVideoPlayerEvents() {
    if (!player) return;

    player.on('seeking', () => {
        if (!allowEmit) return;

        allowEmit = false;
        const currentTime = player.currentTime();
        removeOldBufferData(currentTime);


        setTimeout(() => { allowEmit = true; }, 500);
    });

    player.on('waiting', () => {
        console.log('Video waiting for data');

        if (sourceBuffer && sourceBuffer.buffered.length > 0) {
            const currentTime = player.currentTime();

            let hasValidRange = false;
            for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                const start = sourceBuffer.buffered.start(i);
                const end = sourceBuffer.buffered.end(i);
                console.log(`Buffer range ${i}: ${start.toFixed(3)}s to ${end.toFixed(3)}s`);

                if (currentTime >= start && currentTime <= end) {
                    hasValidRange = true;
                }
            }

            if (!hasValidRange && pendingChunks.length > 0) {
                console.log('Current time outside buffered ranges, processing more chunks');
                processNextChunk();
            }
        }
    });

    player.on('error', (error) => {
        console.error('Video playback error:', error);
        if (mediaSource && sourceBuffer && !sourceBuffer.updating) {
            processNextChunk();
        }
    });
}

document.addEventListener("click", function (e) {
    switch (e.target.id) {
        case "createRoomButton":
            landingPage.style.display = "none";
            createPage.style.display = "block";
            break;

        case "roomCreateButton":
            handleRoomCreate();
            break;

        case "joinRoomButton":
            landingPage.style.display = "none";
            joinPage.style.display = "block";
            break;

        case "roomJoinButton":
            handleRoomJoin();
            break;

        case "roomLeaveButton":
            stopLiveStream();
            Object.values(connections).forEach(conn => conn.close());
            peer.destroy();
            location.reload();
            break;

        case "backButton":
            joinPage.style.display = "none";
            createPage.style.display = "none";
            landingPage.style.display = "block";
            break;
    }
});

function handleRoomCreate() {
    const roomName = document.getElementById("roomname").value;
    const username = document.getElementById("create-username").value;

    if (!roomName || !username) {
        document.getElementById("createRoomText").innerHTML = "Please fill in all fields";
        return;
    }

    localStorage.setItem("username", username);
    localStorage.setItem("roomName", roomName);

    initializePeer(true);

    document.getElementById("roomNameText").innerHTML = roomName;
    document.getElementById("createRoomText").innerHTML = "";
    createPage.style.display = "none";
    document.title = `Local Party | ${roomName}`;
    roomPage.style.display = "block";

    appendData(roomName, peer.id);
}

function handleRoomJoin() {
    const hostPeerId = document.getElementById("roomCode").value;
    const username = document.getElementById("join-username").value;

    if (!hostPeerId || !username) {
        document.getElementById("joinRoomText").innerHTML = "Please fill in all fields";
        return;
    }

    localStorage.setItem("username", username);

    initializePeer(false);

    if (player) {
        player.reset();
    }

    peer.on('open', () => {
        console.log('Connecting to host:', hostPeerId);
        const conn = peer.connect(hostPeerId);

        conn.on('open', () => {
            console.log('Connected to host successfully');
            setupConnection(conn);

            document.getElementById("roomCodeText").innerHTML = hostPeerId;
            joinPage.style.display = "none";
            document.title = "Local Party | Room";
            roomPage.style.display = "block";
            appendData("Room", hostPeerId);
        });

        conn.on('error', (err) => {
            console.error('Connection error:', err);
            document.getElementById("joinRoomText").innerHTML = "Failed to connect to room";
            notyf.error("Failed to connect to room");
        });
    });
}

const form = document.getElementById("send-form");
form.addEventListener('submit', (e) => {
    e.preventDefault();
    const messageInput = document.getElementById("messageInp");
    const message = messageInput.value.trim();

    if (message) {
        const chatData = {
            type: 'chat',
            username: localStorage.getItem("username"),
            message: message,
            pfp: localStorage.getItem("pfpUrl") || "#f3dfbf"
        };

        Object.values(connections).forEach(conn => {
            if (conn.open) {
                conn.send(chatData);
            }
        });

        append({
            name: localStorage.getItem("username"),
            content: message,
            pfp: localStorage.getItem("pfpUrl") || "#f3dfbf"
        });

        messageInput.value = "";
    }
});
function setupBufferMonitoring() {
    if (!player) return;

    player.on('timeupdate', () => {
        if (sourceBuffer && sourceBuffer.buffered.length > 0) {
            const currentTime = player.currentTime();
            const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
            const bufferAhead = bufferedEnd - currentTime;

            console.log(`Buffer status: ${bufferAhead.toFixed(2)}s ahead, ` +
                `${pendingChunks.length} chunks remaining, ` +
                `${receivedSize}/${expectedSize} bytes received`);

            if (pendingChunks.length > 0 && !sourceBuffer.updating) {
                processNextChunk();
            }
        }
    });
}

function logBufferStatus() {
    if (!sourceBuffer || !player) return;

    const videoElement = player.tech().el();
    console.log("--- Buffer Status Check ---");

    if (sourceBuffer.buffered.length > 0) {
        console.log("SourceBuffer ranges:");
        for (let i = 0; i < sourceBuffer.buffered.length; i++) {
            const start = sourceBuffer.buffered.start(i);
            const end = sourceBuffer.buffered.end(i);
            console.log(`Range ${i}: ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
        }
    }

    if (videoElement.buffered.length > 0) {
        console.log("Video Element ranges:");
        for (let i = 0; i < videoElement.buffered.length; i++) {
            const start = videoElement.buffered.start(i);
            const end = videoElement.buffered.end(i);
            console.log(`Range ${i}: ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
        }
    }
}
document.getElementById('roomCodeText').addEventListener('click', () => {
    const text = document.getElementById('roomCodeText').innerHTML;
    navigator.clipboard.writeText(text)
        .then(() => {
            notyf.success("Room code copied to clipboard");
        })
        .catch(err => {
            console.error('Failed to copy room code:', err);
            notyf.error("Failed to copy room code");
        });
});
