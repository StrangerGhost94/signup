// Shared category metadata: color + icon, used on the client search page
// and the provider dashboard so both stay in sync.
window.CATEGORY_COLORS = {
  'Plumbing': '#2F6169',
  'Electrical': '#B9791C',
  'Carpentry': '#8B5E34',
  'Painting': '#A24E67',
  'Cleaning': '#3B6FA0',
  'Gardening': '#6F8C3E',
  'Moving': '#5A5F73',
  'Mechanical': '#B8491F'
};

window.CATEGORY_ICONS = {
  'Plumbing': '<path d="M14.7 6.3a4 4 0 0 0-5.66 5.66L4 17l3 3 5.04-5.04a4 4 0 0 0 5.66-5.66l-2.12 2.12-2.12-.7-.7-2.12 2.12-2.12z"/>',
  'Electrical': '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>',
  'Carpentry': '<path d="M4 20l7-7M14 4l6 6-3 3-6-6 3-3zM10 10l4 4"/>',
  'Painting': '<rect x="9" y="3" width="6" height="8" rx="1"/><path d="M12 11v10M8 21h8"/>',
  'Cleaning': '<path d="M9 3l6 6M4 20l6-6M13 6l5 5-8 8-4-1 1-4 6-6z"/>',
  'Gardening': '<circle cx="12" cy="9" r="4"/><path d="M12 13v8"/>',
  'Moving': '<path d="M3 16V6h11v10M3 16h13M14 10h4l3 3v3M14 16h9M7 19a2 2 0 1 0 0-.01M18 19a2 2 0 1 0 0-.01"/>',
  'Mechanical': '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
};

window.URGENCY_OPTIONS = [
  { value: 'now', label: 'Now', sub: 'ASAP', color: '#DC2626' },
  { value: 'today', label: 'Today', sub: 'Within hours', color: '#D97706' },
  { value: 'schedule', label: 'Schedule', sub: 'Choose a time', color: '#0B6E4F' }
];

// Rough ballpark ranges in UGX, shown as an estimate only — not a quote.
window.CATEGORY_ESTIMATES = {
  'Plumbing': '30,000 – 60,000',
  'Electrical': '40,000 – 80,000',
  'Carpentry': '35,000 – 90,000',
  'Painting': '150,000 – 500,000',
  'Cleaning': '25,000 – 70,000',
  'Gardening': '20,000 – 60,000',
  'Moving': '80,000 – 250,000',
  'Mechanical': '50,000 – 200,000'
};

window.STATUS_META = {
  'requested': { label: 'Requested', color: '#D97706', bg: '#FDF3E3' },
  'accepted': { label: 'Accepted', color: '#0B6E4F', bg: '#E6F4EC' },
  'declined': { label: 'Declined', color: '#DC2626', bg: '#FCE9E9' },
  'completed': { label: 'Completed', color: '#374151', bg: '#F0F1F0' },
  'cancelled': { label: 'Cancelled', color: '#6B7280', bg: '#F0F1F0' }
};

window.categoryColor = function (cat) {
  return window.CATEGORY_COLORS[cat] || '#2F6169';
};

window.categoryIcon = function (cat) {
  return window.CATEGORY_ICONS[cat] || window.CATEGORY_ICONS['Plumbing'];
};

window.checkPasswordStrength = function (pw) {
  return {
    length: pw.length >= 8,
    letter: /[A-Za-z]/.test(pw),
    number: /[0-9]/.test(pw)
  };
};

window.compressImageFile = function (file, maxDim, quality) {
  maxDim = maxDim || 320;
  quality = quality || 0.75;
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Please choose an image file.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
};

// --- PWA install prompt ---
(function () {
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
    return; // already installed/running as an app
  }
  if (localStorage.getItem('installPromptDismissed')) return;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  function showInstallBanner(onInstallClick, installLabel) {
    const banner = document.createElement('div');
    banner.className = 'install-banner';
    banner.innerHTML = `
      <img src="images/icon-192.png" alt="" class="install-banner-icon">
      <div class="install-banner-text">
        <strong>Add HandyLink to your Home Screen</strong>
        <span>${installLabel}</span>
      </div>
      <button type="button" class="install-banner-close" aria-label="Dismiss">&times;</button>
    `;
    document.body.appendChild(banner);
    banner.querySelector('.install-banner-close').addEventListener('click', () => {
      banner.remove();
      localStorage.setItem('installPromptDismissed', '1');
    });
    if (onInstallClick) {
      const clickable = banner.querySelector('.install-banner-text');
      clickable.style.cursor = 'pointer';
      clickable.addEventListener('click', onInstallClick);
    }
  }

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBanner(() => {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(() => {
        document.querySelector('.install-banner')?.remove();
        localStorage.setItem('installPromptDismissed', '1');
      });
    }, 'Tap here to install — quick access, no browser bar.');
  });

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isSafari = /safari/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
  if (isIos && isSafari) {
    setTimeout(() => {
      showInstallBanner(null, 'Tap Share, then "Add to Home Screen".');
    }, 1500);
  }
})();

