// Initialize Notyf for notifications
const notyf = new Notyf({ duration: 1500, position: { x: 'center', y: 'top' } });

// PeerJS variables
let peer = null;
let connections = {};
let videoFile = null;
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

// UI elements
const landingPage = document.getElementById("landing");
const createPage = document.getElementById("create");
const joinPage = document.getElementById("join");
const roomPage = document.getElementById("room");
const videoPlayer = document.getElementById("video-player");

// Global status variables
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
let videoType = '';
let currentTimestamp = 0;
let lastAppendedEnd = 0;
let storedChunks = [];// For host to store chunks with their time ranges
let requestTimeout = null;  

const mediaQueue = {
    chunks: [],
    isProcessing: false,
    mediaSourceBuffer: null,
    
    async addChunk(chunk) {
        // Create new MediaSource if needed
        if (!mediaSource || mediaSource.readyState === 'closed') {
            console.log('Creating new MediaSource for chunk processing');
            mediaSource = new MediaSource();
            const videoElement = document.querySelector('#video-player_html5_api');
            videoElement.src = URL.createObjectURL(mediaSource);
            
            await new Promise(resolve => {
                mediaSource.addEventListener('sourceopen', resolve, { once: true });
            });

            // Create new SourceBuffer
            sourceBuffer = mediaSource.addSourceBuffer('video/webm;codecs="vp8,vorbis"');
            sourceBuffer.mode = 'sequence';
        }
        
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
            // Wait for sourceBuffer to be ready
            while (sourceBuffer && sourceBuffer.updating) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            // Process each chunk
            for (const chunk of this.chunks) {
                if (!sourceBuffer || mediaSource.readyState !== 'open') {
                    console.log('MediaSource or SourceBuffer not ready, stopping processing');
                    break;
                }

                try {
                    sourceBuffer.appendBuffer(chunk);
                    await new Promise((resolve, reject) => {
                        const handleUpdateEnd = () => {
                            sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
                            sourceBuffer.removeEventListener('error', handleError);
                            
                            // Log buffer state
                            if (sourceBuffer.buffered.length > 0) {
                                for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                                    console.log(`Buffer range ${i}: ${sourceBuffer.buffered.start(i).toFixed(3)}s to ${sourceBuffer.buffered.end(i).toFixed(3)}s`);
                                }
                            }
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
                } catch (e) {
                    if (e.name === 'QuotaExceededError') {
                        await this.handleQuotaExceeded();
                        // Retry this chunk
                        continue;
                    } else {
                        throw e;
                    }
                }
            }

            // Clear processed chunks
            this.chunks = [];

        } catch (e) {
            console.error('Error in queue processing:', e);
        } finally {
            this.isProcessing = false;
        }
    },

    async handleQuotaExceeded() {
        if (!sourceBuffer || !sourceBuffer.buffered.length) return;
        
        const currentTime = player.currentTime();
        const start = sourceBuffer.buffered.start(0);
        const removeEnd = Math.max(start, currentTime - 5);
        
        await new Promise(resolve => {
            sourceBuffer.remove(start, removeEnd);
            sourceBuffer.addEventListener('updateend', resolve, { once: true });
        });
    }
};

// Initialize the application
function initializeApp() {
    console.log('Initializing app...');
    
    try {
        // Set global Video.js options first
        videojs.options.techOrder = ['html5'];
        videojs.options.html5 = {
            nativeVideoTracks: false,
            nativeAudioTracks: false,
            nativeTextTracks: false,
            hls: {
                overrideNative: true
            }
        };

        // Only initialize if player doesn't exist
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
            
            // Initialize player events
            initializePlayerEvents();
            
            // Set up buffer monitoring
            setupBufferMonitoring();
            
            // Initially disable play button until we have data
            if (player.controlBar && player.controlBar.playToggle) {
                player.controlBar.playToggle.disable();
            }
        }

        // Show landing page
        if (landingPage) {
            landingPage.style.display = "block";
            console.log('Landing page displayed');
        }
    } catch (e) {
        console.error('Initialization error:', e);
    }
}

// Initialize on DOM load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

