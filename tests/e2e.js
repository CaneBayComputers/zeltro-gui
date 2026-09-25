#!/usr/bin/env node
//
// End-to-end checks for the Zeltro GUI.
//
// Deliberately READ-ONLY: nothing here creates, installs, clones or removes a
// project, and nothing stops the shared services. Every assertion is either a
// pure UI check or an inspection of state the app already read. A real
// `zeltro install` run is tested separately on a throwaway box, not here.
//
// Run with:  npm run test:e2e

const { launchApp, screenshot, loadedPage, t } = require('./helpers');

let passed = 0;
let failed = 0;
const failures = [];

// Strip full-line comments before grepping source for a banned construct.
//
// Needed twice already, both times the same way round: a comment explaining WHY
// something is avoided matches the pattern that looks for it, and the assertion
// fails on its own rationale. A test that fails on its own explanation is a test
// someone deletes.
//
// Full-line only. Stripping trailing comments means deciding whether a `#` or
// `//` sits inside a string, and getting that wrong would silently stop matching
// real code — a far worse failure than a false positive.
function withoutComments(source, lineComment = '//') {
  // HTML comments are blocks, not lines, and are stripped wholesale. Needed
  // because a comment EXPLAINING an attribute counts as an occurrence of it —
  // which broke an assertion about how many alt="" attributes the splash robot
  // has, the third time in this codebase that a comment has failed a check
  // written about the code it describes.
  if (lineComment === '<!--') return source.replace(/<!--[\s\S]*?-->/g, '');

  const re = lineComment === '#' ? /^\s*#/ : /^\s*\/\//;
  return source.split('\n').filter((l) => !re.test(l)).join('\n');
}

// Run one section instead of all of them: `npm test -- --only=ssh`.
//
// The suite is 300-odd assertions and most of a run re-verifies ground that has
// not moved. Matching on the section banner keeps a focused run honest — it
// skips whole sections rather than individual checks, so what does run is still
// a complete section.
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toLowerCase();
let currentSection = '';
let sectionSkipped = false;

function section(name) {
  currentSection = name;
  sectionSkipped = Boolean(ONLY) && !name.toLowerCase().includes(ONLY);
  console.log(sectionSkipped ? `\n${name} (skipped)` : `\n${name}`);
  return !sectionSkipped;
}

// Choosing a framework is two dropdowns now: its runtime, then the framework.
// The lookup lives here so no test has to know which runtime a slug belongs to.
async function selectFramework(win, catalog, slug) {
  const runtime = catalog.frameworks.find((f) => f.slug === slug)?.runtime;
  if (runtime) {
    await win.selectOption('[data-testid="framework-runtime"]', runtime);
    await win.waitForTimeout(150);
  }
  await win.selectOption('[data-testid="framework-choice"]', slug);
}

