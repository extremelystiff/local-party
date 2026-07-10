/**
 * Enhanced Local Party - P2P Video Sharing Application
 * A web app for sharing and synchronized video playback with friends using WebRTC/PeerJS
 */

// Configuration constants
const CONFIG = {
  CHUNK_SIZE: 1024 * 1024, // Default chunk size (1MB)
  MIN_CHUNK_SIZE: 256 * 1024, // Minimum chunk size for slow connections (256KB)
  MAX_CHUNK_SIZE: 2 * 1024 * 1024, // Maximum chunk size for fast connections (2MB)
  BUFFER_GOAL: 15, // Target seconds of video to buffer ahead
  MAX_RECONNECT_ATTEMPTS: 5, // Maximum reconnection attempts
  SYNC_THRESHOLD: 0.5, // Time difference threshold for video synchronization (seconds)
  PEER_CONFIG: { // ICE servers for better NAT traversal
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    }
  }
};


// Initialize Notyf for notifications
const notyf = new Notyf({ 
  duration: 2000, 
  position: { x: 'center', y: 'top' },
  types: [
    {
      type: 'warning',
      background: '#FFA500',
      duration: 3000
    },
    {
      type: 'info',
      background: '#3498db',
      duration: 2000
    }
  ]
});

/**

 * Video Compatibility Helper
 * Detects browser support for various video formats
 */
class VideoCompatibilityHelper {
  constructor() {
    this.testVideoElement = document.createElement('video');
    this.supportedFormats = this.detectSupportedFormats();
  }
  
  /**
   * Detect supported video formats in the current browser
   */
  detectSupportedFormats() {
    const formats = {
      mp4: {
        supported: this.testVideoElement.canPlayType('video/mp4') !== '',
        mimeType: 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"'
      },
      webm: {
        supported: this.testVideoElement.canPlayType('video/webm') !== '',
        mimeType: 'video/webm; codecs="vp8,vorbis"'
      },
      webmVP9: {
        supported: this.testVideoElement.canPlayType('video/webm; codecs="vp9"') !== '',
        mimeType: 'video/webm; codecs="vp9,opus"'
      },
      ogg: {
        supported: this.testVideoElement.canPlayType('video/ogg') !== '',
        mimeType: 'video/ogg; codecs="theora,vorbis"'
      },
      mov: {
        supported: this.testVideoElement.canPlayType('video/quicktime') !== '',
        mimeType: 'video/quicktime'
      },
      mkv: {
        supported: false, // Not natively supported in browsers
        mimeType: 'video/x-matroska'
      },
      avi: {
        supported: false, // Not natively supported in browsers
        mimeType: 'video/x-msvideo'
      }
    };
    
    console.log('Browser video format support:', formats);
    return formats;
  }
  
  /**
   * Check if a file format is compatible
   */
  checkFileCompatibility(file) {
    // Get file extension
    const extension = file.name.split('.').pop().toLowerCase();
    
    // Check if this format is supported
    if (this.supportedFormats[extension] && this.supportedFormats[extension].supported) {
      return {
        compatible: true,
        mimeType: this.supportedFormats[extension].mimeType
      };
    }
    
    // If extension not found in our list, try with the file's type
    const fileType = file.type.split('/')[1];
    if (this.supportedFormats[fileType] && this.supportedFormats[fileType].supported) {
      return {
        compatible: true,
        mimeType: this.supportedFormats[fileType].mimeType
      };
    }
    
    // If we get here, the format is not directly supported
    return {
      compatible: false,
      recommendedFormat: this.getRecommendedFormat()
    };
  }
  
  /**
   * Get the recommended format for this browser
   */
  getRecommendedFormat() {
    // Return the best supported format for this browser
    if (this.supportedFormats.webmVP9.supported) {
      return 'webm (VP9)';
    } else if (this.supportedFormats.webm.supported) {
      return 'webm (VP8)';
    } else if (this.supportedFormats.mp4.supported) {
      return 'mp4 (H.264)';
    } else {
      return 'mp4 or webm';
    }
  }
  
  /**
   * Show compatibility warning in UI
   */
  showCompatibilityWarning(fileInfo) {
    notyf.warning(`This video format (${fileInfo.format}) may not be compatible with all browsers. We recommend using ${fileInfo.recommendedFormat} for best compatibility.`);
    
    // Add a more detailed warning in the UI
    const warningDiv = document.createElement('div');
    warningDiv.className = 'alert alert-warning mt-3';
    warningDiv.innerHTML = `
      <strong>Compatibility Warning:</strong>
      <p>The video format you're sharing (${fileInfo.format}) may not play correctly in all browsers.</p>
      <p>For best compatibility, we recommend using ${fileInfo.recommendedFormat}.</p>
      <p>You can continue anyway, but some participants may have issues playing the video.</p>
    `;
    
    // Add to the UI near the video player
    const container = document.querySelector('.video-player-conatiner');
    if (container) {
      container.appendChild(warningDiv);
      
      // Remove after 10 seconds
      setTimeout(() => {
        warningDiv.remove();
      }, 10000);
    }
  }
}

/**
 * Media Manager class
 * Handles video streaming using chunks and MSE
 */

class MediaManager {
  constructor(app, videoFile = null) {
    this.app = app;
    this.videoFile = videoFile;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.pendingChunks = [];
    this.receivedChunks = [];
    this.receivedSize = 0;
    this.expectedSize = 0;
    this.videoType = '';
    this.isProcessing = false;
    this.dynamicChunkSize = CONFIG.CHUNK_SIZE;
    this.transferStartTime = 0;
    this.lastTransferTime = 0;
    this.transferSpeed = 0;
    this.bufferTimeout = null;
    
    // Create a video element for compatibility testing
    this.testVideoElement = document.createElement('video');
  }