// Initialize PeerJS connection
function initializePeer(asHost) {
    const peerId = randomString(5, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
    isHost = asHost;
    localStorage.setItem("isHost", asHost.toString());
    
    peer = new Peer(peerId);
    
    peer.on('open', (id) => {
        console.log('Connected to PeerJS with ID:', id);
        if (isHost) {
            document.getElementById("roomCodeText").innerHTML = id;
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

// Set up peer connection
// Setup peer connection with improved error handling and state management
function setupConnection(conn) {
    connections[conn.peer] = conn;
    let metadataInitialized = false;
    let mediaSourceReady = false;
    let duration = 0;
    let bytesPerSecond = 0;
    
    // Reset state variables on new connection
    pendingChunks = [];
    receivedSize = 0;
    expectedSize = 0;
    
    const videoElement = document.querySelector('#video-player_html5_api');

    // Helper function to request missing chunks
        const requestMissingChunks = (startTime, endTime) => {
            if (!isHost) {
                console.log(`Requesting chunks for time range: ${startTime} to ${endTime}`);
                // Add debounce to prevent rapid requests
                clearTimeout(requestTimeout);
                requestTimeout = setTimeout(() => {
                    conn.send({
                        type: 'chunk-request',
                        startTime: startTime,
                        endTime: endTime
                    });
                }, 1000);
            }
        };

    // Helper function to set up buffer monitoring
    const setupBufferMonitoring = () => {
        if (!player || !sourceBuffer) return;

        player.on('waiting', () => {
            if (sourceBuffer.buffered.length > 0) {
                const currentTime = player.currentTime();
                let hasValidRange = false;

                for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                    const start = sourceBuffer.buffered.start(i);
                    const end = sourceBuffer.buffered.end(i);
                    
                    if (currentTime >= start && currentTime <= end) {
                        hasValidRange = true;
                        break;
                    }
                }

                if (!hasValidRange) {
                    // Find the closest buffered range and request missing chunks
                    let closestEnd = 0;
                    for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                        const end = sourceBuffer.buffered.end(i);
                        if (end < currentTime && end > closestEnd) {
                            closestEnd = end;
                        }
                    }
                    requestMissingChunks(closestEnd, currentTime + 10);
                }
            }
        });
    };

    conn.on('data', async (data) => {
        console.log('Received data type:', data.type, data);
        
        try {
            switch (data.type) {
                case 'video-metadata':
                    console.log('Processing metadata:', data);
                    expectedSize = data.size;
                    
                    // Reset state
                    pendingChunks = {};  // Change to object for easier index tracking
                    receivedSize = 0;
                
                    // Clean up existing MediaSource
                    if (mediaSource) {
                        if (mediaSource.readyState === 'open') {
                            mediaSource.endOfStream();
                        }
                        mediaSource = null;
                        sourceBuffer = null;
                    }
                
                    // Create new MediaSource
                    mediaSource = new MediaSource();
                    videoElement.src = URL.createObjectURL(mediaSource);
                    
                    mediaSource.addEventListener('sourceopen', () => {
                        let mimeType = data.mimeType;
                        if (data.mimeType === 'video/webm') {
                            mimeType = 'video/webm;codecs="vp8,vorbis"';
                        }
                
                        sourceBuffer = mediaSource.addSourceBuffer(mimeType);
                        sourceBuffer.mode = 'sequence';  // Important for sequence
                        sourceBuffer.timestampOffset = 0;
                
                        mediaSourceReady = true;
                    }, { once: true });
                    break;
                    
                case 'chunk-request':
                    if (isHost && videoFile && storedChunks.length > 0) {
                        console.log(`Received chunk request for time range: ${data.startTime} to ${data.endTime}`);
                        
                        // Calculate approximate chunk indices based on time range
                        const totalDuration = 13; // Duration of video in seconds
                        const chunksPerSecond = storedChunks.length / totalDuration;
                        
                        const startChunk = Math.floor(data.startTime * chunksPerSecond);
                        const endChunk = Math.ceil(data.endTime * chunksPerSecond);
                        
                        console.log(`Sending chunks ${startChunk} to ${endChunk}`);
                        
                        // Send requested chunks
                        for (let i = Math.max(0, startChunk); i < Math.min(storedChunks.length, endChunk); i++) {
                            const chunk = storedChunks[i];
                            try {
                                conn.send({
                                    type: 'video-chunk',
                                    data: chunk.data,
                                    offset: chunk.offset,
                                    total: videoFile.size,
                                    index: chunk.index
                                });
                                await new Promise(resolve => setTimeout(resolve, 50));
                            } catch (e) {
                                console.error('Error sending chunk:', e);
                            }
                        }
                    }
                    break;

                case 'video-chunk':
                    const chunk = new Uint8Array(data.data);
                    console.log(`Processing chunk ${data.index} of size ${chunk.byteLength} at offset ${data.offset}`);
                
                    // Store chunk with metadata
                    pendingChunks[data.index] = {
                        data: chunk,
                        offset: data.offset,
                        size: chunk.byteLength,
                        index: data.index
                    };
                    receivedSize += chunk.byteLength;
                
                    // If all chunks received, assemble in sequence
                    if (data.type === 'video-complete' || receivedSize >= expectedSize) {
                        if (!sourceBuffer || sourceBuffer.updating) return;
                
                        // Sort chunks by index to ensure proper sequence
                        const sortedChunks = Object.values(pendingChunks)
                            .sort((a, b) => a.index - b.index);
                
                        // Combine all chunks into one buffer
                        const totalSize = sortedChunks.reduce((sum, chunk) => sum + chunk.size, 0);
                        const combinedBuffer = new Uint8Array(totalSize);
                        let offset = 0;
                
                        for (const chunk of sortedChunks) {
                            combinedBuffer.set(chunk.data, offset);
                            offset += chunk.size;
                        }
                
                        // Append the combined buffer
                        try {
                            sourceBuffer.appendBuffer(combinedBuffer);
                        } catch (e) {
                            console.error('Error appending combined buffer:', e);
                        }
                
                        // Clear pending chunks
                        pendingChunks = [];
                    }
                    break;

                case 'video-complete':
                    console.log('Video transfer complete');
                    break;

                case 'video-request':
                    if (isHost && videoFile) {
                        console.log('Starting video stream');
                        await startStreamingTo(conn);
                    }
                    break;

                case 'chat':
                    handleChatMessage(data);
                    break;

                case 'control':
                    if (!player || !allowEmit) return;
                    
                    try {
                        const currentTime = player.currentTime();
                        allowEmit = false;

                        switch(data.action) {
                            case 'play':
                                if (player.paused()) {
                                    if (Math.abs(currentTime - data.time) > 3) {
                                        player.currentTime(data.time);
                                        // Request chunks if needed
                                        requestMissingChunks(data.time, data.time + 10);
                                    }
                                    player.play();
                                }
                                break;
                                
                            case 'pause':
                                if (!player.paused()) {
                                    player.pause();
                                }
                                break;
                                
                            case 'seek':
                                if (Math.abs(currentTime - data.time) > 0.5) {
                                    player.currentTime(data.time);
                                    // Request chunks for new position
                                    requestMissingChunks(data.time, data.time + 10);
                                }
                                break;
                        }

                        append({
                            name: "Local Party",
                            content: time(data.action, data.username || "Someone", data.time),
                            pfp: "#f3dfbf"
                        });

                    } catch (e) {
                        console.error('Error handling video control:', e);
                    } finally {
                        setTimeout(() => { allowEmit = true; }, data.action === 'seek' ? 1000 : 500);
                    }
                    break;
            }
        } catch (error) {
            console.error('Error processing data:', error);
            mediaState.hasError = true;
            notyf.error("Error processing video data");
        }
    });

    // Rest of connection setup...
    conn.on('open', () => {
        console.log('Connection opened to peer:', conn.peer);
        if (!isHost) {
            conn.send({ type: 'video-request' });
        }
    });

    conn.on('close', () => {
        handleConnectionClose(conn);
    });

    conn.on('error', (err) => {
        handleConnectionError(conn, err);
    });
}

    // Helper function to set up video control events
    function setupVideoControls() {
        if (!player) return;

        player.on('play', () => {
            if (!allowEmit) return;
            allowEmit = false;
            
            const controlData = {
                type: 'control',
                action: 'play',
                time: player.currentTime(),
                username: localStorage.getItem("username")
            };
            
            conn.send(controlData);
            setTimeout(() => { allowEmit = true; }, 500);
        });

        player.on('pause', () => {
            if (!allowEmit) return;
            allowEmit = false;
            
            const controlData = {
                type: 'control',
                action: 'pause',
                time: player.currentTime(),
                username: localStorage.getItem("username")
            };
            
            conn.send(controlData);
            setTimeout(() => { allowEmit = true; }, 500);
        });

        player.on('seeking', () => {
            if (!allowEmit) return;
            allowEmit = false;
            
            const controlData = {
                type: 'control',
                action: 'seek',
                time: player.currentTime(),
                username: localStorage.getItem("username")
            };
            
            conn.send(controlData);
            setTimeout(() => { allowEmit = true; }, 500);
        });
    }


let isProcessingChunks = false;
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

            // Wait if source buffer is updating
            while (sourceBuffer.updating) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            try {
                const chunk = pendingChunks[i];
                sourceBuffer.appendBuffer(chunk);

                // Wait for the append to complete
                await new Promise((resolve, reject) => {
                    sourceBuffer.addEventListener('updateend', resolve, { once: true });
                    sourceBuffer.addEventListener('error', reject, { once: true });
                });

                // Log buffer status
                if (sourceBuffer.buffered.length > 0) {
                    const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
                    console.log(`Processed chunk ${i + 1}/${pendingChunks.length}, buffer end: ${end.toFixed(2)}s`);
                }

            } catch (e) {
                if (e.name === 'QuotaExceededError') {
                    // Handle quota exceeded by removing old buffer
                    if (sourceBuffer.buffered.length > 0) {
                        const currentTime = player.currentTime();
                        const start = sourceBuffer.buffered.start(0);
                        const removeEnd = Math.max(start, currentTime - 10);

                        await new Promise(resolve => {
                            sourceBuffer.remove(start, removeEnd);
                            sourceBuffer.addEventListener('updateend', resolve, { once: true });
                        });

                        // Retry this chunk
                        i--;
                    }
                } else {
                    console.error(`Error processing chunk ${i + 1}:`, e);
                }
            }
        }

        // Clear processed chunks
        pendingChunks = [];
        
        // Don't end the stream immediately
        if (receivedSize >= expectedSize) {
            // Wait a bit to ensure all data is properly buffered
            setTimeout(() => {
                if (mediaSource && mediaSource.readyState === 'open') {
                    console.log('All chunks processed, ending stream');
                    mediaSource.endOfStream();
                }
            }, 2000);
        }

    } catch (error) {
        console.error('Error in processAllChunks:', error);
    } finally {
        isProcessingChunks = false;
    }
}