function check(name, condition, detail = '') {
  if (sectionSkipped) return;
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function run() {
  console.log('\nZeltro GUI — end-to-end\n');

  const { app, win } = await launchApp();

  try {
    // --- Launch ---------------------------------------------------------
    console.log('launch');
    const page = await loadedPage(win);
    check(
      'main window loads index.html, not the installer',
      page === 'index',
      page === 'installer'
        ? 'loaded installer.html — Zeltro reports not-installed/not-configured'
        : ''
    );

    // Reach into the MAIN process and drive the CLI through the same IPC the
    // dashboard uses. `require` is not in scope inside app.evaluate(), but the
    // electron module is injected and ipcMain exposes its invoke handlers — so
    // the real handler runs, not a reimplementation of it.
    const statusCall = await app.evaluate(async ({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers.get('execute-zeltro');
      if (!handler) return { error: 'execute-zeltro not registered' };
      return handler({}, 'status', ['--all', '--json-output']);
    });
    check('execute-zeltro IPC runs the CLI successfully', statusCall.code === 0,
      statusCall.error || `exit ${statusCall.code}: ${(statusCall.stderr || '').slice(0, 120)}`);

    let statusJson = null;
    try {
      statusJson = JSON.parse(statusCall.stdout || '');
    } catch (error) {
      // leave null — asserted below
    }
    check('zeltro status returns parseable JSON with shared_services',
      statusJson !== null && typeof statusJson.shared_services === 'object',
      statusJson === null ? 'stdout did not parse as JSON' : '');

    // --- Dashboard ------------------------------------------------------
    console.log('\ndashboard');

    // Wait out the "Loading Zeltro" splash before asserting or screenshotting,
    // otherwise every check races the initial render.
    //
    // Do NOT test offsetParent here: .initial-loading is position:fixed, and
    // fixed elements always report offsetParent === null, so that check passes
    // instantly and the screenshot catches a full-screen splash. The app hides
    // it by adding .hide (opacity+visibility transition) then setting
    // display:none 500ms later — visibility is the honest signal.
    await win.waitForFunction(
      () => {
        const splash = document.getElementById('initial-loading');
        if (!splash) return true;
        const style = getComputedStyle(splash);
        return style.display === 'none' || style.visibility === 'hidden';
      },
      null,
      { timeout: 20000 }
    );

    // Real project cards replace the hardcoded placeholder. Asserting on any
    // .project-card would pass on that static placeholder and prove nothing, so
    // require cards that are NOT the placeholder.
    // How many projects SHOULD render is an environment fact, not a constant —
    // a freshly configured machine legitimately has none. Take the expected
    // count from the CLI and assert against that, so the suite is correct on a
    // clean box as well as a populated one.
    const expectedProjects = (statusJson?.projects || []).length;

    // Tile filters persist to localStorage, and the suite runs against the real
    // user data dir — so a filter left on by hand makes "renders every project"
    // fail for a reason that is not a regression. Start from a known state.
    // (The filters get their own assertions further down.)
    await win.evaluate(() => window.resetFilters && window.resetFilters());

    if (expectedProjects > 0) {
      await win.waitForFunction(
        () => document.querySelectorAll('#projects-grid .project-card:not(.placeholder)').length > 0,
        null,
        { timeout: 15000 }
      ).catch(() => {});
    }

    // The splash fades over 0.5s; let it finish so the capture is the dashboard.
    await win.waitForTimeout(600);
    await screenshot(win, '01-dashboard');
    for (const id of ['create-ai', 'start-all', 'stop-all', 'new-project', 'clone-project']) {
      check(`header action "${id}" present`, await win.locator(t(id)).count() === 1);
    }
    // Install App folded into New Project's first step; a stray button here
    // would mean two entry points into the same flow again.
    check('install app is no longer a separate header action',
      await win.locator(t('install-app')).count() === 0);

    // Help/Patreon/Donate moved out of the header into the footer, alongside a
    // link to the CLI the GUI is a front end for.
    // Help is gone, GitHub now points at the GUI repo, and Settings/Donate
    // moved into the top nav. The footer carries GitHub plus the licence line.
    for (const id of ['github-gui']) {
      check(`footer link "${id}" present`, await win.locator(`.app-footer ${t(id)}`).count() === 1);
    }
    for (const id of ['settings-open', 'donate']) {
      check(`nav button "${id}" present`, await win.locator(`.header-actions ${t(id)}`).count() === 1);
    }
    check('header no longer carries the secondary links',
      await win.locator(`.header-actions ${t('help-modal-open')}`).count() === 0);
    // The window is Zeltro. "Zeltro CLI" is the other program — naming this one
    // after it was a leftover from when the GUI was a thin front end for it.
    check('the header names the app, not the CLI',
      (await win.textContent('h1')).trim() === 'Zeltro')
    check('projects grid rendered', await win.locator(t('projects-grid')).count() === 1);
    check('services grid rendered', await win.locator(t('services-grid')).count() === 1);

    // `zeltro status --all` drives this. Without --all it only returns RUNNING
    // projects, so a stopped-everything machine rendered an empty dashboard —
    // that regression is exactly what this guards.
    const realCards = await win.locator('#projects-grid .project-card:not(.placeholder)').count();

    if (expectedProjects === 0) {
      // Clean machine: the empty-state placeholder is the correct render.
      const placeholder = await win.locator('#projects-grid .project-card.placeholder').count();
      check('empty machine shows the create-first-project placeholder', placeholder === 1,
        `${placeholder} placeholders, ${realCards} project cards`);
    } else {
      // Disabled projects are deliberately hidden from the default view, so the
      // expected count is the projects that are NOT parked — asking for all of
      // them would fail on a machine where anything has been disabled.
      // The grid unions every configured host, so comparing it against the
      // LOCAL status alone under-counts by whatever the remote hosts contribute.
      // Ask each host what it has and sum, rather than assuming one.
      const perHost = await app.evaluate(async ({ ipcMain }) => {
        const hosts = ['local', ...(await ipcMain._invokeHandlers.get('get-ssh-profiles')({}))
          .filter((p) => p.host).map((p) => p.id)];
        let total = 0;
        const detail = {};
        for (const h of hosts) {
          const r = await ipcMain._invokeHandlers.get('execute-zeltro-on')({}, h, 'status',
            ['--all', '--json-output']);
          if (r.code !== 0) { detail[h] = 'unreachable'; continue; }
          try {
            const ps = JSON.parse(r.stdout).projects || [];
            // Parked projects are hidden by design, so they are not expected.
            const visible = ps.filter((x) => (x.metadata || {}).status !== 'disabled').length;
            detail[h] = visible;
            total += visible;
          } catch { detail[h] = 'unparseable'; }
        }
        return { total, detail };
      });
      check('dashboard renders every non-disabled project across every host',
        realCards === perHost.total,
        `rendered ${realCards}, hosts reported ${perHost.total} — ${JSON.stringify(perHost.detail)}`);
    }

    // Display metadata is GUI-owned (read from each project's compose file),
    // since zeltro status does not return name/description/emoji.
    //
    // This asserts the metadata actually REACHES the DOM. An earlier version
    // only counted .project-icon elements, which every card has regardless —
    // it passed while a race silently wiped the metadata before render.
    // Metadata comes from the status JSON now, the same call the GUI parses.
    // Skip parked projects: they are deliberately absent from the grid, so
    // looking for their metadata there would assert against a view that is
    // correctly hiding them.
    const metaCheck = await app.evaluate(async ({ ipcMain }) => {
      const status = await ipcMain._invokeHandlers.get('execute-zeltro')(
        {}, 'status', ['--all', '--json-output']
      );
      for (const p of JSON.parse(status.stdout || '{}').projects || []) {
        const m = p.metadata || {};
        if (m.display_name && m.status !== 'disabled') return { name: p.name, ...m };
      }
      return null;
    });

    if (metaCheck) {
      const cardText = await win.locator('#projects-grid').innerText();
      check(`rendered metadata for a project that has it (${metaCheck.name})`,
        cardText.includes(metaCheck.display_name),
        `expected display name "${metaCheck.display_name}" in the grid`);
      if (metaCheck.emoji) {
        check('rendered its metadata emoji', cardText.includes(metaCheck.emoji), metaCheck.emoji);
      }
    } else {
      console.log('  – no project on this machine carries x-metadata; skipping render check');
    }

    // Any project the CLI reports as docker_running must render as running —
    // with a Stop button and its URL. An earlier version also required
    // port_mapped, which marked healthy `zeltro install` projects (nginx front,
    // no published host port — reachable only by hostname) as stopped.
    const running = (statusJson?.projects || []).filter((p) => p.docker_running);
    if (running.length > 0) {
      // Pass which projects the CLI says have a URL. A running container can
      // still have a broken hosts entry — the CLI then reports local_url: null
      // and ping_status: failed, and the GUI has nothing to show. Requiring a
      // URL for every running project asserted something the CLI does not
      // promise, and failed on three projects whose host entries are broken.
      const withUrl = running.filter((p) => p.local_url).map((p) => p.name);
      const wrong = await win.evaluate(({ names, withUrl }) => {
        const bad = [];
        for (const name of names) {
          const card = [...document.querySelectorAll('#projects-grid .project-card')]
            .find((c) => c.querySelector('h3')?.textContent?.trim() === name
                      || c.innerText.includes(name));
          if (!card) { bad.push(`${name}: no card`); continue; }
          const buttons = [...card.querySelectorAll('button')].map((b) => b.textContent.trim());
          if (!buttons.includes('Stop')) bad.push(`${name}: offers "${buttons[0]}" not "Stop"`);
          if (!buttons.some((b) => /Modify with AI/.test(b))) bad.push(`${name}: no "Modify with AI"`);
          if (!buttons.includes('Trash')) bad.push(`${name}: destructive button is not labelled "Trash"`);
          if (withUrl.includes(name) && !card.querySelector('.url-link')) {
            bad.push(`${name}: CLI reports a URL but the tile shows none`);
          }
        }
        return bad;
      }, { names: running.map((p) => p.name), withUrl });

      check(`running projects render as running (${running.length} checked)`,
        wrong.length === 0, wrong.join('; '));
    }

    // A project with an EMPTY metadata object is the normal case for anything
    // predating x-metadata, and it cannot occur on this machine — all 14
    // projects here have a block. Seen for real on the Arch EC2 box, whose one
    // project returns `"metadata": {}`, so it is worth pinning rather than
    // assuming the `||` defaults hold.
    const emptyMeta = await win.evaluate(() => {
      const before = window.__allProjects().length;
      const synthetic = JSON.stringify({
        shared_services: {},
        projects: [
          { name: 'no-meta', docker_running: false, metadata: {} },
          { name: 'absent-meta', docker_running: false }
        ]
      });
      const parsed = window.__parseStatus(synthetic);
      const out = parsed.map((p) => ({
        name: p.name,
        emoji: p.emoji,
        display_name: p.display_name,
        last_on: p.last_on,
        disabled: window.isDisabled(p)
      }));
      return { out, before };
    });
    check('a project with empty metadata gets the default emoji, not undefined',
      emptyMeta.out.every((p) => p.emoji === '🚀'), JSON.stringify(emptyMeta.out));
    check('an empty metadata block falls back to the project name for display',
      emptyMeta.out.every((p) => p.display_name === p.name), JSON.stringify(emptyMeta.out));
    check('a project with no status metadata is NOT treated as disabled',
      emptyMeta.out.every((p) => p.disabled === false), JSON.stringify(emptyMeta.out));
    // Compare only the metadata-derived fields. display_name legitimately
    // differs because it falls back to the project name, and the two projects
    // have different names — comparing it made the assertion fail on the one
    // thing that is supposed to differ.
    const metaDerived = (p) => JSON.stringify({ emoji: p.emoji, last_on: p.last_on, disabled: p.disabled });
    check('a missing metadata key behaves the same as an empty one',
      metaDerived(emptyMeta.out[0]) === metaDerived(emptyMeta.out[1]),
      JSON.stringify(emptyMeta.out));

    // Restore the real project list; the synthetic parse replaced it.
    await win.evaluate(() => window.loadProjects());
    await win.waitForTimeout(3000);

    // The host badge must not sit under the status dot, which is absolutely
    // positioned in the card's top-right corner. Measured rather than eyeballed
    // — margin-left:auto put them on top of each other.
    const badgeOverlap = await win.evaluate(() => {
      const card = document.querySelector('#projects-grid .project-card:not(.placeholder)');
      const badge = card?.querySelector('.host-badge');
      const dot = card?.querySelector('.project-status-dot');
      if (!badge || !dot) return { skipped: true };
      const b = badge.getBoundingClientRect(), d = dot.getBoundingClientRect();
      return {
        skipped: false,
        overlaps: !(b.right <= d.left || b.left >= d.right || b.bottom <= d.top || b.top >= d.bottom)
      };
    });
    if (!badgeOverlap.skipped) {
      check('the host badge does not sit under the status dot', !badgeOverlap.overlaps);
    }

    // --- Dashboard union --------------------------------------------------
    //
    // The bug this pins: loadServices used to call the full status parser,
    // which rebuilds the project list. On a multi-host dashboard that wiped the
    // union and refilled it from the local host alone, so whichever of
    // loadProjects and loadServices finished last decided what the grid showed.
    // Same shape as the metadata-cache race removed earlier — two loaders
    // owning one piece of state.
    const rendererSource = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
    const servicesLoader = rendererSource.slice(
      rendererSource.indexOf('async function loadServices'),
      rendererSource.indexOf('async function loadServices') + 1400);
    check('loadServices does not rebuild the project list',
      !/parseProjectStatusJSON/.test(servicesLoader),
      'loadServices must own shared services only');

    // Every project carries the host it lives on, so an action can be aimed at
    // the right machine and two same-named projects stay distinct.
    const hostTagged = await win.evaluate(() =>
      window.__allProjects().every((p) => typeof p.hostId === 'string' && p.hostId.length > 0));
    check('every project is tagged with the host it lives on', hostTagged);

    // Identity is (host, name). Two hosts can each have a drupal-test.
    check('project identity is host-scoped, not name-only',
      /function projectKey/.test(rendererSource) && /\$\{hostId\}:\$\{name\}/.test(rendererSource));

    // A host that fails its poll must be visible. Contributing no tiles is
    // indistinguishable from a host that simply has no projects.
    const loaderBlock = rendererSource.slice(rendererSource.indexOf('async function loadProjects'),
                                             rendererSource.indexOf('async function loadProjects') + 2200);
    check('a host that does not answer is recorded rather than dropped',
      /hostErrors\[host\.id\]/.test(loaderBlock));
    check('hosts are polled in parallel, not one after another',
      /Promise\.all\(dashboardHosts\.map/.test(loaderBlock));

    // A project's up/down must come from docker_running, not from ping.
    //
    // ping_status is diagnostic. On macOS, Docker Desktop keeps containers in a
    // VM so their IPs are permanently unreachable from the host, and the CLI
    // reports `not_applicable` there. Treating anything but ok/skipped as
    // "starting" made every healthy Mac project render as a red not-running
    // tile. An allowlist of known-good values would break on the next one, so
    // the rule is: docker_running decides, and unknown means running.
    const statusRules = await win.evaluate(() => {
      const mk = (extra) => JSON.stringify({ shared_services: {},
        projects: [{ name: 'p', docker_running: true, external_port: '1', ...extra }] });
      const out = {};
      for (const [label, extra] of [
        ['ping not_applicable', { ping_status: 'not_applicable', http_status: 'ok' }],
        ['ping failed but http ok', { ping_status: 'failed', http_status: 'ok' }],
        ['ping absent entirely', {}],
        ['some future ping value', { ping_status: 'quantum' }],
        ['http failed', { http_status: 'failed' }]
      ]) {
        out[label] = window.__parseStatus(mk(extra))[0].status;
      }
      out['docker down'] = window.__parseStatus(JSON.stringify({ shared_services: {},
        projects: [{ name: 'p', docker_running: false }] }))[0].status;
      return out;
    });
    check('a healthy project is running whatever ping says',
      ['ping not_applicable', 'ping failed but http ok', 'ping absent entirely',
       'some future ping value'].every((k) => statusRules[k] === 'running'),
      JSON.stringify(statusRules));
    check('a container that is up but not serving reads as starting',
      statusRules['http failed'] === 'starting', JSON.stringify(statusRules));
    check('a container that is down reads as stopped',
      statusRules['docker down'] === 'stopped', JSON.stringify(statusRules));

    await win.evaluate(() => window.loadProjects());
    await win.waitForTimeout(2000);

    // Tests must not read or write the machine's real configuration. They used
    // to, which is how a crashed run left test hosts behind and a save racing a
    // load replaced a real setup with nothing.
    const userDataInUse = await app.evaluate(async ({ app: a }) => a.getPath('userData'));
    check('the suite runs against a scratch user-data directory',
      userDataInUse === require('./helpers').testUserDataDir(),
      `using ${userDataInUse}`);

    // --- GitHub -----------------------------------------------------------
    //
    // `zeltro new --github` creates the repository from the machine running the
    // project, so gh has to be authenticated THERE, not here.
    const ghLocal = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('get-github-status')({}, 'local'));
    check('github status reports installed and signed-in separately',
      typeof ghLocal.installed === 'boolean' && typeof ghLocal.loggedIn === 'boolean'
      && !(ghLocal.loggedIn && !ghLocal.installed),
      JSON.stringify(ghLocal).slice(0, 120));

    // A host that does not exist must not be reported as a working local gh.
    const ghGhost = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('get-github-status')({}, 'no-such-host'));
    check('an unknown host does not fall back to the local gh',
      ghGhost.installed === false && ghGhost.loggedIn === false,
      JSON.stringify(ghGhost));

    // Rejected here rather than sent somewhere and refused with an opaque error.
    const ghBad = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('github-login')({}, 'local', 'not-a-token'));
    check('a token that is not a token is refused before it is sent',
      !ghBad.ok && /token/i.test(ghBad.detail), ghBad.detail.slice(0, 80));

    // Parsed from JSON, not from the human output — which is a formatted block
    // with ticks, goes to stderr, and changes between gh releases.
    const ghSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/main.ts'), 'utf8');
    check('gh auth status is read as JSON, not scraped',
      /gh auth status --json hosts/.test(ghSrc));
    // --with-token is the only non-interactive route: the browser flow needs a
    // terminal to print a code in and a browser on the machine running it.
    check('sign-in uses the non-interactive token route',
      /gh auth login --with-token/.test(ghSrc) && !/auth login --web/.test(ghSrc));

    // --- Dictation --------------------------------------------------------
    //
    // decodeAudioData CRASHES this Electron's renderer — not throws, crashes, so
    // nothing can catch it. Reproduced on a synthetic in-memory WAV with no file
    // access, in a normal desktop session as well as headless. The capture path
    // must therefore never call it: it taps raw samples off the stream instead.
    const rendererDict = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
    check('dictation never calls decodeAudioData',
      !/decodeAudioData/.test(rendererDict.replace(/\/\/[^\n]*/g, '')),
      'the renderer crashes on it; capture raw PCM instead');

    // Status is an explicit state, not inferred from whether the pipeline
    // object exists. Inferring it meant anything re-rendering mid-download —
    // switching settings tabs, for one — replaced the progress with a bare
    // "Preparing…" that then never changed, and read as stuck.
    const dictStates = await win.evaluate(() => {
      const seen = [];
      for (const st of ['off', 'downloading', 'starting', 'ready', 'error']) {
        window.__setDictationState?.(st);
        seen.push(document.getElementById('dictation-status')?.innerHTML || '');
      }
      return seen;
    });
    check('every dictation state renders something distinct',
      new Set(dictStates).size === dictStates.length,
      `${new Set(dictStates).size} distinct of ${dictStates.length}`);
    check('no dictation state renders a dead-end "Preparing"',
      !dictStates.some((h) => /Preparing/.test(h)));

    // The preference survives a restart; the loaded model does not, because it
    // is tensors in one process's memory. Nothing reloaded it, so a relaunch
    // showed a ticked "Enable dictation" box above an empty panel with no mic
    // buttons — indistinguishable from the setting not having saved. Unchecking
    // and re-checking was the only way back.
    const rendererRestore = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
    check('an enabled dictation reloads its model at startup',
      /if \(dictationEnabled\(\)\) void restoreDictation\(\)/.test(rendererRestore));
    check('opening Settings also recovers an enabled-but-unloaded model',
      /dictationEnabled\(\) && !whisperPipeline/.test(rendererRestore));

    // Off until asked for, because turning it on downloads 150MB.
    check('dictation is off until enabled',
      await win.evaluate(() => window.__dictationEnabled()) === false);
    const micsOff = await win.evaluate(() =>
      [...document.querySelectorAll('.mic-button')].every(
        (b) => b.disabled && b.classList.contains('mic-button-off')
               && getComputedStyle(b).display !== 'none'));
    check('mic buttons are shown but disabled while dictation is off', micsOff);

    // The resampler is arithmetic, so it can be checked exactly rather than
    // listened to: one second at 48k must become exactly 16000 samples, and a
    // full-scale sine must stay full-scale.
    const resample = await win.evaluate(() => {
      const rate = 48000;
      const src = new Float32Array(rate);
      for (let i = 0; i < rate; i++) src[i] = Math.sin(2 * Math.PI * 440 * i / rate);
      const got = window.__resampleTo16k(src, rate);
      let peak = 0;
      for (const v of got) peak = Math.max(peak, Math.abs(v));
      return { length: got.length, peak: +peak.toFixed(2),
               passthrough: window.__resampleTo16k(src, 16000).length };
    });
    check('resampling 48k to 16k gives exactly one third the samples',
      resample.length === 16000, `${resample.length}`);
    check('resampling preserves amplitude', resample.peak >= 0.99, `${resample.peak}`);
    check('audio already at 16k is passed through untouched',
      resample.passthrough === 48000, `${resample.passthrough}`);

    // One unreachable host must not blank the dashboard.
    //
    // Every host was awaited before anything rendered, so a powered-off laptop
    // held the whole grid — local projects included — for its full ten-second
    // handshake timeout. An empty grid with nothing to click reads as the app
    // being broken rather than one host being down.
    const loaderSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
    const loader = loaderSrc.slice(loaderSrc.indexOf('async function loadProjects'),
                                   loaderSrc.indexOf('async function loadProjects') + 3000);
    check('each host renders as it answers rather than after all of them',
      /applyHost\(h, result\);[\s\S]{0,200}renderProjects\(\)/.test(loader),
      'expected a render inside the per-host map');
    // Clearing upfront made every tile blink out and back on each poll.
    check('the grid is not emptied before the hosts answer',
      !/^\s*projects = \[\];\s*$/m.test(loader.slice(0, loader.indexOf('applyHost'))));
    // A host removed from settings must not leave its projects behind.
    check('projects from a host no longer configured are dropped',
      /configured\.has\(/.test(loader));

    // --- The post-/etc/hosts JSON shape -----------------------------------
    //
    // Zeltro stopped writing /etc/hosts, so three things changed: host_entry is
    // gone, project_ip is new, and local_url is an address rather than a
    // hostname. The CLI flagged the first two as the ones that break silently,
    // and they do — nothing throws, the UI just quietly means something else.
    const newShape = await win.evaluate(() => {
      const parsed = window.__parseStatus(JSON.stringify({
        shared_services: {},
        projects: [{
          name: 'shape-test', docker_running: true, http_status: 'ok',
          // No host_entry at all, as the CLI now emits.
          project_ip: '10.247.177.42',
          local_url: 'http://10.247.177.42',
          lan_url: 'http://192.168.1.6:142',
          external_port: '142', port_mapped: true
        }]
      }))[0];
      return {
        status: parsed.status,
        localUrl: parsed.localUrl,
        projectIp: parsed.projectIp,
        hasHostEntry: 'hostEntry' in parsed
      };
    });
    check('a project with no host_entry still reads as running',
      newShape.status === 'running', JSON.stringify(newShape));
    check('the container address is carried through as project_ip',
      newShape.projectIp === '10.247.177.42', JSON.stringify(newShape));
    check('the removed host_entry field is gone, not defaulted to false',
      !newShape.hasHostEntry, JSON.stringify(newShape));

    // __parseStatus REBUILDS the project list, so the fixture above replaced
    // every real project with one synthetic entry. Put the real ones back
    // before anything downstream reads them.
    await win.evaluate(() => window.loadProjects());
    await win.waitForTimeout(2500);

    // The install check probed http://<project-name>/, which only ever worked
    // because /etc/hosts existed. On current Zeltro that name resolves nowhere,
    // so a working install would have been reported as still initialising.
    const rendererShape = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
    check('install verification asks the CLI for the URL rather than using the name',
      /projectLocalUrl\(target\)/.test(rendererShape)
      && !/check-project-url', target\)/.test(rendererShape));

    // LOCAL and LAN are different routes; unlabelled they look interchangeable.
    check('local and LAN URLs are labelled as different routes',
      /url-scope">LOCAL/.test(rendererShape) && /url-scope">LAN/.test(rendererShape));

    // The splash robot is a BACKGROUND on a box that grows downward, so the box
    // uncovers a stationary image rather than stretching one. background-size
    // must stay fixed — cover or contain would squash him as the box grows,
    // which is the whole thing this avoids.
    const splashCss = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/styles.css'), 'utf8');
    const splashHtml = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/index.html'), 'utf8');
    const splashBlock = splashCss.slice(splashCss.indexOf('.splash-robot {'),
                                        splashCss.indexOf('.brand-row {'));
    // The size comes from a variable now, so the splash and a busy tile can
    // share the reveal at different sizes. What matters is unchanged: the
    // background is a fixed size, not one that tracks the growing box.
    check('the robot is a fixed-size background, not a scaled one',
      /background-size: var\(--reveal-size\) var\(--reveal-size\)/.test(splashBlock)
      && !/background-size: *(cover|contain)/.test(splashBlock));
    check('the reveal loops', /animation: robot-reveal [\d.]+s [a-z-]+ infinite/.test(splashBlock));
    // The outer box holds full height so the text below does not move as the
    // inner one grows.
    check('the reveal does not push the text below it around',
      /\.splash-robot \{[^}]*height: 190px/.test(splashBlock));
    check('reduced motion shows the whole robot',
      /prefers-reduced-motion: reduce/.test(splashBlock) && /height: 190px/.test(splashBlock));
    // The splash has no spinner: two "working on it" signals compete.
    check('the splash has no spinner beside the robot',
      !/loading-spinner large/.test(splashHtml));

    // The window title is what shows in the taskbar and alt-tab, where a
    // subtitle competes for the space the name needs.
    check('the window is titled just Zeltro',
      /<title>Zeltro<\/title>/.test(splashHtml));

    // Electron's default window background is WHITE and shows on any frame the
    // page has not painted — which is what was flashing during the splash.
    const mainForBg = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/main.ts'), 'utf8');
    check('the window has an explicit dark background',
      /backgroundColor: '#[0-9a-f]{6}'/i.test(mainForBg));

    // A bright gradient behind white text is close to unreadable; the other
    // themes use darker fills where white is right, so this is scoped.
    check('Create with AI reads as black on the bright themes',
      /:root\[data-theme="zeltro"\] \.header-actions \.btn-create/.test(splashCss));
    // .btn-create is also the tile's Modify with AI, a transparent outline
    // button — an unscoped rule beat the one giving it its colour and forced
    // black onto a see-through background.
    check('the tile buttons keep their own colour',
      !/:root\[data-theme="(zeltro|matrix)"\] \.btn-create[ ,{]/.test(splashCss));

    // Dictation has two settings and they pick between four models. Whisper
    // ships an English-only variant and a multilingual one at each size — not a
    // model per language — so the choice is English or not, and the .en model is
    // the same download while being better at English.
    const dictModels = await win.evaluate(() => {
      const before = [localStorage.getItem('zeltro-dictation-quality'),
                      localStorage.getItem('zeltro-dictation-multilingual')];
      const out = {};
      for (const q of ['good', 'best']) {
        for (const m of ['off', 'on']) {
          localStorage.setItem('zeltro-dictation-quality', q);
          localStorage.setItem('zeltro-dictation-multilingual', m);
          out[`${q}-${m === 'on' ? 'multi' : 'en'}`] = window.__dictationModelId();
        }
      }
      // Restore, so this does not decide what the rest of the run uses.
      if (before[0] === null) localStorage.removeItem('zeltro-dictation-quality');
      else localStorage.setItem('zeltro-dictation-quality', before[0]);
      if (before[1] === null) localStorage.removeItem('zeltro-dictation-multilingual');
      else localStorage.setItem('zeltro-dictation-multilingual', before[1]);
      return out;
    });
    check('each quality and language pair selects the right model',
      dictModels['good-en'] === 'Xenova/whisper-base.en'
      && dictModels['good-multi'] === 'Xenova/whisper-base'
      && dictModels['best-en'] === 'Xenova/whisper-small.en'
      && dictModels['best-multi'] === 'Xenova/whisper-small',
      JSON.stringify(dictModels));

    // Greyed rather than hidden: hiding it meant the compose box quietly had a
    // different set of buttons depending on a setting three tabs away, and
    // nothing on screen said the feature existed.
    const micSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
    const micBlock = micSrc.slice(micSrc.indexOf('function refreshMicButtons'),
                                 micSrc.indexOf('function refreshMicButtons') + 900);
    check('the mic button is disabled rather than hidden when dictation is off',
      /button\.disabled = !ready/.test(micBlock) && !/style\.display = show/.test(micBlock));
    check('the disabled mic says where to turn dictation on',
      /turn it on in Settings/.test(micBlock));

    // Starting a project blocks its own tile, not the window. Everything else
    // on the dashboard stays usable, and the thing that is working is the thing
    // that looks like it.
    const tileBusy = await win.evaluate(async () => {
      const p = window.__visibleProjects()[0]?.name;
      if (!p) return null;
      window.setTileBusy(p, 'Starting…');
      await new Promise((r) => setTimeout(r, 300));
      const card = document.querySelector(`.project-card[data-project="${CSS.escape(p)}"]`);
      const busy = card?.querySelector('.tile-busy');
      const cr = card?.getBoundingClientRect(), br = busy?.getBoundingClientRect();
      const out = {
        scopedToCard: Boolean(cr && br && br.width <= cr.width + 1 && br.height <= cr.height + 1),
        fullScreen: getComputedStyle(document.getElementById('loading-overlay')).display,
        ownButtonsOff: [...card.querySelectorAll('.project-actions button')].every((b) => b.disabled),
        othersUsable: [...document.querySelectorAll('.project-card[data-project]')]
          .filter((c) => c.dataset.project !== p)
          .every((c) => ![...c.querySelectorAll('button')].every((b) => b.disabled)),
        robot: Boolean(busy?.querySelector('.robot-reveal'))
      };
      window.clearTileBusy(p);
      out.clears = !document.querySelector('.tile-busy');
      return out;
    });
    if (tileBusy) {
      check('a busy tile covers only its own card', tileBusy.scopedToCard, JSON.stringify(tileBusy));
      check('starting a project does not block the window', tileBusy.fullScreen === 'none');
      check('a busy tile disables its own buttons and nothing else',
        tileBusy.ownButtonsOff && tileBusy.othersUsable, JSON.stringify(tileBusy));
      check('the busy tile shows the robot rather than a spinner', tileBusy.robot);
      check('clearing removes the overlay', tileBusy.clears);
    }

    // A throw must not leave a tile blocked for the rest of the session with its
    // own buttons dead and nothing to un-stick it.
    const busySrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
    for (const fn of ['startProject', 'stopProject', 'disableProject', 'enableProject']) {
      const body = busySrc.slice(busySrc.indexOf(`async function ${fn}`),
                                busySrc.indexOf(`async function ${fn}`) + 1200);
      check(`${fn} clears its tile even if the command throws`,
        /finally \{\s*clearTileBusy/.test(body), 'expected the clear in a finally');
    }

    // --- General settings ---------------------------------------------------
    await win.evaluate(() => {
      // Not closeModal(): that closes the one the app considers current, and an
      // earlier section can leave a different one showing whose overlay covers
      // the header.
      document.querySelectorAll('.modal.show').forEach((m) => m.classList.remove('show'));
    });
    await win.waitForTimeout(300);
    await win.click(t('settings-open'));
    await win.waitForTimeout(500);
    await win.click(t('settings-tab-general'));
    await win.waitForTimeout(300);

    const generalPanel = await win.evaluate(() => ({
      update: !!document.querySelector('[data-settings-panel="general"] [data-testid="auto-update-check"]'),
      warn: !!document.querySelector('[data-settings-panel="general"] [data-testid="warn-unreachable-hosts"]'),
      // Behaviour is not appearance; the update setting used to live there.
      strayInAppearance: !!document.querySelector('[data-settings-panel="appearance"] [data-testid="auto-update-check"]')
    }));
    check('General holds the app-wide settings',
      generalPanel.update && generalPanel.warn && !generalPanel.strayInAppearance,
      JSON.stringify(generalPanel));

    // The toggle has to actually suppress the banner, not just store a value —
    // a preference that changes nothing is worse than none.
    const bannerToggle = await win.evaluate(async () => {
      const shown = () => !!document.querySelector('[data-testid="host-errors"]');
      window.setWarnUnreachableHosts(false);
      await new Promise((r) => setTimeout(r, 200));
      const off = shown();
      window.setWarnUnreachableHosts(true);
      await new Promise((r) => setTimeout(r, 200));
      return { off, on: window.__warnUnreachableHosts() };
    });
    check('turning the warning off hides the unreachable-host banner',
      bannerToggle.off === false && bannerToggle.on === true, JSON.stringify(bannerToggle));

    // The window is Zeltro. "Zeltro CLI" is the other program, and naming this
    // one after it was a leftover from when the GUI was a thin front end.
    const shell = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/index.html'), 'utf8');
    check('the header and splash name the app, not the CLI',
      /<h1>Zeltro<\/h1>/.test(shell) && /Loading Zeltro<\/h2>/.test(shell)
      && !/Zeltro CLI<\/(h1|h2)>/.test(shell));

    await win.evaluate(() => window.closeModal());
    await win.waitForTimeout(200);

    // --- Branding -----------------------------------------------------------
    //
    // The rename from Podium to Zeltro touched a thousand strings. These are the
    // ones where being wrong is silent rather than obvious.
    const brandFs = require('fs'), brandPath = require('path');
    const ROOT_B = require('./helpers').ROOT;
    const readSrc = (f) => brandFs.readFileSync(brandPath.join(ROOT_B, f), 'utf8');

    const branding = readSrc('src/branding.ts');
    const binName = (branding.match(/CLI_BIN = '([^']+)'/) || [])[1];
    check('the branding module names the CLI binary', Boolean(binName), String(binName));

    // renderer and installer cannot import branding.ts — they are script-tag
    // loaded and share one global scope — so they keep a literal. Nothing at
    // compile time keeps the three in step, which is exactly why this exists.
    // Only the OLD name matters here. These files also invoke git, sudo and
    // echo, which are not the CLI and never were — an earlier version of this
    // check flagged those and was measuring the wrong thing.
    for (const f of ['src/renderer.ts', 'src/installer.ts']) {
      const stale = [...readSrc(f).matchAll(/invoke\('execute-command(?:-stream)?', '(podium)'/g)];
      check(`${f} does not invoke the CLI by its old name`,
        stale.length === 0, `${stale.length} call(s) still spawn podium`);
    }

    // The old name must not survive anywhere except the places it deliberately
    // does: the projects directory Shawn kept, and URLs to repos and a domain
    // that have not been renamed. Anything else is a miss.
    const strays = [];
    for (const f of ['src/main.ts', 'src/renderer.ts', 'src/installer.ts', 'src/index.html']) {
      for (const line of readSrc(f).split('\n')) {
        if (!/podium/i.test(line)) continue;
        if (/podium-projects|CaneBayComputers\/podium-|podiumcli\.com/.test(line)) continue;
        // The transitional fallbacks name the old paths deliberately: a machine
        // mid-rename has the old binary, config dir or install dir, and a GUI
        // that only knows the new names calls a working install absent. Each is
        // marked LEGACY_ or _CANDIDATES, or is a comment explaining one.
        if (/LEGACY_|_CANDIDATES|_PREFIXES|^\s*\/\/|^\s*'\/(usr|opt|etc)\//.test(line.trim())) continue;
        // Service hostnames match both prefixes on purpose: an upgraded machine
        // keeps podium-* containers so its projects are not orphaned.
        if (/\^\(zeltro\|podium\)-/.test(line)) continue;
        // The remote probe checks both config directories for the same reason.
        if (/grep -qs "\^PROJECTS_DIR="/.test(line)) continue;
        if (/replace\(\/\^zeltro\/, 'podium'\)/.test(line)) continue;
        strays.push(`${f}: ${line.trim().slice(0, 70)}`);
      }
    }
    check('no stray references to the old product name', strays.length === 0,
      strays.slice(0, 4).join(' | '));

    // Renaming the storage keys outright would have reset every existing user's
    // theme, layout, filters and microphone choice, with nothing explaining why.
    check('settings stored under the old name are carried forward',
      /function storedSetting/.test(readSrc('src/renderer.ts'))
      && !/localStorage\.getItem\((LAYOUT|FILTER|THEME)_STORAGE_KEY\)/.test(readSrc('src/renderer.ts')));

    // --- Model listing ----------------------------------------------------
    //
    // Deliberately no assertion that a real endpoint returns models: that would
    // make the suite fail when the network is down, which says nothing about
    // this code. The reachable cases are verified by hand (OpenRouter answers
    // with 414 models and no key); what is pinned here is that failure is quiet
    // and the mechanism is right.
    const badEndpoints = await app.evaluate(async ({ ipcMain }) => {
      const out = {};
      for (const [k, url] of [['garbage', 'not-a-url'],
                              ['unreachable', 'http://127.0.0.1:1/v1'],
                              ['empty', '']]) {
        out[k] = await ipcMain._invokeHandlers.get('list-models')({}, url, '');
      }
      return out;
    });
    check('an unusable model endpoint returns nothing rather than throwing',
      Object.values(badEndpoints).every((r) => Array.isArray(r.models) && r.models.length === 0),
      JSON.stringify(badEndpoints));

    const modelSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/main.ts'), 'utf8');
    const modelBlock = modelSrc.slice(modelSrc.indexOf("ipcMain.handle('list-models'"),
                                      modelSrc.indexOf("// Qwen Code wants Node 22+"));
    // The previous version used the http module only, so every https endpoint
    // failed silently and the field fell back to free text with no explanation.
    check('model listing can reach https endpoints, not just http',
      /https :/.test(modelSrc.slice(modelSrc.indexOf('function fetchJson'), modelSrc.indexOf('function fetchJson') + 600))
      || /\? https :/.test(modelSrc.slice(modelSrc.indexOf('function fetchJson'), modelSrc.indexOf('function fetchJson') + 600)));
    // Two shapes, because Ollama does not serve /v1/models and most others do
    // not serve /api/tags.
    check('both the Ollama and OpenAI-compatible shapes are tried',
      /api\/tags/.test(modelBlock) && /v1\/models/.test(modelBlock));
    // Anthropic authenticates with x-api-key, so a bearer token just 401s.
    check('Anthropic gets its own auth header rather than a bearer token',
      /x-api-key/.test(modelBlock) && /anthropic-version/.test(modelBlock));

    // --- Updates ----------------------------------------------------------
    await win.evaluate(() => window.closeModal());
    await win.waitForTimeout(200);

    // The About window is gone entirely, not just unlinked.
    const htmlNoAbout = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/index.html'), 'utf8');
    check('the About window is removed, not merely hidden',
      !/about-modal|about-open/.test(htmlNoAbout));

    // Both Zeltro repos are source checkouts, so an update is a git pull. The
    // check must be read-only — it fetches remote refs and never touches a
    // working tree, because running it should not be able to change anything.
    const updates = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('check-updates')({}));
    check('the update check finds the GUI checkout it is running from',
      updates.some((r) => r.id === 'gui' && r.branch),
      JSON.stringify(updates.map((r) => `${r.id}:${r.branch}`)));
    check('each repo reports how far behind and ahead it is',
      updates.every((r) => typeof r.behind === 'number' && typeof r.ahead === 'number'),
      JSON.stringify(updates.map((r) => `${r.id} -${r.behind}/+${r.ahead}`)));

    const updateSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/main.ts'), 'utf8');
    const updateBlock = updateSrc.slice(updateSrc.indexOf("ipcMain.handle('update-repo'"),
                                        updateSrc.indexOf("ipcMain.handle('get-platform-capabilities'"));
    // A pull over uncommitted work can destroy it, and which of commit, stash or
    // discard is right is a human decision.
    check('an update refuses to pull over uncommitted changes',
      /status', '--porcelain'/.test(updateBlock) && /uncommitted/i.test(updateBlock));
    // --ff-only so divergence stops cleanly instead of leaving a conflicted tree
    // for someone else to unpick.
    check('an update cannot produce a merge or a conflicted tree',
      /--ff-only/.test(updateBlock));
    check('a failed pull surfaces git\'s own message',
      /pulled\.out/.test(updateBlock));

    // dist/ is gitignored, so a pull brings new SOURCE and leaves the built
    // output alone. Saying only "updated" reads as "you are running it now",
    // which is false until the launcher rebuilds on the next start.
    const runUpdateBlock = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
    check('a successful update says a restart is needed',
      /Restart Zeltro to use it/.test(runUpdateBlock));

    // --- Reachability -----------------------------------------------------
    //
    // A remote project's own addresses are useless from here. local_url is
    // http://<name>, resolved through the REMOTE host's /etc/hosts, and lan_url
    // is that host's view of its own network — on EC2 the private VPC address,
    // unroutable from anywhere else. Only external_port travels.
    const urlComposition = await win.evaluate(() => {
      // Synthetic, so the assertion does not depend on which hosts happen to be
      // configured or which projects happen to be running.
      const remote = { name: 'r', status: 'running', hostId: 'probe-host', port: 8080,
                       localUrl: 'http://r', lanUrl: 'http://10.0.0.5:8080', portMapped: true };
      const local  = { name: 'l', status: 'running', hostId: 'local', port: 99,
                       localUrl: 'http://l', lanUrl: 'http://192.168.1.6:99', portMapped: true };
      const hrefs = (p) => (window.__projectUrls(p).match(/>([^<]+)<\/a>/g) || [])
        .map((m) => m.replace(/>|<\/a>/g, ''));
      return { remote: hrefs(remote), local: hrefs(local) };
    });
    // No profile with that id exists, so a remote project must render NOTHING
    // rather than falling back to an address that cannot work.
    check('a remote project does not fall back to its own lan_url',
      !urlComposition.remote.some((u) => u.includes('10.0.0.5')),
      JSON.stringify(urlComposition.remote));
    check('a local project keeps both of its own addresses',
      urlComposition.local.length === 2 && urlComposition.local.some((u) => u.includes('192.168.1.6')),
      JSON.stringify(urlComposition.local));

    // The probe must separate "nothing answered" from "the network said no":
    // only one of them points at a firewall rule.
    const refused = await app.evaluate(async ({ ipcMain }) => {
      const t0 = Date.now();
      // Port 1 on loopback: refused immediately, with an RST.
      const r = await ipcMain._invokeHandlers.get('check-project-url')({}, '127.0.0.1:1', 2500);
      return { ...r, ms: Date.now() - t0 };
    });
    check('a refused connection is not reported as a timeout',
      refused.code === 0 && !refused.timedOut && refused.ms < 1500,
      JSON.stringify(refused));

    // And the click path must use a short timeout, because a blocked port is
    // the slow failure and the user is waiting on it.
    const clickSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
    const openBlock = clickSrc.slice(clickSrc.indexOf('async function openProjectUrl'),
                                     clickSrc.indexOf('async function openProjectUrl') + 2000);
    check('the click probe uses a short timeout, not the default',
      /check-project-url', address, 2500/.test(openBlock));
    check('a timeout and a refusal produce different explanations',
      /probe\.timedOut/.test(openBlock)
      && /security group/.test(openBlock) && /asleep/.test(openBlock));

    // --- Host filter ------------------------------------------------------
    const hostFilterBehaviour = await win.evaluate(() => {
      const all = window.__allProjects();
      const hosts = [...new Set(all.map((p) => p.hostId))];
      const target = hosts[0];
      window.setHostFilter(target);
      const shown = window.__visibleProjects();
      const out = {
        target,
        allFromTarget: shown.every((p) => p.hostId === target),
        // Counts beside the other controls must describe what those controls
        // would actually show, not the whole unfiltered set.
        runLabel: document.querySelector('[data-testid="filter-run"] option')?.textContent || ''
      };
      window.resetFilters();
      return out;
    });
    check('filtering by host shows only that host\'s projects',
      hostFilterBehaviour.allFromTarget, JSON.stringify(hostFilterBehaviour));
    check('resetting filters clears the host filter too',
      await win.evaluate(() => window.__hostFilter()) === '');

    // A persisted filter naming a host whose profile was deleted would hide
    // everything with nothing on screen explaining why.
    const staleHost = await win.evaluate(() => {
      window.setHostFilter('local');
      const forced = 'a-host-that-no-longer-exists';
      // Simulate the persisted value directly, as loading would.
      window.setHostFilter(forced);
      return { stored: window.__hostFilter() };
    });
    check('a filter naming an unknown host is refused rather than hiding everything',
      staleHost.stored === '', JSON.stringify(staleHost));

    // --- Tile filters ----------------------------------------------------
    if (expectedProjects > 0) {
      console.log('\nfilters');
      const tiles = () => win.locator('#projects-grid .project-card:not(.placeholder)').count();
      const allTiles = await tiles();

      await win.evaluate(() => window.setRunFilter('running'));
      const runningTiles = await tiles();
      await win.evaluate(() => window.setRunFilter('stopped'));
      const stoppedTiles = await tiles();
      // Every project is one or the other, so the two halves must account for
      // the whole — a tile lost by both filters would be invisible everywhere.
      check('running and stopped partition the project list',
        runningTiles + stoppedTiles === allTiles,
        `${runningTiles} + ${stoppedTiles} != ${allTiles}`);
      // `running` above is the LOCAL host's list. With several hosts the grid
      // legitimately shows more, so compare against what the app holds — which
      // the union check above has already tied back to the hosts themselves.
      const runningEverywhere = await win.evaluate(() =>
        window.__allProjects().filter((p) => p.status === 'running' && !window.isDisabled(p)).length);
      check('the running filter matches every running project the grid holds',
        runningTiles === runningEverywhere, `${runningTiles} vs ${runningEverywhere}`);

      await win.evaluate(() => window.setRunFilter('all'));

      // Each emoji chip's count must equal the tiles it leaves on screen.
      const chips = await win.locator('#project-filters .emoji-chip').evaluateAll((els) =>
        els.map((e) => ({
          emoji: e.getAttribute('data-testid').replace('emoji-filter-', ''),
          count: Number(e.querySelector('.emoji-count')?.textContent || 0),
        })));
      check('emoji chips are rendered', chips.length > 0, `${chips.length} chips`);
      for (const { emoji, count } of chips) {
        await win.evaluate((e) => window.toggleEmojiFilter(e), emoji);
        const shown = await tiles();
        check(`emoji ${emoji} count matches the tiles it shows`,
          shown === count, `chip says ${count}, grid shows ${shown}`);
        await win.evaluate((e) => window.toggleEmojiFilter(e), emoji);
      }

      // A filter that empties the grid must say so. Falling through to the
      // "create your first project" placeholder reads as data loss.
      await win.evaluate(() => { window.setRunFilter('running'); window.toggleEmojiFilter('⛔'); });
      check('an empty result explains itself instead of looking empty',
        await win.locator(t('no-matches')).count() === 1);

      // Sort by last-on. The CLI stamps `last_on` into x-metadata on both start
      // and stop, so it means "last time this was up". Projects predating that
      // have no value and must sort LAST — an absent timestamp is "unknown",
      // not 1970.
      // --- Disabled projects ---------------------------------------------
      //
      // A disabled project is parked, not deleted. It is hidden everywhere
      // except its own filter, which makes that filter the ONLY route back —
      // so the ways this can go wrong are all "the project is unreachable".
      console.log('\ndisabled projects');
      await win.evaluate(() => window.resetFilters());

      const disabledRules = await win.evaluate(() => {
        const name = window.__visibleProjects()[0]?.name;
        const proj = () => window.__allProjects().find((p) => p.name === name);
        const before = window.isDisabled(proj());
        // Only the exact string disables. Everything else means enabled —
        // a project must never be parked because a read returned junk.
        const readings = {};
        for (const v of ['disabled', 'DISABLED', 'enabled', 'paused', '', undefined, null, 'disable']) {
          window.__setMetaStatus(name, v);
          readings[String(v)] = window.isDisabled(proj());
        }
        window.__setMetaStatus(name, undefined);
        return { before, readings };
      });
      check('only the exact string "disabled" disables a project',
        disabledRules.readings['disabled'] === true &&
        ['DISABLED', 'enabled', 'paused', '', 'undefined', 'null', 'disable']
          .every((k) => disabledRules.readings[k] === false),
        JSON.stringify(disabledRules.readings));

      // The Disabled option must exist even at zero. Offering it only when the
      // count is non-zero means disabling your last project hides the control
      // that would bring it back, in the same render that hid the project.
      const runOptions = await win.locator('[data-testid="filter-run"] option')
        .evaluateAll((els) => els.map((e) => e.value));
      check('the Disabled filter is always offered, even at zero',
        runOptions.includes('disabled'), runOptions.join(','));

      // Simulate one being disabled and assert it leaves every other view.
      const hiding = await win.evaluate(() => {
        const all = window.__visibleProjects();
        const name = all[0].name;
        window.__setMetaStatus(name, 'disabled');
        const seenIn = {};
        for (const f of ['all', 'running', 'stopped', 'disabled']) {
          window.setRunFilter(f);
          seenIn[f] = window.__visibleProjects().some((p) => p.name === name);
        }
        window.__setMetaStatus(name, undefined);
        window.resetFilters();
        return { name, seenIn };
      });
      check('a disabled project is hidden from All, Running and Stopped',
        !hiding.seenIn.all && !hiding.seenIn.running && !hiding.seenIn.stopped,
        JSON.stringify(hiding.seenIn));
      check('a disabled project IS visible under the Disabled filter',
        hiding.seenIn.disabled, JSON.stringify(hiding.seenIn));

      // Its tile must not offer actions the CLI will refuse, but must keep the
      // two that work: Enable, and Trash.
      const tileActions = await win.evaluate(async () => {
        const name = window.__visibleProjects()[0].name;
        window.__setMetaStatus(name, 'disabled');
        window.setRunFilter('disabled');
        window.renderProjects();
        await new Promise((r) => setTimeout(r, 200));
        const card = document.querySelector('[data-testid="disabled-card"]');
        const buttons = card ? [...card.querySelectorAll('button')].map((b) => b.textContent.trim()) : [];
        window.__setMetaStatus(name, undefined);
        window.resetFilters();
        window.renderProjects();
        return buttons;
      });
      check('a disabled tile offers no Start, Modify with AI or Edit',
        !tileActions.some((b) => /Start|Modify with AI|^Edit$/.test(b)), tileActions.join('|'));
      check('a disabled tile keeps Enable and Trash',
        tileActions.includes('Enable') && tileActions.includes('Trash'),
        tileActions.join('|'));

      // Clear the filter the previous check left on, or this reads an empty
      // list and "no project carries last_on" is true for the wrong reason.
      await win.evaluate(() => window.resetFilters());
      await win.evaluate(() => window.setSortKey('last-on'));
      await win.waitForTimeout(200);
      const lastOnOrder = await win.evaluate(() =>
        window.__visibleProjects().map((p) => ({ name: p.name, last_on: p.last_on || '' })));
      const localNames = (statusJson.projects || []).map((p) => p.name);
      const withStamp = lastOnOrder.filter((p) => p.last_on);
      const firstBlank = lastOnOrder.findIndex((p) => !p.last_on);

      // How many projects SHOULD have one is a fact about the compose files, so
      // read it from the main process. Without this the "skipping" branch below
      // is indistinguishable from the metadata path being broken.
      // Straight from the same status JSON the GUI parses — metadata arrives
      // with operational state now, so there is no second source to reconcile.
      // Disabled projects are hidden by design, so counting their timestamps
      // against the visible list would compare two different populations.
      // statusJson is the LOCAL host only; the list spans every host. Count the
      // same population on both sides or this compares two different things.
      const stampedOnDisk = (statusJson.projects || [])
        .filter((p) => p.metadata?.last_on && p.metadata?.status !== 'disabled')
        .map((p) => p.name);
      const lastOnLocal = lastOnOrder.filter((p) => p.last_on && localNames.includes(p.name));

      check('every last_on on disk reaches the project list',
        lastOnLocal.length === stampedOnDisk.length,
        `${stampedOnDisk.length} on disk (local), ${lastOnLocal.length} local entries in the list`);

      if (withStamp.length > 0) {
        check('projects with a last_on sort ahead of those without',
          firstBlank === -1 || firstBlank >= withStamp.length,
          `${withStamp.length} stamped, first blank at ${firstBlank}`);
        const stamps = withStamp.map((p) => p.last_on);
        check('last_on sorts most-recent first',
          stamps.every((v, i) => i === 0 || stamps[i - 1] >= v), stamps.join(' '));
        // ISO-8601 UTC was agreed precisely so lexical order is chronological.
        check('last_on is the agreed ISO-8601 UTC shape',
          stamps.every((v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v)),
          stamps[0]);
      } else {
        console.log('  – no project carries last_on yet; skipping order check');
      }

      await win.evaluate(() => window.resetFilters());
      check('reset restores every tile', await tiles() === allTiles);
    }

    // --- Service manager -------------------------------------------------
    console.log('\nservice manager');
    await win.click(t('manage-services'));
    await win.waitForSelector('#service-manager-modal.show', { timeout: 8000 });
    // Wait for the rows themselves rather than a fixed delay. The list is filled
    // asynchronously, and on a machine with an unreachable host configured the
    // app can be busy for ten seconds waiting out that handshake — which made a
    // fixed 800ms wait pass alone and fail in a full run.
    await win.waitForSelector('#service-manager-list .service-row', { timeout: 20000 });

    const managerRows = await win.evaluate(() =>
      [...document.querySelectorAll('#service-manager-list .service-row')]
        .map((r) => r.getAttribute('data-testid') || '')
        .filter(Boolean)
        .map((id) => id.replace('service-row-', '')));
    check('the manager lists every optional service',
      managerRows.length === 9, `${managerRows.length}: ${managerRows.join(',')}`);
    check('the manager omits the always-on services',
      !managerRows.some((n) => ['redis', 'memcached', 'mailhog'].includes(n)),
      managerRows.join(','));

    // A database another project points at must not be disableable — nothing in
    // the CLI stops it, and the project simply fails to connect afterwards.
    const guard = await win.evaluate(async () => {
      const inUse = await require('electron').ipcRenderer.invoke('get-services-in-use');
      const locked = [...document.querySelectorAll('#service-manager-list .service-row.locked')]
        .map((r) => r.getAttribute('data-testid').replace('service-row-', ''));
      const disabledButtons = [...document.querySelectorAll('#service-manager-list button[disabled]')]
        .map((b) => b.getAttribute('data-testid'));
      return { inUse, locked, disabledButtons };
    });
    // Every service reported in use AND currently enabled must be locked.
    const enabledNow = await win.evaluate(() =>
      [...document.querySelectorAll('#service-manager-list .service-state.on')]
        .map((e) => e.closest('.service-row').getAttribute('data-testid').replace('service-row-', '')));
    // The guard must not pass vacuously. It did: in-use was computed by scanning
    // docker-compose.yaml for service hostnames, but a project names its
    // database in .env — 12 of the 15 projects on this machine declare
    // DB_HOST=zeltro-mariadb there and every one was missed. With in-use always
    // empty, `shouldLock` was empty and `.every()` on an empty array is true.
    //
    // So establish independently, from disk, what the answer should be.
    // Read from the test process: `require` is not defined inside app.evaluate,
    // which injects the electron module and nothing else.
    const projectsDir = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('get-projects-dir')({}));
    let dbUsersOnDisk = 0;
    {
      const fsD = require('fs'), pathD = require('path');
      for (const proj of fsD.readdirSync(projectsDir)) {
        try {
          const env = fsD.readFileSync(pathD.join(projectsDir, proj, '.env'), 'utf8');
          // Both prefixes: an upgraded machine keeps podium-* container names
          // so its projects are not orphaned, and every project .env here still
          // says podium-mariadb. Looking only for the new name made this report
          // "nothing to find" — the vacuous state this check exists to refuse.
          if (/^DB_HOST=(zeltro|podium)-mariadb/m.test(env)) dbUsersOnDisk++;
        } catch { /* no .env */ }
      }
    }

    if (dbUsersOnDisk > 0) {
      check('the in-use guard actually finds the projects using a service',
        (guard.inUse?.mysql || []).length > 0,
        `${dbUsersOnDisk} projects declare DB_HOST on disk, guard found ${(guard.inUse?.mysql || []).length}`);
    } else {
      check('the in-use guard has something to find on this machine', false,
        'no project declares DB_HOST — this check cannot prove anything here');
    }

    const shouldLock = Object.keys(guard.inUse || {}).filter((s) => enabledNow.includes(s));
    check('a service a project depends on cannot be disabled from here',
      shouldLock.every((s) => guard.locked.includes(s)),
      `in use+enabled=${shouldLock.join(',')} locked=${guard.locked.join(',')}`);

    // A hostname inside a comment must not count. Found on a real remote box: a
    // compose comment reading "still resolved zeltro-mariadb ... by name" made
    // the guard claim two projects depended on MariaDB, which would have blocked
    // disabling a service nothing used.
    const guardSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/main.ts'), 'utf8');
    check('the in-use guard ignores hostnames mentioned in comments',
      /mentionedOutsideAComment/.test(guardSrc) && /\^\[\^#\]\*/.test(guardSrc),
      'expected comment-aware matching on both the local and remote paths');

    // Toggling pulls an image and starts a container. Without visible feedback
    // the row sits unchanged and the click looks like it did nothing — which is
    // how it read before, and why people clicked twice.
    const busy = await win.evaluate(async () => {
      const row = document.querySelector('#service-manager-list .service-row');
      const slug = row.getAttribute('data-testid').replace('service-row-', '');
      window.setServiceRowBusy(slug, 'Starting…');
      const overlay = row.querySelector('.service-row-busy');
      const box = overlay ? overlay.getBoundingClientRect() : null;
      const rowBox = row.getBoundingClientRect();
      const state = {
        present: !!overlay,
        // It has to actually cover the row, not sit collapsed in a corner.
        covers: !!box && box.width >= rowBox.width - 2 && box.height >= rowBox.height - 2,
        buttonsDisabled: [...row.querySelectorAll('button')].every((b) => b.disabled),
        spins: !!overlay?.querySelector('.loading-spinner')
      };
      overlay?.remove();
      row.classList.remove('busy');
      row.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return state;
    });
    check('toggling a service covers its row while it works',
      busy.present && busy.covers && busy.spins, JSON.stringify(busy));
    check('the row cannot be clicked again while busy', busy.buttonsDisabled);

    await win.click('#service-manager-modal .modal-close');
    await win.waitForTimeout(300);

    // Web UI links belong on the service's own card, not in a detached row of
    // header buttons. The card buttons compared `zeltro-phpmyadmin` against
    // `phpmyadmin` and so had never rendered at all.
    check('the header no longer carries a separate row of web UI links',
      await win.locator('#service-links').count() === 0);

    const cardActions = await win.evaluate(() =>
      [...document.querySelectorAll('#services-grid .service-card')].map((c) => ({
        name: c.querySelector('h3')?.textContent?.trim(),
        running: !!c.querySelector('.status-indicator.running'),
        buttons: [...c.querySelectorAll('button')].map((b) => b.textContent.trim())
      })));
    const runningCards = cardActions.filter((c) => c.running);
    if (runningCards.length > 0) {
      // redis and memcached are always on, so at least one running card must
      // offer its action. Zero actions across every running card is the bug.
      const withActions = runningCards.filter((c) => c.buttons.length > 0);
      check('running service cards offer their actions',
        withActions.length > 0,
        runningCards.map((c) => `${c.name}:${c.buttons.length}`).join(' '));
    }

    // Optional services (minio, meilisearch) must not appear as red "Stopped"
    // cards on a machine that never enabled them — that reads as a broken
    // service rather than an unused feature.
    const optional = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('get-optional-services')({})
    );
    const servicesText = await win.locator('#services-grid').innerText();
    for (const name of ['minio', 'meilisearch']) {
      const shown = servicesText.toLowerCase().includes(name);
      check(`optional service "${name}" shown only when enabled`,
        shown === optional.includes(name),
        `enabled=${optional.includes(name)}, rendered=${shown}`);
    }

    // --- Install-an-app modal (the step 2 feature) ----------------------
    // Reached through New Project now, so the test walks the same path a user
    // does rather than calling the modal directly.
    console.log('\ninstall app');
    await win.click(t('new-project'));
    await win.waitForSelector('#new-project-modal.show', { timeout: 5000 });

    // With more than one host configured the host step comes first, because both
    // catalogues are read from the chosen machine. Step past it when it appears.
    if (await win.isVisible(t('new-project-host'))) {
      await win.click('#new-project-host .kind-option');
      await win.waitForTimeout(400);
    }
    check('new project opens on the kind choice, not the form',
      await win.isVisible(t('new-project-choice')) &&
      !(await win.isVisible('#new-project-form')));
    await win.click(t('kind-app'));
    await win.waitForSelector('#install-app-modal.show', { timeout: 5000 });
    check('install modal opens', await win.isVisible('#install-app-modal'));
    check('new project modal closed behind it',
      !(await win.isVisible('#new-project-modal')));

    // The install pane used to lose the end of its own output. Streaming was
    // gated on installInProgress, which is cleared the moment the invoke
    // resolves — and the reply travels on a different channel from the stream
    // events, so it can arrive first. The dropped chunk was exactly where the
    // CLI prints the URL, credentials and notes, which is the whole reason the
    // install deliberately does not pass --json-output.
    const rendererSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
    const streamHandler = rendererSrc.slice(rendererSrc.indexOf('// Live output from the streamed install'));
    check('install streaming is not gated on the completion flag',
      /installStreamActive/.test(streamHandler.slice(0, 400)) &&
      !/!installInProgress/.test(streamHandler.slice(0, 400)));

    // And the repair path itself: a pane holding a truncated prefix must come
    // back complete once the command's own captured output is available.
    const repaired = await win.evaluate(() => {
      const pane = document.getElementById('install-output');
      const full = 'Waiting...\nApp is ready! (HTTP 200)\n\n  URL: http://app/\n  Credentials: admin/secret\n  Note: read the docs\n';
      pane.textContent = 'Waiting...\nApp is ready! (HTTP 200)\n';
      window.reconcileInstallOutput({ stdout: full });
      const after = pane.textContent;
      pane.textContent = '';
      return { after, restored: after === full };
    });
    check('a truncated install pane is repaired from the captured output',
      repaired.restored, JSON.stringify(repaired.after));

    // Removing a project must not destroy data because a dialog was dismissed.
    //
    // confirm() returns false when the user hits Escape or the window X. The
    // question used to be "keep the database?" with OK = keep, so dismissing it
    // took the destructive branch — and --force-db-delete now drops the
    // project's volumes too, not just its database. The destructive answer has
    // to require a deliberate OK.
    const removeFlags = await win.evaluate(async () => {
      const realConfirm = window.confirm;
      const realInvoke = require('electron').ipcRenderer.invoke;
      const runs = {};

      for (const [label, answers] of [
        ['dismissed', [true, false]],   // proceed with removal, then dismiss
        ['accepted', [true, true]]      // proceed, then explicitly say delete
      ]) {
        let i = 0;
        window.confirm = () => answers[i++];
        // Removal routes through execute-zeltro-on now, so it lands on the
        // project's own machine rather than always locally. The flags being
        // checked are unchanged; only which channel carries them moved.
        //   execute-zeltro-on(hostId, subcommand, args)
        require('electron').ipcRenderer.invoke = async (channel, a, b, c) => {
          if (channel === 'execute-zeltro-on' && b === 'remove') {
            runs[label] = { host: a, args: (c || []).slice() };
            return { code: 1, stdout: '', stderr: 'intercepted by test' };
          }
          return realInvoke(channel, a, b, c);
        };
        await window.removeProject('__test_never_exists__');
      }

      window.confirm = realConfirm;
      require('electron').ipcRenderer.invoke = realInvoke;
      return runs;
    });

    check('dismissing the data prompt preserves the database and volumes',
      (removeFlags.dismissed?.args || []).includes('--preserve-database'),
      JSON.stringify(removeFlags.dismissed));
    check('deleting data requires a deliberate confirmation',
      (removeFlags.accepted?.args || []).includes('--force-db-delete'),
      JSON.stringify(removeFlags.accepted));
    // And it must be aimed at a host, not implicitly at this machine.
    check('removal is routed to a host rather than assumed local',
      typeof removeFlags.accepted?.host === 'string' && removeFlags.accepted.host.length > 0,
      JSON.stringify(removeFlags.accepted));
    // --force is an undocumented alias for --force-db-delete, not "skip
    // prompts". Passing it once deleted databases users had asked to keep.
    check('remove never passes the legacy --force alias',
      !JSON.stringify(removeFlags).includes('"--force"'), JSON.stringify(removeFlags));

    // A notification's type must actually reach its styling. showNotification
    // sets `notification-<type>` while the CSS only matched `.notification.
    // <type>`, so every notification rendered identically — a success and a
    // failure were the same colour and nobody noticed.
    const notifStyles = await win.evaluate(() => {
      const seen = {};
      for (const type of ['success', 'error', 'warning']) {
        const n = window.showNotification(`probe ${type}`, type, 0);
        seen[type] = getComputedStyle(n).borderTopColor;
        n.remove();
      }
      return seen;
    });
    const distinct = new Set(Object.values(notifStyles));
    check('notification types are visually distinct',
      distinct.size === 3, JSON.stringify(notifStyles));

    // Repairing must not duplicate what already arrived.
    const idempotent = await win.evaluate(() => {
      const pane = document.getElementById('install-output');
      const full = 'line one\nline two\n';
      pane.textContent = full;
      window.reconcileInstallOutput({ stdout: full });
      const after = pane.textContent;
      pane.textContent = '';
      return after === full;
    });
    check('repairing a complete pane changes nothing', idempotent);

    // Back returns to the choice instead of dumping the user at the dashboard.
    await win.click(t('install-back'));
    await win.waitForSelector('#new-project-modal.show', { timeout: 5000 });
    check('back returns to the kind choice', await win.isVisible(t('new-project-choice')));
    await win.click(t('kind-app'));
    await win.waitForSelector('#install-app-modal.show', { timeout: 5000 });

    // Catalogue is read from the CLI's apps.json at runtime.
    await win.waitForFunction(
      () => document.querySelectorAll('#install-app-list .app-entry').length > 0,
      null,
      { timeout: 10000 }
    );
    const total = await win.locator('#install-app-list .app-entry').count();
    check('app catalogue loaded from the CLI', total > 50, `${total} apps rendered`);

    const countLabel = await win.textContent('#install-app-count');
    check('app count label reflects catalogue', /\(\d+ apps\)/.test(countLabel || ''), countLabel);

    await screenshot(win, '02-install-picker');

    // Install button starts disabled — nothing selected yet.
    check('install button disabled before selection',
      await win.locator(t('install-submit')).isDisabled());

    // With all 102 apps listed the modal is tall; the footer must stay pinned
    // rather than being pushed below the fold, or the primary action is
    // off-screen until the user happens to filter the list.
    const actionsVisible = await win.locator(t('install-submit')).evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.bottom <= window.innerHeight && box.top >= 0 && box.height > 0;
    });
    check('install/cancel buttons stay within the viewport with a full list', actionsVisible);

    // Search narrows the list.
    await win.fill(t('install-search'), 'grafana');
    await win.waitForFunction(
      () => document.querySelectorAll('#install-app-list .app-entry').length < 10,
      null,
      { timeout: 5000 }
    );
    const filtered = await win.locator('#install-app-list .app-entry').count();
    check('search filters the catalogue', filtered > 0 && filtered < total,
      `${filtered} of ${total} after searching "grafana"`);

    // Selecting enables the button and names the app.
    await win.click(t('app-grafana'));
    check('selecting an app enables install',
      await win.locator(t('install-submit')).isEnabled());
    const btnText = await win.textContent(t('install-submit'));
    check('install button names the chosen app', /grafana/i.test(btnText || ''), btnText);

    await screenshot(win, '03-install-selected');

    // A database-fixed app shows its engine; self-contained apps say so.
    await win.fill(t('install-search'), 'actual');
    await win.waitForTimeout(200);
    const selfContained = await win.locator('#install-app-list .app-db-none').count();
    check('self-contained apps are labelled, not offered a database', selfContained > 0);

    await win.click('#install-app-modal .modal-close');
    await win.waitForTimeout(200);

    // --- Create with AI (phase 1 choices, rendered natively) ------------
    //
    // Driven from a FIXTURE, not a live classification: a real
    // `zeltro create --classify-only` is an AI round-trip — slow, costs tokens,
    // and returns different candidates run to run. The contract itself was
    // verified against the real CLI by hand; what matters here is that the GUI
    // renders that contract correctly and never offers a database for an app.
    console.log('\ncreate with ai');
    await win.click(t('create-ai'));
    await win.waitForSelector('#create-ai-modal.show', { timeout: 5000 });
    check('create modal opens', await win.isVisible('#create-ai-modal'));

    // Input validation, before any AI round-trip is paid for.
    await win.fill(t('create-idea'), '');
    await win.click(t('create-classify'));
    await win.waitForTimeout(500);
    check('an empty idea is rejected without calling the AI',
      ((await win.textContent('#create-idea-error')) || '').length > 0,
      await win.textContent('#create-idea-error'));

    // A leading dash is parsed as a command-line flag. `zeltro create` honours
    // `--`, so classification alone could be made to work — but the same text is
    // later handed to `zeltro ai`, where the AGENT's own CLI parses the dash and
    // `--` only stops Zeltro rejecting it. Half-working is worse than declining.
    await win.fill(t('create-idea'), '-a tracker for guitar pedals');
    await win.click(t('create-classify'));
    await win.waitForTimeout(500);
    const dashErr = await win.textContent('#create-idea-error');
    check('an idea starting with a dash is declined with a reason',
      /dash|flag/i.test(dashErr || ''), dashErr || '<none>');
    await win.fill(t('create-idea'), '');

    const FIXTURE = {
      status: 'success',
      project_name: 'team-process-wiki',
      recommended: 'app',
      customization_requested: false,
      database: { slug: 'mysql', reason: 'Relational docs with concurrent edits.' },
      candidates: [
        { kind: 'app', slug: 'bookstack', display: 'BookStack', reason: 'Purpose-built wiki.', database: 'mysql' },
        { kind: 'app', slug: 'trilium', display: 'Trilium Notes', reason: 'Hierarchical notes.', database: '' },
        { kind: 'framework', slug: 'laravel', display: 'Laravel', reason: 'Custom page models.',
          databases: ['mysql', 'postgres', 'sqlite'] }
      ]
    };

    await win.evaluate((fixture) => {
      // renderClassification() adopts the fixture as the current classification,
      // so the click handlers work exactly as they do after a real classify.
      window.renderClassification(fixture);
      // Drive the real stage transition rather than forcing display, so the
      // footer buttons and hidden stages are exercised too.
      window.setCreateStage('choose');
    }, FIXTURE);

    check('choose stage swaps the footer to the create action',
      await win.isVisible(t('create-confirm')) && !(await win.isVisible(t('create-classify'))));
    check('choose stage hides the idea input', !(await win.isVisible('#create-stage-idea')));

    const candidateCount = await win.locator('#create-candidates .candidate').count();
    check('renders every candidate', candidateCount === 3, `${candidateCount} of 3`);

    const recBadges = await win.locator('#create-candidates .rec-badge').count();
    check('marks exactly one recommendation', recBadges === 1, `${recBadges} badges`);

    // The recommendation is the first candidate of the RECOMMENDED KIND, not
    // simply the first row — same rule the CLI menu uses.
    const badgedSlug = await win.locator('#create-candidates .candidate:has(.rec-badge) .app-slug').textContent();
    check('recommends the first candidate of the recommended kind',
      badgedSlug?.trim() === 'bookstack', badgedSlug || '');

    check('prefills the suggested project name',
      (await win.locator(t('create-name')).inputValue()) === 'team-process-wiki');

    // An app's database is fixed by its installer — never offer a choice.
    await win.click(t('candidate-bookstack'));
    check('app selection hides the database picker',
      !(await win.isVisible('#create-database-group')));
    const fixedText = await win.textContent('#create-fixed-db-text');
    check('app shows its fixed database as information',
      /mysql/i.test(fixedText || '') && /installer/i.test(fixedText || ''), fixedText || '');

    await win.click(t('candidate-trilium'));
    const selfContainedText = await win.textContent('#create-fixed-db-text');
    check('self-contained app says so rather than naming an engine',
      /internally/i.test(selfContainedText || ''), selfContainedText || '');

    // A framework offers only the engines it actually supports, recommended first.
    await win.click(t('candidate-laravel'));
    check('framework selection shows the database picker',
      await win.isVisible('#create-database-group'));
    const engines = await win.locator('#create-database option').evaluateAll((o) => o.map((x) => x.value));
    check('offers only engines the framework supports',
      engines.length === 3 && ['mysql', 'postgres', 'sqlite'].every((e) => engines.includes(e)),
      engines.join(','));
    check('recommended engine is first', engines[0] === 'mysql', engines.join(','));

    await screenshot(win, '06-create-choices');

    // A null project_name means the idea implied no subject — ask, don't invent.
    await win.evaluate((fixture) => {
      window.renderClassification({ ...fixture, project_name: null });
    }, FIXTURE);
    check('empty name when the idea implies none',
      (await win.locator(t('create-name')).inputValue()) === '');
    const nameHelp = await win.textContent('#create-name-help');
    check('prompts for a name instead of inventing one',
      /pick one|does not suggest/i.test(nameHelp || ''), nameHelp || '');

    await win.click('#create-ai-modal .modal-close');
    await win.waitForTimeout(200);

    // --- Clone modal (mode selector added during the CLI re-sync) -------
    console.log('\nclone');
    await win.click(t('clone-project'));
    await win.waitForSelector('#clone-project-modal.show', { timeout: 5000 });
    check('clone modal opens', await win.isVisible('#clone-project-modal'));

    const modes = await win.locator(`${t('clone-mode')} option`).evaluateAll(
      (opts) => opts.map((o) => o.value)
    );
    check('clone offers all three required modes',
      ['work-directly', 'fork', 'new-repo'].every((m) => modes.includes(m)),
      modes.join(', '));
    check('clone defaults to work-directly',
      await win.locator(t('clone-mode')).inputValue() === 'work-directly');

    await screenshot(win, '04-clone-modal');
    await win.click('#clone-project-modal .modal-close');
    await win.waitForTimeout(200);

    // --- New Project modal ----------------------------------------------
    console.log('\nnew project');
    await win.click(t('new-project'));
    await win.waitForSelector('#new-project-modal.show', { timeout: 5000 });
    check('new project modal opens', await win.isVisible('#new-project-modal'));

    // --- Host picker ------------------------------------------------------
    //
    // With one option there is nothing to choose, so the step is skipped — a
    // question with a single answer is friction rather than a choice.
    //
    // This machine has real hosts configured, so the test creates the condition
    // rather than assuming it: clear the profiles, check, then put back exactly
    // what was there. Depending on the machine's host count would make this
    // pass or fail for reasons unrelated to the rule.
    const savedProfiles = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('get-ssh-profiles')({}));

    await win.evaluate(() => window.closeModal());
    await win.evaluate(async () => {
      // Credentials stay; only the hosts go, which is what leaves the picker
      // with a single option.
      await require('electron').ipcRenderer.invoke('save-ssh-store',
        { credentials: window.__sshCredentials(), hosts: [] });
    });
    await win.waitForTimeout(200);
    await win.click(t('new-project'));
    await win.waitForTimeout(600);

    check('with one host available the picker is skipped',
      !(await win.isVisible(t('new-project-host')))
      && await win.isVisible(t('new-project-choice')));
    check('the single host is selected rather than left unset',
      await win.evaluate(() => window.__newProjectHost()) === 'local');

    await win.evaluate(async (profiles) => {
      await require('electron').ipcRenderer.invoke('save-ssh-store', profiles);
    }, savedProfiles);
    await win.waitForTimeout(200);

    // Add a host and reopen: now there is a real choice, so it must be asked.
    await win.evaluate(async () => {
      await require('electron').ipcRenderer.invoke('save-ssh-store', {
        credentials: [{ id: 'picker-cred', label: 'picker', user: 'someone',
                        authType: 'key', keyPath: '~/.ssh/id_rsa' }],
        hosts: [{ id: 'picker-test', label: 'test-host', host: '192.0.2.10',
                  port: 22, credentialId: 'picker-cred' }]
      });
    });
    await win.evaluate(() => window.closeModal());
    await win.waitForTimeout(200);
    await win.click(t('new-project'));
    await win.waitForTimeout(600);

    check('with two hosts available the picker is shown',
      await win.isVisible(t('new-project-host')));
    const hostOptions = await win.locator('#new-project-host .kind-option').count();
    check('the picker offers local plus each configured host',
      hostOptions === 2, `${hostOptions} options`);
    check('the kind choice waits until a host is chosen',
      !(await win.isVisible(t('new-project-choice'))));

    // Choosing a host must advance AND be remembered — the catalogue and the
    // create command both depend on it.
    await win.click(t('host-picker-test'));
    await win.waitForTimeout(400);
    check('choosing a host advances to the kind choice',
      await win.isVisible(t('new-project-choice'))
      && !(await win.isVisible(t('new-project-host'))));
    check('the chosen host is remembered',
      await win.evaluate(() => window.__newProjectHost()) === 'picker-test');

    // The framework catalogue is per host: a remote host offers whatever ITS
    // CLI ships, and a single cache would serve the previous host's list.
    const catalogSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
    check('the framework catalogue is cached per host, not globally',
      /frameworkCatalogHost === hostId/.test(catalogSrc));

    // Windows has no local Zeltro, so 'local' must not be offered there. Cannot
    // be run here, so assert the decision.
    const hostStepSrc = catalogSrc.slice(catalogSrc.indexOf('async function showProjectHostStep'),
                                         catalogSrc.indexOf('function chooseProjectHost'));
    check('local is offered only when this machine can run Zeltro',
      /if \(caps\.localZeltro\)/.test(hostStepSrc));
    check('a machine with no hosts at all points at the settings that fix it',
      /no-hosts-settings/.test(hostStepSrc) && /remoteOnly/.test(hostStepSrc));

    // Put back exactly what this machine had, rather than leaving it empty.
    await win.evaluate(async (profiles) => {
      await require('electron').ipcRenderer.invoke('save-ssh-store', profiles);
    }, savedProfiles);
    await win.evaluate(() => window.closeModal());
    await win.waitForTimeout(200);
    await win.click(t('new-project'));
    await win.waitForTimeout(700);
    if (await win.isVisible(t('new-project-host'))) {
      await win.click('#new-project-host .kind-option');
      await win.waitForTimeout(400);
    }

    await win.click(t('kind-framework'));
    check('choosing a framework reveals the form and its footer',
      await win.isVisible('#new-project-form') && await win.isVisible('#new-project-footer'));

    // Assert against the CLI's catalogue, not a list copied into the test —
    // a hardcoded list here would drift exactly the way the form used to.
    const fwCatalog = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('get-framework-catalog')({})
    );
    check('framework catalogue loads from the CLI',
      !fwCatalog.error && fwCatalog.frameworks.length > 0,
      fwCatalog.error || `${fwCatalog.frameworks?.length} frameworks`);

    // Two dropdowns now, so "every framework is offered" means every one is
    // reachable through some runtime — not that they are all on screen at once.
    await win.waitForFunction(
      () => document.querySelectorAll('#framework-runtime option').length > 0,
      null, { timeout: 10000 }
    );

    const offered = await win.evaluate(() => {
      const runtimeSel = document.getElementById('framework-runtime');
      const seen = [];
      for (const opt of runtimeSel.options) {
        runtimeSel.value = opt.value;
        window.onRuntimeChange();
        for (const f of document.getElementById('framework-choice').options) seen.push(f.value);
      }
      return seen;
    });
    const expectedFw = fwCatalog.frameworks.map((f) => f.slug);
    check(`every framework the CLI has is reachable (${expectedFw.length})`,
      expectedFw.length === offered.length && expectedFw.every((s) => offered.includes(s)),
      `missing: ${expectedFw.filter((s) => !offered.includes(s)).join(',') || 'none'}`);

    // The runtime tiers come from the catalogue, not a list invented here — a
    // hardcoded three would silently hide a fourth if the CLI added one.
    const tiers = await win.evaluate(() =>
      [...document.querySelectorAll('#framework-runtime option')].map((o) => o.value));
    const catalogRuntimes = [...new Set(fwCatalog.frameworks.map((f) => f.runtime))];
    check('runtime tiers come from the catalogue',
      tiers.length === catalogRuntimes.length && catalogRuntimes.every((r) => tiers.includes(r)),
      `${tiers.join(', ')} vs ${catalogRuntimes.join(', ')}`);

    // Each framework must offer only the engines it actually supports. This is
    // the bug that made the form send `--database mysql` for all of them.
    for (const fw of fwCatalog.frameworks) {
      await win.selectOption(t('framework-runtime'), fw.runtime);
      await win.waitForTimeout(150);
      await win.selectOption(t('framework-choice'), fw.slug);
      const opts = await win.locator('#project-database option')
        .evaluateAll((els) => els.map((e) => e.value));

      // "" is the Auto entry, which sends no --database at all.
      const engines = opts.filter((v) => v !== '');
      const ok = engines.length === fw.databases.length
        && fw.databases.every((d) => engines.includes(d));
      if (!ok) {
        check(`${fw.slug} offers exactly its supported engines`, false,
          `expected [${fw.databases}] got [${engines}]`);
        break;
      }
    }
    check('every framework offers exactly its supported engines', true);

    // WordPress is the sharp case: MySQL only.
    await win.selectOption(t('framework-runtime'), 'PHP 8.3');
    await win.waitForTimeout(150);
    await win.selectOption(t('framework-choice'), 'wordpress');
    const wpEngines = await win.locator('#project-database option')
      .evaluateAll((els) => els.map((e) => e.value).filter((v) => v !== ''));
    check('wordpress offers only mysql', wpEngines.length === 1 && wpEngines[0] === 'mysql',
      wpEngines.join(','));

    // Version inputs only appear where --version means something.
    // Only laravel and wordpress genuinely honour --version. php's documented
    // "8 or 7" is dead (frameworks/php.sh reads no version and the only image is
    // nginx-php8), and octobercms pins its own, so offering a control for those
    // would be lying about what the CLI will do.
    await win.selectOption(t('framework-runtime'), 'PHP 8.3');
    await win.waitForTimeout(150);
    await win.selectOption(t('framework-choice'), 'laravel');
    check('laravel offers a version field', await win.isVisible('#laravel-version-group'));
    await win.selectOption(t('framework-runtime'), 'PHP 8.3');
    await win.waitForTimeout(150);
    await win.selectOption(t('framework-choice'), 'wordpress');
    check('wordpress offers a version field', await win.isVisible('#wordpress-version-group'));
    for (const fw of ['php', 'django', 'octobercms', 'express']) {
      const fwRuntime = fwCatalog.frameworks.find((f) => f.slug === fw)?.runtime;
      if (fwRuntime) {
        await win.selectOption(t('framework-runtime'), fwRuntime);
        await win.waitForTimeout(150);
      }
      await win.selectOption(t('framework-choice'), fw);
      const anyVersion = (await win.isVisible('#laravel-version-group'))
        || (await win.isVisible('#wordpress-version-group'));
      check(`${fw} offers no version field`, !anyVersion);
    }

    // The catalogue note is the only thing that explains an in-house framework.
    await selectFramework(win, fwCatalog, 'kavera');
    await win.waitForTimeout(200);
    const kaveraNote = await win.textContent('#framework-note');
    check('shows the catalogue note for an in-house framework',
      (kaveraNote || '').length > 20, kaveraNote || '<empty>');

    // Same trap as the install modal: 13 frameworks plus a long catalogue note
    // makes this form tall enough to push the submit button off screen.
    const submitVisible = await win.locator(t('create-project-submit')).evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.bottom <= window.innerHeight && box.top >= 0 && box.height > 0;
    });
    check('create button stays within the viewport with the full catalogue', submitVisible);

    await screenshot(win, '05-new-project');
    await win.click('#new-project-modal .modal-close');

    // --- Main-process IPC, exercised directly ---------------------------
    console.log('\nipc');

    // Every packaged install failed with "spawn zeltro ENOENT" from the panel
    // launcher while working from a terminal, because a .desktop launch has no
    // /usr/local/bin on PATH. Testing it from this shell proves nothing — the
    // PATH has to actually be taken away.
    const zeltroCmd = await app.evaluate(async ({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers.get('get-zeltro-command');
      if (!handler) return { error: 'get-zeltro-command not registered' };
      const before = process.env.PATH;
      process.env.PATH = '/nonexistent';
      const stripped = await handler({});
      process.env.PATH = before;
      const normal = await handler({});
      return { stripped, normal };
    });
    check('zeltro resolves from PATH when it is there',
      !zeltroCmd.error && zeltroCmd.normal?.command?.endsWith('zeltro'),
      zeltroCmd.error || JSON.stringify(zeltroCmd.normal));
    // The install check is a SEPARATE path from the resolver, and it was the one
    // still running a bare `zeltro`. It is the first decision the app makes: get
    // it wrong and the whole UI is replaced by the installer.
    //
    // The realistic failure is a .desktop launch, or a macOS app opened from
    // Finder — PATH without /usr/local/bin, not PATH empty. An empty PATH is not
    // a valid test: the CLI is a bash script that needs git, sed and awk, so it
    // fails for reasons that have nothing to do with how it was invoked.
    const statusMinimal = await app.evaluate(async ({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers.get('get-zeltro-status');
      if (!handler) return { error: 'get-zeltro-status not registered' };
      const before = process.env.PATH;
      const normal = await handler({});
      process.env.PATH = '/usr/bin:/bin';   // what a .desktop launch gets
      const minimal = await handler({});
      process.env.PATH = before;
      return { normal, minimal };
    });
    check('the install check survives a launcher PATH without /usr/local/bin',
      !statusMinimal.error && statusMinimal.minimal === statusMinimal.normal,
      JSON.stringify(statusMinimal));

    // On this machine /usr/bin/zeltro happens to exist, so the check above
    // cannot tell a resolved call from a bare one. Assert the mechanism too, so
    // it holds on a machine where only /usr/local/bin has it.
    const statusSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/main.ts'), 'utf8');
    const checkBody = statusSrc.slice(statusSrc.indexOf('function checkZeltroStatus'));
    check('the install check invokes zeltro by resolved path, not by name',
      /resolveZeltro\(\)/.test(checkBody.slice(0, 900))
      && !/execSync\('zeltro /.test(checkBody.slice(0, 900)));

    check('zeltro still resolves with PATH stripped, as a menu launch has it',
      !zeltroCmd.error &&
      (zeltroCmd.stripped?.command?.startsWith('/') || zeltroCmd.stripped?.command === 'bash'),
      JSON.stringify(zeltroCmd.stripped));

    const catalog = await app.evaluate(async ({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers.get('get-app-catalog');
      if (!handler) return { error: 'get-app-catalog not registered' };
      return handler({});
    });
    check('get-app-catalog IPC returns the catalogue',
      !catalog.error && Array.isArray(catalog.apps) && catalog.apps.length > 50,
      catalog.error || `${catalog.apps?.length} apps`);

    const shaped = catalog.apps?.[0] || {};
    check('catalogue entries carry slug/display/database/note',
      ['slug', 'display', 'database', 'note'].every((k) => k in shaped),
      JSON.stringify(shaped));
    // --- Modal wiring ---------------------------------------------------
    console.log('\nmodal wiring');

    // The Help modal is gone, along with the functions that opened it. It had
    // already lost its button; leaving the markup and a window.showHelpModal
    // behind meant a help screen that was still reachable but unreferenced.
    const helpGone = await win.evaluate(() => ({
      markup: !!document.getElementById('help-modal'),
      opener: typeof window.showHelpModal === 'function',
      cliHelp: typeof window.showCliHelp === 'function'
    }));
    check('the help screen is gone, markup and openers alike',
      !helpGone.markup && !helpGone.opener && !helpGone.cliHelp,
      JSON.stringify(helpGone));

    // Action buttons must not sit flush against the modal's edges. .form-actions
    // carried only padding-top, so the modals using it had their buttons butted
    // against the bottom and right while the .modal-footer ones looked fine —
    // which is why it read as "some modals" rather than all of them.
    //
    // Measure the BUTTONS, not the row: the row's padding is inside it, so a row
    // flush with the modal edge can still hold buttons with plenty of clearance.
    const actionGaps = await win.evaluate(() => {
      const out = [];
      for (const m of document.querySelectorAll('.modal')) {
        const row = m.querySelector('.form-actions, .modal-footer');
        if (!row) continue;
        m.classList.add('show');
        const content = m.querySelector('.modal-content').getBoundingClientRect();
        const btns = [...row.querySelectorAll('button')]
          .filter((b) => b.getBoundingClientRect().width > 0);
        if (btns.length) {
          out.push({
            id: m.id,
            bottom: Math.round(content.bottom - Math.max(...btns.map((b) => b.getBoundingClientRect().bottom))),
            right: Math.round(content.right - Math.max(...btns.map((b) => b.getBoundingClientRect().right)))
          });
        }
        m.classList.remove('show');
      }
      return out;
    });
    const butted = actionGaps.filter((g) => g.bottom < 8 || g.right < 8);
    check('modal action buttons clear the modal edges',
      actionGaps.length > 0 && butted.length === 0,
      butted.length ? JSON.stringify(butted) : `${actionGaps.length} action rows checked`);

    // Every modal must be a top-level element for the same reason.
    const badlyNested = await win.evaluate(() =>
      [...document.querySelectorAll('.modal')]
        .filter((m) => m.parentElement && m.parentElement.closest('.modal'))
        .map((m) => m.id));
    check('no modal is nested inside another', badlyNested.length === 0, badlyNested.join(','));

    // Modals that should open from a standing start. About was here and is
    // gone; updates replaced it as the footer window.
    for (const id of ['updates-modal']) {
      await win.evaluate((m) => window.showModal(m), id);
      await win.waitForTimeout(400);
      check(`${id} actually becomes visible`, await win.isVisible(`#${id}`));
      await win.evaluate(() => window.closeModal());
      await win.waitForTimeout(300);
    }

    // showFieldError used to delete the markup's <div id="…-error"> and append
    // an id-less replacement, making every one of those ids dead weight.
    const errorSlots = await win.evaluate(() => {
      const before = [...document.querySelectorAll('[id$="-error"]')].map((e) => e.id);
      window.showFieldError('create-idea', 'test message');
      const after = [...document.querySelectorAll('[id$="-error"]')].map((e) => e.id);
      const filled = document.getElementById('create-idea-error')?.textContent || '';
      window.clearFieldErrors();
      const cleared = document.getElementById('create-idea-error')?.textContent || '';
      const survived = [...document.querySelectorAll('[id$="-error"]')].map((e) => e.id);
      return { before: before.length, after: after.length, filled, cleared, survived: survived.length };
    });
    check('showFieldError writes into the markup\'s own error slot',
      errorSlots.filled === 'test message', JSON.stringify(errorSlots));
    check('clearFieldErrors empties rather than destroys the slot',
      errorSlots.cleared === '' && errorSlots.survived === errorSlots.before,
      JSON.stringify(errorSlots));

    // --- AI agent settings ----------------------------------------------
    console.log('\nai agent settings');
    await win.click(t('settings-open'));
    await win.waitForSelector('#settings-modal.show', { timeout: 8000 });
    check('Settings panel opens', await win.isVisible('#settings-modal'));


    // Settings opens on Appearance; the AI form lives behind the second tab.
    check('Settings opens on the Appearance tab',
      await win.isVisible('[data-settings-panel="appearance"]')
      && !(await win.isVisible('[data-settings-panel="ai"]')));

    // --- Project layout --------------------------------------------------
    await win.click(t('settings-tab-layout'));
    await win.waitForTimeout(150);
    check('Project layout tab reveals its controls',
      await win.isVisible('#layout-per-row') && await win.isVisible('#layout-terminal-host'));
    check('projects per row defaults to 2 and stops at 4',
      await win.inputValue('#layout-per-row') === '2' &&
      (await win.locator('#layout-per-row option').evaluateAll((o) => o.map((x) => x.value)))
        .join(',') === '1,2,3,4');
    check('the CLI opens inside Zeltro by default',
      await win.inputValue('#layout-terminal-host') === 'tile');

    // The setting has to reach the grid as a data attribute, not an inline
    // style — an inline style would beat the narrow-window rules that cap it.
    await win.selectOption('#layout-per-row', '4');
    await win.waitForTimeout(150);
    const gridAttrs = await win.evaluate(() => {
      const g = document.getElementById('projects-grid');
      return { attr: g.getAttribute('data-per-row'), inline: g.style.getPropertyValue('--per-row') };
    });
    check('projects per row lands on the grid as an attribute',
      gridAttrs.attr === '4' && gridAttrs.inline === '', JSON.stringify(gridAttrs));

    // A wide setting must still be capped on a narrow window, or four tiles
    // become four unreadable slivers.
    const capped = await win.evaluate(() => {
      const g = document.getElementById('projects-grid');
      return getComputedStyle(g).getPropertyValue('--per-row').trim();
    });
    check('the effective column count respects the window width',
      capped === '4' || capped === '2' || capped === '1', `--per-row=${capped}`);

    await win.selectOption('#layout-per-row', '2');
    await win.waitForTimeout(150);

    // --- SSH host profiles ------------------------------------------------
    await win.click(t('settings-tab-hosts'));
    await win.waitForTimeout(200);
    check('SSH Hosts tab reveals its panel',
      await win.isVisible('#ssh-profile-list') && await win.isVisible(t('ssh-add')));

    // Snapshot the REAL stored profiles, from the main process, which owns them.
    // The previous version counted the renderer's in-memory array and later
    // saved that array back — and if it was stale or not yet loaded, saving it
    // wiped the file. This machine has real hosts configured; a test must put
    // them back exactly, not approximately.
    const sshSnapshot = await app.evaluate(async ({ ipcMain }) => {
      const s = await ipcMain._invokeHandlers.get('get-ssh-store')({});
      return { credentials: s.credentials, hosts: s.hosts };
    });
    const sshBefore = sshSnapshot.hosts.length;

    await win.click(t('ssh-add'));
    await win.waitForTimeout(300);
    check('adding a host renders an editable row',
      await win.locator(t('ssh-profile-0')).count() === 1);

    // A new profile must default to something usable rather than blank —
    // port 22 and a key path are the same on nearly every host.
    const defaults = await win.evaluate(() => window.__sshProfiles().slice(-1)[0]);
    check('a new host defaults to port 22 and a key path',
      defaults.port === 22 && defaults.keyPath.includes('.ssh'),
      JSON.stringify(defaults));

    // Profiles live in the main process, because the executor does. A round
    // trip through disk is what proves the renderer is not the only owner.
    await win.fill(t('ssh-host-0'), '192.0.2.99');
    await win.waitForTimeout(300);
    const persisted = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('get-ssh-profiles')({}));
    check('edits persist through the main process, not just the renderer',
      persisted.some((p) => p.host === '192.0.2.99'),
      JSON.stringify(persisted.map((p) => p.host)));

    // The stored file must never contain key material — only a path to it.
    // Read from the test process: `require` is not defined inside
    // app.evaluate, which injects the electron module and nothing else.
    const userDataDir = await app.evaluate(async ({ app: a }) => a.getPath('userData'));
    let storedRaw = '';
    try {
      storedRaw = require('fs').readFileSync(
        require('path').join(userDataDir, 'ssh-hosts.json'), 'utf8');
    } catch { /* asserted below */ }
    check('no private key material is written to disk',
      storedRaw.length > 0 && !/BEGIN [A-Z ]*PRIVATE KEY/.test(storedRaw)
        && !/"password"/.test(storedRaw),
      storedRaw.slice(0, 60));

    // Editing connection details must clear a stale result: "reachable" beside
    // a host that has since been re-pointed is a claim about a different
    // machine.
    const staleCleared = await win.evaluate(async () => {
      const p = window.__sshProfiles().slice(-1)[0];
      const idx = window.__sshProfiles().length - 1;
      window.testSshProfile; // referenced so the hook is real
      // Simulate a completed test, then edit the host.
      // Scoped to the host list. The same status class is used elsewhere in
      // Settings now — the GitHub panel renders one — and an unscoped query
      // found that instead, so this passed or failed on an unrelated panel.
      const list = document.getElementById('ssh-profile-list');
      const before = list.querySelector('.ssh-status') !== null;
      window.updateSshProfile(idx, 'host', '192.0.2.100');
      return { before, after: list.querySelector('.ssh-status.ok') === null };
    });
    check('editing a host clears any stale reachability claim', staleCleared.after);

    // MULTIPLE hosts is the point of the feature — one host is the degenerate
    // case, and a list that silently overwrites instead of appending would pass
    // every single-host check above.
    await win.click(t('ssh-add'));
    await win.waitForTimeout(200);
    await win.click(t('ssh-add'));
    await win.waitForTimeout(300);
    // A username lives on a credential now, not on the host, so the hosts
    // reference one. That separation is the point: several machines reached with
    // the same account share one set of details instead of repeating them.
    // Created through the UI, then found by identity rather than by index.
    // Index arithmetic breaks the moment the list holds anything else, and a
    // real machine's list does.
    await win.click(t('remotes-tab-profiles'));
    await win.waitForTimeout(200);
    const credCountBefore = await win.evaluate(() => window.__sshCredentials().length);
    await win.click(t('cred-add'));
    await win.waitForTimeout(400);
    await win.fill(t(`cred-label-${credCountBefore}`), 'test account');
    await win.fill(t(`cred-user-${credCountBefore}`), 'ubuntu');
    await win.waitForTimeout(400);
    const testCredId = await win.evaluate(() =>
      window.__sshCredentials().find((c) => c.label === 'test account')?.id);
    check('a credential created in the UI is saved and findable',
      typeof testCredId === 'string' && testCredId.length > 0,
      String(testCredId));

    // Back to Hosts: the two lists are separate subtabs now, so only one set of
    // controls is on screen at a time.
    await win.click(t('remotes-tab-hosts'));
    await win.waitForTimeout(200);
    await win.fill(t('ssh-label-0'), 'ec2-ubuntu');
    await win.fill(t('ssh-host-0'), '44.202.33.176');
    await win.fill(t('ssh-label-1'), 'ec2-arch');
    await win.fill(t('ssh-host-1'), '52.23.206.186');
    await win.fill(t('ssh-label-2'), 'mac-m1');
    await win.fill(t('ssh-host-2'), '192.168.1.193');
    for (const i of [0, 1, 2]) {
      await win.selectOption(t(`ssh-cred-${i}`), testCredId);
    }
    await win.waitForTimeout(400);

    const rows = await win.locator('.ssh-profile').count();
    check('three hosts render as three independent rows', rows >= 3, `${rows} rows`);

    const multi = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('get-ssh-profiles')({}));
    const labels = multi.map((p) => p.label);
    check('all three persist, each keeping its own host',
      ['ec2-ubuntu', 'ec2-arch', 'mac-m1'].every((l) => labels.includes(l))
      && multi.find((p) => p.label === 'ec2-arch')?.host === '52.23.206.186'
      && multi.find((p) => p.label === 'mac-m1')?.host === '192.168.1.193',
      JSON.stringify(multi.map((p) => `${p.label}@${p.host}`)));

    // One credential serving several hosts is the reason it is a separate
    // thing; if each host copied it, editing an account would mean editing it
    // once per machine.
    check('several hosts can share one credential',
      [0, 1, 2].every((i) => multi[i]?.credentialId === testCredId),
      JSON.stringify(multi.map((p) => p.credentialId)));

    // Ids must be distinct, or a test result would attach to the wrong row.
    const ids = multi.map((p) => p.id);
    check('every host gets a distinct id', new Set(ids).size === ids.length, ids.join(','));

    // Removing the middle one must not disturb its neighbours.
    const middleIdx = multi.findIndex((p) => p.label === 'ec2-arch');
    await win.evaluate(async (i) => {
      window.confirm = () => true;
      await window.removeSshProfile(i);
    }, middleIdx);
    await win.waitForTimeout(300);
    const afterRemove = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('get-ssh-profiles')({}));
    const remaining = afterRemove.map((p) => p.label);
    check('removing one host leaves the others intact',
      !remaining.includes('ec2-arch')
      && remaining.includes('ec2-ubuntu') && remaining.includes('mac-m1'),
      remaining.join(','));

    // Two properties of the remote invocation, both found on a real Mac and
    // both invisible against a Linux host.
    // Required locally: fsMod/pathMod/ROOT are declared later in this file, so
    // referencing them here is a temporal-dead-zone error.
    const mainSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/main.ts'), 'utf8');
    const sshBlock = mainSrc.slice(mainSrc.indexOf('REMOTE_ZELTRO_CANDIDATES'),
                                   mainSrc.indexOf("ipcMain.handle('get-zeltro-command'"));

    // zeltro is at /usr/local/bin from the script installers and /usr/bin from
    // the .deb, deliberately so they can coexist. Hardcoding either makes the
    // other report "command not found", which is indistinguishable from "not
    // installed" over a non-interactive ssh.
    check('the remote zeltro path is probed, not hardcoded',
      /\/usr\/local\/bin\/zeltro/.test(sshBlock) && /\/usr\/bin\/zeltro/.test(sshBlock)
      && /test -x/.test(sshBlock),
      'expected both candidate paths and an executable probe');

    // Resolving zeltro is necessary but not sufficient: zeltro itself shells
    // out to docker, and on the Mac that failed with "docker: command not
    // found" while /usr/local/bin/docker existed the whole time.
    check('remote commands set a PATH the CLI\'s own children can use',
      /PATH=\/usr\/local\/bin:\/opt\/homebrew\/bin:\$PATH/.test(sshBlock),
      'expected an explicit PATH prefix on remote exec');

    // `command -v zeltro` would need a login shell, and a login shell sources
    // rc files whose output lands in a stream being parsed as JSON.
    check('the probe avoids a login shell',
      !/command -v zeltro/.test(withoutComments(sshBlock)));

    // A remote host has the same three states the local one does, and the GUI
    // shows the installer for the middle one locally. Remotely it has to at
    // least SAY which state it is in: "0 projects" or an unparseable-output
    // error for an unconfigured host tells nobody to run `zeltro configure`.
    const sshSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/main.ts'), 'utf8');
    const testBlock = sshSrc.slice(sshSrc.indexOf("ipcMain.handle('test-ssh-profile'"),
                                   sshSrc.indexOf('// Exposed so the resolution can be exercised'));
    check('the connection test distinguishes not-installed from not-configured',
      /stage: 'zeltro'|'zeltro',/.test(testBlock) && /'configure',/.test(testBlock)
      && /PROJECTS_DIR=/.test(testBlock),
      'expected separate zeltro-missing and not-configured outcomes');
    check('the unconfigured message names the command that fixes it',
      /zeltro configure/.test(testBlock));

    // --- Windows is remote-only -------------------------------------------
    //
    // Cannot be verified by running it here, so assert the decision rather than
    // the outcome. Zeltro is Docker plus bash scripts and the deliberate call is
    // remote hosts rather than WSL, so on Windows there is no local install to
    // make and the installer — which installs and configures a LOCAL CLI —
    // would offer something that cannot succeed.
    const winSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/main.ts'), 'utf8');
    const chooser = winSrc.slice(winSrc.indexOf('const zeltroStatus: string = checkZeltroStatus()'),
                                 winSrc.indexOf('// Open DevTools in development'));
    check('Windows skips the installer and loads the dashboard',
      /win32/.test(chooser) && chooser.indexOf('win32') < chooser.indexOf('installer.html'),
      'expected the win32 branch to come before any installer.html load');

    const platformCaps = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('get-platform-capabilities')({}));
    check('the app reports whether it can run Zeltro locally',
      typeof platformCaps.localZeltro === 'boolean' && typeof platformCaps.remoteOnly === 'boolean'
      && platformCaps.remoteOnly === (platformCaps.platform === 'win32'),
      JSON.stringify(platformCaps));

    // Remote configure must not hang on a sudo password prompt nobody can
    // answer — `sudo -n` fails immediately instead, so the user is told the
    // real reason rather than "timed out".
    const cfgHandler = winSrc.slice(winSrc.indexOf("ipcMain.handle('configure-ssh-host'"));
    check('remote configure fails fast rather than waiting on a sudo prompt',
      /sudo -n true/.test(cfgHandler.slice(0, 1400))
      && /password/i.test(cfgHandler.slice(0, 1400)));

    // A probe against a blocked port is the slow case, and the one that makes a
    // GUI look frozen: a dropped SYN with no RST runs the timeout out in full.
    // Measured on a real security-group-blocked address — an unroutable IP errors
    // in 7ms and bad DNS in 11ms, but a blocked port takes the whole timeout.
    // So the timeout has to be a parameter, because install verification wants
    // patience and a clicked link wants a fast answer.
    const probeSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/main.ts'), 'utf8');
    const probeBlock = probeSrc.slice(probeSrc.indexOf("ipcMain.handle('check-project-url'"),
                                      probeSrc.indexOf("ipcMain.handle('check-project-url'") + 1400);
    check('the URL probe takes a caller-supplied timeout',
      /timeoutMs/.test(probeBlock) && /timeout: timeoutMs/.test(probeBlock));

    // "Nothing answered in time" and "the network refused" are different facts,
    // and only one of them justifies telling someone about a firewall rule.
    check('a timed-out probe is distinguishable from a refused one',
      /timedOut: true/.test(probeBlock));

    // Both outcomes must be fast enough not to look like a hang, and the values
    // are asserted end to end rather than by reading the source.
    const probeTiming = await app.evaluate(async ({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers.get('check-project-url');
      const t0 = Date.now();
      // TEST-NET-1, reserved and unroutable — no host can answer it.
      const r = await handler({}, '192.0.2.1:80', 1200);
      return { r, ms: Date.now() - t0 };
    });
    check('an unreachable probe returns within its timeout rather than hanging',
      probeTiming.ms < 3000 && probeTiming.r.code === 0,
      `${probeTiming.ms}ms, ${JSON.stringify(probeTiming.r)}`);

    // A remote project's agent runs on that host — Shawn's decision, and the
    // only coherent one: `zeltro resume` cds into the project directory and
    // starts the agent there, so files, container and agent share a machine.
    // It follows that the agent's install and API key live there too.
    const aiSrc = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
    // Bounded by the next function rather than a character count. A fixed
    // window cut off just before `hostId: host` and reported a real property as
    // missing — the assertion was measuring my guess at the function's length.
    const modifyStart = aiSrc.indexOf('async function modifyWithAI');
    const modifyEnd = aiSrc.indexOf('\nasync function ', modifyStart + 10);
    const modifyBlock = aiSrc.slice(modifyStart, modifyEnd > 0 ? modifyEnd : modifyStart + 3000);
    check('the agent check asks the host the agent will run on',
      /get-ai-agent', host/.test(modifyBlock));
    check('the projects directory comes from that host too',
      /get-projects-dir-on', host/.test(modifyBlock));
    check('the terminal opens on the project\'s host',
      /hostId: host/.test(modifyBlock));
    // Two hosts can each have a project of this name; a shared session key
    // would focus the wrong machine's terminal.
    check('agent session keys are host-scoped',
      /resume-\$\{host\}-\$\{projectName\}/.test(modifyBlock));

    // --- Executor ---------------------------------------------------------
    //
    // Remote execution needs a reachable host, which a test suite cannot
    // guarantee, so the network path is verified by hand. What IS tested here
    // is the part that must hold with no network at all: a command must never
    // run against the wrong machine.
    const localExec = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('execute-zeltro-on')({}, 'local', 'status', ['--all', '--json-output']));
    check('the executor runs commands on the local host',
      localExec.code === 0 && localExec.stdout.startsWith('{'),
      `code ${localExec.code}: ${(localExec.stderr || '').slice(0, 80)}`);

    // The dangerous failure: a project pointing at a host that has since been
    // removed. Falling back to local would run the command against a different
    // machine and report success — worse than any error.
    const ghost = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('execute-zeltro-on')({}, 'no-such-host-id', 'status', ['--json-output']));
    check('an unknown host fails rather than silently running locally',
      ghost.code !== 0 && /no ssh host/i.test(ghost.stderr) && ghost.stdout === '',
      JSON.stringify(ghost).slice(0, 120));

    // Saving profiles must drop cached connections: a host or key edit means a
    // reused connection is talking to a machine the profile no longer
    // describes.
    const mainSrcExec = require('fs').readFileSync(
      require('path').join(require('./helpers').ROOT, 'src/main.ts'), 'utf8');
    const saveHandler = mainSrcExec.slice(mainSrcExec.indexOf("ipcMain.handle('save-ssh-store'"));
    check('saving profiles disposes cached connections',
      /disposeExecutors\(\)/.test(saveHandler.slice(0, 900)));

    // The pre-credential writer took a bare array. Leaving it registered would
    // let one stale caller wipe every credential and leave each host pointing at
    // an id that no longer exists.
    check('the legacy array writer is gone, not merely unused',
      !/ipcMain\.handle\('save-ssh-profiles'/.test(mainSrcExec));

    // Restore the exact snapshot rather than trimming whatever the renderer
    // happens to hold.
    await win.evaluate(async (profiles) => {
      await require('electron').ipcRenderer.invoke('save-ssh-store', profiles);
    }, sshSnapshot);
    await win.waitForTimeout(300);
    const cleaned = await app.evaluate(async ({ ipcMain }) => {
      const s = await ipcMain._invokeHandlers.get('get-ssh-store')({});
      return { credentials: s.credentials, hosts: s.hosts };
    });
    check('the suite restores the hosts exactly as it found them',
      JSON.stringify(cleaned.hosts) === JSON.stringify(sshSnapshot.hosts)
      && cleaned.credentials.length === sshSnapshot.credentials.length,
      `${cleaned.hosts.length} hosts / ${cleaned.credentials.length} creds vs `
      + `${sshSnapshot.hosts.length} / ${sshSnapshot.credentials.length}`);

    await win.click(t('settings-tab-ai'));
    await win.waitForTimeout(150);
    check('AI tab reveals the agent form', await win.isVisible('#ai-agent'));

    const agentOptions = await win.locator('#ai-agent option').evaluateAll((o) => o.map((x) => x.value));
    check('offers every agent the CLI supports plus none',
      ['', 'claude', 'codex', 'gemini', 'aider'].every((a) => agentOptions.includes(a)),
      agentOptions.join(','));

    // aider is the only agent needing a model and an endpoint — ai-set --help
    // marks model and key required for it, and --api-base is aider-only.
    await win.selectOption('#ai-agent', 'aider');
    await win.waitForTimeout(250);
    check('aider reveals the API endpoint field', await win.isVisible('#ai-api-base-group'));
    check('aider marks the model required',
      /required/i.test((await win.textContent('#ai-model-req')) || ''));

    await win.fill(t('ai-model'), '');
    await win.click(t('ai-settings-save'));
    await win.waitForTimeout(600);
    check('aider without a model is rejected before shelling out',
      ((await win.textContent('#ai-model-error')) || '').length > 0,
      await win.textContent('#ai-model-error'));


    // qwen is the fifth agent, but only offered when the INSTALLED CLI has it.
    // The cheap-models support is on zeltro-cli `dev`, not its `master`, so a
    // current install has no qwen — offering it would produce "Unsupported AI
    // agent" at the point of use. The GUI adapts rather than assuming.
    const caps = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('get-cli-capabilities')({}));
    const qwenUsable = await win.evaluate(() => {
      const o = document.querySelector('#ai-agent option[value="qwen"]');
      return !!o && !o.hidden && !o.disabled;
    });
    check('qwen offered exactly when the installed CLI supports it',
      qwenUsable === caps.qwen, `cli.qwen=${caps.qwen} offered=${qwenUsable}`);

    // The Preset dropdown is gone — it reassigned the agent behind the user's
    // back and its "Custom" entry did nothing at all.
    check('the preset dropdown is gone', await win.locator('#ai-preset').count() === 0);

    // --api-base is no longer aider-only: the CLI passes it to whichever env var
    // each agent reads. gemini is the only one with no endpoint at all. claude
    // has one but keeps it folded behind a reveal.
    for (const [agent, shouldShow] of [['codex', true], ['qwen', true], ['gemini', false]]) {
      await win.selectOption('#ai-agent', agent);
      await win.waitForTimeout(250);
      check(`${agent} endpoint field ${shouldShow ? 'shown' : 'hidden'}`,
        (await win.isVisible('#ai-api-base-group')) === shouldShow);
    }

    // Claude Code signs in to Anthropic on its own, so an empty URL field is
    // noise at best and an invitation to a wrong value at worst.
    await win.evaluate(() => { document.getElementById('ai-api-base').value = ''; });
    await win.selectOption('#ai-agent', 'claude');
    await win.waitForTimeout(250);
    check('claude hides the endpoint behind a reveal',
      !(await win.isVisible('#ai-api-base-group')) && await win.isVisible(t('ai-api-base-reveal')));

    await win.click(t('ai-api-base-reveal'));
    await win.waitForTimeout(250);
    check('the reveal opens the endpoint field', await win.isVisible('#ai-api-base-group'));

    // claude needs an Anthropic-compatible proxy — pointing it at a raw Ollama
    // URL is the obvious mistake, so the note has to say so.
    check('claude endpoint note warns it must be Anthropic-compatible',
      /anthropic/i.test((await win.textContent('#ai-api-base-help')) || ''),
      await win.textContent('#ai-api-base-help'));

    // An endpoint already in force must never be hidden — that would make the
    // panel show a configuration the CLI is not using.
    await win.evaluate(() => {
      document.getElementById('ai-api-base').value = 'https://proxy.example/v1';
      window.onAiAgentChange();
    });
    await win.waitForTimeout(250);
    check('a stored endpoint stays visible rather than folding away',
      await win.isVisible('#ai-api-base-group'));

    // Endpoint chips replace the presets: they fill the field they sit under
    // and are scoped to what the selected agent can actually talk to.
    await win.evaluate(() => { document.getElementById('ai-api-base').value = ''; });
    await win.selectOption('#ai-agent', 'claude');
    await win.waitForTimeout(250);
    check('claude is offered no OpenAI-shaped endpoint chips',
      await win.locator('#ai-endpoint-presets .endpoint-chip').count() === 0);

    await win.selectOption('#ai-agent', 'codex');
    await win.waitForTimeout(250);
    const chips = await win.locator('#ai-endpoint-presets .endpoint-chip').count();
    check('OpenAI-compatible agents get endpoint chips', chips >= 3, `${chips} chips`);

    const agentBefore = await win.inputValue('#ai-agent');
    await win.click(t('endpoint-ollama'));
    await win.waitForTimeout(600);
    const ollama = await win.evaluate(() => ({
      agent: document.getElementById('ai-agent').value,
      base: document.getElementById('ai-api-base').value,
      warning: document.getElementById('ai-local-warning').style.display
    }));
    check('an endpoint chip fills the URL', /11434/.test(ollama.base), ollama.base);
    check('an endpoint chip leaves the agent alone',
      ollama.agent === agentBefore, `${agentBefore} -> ${ollama.agent}`);
    check('a local endpoint surfaces the VRAM warning', ollama.warning === 'block',
      'small models return confident wrong answers — this must be visible');

    await win.click(t('endpoint-openrouter'));
    await win.waitForTimeout(400);
    const remote = await win.evaluate(() => ({
      base: document.getElementById('ai-api-base').value,
      warning: document.getElementById('ai-local-warning').style.display
    }));
    check('a remote endpoint chip fills the URL', /openrouter/.test(remote.base), remote.base);
    check('a remote endpoint hides the VRAM warning', remote.warning === 'none');

    // --- AI autonomy ------------------------------------------------------
    //
    // This setting removes the approval prompt in front of every action the
    // agent takes, so the failure that matters is enabling it by accident or
    // failing to turn it back off.
    const unattendedShown = await win.isVisible('#ai-unattended-group');
    check('autonomy is offered exactly when the CLI supports it',
      unattendedShown === caps.unattended,
      `cli.unattended=${caps.unattended} shown=${unattendedShown}`);

    if (caps.unattended) {
      // The stored value is authoritative, and anything but an explicit "true"
      // must read as off — "unknown" shown as on would be the one dangerous
      // way to be wrong.
      const stored = await app.evaluate(async ({ ipcMain }) =>
        ipcMain._invokeHandlers.get('get-ai-agent-full')({}));
      const boxState = await win.isChecked('#ai-unattended');
      check('autonomy checkbox matches what the agent config actually stores',
        boxState === (stored.unattended === 'true'),
        `stored=${stored.unattended} checked=${boxState}`);

      // Enabling asks first; declining must leave it off.
      const declined = await win.evaluate(async () => {
        const real = window.confirm;
        window.confirm = () => false;
        const box = document.getElementById('ai-unattended');
        box.checked = true;
        window.onUnattendedChange();
        const after = box.checked;
        window.confirm = real;
        return after;
      });
      check('declining the autonomy prompt leaves it off', declined === false);

      // Accepting shows the warning, so the consequence is on screen while it
      // is on rather than only in the dialog that has since closed.
      const accepted = await win.evaluate(async () => {
        const real = window.confirm;
        window.confirm = () => true;
        const box = document.getElementById('ai-unattended');
        box.checked = true;
        window.onUnattendedChange();
        const state = {
          checked: box.checked,
          warning: document.getElementById('ai-unattended-warning').style.display
        };
        box.checked = false;
        window.onUnattendedChange();
        state.warningAfterOff = document.getElementById('ai-unattended-warning').style.display;
        window.confirm = real;
        return state;
      });
      check('accepting turns it on and shows the consequence',
        accepted.checked && accepted.warning === 'block', JSON.stringify(accepted));
      check('turning it off hides the warning again',
        accepted.warningAfterOff === 'none');

      // The flag must be sent in BOTH directions. Sending it only when enabling
      // would make the checkbox one-way — unticking it would silently leave the
      // agent unattended, which is the failure nobody would notice.
      const sent = await win.evaluate(async () => {
        const ipc = require('electron').ipcRenderer;
        const realInvoke = ipc.invoke.bind(ipc);
        const runs = {};
        for (const on of [true, false]) {
          document.getElementById('ai-unattended').checked = on;
          ipc.invoke = async (channel, a, b, c) => {
            // The save is routed to a HOST now rather than spawned locally — a
            // Windows install has no local CLI, which is what issue #64 hit. The
            // flags checked below are unchanged; only the channel moved.
            //   execute-zeltro-stream-on(hostId, subcommand, args)
            if (channel === 'execute-zeltro-stream-on' && b === 'ai-set') {
              runs[on ? 'on' : 'off'] = { host: a, args: (c || []).slice() };
              return { code: 1, stdout: '', stderr: 'intercepted by test' };
            }
            return realInvoke(channel, a, b, c);
          };
          await window.saveAiSettings();
        }
        ipc.invoke = realInvoke;
        return runs;
      });
      check('enabling sends --allow-unattended',
        JSON.stringify(sent.on?.args || []).includes('--allow-unattended'), JSON.stringify(sent.on));
      check('disabling sends --no-allow-unattended, not silence',
        JSON.stringify(sent.off?.args || []).includes('--no-allow-unattended'), JSON.stringify(sent.off));
      // Issue #64: this spawned `zeltro` locally, and a Windows install has no
      // local CLI by design — the report was `spawn zeltro ENOENT`.
      check('the AI settings save targets a host rather than spawning locally',
        typeof sent.on?.host === 'string' && sent.on.host.length > 0, JSON.stringify(sent.on));
    }

    // Switching agents must clear the previous agent's validation message —
    // "aider requires a model" sitting under a field marked (optional) was
    // visible in a screenshot while every assertion passed.
    check('switching agents clears the stale validation error',
      ((await win.textContent('#ai-model-error')) || '').trim() === '',
      await win.textContent('#ai-model-error'));

    await screenshot(win, '08-ai-settings');

    // --- Themes ----------------------------------------------------------
    // The risk here is not "does the attribute change" but "does the theme
    // leave anything unreadable". Contrast is asserted numerically rather than
    // eyeballed from the screenshots, because a low-contrast theme looks fine
    // in a thumbnail and is miserable to actually use.
    console.log('\nthemes');
    await win.click(t('settings-tab-appearance'));
    await win.waitForTimeout(150);

    const swatches = await win.locator('[data-theme-option]').evaluateAll((els) =>
      els.map((e) => e.dataset.themeOption));
    check('offers all five themes',
      ['retro', 'dark', 'light', 'matrix', 'zeltro'].every((x) => swatches.includes(x)),
      swatches.join(','));

    // Relative luminance per WCAG, so the ratio below is the real thing rather
    // than a rough proxy.
    const contrast = (hex1, hex2) => {
      const lum = (hex) => {
        const c = hex.replace('#', '');
        const v = [0, 2, 4].map((i) => {
          const s = parseInt(c.slice(i, i + 2), 16) / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
      };
      const [a, b] = [lum(hex1), lum(hex2)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    };

    for (const theme of ['retro', 'dark', 'light', 'matrix', 'zeltro']) {
      await win.click(t(`theme-${theme}`));
      await win.waitForTimeout(200);

      const applied = await win.evaluate(() =>
        document.documentElement.getAttribute('data-theme'));
      check(`${theme}: applies to the document`, applied === theme, applied);

      const readable = await win.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          bg: cs.getPropertyValue('--bg-primary').trim(),
          fg: cs.getPropertyValue('--text-primary').trim(),
          muted: cs.getPropertyValue('--text-muted').trim(),
          termBg: cs.getPropertyValue('--term-bg').trim(),
          termFg: cs.getPropertyValue('--term-fg').trim()
        };
      });

      // 4.5:1 is the WCAG AA threshold for body text.
      const bodyRatio = contrast(readable.bg, readable.fg);
      check(`${theme}: body text clears 4.5:1 (${bodyRatio.toFixed(1)}:1)`, bodyRatio >= 4.5);

      // Muted text is secondary, so 3:1 (AA large / UI) is the bar.
      const mutedRatio = contrast(readable.bg, readable.muted);
      check(`${theme}: muted text clears 3:1 (${mutedRatio.toFixed(1)}:1)`, mutedRatio >= 3);

      // The one the user explicitly called out: a theme that turns terminal
      // output into mush is worse than not having the theme.
      const termRatio = contrast(readable.termBg, readable.termFg);
      check(`${theme}: terminal text clears 4.5:1 (${termRatio.toFixed(1)}:1)`, termRatio >= 4.5);

      await screenshot(win, `08-theme-${theme}`);
    }

    // Every ANSI colour must be legible on its own theme's terminal background.
    // Light is the one that breaks if the palette is copied from a dark theme:
    // bright yellow and bright white on white are invisible. A build printing
    // npm warnings is the first place a user would notice, so assert it here.
    const palettes = await win.evaluate(() => window.__terminalThemes || null);
    check('terminal palettes exposed for assertion', !!palettes);

    if (palettes) {
      const ansiNames = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
        'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta',
        'brightCyan', 'brightWhite'];
      for (const [theme, pal] of Object.entries(palettes)) {
        // 3:1 is the bar for coloured terminal output: it is decoration on top
        // of text that is already legible in the default foreground, and
        // holding ANSI green to 4.5:1 would force it grey-dark on every theme.
        const weak = ansiNames
          .map((n) => [n, contrast(pal.background, pal[n])])
          .filter(([, r]) => r < 3)
          .map(([n, r]) => `${n} ${r.toFixed(1)}:1`);
        check(`${theme}: every ANSI colour clears 3:1 on its terminal background`,
          weak.length === 0, weak.join(', '));
      }
    }

    // Back to the default so the rest of the run and the screenshots are
    // consistent with every previous baseline.
    await win.click(t('theme-retro'));
    await win.waitForTimeout(200);

    await win.click(t('settings-tab-ai'));
    await win.waitForTimeout(150);
    await win.click('#settings-modal .modal-close');
    await win.waitForTimeout(300);

    // --- Loading overlay output -----------------------------------------
    // Scaffolding runs composer/npm/pip for minutes; the overlay used to show a
    // spinner and nothing else, and it is what captured the nestjs failure.
    console.log('\nloading overlay');
    const overlay = await win.evaluate(async () => {
      window.showLoadingOverlay('Test', 'streaming', true);
      const before = document.getElementById('loading-output').style.display;
      // Simulate what execute-command-stream sends.
      window.__feedOverlay('hello from the CLI\n');
      await new Promise((r) => setTimeout(r, 200));
      const text = document.getElementById('loading-output').textContent;
      window.hideLoadingOverlay();
      const after = document.getElementById('loading-output').style.display;
      return { before, text, afterHidden: after };
    });
    check('overlay shows an output pane when streaming', overlay.before === 'block', overlay.before);
    check('overlay renders streamed output', /hello from the CLI/.test(overlay.text || ''), overlay.text);

    const quiet = await win.evaluate(() => {
      window.showLoadingOverlay('Test', 'no stream');
      const shown = document.getElementById('loading-output').style.display;
      window.hideLoadingOverlay();
      return shown;
    });
    check('overlay stays clean for short actions', quiet === 'none', quiet);

    // A failed create keeps the overlay up with its output, rather than
    // concatenating all of stdout — curl progress bars included — into a toast.
    const failState = await win.evaluate(async () => {
      window.showLoadingOverlay('Creating', 'working', true);
      window.__feedOverlay('some/output\nComposer could not find a composer.json file\n');
      window.failLoadingOverlay('Could not create the project', 'zeltro new exited with code 1.');
      await new Promise((r) => setTimeout(r, 200));
      const spinner = document.querySelector('#loading-overlay .loading-spinner');
      return {
        overlayVisible: document.getElementById('loading-overlay').style.display !== 'none',
        outputVisible: document.getElementById('loading-output').style.display === 'block',
        outputKept: document.getElementById('loading-output').textContent.includes('composer.json'),
        dismissShown: document.getElementById('loading-dismiss').style.display !== 'none',
        spinnerHidden: spinner.style.display === 'none',
        message: document.getElementById('loading-message').textContent
      };
    });
    check('failure keeps the overlay and its output on screen',
      failState.overlayVisible && failState.outputVisible && failState.outputKept,
      JSON.stringify(failState));
    check('failure swaps the spinner for a dismiss button',
      failState.spinnerHidden && failState.dismissShown, JSON.stringify(failState));

    await win.evaluate(() => window.hideLoadingOverlay());
    const restored = await win.evaluate(() => ({
      spinner: document.querySelector('#loading-overlay .loading-spinner').style.display,
      dismiss: document.getElementById('loading-dismiss').style.display
    }));
    check('dismissing restores the overlay for next time',
      restored.spinner !== 'none' && restored.dismiss === 'none', JSON.stringify(restored));

    // The Terminals window is gone. Sessions live in project tiles, which the
    // tile-terminal section below covers — a separate window that tracked
    // sessions in tabs was a second home for something that already had one.

// --- Terminals hosted inside a project tile --------------------------
    //
    // The whole risk here is the projects grid: it is rebuilt from scratch on
    // every status poll, so a terminal living in a tile has to survive having
    // its surroundings replaced.
    if (expectedProjects > 0) {
      console.log('\ntile terminals');
      // Must be a project that actually HAS a tile. This used to take the first
      // project the CLI listed, which on this machine is disabled — and a
      // disabled project is deliberately hidden, so there was no tile for the
      // terminal to attach to and the check failed on a correct behaviour.
      const target = await win.evaluate(() => window.__visibleProjects()[0]?.name);
      if (!target) {
        check('a visible project exists to host a terminal', false,
          'no visible projects — this check cannot prove anything here');
      }

      const opened = target ? await win.evaluate(async (name) => {
        await window.openAgentTerminal({
          title: '✨ ' + name, status: 'test', cwd: '/tmp', command: 'sh',
          args: ['-c', 'echo tile-hello; sleep 120'],
          sessionKey: 'tile-' + name, tileProject: name
        });
        await new Promise((r) => setTimeout(r, 900));
        const card = document.querySelector(`[data-terminal-host="${CSS.escape(name)}"]`);
        // The Terminals window is gone, so there is no tab bar, header button or
        // modal to assert about — only whether the session landed in its tile.
        return { inTile: !!card?.querySelector('.tile-terminal') };
      }, target) : { inTile: false };
      if (target) {
        check('the agent terminal opens inside the project tile', opened.inTile,
          JSON.stringify(opened));
      }
      await screenshot(win, '08-tile-terminal');

      // The Terminals window is gone rather than merely unused: a second home
      // for sessions meant two × buttons that meant different things.
      const rendererSrcT = require('fs').readFileSync(
        require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
      const htmlSrcT = require('fs').readFileSync(
        require('path').join(require('./helpers').ROOT, 'src/index.html'), 'utf8');
      check('the terminals window is removed, not just hidden',
        !/build-terminal-modal|terminals-button|terminal-tabs/.test(htmlSrcT)
        && !/function showTerminals|function activateTerminal/.test(rendererSrcT));

      // Typing into the compose box must survive the ten-second poll.
      //
      // It did not: renderProjects calls detachTileTerminals, which parks each
      // wrapper — and detaching a node blurs whatever is focused inside it. So
      // focus and the caret were lost mid-sentence, roughly twice a minute.
      // Reported from real use before any test covered it.
      const composeSel = `[data-testid="compose-input-${target}"]`;
      if (await win.locator(composeSel).count() > 0) {
        await win.click(composeSel);
        await win.type(composeSel, 'still typing', { delay: 10 });
        await win.evaluate(() => window.loadProjects());
        await win.waitForTimeout(2500);
        const survived = await win.evaluate((s) => {
          const el = document.querySelector(s);
          return { focused: document.activeElement === el, value: el?.value };
        }, composeSel);
        // Focus is asserted through the app's own restore, not the harness:
        // window.evaluate itself moves focus, so this checks the value survived
        // AND that the app put focus back rather than the browser leaving it.
        check('the compose box keeps its text through a refresh',
          survived.value === 'still typing', JSON.stringify(survived));

        const focusSrc = require('fs').readFileSync(
          require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
        // The capture has to precede detachTileTerminals; placed after it, it
        // only ever saw <body> and restored nothing.
        const renderBlock = focusSrc.slice(focusSrc.indexOf('function renderProjects'),
                                           focusSrc.indexOf('function renderProjects') + 3000);
        check('focus is captured before the tile panes are detached',
          renderBlock.indexOf('captureTileFocus()') < renderBlock.indexOf('detachTileTerminals()')
          && renderBlock.includes('captureTileFocus()'));
        check('the caret is restored, not just focus',
          /setSelectionRange\(pendingFocus\.start/.test(focusSrc));
      }

      // The paperclip has to actually render. It did not: an edit adding it was
      // discarded when a later replacement in the same script failed, so the
      // handler existed with nothing to invoke it — invisible in every test that
      // only checked the function was defined.
      check('the attach button is rendered, not just defined',
        await win.locator(`[data-testid="compose-attach-${target}"]`).count() === 1);

      // Ctrl+Enter sends; plain Enter is a newline. The inverse is the chat
      // convention, but this box holds a paragraph written over a minute or two,
      // and a stray Enter would fire it half-written at an agent that then acts
      // on it.
      const composeSrc = require('fs').readFileSync(
        require('path').join(require('./helpers').ROOT, 'src/renderer.ts'), 'utf8');
      check('plain Enter does not send the compose box',
        /e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)/.test(composeSrc));
      check('the send chord is stated in the placeholder',
        /Ctrl\+Enter to send/.test(composeSrc));

      // Attaching writes into the compose box rather than sending on its own:
      // a bare path tells the agent nothing about what to do with the file, and
      // sending would interrupt whatever it is mid-way through.
      const attachBlock = composeSrc.slice(composeSrc.indexOf('async function attachFiles'),
                                           composeSrc.indexOf('function sendCompose'));
      check('an attachment lands in the compose box, not straight at the agent',
        /compose-input-/.test(attachBlock) && !/sendCompose\(/.test(attachBlock));
      check('attachments are named in the message, not counted',
        /result\.attached\.join/.test(attachBlock));

      const attachMain = require('fs').readFileSync(
        require('path').join(require('./helpers').ROOT, 'src/main.ts'), 'utf8');
      const attachHandler = attachMain.slice(attachMain.indexOf("ipcMain.handle('attach-files'"),
                                             attachMain.indexOf("ipcMain.handle('choose-files'"));
      // A remote project's files have to sit next to the code the agent edits,
      // and that code is on the host.
      check('remote attachments go over sftp to the project host',
        /fastPut/.test(attachHandler) && /projects-dir/.test(attachHandler));
      // A filename is attacker-adjacent input the moment it is joined to a path.
      check('an attachment cannot escape the uploads folder',
        /safeUploadName/.test(attachHandler));

      // The real trap: a poll rebuilds #projects-grid.innerHTML underneath it.
      const survived = await win.evaluate(async (name) => {
        const before = document.querySelector('.tile-terminal .xterm-screen');
        window.renderProjects();
        await new Promise((r) => setTimeout(r, 400));
        const host = document.querySelector(`[data-terminal-host="${CSS.escape(name)}"]`);
        const after = host?.querySelector('.tile-terminal .xterm-screen');
        return {
          stillThere: !!after,
          // Same DOM node, not a rebuilt one — a re-created terminal would have
          // lost its scrollback and its pty.
          sameNode: !!before && before === after,
          sessions: window.__terminalCount()
        };
      }, target);
      check('a tile terminal survives the grid being re-rendered',
        survived.stillThere && survived.sameNode && survived.sessions === 1,
        JSON.stringify(survived));

      // Collapsing must clip, not resize: refitting to the sliver would tell
      // the pty it has two rows and wreck whatever the agent is drawing.
      const collapsed = await win.evaluate(async (name) => {
        const rowsBefore = window.__terminalRows();
        window.toggleTileTerminal(name);
        await new Promise((r) => setTimeout(r, 400));
        const wrap = document.querySelector('.tile-terminal');
        const viewport = wrap.querySelector('.tile-terminal-viewport');
        const pane = wrap.querySelector('.terminal-pane');
        return {
          collapsed: wrap.classList.contains('collapsed'),
          rowsBefore,
          rowsAfter: window.__terminalRows(),
          viewportHeight: viewport.getBoundingClientRect().height,
          paneHeight: pane.getBoundingClientRect().height,
          barVisible: wrap.querySelector('.tile-terminal-bar').getBoundingClientRect().height > 0
        };
      }, target);
      check('collapsing leaves a sliver rather than hiding the terminal',
        collapsed.collapsed && collapsed.viewportHeight > 20 && collapsed.viewportHeight < 100,
        JSON.stringify(collapsed));
      check('the collapsed sliver shows the BOTTOM of the output',
        collapsed.paneHeight > collapsed.viewportHeight + 100,
        `pane ${collapsed.paneHeight} clipped to ${collapsed.viewportHeight}`);
      check('collapsing does not resize the pty',
        collapsed.rowsAfter === collapsed.rowsBefore,
        `${collapsed.rowsBefore} -> ${collapsed.rowsAfter} rows`);
      check('the bar stays readable while collapsed', collapsed.barVisible);

      // Clipping to the pane's bottom edge is not enough: a session that has
      // printed two lines into a 24-row terminal has 22 blank rows down there,
      // and the sliver came up empty. It has to follow the cursor.
      const sliverContent = await win.evaluate(async () => {
        const wrap = document.querySelector('.tile-terminal');
        const viewport = wrap.querySelector('.tile-terminal-viewport');
        const pane = wrap.querySelector('.terminal-pane');
        const vp = viewport.getBoundingClientRect();

        // Which rendered rows actually fall inside the sliver's window.
        const visibleRows = [...pane.querySelectorAll('.xterm-rows > div')]
          .filter((row) => {
            const r = row.getBoundingClientRect();
            return r.bottom > vp.top + 1 && r.top < vp.bottom - 1;
          })
          .map((row) => row.textContent.trim())
          .filter(Boolean);

        return { visibleRows, marginTop: pane.style.marginTop };
      });
      check('the sliver shows the most recent output, not blank rows',
        sliverContent.visibleRows.some((r) => r.includes('tile-hello')),
        JSON.stringify(sliverContent));

      await screenshot(win, '09-tile-terminal-collapsed');

      // A filter must never hide a project whose agent is still running.
      const pinned = await win.evaluate(async (name) => {
        window.toggleEmojiFilter('⛔');
        await new Promise((r) => setTimeout(r, 300));
        const host = document.querySelector(`[data-terminal-host="${CSS.escape(name)}"]`);
        const still = !!host?.querySelector('.tile-terminal');
        window.resetFilters();
        await new Promise((r) => setTimeout(r, 300));
        return still;
      }, target);
      check('a filter cannot hide a project with a live agent session', pinned);

      const closed = await win.evaluate(async (name) => {
        window.closeTileTerminal(name);
        await new Promise((r) => setTimeout(r, 600));
        return {
          sessions: window.__terminalCount(),
          leftovers: document.querySelectorAll('.tile-terminal').length
        };
      }, target);
      check('closing a tile session removes it and its chrome',
        closed.sessions === 0 && closed.leftovers === 0, JSON.stringify(closed));
    }

    // --- Installers -----------------------------------------------------
    //
    // Shell, not UI, but they belong in the same gate: each behaviour below was
    // found by running installers on clean machines, and each is invisible
    // until it bites. A syntax slip or a dropped guard should fail here rather
    // than on someone's fresh install.
    // --- Packaging: does the build actually include the UI? -----------------
  // The suite runs against dist/main.js in a dev checkout, where src/ is simply
  // present on disk — so every renderer assertion passes even when the built
  // package contains no UI at all. That is exactly what shipped in
  // 1.0.0-beta.1: main.ts loaded '../src/index.html', the files glob matched
  // only root-level *.html, and every package on every platform opened a window
  // with nothing in it. The window even had the right title, because that is
  // set on BrowserWindow rather than coming from the page.
  //
  // Static check, no build required: every file main.ts loads must be covered
  // by one of the build.files globs.
  console.log('\npackaging');
  {
    const fs = require('fs');
    const path = require('path');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    const globs = (pkg.build.files || []).filter((g) => !g.startsWith('!'));

    // loadFile is written as path.join(__dirname, '..', 'src', 'x.html'), so
    // rebuild the real relative path from the quoted segments rather than
    // grabbing the basename — 'index.html' alone matches no glob and would
    // fail this test for the wrong reason.
    const loaded = [...mainSrc.matchAll(/loadFile\(([^)]*)\)/g)]
      .map((m) => [...m[1].matchAll(/['"]([^'"]+)['"]/g)]
        .map((q) => q[1])
        .filter((seg) => seg !== '..' && seg !== '.')
        .join('/'))
      .filter((f) => f.endsWith('.html'));
    check('main.ts loads at least one page', loaded.length > 0, loaded.join(','));

    // A glob covers the file if its leading directory segment matches.
    const covered = (file) => globs.some((g) => {
      const root = g.split('/')[0].replace(/\*+/g, '');
      return root && file.startsWith(root);
    });

    for (const page of loaded) {
      check(`build packages ${page}`, covered(page), `globs: ${globs.join(' ')}`);
    }

    // The stylesheet is referenced from the HTML rather than from main.ts, so
    // it needs its own assertion or it silently drops out of the package.
    check('build packages src/styles.css', covered('src/styles.css'), globs.join(' '));
  }

  console.log('\ninstallers');
    const { execSync } = require('child_process');
    const fsMod = require('fs');
    const pathMod = require('path');
    const { ROOT } = require('./helpers');

    const REQUIRED = [
      // Cloud images and CI grant NOPASSWD alongside a password-requiring rule,
      // and plain `sudo -v` prompts anyway — which aborted the CLI installer.
      ['probes sudo -n before sudo -v', /sudo -n true/],
      // set -e is inherited by the subshell; without `|| true` the keepalive
      // dies instantly and the trap kills a dead PID.
      ['guards the sudo keepalive', /sudo -n -v 2>\/dev\/null \|\| true/],
      // A bare `exit` returns the status of `kill`, reporting failure after a
      // fully successful install.
      ['trap preserves the exit status', /trap 'rc=\$\?;/],
      // Otherwise ./zeltro-gui/install-*.sh from the parent silently re-clones
      // instead of installing the checkout you are standing in.
      ['detects a local checkout', /BASH_SOURCE\[0\]/],
      // The GUI is useless without the CLI, so it is never installable alone.
      ['installs the CLI first', /command -v zeltro/],
      // Ubuntu 24.04 still ships Node 18; presence is not enough.
      ['checks the Node VERSION, not just presence', /NODE_MIN_MAJOR/],
      // node-pty must match Electron's ABI or the embedded terminal fails.
      ['rebuilds native modules for Electron', /electron\/rebuild/]
    ];

    for (const file of ['install-ubuntu.sh', 'install-fedora.sh', 'install-arch.sh', 'install-mac.sh']) {
      const full = pathMod.join(ROOT, file);
      check(`${file} exists and is executable`,
        fsMod.existsSync(full) && (fsMod.statSync(full).mode & 0o111) !== 0);

      let syntaxOk = true;
      try {
        execSync(`bash -n ${JSON.stringify(full)}`, { stdio: 'pipe' });
      } catch (error) {
        syntaxOk = false;
      }
      check(`${file} parses`, syntaxOk);

      const body = fsMod.readFileSync(full, 'utf8');
      const missing = REQUIRED.filter(([, re]) => !re.test(body)).map(([label]) => label);
      check(`${file} keeps every hard-won guard`, missing.length === 0, missing.join('; '));
    }

    // Metadata writes go through `zeltro set-metadata` now. The guarantee is
    // unchanged — only emoji/name/description are touched, and the CLI's own
    // last_on and status survive — but it is the CLI's guarantee to keep, so
    // this asserts the GUI delegates rather than editing the file itself.
    const mainBody = fsMod.readFileSync(pathMod.join(ROOT, 'src/main.ts'), 'utf8');
    const writer = mainBody.slice(
      mainBody.indexOf("ipcMain.handle('update-project-metadata'"),
      mainBody.indexOf("ipcMain.handle('update-project-metadata'") + 1200);
    check('metadata writes delegate to zeltro set-metadata',
      /'set-metadata'/.test(writer)
      && ['--emoji', '--name', '--description'].every((f) => writer.includes(f))
      && !/writeFileSync/.test(writer),
      writer.slice(0, 80));

    // The source launcher travels with the repo, so the other machines get it
    // by pulling rather than by having a copy installed alongside them.
    const launcher = pathMod.join(ROOT, 'scripts/zeltro-gui-dev.sh');
    check('source launcher exists and is executable',
      fsMod.existsSync(launcher) && (fsMod.statSync(launcher).mode & 0o111) !== 0);
    let launcherOk = true;
    try { execSync(`bash -n ${JSON.stringify(launcher)}`, { stdio: 'pipe' }); }
    catch (error) { launcherOk = false; }
    check('source launcher parses', launcherOk);

    const launcherBody = fsMod.readFileSync(launcher, 'utf8');
    // It is symlinked from ~/scripts and from /usr/local/bin, so a hardcoded
    // path would resolve to the wrong checkout on three of the four machines.
    // Resolves its own location rather than hardcoding one — it is symlinked
    // from ~/scripts, /usr/local/bin and /opt/homebrew/bin, so a fixed path
    // would point at the wrong checkout on three of the four machines. The
    // resolution goes through a helper now, because `readlink -f` is missing on
    // older macOS; assert the intent, not the spelling.
    check('source launcher finds its own checkout rather than a fixed path',
      /_resolve "\$\{BASH_SOURCE\[0\]\}"/.test(launcherBody)
      && /readlink -f/.test(launcherBody));
    // A .desktop launch never sources .bashrc, so npm is missing from the menu
    // even though it works fine from a terminal.
    check('source launcher recovers npm from nvm', /NVM_DIR/.test(launcherBody));

    // The sync script also ships in the repo, which is what puts it on the
    // workstation — where running it would hard-reset the source of truth.
    const sync = pathMod.join(ROOT, 'scripts/zeltro-sync.sh');
    check('sync script exists and is executable',
      fsMod.existsSync(sync) && (fsMod.statSync(sync).mode & 0o111) !== 0);
    let syncOk = true;
    try { execSync(`bash -n ${JSON.stringify(sync)}`, { stdio: 'pipe' }); }
    catch (error) { syncOk = false; }
    check('sync script parses', syncOk);

    const syncBody = fsMod.readFileSync(sync, 'utf8');
    for (const [label, re] of [
      // Running it on the workstation would reset the source of truth to itself
      // and discard uncommitted work.
      ['refuses to sync the workstation to itself', /hostname.*=.*SRC_HOST|SRC_HOST.*=.*hostname/s],
      // npm exiting 0 says nothing about node-pty matching Electron's ABI; a
      // wrong build installs cleanly and only fails when a terminal is opened.
      ['verifies node-pty by loading it under Electron', /ELECTRON_RUN_AS_NODE=1 npx electron/],
      // Root-owned node_modules breaks the next interactive npm run.
      ['builds as the user, not root', /su - shawn -c/],
      // Otherwise every future change needs an SSH session to each machine.
      ['installs its own next version', /SELF_SRC|SELF_DST/]
    ]) {
      check(`sync script ${label}`, re.test(syncBody));
    }

    // --- Optional services -----------------------------------------------
    //
    // The GUI no longer keeps its own catalogue: the CLI publishes one via
    // `zeltro enable-service --json-output`. This asserts the window renders
    // exactly what the CLI declares — the earlier version of this test compared
    // the GUI's hardcoded copy against the CLI's shell source, and existed only
    // because that copy did.
    const cliCatalog = await app.evaluate(async ({ ipcMain }) =>
      ipcMain._invokeHandlers.get('get-service-catalog')({}));

    check('the CLI publishes a machine-readable service listing',
      !cliCatalog.error && Array.isArray(cliCatalog.services) && cliCatalog.services.length > 0,
      cliCatalog.error || `${cliCatalog.services?.length} services`);

    if (!cliCatalog.error) {
      const shaped = cliCatalog.services[0] || {};
      check('listing entries carry slug/group/description/address/state',
        ['slug', 'group', 'description', 'address', 'state'].every((k) => k in shaped),
        JSON.stringify(shaped));

      // Every state the CLI can report must map to something the window shows.
      const states = [...new Set(cliCatalog.services.map((s) => s.state))];
      check('every reported state is one the GUI understands',
        states.every((st) => ['disabled', 'enabled_not_running', 'running'].includes(st)),
        states.join(','));

      const guiServices = (await win.evaluate(() => window.__optionalServices())).sort();
      const cliServices = cliCatalog.services.map((s) => s.slug).sort();
      check('the manager offers exactly the services the CLI declares',
        JSON.stringify(guiServices) === JSON.stringify(cliServices),
        `cli=${cliServices.join(',')} gui=${guiServices.join(',')}`);

      // Always-on services must never appear as toggles — they cannot move.
      const offered = guiServices.filter((s) => (cliCatalog.always_on || []).includes(s));
      check('the always-on services are not offered as toggles',
        offered.length === 0, offered.join(','));
    }

    // macOS ships bash 3.2.57 and always will — Apple froze it at the last
    // GPLv2 release. Every script here uses `#!/usr/bin/env bash`, which on a
    // Mac resolves to that unless Homebrew's bash is installed, and on the test
    // rig it is not. `bash -n` alone does NOT catch this: `mapfile` parses fine
    // and fails at runtime with "command not found", which is exactly how the
    // CLI's `zeltro configure` broke on the Mac.
    const BASH4 = [
      ['mapfile', /\bmapfile\b/],
      ['readarray', /\breadarray\b/],
      ['associative arrays', /declare\s+-A\b/],
      ['case conversion \${v,,}', /\$\{[A-Za-z_][A-Za-z0-9_]*,,?\}/],
      ['case conversion \${v^^}', /\$\{[A-Za-z_][A-Za-z0-9_]*\^\^?\}/],
      ['negative array index', /\$\{[A-Za-z_][A-Za-z0-9_]*\[-[0-9]+\]\}/],
      ['coproc', /\bcoproc\b/],
      ['|& pipe', /\|&/]
    ];
    for (const file of ['scripts/zeltro-sync.sh', 'scripts/zeltro-gui-dev.sh',
                        'install-mac.sh', 'packaging/after-install.sh']) {
      const full = pathMod.join(ROOT, file);
      if (!fsMod.existsSync(full)) { check(`${file} exists`, false); continue; }
      // Strip full-line comments before matching. A comment explaining WHY
      // mapfile is banned would otherwise trip the guard on its own rationale —
      // confirmed by adding one — and a lint that fails on its own explanation
      // is a lint someone disables within a week. (Flagged by the CLI session,
      // which hit it first.)
      //
      // Full-line only: stripping trailing comments means deciding whether a #
      // is inside a string, and getting that wrong would silently stop matching
      // real code. A ban explained in a trailing comment is the rarer case and
      // failing loudly there is the safer error.
      const body = withoutComments(fsMod.readFileSync(full, 'utf8'), '#');
      const found = BASH4.filter(([, re]) => re.test(body)).map(([label]) => label);
      check(`${file} avoids bash 4+ constructs (macOS has 3.2)`,
        found.length === 0, found.join('; '));
    }

    // Arch-only landmines, both from the CLI's installer.
    const archBody = fsMod.readFileSync(pathMod.join(ROOT, 'install-arch.sh'), 'utf8');
    check('arch initialises the pacman keyring', /pacman-key --init/.test(archBody));
    check('arch warns when the running kernel was replaced',
      /usr\/lib\/modules\/\$\(uname -r\)/.test(archBody));

    // The menu entry must invoke the launcher. `zeltro gui` is not a CLI
    // subcommand — it printed "Unknown command: gui" and did nothing.
    const desktop = fsMod.readFileSync(
      pathMod.join(ROOT, 'packaging/debian-package/usr/share/applications/zeltro-gui.desktop'), 'utf8');
    check('desktop entry execs the launcher, not a nonexistent subcommand',
      /^Exec=zeltro-gui$/m.test(desktop), desktop.match(/^Exec=.*$/m)?.[0] || '');
  } finally {
    await app.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('screenshots: debug/\n');

  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error('\ne2e run crashed:', error);
  process.exit(1);
});
