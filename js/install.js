// Installable app: registers the service worker and shows the right "install" help for the phone.
// Android / desktop Chrome & Edge: the browser offers an install prompt -> show an Install button.
// iPhone / iPad (Safari has no prompt): show "Share -> Add to Home Screen" instructions once.

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

(() => {
  const installBtn = document.getElementById('installBtn');
  const iosHint = document.getElementById('iosInstallHint');
  if (!installBtn && !iosHint) return; // page without install UI (e.g. admin)

  const HINT_KEY = 'tuktuk_ios_hint_closed';
  const isInstalled = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (isInstalled) return; // already opened from the home screen

  // Android / Chrome / Edge
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // show our own button instead of the browser's mini bar
    installPrompt = e;
    installBtn.classList.remove('hidden');
  });
  installBtn.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    installBtn.classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => installBtn.classList.add('hidden'));

  // iPhone / iPad (iPadOS reports itself as a Mac with a touch screen)
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let hintClosed = false;
  try { hintClosed = localStorage.getItem(HINT_KEY) === '1'; } catch (e) { /* storage blocked */ }

  if (isIos && !hintClosed) {
    iosHint.classList.remove('hidden');
    document.getElementById('iosHintClose').addEventListener('click', () => {
      iosHint.classList.add('hidden');
      try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* storage blocked */ }
    });
  }
})();
