// --- CSRF token handling ---
// Rather than editing every fetch() call across ~30 pages (and
// inevitably missing some), this wraps fetch once. Every same-origin
// mutating request transparently gains the token. Pages don't know or
// care that CSRF exists, which also means future code is protected by
// default instead of needing to remember.
(function () {
  const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
  let csrfToken = null;
  let inFlight = null;

  async function loadToken() {
    // De-duplicate: if several requests fire at once on page load, they
    // share one token fetch rather than racing.
    if (inFlight) return inFlight;
    inFlight = fetch('/api/csrf-token', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { csrfToken = d && d.csrfToken ? d.csrfToken : null; return csrfToken; })
      .catch(() => null)
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    init = init || {};
    const method = (init.method || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    // Only same-origin API calls — never leak the token to third
    // parties like the map tile or geocoding services.
    const isSameOrigin = url.startsWith('/') || url.startsWith(window.location.origin);

    if (!SAFE_METHODS.includes(method) && isSameOrigin) {
      if (!csrfToken) await loadToken();
      if (csrfToken) {
        const headers = new Headers(init.headers || (typeof input !== 'string' && input ? input.headers : undefined) || {});
        headers.set('X-CSRF-Token', csrfToken);
        init = { ...init, headers, credentials: init.credentials || 'same-origin' };
      }
    }

    let response = await originalFetch(input, init);

    // Session expiry is the single most common cause of "everything
    // stopped working" in an installed PWA — it stays open for days, the
    // session lapses, and every request then 401s. Previously each
    // failure surfaced as "Something went wrong — check your connection",
    // which is actively misleading: the network is fine, and no amount
    // of retrying will help. Send them to sign in instead.
    if (response.status === 401 && isSameOrigin && !url.includes('/api/me') && !url.includes('/api/login')) {
      const onAuthPage = /\/(login|signup|index|reset-password)\.html$/.test(window.location.pathname) ||
                         window.location.pathname === '/';
      if (!onAuthPage) {
        // Remember where they were so they land back here after signing in.
        try { sessionStorage.setItem('returnTo', window.location.pathname + window.location.search); } catch (e) {}
        window.location.href = '/login.html?expired=1';
      }
      return response;
    }

    // A rotated session (re-login) or a token we never managed to load
    // invalidates the cached token. Retry once on any 403 for a mutating
    // same-origin request. Keying off the status code rather than
    // matching the server's error wording means this keeps working even
    // if that message is ever reworded or localised.
    if (response.status === 403 && !SAFE_METHODS.includes(method) && isSameOrigin && !init._csrfRetried) {
      csrfToken = null;
      await loadToken();
      if (csrfToken) {
        const headers = new Headers(init.headers || {});
        headers.set('X-CSRF-Token', csrfToken);
        response = await originalFetch(input, {
          ...init, headers, credentials: 'same-origin', _csrfRetried: true
        });
      }
    }
    return response;
  };
})();

// Shared category metadata: color + icon, used on the client search page
// and the provider dashboard so both stay in sync.
window.CATEGORY_COLORS = {
  'Plumbing': '#2F6169',
  'Electrical': '#B9791C',
  'Carpentry': '#8B5E34',
  'Painting': '#A24E67',
  'Cleaning': '#3B6FA0',
  'Moving': '#5A5F73',
  'Mechanical': '#B8491F',
  'Realtor': '#3E5C76',
  'Construction': '#C1440E'
};

// All icons are drawn on the same 24x24 grid with matching optical
// weight and detail level, so a row of them reads as one set rather
// than a collection of clip-art. Stroke width and caps are applied
// globally in CSS, so paths stay purely geometric here.
window.CATEGORY_ICONS = {
  // Pipe with joint and a drip — reads as plumbing at small sizes
  // better than a bare wrench, which was ambiguous next to Mechanical.
  'Plumbing': '<path d="M7 4v5a3 3 0 0 0 3 3h4a3 3 0 0 1 3 3v5"/><path d="M4.5 4h5"/><path d="M14.5 20h5"/><path d="M10.5 8.5h3"/>',
  // Bolt inside a rounded plate — more deliberate than a lone zigzag.
  'Electrical': '<path d="M13.5 3 6 13h5l-1.5 8L17 11h-5z"/>',
  // Hand saw with a visible blade edge and handle.
  'Carpentry': '<path d="M3 17.5 13.5 7l3.5 3.5L6.5 21H3z"/><path d="M16 4.5 19.5 8l-2 2L14 6.5z"/><path d="M6 14.5l1.5 1.5M8.5 12l1.5 1.5M11 9.5l1.5 1.5"/>',
  // Roller with handle and tray edge.
  'Painting': '<rect x="4" y="4" width="12" height="5" rx="1.5"/><path d="M16 6.5h2.5A1.5 1.5 0 0 1 20 8v2.5a1.5 1.5 0 0 1-1.5 1.5H12"/><path d="M12 12v2"/><rect x="10" y="14" width="4" height="6" rx="1.5"/>',
  // Spray bottle with motion lines — clearer than a generic sparkle.
  'Cleaning': '<path d="M9 8h5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2z"/><path d="M9 8V5.5A1.5 1.5 0 0 1 10.5 4h2"/><path d="M16 6h3M17.5 3.5 19.5 6l-2 2.5"/><path d="M12 12v3"/>',
  // Box truck, drawn to the same optical box as its neighbours. The
  // earlier version ran edge-to-edge horizontally and sat low, which
  // made it read as noticeably larger than the icons beside it.
  'Moving': '<path d="M3.5 6.5h9v8h-9z"/><path d="M12.5 9h3.2l2.8 3v2.5h-6z"/><circle cx="7" cy="17" r="1.7"/><circle cx="16" cy="17" r="1.7"/><path d="M8.7 17h5.6"/><path d="M3.5 14.5h1.8M17.7 14.5h1.3"/>',
  // Gear with a clear tooth profile and centre bore.
  'Mechanical': '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3"/>',
  // House with a key — property/realtor rather than just another house.
  'Realtor': '<path d="M3.5 10.5 12 4l8.5 6.5"/><path d="M5.5 9.5V20h13V9.5"/><circle cx="12" cy="14" r="1.8"/><path d="M12 15.8V18"/><path d="M11 17h2"/>',
  // Crane hook and load — construction as a site, not a single tool.
  'Construction': '<path d="M4 20h16"/><path d="M6 20V6h12"/><path d="M6 6 18 6"/><path d="M15 6v4"/><path d="M13.5 10h3l-1.5 3.5z"/><path d="M6 9.5 11 6"/><rect x="7.5" y="15" width="6" height="5" rx="1"/>'
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
  'Moving': '80,000 – 250,000',
  'Mechanical': '50,000 – 200,000',
  'Realtor': '50,000 – 300,000',
  'Construction': '300,000 – 2,000,000'
};

window.STATUS_META = {
  'awaiting_offers': { label: 'Awaiting Offers', color: '#7C3AED', bg: '#F1E9FE' },
  'requested': { label: 'Requested', color: '#D97706', bg: '#FDF3E3' },
  'accepted': { label: 'Booked', color: '#0B6E4F', bg: '#E6F4EC' },
  'on_the_way': { label: 'On the Way', color: '#1D4ED8', bg: '#DBEAFE' },
  'arrived': { label: 'Arrived', color: '#1D4ED8', bg: '#DBEAFE' },
  'in_progress': { label: 'In Progress', color: '#B45309', bg: '#FEF3C7' },
  'awaiting_payment': { label: 'Awaiting Payment', color: '#B45309', bg: '#FEF3C7' },
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

// Service worker registration must be unconditional — push notifications
// depend on it, and it especially needs to run once the app is already
// installed, which the install-prompt logic below deliberately skips.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// Requests permission and subscribes this device to real push
// notifications. Returns 'granted', 'denied', or 'unsupported' so the
// caller can show the right feedback.
window.enablePushNotifications = async function () {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported';
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  try {
    const keyRes = await fetch('/api/push/vapid-public-key');
    if (!keyRes.ok) return 'unsupported'; // server has no VAPID keys configured
    const { publicKey } = await keyRes.json();

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }

    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON())
    });
    return 'granted';
  } catch (err) {
    console.error('Push subscription failed:', err);
    return 'denied';
  }
};

