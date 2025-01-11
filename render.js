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

// Initialize the application
function initializeApp() {
    console.log('Initializing app...');
    
    try {
        // Only initialize if player doesn't exist
        if (!player) {
            player = videojs('video-player', {
                controls: true,
                preload: 'auto',
                fluid: true,
                playsinline: true,
                html5: {
                    vhs: {
                        overrideNative: true
                    },
                    nativeVideoTracks: false,
                    nativeAudioTracks: false,
                    nativeTextTracks: false
                }
            });
            
            console.log('Video.js initialized');
            
            // Set up video player event handlers
            player.on('error', function(error) {
                console.error('Video.js error:', player.error());
                if (mediaSource && sourceBuffer && !sourceBuffer.updating) {
                    processNextChunk();
                }
            });

            player.on('waiting', function() {
                console.log('Video waiting for data');
                if (mediaSource && sourceBuffer && !sourceBuffer.updating) {
                    processNextChunk();
                }
            });

            // Add play/pause event listeners
            player.on('play', videoControlsHandler);
            player.on('pause', videoControlsHandler);
            // Set up buffer monitoring
            setupBufferMonitoring();
            console.log('Buffer monitoring initialized');
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
    try {
        connections[conn.peer] = conn;
        let metadataInitialized = false;
        let mediaSourceReady = false;
        
        // Reset state variables on new connection
        pendingChunks = [];
        receivedSize = 0;
        expectedSize = 0;
        isFirstChunk = true;
        
        // Get video element
        const videoElement = document.querySelector('#video-player_html5_api');
        if (!videoElement) {
            throw new Error('Video element not found');
        }

        // Handle incoming data
        conn.on('data', async (data) => {
            console.log('Received data type:', data.type);
            
            try {
                switch (data.type) {
                    case 'video-metadata':
                        console.log('Processing metadata:', data);
                        expectedSize = data.size;
                        
                        try {
                            // Initialize media source with proper mime type
                            await setupMediaSource(videoElement, data.mimeType);
                            metadataInitialized = true;
                            mediaSourceReady = true;
                            
                            // Process any queued chunks
                            if (pendingChunks.length > 0) {
                                console.log(`Processing ${pendingChunks.length} queued chunks`);
                                await processNextChunk();
                            }
                        } catch (e) {
                            console.error('Error setting up media source:', e);
                            notyf.error("Error setting up video stream");
                        }
                        break;
                        
                    case 'video-chunk':
                        handleVideoChunkData(data, metadataInitialized, mediaSourceReady);
                        break;
                        
                    case 'video-complete':
                        console.log('Video transfer complete. Total chunks received:', pendingChunks.length);
                        handleVideoComplete(metadataInitialized, mediaSourceReady);
                        break;
                        
                    case 'video-request':
                        if (isHost && videoFile) {
                            console.log('Received video request, starting stream');
                            await startStreamingTo(conn);
                        }
                        break;
                        
                    case 'request-more-chunks':
                        // Handle requests for additional chunks if needed
                        if (isHost && videoFile) {
                            console.log('Received request for more chunks');
                            // Implementation for sending more chunks
                        }
                        break;
                        
                    case 'chat':
                        handleChatMessage(data);
                        break;
                        
                    case 'control':
                        if (!player || !mediaSourceReady) {
                            console.log('Ignoring control command - player not ready');
                            return;
                        }
                        handleVideoControl(data);
                        break;
                        
                    default:
                        console.warn('Unknown data type received:', data.type);
                }
            } catch (error) {
                console.error('Error processing received data:', error);
                notyf.error("Error processing video data");
            }
        });

        // Connection event handlers
        conn.on('open', () => {
            console.log('Connection opened to peer:', conn.peer);
            if (!isHost) {
                console.log('Sending video request to host');
                conn.send({ type: 'video-request' });
            }
            append({
                name: 'Local Party',
                content: 'Connected to peer.',
                pfp: '#f3dfbf'
            });
        });

        conn.on('close', () => {
            handleConnectionClose(conn);
        });

        conn.on('error', (err) => {
            handleConnectionError(conn, err);
        });

    } catch (error) {
        console.error('Error in setupConnection:', error);
        notyf.error("Error setting up connection");
    }
}

// Helper function to handle video chunk data
function handleVideoChunkData(data, metadataInitialized, mediaSourceReady) {
    const chunk = new Uint8Array(data.data);
    
    if (!metadataInitialized) {
        console.log('Queuing chunk while waiting for metadata initialization');
        pendingChunks.push(chunk);
        return;
    }
    
    pendingChunks.push(chunk);
    console.log(`Received chunk, size: ${chunk.length}, total queued: ${pendingChunks.length}`);
    
    if (mediaSourceReady && !sourceBuffer.updating) {
        processNextChunk();
    }
}

// Helper function to handle video complete event
function handleVideoComplete(metadataInitialized, mediaSourceReady) {
    if (metadataInitialized && mediaSourceReady) {
        processNextChunk();
    }
}

// Helper function to handle chat messages
function handleChatMessage(data) {
    append({
        name: data.username,
        content: data.message,
        pfp: data.pfp || '#f3dfbf'
    });
}

// Helper function to handle connection close
function handleConnectionClose(conn) {
    console.log('Connection closed to peer:', conn.peer);
    delete connections[conn.peer];
    append({
        name: 'Local Party',
        content: 'A user has disconnected.',
        pfp: '#f3dfbf'
    });

    // Clean up resources if needed
    if (!isHost && Object.keys(connections).length === 0) {
        if (mediaSource && mediaSource.readyState === 'open') {
            try {
                mediaSource.endOfStream();
            } catch (e) {
                console.warn('Error ending media stream:', e);
            }
        }
    }
}

// Helper function to handle connection errors
function handleConnectionError(conn, err) {
    console.error('Connection error with peer:', conn.peer, err);
    notyf.error("Connection error occurred");
    
    // Clean up the connection
    delete connections[conn.peer];
    
    // Attempt to reconnect if appropriate
    if (!isHost) {
        setTimeout(() => {
            console.log('Attempting to reconnect...');
            conn.reconnect();
        }, 2000);
    }
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

        // Get proper MIME type from file
        const mimeType = getVideoMimeType(videoFile);

        // Send metadata with proper MIME type
        const metadata = {
            type: 'video-metadata',
            name: videoFile.name,
            size: videoFile.size,
            mimeType: mimeType,
            lastModified: videoFile.lastModified
        };
        
        console.log('Sending metadata:', metadata);
        conn.send(metadata);

        // Add delay to ensure metadata is processed
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Stream chunks
        let offset = 0;
        while (offset < videoFile.size) {
            const chunk = videoFile.slice(offset, offset + CHUNK_SIZE);
            const buffer = await chunk.arrayBuffer();
            
            conn.send({
                type: 'video-chunk',
                data: buffer,
                offset: offset,
                total: videoFile.size
            });
            
            offset += buffer.byteLength;
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
    console.log('Received video metadata:', data);
    
    return new Promise((resolve, reject) => {
        try {
            // Reset state
            pendingChunks = [];
            receivedSize = 0;
            expectedSize = data.size;
            videoType = data.type || 'video/webm;codecs="vp8,opus"';
            
            console.log(`Initializing stream: size=${expectedSize}, type=${videoType}`);
            
            // Create new MediaSource
            mediaSource = new MediaSource();
            const url = URL.createObjectURL(mediaSource);
            
            mediaSource.addEventListener('sourceopen', () => {
                try {
                    console.log('MediaSource opened, setting up source buffer');
                    sourceBuffer = mediaSource.addSourceBuffer(videoType);
                    sourceBuffer.mode = 'sequence';
                    
                    sourceBuffer.addEventListener('updateend', () => {
                        console.log('Source buffer updated, checking queue');
                        processNextChunk();
                    });
                    
                    // Set up player source after buffer is ready
                    console.log('Setting player source to:', url);
                    player.src({
                        src: url,
                        type: videoType
                    });
                    
                    // Reset player state
                    player.currentTime(0);
                    player.pause();
                    
                    resolve();
                } catch (e) {
                    console.error('Error in sourceopen:', e);
                    reject(e);
                }
            });
            
        } catch (e) {
            console.error('Error in handleVideoMetadata:', e);
            reject(e);
        }
    });
}


// Process next chunk in queue
// Improved chunk processing function with better buffer management
async function processNextChunk() {
    // Guard clauses for essential components
    if (!sourceBuffer || !mediaSource) {
        console.log('Media components not ready');
        return;
    }

    // If we have no chunks to process, exit early
    if (pendingChunks.length === 0) {
        if (isStreamComplete()) {
            console.log('Stream complete, no more chunks to process');
            if (mediaSource.readyState === 'open') {
                try {
                    mediaSource.endOfStream();
                } catch (e) {
                    console.warn('Error ending media stream:', e);
                }
            }
        }
        return;
    }

    // If source buffer is updating, schedule next update
    if (sourceBuffer.updating) {
        console.log('Source buffer updating, scheduling next chunk');
        setTimeout(processNextChunk, 10);
        return;
    }

    try {
        // Get buffer status
        let currentTime = 0;
        let bufferedEnd = 0;
        let bufferAhead = 0;

        try {
            currentTime = player.currentTime();
            bufferedEnd = sourceBuffer.buffered.length ? 
                sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) : 0;
            bufferAhead = bufferedEnd - currentTime;
        } catch (e) {
            console.warn('Error getting buffer status:', e);
        }

        // Determine how many chunks to process based on buffer status
        const chunksToProcess = bufferAhead < 2 ? 3 : 1;
        console.log(`Buffer ahead: ${bufferAhead.toFixed(2)}s, Processing ${chunksToProcess} chunks`);

        let currentChunk = null;
        for (let i = 0; i < chunksToProcess && pendingChunks.length > 0; i++) {
            try {
                currentChunk = pendingChunks.shift();
                if (!currentChunk) continue;

                // Track received data
                receivedChunks.push(currentChunk);
                receivedSize += currentChunk.byteLength;

                // Special handling for first chunk
                if (isFirstChunk) {
                    isFirstChunk = false;
                    await appendBufferAsync(currentChunk);
                    continue;
                }

                // Handle quota exceeded error
                try {
                    await appendBufferAsync(currentChunk);
                } catch (e) {
                    if (e.name === 'QuotaExceededError') {
                        console.log('Buffer quota exceeded, combining remaining chunks');
                        if (currentChunk) pendingChunks.unshift(currentChunk);
                        await handleQuotaExceeded();
                        break;
                    } else {
                        throw e;
                    }
                }

                // Update buffer status
                if (sourceBuffer.buffered.length > 0) {
                    const newBufferedEnd = sourceBuffer.buffered.end(0);
                    const bufferedDuration = newBufferedEnd - sourceBuffer.buffered.start(0);
                    console.log(`Buffer status: ${bufferedDuration.toFixed(2)}s buffered, ` +
                              `Total received: ${receivedSize}/${expectedSize} ` +
                              `(${((receivedSize/expectedSize)*100).toFixed(1)}%)`);

                    // Enable play when we have enough buffer
                    if (bufferedDuration >= 0.5 && player.controlBar.playToggle.hasClass('vjs-disabled')) {
                        console.log('Enabling play button');
                        player.controlBar.playToggle.enable();
                    }
                }
            } catch (chunkError) {
                console.error('Error processing individual chunk:', chunkError);
                if (currentChunk) pendingChunks.unshift(currentChunk);
                break;
            }
        }

        // Schedule next chunk processing if needed
        if (pendingChunks.length > 0) {
            requestAnimationFrame(processNextChunk);
        } else if (isStreamComplete()) {
            console.log('All chunks processed successfully');
            if (mediaSource.readyState === 'open') {
                try {
                    await new Promise(resolve => setTimeout(resolve, 100)); // Small delay before ending
                    mediaSource.endOfStream();
                } catch (e) {
                    console.warn('Error ending media stream:', e);
                }
            }
        }

    } catch (error) {
        console.error('Error in processNextChunk:', error);
        setTimeout(processNextChunk, 100);
    }
}

// Helper function to handle quota exceeded error
async function handleQuotaExceeded() {
    try {
        // Combine all remaining chunks into one buffer
        const totalSize = pendingChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const combinedBuffer = new Uint8Array(totalSize);
        let offset = 0;
        
        pendingChunks.forEach(chunk => {
            combinedBuffer.set(new Uint8Array(chunk), offset);
            offset += chunk.byteLength;
        });
        
        // Replace pending chunks with combined buffer
        pendingChunks = [combinedBuffer.buffer];
        console.log('Combined remaining chunks into single buffer of size:', totalSize);
    } catch (e) {
        console.error('Error in handleQuotaExceeded:', e);
        throw e;
    }
}


// Helper function to append buffer with promise
function appendBufferAsync(chunk) {
    return new Promise((resolve, reject) => {
        if (!sourceBuffer || sourceBuffer.updating) {
            reject(new Error('SourceBuffer not ready'));
            return;
        }

        try {
            const appendStartTime = performance.now();
            sourceBuffer.appendBuffer(chunk);
            
            function updateEndHandler() {
                sourceBuffer.removeEventListener('updateend', updateEndHandler);
                sourceBuffer.removeEventListener('error', errorHandler);
                const appendDuration = performance.now() - appendStartTime;
                console.log(`Chunk appended in ${appendDuration.toFixed(2)}ms`);
                resolve();
            }
            
            function errorHandler(e) {
                sourceBuffer.removeEventListener('updateend', updateEndHandler);
                sourceBuffer.removeEventListener('error', errorHandler);
                reject(e);
            }
            
            sourceBuffer.addEventListener('updateend', updateEndHandler);
            sourceBuffer.addEventListener('error', errorHandler);
        } catch (e) {
            reject(e);
        }
    });
}

// Helper function to check if stream is complete
function isStreamComplete() {
    return receivedSize >= expectedSize && 
           pendingChunks.length === 0 && 
           !sourceBuffer.updating;
}

// Add buffer monitoring to the player
function setupBufferMonitoring() {
    if (!player) return;

    // Monitor buffer status during playback
    player.on('timeupdate', () => {
        if (sourceBuffer && sourceBuffer.buffered.length > 0) {
            const currentTime = player.currentTime();
            const bufferedEnd = sourceBuffer.buffered.end(0);
            const bufferAhead = bufferedEnd - currentTime;
            
            // If buffer is running low, process more chunks
            if (bufferAhead < 3 && pendingChunks.length > 0) {
                console.log('Buffer running low, processing more chunks');
                processNextChunk();
            }
        }
    });

    // Handle waiting events
    player.on('waiting', () => {
        console.log('Video waiting for data');
        if (pendingChunks.length > 0) {
            processNextChunk();
        }
    });
}

// Add a buffer check function
function checkBuffer() {
    if (!sourceBuffer || !mediaSource) return;
    
    if (sourceBuffer.buffered.length > 0) {
        const currentTime = player.currentTime();
        const bufferedEnd = sourceBuffer.buffered.end(0);
        const bufferedStart = sourceBuffer.buffered.start(0);
        
        console.log(`Current time: ${currentTime}, Buffered: ${bufferedStart}-${bufferedEnd}, Chunks remaining: ${pendingChunks.length}`);
        
        // More aggressive buffering - start loading when we have less than 5 seconds ahead
        if (bufferedEnd - currentTime < 5) {
            if (pendingChunks.length > 0) {
                console.log('Buffer running low, processing more chunks');
                // Process multiple chunks at once
                for (let i = 0; i < 3 && pendingChunks.length > 0; i++) {
                    if (!sourceBuffer.updating) {
                        processNextChunk();
                    }
                }
            } else if (receivedSize < expectedSize) {
                console.log('Waiting for more data...');
                // Request more data from peer if needed
                Object.values(connections).forEach(conn => {
                    if (conn.open) {
                        conn.send({ type: 'request-more-chunks' });
                    }
                });
            }
        }
        
        // If we're completely out of buffer, try to recover
        if (currentTime >= bufferedEnd) {
            console.log('Buffer depleted, attempting recovery');
            if (pendingChunks.length > 0) {
                processNextChunk();
            }
        }
    }
}

// Add buffer monitoring to the player
player.on('timeupdate', checkBuffer);
player.on('waiting', () => {
    console.log('Video waiting for data');
    if (pendingChunks.length > 0) {
        processNextChunk();
    }
});

// Handle incoming video chunk
function handleVideoChunk(data) {
    const chunk = new Uint8Array(data.data);
    
    // Always queue the chunk, even if metadata isn't ready
    pendingChunks.push(chunk);
    
    if (!expectedSize) {
        console.log('Queuing chunk while waiting for metadata');
        return;
    }
    
    try {
        receivedSize += chunk.byteLength;
        const percentage = Math.round((receivedSize / expectedSize) * 100);
        console.log(`Received chunk: ${receivedSize}/${expectedSize} bytes (${percentage}%)`);

        // Try to process if source buffer is ready
        if (sourceBuffer && !sourceBuffer.updating) {
            processNextChunk();
        }

        // If this was the last chunk
        if (receivedSize >= expectedSize) {
            console.log('All chunks received, finishing stream');
            
            // Wait for all chunks to be processed
            const checkComplete = setInterval(() => {
                if (pendingChunks.length === 0 && !sourceBuffer.updating) {
                    clearInterval(checkComplete);
                    console.log('All chunks processed, ending stream');
                    
                    try {
                        mediaSource.endOfStream();
                        notyf.success("Video fully loaded");
                        
                        // Ensure video is playing if it should be
                        if (!player.paused()) {
                            player.play().catch(e => console.error('Play after complete failed:', e));
                        }
                    } catch (e) {
                        console.error('Error ending stream:', e);
                    }
                }
            }, 100);
        }
    } catch (error) {
        console.error('Error handling video chunk:', error);
        notyf.error("Error processing video chunk: " + error.message);
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
    if (!allowEmit || !player) return;
    
    allowEmit = false;  // Prevent echo
    
    try {
        // Always sync time first
        if (Math.abs(player.currentTime() - data.time) > 0.5) {
            console.log(`Syncing time from ${player.currentTime()} to ${data.time}`);
            player.currentTime(data.time);
        }

        // Then handle play/pause
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
    
    // Re-enable control emission after a delay
    setTimeout(() => { allowEmit = true; }, 500);
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
    if (!allowEmit || !player) return;
    
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
        console.log('Video buffering...');
        if (mediaSource && sourceBuffer && !sourceBuffer.updating) {
            processNextChunk();
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