window.promptForLocation = function (onResult) {
  const KEY = 'locationPromptDismissedSession';

  function actuallyGetPosition() {
    navigator.geolocation.getCurrentPosition(
      (pos) => onResult(pos.coords.latitude, pos.coords.longitude),
      () => onResult(null, null),
      { timeout: 8000 }
    );
  }

  if (!navigator.geolocation) {
    onResult(null, null);
    return;
  }

  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then((status) => {
      if (status.state === 'granted') {
        actuallyGetPosition();
      } else if (status.state === 'denied') {
        onResult(null, null);
      } else {
        showLocationBanner(actuallyGetPosition, onResult);
      }
    }).catch(() => showLocationBanner(actuallyGetPosition, onResult));
  } else {
    if (sessionStorage.getItem(KEY)) {
      onResult(null, null);
      return;
    }
    showLocationBanner(actuallyGetPosition, onResult);
  }

  function showLocationBanner(onAllow, onResultInner) {
    if (document.querySelector('.location-banner')) return;
    const banner = document.createElement('div');
    banner.className = 'install-banner location-banner';
    banner.innerHTML = `
      <div class="install-banner-icon" style="background:var(--primary-tint); display:flex; align-items:center; justify-content:center;">
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2" style="width:20px;height:20px;"><path d="M12 21s-7-6.5-7-11a7 7 0 1 1 14 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>
      </div>
      <div class="install-banner-text">
        <strong>See pros near you</strong>
        <span>Allow location to sort results by distance.</span>
      </div>
      <button type="button" class="small-btn" style="width:auto; padding:0.5rem 0.9rem;">Allow</button>
    `;
    document.body.appendChild(banner);
    banner.querySelector('button').addEventListener('click', () => {
      banner.remove();
      onAllow();
    });
    const closeBtn = document.createElement('button');
    closeBtn.className = 'install-banner-close';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => {
      banner.remove();
      sessionStorage.setItem(KEY, '1');
      onResultInner(null, null);
    });
    banner.appendChild(closeBtn);
  }
};

window.distanceKm = function (lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => v === null || v === undefined || isNaN(v))) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

window.relativeTime = function (iso) {
  if (!iso) return null;
  const diffSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
};

window.escapeHtml = function (str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

window.initials = function (name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
};

window.renderTrustBadges = function (w) {
  const badges = [];
  if (w.identity_status === 'VERIFIED') {
    badges.push(`<span class="trust-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>Identity verified</span>`);
  }
  if (w.phone_status === 'VERIFIED') {
    badges.push(`<span class="trust-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>Phone verified</span>`);
  }
  if (w.category_verified) {
    badges.push(`<span class="trust-badge trust-badge-primary"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>${escapeHtml(w.category)} verified</span>`);
  }
  if (badges.length === 0) return '';
  return `<div class="trust-badge-row">${badges.join('')}</div>`;
};

window.renderTrustMeta = function (w) {
  const parts = [];
  parts.push(`${w.completed_jobs || 0} job${w.completed_jobs === 1 ? '' : 's'} completed`);
  if (w.experience_years != null) parts.push(`${w.experience_years} yrs experience`);
  return parts.join(' · ');
};

window.errorStateHtml = function (retryFnName) {
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>
    <strong>Something went wrong</strong>
    Check your connection and try again.
    <div style="margin-top:0.75rem;"><button class="small-btn btn-outline" style="width:auto;" onclick="${retryFnName}">Retry</button></div>
  </div>`;
};

let _modalLastFocus = null;
let _modalKeyHandler = null;

window.openModal = function (overlayEl) {
  _modalLastFocus = document.activeElement;
  overlayEl.style.display = 'flex';

  const focusables = overlayEl.querySelectorAll('button, input, textarea, a[href], select');
  if (focusables.length) focusables[0].focus();

  _modalKeyHandler = function (e) {
    if (e.key === 'Escape') {
      window.closeModal(overlayEl);
      return;
    }
    if (e.key === 'Tab' && focusables.length) {
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener('keydown', _modalKeyHandler);
};

window.closeModal = function (overlayEl) {
  overlayEl.style.display = 'none';
  if (_modalKeyHandler) {
    document.removeEventListener('keydown', _modalKeyHandler);
    _modalKeyHandler = null;
  }
  if (_modalLastFocus) _modalLastFocus.focus();
};

window.showToast = function (message, type) {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    stack.setAttribute('aria-live', 'polite');
    stack.setAttribute('aria-atomic', 'true');
    document.body.appendChild(stack);
  }
  const toast = document.createElement('div');
  toast.className = 'toast' + (type ? ` toast-${type}` : '');
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, 2800);
};

window.animateCount = function (el, target, opts) {
  const duration = (opts && opts.duration) || 900;
  const prefix = (opts && opts.prefix) || '';
  const suffix = (opts && opts.suffix) || '';
  const start = performance.now();
  const from = 0;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = prefix + target.toLocaleString() + suffix;
    return;
  }
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = Math.round(from + (target - from) * eased);
    el.textContent = prefix + value.toLocaleString() + suffix;
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
};