window.disablePushNotifications = async function () {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint })
    });
    await subscription.unsubscribe();
  }
};

// Browsers/OSes throttle or fully pause setInterval timers once a tab or
// installed PWA is backgrounded — the standard cause of "this screen
// looks stale until I manually reload." This runs the given refresh
// function immediately whenever the page becomes visible again, on top
// of whatever periodic polling a page already has, so returning to the
// app always shows current data without waiting for the next tick.
window.refreshOnResume = function (refreshFn) {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshFn();
  });
  window.addEventListener('focus', () => refreshFn());
};

// Fills any location text input from the device's real GPS position —
// reusable anywhere a location field exists, without touching the
// user's saved profile location.
// Takes up to 3 readings, keeping the most accurate one, instead of
// trusting whatever the very first fix happens to be — a single
// getCurrentPosition() call can return a coarse, wifi/cell-tower-based
// fix (accuracy of hundreds of meters) even on a device with a strong
// GPS signal, because it doesn't wait for the receiver to lock on.
// Uses sequential getCurrentPosition calls rather than watchPosition —
// simpler and more predictable across browsers, and each call gets its
// own generous timeout that accounts for how long a person actually
// takes to notice and respond to the permission prompt (which can
// easily be several seconds), not just GPS acquisition time. A short
// timeout here was the actual cause of the prompt looking
// unresponsive: the code was giving up before the person had even
// finished tapping "Allow."
window.getAccurateLocation = function () {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    let best = null;
    let attempts = 0;
    const maxAttempts = 5;
    // Accuracy (metres) we consider a real GPS-grade fix worth stopping
    // on. Below this, extra readings rarely improve things and just cost
    // time and battery. Above it, we're likely still on a coarse
    // wifi/cell-tower estimate and it's worth sampling again — the
    // device fuses GPS, wifi and cellular itself and typically reports
    // progressively better accuracy as the GPS receiver settles.
    const GOOD_ACCURACY_M = 25;
    // Never keep the user waiting longer than this overall, however
    // poor the readings are — we resolve with the best we have.
    const OVERALL_BUDGET_MS = 15000;
    const startedAt = Date.now();

    function takeReading() {
      attempts++;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
          const goodEnough = best.coords.accuracy <= GOOD_ACCURACY_M;
          const outOfBudget = Date.now() - startedAt > OVERALL_BUDGET_MS;
          if (goodEnough || attempts >= maxAttempts || outOfBudget) {
            resolve(best);
          } else {
            takeReading();
          }
        },
        (err) => {
          // The very first attempt failing (e.g. permission denied, or
          // the person dismissed the prompt) should surface immediately
          // rather than retrying blind. A later attempt failing after
          // we already have at least one reading just means "good
          // enough, stop here."
          if (best) resolve(best);
          else reject(err);
        },
        // enableHighAccuracy asks the device for its best available
        // positioning — on a phone that means engaging GPS rather than
        // settling for a cached network-based estimate. maximumAge: 0
        // forbids returning a stale cached fix.
        // Only the first call needs a generous timeout — it's the one
        // covering however long the person takes to notice and respond
        // to the permission prompt. By the second call, permission is
        // already resolved, so a shorter window is plenty.
        { enableHighAccuracy: true, timeout: attempts === 1 ? 20000 : 8000, maximumAge: 0 }
      );
    }
    takeReading();
  });
};