  /**
   * Start streaming video to a peer
   */
  async startStreamingTo(conn) {
    try {
      if (!this.videoFile) {
        throw new Error('No video file available');
      }

      console.log('Starting video stream with file:', this.videoFile.name);

      // Start time for speed calculation
      this.transferStartTime = Date.now();
      
      // Get proper MIME type from file
      const mimeType = this.getVideoMimeType(this.videoFile);

      // Send metadata
      const metadata = {
        type: 'video-metadata',
        name: this.videoFile.name,
        size: this.videoFile.size,
        mimeType: mimeType,
        lastModified: this.videoFile.lastModified
      };
      
      console.log('Sending metadata:', metadata);
      conn.send(metadata);

      // Add delay to ensure metadata is processed
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Stream chunks
      let offset = 0;
      let chunksCount = 0;
      let chunkStartTime = Date.now();
      
      while (offset < this.videoFile.size) {
        // Calculate optimal chunk size based on network speed
        if (chunksCount > 0 && chunksCount % 5 === 0) {
          this.adjustChunkSize(offset, Date.now() - this.transferStartTime);
        }
        
        // Slice the file
        const chunkEnd = Math.min(offset + this.dynamicChunkSize, this.videoFile.size);
        const chunk = this.videoFile.slice(offset, chunkEnd);
        const buffer = await chunk.arrayBuffer();
        
        // Send the chunk
        conn.send({
          type: 'video-chunk',
          data: buffer,
          offset: offset,
          total: this.videoFile.size
        });
        
        // Update offset and transfer stats
        offset += buffer.byteLength;
        chunksCount++;
        
        // Update progress in chat
        if (chunksCount % 20 === 0 || offset >= this.videoFile.size) {
          const progress = Math.round((offset / this.videoFile.size) * 100);
          const duration = (Date.now() - this.transferStartTime) / 1000;
          const speed = (offset / duration / (1024 * 1024)).toFixed(2);
          
          console.log(`Transfer progress: ${progress}%, Speed: ${speed} MB/s`);
          if (chunksCount % 50 === 0) {
            this.app.addLocalMessage(`Sending video: ${progress}% complete (${speed} MB/s)`);
          }
        }
        
        // Small delay between chunks to prevent flooding
        const timeTaken = Date.now() - chunkStartTime;
        if (timeTaken < 20) { // Ensure at least 20ms between chunks
          await new Promise(resolve => setTimeout(resolve, 20 - timeTaken));
        }
        chunkStartTime = Date.now();
      }
      
      // Send completion message
      conn.send({ type: 'video-complete' });
      
      // Calculate final stats
      const totalDuration = (Date.now() - this.transferStartTime) / 1000;
      const avgSpeed = (this.videoFile.size / totalDuration / (1024 * 1024)).toFixed(2);
      
      console.log(`Video transfer complete. Average speed: ${avgSpeed} MB/s`);
      this.app.addLocalMessage(`Video sent successfully (${avgSpeed} MB/s)`);
      notyf.success("Video sent to peer");
      
    } catch (err) {
      console.error('Error streaming video:', err);
      notyf.error("Error streaming video: " + err.message);
    }
  }
  
  /**
   * Adjust chunk size based on network conditions
   */
  adjustChunkSize(bytesSent, transferTime) {
    // Calculate transfer speed in bytes per second
    this.transferSpeed = bytesSent / (transferTime / 1000);
    
    const speedMbps = this.transferSpeed / (1024 * 1024);
    console.log(`Current transfer speed: ${speedMbps.toFixed(2)} MB/s`);
    
    // Adjust chunk size based on speed
    if (speedMbps > 5) { // > 5 MB/s is fast
      this.dynamicChunkSize = CONFIG.MAX_CHUNK_SIZE;
    } else if (speedMbps > 1) { // 1-5 MB/s is moderate
      this.dynamicChunkSize = CONFIG.CHUNK_SIZE;
    } else { // < 1 MB/s is slow
      this.dynamicChunkSize = CONFIG.MIN_CHUNK_SIZE;
    }
    
    console.log(`Adjusted chunk size to ${(this.dynamicChunkSize / 1024).toFixed(0)} KB`);
  }
  
  /**
   * Handle incoming video metadata
   */
  handleVideoMetadata(data) {
    console.log('Processing video metadata:', data);
    this.expectedSize = data.size;
    this.videoType = data.mimeType;
    
    // Reset state
    this.pendingChunks = [];
    this.receivedChunks = [];
    this.receivedSize = 0;
    
    // Initialize MediaSource
    this.initializeMediaSource(data.mimeType);
    
    // Update UI
    this.app.addLocalMessage(`Receiving video: ${data.name} (${this.formatSize(data.size)})`);
  }
  
  /**
   * Initialize MediaSource for video playback
   */
  async initializeMediaSource(mimeType) {
    try {
      // Clean up existing MediaSource
      if (this.mediaSource) {
        if (this.mediaSource.readyState === 'open') {
          try {
            this.mediaSource.endOfStream();
          } catch (e) {
            console.warn('Error ending previous MediaSource:', e);
          }
        }
        
        if (this.mediaSource.url) {
          URL.revokeObjectURL(this.mediaSource.url);
        }
      }
      
      // Create new MediaSource
      this.mediaSource = new MediaSource();
      const mediaSourceUrl = URL.createObjectURL(this.mediaSource);
      
      // Set player source
      this.app.player.src({
        src: mediaSourceUrl,
        type: mimeType
      });
      
      // Wait for MediaSource to open
      await new Promise((resolve) => {
        this.mediaSource.addEventListener('sourceopen', resolve, { once: true });
      });
      
      console.log('MediaSource opened, creating SourceBuffer');
      
      // Create appropriate SourceBuffer
      try {
        // Format the MIME type properly
        const formattedMimeType = this.getFormattedMimeType(mimeType);
        console.log('Using MIME type:', formattedMimeType);
        
        this.sourceBuffer = this.mediaSource.addSourceBuffer(formattedMimeType);
        this.sourceBuffer.mode = 'segments'; // More flexible mode for streaming
        
        // Set up updateend event for processing pendingChunks
        this.sourceBuffer.addEventListener('updateend', () => {
          this.processNextChunk();
        });
        
        console.log('SourceBuffer created successfully');
        return true;
      } catch (e) {
        console.error('Error creating SourceBuffer:', e);
        notyf.error("Your browser doesn't support this video format");
        return false;
      }
    } catch (error) {
      console.error('MediaSource initialization error:', error);
      notyf.error("Error initializing video player");
      return false;
    }
  }
  
