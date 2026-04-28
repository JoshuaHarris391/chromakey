import './style.css';

    const state = {
      image: null,
      imageData: null,
      width: 0,
      height: 0,
      mode: 'mask',
      wavelength: { min: 380, max: 700 },
      intensity: { min: 0, max: 100 },
      feather: 0,
      lastRawSelectedCount: 0,
      invertMask: false,
      outputBg: 'transparent',
      silhouetteColor: '#ffffff',
      zoom: 1,
      panX: 0,
      panY: 0,
      isPanning: false,
    };

    const $ = (id) => document.getElementById(id);
    const viewport = $('viewport');
    const emptyState = $('emptyState');
    const displayCanvas = $('displayCanvas');
    const displayCtx = displayCanvas.getContext('2d');
    const fileInput = $('fileInput');

    emptyState.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) loadImage(e.target.files[0]);
    });

    ['dragenter', 'dragover'].forEach(ev => {
      viewport.addEventListener(ev, (e) => {
        e.preventDefault();
        emptyState.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(ev => {
      viewport.addEventListener(ev, (e) => {
        e.preventDefault();
        emptyState.classList.remove('dragover');
      });
    });
    viewport.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) loadImage(file);
    });

    function loadImage(file) {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1800;
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > maxDim || h > maxDim) {
          const scale = maxDim / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }

        const src = document.createElement('canvas');
        src.width = w; src.height = h;
        src.getContext('2d').drawImage(img, 0, 0, w, h);

        state.image = src;
        state.width = w;
        state.height = h;
        state.imageData = src.getContext('2d').getImageData(0, 0, w, h);

        displayCanvas.width = w;
        displayCanvas.height = h;
        displayCanvas.style.display = 'block';
        emptyState.style.display = 'none';

        $('exportBtn').disabled = false;
        $('exportSilhouetteBtn').disabled = false;
        $('resetBtn').disabled = false;
        $('resReadout').textContent = `${w}×${h}`;
        $('zoomControls').classList.add('active');
        fitView();

        computeHistograms();
        renderAllHistograms();
        process();
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(file);
    }

    function rgbToHsv(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const d = max - min;
      const v = max;
      const s = max === 0 ? 0 : d / max;
      let h = 0;
      if (d !== 0) {
        if (max === r)      h = ((g - b) / d) + (g < b ? 6 : 0);
        else if (max === g) h = ((b - r) / d) + 2;
        else                h = ((r - g) / d) + 4;
        h *= 60;
      }
      return [h, s, v];
    }

    function hueToWavelength(h) {
      if (h <= 270) return 700 - (h / 270) * 320;
      return -1;
    }

    // ════════════════════════════════════════════════════════════
    // HISTOGRAMS
    // ════════════════════════════════════════════════════════════
    const HIST_BUCKETS = 64;

    // Spectrum color stops — match the slider track gradient exactly.
    const SPECTRUM_STOPS = [
      { pos: 0.00, color: [107,  33, 168] }, // violet (380nm)
      { pos: 0.22, color: [ 37,  99, 235] }, // blue
      { pos: 0.38, color: [  8, 145, 178] }, // cyan
      { pos: 0.53, color: [ 22, 163,  74] }, // green
      { pos: 0.63, color: [234, 179,   8] }, // yellow
      { pos: 0.75, color: [234,  88,  12] }, // orange
      { pos: 1.00, color: [220,  38,  38] }  // red (700nm)
    ];

    function spectrumColorAt(t) {
      t = Math.max(0, Math.min(1, t));
      for (let i = 0; i < SPECTRUM_STOPS.length - 1; i++) {
        const a = SPECTRUM_STOPS[i], b = SPECTRUM_STOPS[i + 1];
        if (t >= a.pos && t <= b.pos) {
          const lt = (t - a.pos) / (b.pos - a.pos);
          return `rgb(${
            Math.round(a.color[0] + (b.color[0] - a.color[0]) * lt)},${
            Math.round(a.color[1] + (b.color[1] - a.color[1]) * lt)},${
            Math.round(a.color[2] + (b.color[2] - a.color[2]) * lt)})`;
        }
      }
      return 'rgb(220,38,38)';
    }

    function computeHistograms() {
      if (!state.imageData) return;
      const { data } = state.imageData;
      const wHist = new Float32Array(HIST_BUCKETS);
      const iHist = new Float32Array(HIST_BUCKETS);

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const [hue, sat, val] = rgbToHsv(r, g, b);

        // Intensity — every pixel contributes
        const ib = Math.min(Math.floor(val * HIST_BUCKETS), HIST_BUCKETS - 1);
        iHist[ib]++;

        // Wavelength — only saturated, spectral pixels
        if (sat >= 0.05) {
          const wl = hueToWavelength(hue);
          if (wl >= 380 && wl <= 700) {
            const wb = Math.min(Math.floor(((wl - 380) / 320) * HIST_BUCKETS), HIST_BUCKETS - 1);
            wHist[wb]++;
          }
        }
      }

      state.wavelengthHist = wHist;
      state.intensityHist = iHist;
    }

    function renderHistogram(canvasId, hist, range, rangeMin, rangeMax, inRangeColorFn) {
      const canvas = document.getElementById(canvasId);
      if (!canvas || !hist) return;

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0) return;

      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      // Log normalization
      let max = 0;
      for (let i = 0; i < hist.length; i++) if (hist[i] > max) max = hist[i];
      if (max === 0) return;
      const logMax = Math.log(1 + max);

      const bw = rect.width / hist.length;
      const gap = 0.5;

      for (let i = 0; i < hist.length; i++) {
        const t = i / (hist.length - 1);                // 0..1 position in range
        const value = range[0] + t * (range[1] - range[0]);
        const inRange = value >= rangeMin && value <= rangeMax;
        const h = rect.height * (Math.log(1 + hist[i]) / logMax);

        ctx.fillStyle = inRange ? inRangeColorFn(t) : '#262626';
        ctx.fillRect(i * bw, rect.height - h, Math.max(bw - gap, 0.5), h);
      }
    }

    function renderWavelengthHist() {
      renderHistogram(
        'wavelengthHist',
        state.wavelengthHist,
        [380, 700],
        state.wavelength.min,
        state.wavelength.max,
        (t) => spectrumColorAt(t)
      );
    }

    function renderIntensityHist() {
      renderHistogram(
        'intensityHist',
        state.intensityHist,
        [0, 100],
        state.intensity.min,
        state.intensity.max,
        () => '#fafafa'
      );
    }

    function renderAllHistograms() {
      renderWavelengthHist();
      renderIntensityHist();
    }

    window.addEventListener('resize', () => {
      if (state.imageData) renderAllHistograms();
    });

    function computeRawMask() {
      const { data } = state.imageData;
      const total = state.width * state.height;
      const mask = new Uint8Array(total);

      const wMin = state.wavelength.min;
      const wMax = state.wavelength.max;
      const iMin = state.intensity.min / 100;
      const iMax = state.intensity.max / 100;
      const fullWavelength = wMin <= 380 && wMax >= 700;

      let selected = 0;

      for (let i = 0, p = 0; p < total; i += 4, p++) {
        const r = data[i], g = data[i+1], b = data[i+2];
        const [hue, sat, val] = rgbToHsv(r, g, b);

        if (val < iMin || val > iMax) continue;

        if (sat < 0.05) {
          if (fullWavelength) { mask[p] = 255; selected++; }
          continue;
        }

        const wavelength = hueToWavelength(hue);
        if (wavelength < 0) continue;

        if (wavelength >= wMin && wavelength <= wMax) {
          mask[p] = 255;
          selected++;
        }
      }

      state.lastRawSelectedCount = selected;
      return mask;
    }

    function featherMask(mask, radius) {
      const w = state.width, h = state.height;
      const c1 = document.createElement('canvas');
      c1.width = w; c1.height = h;
      const ctx1 = c1.getContext('2d');
      const id = ctx1.createImageData(w, h);
      for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
        id.data[i] = id.data[i+1] = id.data[i+2] = 255;
        id.data[i+3] = mask[p];
      }
      ctx1.putImageData(id, 0, 0);

      const c2 = document.createElement('canvas');
      c2.width = w; c2.height = h;
      const ctx2 = c2.getContext('2d');
      ctx2.filter = `blur(${radius}px)`;
      ctx2.drawImage(c1, 0, 0);

      const blurred = ctx2.getImageData(0, 0, w, h).data;
      const result = new Uint8Array(mask.length);
      for (let i = 3, p = 0; p < result.length; i += 4, p++) {
        result[p] = blurred[i];
      }
      return result;
    }

    function buildMask() {
      let mask = computeRawMask();
      if (state.invertMask) {
        const inv = new Uint8Array(mask.length);
        for (let i = 0; i < mask.length; i++) inv[i] = 255 - mask[i];
        mask = inv;
      }
      return state.feather > 0 ? featherMask(mask, state.feather) : mask;
    }

    function render(maskAlpha) {
      const w = state.width, h = state.height;
      const src = state.imageData.data;

      if (state.mode === 'original') {
        displayCtx.putImageData(state.imageData, 0, 0);
        return;
      }

      const out = displayCtx.createImageData(w, h);

      if (state.mode === 'mask') {
        for (let i = 0, p = 0; p < maskAlpha.length; i += 4, p++) {
          const m = maskAlpha[p] / 255 * 0.68;
          out.data[i]   = Math.round(src[i]   * (1 - m) + 239 * m);
          out.data[i+1] = Math.round(src[i+1] * (1 - m) + 68  * m);
          out.data[i+2] = Math.round(src[i+2] * (1 - m) + 68  * m);
          out.data[i+3] = src[i+3];
        }
      } else {
        // output mode: composite with transparent or white bg
        const whiteBg = state.outputBg === 'white';
        for (let i = 0, p = 0; p < maskAlpha.length; i += 4, p++) {
          const keep = 1 - maskAlpha[p] / 255;
          const finalAlpha = src[i+3] * keep;
          if (whiteBg) {
            const a = finalAlpha / 255;
            out.data[i]   = Math.round(src[i]   * a + 255 * (1 - a));
            out.data[i+1] = Math.round(src[i+1] * a + 255 * (1 - a));
            out.data[i+2] = Math.round(src[i+2] * a + 255 * (1 - a));
            out.data[i+3] = 255;
          } else {
            out.data[i]   = src[i];
            out.data[i+1] = src[i+1];
            out.data[i+2] = src[i+2];
            out.data[i+3] = Math.round(finalAlpha);
          }
        }
      }

      displayCtx.putImageData(out, 0, 0);
    }

    function process() {
      if (!state.imageData) return;
      const mask = buildMask();
      const total = state.width * state.height;
      const rawCount = state.lastRawSelectedCount;
      const keyedCount = state.invertMask ? total - rawCount : rawCount;
      const pct = (keyedCount / total) * 100;
      $('selectedPercent').textContent = pct.toFixed(1);
      $('pixelCount').textContent = keyedCount.toLocaleString();
      render(mask);
    }

    function setupDualSlider(el, onChange) {
      const min = parseFloat(el.dataset.min);
      const max = parseFloat(el.dataset.max);
      const handleMin = el.querySelector('.handle-min');
      const handleMax = el.querySelector('.handle-max');
      const dimLeft = el.querySelector('.dim-left');
      const dimRight = el.querySelector('.dim-right');
      let values = { min, max };

      function paint() {
        const minPct = (values.min - min) / (max - min) * 100;
        const maxPct = (values.max - min) / (max - min) * 100;
        handleMin.style.left = `${minPct}%`;
        handleMax.style.left = `${maxPct}%`;
        dimLeft.style.width = `${minPct}%`;
        dimRight.style.width = `${100 - maxPct}%`;
        onChange(values.min, values.max);
      }

      function startDrag(isMin, handle) {
        return (e) => {
          e.preventDefault();
          handle.classList.add('active');
          const rect = el.getBoundingClientRect();
          const move = (ev) => {
            const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
            const x = cx - rect.left;
            const pct = Math.max(0, Math.min(1, x / rect.width));
            const v = min + pct * (max - min);
            const minGap = (max - min) * 0.005;
            if (isMin) values.min = Math.min(v, values.max - minGap);
            else       values.max = Math.max(v, values.min + minGap);
            paint();
          };
          const up = () => {
            handle.classList.remove('active');
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.removeEventListener('touchmove', move);
            document.removeEventListener('touchend', up);
          };
          document.addEventListener('mousemove', move);
          document.addEventListener('mouseup', up);
          document.addEventListener('touchmove', move, { passive: false });
          document.addEventListener('touchend', up);
        };
      }

      handleMin.addEventListener('mousedown', startDrag(true, handleMin));
      handleMax.addEventListener('mousedown', startDrag(false, handleMax));
      handleMin.addEventListener('touchstart', startDrag(true, handleMin), { passive: false });
      handleMax.addEventListener('touchstart', startDrag(false, handleMax), { passive: false });

      requestAnimationFrame(paint);
      return { setValues: (mn, mx) => { values.min = mn; values.max = mx; paint(); } };
    }

    let processTimer = null;
    const scheduleProcess = () => {
      clearTimeout(processTimer);
      processTimer = setTimeout(process, 25);
    };

    const wavelengthSlider = setupDualSlider($('wavelengthSlider'), (mn, mx) => {
      state.wavelength.min = mn;
      state.wavelength.max = mx;
      $('wavelengthMinValue').textContent = Math.round(mn);
      $('wavelengthMaxValue').textContent = Math.round(mx);
      renderWavelengthHist();
      scheduleProcess();
    });

    const intensitySlider = setupDualSlider($('intensitySlider'), (mn, mx) => {
      state.intensity.min = mn;
      state.intensity.max = mx;
      $('intensityMinValue').textContent = Math.round(mn);
      $('intensityMaxValue').textContent = Math.round(mx);
      renderIntensityHist();
      scheduleProcess();
    });

    $('featherSlider').addEventListener('input', (e) => {
      state.feather = parseFloat(e.target.value);
      $('featherValue').textContent = state.feather.toFixed(1);
      scheduleProcess();
    });

    document.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.mode = btn.dataset.mode;
        const labels = { mask: 'Mask Overlay', output: 'Output', original: 'Source' };
        $('viewportMode').textContent = labels[state.mode];
        process();
      });
    });

    displayCanvas.addEventListener('mousemove', (e) => {
      if (!state.imageData || state.isPanning) return;
      const rect = displayCanvas.getBoundingClientRect();
      const x = Math.floor((e.clientX - rect.left) * (state.width / rect.width));
      const y = Math.floor((e.clientY - rect.top) * (state.height / rect.height));
      if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
      const i = (y * state.width + x) * 4;
      const d = state.imageData.data;
      const r = d[i], g = d[i+1], b = d[i+2];
      const [hue, sat, val] = rgbToHsv(r, g, b);
      const wl = sat < 0.05 ? null : hueToWavelength(hue);
      const sampleSwatch = $('sampleSwatch');
      const sampleText = $('sampleText');
      sampleSwatch.style.background = `rgb(${r},${g},${b})`;
      sampleSwatch.style.borderColor = 'var(--border-bright)';
      const wlText = wl === null ? 'gray' : wl < 0 ? 'n/a' : `${Math.round(wl)}nm`;
      sampleText.classList.remove('empty');
      sampleText.innerHTML = `<span class="lbl">λ</span> <span class="hi">${wlText}</span>&nbsp;&nbsp;<span class="lbl">I</span> <span class="hi">${Math.round(val * 100)}%</span>`;
    });

    displayCanvas.addEventListener('mouseleave', () => {
      $('sampleText').classList.add('empty');
      $('sampleText').textContent = 'Hover to sample';
      $('sampleSwatch').style.background = 'var(--raised)';
      $('sampleSwatch').style.borderColor = 'var(--border-bright)';
    });

    $('exportBtn').addEventListener('click', () => {
      const w = state.width, h = state.height;
      const mask = buildMask();
      const src = state.imageData.data;

      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = w;
      exportCanvas.height = h;
      const ectx = exportCanvas.getContext('2d');
      const out = ectx.createImageData(w, h);
      const whiteBg = state.outputBg === 'white';

      for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
        const finalAlpha = src[i+3] * (1 - mask[p] / 255);
        if (whiteBg) {
          const a = finalAlpha / 255;
          out.data[i]   = Math.round(src[i]   * a + 255 * (1 - a));
          out.data[i+1] = Math.round(src[i+1] * a + 255 * (1 - a));
          out.data[i+2] = Math.round(src[i+2] * a + 255 * (1 - a));
          out.data[i+3] = 255;
        } else {
          out.data[i]   = src[i];
          out.data[i+1] = src[i+1];
          out.data[i+2] = src[i+2];
          out.data[i+3] = Math.round(finalAlpha);
        }
      }

      ectx.putImageData(out, 0, 0);

      exportCanvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = whiteBg ? 'chromakey-output-white.png' : 'chromakey-output.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 'image/png');
    });

    function hexToRgb(hex) {
      const h = hex.replace('#', '');
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      ];
    }

    $('silhouetteColor').addEventListener('input', (e) => {
      state.silhouetteColor = e.target.value;
    });

    $('exportSilhouetteBtn').addEventListener('click', () => {
      const w = state.width, h = state.height;
      const mask = buildMask();
      const src = state.imageData.data;
      const [r, g, b] = hexToRgb(state.silhouetteColor);

      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = w;
      exportCanvas.height = h;
      const ectx = exportCanvas.getContext('2d');
      const out = ectx.createImageData(w, h);

      for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
        const finalAlpha = src[i+3] * (1 - mask[p] / 255);
        out.data[i]   = r;
        out.data[i+1] = g;
        out.data[i+2] = b;
        out.data[i+3] = Math.round(finalAlpha);
      }

      ectx.putImageData(out, 0, 0);

      exportCanvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chromakey-silhouette-${state.silhouetteColor.replace('#','')}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 'image/png');
    });

    // ════════════════════════════════════════════════════════════
    // ZOOM + PAN
    // ════════════════════════════════════════════════════════════
    function applyTransform() {
      displayCanvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    }

    function updateZoomLabel() {
      $('zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
    }

    function fitView() {
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
      applyTransform();
      updateZoomLabel();
    }

    // Cursor-centered zoom. If cx/cy omitted, zooms about viewport center.
    function setZoom(newZoom, cx, cy) {
      const vRect = viewport.getBoundingClientRect();
      const vcx = vRect.width / 2;
      const vcy = vRect.height / 2;
      if (cx === undefined) cx = vcx;
      if (cy === undefined) cy = vcy;

      const dx = cx - vcx;
      const dy = cy - vcy;
      // Point in canvas space under cursor (pre-zoom)
      const px = (dx - state.panX) / state.zoom;
      const py = (dy - state.panY) / state.zoom;

      newZoom = Math.max(0.1, Math.min(16, newZoom));
      state.panX = dx - px * newZoom;
      state.panY = dy - py * newZoom;
      state.zoom = newZoom;

      applyTransform();
      updateZoomLabel();
    }

    $('zoomIn').addEventListener('click', () => setZoom(state.zoom * 1.25));
    $('zoomOut').addEventListener('click', () => setZoom(state.zoom / 1.25));
    $('zoomLabel').addEventListener('click', fitView);

    // Wheel zoom
    viewport.addEventListener('wheel', (e) => {
      if (!state.imageData) return;
      e.preventDefault();
      const vRect = viewport.getBoundingClientRect();
      const cx = e.clientX - vRect.left;
      const cy = e.clientY - vRect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom(state.zoom * factor, cx, cy);
    }, { passive: false });

    // Panning (left-click drag on canvas)
    let panStart = null;
    displayCanvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      panStart = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
      state.isPanning = true;
      displayCanvas.classList.add('panning');
    });
    window.addEventListener('mousemove', (e) => {
      if (!state.isPanning || !panStart) return;
      state.panX = panStart.panX + (e.clientX - panStart.x);
      state.panY = panStart.panY + (e.clientY - panStart.y);
      applyTransform();
    });
    window.addEventListener('mouseup', () => {
      if (!state.isPanning) return;
      state.isPanning = false;
      panStart = null;
      displayCanvas.classList.remove('panning');
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (!state.imageData) return;
      if (e.target.tagName === 'INPUT') return;
      if (e.key === '0') { fitView(); e.preventDefault(); }
      else if (e.key === '+' || e.key === '=') { setZoom(state.zoom * 1.25); e.preventDefault(); }
      else if (e.key === '-' || e.key === '_') { setZoom(state.zoom / 1.25); e.preventDefault(); }
    });

    // ════════════════════════════════════════════════════════════
    // INVERT MASK + OUTPUT BG
    // ════════════════════════════════════════════════════════════
    $('invertSwitch').addEventListener('click', (e) => {
      state.invertMask = !state.invertMask;
      e.currentTarget.dataset.on = state.invertMask ? 'true' : 'false';
      process();
    });

    document.querySelectorAll('#outputBgToggle .seg').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#outputBgToggle .seg').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.outputBg = btn.dataset.bg;
        process();
      });
    });

    $('resetBtn').addEventListener('click', () => {
      wavelengthSlider.setValues(380, 700);
      intensitySlider.setValues(0, 100);
      $('featherSlider').value = 0;
      $('featherValue').textContent = '0.0';
      state.feather = 0;
      renderAllHistograms();
      scheduleProcess();
    });