window.autofillLocation = function (inputId, btn) {
  const originalHtml = btn.innerHTML;
  btn.innerHTML = 'Allow location access…';
  btn.disabled = true;
  const restore = () => { btn.innerHTML = originalHtml; btn.disabled = false; };

  getAccurateLocation().then(async (pos) => {
    try {
      const res = await fetch(`/api/geocode/reverse?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}`);
      const data = await res.json();
      if (!res.ok) { showToast(data.error, 'error'); return; }
      const input = document.getElementById(inputId);
      input.value = data.formattedAddress;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Also publish the raw coordinates — callers that need to store
      // an exact position (worker signup, job posting) would otherwise
      // only get the display text and lose the precision entirely.
      window.dispatchEvent(new CustomEvent('handylink:location-autofilled', {
        detail: {
          inputId,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }
      }));
    } catch (err) {
      showToast('Couldn\u2019t look up your address right now.', 'error');
    } finally {
      restore();
    }
  }).catch((err) => {
    showToast(err.message === 'unsupported' ? 'Location isn\u2019t supported on this device.' : 'Location permission was denied or unavailable.', 'error');
    restore();
  });
};

// --- Automatic location tracking (while the app is open) ---
// Honest scope: a website cannot get real background location access
// the way a native app can — there's no "always allow, even when
// closed" for web pages. What this DOES do is remove the need to ever
// manually click a "use my location" button again: once permission is
// granted once, location is captured and kept fresh automatically for
// the rest of this session and every future one, silently, for as
// long as the tab/app is open.
const LOCATION_REFRESH_MS = 5 * 60 * 1000; // keep it fresh every 5 minutes while open
let locationRefreshTimer = null;
let lastLocationSaveAt = 0;

async function saveCurrentLocationSilently() {
  try {
    const pos = await getAccurateLocation();
    const res = await fetch('/api/me/location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy })
    });
    // fetch() only rejects on network failure — an HTTP 403/500 resolves
    // normally. Without this check the code treated a rejected save as a
    // success, stamped lastLocationSaveAt, and then suppressed retries
    // for the next 5 minutes: location silently stopped working while
    // reporting that it worked.
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      console.error('Location save failed:', res.status, detail.error || '');
      return false;
    }
    lastLocationSaveAt = Date.now();
    return true;
  } catch (err) {
    console.error('Location save error:', err && err.message ? err.message : err);
    return false;
  }
}