  /**
   * Get properly formatted MIME type
   */
  getFormattedMimeType(mimeType) {
    // If MIME type already has codecs, use it
    if (mimeType.includes('codecs=')) {
      return mimeType;
    }
    
    // Otherwise, add default codecs based on container
    if (mimeType.includes('mp4')) {
      return 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
    } else if (mimeType.includes('webm')) {
      return 'video/webm; codecs="vp8,vorbis"';
    } else if (mimeType.includes('ogg')) {
      return 'video/ogg; codecs="theora,vorbis"';
    } else {
      // Default to MP4 if we can't determine
      return 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
    }
  }
  
  /**
   * Handle incoming video chunk
   */
  handleVideoChunk(data) {
    const chunk = new Uint8Array(data.data);
    this.pendingChunks.push(chunk);
    this.receivedSize += chunk.byteLength;
    
    // Calculate progress
    const percentage = ((this.receivedSize / this.expectedSize) * 100).toFixed(1);
    
    // Process chunk if source buffer is ready and not updating
    if (this.sourceBuffer && !this.sourceBuffer.updating) {
      this.processNextChunk();
    }
    
    // Update UI periodically (not for every chunk)
    if (this.pendingChunks.length % 10 === 0 || this.receivedSize >= this.expectedSize) {
      // Calculate speed
      const now = Date.now();
      if (this.lastTransferTime !== 0) {
        const timeDiff = (now - this.lastTransferTime) / 1000; // seconds
        const bytesDiff = chunk.byteLength;
        this.transferSpeed = bytesDiff / timeDiff;
      }
      this.lastTransferTime = now;
      
      const speed = (this.transferSpeed / (1024 * 1024)).toFixed(2);
      
      // Log progress to console
      console.log(`Received: ${percentage}%, Speed: ${speed} MB/s, Buffer: ${this.pendingChunks.length} chunks`);
      
      // Update UI less frequently to avoid flooding
      if (this.pendingChunks.length % 50 === 0 || this.receivedSize >= this.expectedSize) {
        this.app.addLocalMessage(`Receiving video: ${percentage}% complete (${speed} MB/s)`);
      }
    }
    
    // Schedule periodic buffer processing
    this.scheduleBufferProcessing();
  }
  
