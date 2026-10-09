/**
 * P2P File Transfer Application
 * Uses WebRTC DataChannels for direct browser-to-browser transfer.
 * Signaling is manual (Copy/Paste) to avoid backend requirements.
 */

class P2PApp {
  constructor() {
    this.pc = null; // PeerConnection
    this.channel = null; // DataChannel
    this.files = [];
    this.currentFileIndex = 0;
    this.totalChunks = 0;
    this.chunksReceived = 0;
    this.chunksSent = 0;
    this.fileMetadata = {};
    this.speedMonitor = null;
    this.lastBytes = 0;
    this.lastTime = 0;

    // Configuration
    this.MaxFileSize = 2 * 1024 * 1024 * 1024; // 2GB default limit
    this.chunkSize = 16 * 1024; // 16KB chunks (good balance for memory vs overhead)

    this.init();
  }

  init() {
    // Check browser support
    if (!window.RTCPeerConnection) {
      alert(
        "WebRTC is not supported in this browser. Please use Chrome, Firefox, or Edge.",
      );
      return;
    }
  }

  setMode(mode) {
    document
      .querySelectorAll(".mode-btn")
      .forEach((b) => b.classList.remove("active"));
    document
      .querySelectorAll(".panel")
      .forEach((p) => p.classList.remove("active"));

    if (mode === "send") {
      document.querySelector(".mode-btn:nth-child(1)").classList.add("active");
      document.getElementById("send-panel").classList.add("active");
    } else {
      document.querySelector(".mode-btn:nth-child(2)").classList.add("active");
      document.getElementById("receive-panel").classList.add("active");
    }
  }

  // --- SENDER LOGIC ---

  handleFileSelect(input) {
    this.files = Array.from(input.files).filter(
      (f) => f.size <= this.MaxFileSize,
    );
    if (this.files.length === 0) return;

    const list = document.getElementById("selected-files");
    const summary = document.getElementById("file-summary");
    list.innerHTML = "";

    let totalSize = 0;

    this.files.forEach((f) => {
      totalSize += f.size;
      const li = document.createElement("li");
      li.className = "file-item";
      li.innerHTML = `
                <div class="file-info">
                    <span class="file-name">${this.sanitize(f.name)}</span>
                    <span class="file-size">${this.formatBytes(f.size)}</span>
                </div>
            `;
      list.appendChild(li);
    });

    summary.textContent = `Total: ${this.files.length} file(s), ${this.formatBytes(totalSize)}`;
    document.getElementById("generate-offer-btn").disabled = false;
  }

  async generateOffer() {
    try {
      this.setMode("send");
      document.getElementById("send-step-1").style.display = "none";
      document.getElementById("send-step-2").style.display = "block";

      // 1. Create PeerConnection
      this.pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      // 2. Create DataChannel
      this.channel = this.pc.createDataChannel("fileTransfer", {
        ordered: true, // Ensure files are received in order
      });
      this.setupChannelEvents();

      // 3. Create Offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // 4. Wait for ICE gathering to complete (to include STUN candidates in the code)
      await this.waitForIceGathering();

      // 5. Display Code
      document.getElementById("offer-code").value = JSON.stringify(
        this.pc.localDescription,
      );
    } catch (err) {
      console.error(err);
      alert("Error creating offer: " + err.message);
      this.resetUI();
    }
  }

  async processAnswer() {
    const answerText = document.getElementById("answer-input").value.trim();
    if (!answerText) return alert("Please paste the answer code.");

    try {
      const answer = JSON.parse(answerText);
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));

