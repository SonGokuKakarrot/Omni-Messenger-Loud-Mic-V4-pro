 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/content/service.js b/content/service.js
index daff1faf5d394d9791a8ca30ad614124f345eda3..5664b0357ccb96751045f474842771b909946627 100644
--- a/content/service.js
+++ b/content/service.js
@@ -1,87 +1,95 @@
 (() => {
   const EXT = globalThis.browser ?? globalThis.chrome;
   if (!EXT?.runtime || !EXT?.storage?.local) return;
 
   const HAS_PROMISE_API = typeof globalThis.browser !== 'undefined' && EXT === globalThis.browser;
   const DEFAULTS = {
+    profileVersion: 7,
     enabled: true,
-    gainDb: 84,
+    gainDb: 106.0206,
     thresholdDb: -60,
     knee: 40,
     ratio: 20,
     attack: 0.0001,
     release: 0.03,
     lowShelfDb: 14,
-    presenceDb: 20,
-    highShelfDb: 16,
+    presenceDb: 24,
+    highShelfDb: 18,
     limiterDb: -0.1,
-    drive: 1.8,
-    loudness: 20.0,
-    maxBoost: 5000,
+    drive: 1.5,
+    loudness: 1.0,
+    maxBoost: 200000,
     sustain: true,
-    sustainTargetDb: -2,
-    sustainMaxGain: 64,
-    forceRawMic: true
+    sustainTargetDb: 5,
+    sustainMaxGain: 120,
+    forceRawMic: true,
+    reverbEnabled: true,
+    reverbDelay: 0.045,
+    reverbFeedback: 0.35,
+    reverbWet: 0.18,
+    keepAlive: true,
+    keepAliveGain: 0.0012,
+    senderRefreshMs: 250
   };
   const MSG_CFG = 'MIC_MAXIMIZER_CONFIG';
   let hookReady = false;
 
   function storageGet(key) {
     if (HAS_PROMISE_API) return EXT.storage.local.get(key);
     return new Promise((resolve) => {
       try {
         EXT.storage.local.get(key, (res) => {
           if (EXT.runtime?.lastError) resolve({});
           else resolve(res || {});
         });
       } catch (_) {
         resolve({});
       }
     });
   }
 
   function sendMessage(message) {
     if (HAS_PROMISE_API) return EXT.runtime.sendMessage(message);
     return new Promise((resolve) => {
       try {
         EXT.runtime.sendMessage(message, () => resolve(!EXT.runtime?.lastError));
       } catch (_) {
         resolve(false);
       }
     });
   }
 
   function pushConfig(config) {
     window.postMessage({ type: MSG_CFG, payload: config }, '*');
   }
 
   async function loadConfig() {
     try {
       const res = await storageGet('micMaximizerConfig');
       const stored = res.micMaximizerConfig || {};
-      if (stored.forceRawMic === undefined) return { ...DEFAULTS };
+      if (stored.profileVersion !== DEFAULTS.profileVersion) return { ...DEFAULTS };
       return { ...DEFAULTS, ...stored };
     } catch (_) {
       return { ...DEFAULTS };
     }
   }
 
   async function sync() {
     pushConfig(await loadConfig());
   }
 
   function heartbeat() {
     if (!hookReady) return;
     sendMessage({ type: 'MICMAX_HEARTBEAT' }).catch(() => {});
   }
 
   window.addEventListener('message', (event) => {
     if (event.source === window && event.data?.type === 'MIC_MAXIMIZER_READY') {
       hookReady = true;
       sync();
       heartbeat();
     }
   });
 
   EXT.storage.onChanged.addListener((changes, area) => {
     if (area === 'local' && changes.micMaximizerConfig) {
 
EOF
)