// Only actually pings GPS if the last save is old enough to need
// refreshing — this is what stops the browser's own "this site is
// using your location" indicator from firing on every page load or
// every time the app regains focus. A real GPS request happens at
// most once per LOCATION_REFRESH_MS window, not on every trigger.
function maybeSaveLocation() {
  if (Date.now() - lastLocationSaveAt < LOCATION_REFRESH_MS) return;
  saveCurrentLocationSilently();
}

// Call on every page load for a role that needs live location (providers
// today). Checks the *existing* permission state — never prompts on its
// own, since browsers require a real click to ask, which is what
// enableAutoLocationTracking() below is for.
let locationResumeListenerAdded = false;
function ensureLocationResumeListener() {
  if (locationResumeListenerAdded) return;
  locationResumeListenerAdded = true;
  // Background tabs get their timers throttled by the browser, so the
  // fixed interval alone isn't enough to guarantee freshness — this
  // makes a return to the app check for a fresh reading too. Routed
  // through maybeSaveLocation so switching tabs frequently doesn't
  // trigger a real GPS ping every single time.
  refreshOnResume(maybeSaveLocation);
}

window.startAutoLocationIfPermitted = async function () {
  if (!navigator.geolocation) return 'unsupported';

  // navigator.permissions.query({name:'geolocation'}) is known to be
  // unreliable on some browsers (notably Safari/iOS) — it can report
  // "not granted" even when the user already granted access, which is
  // what was causing the enable banner (and effectively the OS
  // permission prompt) to reappear on every refresh. Once location has
  // ever worked successfully on this device, trust that over what the
  // Permissions API claims, and just try directly — a real, silent
  // getCurrentPosition() call is the actual ground truth: if access
  // was truly revoked, it will fail and we correctly fall back to
  // asking again; if it was only misreported, it succeeds immediately
  // with no prompt at all.
  if (localStorage.getItem('locationEverGranted') === 'true') {
    const ok = await tryRefreshLocationIfStale();
    if (ok) {
      if (!locationRefreshTimer) locationRefreshTimer = setInterval(saveCurrentLocationSilently, LOCATION_REFRESH_MS);
      ensureLocationResumeListener();
      return 'granted';
    }
    // Genuinely no longer working (revoked at the OS/browser level) —
    // fall through and ask again below, rather than getting stuck.
  }

  if (!navigator.permissions) return 'prompt';
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    if (status.state === 'denied') return 'denied';
    if (status.state !== 'granted') return 'prompt';

    const ok = await tryRefreshLocationIfStale();
    if (!ok) return 'prompt';
    localStorage.setItem('locationEverGranted', 'true');
    if (!locationRefreshTimer) locationRefreshTimer = setInterval(saveCurrentLocationSilently, LOCATION_REFRESH_MS);
    ensureLocationResumeListener();
    return 'granted';
  } catch (err) {
    return 'unsupported';
  }
};

// Shared by both paths above — checks the server's own last-saved
// timestamp first so a normal page refresh doesn't re-trigger a real
// GPS request every time, only once it's actually gone stale.
async function tryRefreshLocationIfStale() {
  let needsFreshReading = true;
  try {
    const freshRes = await fetch('/api/me/location-freshness');
    if (freshRes.ok) {
      const { locationUpdatedAt } = await freshRes.json();
      if (locationUpdatedAt) {
        const age = Date.now() - new Date(locationUpdatedAt).getTime();
        if (age < LOCATION_REFRESH_MS) {
          needsFreshReading = false;
          lastLocationSaveAt = Date.now() - age;
        }
      }
    }
  } catch (err) { /* fall through and just take a fresh reading */ }

  if (!needsFreshReading) return true;
  return await saveCurrentLocationSilently();
}

// Call from a real click handler — this is the one moment a browser
// will actually show the permission prompt. Starts the same automatic
// refresh cycle the instant it's granted.
window.enableAutoLocationTracking = async function (btn) {
  const originalHtml = btn ? btn.innerHTML : null;
  if (btn) { btn.innerHTML = 'Allow location access…'; btn.disabled = true; }
  const ok = await saveCurrentLocationSilently();
  if (ok) {
    localStorage.setItem('locationEverGranted', 'true');
    if (!locationRefreshTimer) locationRefreshTimer = setInterval(saveCurrentLocationSilently, LOCATION_REFRESH_MS);
    ensureLocationResumeListener();
  }
  if (btn) { btn.innerHTML = originalHtml; btn.disabled = false; }
  return ok;
};