// Helper function to handle video chunk data
function handleVideoChunk(data) {
    const chunk = new Uint8Array(data.data);
    
    // Split large chunks into smaller segments
    if (chunk.byteLength > MAX_SEGMENT_SIZE) {
        let offset = 0;
        while (offset < chunk.byteLength) {
            const size = Math.min(MAX_SEGMENT_SIZE, chunk.byteLength - offset);
            const segment = new Uint8Array(chunk.buffer, offset, size);
            pendingChunks.push(segment);
            offset += size;
        }
    } else {
        pendingChunks.push(chunk);
    }
    
    receivedSize += chunk.byteLength;
    console.log(`Segmented chunk into ${pendingChunks.length} pieces`);

    if (!sourceBuffer.updating) {
        processNextSegment();
    }
}

// Process segments sequentially
async function processNextSegment() {
    if (!sourceBuffer || sourceBuffer.updating || pendingChunks.length === 0) {
        return;
    }

    try {
        const segment = pendingChunks[0];
        sourceBuffer.appendBuffer(segment);

        // Wait for segment to be processed
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

        // Remove processed segment
        pendingChunks.shift();

        // Log buffer status
        if (sourceBuffer.buffered.length > 0) {
            const start = sourceBuffer.buffered.start(0);
            const end = sourceBuffer.buffered.end(0);
            console.log(`Buffer range: ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
        }

        // Process next segment if available
        if (pendingChunks.length > 0) {
            setTimeout(() => processNextSegment(), 0);
        }

    } catch (error) {
        if (error.name === 'QuotaExceededError') {
            // Remove old buffer data
            if (sourceBuffer.buffered.length > 0) {
                const currentTime = player.currentTime();
                const start = sourceBuffer.buffered.start(0);
                const removeEnd = Math.max(start, currentTime - 10);

                try {
                    await new Promise(resolve => {
                        sourceBuffer.remove(start, removeEnd);
                        sourceBuffer.addEventListener('updateend', resolve, { once: true });
                    });
                    // Retry current segment
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

    console.log(`Processing chunks: ${pendingChunks.length} available`);

    // Find first unprocessed chunk
    let nextIndex = 0;
    while (pendingChunks[nextIndex]?.processed) {
        nextIndex++;
    }

    try {
        while (pendingChunks[nextIndex] && !sourceBuffer.updating) {
            const nextChunk = pendingChunks[nextIndex];
            console.log(`Processing chunk ${nextIndex} at offset ${nextChunk.offset}`);

            // Set timestamp offset for continuity
            if (nextIndex > 0 && sourceBuffer.buffered.length > 0) {
                const lastEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
                sourceBuffer.timestampOffset = lastEnd;
            }

            await new Promise((resolve, reject) => {
                const handleUpdateEnd = () => {
                    sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
                    sourceBuffer.removeEventListener('error', handleError);
                    
                    if (sourceBuffer.buffered.length > 0) {
                        console.log(`After chunk ${nextIndex} - Buffer ranges:`);
                        for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                            console.log(`Range ${i}: ${sourceBuffer.buffered.start(i).toFixed(3)}s to ${sourceBuffer.buffered.end(i).toFixed(3)}s`);
                        }
                    }
                    resolve();
                };

                const handleError = (err) => {
                    sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
                    sourceBuffer.removeEventListener('error', handleError);
                    reject(err);
                };

                sourceBuffer.addEventListener('updateend', handleUpdateEnd);
                sourceBuffer.addEventListener('error', handleError);

                sourceBuffer.appendBuffer(nextChunk.data);
            });

            nextChunk.processed = true;
            nextIndex++;
        }
    } catch (e) {
        console.error('Error in processChunkBatch:', e);
        if (e.name === 'QuotaExceededError') {
            await handleQuotaExceeded();
        }
    }
}
// Helper function to append a chunk with retry logic
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

            return; // Success, exit function
        } catch (e) {
            attempt++;
            if (e.name === 'QuotaExceededError') {
                await handleQuotaExceeded();
                continue;
            }
            if (attempt === maxRetries) throw e;
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
        }
    }
}
function setupSourceBuffer(mimeType) {
    if (!mediaSource || mediaSource.readyState !== 'open') return;

    try {
        if (mimeType === 'video/webm') {
            mimeType = 'video/webm;codecs="vp8,vorbis"';
        }
        
        sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        // Change to 'segments' mode to handle discontinuous appends
        sourceBuffer.mode = 'sequence';
        sourceBuffer.timestampOffset = 0;  
        console.log('Created source buffer in segments mode');
        
        // Initialize timestamp offset to 0
        sourceBuffer.timestampOffset = 0;
        
        sourceBuffer.addEventListener('updateend', () => {
            if (sourceBuffer.buffered.length > 0) {
                // Log all current ranges
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
// Helper function to handle video complete event
function handleVideoComplete() {
    console.log('Video transfer complete');
    
    // Only end the stream if we've processed all segments and the buffer is stable
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
            
            // Log all buffer ranges
            let hasValidRange = false;
            for (let i = 0; i < sourceBuffer.buffered.length; i++) {
                const start = sourceBuffer.buffered.start(i);
                const end = sourceBuffer.buffered.end(i);
                console.log(`Buffer range ${i}: ${start.toFixed(3)}s to ${end.toFixed(3)}s`);
                
                if (currentTime >= start && currentTime <= end) {
                    hasValidRange = true;
                }
            }
            
            // If we have pending chunks, process them regardless of valid range
            if (pendingChunks.length > 0 && !sourceBuffer.updating) {
                console.log('Processing pending chunks...');
                processChunkBatch(); // Use batch processing instead of single chunks
            } else if (!hasValidRange) {
                console.log('No valid range for current time:', currentTime);
            }
        } else {
            console.log('No buffered ranges available');
            // If we have chunks but no buffer, start processing
            if (pendingChunks.length > 0 && sourceBuffer && !sourceBuffer.updating) {
                console.log('Starting initial chunk processing...');
                processChunkBatch();
            }
        }
    });

    // Add canplay handler
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

    // Add play handler
    player.on('play', () => {
        console.log('Play event triggered');
        if (pendingChunks.length > 0 && sourceBuffer && !sourceBuffer.updating) {
            console.log('Processing chunks on play');
            processChunkBatch();
        }
    });

    // Handle play/pause events
    player.on('play', () => {
        console.log('Local play event triggered');
        broadcastVideoControl('play');
    });

    player.on('pause', () => {
        console.log('Local pause event triggered');
        broadcastVideoControl('pause');
    });
    player.on('seeking', () => {
        if (!allowEmit) return;
        console.log('Local seek event triggered');
        
        broadcastVideoControl('seek');
    });
}
// Helper function to handle chat messages
function handleChatMessage(data) {
    append({
        name: data.username,
        content: data.message,
        pfp: data.pfp || '#f3dfbf'
    });
}

function broadcastVideoControl(action) {
    if (!allowEmit) return;  // Add this check
    
    allowEmit = false;
    const currentTime = player.currentTime();
    console.log(`Broadcasting ${action} control at time ${currentTime}`);
    
    const controlData = {
        type: 'control',
        action: action,
        time: currentTime,
        username: localStorage.getItem("username")
    };
    
    console.log('Sending control data:', controlData);
    
    // Send to all connected peers
    Object.values(connections).forEach(conn => {
        if (conn.open) {
            conn.send(controlData);
        }
    });

    // Use longer timeout for seek events
    setTimeout(() => { allowEmit = true; }, action === 'seek' ? 1000 : 500);
}
// Helper function to handle connection close
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

// Helper function to handle connection errors
function handleConnectionError(conn, err) {
    console.error('Connection error:', err);
    mediaState.hasError = true;
    notyf.error("Connection error occurred");
    
    // Clean up
    delete connections[conn.peer];
    if (mediaState.mediaSourceUrl) {
        URL.revokeObjectURL(mediaState.mediaSourceUrl);
    }
}
// State management object
const mediaState = {
    isReady: false,
    hasError: false,
    mediaSourceReady: false,
    sourceBufferReady: false,
    isInitializing: false,
    mediaSourceUrl: null,
    initComplete: false
};

// Function to set up MediaSource and SourceBuffer
async function setupMediaSource(videoElement, mimeType) {
    return new Promise((resolve, reject) => {
        try {
            // Reset state
            mediaState.isReady = false;
            mediaState.hasError = false;
            mediaState.initComplete = false;

            // Cleanup existing MediaSource
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

            // Create new MediaSource
            mediaSource = new MediaSource();
            mediaState.mediaSourceUrl = URL.createObjectURL(mediaSource);
            console.log('Created new MediaSource');

            let setupComplete = false;

            const handleSourceOpen = async () => {
                // Prevent multiple executions
                if (setupComplete) return;
                setupComplete = true;

                // Remove the event listener immediately
                mediaSource.removeEventListener('sourceopen', handleSourceOpen);

                try {
                    console.log('MediaSource opened');
                    
                    // Set up SourceBuffer only if it doesn't exist
                    if (!sourceBuffer) {
                        const finalMimeType = mimeType === 'video/webm' ? 
                            'video/webm;codecs="vp8,vorbis"' : mimeType;

                        sourceBuffer = mediaSource.addSourceBuffer(finalMimeType);
                        sourceBuffer.mode = 'sequence';
                        sourceBuffer.timestampOffset = 0;  
                        console.log('SourceBuffer created');

                        // Add updateend listener only once
                        sourceBuffer.addEventListener('updateend', () => {
                            if (pendingChunks.length > 0 && !sourceBuffer.updating) {
                                processNextChunk();
                            }
                        });
                    }

                    // Update player source only if needed
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

            // Add the sourceopen listener with once option
            mediaSource.addEventListener('sourceopen', handleSourceOpen, { once: true });
            
            // Set video element source
            videoElement.src = mediaState.mediaSourceUrl;

        } catch (error) {
            console.error('Error in setupMediaSource:', error);
            mediaState.hasError = true;
            reject(error);
        }
    });
}
// Helper function to get proper MIME type and codecs
function getVideoMimeType(file) {
    // Start with the file's type
    let mimeType = file.type;
    
    // If file.type is empty or generic "video", try to detect from extension
    if (!mimeType || mimeType === 'video' || mimeType === 'video/') {
        const ext = file.name.split('.').pop().toLowerCase();
        switch (ext) {
            case 'mp4':
                mimeType = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
                break;
            case 'webm':
                mimeType = 'video/webm; codecs="vp8, vorbis"';
                break;
            case 'ogg':
                mimeType = 'video/ogg; codecs="theora, vorbis"';
                break;
            case 'mov':
                mimeType = 'video/quicktime';
                break;
            case 'mkv':
                mimeType = 'video/x-matroska';
                break;
            case 'avi':
                mimeType = 'video/x-msvideo';
                break;
            case '3gp':
                mimeType = 'video/3gpp';
                break;
            default:
                // Default to MP4 if we can't detect
                mimeType = 'video/mp4';
        }
    }
    
    console.log('Detected MIME type:', mimeType, 'for file:', file.name);
    return mimeType;
}

// Update startStreamingTo to use proper MIME type
async function startStreamingTo(conn) {
    try {
        if (!videoFile) {
            throw new Error('No video file available');
        }

        console.log('Starting video stream with file:', videoFile);
        const mimeType = getVideoMimeType(videoFile);
        
        // Send metadata
        const metadata = {
            type: 'video-metadata',
            name: videoFile.name,
            size: videoFile.size,
            mimeType: mimeType,
            lastModified: videoFile.lastModified
        };
        
        conn.send(metadata);
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Clear stored chunks for new connection
        storedChunks = [];
        
        // Stream chunks
        let offset = 0;
        let chunkIndex = 0;
        while (offset < videoFile.size) {
            const chunk = videoFile.slice(offset, offset + CHUNK_SIZE);
            const buffer = await chunk.arrayBuffer();
            
            // Store chunk with index for later retrieval
            storedChunks.push({
                index: chunkIndex,
                data: buffer,
                offset: offset
            });
            
            conn.send({
                type: 'video-chunk',
                data: buffer,
                offset: offset,
                total: videoFile.size,
                index: chunkIndex
            });
            
            offset += buffer.byteLength;
            chunkIndex++;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        conn.send({ type: 'video-complete' });
        notyf.success("Video sent to peer");
    } catch (err) {
        console.error('Error streaming video:', err);
        notyf.error("Error streaming video: " + err.message);
    }
}


// Handle incoming video metadata
function handleVideoMetadata(data) {
    console.log('Processing metadata:', data);
    expectedSize = data.size;
    
    // Reset state
    pendingChunks = [];
    receivedSize = 0;
    
    try {
        // Clean up existing MediaSource
        if (mediaSource) {
            if (mediaSource.readyState === 'open') {
                mediaSource.endOfStream();
            }
            if (mediaState.mediaSourceUrl) {
                URL.revokeObjectURL(mediaState.mediaSourceUrl);
            }
        }

        // Create new MediaSource
        mediaSource = new MediaSource();
        mediaState.mediaSourceUrl = URL.createObjectURL(mediaSource);
        videoElement.src = mediaState.mediaSourceUrl;

        mediaSource.addEventListener('sourceopen', () => {
            setupSourceBuffer(data.mimeType);
        }, { once: true });

        return true;
    } catch (error) {
        console.error('Error in handleVideoMetadata:', error);
        mediaState.hasError = true;
        return false;
    }
}


// Process next chunk in queue
// Improved chunk processing function with better buffer management
async function processNextChunk() {
    if (!sourceBuffer || sourceBuffer.updating || pendingChunks.length === 0) return;

    const chunk = pendingChunks[0];
    try {
        await appendChunkWithRetry(chunk.data);
        pendingChunks.shift();

        // Check if we can start playback
        if (sourceBuffer.buffered.length > 0) {
            const bufferedEnd = sourceBuffer.buffered.end(0);
            if (bufferedEnd > 3 && player.paused()) { // Start once we have 3 seconds
                player.play().catch(e => console.error('Auto-play failed:', e));
            }
        }
    } catch (e) {
        console.error('Error processing chunk:', e);
        if (e.name === 'QuotaExceededError') {
            await handleQuotaExceeded();
        }
    }
}
// Function to handle video metadata with proper initialization
async function initializeMediaSource(videoElement, mimeType) {
    if (mediaState.isInitializing) {
        console.log('Already initializing media source');
        return false;
    }

    mediaState.isInitializing = true;
    console.log('Starting media source initialization');

    try {
        // Clean up existing media source
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

        // Reset state
        sourceBuffer = null;
        mediaSource = new MediaSource();
        mediaState.mediaSourceUrl = URL.createObjectURL(mediaSource);

        await new Promise((resolve, reject) => {
            const sourceOpenHandler = () => {
                try {
                    console.log('MediaSource opened');
                    
                    // Set up source buffer
                    const finalMimeType = mimeType === 'video/webm' ? 
                        'video/webm;codecs="vp8,vorbis"' : mimeType;
                    
                    sourceBuffer = mediaSource.addSourceBuffer(finalMimeType);
                    sourceBuffer.mode = 'sequence';
                    sourceBuffer.timestampOffset = 0;  
                    console.log('SourceBuffer created successfully');

                    // Set up source buffer event listeners
                    sourceBuffer.addEventListener('updateend', () => {
                        if (pendingChunks.length > 0 && !sourceBuffer.updating) {
                            processNextChunk();
                        }
                    });

                    // Update player source
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
            
            // Reset state
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
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
        }
        attempts++;
    }
    
    console.error('All initialization attempts failed');
    return false;
}
// Helper function to handle quota exceeded error
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


// Helper function to append buffer with promise
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

// Helper function to check if stream is complete
function isStreamComplete() {
    return (
        receivedSize >= expectedSize && 
        pendingChunks.length === 0 && 
        sourceBuffer && 
        !sourceBuffer.updating
    );
}

// Add buffer monitoring to the player
// Update setupBufferMonitoring to be more defensive
function setupBufferMonitoring() {
    if (!player) return;

    // Check buffer status every 500ms
    setInterval(() => {
        if (sourceBuffer && player) {
            const currentTime = player.currentTime();
            removeOldBufferData(currentTime);

            // Rest of buffer monitoring logic...
            if (sourceBuffer.buffered.length > 0) {
                const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
                const bufferAhead = bufferedEnd - currentTime;
                
                console.log(`Buffer status: ${bufferAhead.toFixed(2)}s ahead, ` +
                          `${pendingChunks.length} chunks remaining, ` +
                          `${receivedSize}/${expectedSize} bytes received`);
            }
        }
    }, 500);
    
    // Handle waiting events more aggressively
player.on('waiting', () => {
    console.log('Video waiting for data');
    
    if (sourceBuffer && sourceBuffer.buffered.length > 0) {
        const currentTime = player.currentTime();
        
        // Log all buffer ranges
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

    // Cleanup on player dispose
    player.on('dispose', () => {
        clearInterval(bufferInterval);
    });
}
// Add a buffer check function
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



// Handle incoming video chunk
function handleVideoChunk(data) {
    const chunk = new Uint8Array(data.data);
    pendingChunks.push(chunk);
    receivedSize += chunk.byteLength;

    const percentage = ((receivedSize / expectedSize) * 100).toFixed(1);
    console.log(`Received chunk: ${receivedSize}/${expectedSize} bytes (${percentage}%)`);

    // Process immediately if possible
    if (mediaState.isReady && sourceBuffer && !sourceBuffer.updating) {
        processNextChunk();
    }
}

function initializePlayerControls() {
    if (!player) return;
    
    // Initially disable play button until we have enough data
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
// Handle video controls
function handleVideoControl(data) {
    if (!player || !allowEmit) return;  // Add allowEmit check here
    
    try {
        console.log('Processing control event:', data);
        const currentTime = player.currentTime();

        // Temporarily disable emit before making any changes
        allowEmit = false;

        switch(data.action) {
            case 'play':
                console.log('Handling play command');
                if (player.paused()) {
                    if (Math.abs(currentTime - data.time) > 3) {
                        console.log(`Syncing time before play: ${currentTime} -> ${data.time}`);
                        player.currentTime(data.time);
                    }
                    player.play().catch(e => console.error('Play failed:', e));
                }
                break;
                
            case 'pause':
                console.log('Handling pause command');
                if (!player.paused()) {
                    player.pause();
                }
                break;
                
            case 'seek':
                console.log(`Remote seek command received: ${data.time}`);
                if (Math.abs(currentTime - data.time) > 0.5) {
                    console.log(`Seeking: ${currentTime} -> ${data.time}`);
                    player.currentTime(data.time);
                }
                break;
        }

        // Log the action in chat
        const content = time(data.action === 'seek' ? "seeked" : data.action, 
                           data.username || "Someone", 
                           data.time);
        append({
            name: "Local Party",
            content: content,
            pfp: "#f3dfbf"
        });

    } catch (e) {
        console.error('Error handling video control:', e);
    } finally {
        // Re-enable emit after a delay
        setTimeout(() => { allowEmit = true; }, 1000);  // Increased delay for seek
    }
}

// Helper function for generating random strings
function randomString(length, chars) {
    let result = '';
    for (let i = length; i > 0; --i) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

// Format time for messages
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

// Append message to chat
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

// Append room data
function appendData(roomName, roomCode) {
    append({
        name: "Local Party",
        content: "Local Party allows you to watch local videos with your friends synchronously while chatting.",
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
        content: "The video will be automatically shared with others who join.",
        pfp: "#f3dfbf"
    });
}

// Handle file selection
function onChangeFile() {
    const fileInput = document.getElementById("file-id");
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return;
    
    videoFile = fileInput.files[0];
    const url = URL.createObjectURL(videoFile);
    
    player.src({
        src: url,
        type: videoFile.type
    });
}

// Video controls handler
function videoControlsHandler(e) {
    if (!allowEmit || !player || !mediaState.isReady) return;
    
    allowEmit = false;  // Prevent control echo
    
    try {
        const currentTime = player.currentTime();
        console.log(`Sending ${e.type} command at time ${currentTime}`);
        
        const controlData = {
            type: 'control',
            action: e.type,
            time: currentTime,
            username: localStorage.getItem("username")
        };
        
        // Send to all connected peers
        Object.values(connections).forEach(conn => {
            if (conn.open) {
                conn.send(controlData);
            }
        });
        
        // Log local action
        const content = time(e.type === 'play' ? "played" : "paused", "You", currentTime);
        append({
            name: "Local Party",
            content: content,
            pfp: "#f3dfbf"
        });
    } catch (e) {
        console.error('Error in video controls handler:', e);
    }
    
    // Re-enable control emission after a delay
    setTimeout(() => { allowEmit = true; }, 500);
}

// Additional video player event listeners
function initializeVideoPlayerEvents() {
    if (!player) return;
    
    // Handle seeking events
    player.on('seeking', () => {
        if (!allowEmit) return;
        
        allowEmit = false;
        const currentTime = player.currentTime();
        removeOldBufferData(currentTime);
        
        Object.values(connections).forEach(conn => {
            if (conn.open) {
                conn.send({
                    type: 'control',
                    action: 'seek',
                    time: currentTime,
                    username: localStorage.getItem("username")
                });
            }
        });
        
        setTimeout(() => { allowEmit = true; }, 500);
    });
    
    // Handle buffering events
player.on('waiting', () => {
    console.log('Video waiting for data');
    
    if (sourceBuffer && sourceBuffer.buffered.length > 0) {
        const currentTime = player.currentTime();
        
        // Log all buffer ranges
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
    
    // Handle playback errors
    player.on('error', (error) => {
        console.error('Video playback error:', error);
        if (mediaSource && sourceBuffer && !sourceBuffer.updating) {
            processNextChunk();
        }
    });
}

// Set up event listeners
document.addEventListener("click", function(e) {
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
            const fileInput = document.getElementById("file-id");
            if (fileInput) fileInput.style.display = "none";
            break;
            
        case "roomJoinButton":
            handleRoomJoin();
            break;
            
        case "roomLeaveButton":
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

// Handle room creation
function handleRoomCreate() {
    const roomName = document.getElementById("roomname").value;
    const username = document.getElementById("create-username").value;
    
    if (!roomName || !username) {
        document.getElementById("createRoomText").innerHTML = "Please fill in all fields";
        return;
    }
    
    const fileInput = document.getElementById("file-id");
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
        document.getElementById("createRoomText").innerHTML = "Please select a video file";
        return;
    }
    
    if (!videoFile) {
        videoFile = fileInput.files[0];
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

// Handle room joining
function handleRoomJoin() {
    const hostPeerId = document.getElementById("roomCode").value;
    const username = document.getElementById("join-username").value;
    
    if (!hostPeerId || !username) {
        document.getElementById("joinRoomText").innerHTML = "Please fill in all fields";
        return;
    }
    
    localStorage.setItem("username", username);
    
    initializePeer(false);
    
    // Clear any existing video
    if (player) {
        player.reset();
    }
    videoFile = null;
    
    peer.on('open', () => {
        console.log('Connecting to host:', hostPeerId);
        const conn = peer.connect(hostPeerId);
        
        conn.on('open', () => {
            console.log('Connected to host successfully');
            setupConnection(conn);
            
            conn.send({
                type: 'video-request'
            });
            
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

// Set up chat form handling
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
// Add better buffer monitoring
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
            
            // More aggressive chunk processing
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
    
    // Log SourceBuffer ranges
    if (sourceBuffer.buffered.length > 0) {
        console.log("SourceBuffer ranges:");
        for (let i = 0; i < sourceBuffer.buffered.length; i++) {
            const start = sourceBuffer.buffered.start(i);
            const end = sourceBuffer.buffered.end(i);
            console.log(`Range ${i}: ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
        }
    }
    
    // Log Video Element ranges
    if (videoElement.buffered.length > 0) {
        console.log("Video Element ranges:");
        for (let i = 0; i < videoElement.buffered.length; i++) {
            const start = videoElement.buffered.start(i);
            const end = videoElement.buffered.end(i);
            console.log(`Range ${i}: ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
        }
    }
}
// Set up room code click-to-copy
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
