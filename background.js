// Omni Messenger Lord V4 - Background Service Worker (MV3)
// Local diagnostics only: no remote fetches, no webhooks, no token/session reads.

const EXT = globalThis.browser ?? globalThis.chrome;

const state = {
  installedAt: Date.now(),
  lastHeartbeat: 0,
  hookActiveTabs: new Set()
};

function reply(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (_) {}
}

// Installation log
EXT.runtime.onInstalled.addListener((details) => {
  console.log('[Omni Messenger Lord V4] installed / updated:', details.reason);
});

// Message listener (works with service worker)
EXT.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'MICMAX_HEARTBEAT') {
    state.lastHeartbeat = Date.now();
    if (sender?.tab?.id != null) {
      state.hookActiveTabs.add(sender.tab.id);
    }
    reply(sendResponse, { ok: true });
    return false; // synchronous response
  }

  if (message.type === 'MICMAX_STATUS_REQUEST') {
    reply(sendResponse, {
      ok: true,
      installedAt: state.installedAt,
      lastHeartbeat: state.lastHeartbeat,
      activeTabs: [...state.hookActiveTabs]
    });
    return false;
  }

  if (message.type === 'MICMAX_RESET_STATUS') {
    state.hookActiveTabs.clear();
    state.lastHeartbeat = 0;
    reply(sendResponse, { ok: true });
    return false;
  }

  return false;
});

// Optional: Clean up inactive tabs periodically (good for service worker)
setInterval(() => {
  // Service workers can be terminated, so this helps keep state light
}, 300000); // every 5 minutes