// One shared notification bell implementation for every page that has
// the markup (#bellBtn, #bellDot, #notifPanel) — previously duplicated
// separately in the client and provider home pages, and missing
// entirely from every other page, which is why notifications felt
// inconsistent between screens. Call once per page after the elements
// exist; returns a refresh() function for polling/refreshOnResume.
window.initNotificationBell = function () {
  const bellBtn = document.getElementById('bellBtn');
  const bellDot = document.getElementById('bellDot');
  if (!bellBtn || !bellDot) return () => {};

  // Built once, appended straight to <body> — this is what guarantees
  // the panel looks and behaves identically everywhere, completely
  // independent of whatever header layout a given page happens to use.
  let overlay = document.getElementById('notifSheetOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'notifSheetOverlay';
    overlay.className = 'notif-sheet-overlay';
    overlay.innerHTML = `
      <div class="notif-sheet">
        <div class="notif-sheet-handle"></div>
        <div class="notif-sheet-header">
          <h2>Notifications</h2>
          <div style="display:flex; gap:0.25rem;">
            <button type="button" id="notifSheetClear">Clear all</button>
            <button type="button" id="notifSheetClose">Close</button>
          </div>
        </div>
        <div class="notif-sheet-list" id="notifSheetList"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });
    overlay.querySelector('#notifSheetClose').addEventListener('click', closeSheet);
    overlay.querySelector('#notifSheetClear').addEventListener('click', async () => {
      const res = await fetch('/api/notifications', { method: 'DELETE' });
      if (!res.ok) { showToast('Couldn\u2019t clear notifications.', 'error'); return; }
      list.innerHTML = renderGroupedNotifications([]);
      bellDot.style.display = 'none';
      updateAppBadge(0);
      showToast('Notifications cleared.', 'success');
    });
  }
  const list = overlay.querySelector('#notifSheetList');

  function openSheet() { overlay.classList.add('open'); }
  function closeSheet() { overlay.classList.remove('open'); }

  async function loadNotifications(render) {
    const res = await fetch('/api/notifications');
    if (!res.ok) return;
    const data = await res.json();
    bellDot.style.display = data.unreadCount > 0 ? 'block' : 'none';
    updateAppBadge(data.unreadCount);
    if (render) {
      list.innerHTML = renderGroupedNotifications(data.notifications);
      list.querySelectorAll('.suggestion-row').forEach(row => {
        row.addEventListener('click', () => {
          // A swipe leaves the row translated; don't also navigate when
          // the user was clearly swiping rather than tapping.
          if (row.style.transform && row.style.transform !== 'translateX(0px)') return;
          if (row.dataset.link) window.location.href = row.dataset.link;
        });
      });
      attachNotificationSwipe(list, () => {
        // Keep the badge honest as rows are cleared one by one.
        loadNotifications(false);
      });
    }
  }

  bellBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await loadNotifications(true);
    openSheet();
    await fetch('/api/notifications/read', { method: 'POST' });
    bellDot.style.display = 'none';
    updateAppBadge(0);
  });

  loadNotifications(false);
  return () => loadNotifications(false);
};


window.updateAppBadge = function (count) {
  if (!('setAppBadge' in navigator)) return;
  if (count > 0) navigator.setAppBadge(count).catch(() => {});
  else if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
};

// Renders a notification list grouped into "Today" / "Earlier" —
// shared by both dashboards so the bell dropdown looks and behaves
// identically for clients and providers.
// iOS-style swipe-left-to-clear on a notification row. Deliberately
// requires clear horizontal intent and a real distance threshold, so a
// vertical scroll never deletes something by accident.
window.attachNotificationSwipe = function (container, onDeleted) {
  container.querySelectorAll('.notif-swipe-wrap').forEach(wrap => {
    const row = wrap.querySelector('.suggestion-row');
    const id = wrap.dataset.notifId;
    let startX = 0, startY = 0, dx = 0, tracking = false, decided = false, horizontal = false;

    row.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true; decided = false; horizontal = false;
      wrap.classList.add('swiping');
    }, { passive: true });

    row.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      // Decide once, early, whether this is a horizontal swipe or a
      // vertical scroll — flip-flopping mid-gesture feels broken.
      if (!decided && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        decided = true;
        horizontal = Math.abs(dx) > Math.abs(dy);
      }
      if (!horizontal) return;
      row.style.transform = `translateX(${Math.min(0, dx)}px)`; // left only
    }, { passive: true });

    function finish() {
      if (!tracking) return;
      tracking = false;
      wrap.classList.remove('swiping');
      if (horizontal && dx < -90) {
        row.style.transform = 'translateX(-100%)';
        wrap.style.height = wrap.offsetHeight + 'px';
        requestAnimationFrame(() => wrap.classList.add('removing'));
        fetch(`/api/notifications/${id}`, { method: 'DELETE' })
          .then(res => {
            if (!res.ok) throw new Error('delete failed');
            setTimeout(() => { wrap.remove(); if (onDeleted) onDeleted(); }, 260);
          })
          .catch(() => {
            // Roll back rather than leave it visually deleted while it
            // still exists on the server.
            wrap.classList.remove('removing');
            wrap.style.height = '';
            row.style.transform = '';
            showToast('Couldn\u2019t clear that notification.', 'error');
          });
      } else {
        row.style.transform = '';
      }
      dx = 0;
    }
    row.addEventListener('touchend', finish, { passive: true });
    row.addEventListener('touchcancel', finish, { passive: true });
  });
};

window.renderGroupedNotifications = function (notifications) {
  if (notifications.length === 0) {
    return `<div style="padding:1rem; text-align:center; color:var(--ink-soft); font-size:0.85rem;">No notifications yet.</div>`;
  }
  const today = new Date().toDateString();
  const todayItems = notifications.filter(n => new Date(n.created_at).toDateString() === today);
  const earlierItems = notifications.filter(n => new Date(n.created_at).toDateString() !== today);

  const renderRow = (n) => `
    <div class="notif-swipe-wrap" data-notif-id="${n.id}">
      <span class="swipe-delete-label">Clear</span>
      <div class="suggestion-row" style="align-items:flex-start;" data-link="${n.link || ''}">
        <div class="icon-chip" style="background:${n.read_at ? 'var(--surface)' : 'var(--primary-tint)'};">
          <svg viewBox="0 0 24 24" fill="none" stroke="${n.read_at ? 'var(--ink-soft)' : 'var(--primary)'}" stroke-width="2"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/></svg>
        </div>
        <div>
          <span style="display:block; font-weight:${n.read_at ? '500' : '700'};">${escapeHtml(n.body)}</span>
          <span style="font-size:0.72rem; color:var(--ink-soft); font-weight:400;">${relativeTime(n.created_at)}</span>
        </div>
      </div>
    </div>
  `;
  const sectionLabel = (text) => `<div style="padding:0.6rem 0.9rem 0.3rem; font-size:0.7rem; font-weight:700; color:var(--ink-soft); text-transform:uppercase; letter-spacing:0.03em;">${text}</div>`;

  let html = '';
  if (todayItems.length > 0) html += sectionLabel('Today') + todayItems.map(renderRow).join('');
  if (earlierItems.length > 0) html += sectionLabel('Earlier') + earlierItems.map(renderRow).join('');
  return html;
};


// --- PWA install prompt ---
(function () {
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
    return; // already installed/running as an app
  }
  if (localStorage.getItem('installPromptDismissed')) return;

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
    // Previously this took a single reading with enableHighAccuracy
    // off — a coarse wifi/cell-tower fix that could be hundreds of
    // metres out, which then fed straight into handyman distance
    // ranking. Routing through getAccurateLocation() reuses the same
    // high-accuracy multi-reading sampler used elsewhere in the app,
    // so matching distances are based on a real GPS-grade fix.
    getAccurateLocation()
      .then((pos) => onResult(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy))
      .catch(() => onResult(null, null, null));
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
  // A Retry button that calls nothing is worse than no button — the
  // user taps it, nothing happens, and they conclude the app is broken.
  // Only render it when there's a real retry to run.
  const retryButton = retryFnName
    ? `<div style="margin-top:0.75rem;"><button class="small-btn btn-outline" style="width:auto;" onclick="${retryFnName}">Retry</button></div>`
    : `<div style="margin-top:0.75rem;"><button class="small-btn btn-outline" style="width:auto;" onclick="window.location.reload()">Reload</button></div>`;

  // Only blame the connection when the device actually reports being
  // offline. Saying "check your connection" for a server-side error
  // sends people to restart their router over something they can't fix.
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const title = offline ? 'You\u2019re offline' : 'Couldn\u2019t load this';
  const detail = offline
    ? 'Reconnect to the internet and try again.'
    : 'Something went wrong on our side. Please try again.';

  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>
    <strong>${title}</strong>
    ${detail}
    ${retryButton}
  </div>`;
};

let _modalLastFocus = null;
let _modalKeyHandler = null;

window.CLIENT_REPORT_CATEGORIES = [
  ['identity_mismatch', 'Worker identity doesn\u2019t match profile'],
  ['suspected_scam', 'Suspected scam'],
  ['unsafe_behavior', 'Unsafe behavior'],
  ['harassment', 'Harassment'],
  ['threatening_behavior', 'Threatening behavior'],
  ['unauthorized_price_increase', 'Unauthorized price increase'],
  ['poor_workmanship', 'Poor workmanship'],
  ['property_damage', 'Property damage'],
  ['worker_did_not_arrive', 'Worker didn\u2019t arrive'],
  ['other', 'Other']
];
window.PROVIDER_REPORT_CATEGORIES = [
  ['customer_fraud', 'Customer fraud'],
  ['unsafe_location', 'Unsafe location'],
  ['harassment', 'Harassment'],
  ['non_payment', 'Non-payment'],
  ['fake_job', 'Fake job'],
  ['suspicious_behavior', 'Suspicious behavior'],
  ['other', 'Other']
];

window.openReportModal = function (reportedUserId, jobId, isProvider) {
  const existing = document.getElementById('sharedReportOverlay');
  if (existing) existing.remove();

  const categories = isProvider ? window.PROVIDER_REPORT_CATEGORIES : window.CLIENT_REPORT_CATEGORIES;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'sharedReportOverlay';
  overlay.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true">
      <h2>Report an issue</h2>
      <div class="error" id="reportModalError"></div>
      <label style="display:block; font-weight:700; font-size:0.85rem; margin-bottom:0.4rem;">What happened?</label>
      <select id="reportCategory" style="width:100%; padding:0.75rem; margin-bottom:1rem; border:1.5px solid var(--line); border-radius:var(--radius-sm); font-family:inherit;">
        ${categories.map(([val, label]) => `<option value="${val}">${label}</option>`).join('')}
      </select>
      <textarea id="reportDescription" rows="4" placeholder="Please describe what happened..."></textarea>
      <div class="modal-actions">
        <button type="button" class="btn-outline" id="cancelReport">Cancel</button>
        <button type="button" id="submitReport">Submit report</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  window.openModal(overlay);

  overlay.querySelector('#cancelReport').addEventListener('click', () => window.closeModal(overlay));
  overlay.querySelector('#submitReport').addEventListener('click', async () => {
    const errorEl = overlay.querySelector('#reportModalError');
    const description = overlay.querySelector('#reportDescription').value.trim();
    if (!description) {
      errorEl.textContent = 'Please describe what happened.';
      return;
    }
    const res = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reportedUserId,
        jobId: jobId || null,
        category: overlay.querySelector('#reportCategory').value,
        description
      })
    });
    const data = await res.json();
    if (!res.ok) { errorEl.textContent = data.error; return; }
    window.closeModal(overlay);
    overlay.remove();
    window.showToast('Report submitted. Our team will review it.', 'success');
  });
};

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

