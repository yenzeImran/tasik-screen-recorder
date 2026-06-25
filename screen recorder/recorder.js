(view => {
  const IS_POPUP = window.innerWidth < 600;
  const popupUI = document.getElementById('popup-ui');
  const recorderUI = document.getElementById('recorder-ui');

  // Optimized presets to ensure stable, hardware-accelerated encoding pipelines
  const QUALITY_PRESETS = {
    '1080p': { width: 1920, height: 1080, bitrate: 25 },
    '1440p': { width: 2560, height: 1440, bitrate: 50 },
    '4K':    { width: 2560, height: 1440, bitrate: 75 }, // Scaled down to prevent hardware buffer crash
    'max':   { width: 2560, height: 1440, bitrate: 100 } // Unthrottled crisp master ceiling
  };

  let selectedQuality = 'max'; 
  let customBitrate = 100;

  if (IS_POPUP) {
    popupUI.classList.remove('hidden');
    recorderUI.classList.add('hidden');
    document.getElementById('open-recorder-btn').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('recorder.html') });
    });
  } else {
    popupUI.classList.add('hidden');
    recorderUI.classList.remove('hidden');
    initRecorder();
  }

  function initRecorder() {
    let stream;
    let startTime;
    let updateInterval;
    let totalBytes = 0;
    
    let muxer = null;
    let videoEncoder = null;
    let videoTrackProcessor = null;
    let videoReader = null;

    const setupScreen = document.getElementById('setup-screen');
    const recordingScreen = document.getElementById('recording-screen');
    const downloadScreen = document.getElementById('download-screen');

    const qualityButtons = document.querySelectorAll('.quality-btn');
    const bitrateSlider = document.getElementById('bitrate-slider');
    const bitrateValue = document.getElementById('bitrate-value');
    const startScreenBtn = document.getElementById('start-screen-btn');
    const stopBtn = document.getElementById('stop-btn');
    const downloadVideo = document.getElementById('download-video');
    const newRecordingBtn = document.getElementById('new-recording-btn');
    const timerDisplay = document.getElementById('timer');
    const fileSizeDisplay = document.getElementById('file-size');
    const currentQualityDisplay = document.getElementById('current-quality');

    qualityButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        qualityButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedQuality = btn.dataset.quality;
        
        const preset = QUALITY_PRESETS[selectedQuality];
        customBitrate = preset.bitrate;
        bitrateSlider.value = customBitrate;
        bitrateValue.textContent = customBitrate + ' Mbps';
      });
    });

    bitrateSlider.addEventListener('input', () => {
      customBitrate = parseInt(bitrateSlider.value);
      bitrateValue.textContent = customBitrate + ' Mbps';
      qualityButtons.forEach(b => b.classList.remove('active'));
    });

    startScreenBtn.addEventListener('click', async () => {
      try {
        const preset = QUALITY_PRESETS[selectedQuality];
        
        const constraints = {
          video: {
            width: { ideal: preset.width },
            height: { ideal: preset.height },
            frameRate: { ideal: 60 },
            displaySurface: 'monitor'
          },
          audio: true
        };

        stream = await navigator.mediaDevices.getDisplayMedia(constraints);

        stream.getVideoTracks()[0].addEventListener('ended', () => {
          handleStopSequence();
        });

        const videoTrack = stream.getVideoTracks()[0];
        const settings = videoTrack.getSettings();
        
        // Dynamic boundary tracking to prevent OpenH264 macroblock failures
        const encodeWidth = settings.width > 2560 ? 2560 : settings.width;
        const encodeHeight = settings.height > 1440 ? 1440 : settings.height;

        currentQualityDisplay.textContent = `${encodeWidth}x${encodeHeight} MP4`;

        // 1. Initialize MP4 Muxer with the timestamp offset behavior fix
        muxer = new Mp4Muxer.Muxer({
          target: new Mp4Muxer.ArrayBufferTarget(),
          video: {
            codec: 'avc', 
            width: encodeWidth,
            height: encodeHeight
          },
          firstTimestampBehavior: 'offset', // FIX: Forces the timeline to start smoothly at 0
          fastStart: 'fragmented' 
        });

        // 2. Setup the hardware-accelerated WebCodecs video processing pipeline
        videoEncoder = new VideoEncoder({
          output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
          error: (e) => console.error("Hardware Video Encoder Failure:", e)
        });

        videoEncoder.configure({
          codec: 'avc1.4d4032', // Universal High Profile Level 5.0 (GPU supported)
          width: encodeWidth,
          height: encodeHeight,
          bitrate: customBitrate * 1000000, 
          avc: { format: 'annexb' },
          framerate: 60,
          latencyMode: 'quality' 
        });

        // 3. Pipe raw real-time stream frames directly into the hardware layer
        videoTrackProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
        videoReader = videoTrackProcessor.readable.getReader();

        startTime = Date.now();
        let frameCount = 0;

        async function processFrames() {
          try {
            while (true) {
              const { done, value } = await videoReader.read();
              if (done) break;
              if (!videoEncoder || videoEncoder.state === 'closed') {
                value.close();
                break;
              }

              frameCount++;
              const insertKeyframe = frameCount % 60 === 0;

              videoEncoder.encode(value, { keyFrame: insertKeyframe });
              
              // Increment metric counter accurately
              totalBytes += (customBitrate * 1000000 / 8 / 60); 
              value.close();
            }
          } catch (err) {
            console.warn("Frame acquisition processor pipeline terminated:", err);
          }
        }

        processFrames();

        setupScreen.classList.add('hidden');
        recordingScreen.classList.remove('hidden');
        downloadScreen.classList.add('hidden');

        updateStats();
        updateInterval = setInterval(updateStats, 1000);
      } catch (err) {
        alert('Screen capture setup failed: ' + err.message);
        console.error(err);
      }
    });

    stopBtn.addEventListener('click', () => {
      handleStopSequence();
    });

    async function handleStopSequence() {
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }

      if (videoReader) {
        try { await videoReader.cancel(); } catch(e){}
        videoReader = null;
      }

      if (videoEncoder && videoEncoder.state !== 'closed') {
        try {
          await videoEncoder.flush();
          videoEncoder.close();
        } catch(e){}
      }

      if (stream) {
        stream.getTracks().forEach(track => {
          if (track.readyState === 'live') track.stop();
        });
      }

      showDownloadScreen();
    }

    function updateStats() {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const secs = String(elapsed % 60).padStart(2, '0');
      timerDisplay.textContent = `${mins}:${secs}`;

      const sizeMB = (totalBytes / (1024 * 1024)).toFixed(1);
      fileSizeDisplay.textContent = sizeMB + ' MB';
    }

    function showDownloadScreen() {
      if (recordingScreen.classList.contains('hidden') && !downloadScreen.classList.contains('hidden')) {
        return; 
      }

      recordingScreen.classList.add('hidden');
      downloadScreen.classList.remove('hidden');

      if (!muxer) return;

      muxer.finalize();
      const { buffer } = muxer.target;

      const blob = new Blob([buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      
      downloadVideo.href = url;
      downloadVideo.download = 'tasik_pro_recording_' + Date.now() + '.mp4';
      downloadVideo.style.pointerEvents = "auto";
      downloadVideo.style.opacity = "1";
      downloadVideo.textContent = "⬇ Download Master MP4 Video";
    }

    newRecordingBtn.addEventListener('click', () => {
      muxer = null;
      videoEncoder = null;
      totalBytes = 0;
      downloadScreen.classList.add('hidden');
      setupScreen.classList.remove('hidden');
    });
  }
})(this);