      // Start sending
      this.startSending();
    } catch (err) {
      alert("Invalid answer code: " + err.message);
    }
  }

  startSending() {
    document.getElementById("send-step-2").style.display = "none";
    document.getElementById("send-step-3").style.display = "block";

    this.currentFileIndex = 0;
    this.sendNextFile();
  }

  sendNextFile() {
    if (this.currentFileIndex >= this.files.length) {
      this.finishTransfer();
      return;
    }

    const file = this.files[this.currentFileIndex];
    this.totalChunks = Math.ceil(file.size / this.chunkSize);
    this.chunksSent = 0;

    // Send Metadata
    const metadata = {
      type: "metadata",
      name: file.name,
      size: file.size,
      mime: file.type,
      index: this.currentFileIndex,
    };
    this.channel.send(JSON.stringify(metadata));

    // Read and Send File in Chunks
    let start = 0;
    const reader = new FileReader();

    // Backpressure handling: only read next chunk when buffer is low
    const readNext = () => {
      if (start >= file.size) {
        reader.onload = null;
        this.currentFileIndex++;
        readNext();
        return;
      }

      const chunk = file.slice(start, start + this.chunkSize);
      reader.readAsArrayBuffer(chunk);
    };

    reader.onload = (e) => {
      if (this.channel.bufferedAmount > 1024 * 1024) {
        // If buffer > 1MB, wait
        setTimeout(readNext, 100);
        return;
      }

      this.channel.send(e.target.result);
      this.chunksSent++;
      start += this.chunkSize;

      this.updateProgress("send");
      readNext();
    };

    readNext();
  }

  // --- RECEIVER LOGIC ---

  async processOffer() {
    const offerText = document.getElementById("offer-input").value.trim();
    if (!offerText) return alert("Please paste the sender's code.");

    try {
      const offer = JSON.parse(offerText);

      this.pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      this.setupChannelEvents();

      // Attach incoming data channel
      this.pc.ondatachannel = (event) => {
        this.channel = event.channel;
        this.setupChannelEvents();
      };

      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      await this.waitForIceGathering();

      document.getElementById("receive-step-1").style.display = "none";
      document.getElementById("receive-step-2").style.display = "block";
      document.getElementById("answer-code").value = JSON.stringify(
        this.pc.localDescription,
      );
    } catch (err) {
      alert("Invalid offer code: " + err.message);
    }
  }

  receiveData(chunk) {
    // We handle parsing in onmessage below, this is just a placeholder if needed
  }

  // --- SHARED LOGIC ---

  setupChannelEvents() {
    if (!this.channel) return;

    this.channel.onopen = () => {
      console.log("Channel Open");
      if (document.getElementById("receive-step-2").style.display === "block") {
        document.getElementById("receive-step-2").style.display = "none";
        document.getElementById("receive-step-3").style.display = "block";
      }
    };

    this.channel.onmessage = async (event) => {
      const data = event.data;

      // If it's a string, it's metadata
      if (typeof data === "string") {
        const meta = JSON.parse(data);
        if (meta.type === "metadata") {
          this.fileMetadata = {
            name: meta.name,
            size: meta.size,
            data: [],
          };
          this.chunksReceived = 0;
          this.totalChunks = Math.ceil(meta.size / this.chunkSize);

          // Ask user to save
          this.showSavePrompt(meta.name, meta.size);
        }
        return;
      }

      // If it's an ArrayBuffer, it's file data
      if (data instanceof ArrayBuffer) {
        if (!this.fileMetadata) return;

        this.fileMetadata.data.push(data);
        this.chunksReceived++;
        this.updateProgress("receive");

        // Notify sender we got it (optional, but good for flow)
        // For now, we just keep going until we have all chunks
        if (this.chunksReceived === this.totalChunks) {
          this.finalizeFile();
        }
      }
    };

    this.channel.onerror = (err) => {
      console.error("Datachannel error:", err);
      alert("Transfer error occurred.");
    };

    this.channel.onclose = () => {
      console.log("Channel closed");
      this.resetUI();
    };
  }

  showSavePrompt(name, size) {
    // In a real app, you might show a list of files here.
    // For simplicity, we auto-accept.
    // Note: "Choose where to save" (File System Access API) is not supported in all browsers.
    // We use standard download for maximum compatibility.

    const list = document.getElementById("received-files");
    const li = document.createElement("li");
    li.className = "file-item";
    li.innerHTML = `
            <div class="file-info">
                <span class="file-name">${this.sanitize(name)}</span>
                <span class="file-size">Receiving...</span>
            </div>
        `;
    list.appendChild(li);
  }

  async finalizeFile() {
    const blob = new Blob(this.fileMetadata.data);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = this.fileMetadata.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Clean up metadata
    this.fileMetadata = null;
    this.fileMetadata.data = [];

    // Update UI to show complete
    const list = document.getElementById("received-files");
    const items = list.querySelectorAll("li");
    const lastItem = items[items.length - 1];
    lastItem.querySelector(".file-size").textContent = "Complete - Downloaded";
    lastItem.querySelector(".file-size").style.color = "var(--success)";
    lastItem.querySelector(".file-name").style.color = "var(--success)";
  }

  // --- UTILS & UI HELPERS ---

  async waitForIceGathering() {
    if (this.pc.iceGatheringState === "complete") return;
    return new Promise((resolve) => {
      const handler = () => {
        if (this.pc.iceGatheringState === "complete") {
          this.pc.removeEventListener("icegatheringstatechange", handler);
          resolve();
        }
      };
      this.pc.addEventListener("icegatheringstatechange", handler);
    });
  }

  updateProgress(mode) {
    if (mode === "send") {
      const percent = (this.chunksSent / this.totalChunks) * 100;
      document.getElementById("send-progress").style.width = `${percent}%`;
      document.getElementById("send-status-text").textContent =
        `Sending: ${this.files[this.currentFileIndex].name} (${Math.round(percent)}%)`;
      this.monitorSpeed();
    } else {
      const percent = (this.chunksReceived / this.totalChunks) * 100;
      // We update the received list item dynamically
      const list = document.getElementById("received-files");
      const items = list.querySelectorAll("li");
      const current = items[items.length - 1];
      if (current) {
        current.querySelector(".file-size").textContent =
          `Receiving... ${Math.round(percent)}%`;
      }
    }
  }

  monitorSpeed() {
    const now = performance.now();
    const bytes = this.chunksSent * this.chunkSize;
    const delta = now - this.lastTime;

    if (delta > 500) {
      // Update every 500ms
      const speed = (bytes - this.lastBytes) / (delta / 1000); // Bytes per sec
      document.getElementById("send-speed").textContent =
        this.formatBytes(speed) + "/s";
      this.lastBytes = bytes;
      this.lastTime = now;
    }
  }

  finishTransfer() {
    document.getElementById("send-status-text").textContent =
      "Transfer Complete!";
    document.getElementById("send-progress").style.width = "100%";
    document.getElementById("send-speed").textContent = "";
    document.getElementById("cancel-send-btn").style.display = "none";

    // Close channel after a delay
    setTimeout(() => {
      if (this.channel) this.channel.close();
    }, 1000);
  }

  cancelTransfer() {
    if (confirm("Are you sure you want to cancel the transfer?")) {
      if (this.channel) this.channel.close();
      if (this.pc) this.pc.close();
      this.resetUI();
    }
  }

  closeConnection() {
    if (this.channel) this.channel.close();
    if (this.pc) this.pc.close();
    this.resetUI();
  }

  resetUI() {
    // Reset Send
    document.getElementById("send-step-1").style.display = "block";
    document.getElementById("send-step-2").style.display = "none";
    document.getElementById("send-step-3").style.display = "none";
    document.getElementById("file-input").value = "";
    document.getElementById("selected-files").innerHTML = "";
    document.getElementById("file-summary").textContent = "";
    document.getElementById("generate-offer-btn").disabled = true;
    document.getElementById("cancel-send-btn").style.display = "inline-flex";

    // Reset Receive
    document.getElementById("receive-step-1").style.display = "block";
    document.getElementById("receive-step-2").style.display = "none";
    document.getElementById("receive-step-3").style.display = "none";
    document.getElementById("offer-input").value = "";
    document.getElementById("received-files").innerHTML = "";
  }

  copyToClipboard(elementId) {
    const el = document.getElementById(elementId);
    el.select();
    navigator.clipboard
      .writeText(el.value)
      .then(() => {
        alert("Code copied to clipboard!");
      })
      .catch((err) => {
        console.error("Failed to copy:", err);
        alert("Failed to copy. Please select and copy manually.");
      });
  }

  formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  sanitize(str) {
    // Basic sanitization to prevent path traversal
    return str.replace(/[\/\\]/g, "_");
  }
}

// Initialize App
const app = new P2PApp();
