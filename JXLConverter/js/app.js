/**
 * JXL Converter Web App - Main Application Logic
 * Cross-platform compatible (PC, Android Chrome/Firefox, iOS Safari)
 */
document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const modeLossyBtn = document.getElementById('mode-lossy');
  const modeLosslessBtn = document.getElementById('mode-lossless');
  const qualitySliderGroup = document.getElementById('quality-slider-group');
  const losslessInfoGroup = document.getElementById('lossless-info-group');
  const resolutionSelect = document.getElementById('resolution-select');
  const qualitySlider = document.getElementById('quality-slider');
  const qualityValue = document.getElementById('quality-value');
  const queueSection = document.getElementById('queue-section');
  const queueList = document.getElementById('queue-list');
  const downloadAllBtn = document.getElementById('download-all-btn');
  const clearAllBtn = document.getElementById('clear-all-btn');
  const globalProgress = document.getElementById('global-progress');
  const globalProgressBar = document.getElementById('global-progress-bar');
  const globalProgressText = document.getElementById('global-progress-text');
  const installBanner = document.getElementById('install-banner');
  const installBtn = document.getElementById('install-btn');
  const closeInstallBanner = document.getElementById('close-install-banner');
  const offlineStatusBadge = document.getElementById('offline-status-badge');

  // State
  let currentMode = 'lossy'; // 'lossy' or 'lossless'
  let worker = null;
  let taskQueue = [];
  let completedTasks = [];
  let isProcessing = false;
  let taskIdCounter = 0;
  let deferredPrompt = null;

  // Mobile device detection
  const isMobileDevice = (typeof navigator !== 'undefined' && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '')) ||
                         (typeof window !== 'undefined' && window.innerWidth <= 1024 && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);

  function getEffectiveMaxDimension(selectedVal, retryStep = 0) {
    if (retryStep === 1) return 2560;
    if (retryStep === 2) return 1920;
    if (retryStep >= 3) return 1280;

    if (selectedVal === 'auto' || !selectedVal) {
      return isMobileDevice ? 2560 : 4096;
    }
    const val = parseInt(selectedVal, 10);
    return isNaN(val) ? (isMobileDevice ? 2560 : 4096) : val;
  }

  // 1. Initialize Worker (with self-healing and auto-restart)
  function initWorker() {
    if (worker) {
      try { worker.terminate(); } catch (e) {}
      worker = null;
    }
    if (window.Worker) {
      worker = new Worker('js/worker.js');
      worker.onmessage = handleWorkerMessage;
      worker.onerror = (err) => {
        console.error("Worker error:", err);
        handleWorkerCrash(err.message || "Worker crashed");
      };
    } else {
      alert("お使いのブラウザは Web Worker をサポートしていません。最新のブラウザをご使用ください。");
    }
  }

  function handleWorkerCrash(errorMsg) {
    console.warn("Recovering from Worker crash/error...", errorMsg);
    const currentTask = taskQueue.find(t => t.status === 'processing');
    if (currentTask) {
      handleTaskFailure(currentTask, errorMsg || 'Worker異常停止（メモリ上限）');
    } else {
      initWorker();
      isProcessing = false;
      updateGlobalProgress();
      processNextInQueue();
    }
  }

  function handleTaskFailure(task, errorMsg) {
    const errStr = String(errorMsg);
    const isWasmFatal = errStr.includes('unreachable') || errStr.includes('Aborted') || errStr.includes('memory') || errStr.includes('RuntimeError') || errStr.includes('Failed to load') || errStr.includes('null');

    if (isWasmFatal && (task.retryCount || 0) < 3) {
      task.retryCount = (task.retryCount || 0) + 1;
      const nextRes = getEffectiveMaxDimension(resolutionSelect ? resolutionSelect.value : 'auto', task.retryCount);
      console.warn(`[Auto-Recovery] Retrying task ${task.taskId} with safe resolution ${nextRes}px (Attempt ${task.retryCount})...`);
      task.status = 'pending';
      task.statusMessage = `端末メモリ保護のため ${nextRes}px で自動再試行中...`;
      task.percent = 10;
      updateQueueItemUI(task);
      initWorker(); // Restart with clean WASM state
      isProcessing = false;
      setTimeout(processNextInQueue, 150);
      return;
    }

    // If all retries failed or not fatal
    task.status = 'error';
    task.errorMessage = errorMsg;
    updateQueueItemUI(task);
    if (isWasmFatal) {
      initWorker();
    }
    isProcessing = false;
    updateGlobalProgress();
    processNextInQueue();
  }

  initWorker();

  // 2. Service Worker & PWA Registration
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then((reg) => {
          console.log("Service Worker registered successfully:", reg.scope);
        })
        .catch((err) => {
          console.warn("Service Worker registration failed:", err);
        });
    });
  }

  // PWA Install Prompt handling
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBanner) installBanner.classList.remove('hidden');
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice.outcome === 'accepted') {
          console.log('User accepted the PWA install');
        }
        deferredPrompt = null;
        if (installBanner) installBanner.classList.add('hidden');
      }
    });
  }

  if (closeInstallBanner) {
    closeInstallBanner.addEventListener('click', () => {
      if (installBanner) installBanner.classList.add('hidden');
    });
  }

  // Network offline status
  function updateOnlineStatus() {
    if (offlineStatusBadge) {
      if (navigator.onLine) {
        offlineStatusBadge.textContent = '🟢 オンライン';
        offlineStatusBadge.className = 'status-badge online';
      } else {
        offlineStatusBadge.textContent = '⚡ 完全ローカル (オフライン動作中)';
        offlineStatusBadge.className = 'status-badge offline';
      }
    }
  }
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();

  // 3. Mode Selection (Lossy vs Lossless) & Slider Handling
  const savedMode = localStorage.getItem('jxl_mode');
  if (savedMode === 'lossless' || savedMode === 'lossy') {
    currentMode = savedMode;
  }

  const savedQuality = localStorage.getItem('jxl_quality');
  if (savedQuality !== null) {
    qualitySlider.value = savedQuality;
  }

  const savedRes = localStorage.getItem('jxl_max_res');
  if (savedRes !== null && resolutionSelect) {
    resolutionSelect.value = savedRes;
  }
  if (resolutionSelect) {
    resolutionSelect.addEventListener('change', () => {
      localStorage.setItem('jxl_max_res', resolutionSelect.value);
    });
  }

  function setMode(mode) {
    currentMode = mode;
    localStorage.setItem('jxl_mode', mode);

    if (mode === 'lossless') {
      modeLosslessBtn.classList.add('active');
      modeLossyBtn.classList.remove('active');
      qualitySliderGroup.classList.add('hidden');
      losslessInfoGroup.classList.remove('hidden');
    } else {
      modeLossyBtn.classList.add('active');
      modeLosslessBtn.classList.remove('active');
      qualitySliderGroup.classList.remove('hidden');
      losslessInfoGroup.classList.add('hidden');
    }
  }

  modeLossyBtn.addEventListener('click', () => setMode('lossy'));
  modeLosslessBtn.addEventListener('click', () => setMode('lossless'));
  setMode(currentMode);

  function updateSliderDisplay() {
    const q = parseInt(qualitySlider.value, 10);
    qualityValue.textContent = `${q}%`;
    localStorage.setItem('jxl_quality', q);
  }
  qualitySlider.addEventListener('input', updateSliderDisplay);
  updateSliderDisplay();

  // 4. Drag & Drop & File Selection
  dropZone.addEventListener('click', () => fileInput.click());

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-active');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-active');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToQueue(Array.from(e.dataTransfer.files));
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      addFilesToQueue(Array.from(e.target.files));
      fileInput.value = ''; // Reset
    }
  });

  // 5. Queue Management
  function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  function addFilesToQueue(files) {
    // Robust file validation (compatible with mobile photo pickers)
    const validFiles = files.filter(file => {
      const name = (file.name || '').toLowerCase();
      const type = (file.type || '').toLowerCase();
      // Allow any image MIME type, or common image extensions, or files with non-zero size if type is generic
      return type.startsWith('image/') ||
        name.endsWith('.jpg') || name.endsWith('.jpeg') ||
        name.endsWith('.png') || name.endsWith('.gif') ||
        name.endsWith('.webp') || name.endsWith('.jxl') ||
        name.endsWith('.avif') || name.endsWith('.bmp') ||
        name.endsWith('.heic') || name.endsWith('.heif') ||
        (!type && file.size > 0);
    });

    if (validFiles.length === 0) {
      alert("変換対象の画像ファイル（JPEG, PNG, GIF, WebP等）を選択してください。");
      return;
    }

    queueSection.classList.remove('hidden');

    for (const file of validFiles) {
      const taskId = `task_${++taskIdCounter}`;
      let safeName = file.name || `image_${taskIdCounter}.jpg`;
      // Clean up Android content URI style names if needed
      if (!safeName.includes('.')) {
        safeName += '.jpg';
      }

      const item = {
        taskId: taskId,
        file: file,
        fileName: safeName,
        fileSize: file.size,
        type: file.type,
        status: 'pending',
        percent: 0,
        resultBlob: null,
        resultSize: 0,
        mode: currentMode,
        outFileName: safeName.replace(/\.[^.]+$/, '') + '.jxl',
        retryCount: 0
      };

      taskQueue.push(item);
      renderQueueItem(item);
    }

    processNextInQueue();
  }

  function renderQueueItem(item) {
    const li = document.createElement('li');
    li.id = item.taskId;
    li.className = 'queue-item';

    let formatBadge = 'IMAGE';
    const ext = item.fileName.split('.').pop().toUpperCase();
    if (['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'JXL'].includes(ext)) {
      formatBadge = ext;
    }

    // Thumbnail preview
    let previewUrl = '';
    try {
      previewUrl = URL.createObjectURL(item.file);
    } catch (e) {
      previewUrl = '';
    }

    li.innerHTML = `
      <div class="item-preview">
        ${previewUrl ? `<img src="${previewUrl}" alt="Preview" class="thumbnail" />` : `<span class="badge">IMG</span>`}
      </div>
      <div class="item-info">
        <div class="item-header">
          <span class="item-name" title="${item.fileName}">${item.fileName}</span>
          <span class="badge badge-format">${formatBadge}</span>
          <span class="badge badge-size">${formatBytes(item.fileSize)}</span>
        </div>
        <div class="item-progress-container">
          <div class="item-progress-bar" style="width: 0%"></div>
        </div>
        <div class="item-status">待機中...</div>
      </div>
      <div class="item-actions">
        <button class="btn btn-sm btn-download hidden" title="ダウンロード">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          保存
        </button>
      </div>
    `;

    queueList.appendChild(li);
  }

  function updateQueueItemUI(item) {
    const el = document.getElementById(item.taskId);
    if (!el) return;

    const progressBar = el.querySelector('.item-progress-bar');
    const statusText = el.querySelector('.item-status');
    const downloadBtn = el.querySelector('.btn-download');

    if (progressBar) progressBar.style.width = `${item.percent}%`;
    if (statusText) statusText.textContent = item.statusMessage || item.status;

    if (item.status === 'processing') {
      el.classList.add('processing');
      el.classList.remove('complete', 'error');
    } else if (item.status === 'complete') {
      el.classList.remove('processing');
      el.classList.add('complete');

      const savedDiff = item.resultSize - item.fileSize;
      const diffText = savedDiff <= 0
        ? ` (${((1 - item.resultSize / item.fileSize) * 100).toFixed(1)}% 削減)`
        : ` (+${((item.resultSize / item.fileSize - 1) * 100).toFixed(1)}%)`;

      const optBadge = (item.retryCount > 0)
        ? `<span class="badge badge-warning" title="端末メモリに合わせて解像度を自動最適化しました">⚡ 自動適応 (${item.width}x${item.height})</span>`
        : '';

      statusText.innerHTML = `
        <span class="text-success">✅ 完了</span>: <strong>${formatBytes(item.resultSize)}</strong> ${diffText}
        <span class="badge ${item.isLossless ? 'badge-lossless' : 'badge-format'}">${item.isLossless ? '💎 可逆(無劣化)' : '⚡ 非可逆'}</span>
        ${item.isAnimated ? '<span class="badge badge-anim">動的 (Animation)</span>' : ''}
        ${item.hasExif ? '<span class="badge badge-exif">Exif保持</span>' : ''}
        ${optBadge}
      `;

      if (downloadBtn) {
        downloadBtn.classList.remove('hidden');
        downloadBtn.onclick = () => downloadSingle(item);
      }
    } else if (item.status === 'error') {
      el.classList.remove('processing');
      el.classList.add('error');
      statusText.innerHTML = `<span class="text-danger">❌ エラー: ${item.errorMessage}</span>`;
    }
  }

  // 6. Process Queue with Hybrid Main-Thread Decoding (100% Mobile Compatible)
  async function processNextInQueue() {
    if (isProcessing) return;

    const nextItem = taskQueue.find(t => t.status === 'pending');
    if (!nextItem) {
      updateGlobalProgress();
      return;
    }

    isProcessing = true;
    nextItem.status = 'processing';
    const selectedRes = resolutionSelect ? resolutionSelect.value : 'auto';
    const maxDimension = getEffectiveMaxDimension(selectedRes, nextItem.retryCount || 0);

    nextItem.statusMessage = (nextItem.retryCount > 0)
      ? `画像最適化中 (長辺${maxDimension}px)...`
      : '画像解析・フレーム展開中...';
    nextItem.percent = 15;
    updateQueueItemUI(nextItem);
    updateGlobalProgress();

    const isLossless = (currentMode === 'lossless');
    const quality = isLossless ? 100 : parseInt(qualitySlider.value, 10);

    try {
      // 1. Read raw ArrayBuffer
      const rawArrayBuffer = await nextItem.file.arrayBuffer();

      // 2. Safely decode on main thread (guarantees Canvas / Image element support on Android Chrome & Firefox)
      let extractedData = null;
      let transferables = [rawArrayBuffer];

      if (typeof FrameExtractor !== 'undefined') {
        try {
          const decoded = await FrameExtractor.extractFrames(nextItem.file, (p) => {
            nextItem.percent = 15 + Math.round(p * 0.2);
            updateQueueItemUI(nextItem);
          }, { maxDimension: maxDimension });

          if (decoded && decoded.frames && decoded.frames.length > 0) {
            extractedData = {
              width: decoded.width,
              height: decoded.height,
              isAnimated: decoded.isAnimated,
              frames: []
            };

            for (const f of decoded.frames) {
              const buffer = f.imageData.data.buffer;
              extractedData.frames.push({
                width: f.imageData.width,
                height: f.imageData.height,
                rgbaBuffer: buffer,
                delayMs: f.delayMs
              });
              transferables.push(buffer);
            }
          }
        } catch (decodeErr) {
          console.warn("Main thread decoding fallback to worker:", decodeErr);
        }
      }

      nextItem.statusMessage = 'JXL エンコード準備中...';
      nextItem.percent = 35;
      updateQueueItemUI(nextItem);

      // 3. Send to Web Worker for CPU WASM Encoding
      worker.postMessage({
        taskId: nextItem.taskId,
        fileName: nextItem.fileName,
        fileSize: nextItem.fileSize,
        rawArrayBuffer: rawArrayBuffer,
        extractedData: extractedData,
        isLossless: isLossless,
        quality: quality,
        maxDimension: maxDimension
      }, transferables);

    } catch (err) {
      console.error("Queue process error:", err);
      handleTaskFailure(nextItem, err.message || String(err));
    }
  }

  function handleWorkerMessage(e) {
    const data = e.data;
    const task = taskQueue.find(t => t.taskId === data.taskId);
    if (!task) return;

    if (data.type === 'progress') {
      task.percent = data.percent;
      task.statusMessage = data.status;
      updateQueueItemUI(task);
      updateGlobalProgress();
    } else if (data.type === 'complete') {
      task.status = 'complete';
      task.percent = 100;
      task.resultBlob = new Blob([data.jxlBytes], { type: 'image/jxl' });
      task.resultSize = data.jxlSize;
      task.outFileName = data.fileName;
      task.isAnimated = data.isAnimated;
      task.hasExif = data.hasExif;
      task.isLossless = data.isLossless;
      task.width = data.width;
      task.height = data.height;
      completedTasks.push(task);

      updateQueueItemUI(task);
      isProcessing = false;
      updateGlobalProgress();
      processNextInQueue();
    } else if (data.type === 'error') {
      handleTaskFailure(task, data.error);
    }
  }

  function updateGlobalProgress() {
    const total = taskQueue.length;
    if (total === 0) {
      globalProgress.classList.add('hidden');
      downloadAllBtn.disabled = true;
      return;
    }

    globalProgress.classList.remove('hidden');
    const completed = taskQueue.filter(t => t.status === 'complete' || t.status === 'error').length;
    const percent = Math.round((completed / total) * 100);

    globalProgressBar.style.width = `${percent}%`;
    globalProgressText.textContent = `変換進捗: ${completed} / ${total} 件 (${percent}%)`;

    if (completedTasks.length > 0) {
      downloadAllBtn.disabled = false;
    }

    if (completed === total && total > 0) {
      globalProgressText.textContent = `🎉 すべての変換が完了しました (${completedTasks.length}件 成功)`;
    }
  }

  // 7. Downloads (Mobile friendly)
  function downloadSingle(item) {
    if (!item.resultBlob) return;
    const url = URL.createObjectURL(item.resultBlob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = item.outFileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 5000);
  }

  if (downloadAllBtn) {
    downloadAllBtn.addEventListener('click', async () => {
      if (completedTasks.length === 0) return;

      if (completedTasks.length === 1) {
        downloadSingle(completedTasks[0]);
        return;
      }

      downloadAllBtn.disabled = true;
      const originalText = downloadAllBtn.innerHTML;
      downloadAllBtn.innerHTML = '<span>ZIP圧縮中...</span>';

      try {
        if (typeof JSZip === 'undefined') {
          throw new Error("JSZip library not loaded");
        }

        const zip = new JSZip();
        for (const item of completedTasks) {
          zip.file(item.outFileName, item.resultBlob);
        }

        const zipBlob = await zip.generateAsync({
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 }
        });

        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.style.display = 'none';
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        a.href = url;
        a.download = `jxl_converted_${dateStr}.zip`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 5000);
      } catch (err) {
        console.error("ZIP creation failed:", err);
        alert("ZIPファイルの作成に失敗しました。個別ダウンロードをお試しください。");
      } finally {
        downloadAllBtn.disabled = false;
        downloadAllBtn.innerHTML = originalText;
      }
    });
  }

  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
      taskQueue = [];
      completedTasks = [];
      isProcessing = false;
      queueList.innerHTML = '';
      queueSection.classList.add('hidden');
      updateGlobalProgress();
    });
  }
});
