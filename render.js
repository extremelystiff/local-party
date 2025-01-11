// Initialize Notyf for notifications
const notyf = new Notyf({ duration: 1500, position: { x: 'center', y: 'top' } });

// PeerJS variables
let peer = null;
let connections = {};
let videoFile = null;
const CHUNK_SIZE = 256 * 1024; // 1MB chunks

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
    
    // Reset state variables on new connection
    pendingChunks = [];
    receivedSize = 0;
    
    const videoElement = document.querySelector('#video-player_html5_api');
    
    conn.on('data', async (data) => {
        console.log('Received data type:', data.type);
        
        try {
            switch (data.type) {
                case 'video-metadata':
                    console.log('Processing metadata:', data);
                    
                    // Reset previous MediaSource
                    if (mediaSource) {
                        if (mediaSource.readyState === 'open') {
                            mediaSource.endOfStream();
                        }
                        mediaSource = null;
                        sourceBuffer = null;
                    }

                    // Create new MediaSource
                    mediaSource = new MediaSource();
                    console.log('Created new MediaSource');
                    
                    videoElement.src = URL.createObjectURL(mediaSource);
                    console.log('Set video element source');
                    
                    mediaSource.addEventListener('sourceopen', () => {
                        try {
                            console.log('MediaSource opened, state:', mediaSource.readyState);
                            
                            let mimeType = data.mimeType;
                            if (data.mimeType === 'video/webm') {
                                mimeType = 'video/webm;codecs="vp8,vorbis"';
                            }
                            
                            console.log('Creating source buffer with MIME type:', mimeType);
                            sourceBuffer = mediaSource.addSourceBuffer(mimeType);
                            sourceBuffer.mode = 'sequence';  // Use sequence mode as it worked better
                            console.log('Source buffer created and mode set to sequence');
                            
                            sourceBuffer.addEventListener('updateend', () => {
                                if (!mediaSourceReady) {
                                    mediaSourceReady = true;
                                    console.log('MediaSource ready for chunks');
                                }
                                
                                if (pendingChunks.length > 0) {
                                    processNextChunk();
                                }
                            });

                            metadataInitialized = true;
                            console.log('Metadata initialized, ready for chunks');
                            
                            // Process any queued chunks
                            if (pendingChunks.length > 0) {
                                processNextChunk();
                            }
                        } catch (e) {
                            console.error('Error in sourceopen:', e);
                        }
                    });
                    break;
                    
                case 'video-chunk':
                    const chunk = new Uint8Array(data.data);
                    pendingChunks.push(chunk);
                    receivedSize += chunk.byteLength;
                    
                    console.log(`Received chunk: ${receivedSize}/${expectedSize} bytes (${((receivedSize/expectedSize)*100).toFixed(1)}%)`);
                    
                    if (metadataInitialized && mediaSourceReady && !sourceBuffer.updating) {
                        processNextChunk();
                    }
                    break;
                    
                case 'video-complete':
                    console.log('Video transfer complete');
                    if (metadataInitialized && mediaSourceReady) {
                        processNextChunk();
                    }
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
                    if (mediaState.isReady && player) {
                        handleVideoControl(data);
                    }
                    break;
            }
        } catch (error) {
            console.error('Error processing data:', error);
            mediaState.hasError = true;
            notyf.error("Error processing video data");
        }
    });

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


// Helper function to handle video chunk data
function handleVideoChunk(data) {
    // Add the chunk to pending chunks
    const chunk = new Uint8Array(data.data);
    pendingChunks.push(chunk);
    receivedSize += chunk.byteLength;

    const percentage = ((receivedSize / expectedSize) * 100).toFixed(1);
    console.log(`Received chunk: ${receivedSize}/${expectedSize} bytes (${percentage}%)`);

    // Only process if media components are ready
    if (mediaState.isReady && sourceBuffer && mediaSource && 
        mediaSource.readyState === 'open' && !sourceBuffer.updating) {
        processNextChunk();
    }
}

// Helper function to handle video complete event
function handleVideoComplete(metadataInitialized, mediaSourceReady) {
    console.log('Video transfer complete. Checking state:', {
        metadataInitialized,
        mediaSourceReady,
        pendingChunks: pendingChunks.length,
        receivedSize,
        expectedSize
    });

    if (metadataInitialized && mediaSourceReady) {
        // Process any remaining chunks
        processNextChunk();
        
        // Set up a check for completion
        const checkComplete = setInterval(() => {
            if (pendingChunks.length === 0 && !sourceBuffer.updating) {
                clearInterval(checkComplete);
                console.log('All chunks processed, ending stream');
                
                try {
                    if (mediaSource && mediaSource.readyState === 'open') {
                        mediaSource.endOfStream();
                        notyf.success("Video fully loaded");
                    }
                } catch (e) {
                    console.error('Error ending stream:', e);
                }
            }
        }, 100);
    }
}

