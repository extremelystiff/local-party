// At the top with your other variables
let peer = null;
let connections = {};
let streamBuffer = [];
const CHUNK_SIZE = 64 * 1024;

function initializePeer(isHost) {
    // Generate a random ID for the peer (this will be our "room code")
    const peerId = randomString(5, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
    peer = new Peer(peerId);
    
    peer.on('open', (id) => {
        console.log('My peer ID is:', id);
        if(isHost) {
            // For host: display the peer ID as the room code
            document.getElementById("roomCodeText").innerHTML = id;
        }
    });

    peer.on('connection', (conn) => {
        setupConnection(conn);
    });

    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        notyf.error("Connection error. Please try rejoining.");
    });
}

function setupConnection(conn) {
    connections[conn.peer] = conn;
    
    conn.on('data', (data) => {
        if(data.type === 'chat') {
            append({
                name: data.username,
                content: data.message,
                pfp: data.pfp
            });
        } else if(data.type === 'videoControl') {
            handleVideoControl(data);
        }
    });
    
    conn.on('open', () => {
        console.log('Connected to peer:', conn.peer);
        notyf.success("Connected successfully");
    });
    
    conn.on('close', () => {
        delete connections[conn.peer];
        console.log('Peer disconnected:', conn.peer);
    });
}

// Modify room creation click handler
if(e.target.id == "roomCreateButton") {
    const roomName = document.getElementById("roomname").value;
    const username = document.getElementById("create-username").value;
    
    if(!roomName || !username) {
        document.getElementById("createRoomText").innerHTML = "Please fill in all the fields";
        return;
    }

    localStorage.setItem("isHost", "true");
    localStorage.setItem("roomName", roomName);
    localStorage.setItem("username", username);
    
    // Initialize peer connection
    initializePeer(true);
    
    document.getElementById("roomNameText").innerHTML = roomName;
    createPage.style.display = "none";
    document.title = `Local Party | ${roomName}`;
    roomPage.style.display = "block";
    
    // Welcome messages
    appendData(roomName, peer.id);
}

// Modify room joining click handler
if(e.target.id == "roomJoinButton") {
    const roomCode = document.getElementById("roomCode").value;
    const username = document.getElementById("join-username").value;
    
    if(!roomCode || !username) {
        document.getElementById("joinRoomText").innerHTML = "Please fill in all the fields";
        return;
    }

    localStorage.setItem("isHost", "false");
    localStorage.setItem("username", username);
    
    // Initialize peer connection
    initializePeer(false);
    
    // Connect to host
    const conn = peer.connect(roomCode);
    setupConnection(conn);
    
    document.getElementById("roomCodeText").innerHTML = roomCode;
    joinPage.style.display = "none";
    document.title = `Local Party | Room`;
    roomPage.style.display = "block";
}

// Modify video controls to use PeerJS
videoPlayer.addEventListener('play', (e) => {
    if(allowEmit) {
        const controlData = {
            type: 'videoControl',
            action: 'play',
            time: videoPlayer.currentTime,
            username: localStorage.getItem("username")
        };
        
        // Send to all connected peers
        Object.values(connections).forEach(conn => {
            if(conn.open) {
                conn.send(controlData);
            }
        });
        
        let content = time("played", "You", videoPlayer.currentTime);
        append({
            name: "Local Party",
            content: content,
            pfp: "#f3dfbf"
        });
    }
    setTimeout(() => { allowEmit = true; }, 500);
});

videoPlayer.addEventListener('pause', (e) => {
    if(allowEmit) {
        const controlData = {
            type: 'videoControl',
            action: 'pause',
            time: videoPlayer.currentTime,
            username: localStorage.getItem("username")
        };
        
        Object.values(connections).forEach(conn => {
            if(conn.open) {
                conn.send(controlData);
            }
        });
        
        let content = time("paused", "You", videoPlayer.currentTime);
        append({
            name: "Local Party",
            content: content,
            pfp: "#f3dfbf"
        });
    }
    setTimeout(() => { allowEmit = true; }, 500);
});

function handleVideoControl(data) {
    if(data.action === 'play') {
        allowEmit = false;
        videoPlayer.currentTime = data.time;
        videoPlayer.play();
        let content = time("played", data.username, data.time);
        append({
            name: "Local Party",
            content: content,
            pfp: "#f3dfbf"
        });
    } else if(data.action === 'pause') {
        allowEmit = false;
        videoPlayer.currentTime = data.time;
        videoPlayer.pause();
        let content = time("paused", data.username, data.time);
        append({
            name: "Local Party",
            content: content,
            pfp: "#f3dfbf"
        });
    }
}

// Modify chat form submission
form.addEventListener('submit', (e) => {
    e.preventDefault();
    const messageInput = document.getElementById("messageInp").value;
    if(messageInput.trim().length > 0) {
        const chatData = {
            type: 'chat',
            username: localStorage.getItem("username"),
            message: messageInput,
            pfp: localStorage.getItem("pfpUrl")
        };
        
        // Send to all connected peers
        Object.values(connections).forEach(conn => {
            if(conn.open) {
                conn.send(chatData);
            }
        });
        
        // Add your own message to chat
        append({
            name: localStorage.getItem("username"),
            content: messageInput,
            pfp: localStorage.getItem("pfpUrl")
        });
        
        document.getElementById("messageInp").value = "";
        document.getElementById("messages-box").scrollTop = document.getElementById("messages-box").scrollHeight;
    }
});