// --- Address autocomplete ---
// Attaches to any text input and turns it into a coordinate-backed
// address picker. GPS stays available as a shortcut, but typing is the
// dependable path — it works indoors, on weak signal and on low-end
// handsets, where GPS routinely doesn't.
//
// onSelect receives { label, latitude, longitude, fullAddress } so the
// caller can store exact coordinates alongside the display text.
window.attachAddressAutocomplete = function (inputId, onSelect) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const wrap = document.createElement('div');
  wrap.className = 'addr-ac-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const list = document.createElement('div');
  list.className = 'addr-ac-list';
  list.style.display = 'none';
  wrap.appendChild(list);

  let debounce, activeIndex = -1, results = [];

  function close() { list.style.display = 'none'; activeIndex = -1; }

  function render() {
    if (results.length === 0) { close(); return; }
    list.innerHTML = results.map((r, i) => `
      <button type="button" class="addr-ac-item${i === activeIndex ? ' active' : ''}" data-i="${i}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.5-7-11a7 7 0 1 1 14 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>
        <span><strong>${escapeHtml(r.label)}</strong><em>${escapeHtml(r.sublabel)}</em></span>
      </button>`).join('');
    list.style.display = 'block';
    list.querySelectorAll('.addr-ac-item').forEach(btn => {
      btn.addEventListener('click', () => choose(parseInt(btn.dataset.i, 10)));
    });
  }

  function choose(i) {
    const r = results[i];
    if (!r) return;
    input.value = r.label + (r.sublabel ? `, ${r.sublabel}` : '');
    close();
    if (onSelect) onSelect(r);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (q.length < 3) { close(); return; }
    // Debounced so a typed address doesn't fire a request per keystroke.
    debounce = setTimeout(async () => {
      try {
        const res = await fetch('/api/geocode/search?q=' + encodeURIComponent(q));
        if (!res.ok) { close(); return; }
        const data = await res.json();
        results = data.results || [];
        activeIndex = -1;
        render();
      } catch (err) { close(); }
    }, 350);
  });

  // Keyboard support — a dropdown that only works with a mouse isn't
  // usable for anyone navigating by keyboard.
  input.addEventListener('keydown', (e) => {
    if (list.style.display === 'none') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, results.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); render(); }
    else if (e.key === 'Enter' && activeIndex >= 0) { e.preventDefault(); choose(activeIndex); }
    else if (e.key === 'Escape') { close(); }
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) close();
  });
};

