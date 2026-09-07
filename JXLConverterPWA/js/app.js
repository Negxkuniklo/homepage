/**
 * JXL Converter Web App - Main Application Logic
 */
document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const qualitySlider = document.getElementById('quality-slider');
  const qualityValue = document.getElementById('quality-value');
  const losslessBadge = document.getElementById('lossless-badge');
  const updateExifCheckbox = document.getElementById('update-exif-checkbox');
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
  let worker = null;
  let taskQueue = [];
  let completedTasks = [];
  let isProcessing = false;
  let taskIdCounter = 0;
  let deferredPrompt = null;

  // 1. Initialize Worker
  function initWorker() {
    if (window.Worker) {
      worker = new Worker('js/worker.js');
      worker.onmessage = handleWorkerMessage;
      worker.onerror = (err) => {
        console.error("Worker error:", err);
      };
    } else {
      alert("お使いのブラウザは Web Worker をサポートしていません。最新のブラウザをご使用ください。");
    }
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

  // 3. Settings & Slider Handling
  const savedQuality = localStorage.getItem('jxl_quality');
  if (savedQuality !== null) {
    qualitySlider.value = savedQuality;
  }
  const savedExif = localStorage.getItem('jxl_update_exif');
  if (savedExif !== null && updateExifCheckbox) {
    updateExifCheckbox.checked = savedExif === 'true';
  }

  function updateSliderDisplay() {
    const q = parseInt(qualitySlider.value, 10);
    qualityValue.textContent = `${q}%`;
    if (q >= 100) {
      losslessBadge.classList.remove('hidden');
    } else {
      losslessBadge.classList.add('hidden');
    }
    localStorage.setItem('jxl_quality', q);
  }
  qualitySlider.addEventListener('input', updateSliderDisplay);
  updateSliderDisplay();

  if (updateExifCheckbox) {
    updateExifCheckbox.addEventListener('change', () => {
      localStorage.setItem('jxl_update_exif', updateExifCheckbox.checked);
    });
  }

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
    const validFiles = files.filter(file => {
      const name = file.name.toLowerCase();
      return file.type.startsWith('image/') ||
        name.endsWith('.jpg') || name.endsWith('.jpeg') ||
        name.endsWith('.png') || name.endsWith('.gif') ||
        name.endsWith('.webp') || name.endsWith('.jxl') ||
        name.endsWith('.avif') || name.endsWith('.bmp');
    });

    if (validFiles.length === 0) {
      alert("変換対象の画像ファイル（JPEG, PNG, GIF, WebP等）を選択してください。");
      return;
    }

    queueSection.classList.remove('hidden');

    for (const file of validFiles) {
      const taskId = `task_${++taskIdCounter}`;
      const item = {
        taskId: taskId,
        file: file,
        fileName: file.name,
        fileSize: file.size,
        type: file.type,
        status: 'pending', // pending, processing, complete, error
        percent: 0,
        resultBlob: null,
        resultSize: 0,
        outFileName: file.name.replace(/\.[^.]+$/, '') + '.jxl'
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

    // Format badge
    let formatBadge = 'IMAGE';
    const ext = item.fileName.split('.').pop().toUpperCase();
    if (['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'JXL'].includes(ext)) {
      formatBadge = ext;
    }

    // Thumbnail preview
    const previewUrl = URL.createObjectURL(item.file);

    li.innerHTML = `
      <div class="item-preview">
        <img src="${previewUrl}" alt="Preview" class="thumbnail" />
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
      const ratio = ((item.resultSize / item.fileSize) * 100).toFixed(1);
      const diffText = savedDiff <= 0
        ? ` (${((1 - item.resultSize / item.fileSize) * 100).toFixed(1)}% 削減)`
        : ` (+${((item.resultSize / item.fileSize - 1) * 100).toFixed(1)}%)`;

      statusText.innerHTML = `
        <span class="text-success">✅ 完了</span>: <strong>${formatBytes(item.resultSize)}</strong> ${diffText}
        ${item.isAnimated ? '<span class="badge badge-anim">動的 (Animation)</span>' : ''}
        ${item.hasExif ? '<span class="badge badge-exif">Exif保持</span>' : ''}
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

  // 6. Process Queue
  async function processNextInQueue() {
    if (isProcessing) return;

    const nextItem = taskQueue.find(t => t.status === 'pending');
    if (!nextItem) {
      updateGlobalProgress();
      return;
    }

    isProcessing = true;
    nextItem.status = 'processing';
    nextItem.statusMessage = '変換処理を開始...';
    nextItem.percent = 10;
    updateQueueItemUI(nextItem);
    updateGlobalProgress();

    const quality = parseInt(qualitySlider.value, 10);
    const updateExif = updateExifCheckbox ? updateExifCheckbox.checked : true;

    // Send task to worker
    worker.postMessage({
      taskId: nextItem.taskId,
      file: nextItem.file,
      fileName: nextItem.fileName,
      quality: quality,
      updateExif: updateExif
    });
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
      completedTasks.push(task);

      updateQueueItemUI(task);
      isProcessing = false;
      updateGlobalProgress();
      processNextInQueue();
    } else if (data.type === 'error') {
      task.status = 'error';
      task.errorMessage = data.error;
      updateQueueItemUI(task);
      isProcessing = false;
      updateGlobalProgress();
      processNextInQueue();
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

  // 7. Downloads
  function downloadSingle(item) {
    if (!item.resultBlob) return;
    const url = URL.createObjectURL(item.resultBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.outFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
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
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        a.href = url;
        a.download = `jxl_converted_${dateStr}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
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