  /**
   * Schedule buffer processing to ensure chunks are processed even when updateend doesn't fire
   */
  scheduleBufferProcessing() {
    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout);
    }
    
    this.bufferTimeout = setTimeout(() => {
      if (this.sourceBuffer && !this.sourceBuffer.updating && this.pendingChunks.length > 0) {
        this.processNextChunk();
      }
      
      // Continue scheduling if we have more chunks
      if (this.pendingChunks.length > 0) {
        this.scheduleBufferProcessing();
      }
    }, 100);
  }
  
  /**
   * Process next chunk in queue
   */
  async processNextChunk() {
    if (this.isProcessing || !this.sourceBuffer || this.sourceBuffer.updating || this.pendingChunks.length === 0) {
      return;
    }
    
    this.isProcessing = true;
    
    try {
      // Get next chunk
      const chunk = this.pendingChunks.shift();
      
      // Append to source buffer
      this.sourceBuffer.appendBuffer(chunk);
      
      // Log buffer status periodically
      if (this.pendingChunks.length % 20 === 0) {
        this.logBufferStatus();
      }
      
      // Check if we need to clean up old buffer
      const currentTime = this.app.player.currentTime();
      if (this.sourceBuffer.buffered.length > 0) {
        const bufferEnd = this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1);
        const bufferAhead = bufferEnd - currentTime;
        
        // If we have more than 30s buffered, clean up old data
        if (bufferAhead > 30 && currentTime > 10) {
          // This will be processed in the next updateend event
          this.clearOldBuffer(currentTime - 5);
        }
      }
    } catch (error) {
      if (error.name === 'QuotaExceededError') {
        // Handle quota exceeded - remove old buffer data
        console.warn('Buffer quota exceeded, clearing old data');
        await this.clearOldBuffer(this.app.player.currentTime() - 10);
        
        // Put the chunk back
        this.pendingChunks.unshift(chunk);
      } else {
        console.error('Error processing chunk:', error);
      }
    } finally {
      this.isProcessing = false;
      
      // Process more chunks if available and buffer is not updating
      if (this.pendingChunks.length > 0 && this.sourceBuffer && !this.sourceBuffer.updating) {
        setTimeout(() => this.processNextChunk(), 0);
      }
    }
  }
  
  /**
   * Clear old buffer data
   */
  async clearOldBuffer(beforeTime) {
    if (!this.sourceBuffer || this.sourceBuffer.updating || !this.sourceBuffer.buffered.length) {
      return;
    }
    
    const start = this.sourceBuffer.buffered.start(0);
    
    if (start < beforeTime) {
      return new Promise((resolve) => {
        const handleUpdateEnd = () => {
          this.sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
          resolve();
        };
        
        this.sourceBuffer.addEventListener('updateend', handleUpdateEnd);
        this.sourceBuffer.remove(start, beforeTime);
      });
    }
  }
  
  /**
   * Handle video complete event
   */
  handleVideoComplete() {
    console.log('Video transfer complete');
    
    // Check if we have all the data
    if (this.receivedSize < this.expectedSize) {
      console.warn(`Received only ${this.receivedSize}/${this.expectedSize} bytes`);
      this.app.addLocalMessage(`Video transfer incomplete. Received ${this.formatSize(this.receivedSize)}/${this.formatSize(this.expectedSize)}`);
      return;
    }
    
    // Process all pending chunks
    this.processPendingChunks();
    
    // Show completion message
    this.app.addLocalMessage('Video transfer complete. Ready to play!');
    
    // Enable play button if it's disabled
    if (this.app.player.controlBar && this.app.player.controlBar.playToggle) {
      this.app.player.controlBar.playToggle.enable();
    }
  }
  
  /**
   * Process all pending chunks
   */
  async processPendingChunks() {
    // Process chunks in batches to avoid UI freezing
    const processChunkBatch = async (startIndex, batchSize) => {
      const endIndex = Math.min(startIndex + batchSize, this.pendingChunks.length);
      
      for (let i = startIndex; i < endIndex; i++) {
        if (!this.sourceBuffer || this.sourceBuffer.updating) {
          await new Promise(resolve => {
            const handleUpdateEnd = () => {
              this.sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
              resolve();
            };
            this.sourceBuffer.addEventListener('updateend', handleUpdateEnd);
          });
        }
        
        try {
          this.sourceBuffer.appendBuffer(this.pendingChunks[i]);
          
          await new Promise(resolve => {
            const handleUpdateEnd = () => {
              this.sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
              resolve();
            };
            this.sourceBuffer.addEventListener('updateend', handleUpdateEnd);
          });
        } catch (error) {
          if (error.name === 'QuotaExceededError') {
            // Handle quota exceeded - remove old buffer data
            await this.clearOldBuffer(this.app.player.currentTime() - 10);
            i--; // Retry this chunk
          } else {
            console.error('Error processing chunk:', error);
          }
        }
      }
      
      // Process next batch if there are more chunks
      if (endIndex < this.pendingChunks.length) {
        setTimeout(() => processChunkBatch(endIndex, batchSize), 10);
      } else {
        // All chunks processed, end the stream
        this.pendingChunks = [];
        
        // Wait a bit before ending the stream to ensure all data is properly buffered
        setTimeout(() => {
          if (this.mediaSource && this.mediaSource.readyState === 'open') {
            try {
              this.mediaSource.endOfStream();
              console.log('MediaSource stream ended');
            } catch (e) {
              console.warn('Error ending MediaSource stream:', e);
            }
          }
        }, 2000);
      }
    };
    
    // Start processing in batches of 10
    processChunkBatch(0, 10);
  }
  
  /**
   * Handle video playback buffering
   */
  handleBuffering() {
    console.log('Handling video buffering');
    
    if (!this.sourceBuffer) return;
    
    // Log current buffer status
    this.logBufferStatus();
    
    // Try to process more chunks if available
    if (this.pendingChunks.length > 0 && !this.sourceBuffer.updating) {
      this.processNextChunk();
    }
  }
  
  /**
   * Handle video playback error
   */
  handlePlaybackError() {
    console.error('Video playback error');
    
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      // Try to recover by processing more chunks
      if (this.pendingChunks.length > 0) {
        this.processNextChunk();
      }
    } else {
      // Media source is closed or in error state, try to reinitialize
      notyf.error("Playback error. Trying to recover...");
      
      // Reinitialize with a delay
      setTimeout(() => {
        this.initializeMediaSource(this.videoType);
      }, 1000);
    }
  }
  
  /**
   * Log buffer status
   */
  logBufferStatus() {
    if (!this.sourceBuffer || !this.sourceBuffer.buffered.length) return;
    
    const currentTime = this.app.player.currentTime();
    console.log("Buffer Status:");
    
    // Log all buffer ranges
    for (let i = 0; i < this.sourceBuffer.buffered.length; i++) {
      const start = this.sourceBuffer.buffered.start(i);
      const end = this.sourceBuffer.buffered.end(i);
      console.log(`Range ${i}: ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
    }
    
    // Calculate buffer ahead
    let bufferAhead = 0;
    for (let i = 0; i < this.sourceBuffer.buffered.length; i++) {
      const start = this.sourceBuffer.buffered.start(i);
      const end = this.sourceBuffer.buffered.end(i);
      
      if (currentTime >= start && currentTime <= end) {
        bufferAhead = end - currentTime;
        break;
      }
    }
    
    console.log(`Current position: ${currentTime.toFixed(2)}s`);
    console.log(`Buffered ahead: ${bufferAhead.toFixed(2)}s`);
    console.log(`Pending chunks: ${this.pendingChunks.length}`);
    console.log(`Received: ${this.receivedSize}/${this.expectedSize} bytes (${((this.receivedSize/this.expectedSize)*100).toFixed(1)}%)`);
  }
  
  /**
   * Get MIME type for video file
   */
  getVideoMimeType(file) {
    // Start with the file's type
    let mimeType = file.type;
    
    // If file.type is empty or generic, try to detect from extension
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
        default:
          // Default to MP4 if we can't detect
          mimeType = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
      }
    }
    
    console.log('Detected MIME type:', mimeType, 'for file:', file.name);
    return mimeType;
  }
  
  /**
   * Format bytes to human-readable size
   */
  formatSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
  
  /**
   * Clean up and destroy the media manager
   */
  destroy() {
    // Clear any pending timeouts
    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout);
    }
    
    // Clean up MediaSource
    if (this.mediaSource) {
      if (this.mediaSource.readyState === 'open') {
        try {
          this.mediaSource.endOfStream();
        } catch (e) {
          console.warn('Error ending MediaSource:', e);
        }
      }
      
      if (this.mediaSource.url) {
        URL.revokeObjectURL(this.mediaSource.url);
      }
    }
    
    // Reset state
    this.pendingChunks = [];
    this.receivedChunks = [];
    this.sourceBuffer = null;
    this.mediaSource = null;
  }
}

/**
 * Connection Manager class
 * Handles P2P connections using PeerJS
 */

class ConnectionManager {
  constructor(app, asHost, hostId = null) {
    this.app = app;
    this.isHost = asHost;
    this.hostId = hostId;
    this.peer = null;
    this.connections = {};
    this.reconnectAttempts = {};
    this.maxReconnectAttempts = CONFIG.MAX_RECONNECT_ATTEMPTS;
    
    // Initialize peer connection
    this.initializePeer();
  }
  
  /**
   * Initialize PeerJS connection
   */
  initializePeer() {
    // Generate peer ID if we're the host
    const peerId = this.isHost ? this.generatePeerId() : undefined;
    
    // Create peer with configuration
    this.peer = new Peer(peerId, CONFIG.PEER_CONFIG);
    
    // Set up peer events
    this.setupPeerEvents();
  }
  
  /**
   * Set up PeerJS events
   */
  setupPeerEvents() {
    // Connection opened
    this.peer.on('open', (id) => {
      console.log('Connected to PeerJS with ID:', id);
      
      if (this.isHost) {
        this.hostId = id;
        this.app.ui.roomCodeText.innerHTML = id;
      } else if (this.hostId) {
        // If we're not the host, connect to the host
        this.connectToPeer(this.hostId);
      }
    });
    
    // Incoming connection
    this.peer.on('connection', (conn) => {
      console.log('Incoming connection from:', conn.peer);
      this.setupConnection(conn);
    });
    
    // Error event
    this.peer.on('error', (err) => {
      console.error('PeerJS error:', err);
      
      if (err.type === 'peer-unavailable') {
        notyf.error("The room you're trying to join doesn't exist");
      } else if (err.type === 'network' || err.type === 'disconnected') {
        notyf.error("Network error. Attempting to reconnect...");
        this.attemptReconnect();
      } else {
        notyf.error("Connection error occurred");
      }
    });
  }
  
  /**
   * Set up peer connection
   */
  setupConnection(conn) {
    this.connections[conn.peer] = conn;
    this.reconnectAttempts[conn.peer] = 0;
    
    // Connection opened
    conn.on('open', () => {
      console.log('Connection opened to peer:', conn.peer);
      
      // If we're not the host, request the video
      if (!this.isHost) {
        conn.send({ type: 'video-request' });
      }
      
      // Send user info
      conn.send({
        type: 'user-info',
        username: this.app.username,
        isHost: this.isHost
      });
      
      // Update participant count
      this.app.updateParticipantCount(Object.keys(this.connections).length + 1); // +1 for self
    });
    
    // Data received
    conn.on('data', (data) => {
      console.log('Received data type:', data.type);
      
      try {
        this.handleIncomingData(conn, data);
      } catch (error) {
        console.error('Error processing data:', error);
      }
    });
    
    // Connection closed
    conn.on('close', () => {
      this.handleConnectionClose(conn);
    });
    
    // Connection error
    conn.on('error', (err) => {
      this.handleConnectionError(conn, err);
    });
  }
  
  /**
   * Handle incoming data
   */
  handleIncomingData(conn, data) {
    switch (data.type) {
      case 'video-request':
        if (this.isHost && this.app.videoFile) {
          // If we're the host and have a video file, start streaming
          if (this.app.mediaManager) {
            this.app.mediaManager.startStreamingTo(conn);
          }
        }
        break;
        
      case 'video-metadata':
        // Initialize media manager for receiving video
        if (!this.isHost && !this.app.mediaManager) {
          this.app.mediaManager = new MediaManager(this.app);
        }
        
        if (this.app.mediaManager) {
          this.app.mediaManager.handleVideoMetadata(data);
        }
        break;
        
      case 'video-chunk':
        if (this.app.mediaManager) {
          this.app.mediaManager.handleVideoChunk(data);
        }
        break;
        
      case 'video-complete':
        if (this.app.mediaManager) {
          this.app.mediaManager.handleVideoComplete();
        }
        break;
        
      case 'chat':
        this.app.addChatMessage(data.username, data.message);
        break;
        
      case 'control':
        this.app.handleVideoControl(data);
        break;
        
      case 'user-info':
        // Handle user info (username, etc.)
        this.app.addLocalMessage(`${data.username} joined the room`);
        break;
    }
  }
  
  /**
   * Handle connection close
   */
  handleConnectionClose(conn) {
    console.log('Connection closed:', conn.peer);
    
    // Remove from connections
    delete this.connections[conn.peer];
    
    // Update UI
    this.app.addLocalMessage("A user has disconnected.");
    this.app.updateParticipantCount(Object.keys(this.connections).length + 1); // +1 for self
  }
  
  /**
   * Handle connection error
   */
  handleConnectionError(conn, err) {
    console.error('Connection error:', err);
    
    // Remove from connections
    delete this.connections[conn.peer];
    
    // Try to reconnect if we're not at the limit
    if (this.reconnectAttempts[conn.peer] < this.maxReconnectAttempts) {
      this.reconnectAttempts[conn.peer]++;
      
      setTimeout(() => {
        this.connectToPeer(conn.peer);
      }, 2000 * this.reconnectAttempts[conn.peer]); // Exponential backoff
    } else {
      notyf.error("Connection lost and could not be re-established");
    }
    
    // Update UI
    this.app.updateParticipantCount(Object.keys(this.connections).length + 1); // +1 for self
  }
  
  /**
   * Connect to a peer
   */
  connectToPeer(peerId) {
    if (this.connections[peerId]) {
      console.log('Already connected to', peerId);
      return;
    }
    
    console.log('Connecting to peer:', peerId);
    
    const conn = this.peer.connect(peerId, {
      reliable: true,
      serialization: 'binary'
    });
    
    this.setupConnection(conn);
    return conn;
  }
  
  /**
   * Attempt to reconnect after error
   */
  attemptReconnect() {
    setTimeout(() => {
      if (this.peer && !this.peer.destroyed) {
        this.peer.reconnect();
      } else {
        // If peer is destroyed, create a new one
        this.initializePeer();
      }
    }, 3000);
  }
  
  /**
   * Broadcast message to all connected peers
   */
  broadcastMessage(message) {
    Object.values(this.connections).forEach(conn => {
      if (conn.open) {
        conn.send(message);
      }
    });
  }
  
  /**
   * Generate random peer ID
   */
  generatePeerId(length = 6) {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  }
  
  /**
   * Get host ID
   */
  getHostId() {
    return this.hostId;
  }
  
  /**
   * Clean up and destroy the PeerJS connection
   */
  destroy() {
    // Close all connections
    Object.values(this.connections).forEach(conn => {
      if (conn.open) {
        conn.close();
      }
    });
    
    // Destroy the peer object
    if (this.peer && !this.peer.destroyed) {
      this.peer.destroy();
    }
    
    // Reset state
    this.connections = {};
    this.reconnectAttempts = {};
  }
}

/**
 * Main application class
 */

class LocalParty {
  constructor() {
    // App state
    this.isHost = false;
    this.connectionManager = null;
    this.mediaManager = null;
    this.videoFile = null;
    this.roomName = '';
    this.username = '';
    this.compatibilityHelper = null;
    this.allowEmit = true;
    
    // UI elements
    this.ui = {
      pages: {
        landing: document.getElementById("landing"),
        create: document.getElementById("create"),
        join: document.getElementById("join"),
        room: document.getElementById("room")
      },
      videoPlayer: document.getElementById("video-player"),
      messagesBox: document.getElementById("messages-box"),
      roomNameText: document.getElementById("roomNameText"),
      roomCodeText: document.getElementById("roomCodeText"),
      peopleInParty: document.getElementById("pplinparty")
    };
    
    // Initialize the app
    this.init();
  }
  
  /**
   * Initialize the application
   */
  init() {
    console.log('Initializing Local Party application...');
    
    try {
      // Initialize format compatibility helper
      this.compatibilityHelper = new VideoCompatibilityHelper();
      
      // Set up video.js player
      this.initializeVideoPlayer();
      
      // Set up event listeners
      this.setupEventListeners();
      
      // Show landing page
      if (this.ui.pages.landing) {
        this.ui.pages.landing.style.display = "block";
        console.log('Landing page displayed');
      }
    } catch (error) {
      console.error('Initialization error:', error);
      notyf.error("Failed to initialize application");
    }
  }
  
  /**
   * Initialize the video.js player
   */
  initializeVideoPlayer() {
    try {
      // Configure global Video.js options
      videojs.options.techOrder = ['html5'];
      videojs.options.html5 = {
        nativeVideoTracks: false,
        nativeAudioTracks: false,
        nativeTextTracks: false,
        hls: { overrideNative: true }
      };
      
      // Initialize player if it doesn't exist
      if (!this.player) {
        this.player = videojs('video-player', {
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
        
        console.log('Video.js player initialized');
        
        // Add player event listeners
        this.initializePlayerEvents();
        
        // Initially disable play button until we have data
        if (this.player.controlBar && this.player.controlBar.playToggle) {
          this.player.controlBar.playToggle.disable();
        }
      }
    } catch (error) {
      console.error('Video player initialization error:', error);
    }
  }
  
  /**
   * Set up event listeners for player
   */
  initializePlayerEvents() {
    // Wait until the player is ready
    this.player.ready(() => {
      // Play event
      this.player.on('play', () => {
        if (!this.allowEmit) return;
        
        this.allowEmit = false;
        const currentTime = this.player.currentTime();
        
        console.log('Play event at time:', currentTime);
        
        // Broadcast play event to all peers
        this.broadcastVideoControl('play', currentTime);
        
        // Add a message in the chat
        this.addLocalMessage(`You played the video at ${this.formatTime(currentTime)}`);
        
        // Re-enable control emission after a delay
        setTimeout(() => { this.allowEmit = true; }, 500);
      });
      
      // Pause event
      this.player.on('pause', () => {
        if (!this.allowEmit) return;
        
        this.allowEmit = false;
        const currentTime = this.player.currentTime();
        
        console.log('Pause event at time:', currentTime);
        
        // Broadcast pause event to all peers
        this.broadcastVideoControl('pause', currentTime);
        
        // Add a message in the chat
        this.addLocalMessage(`You paused the video at ${this.formatTime(currentTime)}`);
        
        // Re-enable control emission after a delay
        setTimeout(() => { this.allowEmit = true; }, 500);
      });
      
      // Seeking event
      this.player.on('seeking', () => {
        if (!this.allowEmit) return;
        
        this.allowEmit = false;
        const currentTime = this.player.currentTime();
        
        console.log('Seeking event to time:', currentTime);
        
        // Broadcast seek event to all peers
        this.broadcastVideoControl('seek', currentTime);
        
        // Add a message in the chat
        this.addLocalMessage(`You jumped to ${this.formatTime(currentTime)}`);
        
        // Re-enable control emission after a delay
        setTimeout(() => { this.allowEmit = true; }, 1000);
      });
      
      // Waiting event (buffering)
      this.player.on('waiting', () => {
        console.log('Video waiting for data');
        
        // If using a MediaSource and we have a mediaManager
        if (this.mediaManager) {
          this.mediaManager.handleBuffering();
        }
      });
      
      // Can play event
      this.player.on('canplay', () => {
        console.log('Video can play - enabling play button');
        if (this.player.controlBar && this.player.controlBar.playToggle) {
          this.player.controlBar.playToggle.enable();
        }
      });
      
      // Error event
      this.player.on('error', (error) => {
        console.error('Player error:', error);
        if (this.mediaManager) {
          this.mediaManager.handlePlaybackError();
        }
      });
    });
  }
  
  /**
   * Set up event listeners for UI elements
   */
  setupEventListeners() {
    // Navigation buttons
    document.addEventListener("click", (e) => {
      switch (e.target.id) {
        case "createRoomButton":
          this.ui.pages.landing.style.display = "none";
          this.ui.pages.create.style.display = "block";
          break;
          
        case "joinRoomButton":
          this.ui.pages.landing.style.display = "none";
          this.ui.pages.join.style.display = "block";
          const fileInput = document.getElementById("file-id");
          if (fileInput) fileInput.style.display = "none";
          break;
          
        case "roomCreateButton":
          this.handleRoomCreate();
          break;
          
        case "roomJoinButton":
          this.handleRoomJoin();
          break;
          
        case "roomLeaveButton":
          this.leaveRoom();
          break;
          
        case "backButton":
          this.ui.pages.join.style.display = "none";
          this.ui.pages.create.style.display = "none";
          this.ui.pages.landing.style.display = "block";
          break;
      }
    });
    
    // File input change
    const fileInput = document.getElementById("file-id");
    if (fileInput) {
      fileInput.addEventListener("change", () => this.handleFileSelection());
    }
    
    // Set up chat form handling
    const form = document.getElementById("send-form");
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.sendChatMessage();
      });
    }
    
    // Make room code clickable for copying
    if (this.ui.roomCodeText) {
      this.ui.roomCodeText.addEventListener('click', () => {
        const text = this.ui.roomCodeText.innerHTML;
        navigator.clipboard.writeText(text)
          .then(() => {
            notyf.success("Room code copied to clipboard");
          })
          .catch(err => {
            console.error('Failed to copy room code:', err);
            notyf.error("Failed to copy room code");
          });
      });
    }
  }

  /**
   * Handle room creation
   */
  handleRoomCreate() {
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
    
    // Store user data
    this.roomName = roomName;
    this.username = username;
    localStorage.setItem("username", username);
    localStorage.setItem("roomName", roomName);
    
    // Check video compatibility
    this.videoFile = fileInput.files[0];
    const compatibilityResult = this.compatibilityHelper.checkFileCompatibility(this.videoFile);
    
    if (!compatibilityResult.compatible) {
      // Show warning but allow to continue
      this.compatibilityHelper.showCompatibilityWarning({
        format: this.videoFile.name.split('.').pop().toLowerCase(),
        recommendedFormat: compatibilityResult.recommendedFormat
      });
    }
    
    // Initialize connection as host
    this.isHost = true;
    this.initializeConnection(true);
    
    // Update UI
    this.ui.roomNameText.innerHTML = roomName;
    document.getElementById("createRoomText").innerHTML = "";
    this.ui.pages.create.style.display = "none";
    document.title = `Local Party | ${roomName}`;
    this.ui.pages.room.style.display = "block";
    
    // Set up host video
    this.setupHostVideo();
    
    // Add initial messages
    this.appendRoomInfo(roomName, this.connectionManager.getHostId());
  }
  
  /**
   * Handle room joining
   */
  handleRoomJoin() {
    const hostPeerId = document.getElementById("roomCode").value;
    const username = document.getElementById("join-username").value;
    
    if (!hostPeerId || !username) {
      document.getElementById("joinRoomText").innerHTML = "Please fill in all fields";
      return;
    }
    
    // Store user data
    this.username = username;
    localStorage.setItem("username", username);
    
    // Initialize connection as guest
    this.isHost = false;
    this.initializeConnection(false, hostPeerId);
    
    // Clear any existing video
    if (this.player) {
      this.player.reset();
    }
    this.videoFile = null;
    
    // Update UI
    this.ui.roomCodeText.innerHTML = hostPeerId;
    this.ui.pages.join.style.display = "none";
    document.title = "Local Party | Room";
    this.ui.pages.room.style.display = "block";
    
    // Add initial messages
    this.appendRoomInfo("Room", hostPeerId);
    this.addLocalMessage("Connecting to host...");
  }
  
  /**
   * Initialize P2P connection
   */
  initializeConnection(asHost, hostPeerId = null) {
    // Initialize connection manager
    this.connectionManager = new ConnectionManager(this, asHost, hostPeerId);
    
    // Initialize media manager if we're the host
    if (asHost && this.videoFile) {
      this.mediaManager = new MediaManager(this, this.videoFile);
    }
  }
  
  /**
   * Set up video for host
   */
  setupHostVideo() {
    if (!this.videoFile) return;
    
    // Create object URL for video
    const url = URL.createObjectURL(this.videoFile);
    
    // Set player source
    this.player.src({
      src: url,
      type: this.videoFile.type || 'video/mp4'
    });
    
    // Add message
    this.addLocalMessage(`Video loaded: ${this.videoFile.name}`);
    
    // Enable play button
    if (this.player.controlBar && this.player.controlBar.playToggle) {
      this.player.controlBar.playToggle.enable();
    }
  }
  
  /**
   * Handle file selection
   */
  handleFileSelection() {
    const fileInput = document.getElementById("file-id");
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return;
    
    this.videoFile = fileInput.files[0];
    console.log("Video file selected:", this.videoFile.name);
    
    // Check compatibility
    const compatibilityResult = this.compatibilityHelper.checkFileCompatibility(this.videoFile);
    
    if (!compatibilityResult.compatible) {
      this.compatibilityHelper.showCompatibilityWarning({
        format: this.videoFile.name.split('.').pop().toLowerCase(),
        recommendedFormat: compatibilityResult.recommendedFormat
      });
    }
  }
  
  /**
   * Send chat message
   */
  sendChatMessage() {
    const messageInput = document.getElementById("messageInp");
    const message = messageInput.value.trim();
    
    if (message) {
      // Create chat data
      const chatData = {
        type: 'chat',
        username: this.username,
        message: message,
        timestamp: Date.now()
      };
      
      // Send to all peers
      this.connectionManager.broadcastMessage(chatData);
      
      // Add to local chat
      this.addChatMessage(this.username, message, true);
      
      // Clear input field
      messageInput.value = "";
    }
  }
  
  /**
   * Add a chat message to the UI
   */
  addChatMessage(username, message, isSelf = false) {
    const color = isSelf ? "#e0f7fa" : "#f3dfbf";
    
    this.ui.messagesBox.innerHTML += `
      <div class="col-12 mt-3" id="message">
        <span class="username" style="color: ${color}">${username}: </span>
        ${this.escapeHtml(message)}
      </div>
    `;
    
    // Scroll to bottom
    this.ui.messagesBox.scrollTop = this.ui.messagesBox.scrollHeight;
  }
  
  /**
   * Add a local system message
   */
  addLocalMessage(content) {
    this.ui.messagesBox.innerHTML += `
      <div class="col-12 mt-3" id="message">
        <span class="username" style="color: #3498db">Local Party: </span>
        ${content}
      </div>
    `;
    
    // Scroll to bottom
    this.ui.messagesBox.scrollTop = this.ui.messagesBox.scrollHeight;
  }
  
  /**
   * Append room information to chat
   */
  appendRoomInfo(roomName, roomCode) {
    this.addLocalMessage("Local Party allows you to watch local videos with your friends synchronously while chatting.");
    this.addLocalMessage(`Welcome to ${roomName}`);
    this.addLocalMessage(`Share the room code (${roomCode}) with others to invite them to the party.`);
    this.addLocalMessage("The video will be automatically shared with others who join.");
  }
  
  /**
   * Broadcast video control event to all peers
   */
  broadcastVideoControl(action, time) {
    // Create control data
    const controlData = {
      type: 'control',
      action: action,
      time: time,
      username: this.username
    };
    
    // Send to all peers
    this.connectionManager.broadcastMessage(controlData);
  }
  
  /**
   * Handle incoming video control
   */
  handleVideoControl(data) {
    if (!this.allowEmit || !this.player) return;
    
    this.allowEmit = false;  // Prevent echo
    
    try {
      // Always sync time first if difference is significant
      if (Math.abs(this.player.currentTime() - data.time) > CONFIG.SYNC_THRESHOLD) {
        console.log(`Syncing time from ${this.player.currentTime()} to ${data.time}`);
        this.player.currentTime(data.time);
      }
      
      // Then handle play/pause action
      if (data.action === 'play' && this.player.paused()) {
        console.log('Remote play command received');
        this.player.play().catch(e => console.error('Play failed:', e));
        this.addLocalMessage(`${data.username} played the video at ${this.formatTime(data.time)}`);
      } else if (data.action === 'pause' && !this.player.paused()) {
        console.log('Remote pause command received');
        this.player.pause();
        this.addLocalMessage(`${data.username} paused the video at ${this.formatTime(data.time)}`);
      } else if (data.action === 'seek') {
        console.log(`Remote seek command received to ${data.time}`);
        this.player.currentTime(data.time);
        this.addLocalMessage(`${data.username} jumped to ${this.formatTime(data.time)}`);
      }
    } catch (e) {
      console.error('Error handling video control:', e);
    }
    
    // Re-enable control emission after a delay
    setTimeout(() => { this.allowEmit = true; }, 500);
  }
  
  /**
   * Format time for messages (MM:SS or HH:MM:SS)
   */
  formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    const paddedMinutes = minutes < 10 ? "0" + minutes : minutes;
    const paddedSeconds = secs < 10 ? "0" + secs : secs;
    
    if (hours > 0) {
      const paddedHours = hours < 10 ? "0" + hours : hours;
      return `${paddedHours}:${paddedMinutes}:${paddedSeconds}`;
    } else {
      return `${paddedMinutes}:${paddedSeconds}`;
    }
  }
  
  /**
   * Leave the current room
   */
  leaveRoom() {
    // Clean up connections
    if (this.connectionManager) {
      this.connectionManager.destroy();
    }
    
    // Clean up media manager
    if (this.mediaManager) {
      this.mediaManager.destroy();
    }
    
    // Clean up player
    if (this.player) {
      this.player.dispose();
      this.player = null;
    }
    
    // Reset state
    this.videoFile = null;
    
    // Reload page to reset everything
    location.reload();
  }
  
  /**
   * Escape HTML to prevent XSS in chat
   */
  escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }
  
  /**
   * Update participant count in UI
   */
  updateParticipantCount(count) {
    if (this.ui.peopleInParty) {
      this.ui.peopleInParty.innerHTML = `<i class="fas fa-user-friends"></i> ${count}`;
    }
  }
}

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.localParty = new LocalParty();
});