// Category-specific description prompts. A plumbing example shown to
// someone booking a realtor is worse than no example — it signals the
// app isn't paying attention, and it nudges people to describe the
// wrong things. Each prompt models the detail that actually helps a
// professional quote accurately for THAT trade.
window.CATEGORY_PROMPTS = {
  'Plumbing': {
    placeholder: 'e.g. The kitchen sink drains very slowly and water backs up. It started about a week ago.',
    hint: 'Mention where it is, when it started, and whether water is still running or leaking.'
  },
  'Electrical': {
    placeholder: 'e.g. Two sockets in the sitting room stopped working. The breaker trips when I plug in the fridge.',
    hint: 'Mention which rooms or appliances are affected, and whether the breaker trips.'
  },
  'Carpentry': {
    placeholder: 'e.g. A wardrobe door has come off its hinge and won\u2019t close properly.',
    hint: 'Mention the item, what\u2019s broken, and rough size or measurements if you know them.'
  },
  'Painting': {
    placeholder: 'e.g. Repaint two bedrooms, about 4m x 4m each. Walls are currently cream with some peeling.',
    hint: 'Mention how many rooms or walls, rough size, and the current condition.'
  },
  'Cleaning': {
    placeholder: 'e.g. Deep clean of a 3-bedroom house after moving out, including kitchen and bathrooms.',
    hint: 'Mention the property size, number of rooms, and whether it\u2019s a one-off or regular.'
  },
  'Moving': {
    placeholder: 'e.g. Moving a 2-bedroom apartment from Ntinda to Kira. Includes a fridge, bed and sofa. Second floor, no lift.',
    hint: 'Mention both locations, rough volume, and whether there are stairs or a lift.'
  },
  'Mechanical': {
    placeholder: 'e.g. Toyota Premio 2010 making a grinding noise when braking. Gets worse at low speed.',
    hint: 'Mention the make, model, year, and what the problem sounds or feels like.'
  },
  'Realtor': {
    placeholder: 'e.g. Looking for a 2-bedroom apartment to rent in Ntinda or Kiwatule, budget around UGX 800,000/month.',
    hint: 'Mention whether you\u2019re buying, selling or renting, the areas you want, and your budget.'
  },
  'Construction': {
    placeholder: 'e.g. Build a boundary wall about 30m long around a plot in Gayaza, including a metal gate.',
    hint: 'Mention the scope, rough dimensions, and whether you already have drawings or materials.'
  }
};

