// src/renderer/renderer.js
// Wizard state machine. Drives which panel is visible, wires up the
// Back/Next buttons, validates each step, and calls the preload-exposed
// APIs for actual system work.

(() => {
  const STEPS = ['welcome', 'license', 'system', 'config', 'install', 'finish'];
  let currentIndex = 0;
  let nodeCheckResult = null;
  let installSucceeded = false;

  // ---------- Element refs ----------
  const $step = (name) => document.querySelector(`.step[data-step="${name}"]`);
  const $panel = (name) => document.querySelector(`.panel[data-panel="${name}"]`);
  const $ = (sel) => document.querySelector(sel);

  const btnBack   = $('#btn-back');
  const btnNext   = $('#btn-next');
  const btnCancel = $('#btn-cancel');

  // ---------- Navigation ----------
  function renderStep() {
    const name = STEPS[currentIndex];

    // Sidebar step states
    STEPS.forEach((s, i) => {
      const el = $step(s);
      el.classList.toggle('is-active', i === currentIndex);
      el.classList.toggle('is-done', i < currentIndex);
    });

    // Panel visibility
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('is-active'));
    $panel(name).classList.add('is-active');

    // Back button
    btnBack.disabled = currentIndex === 0 || name === 'install' || name === 'finish';

    // Next button label + enabled state per step
    updateNextButton();

    // Step-specific hooks
    if (name === 'system')  onEnterSystem();
    if (name === 'install') onEnterInstall();
    if (name === 'finish')  onEnterFinish();
  }

  function updateNextButton() {
    const name = STEPS[currentIndex];
    if (name === 'finish') {
      btnNext.textContent = 'Close';
      btnNext.disabled = false;
      return;
    }
    if (name === 'install') {
      btnNext.textContent = 'Next';
      btnNext.disabled = !installSucceeded;
      return;
    }
    btnNext.textContent = 'Next';

    if (name === 'license') {
      btnNext.disabled = !$('#accept-license').checked;
    } else if (name === 'system') {
      btnNext.disabled = !(nodeCheckResult && nodeCheckResult.meetsRequirement);
    } else if (name === 'config') {
      // API key is optional (can be set during onboard); always allow Next.
      btnNext.disabled = false;
    } else {
      btnNext.disabled = false;
    }
  }

  function goNext() {
    const name = STEPS[currentIndex];
    if (name === 'finish') { window.close(); return; }
    if (currentIndex < STEPS.length - 1) {
      currentIndex += 1;
      renderStep();
    }
  }

  function goBack() {
    if (currentIndex > 0) {
      currentIndex -= 1;
      renderStep();
    }
  }

  btnBack.addEventListener('click', goBack);
  btnNext.addEventListener('click', goNext);
  btnCancel.addEventListener('click', () => {
    if (confirm('Cancel installation?')) window.close();
  });

  // ---------- License step ----------
  $('#accept-license').addEventListener('change', updateNextButton);

  // ---------- System check step ----------
  async function onEnterSystem() {
    const iconEl    = $('#check-node .check-row__icon');
    const subEl     = $('#node-status');
    const actionsEl = $('#node-actions');

    iconEl.setAttribute('data-status', 'pending');
    iconEl.innerHTML = '<svg class="spinner" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>';
    subEl.textContent = 'Checking…';
    actionsEl.innerHTML = '';

    const result = await window.openclaw.checkNode();
    nodeCheckResult = result;

    if (result.installed && result.meetsRequirement) {
      iconEl.setAttribute('data-status', 'ok');
      iconEl.innerHTML = '';
      subEl.textContent = `Found ${result.version}. Good to go.`;
    } else if (result.installed && !result.meetsRequirement) {
      iconEl.setAttribute('data-status', 'error');
      iconEl.innerHTML = '';
      subEl.textContent = `Found ${result.version} — need v${result.minRequired}+.`;
      actionsEl.appendChild(makeInstallNodeButton());
      actionsEl.appendChild(makeRecheckButton());
    } else {
      iconEl.setAttribute('data-status', 'error');
      iconEl.innerHTML = '';
      subEl.textContent = `Not installed. Node.js ${result.minRequired}+ required.`;
      actionsEl.appendChild(makeInstallNodeButton());
      actionsEl.appendChild(makeRecheckButton());
    }
    updateNextButton();
  }

  function makeInstallNodeButton() {
    const b = document.createElement('button');
    b.className = 'btn btn--primary btn--sm';
    b.textContent = 'Install Node.js';
    b.onclick = () => window.openclaw.openExternal('https://nodejs.org/');
    return b;
  }
  function makeRecheckButton() {
    const b = document.createElement('button');
    b.className = 'btn btn--ghost btn--sm';
    b.textContent = 'Re-check';
    b.onclick = onEnterSystem;
    return b;
  }

  // ---------- Install step ----------
  async function onEnterInstall() {
    const bar       = $('#progress-bar');
    const logEl     = $('#log-output');
    const statusEl  = $('#install-status');

    logEl.textContent = '';
    bar.classList.add('is-indeterminate');
    bar.style.width = '30%';

    // Subscribe to streamed log lines from the main process
    const unsubscribe = window.openclaw.onLog((line) => {
      logEl.textContent += line + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    });

    // 1. Save pre-config (provider + API key)
    const provider = document.querySelector('input[name="provider"]:checked').value;
    const apiKey = $('#api-key').value.trim();
    if (apiKey) {
      const saveResult = await window.openclaw.saveConfig({ provider, apiKey });
      if (saveResult.ok) {
        logEl.textContent += `✓ Saved pre-config to ${saveResult.path}\n\n`;
      } else {
        logEl.textContent += `[warn] Could not save pre-config: ${saveResult.error}\n\n`;
      }
    }

    // 2. npm install -g openclaw@latest
    const result = await window.openclaw.installOpenClaw();

    unsubscribe();
    bar.classList.remove('is-indeterminate');

    if (result.ok) {
      bar.style.width = '100%';
      statusEl.innerHTML = 'Done. Click <em>Next</em> to finish up.';
      installSucceeded = true;
    } else {
      bar.style.width = '0%';
      statusEl.innerHTML = `<span style="color:var(--coral)">Install failed: ${result.error}</span>`;
      installSucceeded = false;
    }
    updateNextButton();
  }

  // ---------- Finish step ----------
  function onEnterFinish() {
    $('#btn-onboard').onclick = async () => {
      const r = await window.openclaw.launchOnboard();
      if (!r.ok) alert(`Could not launch terminal: ${r.error}`);
    };
    $('#btn-dashboard').onclick = async () => {
      const r = await window.openclaw.launchDashboard();
      if (!r.ok) alert(`Could not launch dashboard: ${r.error}\n\nFinish onboarding first, then try again.`);
    };

    // External links (e.g. docs)
    document.querySelectorAll('[data-external]').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        window.openclaw.openExternal(a.getAttribute('data-external'));
      };
    });
  }

  // ---------- Boot ----------
  (async function boot() {
    const info = await window.openclaw.getPlatform();
    const label = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[info.platform] || info.platform;
    $('#platform-label').textContent = `${label} · ${info.arch}`;
    renderStep();
  })();
})();