function initializePlayerEvents() {
    if (!player) return;

    player.on('timeupdate', checkBuffer);
    
    player.on('waiting', () => {
        console.log('Video waiting for data');
        if (pendingChunks.length > 0 && !sourceBuffer.updating) {
            processNextChunk();
        }
    });

    player.on('playing', () => {
        console.log('Video started playing');
        mediaState.isBuffering = false;
    });

    player.on('pause', () => {
        console.log('Video paused');
        mediaState.isBuffering = false;
    });

    player.on('error', (error) => {
        console.error('Player error:', error);
        mediaState.hasError = true;
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
                        sourceBuffer.mode = 'segments';
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
async function handleVideoMetadata(data, videoElement) {
    console.log('Processing metadata:', data);
    expectedSize = data.size;
    
    // Reset state for new video
    mediaState.isReady = false;
    mediaState.hasError = false;
    mediaState.isBuffering = false;
    pendingChunks = [];
    receivedSize = 0;
    
    try {
        // Initialize media source
        if (mediaSource) {
            if (mediaSource.readyState === 'open') {
                try {
                    mediaSource.endOfStream();
                } catch (e) {
                    console.warn('Error closing previous MediaSource:', e);
                }
            }
            if (mediaState.mediaSourceUrl) {
                URL.revokeObjectURL(mediaState.mediaSourceUrl);
            }
        }

        mediaSource = new MediaSource();
        mediaState.mediaSourceUrl = URL.createObjectURL(mediaSource);
        
        await new Promise((resolve, reject) => {
            const handleSourceOpen = () => {
                mediaSource.removeEventListener('sourceopen', handleSourceOpen);
                resolve();
            };
            mediaSource.addEventListener('sourceopen', handleSourceOpen);
            videoElement.src = mediaState.mediaSourceUrl;
        });

        console.log('MediaSource opened');

        // Set up source buffer
        let mimeType = data.mimeType === 'video/webm' ? 
            'video/webm;codecs="vp8,vorbis"' : data.mimeType;

        sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        sourceBuffer.mode = 'sequence';
        
        // Set up player source
        if (player) {
            player.src({
                src: mediaState.mediaSourceUrl,
                type: mimeType
            });
            player.load();
        }

        // Initialize buffer processing
        sourceBuffer.addEventListener('updateend', () => {
            if (pendingChunks.length > 0 && !sourceBuffer.updating) {
                processNextChunk();
            }
        });

        console.log('Media source initialization complete');
        return true;
    } catch (error) {
        console.error('Error setting up media source:', error);
        mediaState.hasError = true;
        return false;
    }
}


// Process next chunk in queue
// Improved chunk processing function with better buffer management
function processNextChunk() {
    if (!sourceBuffer || sourceBuffer.updating || pendingChunks.length === 0) {
        return;
    }

    try {
        const chunk = pendingChunks.shift();
        console.log('Processing chunk:', chunk.byteLength, 'bytes');
        sourceBuffer.appendBuffer(chunk);

        // Check buffer status
        if (sourceBuffer.buffered.length > 0) {
            const end = sourceBuffer.buffered.end(0);
            const start = sourceBuffer.buffered.start(0);
            console.log(`Buffer: ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
            
            // Enable play button if we have enough buffer
            if (end - start >= 0.5) {
                player.controlBar.playToggle.enable();
            }
        }
    } catch (e) {
        console.error('Error processing chunk:', e);
        if (e.name === 'QuotaExceededError') {
            // Handle quota exceeded by removing old data
            if (sourceBuffer.buffered.length > 0) {
                const start = sourceBuffer.buffered.start(0);
                const end = sourceBuffer.buffered.end(0);
                sourceBuffer.remove(start, end - 10);
                pendingChunks.unshift(chunk); // Put the chunk back
            }
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
                    sourceBuffer.mode = 'segments';
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

    player.on('timeupdate', () => {
        try {
            if (!mediaState.isReady || !sourceBuffer || !mediaSource || 
                mediaSource.readyState !== 'open' || !sourceBuffer.buffered) {
                return;
            }

            if (sourceBuffer.buffered.length > 0) {
                const currentTime = player.currentTime();
                const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
                const bufferAhead = bufferedEnd - currentTime;
                
                console.log(`Buffer ahead: ${bufferAhead.toFixed(2)}s`);
                
                if (bufferAhead < 3 && pendingChunks.length > 0) {
                    processNextChunk();
                }
            }
        } catch (e) {
            console.warn('Buffer monitoring error:', e);
        }
    });

    player.on('seeking', () => {
        try {
            if (mediaState.isReady && sourceBuffer && !sourceBuffer.updating && 
                pendingChunks.length > 0) {
                processNextChunk();
            }
        } catch (e) {
            console.warn('Seek error:', e);
        }
    });

    player.on('waiting', () => {
        console.log('Video waiting for data');
        try {
            if (mediaState.isReady && sourceBuffer && !sourceBuffer.updating && 
                pendingChunks.length > 0) {
                processNextChunk();
            }
        } catch (e) {
            console.warn('Waiting error:', e);
        }
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
    pendingChunks.push(chunk);
    receivedSize += chunk.byteLength;

    const percentage = ((receivedSize / expectedSize) * 100).toFixed(1);
    console.log(`Received chunk: ${receivedSize}/${expectedSize} bytes (${percentage}%)`);

    // Only process if we're ready and not already processing
    if (mediaState.isReady && sourceBuffer && 
        !sourceBuffer.updating && mediaSource.readyState === 'open') {
        processNextChunk().catch(console.error);
    } else {
        console.log('Queuing chunk for later processing. State:', {
            mediaReady: mediaState.isReady,
            hasSourceBuffer: !!sourceBuffer,
            isUpdating: sourceBuffer?.updating,
            mediaSourceState: mediaSource?.readyState
        });
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
// Add better buffer monitoring
function setupBufferMonitoring() {
    if (!player) return;

    player.on('timeupdate', () => {
        if (sourceBuffer && sourceBuffer.buffered.length > 0) {
            const currentTime = player.currentTime();
            const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
            const bufferAhead = bufferedEnd - currentTime;
            
            console.log(`Buffer ahead: ${bufferAhead.toFixed(2)}s`);
            
            // If buffer is running low, process more chunks
            if (bufferAhead < 3 && pendingChunks.length > 0) {
                processNextChunk();
            }
        }
    });

    // Add specific error handling
    player.on('error', (e) => {
        console.error('Player error:', e);
        // Try to recover by reprocessing chunks
        if (pendingChunks.length > 0) {
            processNextChunk();
        }
    });
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