// Falls back to neutral wording rather than a plumbing example, so an
// unrecognised or newly-added category never shows a mismatched prompt.
window.promptForCategory = function (category) {
  return window.CATEGORY_PROMPTS[category] || {
    placeholder: 'e.g. Describe what needs doing, where it is, and when you noticed it.',
    hint: 'The more detail you give, the more accurate the estimate.'
  };
};

// --- Auth flash guard ---
// The CSS above hides authenticated content until this marks the page
// ready. Without it, 22 pages rendered their full UI before /api/me
// resolved — so you briefly saw the dashboard (or admin panel) before
// being bounced to login, and on a role mismatch the wrong side of the
// app flashed past first.
(function () {
  const reveal = () => document.documentElement.setAttribute('data-auth-ready', '1');

  // Pages with no session check must never stay hidden — reveal at once.
  const AUTH_FREE = /\/(login|signup|signup-customer|signup-worker|index|reset-password|terms|privacy|404)\.html$/;
  if (AUTH_FREE.test(window.location.pathname) || window.location.pathname === '/') {
    reveal();
    return;
  }

  // Reveal as soon as any /api/me call resolves — that's the moment the
  // page knows who the user is and whether it's about to redirect.
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const promise = originalFetch(input, init);
    if (url.includes('/api/me')) {
      // Reveal on the next frame so any redirect issued in the same tick
      // wins the race and the user never sees the page at all.
      promise.then(() => requestAnimationFrame(reveal)).catch(reveal);
    }
    return promise;
  };

  // Safety net: if a page never calls /api/me, or the request hangs,
  // showing the content is far better than an app that appears blank.
  setTimeout(reveal, 3000);
  // Never leave it hidden if scripts fail outright.
  window.addEventListener('error', reveal);
})();
