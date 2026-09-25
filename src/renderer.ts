const { ipcRenderer, shell } = require('electron');


// Global state interfaces
interface Project {
  name: string;
  display_name?: string;
  description?: string;
  emoji?: string;
  type: 'php' | 'laravel' | 'wordpress';
  folderExists: boolean;
  dockerRunning: boolean;
  portMapped: boolean;
  localUrl: string;
  lanUrl: string;
  port: number | null;
  status: 'running' | 'starting' | 'stopped';
}

interface SharedService {
  name: string;
  status: string;
  port: string;
  ip_address: string;
}

interface SharedServices {
  [key: string]: SharedService;
}

interface Services {
  [key: string]: any;
}

// Global state
let projects: Project[] = [];
let sharedServices: SharedServices = {};
let services: Services = {};
let autoRefreshInterval: NodeJS.Timeout | null = null;
const isDebugMode = process.argv.includes('--debug-mode');
console.log('RENDERER: Global state initialized', { debugMode: isDebugMode });

// Function to get emoji CSS class for dynamic backgrounds
function getEmojiClass(emoji: string): string {
    const emojiMap: { [key: string]: string } = {
        '🚀': 'emoji-rocket',
        '💻': 'emoji-computer',
        '🌟': 'emoji-star',
        '🔥': 'emoji-fire',
        '⚡': 'emoji-lightning',
        '🎯': 'emoji-target',
        '🏆': 'emoji-trophy',
        '💎': 'emoji-diamond',
        '🎨': 'emoji-art',
        '🔧': 'emoji-wrench',
        '📱': 'emoji-mobile',
        '🌐': 'emoji-globe',
        '🎮': 'emoji-game',
        '📊': 'emoji-chart',
        '🛡️': 'emoji-shield'
    };
    
    return emojiMap[emoji] || 'emoji-rocket'; // Default to rocket
}

// Initialize app
document.addEventListener('DOMContentLoaded', (): void => {
    console.log('DEBUG: DOMContentLoaded event fired');

    // Sync the theme module state with the attribute the inline <head> script
    // already set. That script runs before first paint so the splash is not
    // drawn in the wrong theme; this just brings `currentTheme` in line and
    // renders the picker.
    loadTheme();
    renderThemePicker();
    loadFilterState();
    loadLayoutState();

    // Show initial loading screen
    showInitialLoading();
    
    // Read which optional services are enabled BEFORE the first render, so
    // minio/meilisearch are never briefly shown as "Stopped" on a machine that
    // simply never enabled them.
    loadOptionalServices()
        .then(() => refreshServiceCatalog())
        .then(() => Promise.all([
        loadProjects(),
        loadServices(),
        showAboutVersions()
    ])).then(() => {
        setupEventListeners();

        // Deliberately not awaited. It talks to GitHub, and nothing on screen
        // depends on the answer — putting it on the startup path would delay the
        // dashboard for a check nobody has asked for yet. The badge appears when
        // it lands.
        if (autoUpdateCheckEnabled()) checkUpdatesInBackground();

        // Not awaited: the model is cached so this is quick, but the dashboard
        // has no reason to wait on it either way.
        if (dictationEnabled()) void restoreDictation();
        
        // Show debug indicator if in debug mode
        if (isDebugMode) {
            const debugIndicator = document.getElementById('debug-indicator');
            if (debugIndicator) {
                debugIndicator.style.display = 'block';
            }
        }
        
        console.log('DEBUG: DOMContentLoaded initialization complete');
        
        // Hide initial loading screen after a brief delay
        setTimeout(() => {
            hideInitialLoading();
        }, 1000);
    }).catch((error) => {
        console.error('Failed to initialize app:', error);
        hideInitialLoading();
    });
});

function setupEventListeners(): void {
    // The framework picker is two dropdowns now, and each wires its own
    // onchange in the markup it generates.
    
    // GitHub repository checkbox
    const githubCheckbox: HTMLInputElement | null = document.getElementById('create-github-repo') as HTMLInputElement;
    if (githubCheckbox) {
        githubCheckbox.addEventListener('change', toggleGithubOptions);
    }

    // Clone Project form handler
    const cloneProjectForm = document.getElementById('clone-project-form');
    if (cloneProjectForm) {
        cloneProjectForm.addEventListener('submit', (e) => {
            e.preventDefault();
            submitCloneProject();
        });
    }

    // F5 key listener for manual refresh
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'F5') {
            e.preventDefault(); // Prevent browser refresh
            manualRefresh();
        }
    });

    console.log('Event listeners setup complete', { 
        debugMode: isDebugMode,
        f5RefreshEnabled: true 
    });
}

function toggleGithubOptions(): void {
    const githubCheckbox: HTMLInputElement | null = document.getElementById('create-github-repo') as HTMLInputElement;
    const githubOptions: HTMLElement | null = document.getElementById('github-options');
    
    if (githubCheckbox && githubOptions) {
        githubOptions.style.display = githubCheckbox.checked ? 'block' : 'none';
    }
}

// ---------------------------------------------------------------------------
// Framework catalogue (New Project)
//
// Read from the CLI's src/catalog/frameworks.json rather than hardcoded. The
// form used to offer 3 of the 13 frameworks and send `--database mysql` for
// every one of them, which the CLI then silently coerced to whatever that
// framework actually supports.
// ---------------------------------------------------------------------------

interface CatalogFramework {
    slug: string;
    display: string;
    runtime: string;
    databases: string[];
    note: string;
}

let frameworkCatalog: CatalogFramework[] = [];

// `--version` only genuinely does something for these two:
//   laravel   -> sets CUR_LARAVEL_BRANCH, validated against Laravel's git tags
//   wordpress -> downloads wordpress-<version>.tar.gz
// The CLI's help also advertises `php: 8 or 7`, but frameworks/php.sh contains
// no version handling at all and the only PHP image in the tree is nginx-php8 —
// passing a PHP version silently gets you 8.3 either way. October CMS pins its
// own version through OCTOBER_VERSION rather than this flag. Reported upstream;
// offering a control for any of those would be lying to the user.
const VERSIONED_FRAMEWORKS = ['laravel', 'wordpress'];

// Cached PER HOST. A single cache would serve the previous host's frameworks on
// the next open, offering a remote machine's list for a local create or the
// reverse — and the mismatch would only surface when creation failed.
let frameworkCatalogHost = '';

async function loadFrameworkCatalog(hostId: string = 'local'): Promise<void> {
    if (frameworkCatalog.length > 0 && frameworkCatalogHost === hostId) return;

    const result = await ipcRenderer.invoke('get-framework-catalog', hostId);
    frameworkCatalogHost = hostId;
    frameworkCatalog = result.frameworks || [];

    const list = document.getElementById('framework-list');
    if (!list) return;

    if (frameworkCatalog.length === 0) {
        list.innerHTML = `<p class="app-list-empty">Could not read the framework catalogue.<br><small>${escapeHtml(result.error || '')}</small></p>`;
        return;
    }

    // Group by runtime, the way the CLI's own listing reads.
    const runtimes: string[] = [];
    for (const fw of frameworkCatalog) {
        if (!runtimes.includes(fw.runtime)) runtimes.push(fw.runtime);
    }

    // Two dropdowns rather than twenty-one radio buttons: pick a runtime, then a
    // framework within it. The full grid made the common case (Laravel, Django,
    // Express) as much work as the rare one, and grew every time the CLI added a
    // framework.
    list.innerHTML = `
        <div class="ssh-row">
            <div class="form-group">
                <label>Runtime</label>
                <select id="framework-runtime" data-testid="framework-runtime"
                        onchange="onRuntimeChange()">
                    ${runtimes.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>Framework</label>
                <select id="framework-choice" data-testid="framework-choice"
                        onchange="onFrameworkChange()"></select>
            </div>
        </div>
        <p id="framework-note" class="settings-note" data-testid="framework-note"></p>`;

    // Laravel stays the default, so its runtime is what opens.
    const laravel = frameworkCatalog.find((fw) => fw.slug === 'laravel');
    const runtimeSelect = document.getElementById('framework-runtime') as HTMLSelectElement | null;
    if (runtimeSelect && laravel) runtimeSelect.value = laravel.runtime;

    onRuntimeChange();
}

// Fill the second dropdown from the first. Keeps the current framework selected
// when it belongs to the newly chosen runtime, so re-picking the same runtime
// does not silently move the selection.
function onRuntimeChange(): void {
    const runtime = (document.getElementById('framework-runtime') as HTMLSelectElement | null)?.value;
    const choice = document.getElementById('framework-choice') as HTMLSelectElement | null;
    if (!choice) return;

    const inRuntime = frameworkCatalog.filter((fw) => fw.runtime === runtime);
    const keep = choice.value;
    choice.innerHTML = inRuntime.map((fw) =>
        `<option value="${escapeHtml(fw.slug)}">${escapeHtml(fw.display)}</option>`).join('');

    if (inRuntime.some((fw) => fw.slug === keep)) choice.value = keep;
    else if (inRuntime.some((fw) => fw.slug === 'laravel')) choice.value = 'laravel';

    onFrameworkChange();
}

function selectedFramework(): CatalogFramework | null {
    const choice = document.getElementById('framework-choice') as HTMLSelectElement | null;
    if (!choice || !choice.value) return null;
    return frameworkCatalog.find((fw) => fw.slug === choice.value) || null;
}

function onFrameworkChange(): void {
    const framework = selectedFramework();
    if (!framework) return;

    // Offer only the engines this framework actually works with. "Auto" is the
    // default and sends no --database at all, letting the CLI apply its own
    // per-framework rule rather than the GUI second-guessing it.
    const select = document.getElementById('project-database') as HTMLSelectElement;
    if (select) {
        const options = ['<option value="">Auto — chosen by Zeltro</option>'];
        for (const db of framework.databases) {
            options.push(`<option value="${escapeHtml(db)}">${escapeHtml(db)}</option>`);
        }
        select.innerHTML = options.join('');
    }

    const help = document.getElementById('project-database-help');
    if (help) {
        help.textContent = framework.databases.length === 1
            ? `${framework.display} only works with ${framework.databases[0]}.`
            : 'Only engines this framework supports are offered.';
    }

    // The catalogue's note carries what the name alone cannot — in-house
    // frameworks especially, which no one can be expected to recognise.
    const note = document.getElementById('framework-note');
    if (note) note.textContent = framework.note || '';

    toggleVersionGroups();
}

function toggleVersionGroups(): void {
    const framework = selectedFramework();
    const slug = framework?.slug || '';

    const versionGroups: Array<[string, string]> = [
        ['laravel-version-group', 'laravel'],
        ['wordpress-version-group', 'wordpress']
    ];

    for (const [id, owner] of versionGroups) {
        const group = document.getElementById(id);
        if (!group) continue;

        const show = slug === owner && VERSIONED_FRAMEWORKS.includes(slug);
        group.style.display = show ? 'block' : 'none';

        if (show && owner !== 'php') {
            const input = document.getElementById(`${owner}-version`) as HTMLInputElement;
            if (input) input.value = 'latest';
        }
    }
}

// Which hosts the dashboard shows. Local (when this machine has Zeltro) plus
// every configured SSH profile.
let dashboardHosts: Array<{ id: string; label: string }> = [];
// Read once and kept, because rendering needs it synchronously — an empty state
// that says the wrong thing for a second is worse than one that waits.
let platformCaps: { platform: string; localZeltro: boolean; remoteOnly: boolean } | null = null;
// Hosts that failed their last poll, so a tile-less host is distinguishable
// from a host that is simply empty.
let hostErrors: Record<string, string> = {};

async function refreshDashboardHosts(): Promise<void> {
    const caps = await ipcRenderer.invoke('get-platform-capabilities');
    platformCaps = caps;
    await loadSshProfiles();

    dashboardHosts = [];
    if (caps.localZeltro) dashboardHosts.push({ id: 'local', label: 'This computer' });
    for (const p of sshProfiles) {
        if (p.host) dashboardHosts.push({ id: p.id, label: p.label || p.host });
    }
}

async function loadProjects(): Promise<void> {
    try {
        await refreshDashboardHosts();

        // Every host in parallel, AND rendered as each one answers.
        //
        // Waiting for all of them before rendering anything meant a single
        // unreachable host blanked the whole dashboard for its full ten-second
        // handshake timeout — local projects included. With a laptop powered
        // off, that is an empty grid and nothing to click, which reads as the
        // app being broken rather than one host being down.
        //
        // `--all` is required: zeltro status lists only RUNNING projects by
        // default, so without it the grid is empty whenever nothing is up.
        // NOT cleared here. Clearing upfront and refilling as hosts answered
        // made every project blink out and back on each ten-second poll — the
        // slow host's tiles were missing for as long as it took to answer.
        // Each host's entries are replaced when that host reports instead, so
        // what is on screen stays there until something newer arrives.
        const seenHosts = new Set<string>();

        const applyHost = (host: { id: string; label: string }, result: any): void => {
            // Drop anything already held for this host before re-adding, so a
            // second answer replaces rather than duplicates.
            seenHosts.add(host.id);
            projects = projects.filter((p) => ((p as any).hostId || 'local') !== host.id);

            if (result.code !== 0) {
                // Recorded rather than thrown away: a host that is down should
                // say so, not silently contribute nothing and look like a host
                // with no projects.
                hostErrors[host.id] = (result.stderr || result.stdout || 'did not respond').split('\n')[0]!;
                return;
            }
            delete hostErrors[host.id];
            // Append: the parse must not clear what other hosts have added.
            parseProjectStatusJSON(result.stdout, host.id, true);
        };

        await Promise.all(dashboardHosts.map(async (h) => {
            const result = await ipcRenderer.invoke('execute-zeltro-on', h.id, 'status',
                ['--all', '--json-output']);
            applyHost(h, result);
            // Render on arrival. The fast hosts are visible while the slow ones
            // are still being waited on.
            renderProjects();
            renderFilterBar();
        }));

        // A host removed from settings, or one that never answered, must not
        // leave its projects on screen forever.
        const configured = new Set(dashboardHosts.map((h) => h.id));
        projects = projects.filter((p) => configured.has((p as any).hostId || 'local'));

        renderProjects();
        renderFilterBar();   // counts derive from the project list
        renderServicesHostPicker();
    } catch (error) {
        console.error('Failed to load projects:', error);
        // Only show error if it's a real failure, not just empty state
        if (projects.length === 0) {
            console.log('No projects found, not showing error notification');
        } else {
            showError('Failed to load projects');
        }
    }
}

// Identity is (host, name), not name.
//
// Two hosts can each have a `drupal-test`. Everything used to key on the name
// alone — tile lookup, terminal session keys, the emoji filter — and with more
// than one host that silently conflates two different projects.
function projectKey(hostId: string, name: string): string {
    return `${hostId}:${name}`;
}

function keyOf(project: Project): string {
    return projectKey((project as any).hostId || 'local', project.name);
}

function parseProjectStatusJSON(statusOutput: string, hostId: string = 'local',
                                append: boolean = false): void {
    if (!append) {
        projects = [];
        sharedServices = {};
    }
    
    if (!statusOutput || statusOutput.trim() === '') {
        console.log('Empty status output, no projects to parse');
        return;
    }
    
    // Check if output looks like JSON
    const trimmed: string = statusOutput.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        console.log('Status output is not JSON format, likely no projects or services stopped:', trimmed);
        return;
    }
    
    try {
        const data = JSON.parse(statusOutput);
        
        // Store shared services data
        // Shared services are per host. The panel shows the local set, or the
        // first host's when there is no local install — merging them would
        // present one machine's Redis as though it were another's.
        if (!append || Object.keys(sharedServices).length === 0) {
            sharedServices = data.shared_services || {};
        }
        
        // Parse projects
        if (data.projects && Array.isArray(data.projects)) {
            for (const projectData of data.projects) {
                // Display metadata arrives WITH operational state now, in the
                // same object from the same call (CLI 36109a7). It used to come
                // from a separate pass that opened each project's compose file,
                // and every bug in this area came from those two paths racing.
                //
                // Absent keys are absent rather than blank, so the `||` defaults
                // still apply. Unknown keys (type, version) pass through and are
                // ignored.
                const meta = projectData.metadata || {};

                const project: Project = {
                    name: projectData.name || '',
                    display_name: meta.display_name || projectData.name || '',
                    description: meta.description || '',
                    emoji: meta.emoji || '🚀',
                    type: 'php', // Default type
                    folderExists: projectData.folder_exists === true,
                    dockerRunning: projectData.docker_running === true,
                    portMapped: projectData.port_mapped === true,
                    localUrl: projectData.local_url || '',
                    lanUrl: projectData.lan_url || '',
                    port: projectData.external_port ? parseInt(projectData.external_port) : null,
                    status: 'stopped'
                };

                // Carried for sorting and for the parked check. The CLI passes
                // the raw status string through untouched; applying "only the
                // exact string disabled disables" stays on this side.
                (project as any).last_on = meta.last_on || '';
                (project as any).status_meta = meta.status || '';
                // Which machine this project lives on. Everything downstream —
                // the tile's actions, its terminal, its key — needs it.
                (project as any).hostId = hostId;
                // The container address. Zeltro no longer writes /etc/hosts, so
                // this is the route from the machine itself.
                (project as any).projectIp = projectData.project_ip || '';
                
                // Determine overall status.
                //
                // `port_mapped` is NOT a liveness signal. Zeltro routes to a
                // project by hostname via its VPC IP (http://<project>/), so an
                // adapted multi-service compose — anything `zeltro install`
                // produces with an nginx front — runs perfectly with no host
                // port published at all. Requiring port_mapped here marked a
                // verified-healthy install (HTTP 200) as stopped, offered a
                // "Start" button for an already-running container, and hid its
                // URL. The container being up is what "running" means.
                // `ping_status` is diagnostic, not a liveness signal, and this
                // used to treat it as one — anything other than ok/skipped meant
                // "starting". That inverted on macOS, where Docker Desktop keeps
                // containers inside a VM so their IPs are permanently
                // unreachable from the host: the CLI reports `not_applicable`
                // there, which is neither of the two allowed values, so every
                // healthy Mac project rendered as a red not-running tile.
                //
                // An allowlist of known-good values would break again on the
                // next one. So: docker_running decides up or down, http_status
                // decides whether it is serving yet, and anything unknown
                // defaults to running — because docker_running is the
                // authoritative signal and "I cannot tell" is not evidence of a
                // problem.
                if (!project.dockerRunning) {
                    project.status = 'stopped';
                } else if (projectData.http_status === 'failed') {
                    // Up, but not answering yet — mid-boot.
                    project.status = 'starting';
                } else {
                    project.status = 'running';
                }
                
                // Detect project type from name (simplified)
                if (project.name.includes('laravel') || project.name.includes('api')) {
                    project.type = 'laravel';
                } else if (project.name.includes('wordpress') || project.name.includes('wp')) {
                    project.type = 'wordpress';
                } else {
                    project.type = 'php';
                }
                
                projects.push(project);
            }
        }
        
    } catch (error) {
        console.error('Failed to parse JSON status output:', error);
        console.log('Raw output that failed to parse:', statusOutput);
        // Only show error if the directory exists but parsing failed
        // This prevents errors when services are simply stopped or directory is empty
        if (statusOutput.includes('Error:') || statusOutput.includes('Failed:')) {
            showError('Failed to parse project status data');
        } else {
            console.log('Non-JSON output likely due to stopped services, not showing error');
        }
    }
}

// Display metadata now arrives inside `zeltro status --json-output` (CLI
// 36109a7), merged onto each project at parse time. What used to be here — a
// per-project docker-compose.yaml read, a cache keyed by project name, and a
// merge applied at render time — is gone, along with the two bugs that only
// existed because operational state and display metadata arrived by different
// routes and could disagree.
//
// withMetadata is kept as an identity function rather than removed: it is named
// at eleven call sites, and reading `withMetadata(p).emoji` still says "this is
// the display value" at each one. Deleting it would be a bigger diff that says
// less.
function withMetadata(project: Project): Project {
    return project;
}

// Legacy function - redirects to JSON version
function parseProjectStatus(statusOutput: string): void {
    console.log('DEBUG: parseProjectStatus called - redirecting to JSON version');
    parseProjectStatusJSON(statusOutput);
}


// ---------------------------------------------------------------------------
// PROJECT LAYOUT
//
// How wide the tiles are, and where "Modify with AI" opens. Both are per-machine
// preferences rather than project state, so they live in localStorage next to
// the filters.
// ---------------------------------------------------------------------------
type TerminalHost = 'tile' | 'system';

// Stored settings survive the rename.
//
// Every key was `podium-*` before, and renaming them straight to `zeltro-*`
// would have silently reset each existing user's theme, tile layout, filters,
// dictation model and microphone choice — with nothing on screen explaining
// why. The old key is read once when the new one is absent, then written
// forward, so the migration happens on first launch and needs no thought later.
function storedSetting(key: string): string | null {
    const current = localStorage.getItem(key);
    if (current !== null) return current;

    const legacy = localStorage.getItem(key.replace(/^zeltro/, 'podium'));
    if (legacy === null) return null;

    localStorage.setItem(key, legacy);
    return legacy;
}

const LAYOUT_STORAGE_KEY = 'zeltro-gui-layout';

let projectsPerRow = 2;
let terminalHost: TerminalHost = 'tile';

function loadLayoutState(): void {
    try {
        const saved = JSON.parse(storedSetting(LAYOUT_STORAGE_KEY) || '{}');
        const perRow = Number(saved.perRow);
        // Clamp rather than trust: a hand-edited 12 would render unreadable
        // slivers with no way back except editing storage again.
        if (perRow >= 1 && perRow <= 4) projectsPerRow = Math.floor(perRow);
        if (saved.terminalHost === 'system' || saved.terminalHost === 'tile') {
            terminalHost = saved.terminalHost;
        }
    } catch {
        // Unparseable state falls back to the defaults.
    }
    applyLayout();
}

function saveLayoutState(): void {
    try {
        localStorage.setItem(LAYOUT_STORAGE_KEY,
            JSON.stringify({ perRow: projectsPerRow, terminalHost }));
    } catch {
        // Storage full or blocked; the setting just will not persist.
    }
}

// The width lives in a data attribute rather than an inline style so the
// narrow-window media queries can still override it — an inline style would
// win over them and leave four unreadable columns on a small screen.
function applyLayout(): void {
    document.getElementById('projects-grid')?.setAttribute('data-per-row', String(projectsPerRow));

    const perRow = document.getElementById('layout-per-row') as HTMLSelectElement;
    if (perRow) perRow.value = String(projectsPerRow);

    const host = document.getElementById('layout-terminal-host') as HTMLSelectElement;
    if (host) host.value = terminalHost;

    const help = document.getElementById('layout-terminal-host-help');
    if (help) {
        help.textContent = terminalHost === 'system'
            ? 'Zeltro opens your terminal emulator and hands the session to it.'
            : 'The session appears in the project\'s own tile, and can be collapsed to a sliver.';
    }
}

function setProjectsPerRow(value: string): void {
    const n = Number(value);
    if (!(n >= 1 && n <= 4)) return;
    projectsPerRow = Math.floor(n);
    saveLayoutState();
    applyLayout();
    // Tile terminals are sized in pixels by their container; a width change
    // means the pty's column count is now wrong.
    refitTileTerminals();
}

function setTerminalHost(value: string): void {
    if (value !== 'tile' && value !== 'system') return;
    terminalHost = value;
    saveLayoutState();
    applyLayout();
}

// ---------------------------------------------------------------------------
// PROJECT FILTERING AND SORTING
//
// State lives here rather than being read from the DOM at render time, so the
// controls and the grid cannot disagree. Persisted, because a filter you have
// to reapply on every launch is worse than no filter.
// ---------------------------------------------------------------------------
type RunFilter = 'all' | 'running' | 'stopped' | 'disabled';
type SortKey = 'name' | 'newest' | 'last-on';

const FILTER_STORAGE_KEY = 'zeltro-gui-filters';

let runFilter: RunFilter = 'all';
let sortKey: SortKey = 'name';
let emojiFilter: Set<string> = new Set();
// '' means every host. Persisted like the others, but validated against the
// CURRENT host list on load — a filter naming a host whose profile was deleted
// would hide every project with no visible reason.
let hostFilter = '';

function loadFilterState(): void {
    try {
        const raw = storedSetting(FILTER_STORAGE_KEY);
        if (!raw) return;
        const v = JSON.parse(raw);
        if (['all', 'running', 'stopped', 'disabled'].includes(v.runFilter)) runFilter = v.runFilter;
        if (['name', 'newest', 'last-on'].includes(v.sortKey)) sortKey = v.sortKey;
        if (Array.isArray(v.emoji)) emojiFilter = new Set(v.emoji);
        if (typeof v.hostFilter === 'string') hostFilter = v.hostFilter;
    } catch { /* corrupt or unavailable; defaults are fine */ }
}

function saveFilterState(): void {
    try {
        localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({
            runFilter, sortKey, emoji: [...emojiFilter], hostFilter
        }));
    } catch { /* private mode */ }
}

// Parked, not deleted.
//
// ONLY the exact string "disabled" disables. Missing, empty, or anything
// unrecognised means enabled — the CLI asked for that rule explicitly and it is
// the safe direction: a project must never become unusable because a metadata
// read returned something unexpected. Every project predating the feature has
// no `status` key at all.
function isDisabled(p: Project): boolean {
    return (withMetadata(p) as any).status_meta === 'disabled';
}

// A disabled project's container does not exist, so docker sees it exactly as
// it sees a stopped one. The metadata is the only thing that tells them apart,
// which is why "stopped" has to exclude disabled explicitly rather than just
// meaning "not running".
function isStopped(p: Project): boolean {
    return !p.dockerRunning && !isDisabled(p);
}

// The emoji shown on a tile, resolved the same way renderProjects does it —
// otherwise the filter counts a different emoji than the user can see.
function projectEmoji(p: Project): string {
    const m = withMetadata(p);
    return m.emoji || (m.type === 'laravel' ? '🎯' : m.type === 'wordpress' ? '📝' : '🐘');
}

function visibleProjects(): Project[] {
    let list = projects.slice();

    // A project running an agent in its tile is never filtered out. Hiding it
    // would leave a live session with no window and no way to reach it — the
    // filter would look like it had killed the agent.
    const pinned = (p: Project) => hasTileTerminal(p.name);

    // Host first: it narrows the set every other filter then works within, and
    // the counts shown beside them should describe what is actually reachable
    // through them.
    if (hostFilter) list = list.filter((p) => ((p as any).hostId || 'local') === hostFilter);

    if (runFilter === 'disabled') {
        // The only view that shows them, and therefore the only route back to a
        // parked project. Nothing else may filter this list further.
        list = list.filter(isDisabled);
    } else {
        // Disabled projects are hidden from every other view, including "All" —
        // that is what parking means.
        list = list.filter(p => !isDisabled(p) || pinned(p));

        if (runFilter === 'running') list = list.filter(p => p.dockerRunning || pinned(p));
        else if (runFilter === 'stopped') list = list.filter(p => isStopped(p) || pinned(p));

        if (emojiFilter.size) list = list.filter(p => emojiFilter.has(projectEmoji(p)) || pinned(p));
    }

    const nameOf = (p: Project) => (withMetadata(p).display_name || p.name).toLowerCase();
    list.sort((a, b) => {
        if (sortKey === 'name') return nameOf(a).localeCompare(nameOf(b));
        // `newest` and `last-on` both fall back to name when the underlying
        // value is missing, so the order stays stable and predictable rather
        // than arbitrary. last_on is not written by the CLI yet.
        // Read THROUGH withMetadata. last_on lives in the compose file's
        // x-metadata and is merged in at render time, so the raw project
        // objects never carry it — sorting on them silently compared undefined
        // to undefined and left the order untouched.
        const key = sortKey === 'newest' ? 'created_at' : 'last_on';
        const av = (withMetadata(a) as any)[key] || '';
        const bv = (withMetadata(b) as any)[key] || '';
        if (av && bv) return bv.localeCompare(av);
        if (av) return -1;
        if (bv) return 1;
        return nameOf(a).localeCompare(nameOf(b));
    });
    return list;
}

function renderFilterBar(): void {
    const host = document.getElementById('project-filters');
    if (!host) return;

    // Counts exclude disabled projects AND respect the host filter, so every
    // number describes what its own control would actually show. A chip saying
    // 3 that yields 2 tiles is worse than no chip, and that is exactly what a
    // host-wide count beside a host-filtered grid would be.
    const active = projects.filter(p => !isDisabled(p)
        && (!hostFilter || ((p as any).hostId || 'local') === hostFilter));
    const counts = new Map<string, number>();
    for (const p of active) {
        const e = projectEmoji(p);
        counts.set(e, (counts.get(e) || 0) + 1);
    }
    const emojiButtons = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([e, n]) => `<button class="emoji-chip${emojiFilter.has(e) ? ' active' : ''}"
              data-testid="emoji-filter-${e}" onclick="toggleEmojiFilter('${e}')"
              title="${n} project${n === 1 ? '' : 's'}">${e}<span class="emoji-count">${n}</span></button>`)
        .join('');

    // A persisted filter naming a host whose profile has since been removed
    // would hide everything with nothing on screen explaining why. Drop it.
    if (hostFilter && !dashboardHosts.some((h) => h.id === hostFilter)) hostFilter = '';

    // Only offered with more than one host: filtering by the only host there is
    // would be a control that can never change anything.
    const hostSelect = dashboardHosts.length > 1
        ? `<select data-testid="filter-host" onchange="setHostFilter(this.value)">
               <option value=""${hostFilter === '' ? ' selected' : ''}>All hosts (${dashboardHosts.length})</option>
               ${dashboardHosts.map((h) => {
                   const n = projects.filter((p) => ((p as any).hostId || 'local') === h.id
                       && !isDisabled(p)).length;
                   return `<option value="${escapeHtml(h.id)}"${hostFilter === h.id ? ' selected' : ''}>${escapeHtml(h.label)} (${n})</option>`;
               }).join('')}
           </select>`
        : '';

    const running = active.filter(p => p.dockerRunning).length;
    const stopped = active.length - running;
    const disabled = projects.length - active.length;

    // The Disabled option is ALWAYS offered, even at zero. It is the only route
    // back to a parked project, so hiding it when the count is zero would mean
    // disabling the last visible project made it unreachable — the count is
    // read from the same render that just hid it.
    host.innerHTML = `
        <div class="filter-group">
            ${hostSelect}
            <select data-testid="filter-run" onchange="setRunFilter(this.value)">
                <option value="all"${runFilter === 'all' ? ' selected' : ''}>All (${active.length})</option>
                <option value="running"${runFilter === 'running' ? ' selected' : ''}>Running (${running})</option>
                <option value="stopped"${runFilter === 'stopped' ? ' selected' : ''}>Stopped (${stopped})</option>
                <option value="disabled"${runFilter === 'disabled' ? ' selected' : ''}>Disabled (${disabled})</option>
            </select>
            <select data-testid="filter-sort" onchange="setSortKey(this.value)">
                <option value="name"${sortKey === 'name' ? ' selected' : ''}>Sort: Name</option>
                <option value="newest"${sortKey === 'newest' ? ' selected' : ''}>Sort: Newest</option>
                <option value="last-on"${sortKey === 'last-on' ? ' selected' : ''}>Sort: Last on</option>
            </select>
        </div>
        <div class="emoji-filters" data-testid="emoji-filters">${emojiButtons}</div>
        ${emojiFilter.size ? `<button class="btn btn-secondary btn-small" data-testid="clear-emoji-filter" onclick="clearEmojiFilter()">Clear emoji</button>` : ''}
    `;
}

function resetFilters(): void {
    runFilter = 'all'; sortKey = 'name'; emojiFilter.clear(); hostFilter = '';
    saveFilterState(); renderProjects(); renderFilterBar();
}

function setHostFilter(v: string): void {
    hostFilter = dashboardHosts.some((h) => h.id === v) ? v : '';
    saveFilterState(); renderProjects(); renderFilterBar();
}

function setRunFilter(v: string): void {
    // Keep this list in step with RunFilter. It silently fell back to 'all'
    // for 'disabled', so selecting the Disabled filter showed everything except
    // the disabled projects it was meant to reveal — the one view that must
    // work, because it is the only route back to a parked project.
    runFilter = (['all', 'running', 'stopped', 'disabled'].includes(v) ? v : 'all') as RunFilter;
    saveFilterState(); renderProjects(); renderFilterBar();
}

function setSortKey(v: string): void {
    sortKey = (['name', 'newest', 'last-on'].includes(v) ? v : 'name') as SortKey;
    saveFilterState(); renderProjects(); renderFilterBar();
}

function toggleEmojiFilter(e: string): void {
    emojiFilter.has(e) ? emojiFilter.delete(e) : emojiFilter.add(e);
    saveFilterState(); renderProjects(); renderFilterBar();
}

function clearEmojiFilter(): void {
    emojiFilter.clear();
    saveFilterState(); renderProjects(); renderFilterBar();
}

// The addresses a project can be reached at FROM THIS MACHINE.
//
// A remote project's own URLs are useless here and were the thing I got wrong
// first time: `local_url` is http://<name>, resolved through the REMOTE host's
// /etc/hosts, and `lan_url` is that host's own view of its network — on EC2 the
// private VPC address, unroutable from anywhere else. Only `external_port` is
// portable: a port is the same number wherever the host is.
//
// So a remote project gets one link, composed from the address configured for
// that host plus its port.
function projectUrls(project: Project): string {
    if (project.status === 'stopped') return '';

    const hostId = (project as any).hostId || 'local';
    const link = (url: string) =>
        `<a href="#" class="url-link" data-testid="url-${escapeHtml(project.name)}"
            onclick="event.preventDefault(); openProjectUrl('${escapeHtml(url)}', '${escapeHtml(hostId)}'); return false;"
            >${escapeHtml(url)}</a>`;

    if (hostId === 'local') {
        // Labelled, because the two are not interchangeable: LOCAL is the
        // container address and only works from this machine, LAN is the route
        // from another. Unlabelled, they look like two equivalent links, and
        // sending a colleague the LOCAL one is how you send a link only you can
        // open.
        return [
            project.localUrl ? `<span class="url-scope">LOCAL</span>${link(project.localUrl)}` : '',
            project.portMapped && project.lanUrl
                ? `<span class="url-scope">LAN</span>${link(project.lanUrl)}` : ''
        ].join('');
    }

    const profile = sshProfiles.find((p) => p.id === hostId);
    if (!profile || !project.port) return '';
    return link(`http://${profile.host}:${project.port}`);
}

// Probe before opening, and explain a failure rather than handing the browser a
// dead address.
//
// On click rather than on render: probing every project on every poll is N
// requests per host per tick for something that rarely changes, and a result
// from the last tick can be stale by the time anyone clicks it. Asked at the
// moment it matters, the answer is always current.
// Where a project can be reached from this machine, straight from the CLI.
//
// Never derived from the project name: that only worked while Zeltro wrote
// /etc/hosts, and it no longer does.
async function projectLocalUrl(projectName: string): Promise<string> {
    try {
        const result = await ipcRenderer.invoke('execute-zeltro', 'status',
            [projectName, '--json-output']);
        if (result.code !== 0) return '';
        const found = (JSON.parse(result.stdout).projects || [])
            .find((p: any) => p.name === projectName);
        return found?.local_url || '';
    } catch {
        return '';
    }
}

async function openProjectUrl(url: string, hostId: string): Promise<void> {
    const address = url.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // Short deliberately. A blocked port is the slow failure — a dropped SYN
    // with no RST runs the timeout out in full, and that is the common case for
    // a cloud host. A fast wrong-ish "cannot reach it" beats a frozen window.
    const probe = await ipcRenderer.invoke('check-project-url', address, 2500);

    if (probe.code >= 200 && probe.code < 500) {
        openUrl(url);
        return;
    }

    const label = dashboardHosts.find((h) => h.id === hostId)?.label || hostId;
    // A timeout and a refusal are different facts and point at different fixes,
    // so they get different sentences rather than one vague failure.
    showError(probe.timedOut
        ? `${url} did not respond within 2.5s. If ${label} is a cloud host, the port `
          + `probably needs a firewall or security group rule — it is reachable on the `
          + `machine itself but not from here.`
        : `${url} could not be reached. ${label} may be asleep, off this network, or `
          + `refusing the connection.`);
}

function renderProjects(): void {
    const grid: HTMLElement | null = document.getElementById('projects-grid');
    if (!grid) return;

    // The grid is rebuilt wholesale on every poll. Any terminal living in a
    // tile has to be lifted out first or innerHTML destroys a running xterm
    // and its pty along with the markup around it.
    captureTileFocus();
    detachTileTerminals();

    if (projects.length === 0) {
        // On a machine that cannot run Zeltro locally and has no hosts yet,
        // "create your first project" points at something that cannot happen —
        // seen for real on the Windows box, where the button leads to a picker
        // with nothing in it. Say what is actually missing.
        const noWhereToRun = platformCaps && !platformCaps.localZeltro && dashboardHosts.length === 0;
        grid.innerHTML = noWhereToRun
            ? `
            <div class="project-card placeholder" data-testid="no-hosts-placeholder">
                <div class="project-icon">🖧</div>
                <h3>No Zeltro hosts yet</h3>
                <p>This machine runs projects on other computers. Add one to get started.</p>
                <button class="btn btn-primary" onclick="showSettings('hosts')">Add a host</button>
            </div>`
            : `
            <div class="project-card placeholder">
                <div class="project-icon">🚀</div>
                <h3>Create Your First Project</h3>
                <p>Get started by creating a new PHP, Laravel, or WordPress project</p>
                <button class="btn btn-primary" onclick="showCreateProject()">Create Project</button>
            </div>`;
        reattachTileTerminals();
        return;
    }

    // A host that did not answer contributes no tiles, which is
    // indistinguishable from a host with no projects. Say which, and why.
    const hostBanner = Object.keys(hostErrors).length > 0 && warnUnreachableHosts()
        ? `<div class="host-errors" data-testid="host-errors">${
            Object.entries(hostErrors).map(([id, err]) => {
                const label = dashboardHosts.find((h) => h.id === id)?.label || id;
                return `<p>⚠️ <strong>${escapeHtml(label)}</strong> did not respond — ${escapeHtml(err)}</p>`;
            }).join('')}</div>`
        : '';

    const shown = visibleProjects();
    if (shown.length === 0) {
        // Distinguish "no projects" from "your filter hid them all" — otherwise
        // a filter looks like data loss.
        grid.innerHTML = `
            <div class="project-card placeholder" data-testid="no-matches">
                <div class="project-icon">🔍</div>
                <h3>No projects match</h3>
                <p>${projects.length} project${projects.length === 1 ? '' : 's'} hidden by the current filter.</p>
                <button class="btn btn-primary" onclick="resetFilters()">Show all</button>
            </div>
        `;
        reattachTileTerminals();
        return;
    }

    grid.innerHTML = hostBanner + shown.map((parsed: Project) => {
        // Apply cached display metadata here rather than trusting the parsed
        // object — display fields arrive on it directly from status now.
        const project = withMetadata(parsed);

        // Use emoji from metadata or fallback to type-based icon
        const projectIcon = project.emoji ||
                           (project.type === 'laravel' ? '🎯' : 
                            project.type === 'wordpress' ? '📝' : '🐘');
        
        // Use display_name or fallback to name
        const displayName = project.display_name || project.name;
        
        // Show description if available
        const descriptionHtml = project.description ? 
            `<p class="project-description">${project.description}</p>` : '';

        // Get the emoji-based CSS class
        const emojiClass = getEmojiClass(projectIcon);
        
        // Status dot emoji (red for stopped, green for running)
        // Disabled is its own state, not a third kind of stopped: its container
        // does not exist, so docker cannot tell it from stopped and the dot has
        // to come from the metadata.
        const disabled = isDisabled(parsed);

        // Which machine, shown only when there is more than one. On a
        // single-host dashboard the badge would be on every tile and mean
        // nothing; with several it is the difference between two projects that
        // share a name.
        const pHost = (parsed as any).hostId || 'local';
        const hostBadge = dashboardHosts.length > 1
            ? `<span class="host-badge" data-testid="host-badge-${escapeHtml(pHost)}">${
                escapeHtml(dashboardHosts.find((h) => h.id === pHost)?.label || pHost)}</span>`
            : '';
        const statusDot = disabled ? '⏸️' : project.status === 'running' ? '🟢' : '🔴';
        const statusClass = disabled ? 'disabled' : project.status === 'running' ? 'running' : 'stopped';

        return `
            <div class="project-card ${emojiClass}${disabled ? ' project-disabled' : ''}"
                 data-project="${escapeHtml(project.name)}"
                 ${disabled ? 'data-testid="disabled-card"' : ''}>
                <div class="project-status-dot ${statusClass}" title="${disabled ? 'Disabled — parked, not deleted' : ''}">${statusDot}</div>
                <div class="project-header">
                    <div class="project-icon">${projectIcon}</div>
                    <h3>${displayName}</h3>
                    ${hostBadge}
                </div>
                ${descriptionHtml}
                <div class="project-details">
                    <div class="project-urls">${projectUrls(parsed)}</div>
                    <div class="project-actions">
                        ${disabled ? `
                        <!--
                            Parked. Start, Modify with AI and Edit are gone rather
                            than greyed: the CLI refuses startup on a disabled
                            project outright, so offering the button would only
                            produce an error. Trash stays — parking is often the
                            step before deleting, and the CLI still allows remove.
                        -->
                        <button class="btn btn-success btn-sm" data-testid="enable-${project.name}"
                                onclick="enableProject('${project.name}')"
                                title="Lift the block. Does not start it.">Enable</button>
                        <button class="btn btn-danger btn-sm" onclick="showRemoveProjectModal('${project.name}')">Trash</button>
                        ` : `
                        ${project.status !== 'stopped' ?
                            `<button class="btn btn-warning btn-sm" onclick="stopProject('${project.name}')">Stop</button>` :
                            `<button class="btn btn-success btn-sm" onclick="startProject('${project.name}')">Start</button>`
                        }
                        <button class="btn btn-create btn-sm" onclick="modifyWithAI('${project.name}')" title="Continue the AI session in this project">✨ Modify with AI</button>
                        <button class="btn btn-secondary btn-sm" onclick="editProject('${project.name}')">Edit</button>
                        <button class="btn btn-secondary btn-sm" data-testid="disable-${project.name}"
                                onclick="disableProject('${project.name}')"
                                title="Park it: stops it and hides it, keeping files, database and volumes">Disable</button>
                        <button class="btn btn-danger btn-sm" onclick="showRemoveProjectModal('${project.name}')">Trash</button>
                        `}
                    </div>
                    <!-- Where an agent session lands. Empty until one is open;
                         the pane is moved in rather than rebuilt, because
                         re-rendering it would kill the terminal. -->
                    <div class="tile-terminal-host" data-terminal-host="${escapeHtml(project.name)}"></div>
                </div>
            </div>
        `;
    }).join('');

    reattachTileTerminals();
}



async function loadServices(): Promise<void> {
    try {
        const result = await ipcRenderer.invoke('execute-zeltro-on', servicesHost,
            'status', ['--all', '--json-output']);

        if (result.code !== 0) {
            console.log('Services status command failed, likely no services running');
            sharedServices = {};
            renderServices();
            return;
        }
        
        // Services ONLY, from the SELECTED host. This used to call the full parser, which rebuilds the
        // project list — so on a multi-host dashboard it wiped the union and
        // refilled it from the local host alone, and whichever of loadProjects
        // and loadServices finished last decided what the grid showed.
        //
        // Exactly the shape of the metadata-cache race removed earlier: two
        // loaders owning one piece of state. This one owns shared services and
        // nothing else.
        try {
            const data = JSON.parse(result.stdout);
            sharedServices = data.shared_services || {};
        } catch (error) {
            console.log('Services status output did not parse');
        }
        renderServices();
    } catch (error) {
        console.error('Failed to load services:', error);
        renderServices();
    }
}

// Optional shared services, per the CLI's `zeltro enable-service`. Kept as a
// list rather than inferred, so a core service is never hidden by accident.
// The service catalogue comes from the CLI now — `zeltro enable-service
// --json-output` returns slug, group, description, address and state, all
// generated from the same catalogue the CLI validates against.
//
// The GUI used to keep its own copy, which existed only because that listing
// did not exist. It drifted the moment the CLI went from two services to nine,
// and the contract test written to catch that drift is why this replaced it
// rather than being patched.
interface OptionalService {
    slug: string;
    group: string;
    description: string;
    address: string;
    // disabled | enabled_not_running | running
    state: string;
}

let optionalServices: OptionalService[] = [];
let alwaysOnServices: string[] = [];
let serviceCatalogError = '';

function optionalServiceNames(): string[] {
    return optionalServices.map(s => s.slug);
}
let enabledOptionalServices: string[] = [];

// ---------------------------------------------------------------------------
// Shared service manager
// ---------------------------------------------------------------------------

let servicesInUse: Record<string, string[]> = {};

// Which host the Shared Services panel is showing and acting on.
//
// Everything in that panel follows it — the cards, Start/Stop, the Manage
// window, and the in-use guard. Before this the panel DISPLAYED whichever host
// answered the status poll while its BUTTONS always acted locally, which on
// Windows meant looking at a remote machine's services and operating on a local
// Zeltro that does not exist.
let servicesHost = 'local';

function renderServicesHostPicker(): void {
    const sel = document.getElementById('services-host') as HTMLSelectElement | null;
    if (!sel) return;

    // One host needs no choosing, and a dropdown with a single entry is noise.
    if (dashboardHosts.length < 2) {
        sel.style.display = 'none';
        if (dashboardHosts.length === 1) servicesHost = dashboardHosts[0]!.id;
        return;
    }

    // A host can disappear when its profile is removed; fall back rather than
    // leaving the panel pointed at nothing.
    if (!dashboardHosts.some((h) => h.id === servicesHost)) {
        servicesHost = dashboardHosts[0]!.id;
    }

    sel.style.display = '';
    sel.innerHTML = dashboardHosts.map((h) =>
        `<option value="${escapeHtml(h.id)}"${h.id === servicesHost ? ' selected' : ''}>${escapeHtml(h.label)}</option>`
    ).join('');
}

async function setServicesHost(hostId: string): Promise<void> {
    servicesHost = hostId;
    await loadOptionalServices();
    await loadServices();
    renderServices();
}

async function showServiceManager(): Promise<void> {
    showModal('service-manager-modal');
    await refreshServiceCatalog();
    servicesInUse = await ipcRenderer.invoke('get-services-in-use', servicesHost) || {};
    renderServiceManager();
}

async function refreshServiceCatalog(): Promise<void> {
    const catalog = await ipcRenderer.invoke('get-service-catalog', servicesHost);
    optionalServices = catalog.services || [];
    alwaysOnServices = catalog.always_on || [];
    serviceCatalogError = catalog.error || '';
}

// Cover the row being toggled and say which way it is going. Cleared by the
// re-render that follows, so there is no separate teardown to forget.
function setServiceRowBusy(slug: string, label: string): void {
    const row = document.querySelector(`[data-testid="service-row-${slug}"]`);
    if (!row) return;

    row.classList.add('busy');
    row.querySelectorAll('button').forEach(b => ((b as HTMLButtonElement).disabled = true));

    const overlay = document.createElement('div');
    overlay.className = 'service-row-busy';
    overlay.dataset.testid = `service-busy-${slug}`;
    overlay.innerHTML = `<span class="loading-spinner"></span><span>${escapeHtml(label)}</span>`;
    row.appendChild(overlay);
}

// The CLI's group names, in the order they should appear.
const SERVICE_GROUPS: Array<[string, string]> = [
    ['database', 'Databases'],
    ['admin-ui', 'Admin interfaces'],
    ['storage-search', 'Storage and search']
];

function renderServiceManager(): void {
    const host = document.getElementById('service-manager-list');
    if (!host) return;

    if (serviceCatalogError) {
        host.innerHTML = `<p class="app-list-empty">${escapeHtml(serviceCatalogError)}<br>
            <small>Run <code>zeltro update</code>, then reopen this window.</small></p>`;
        return;
    }

    // Anything in an unrecognised group still gets shown, at the end. A service
    // the CLI adds under a new group name must never become invisible here —
    // that is the drift this window was rewritten to stop having.
    const known = SERVICE_GROUPS.map(([g]) => g);
    const extras = [...new Set(optionalServices.map(s => s.group).filter(g => !known.includes(g)))];
    const groups: Array<[string, string]> = [...SERVICE_GROUPS, ...extras.map(g => [g, g] as [string, string])];

    host.innerHTML = groups.map(([group, heading]) => {
        const members = optionalServices.filter(svc => svc.group === group);
        if (members.length === 0) return '';

        const rows = members.map(svc => {
            // State comes from the CLI, which distinguishes "configured on" from
            // "actually running" — a service can die after a successful enable.
            const on = svc.state !== 'disabled';
            const running = svc.state === 'running';
            const users = servicesInUse[svc.slug] || [];
            // Turning off a database a project points at leaves it unable to
            // connect. The CLI is adding its own refusal; this stops the GUI
            // offering the button in the first place.
            const locked = on && users.length > 0;
            const label = svc.state === 'running' ? 'running'
                : svc.state === 'enabled_not_running' ? 'enabled, not running' : 'off';

            return `
                <div class="service-row${locked ? ' locked' : ''}" data-testid="service-row-${svc.slug}">
                    <div class="service-row-main">
                        <strong>${escapeHtml(svc.slug)}</strong>
                        <code class="app-slug">${escapeHtml(svc.address || '')}</code>
                        <span class="service-state ${running ? 'on' : on ? 'stale' : 'off'}">${label}</span>
                    </div>
                    <p class="service-note">${escapeHtml(svc.description || '')}</p>
                    ${locked ? `<p class="service-note service-locked-note">In use by ${users.map(escapeHtml).join(', ')} — disabling would break ${users.length === 1 ? 'it' : 'them'}.</p>` : ''}
                    <button class="btn btn-small ${on ? 'btn-warning' : 'btn-success'}"
                            data-testid="toggle-${svc.slug}"
                            ${locked ? 'disabled title="A project is using this"' : ''}
                            onclick="toggleOptionalService('${svc.slug}')">${on ? 'Disable' : 'Enable'}</button>
                </div>`;
        }).join('');

        return `<div class="service-group"><h4>${escapeHtml(heading)}</h4>${rows}</div>`;
    }).join('');

    const always = document.getElementById('service-always-on');
    if (always) {
        always.textContent = alwaysOnServices.length
            ? `Always on and not listed here: ${alwaysOnServices.join(', ')}. `
              + `They are small, and their absence produces confusing failures rather than clear ones.`
            : '';
    }
}

async function toggleOptionalService(name: string): Promise<void> {
    const svc = optionalServices.find(s => s.slug === name);
    const on = !!svc && svc.state !== 'disabled';
    const command = on ? 'disable-service' : 'enable-service';

    // Enabling pulls an image and starts a container — seconds at best, much
    // longer on a cold pull. Without this the row sits unchanged and the click
    // looks like it did nothing, so people click again.
    setServiceRowBusy(name, on ? 'Stopping…' : 'Starting…');

    const result = await ipcRenderer.invoke('execute-zeltro-on', servicesHost, command, [name, '--json-output']);
    if (result.code !== 0) {
        showError(`Could not ${on ? 'disable' : 'enable'} ${name}: ${result.stderr || result.stdout}`);
    } else {
        showSuccess(`${name} ${on ? 'disabled' : 'enabled'}.`);
    }

    // Re-read either way. A failed enable used to leave the service recorded as
    // on; the CLI now rolls that back, and re-reading is what makes the window
    // show whichever of those is true rather than assuming.
    await loadOptionalServices();
    await refreshServiceCatalog();
    servicesInUse = await ipcRenderer.invoke('get-services-in-use', servicesHost) || {};
    renderServiceManager();
    renderServices();
}

async function loadOptionalServices(): Promise<void> {
    try {
        enabledOptionalServices = await ipcRenderer.invoke('get-optional-services') || [];
    } catch (error) {
        console.log('Could not read OPTIONAL_SERVICES:', error);
        enabledOptionalServices = [];
    }
}

function renderServices(): void {
    const servicesGrid: HTMLElement | null = document.getElementById('services-grid');
    if (!servicesGrid) return;

    if (!sharedServices || Object.keys(sharedServices).length === 0) {
        servicesGrid.innerHTML = `
            <div class="service-card">
                <div class="service-status">⚪</div>
                <h4>No Services</h4>
                <p>${platformCaps && !platformCaps.localZeltro
                    ? 'Services belong to a host. Add one under Settings.'
                    : 'Start Zeltro to see shared services'}</p>
            </div>
        `;
        return;
    }

    // Hide optional services this machine has not enabled. zeltro status reports
    // minio/meilisearch as "stopped" whether or not they were ever turned on,
    // and a red "Stopped" card reads as a broken service rather than an unused
    // feature. Anything enabled via `zeltro enable-service` shows normally.
    const visibleServices = Object.entries(sharedServices).filter(([serviceName]) => {
        const key = serviceName.replace(/^(zeltro|podium)-/, '').toLowerCase();
        return !optionalServiceNames().includes(key) || enabledOptionalServices.includes(key);
    });

    if (visibleServices.length === 0) {
        servicesGrid.innerHTML = `
            <div class="service-card">
                <div class="service-status">⚪</div>
                <h4>No Services</h4>
                <p>Start Zeltro to see shared services</p>
            </div>
        `;
        return;
    }

    servicesGrid.innerHTML = visibleServices.map(([serviceName, service]: [string, SharedService]) => {
        const statusText = service.status === 'running' ? 'Running' : 'Stopped';

        // zeltro status keys these as `zeltro-<name>`. The action buttons below
        // compared the raw key against bare names, so NONE of them has ever
        // rendered — every service card has been actionless.
        // Either prefix — see the note on the visibility filter above. Stripping
        // only one left every slug wrong, so no card matched redis/memcached and
        // none offered its Manage button.
        const slug = serviceName.replace(/^(zeltro|podium)-/, '').toLowerCase();
        // The listing calls MariaDB "mysql"; status calls the container mariadb.
        const listed = optionalServices.find(
            svc => svc.slug === slug || (svc.slug === 'mysql' && slug === 'mariadb'));

        // Web UI address comes from the CLI listing, which is rewritten on every
        // enable — optional services moved to .250-.254, so anything hardcoded
        // here would point at the old address.
        const webUi = listed && listed.group === 'admin-ui' && listed.address
            ? (listed.address.startsWith('http') ? listed.address : `http://${listed.address}`)
            : slug === 'mailhog' ? 'http://localhost:8025'
            : '';
        
        // Handle IP and port display
        let ipInfo = '';
        // The CLI currently emits the subnet with its quotes attached —
        // VPC_SUBNET="10.247.177" is read from .env without stripping them, so
        // ip_address arrives as "10.247.177".8 and renders exactly like that.
        // Reported to the CLI; stripping here so a real address is shown until
        // that lands, and harmlessly after. An address is never quoted, so this
        // cannot discard anything meaningful.
        const cleanIp = (service.ip_address || '').replace(/"/g, '');

        if (cleanIp) {
            if (service.port) {
                ipInfo = `${cleanIp}:${service.port}`;
            } else if (serviceName === 'phpmyadmin') {
                ipInfo = `${cleanIp}:80`; // Default port for phpMyAdmin
            } else {
                ipInfo = cleanIp;
            }
        } else if (service.port) {
            ipInfo = `Port ${service.port}`;
        }
        
        return `
            <div class="service-card">
                <div class="service-header">
                    <div class="service-title">
                        <div class="status-indicator ${service.status === 'running' ? 'running' : 'stopped'}"></div>
                        <h3>${service.name}</h3>
                    </div>
                </div>
                <div class="service-info">
                    <p>${statusText}</p>
                    ${ipInfo ? `<div class="service-ip">${ipInfo}</div>` : ''}
                </div>
                <div class="service-actions">
                    ${(slug === 'redis' || slug === 'memcached') && service.status === 'running' ?
                        `<button class="btn btn-secondary btn-sm" onclick="showManageModal('${slug}')">Manage</button>` :
                        ''
                    }
                    ${webUi && service.status === 'running' ?
                        `<button class="btn btn-primary btn-sm" data-testid="open-${slug}" onclick="openUrl('${escapeHtml(webUi)}')">🌐 Open Web UI</button>` :
                        ''
                    }
                </div>
            </div>
        `;
    }).join('');
}

// Project management functions
// The CLI returns a machine-readable code for a refused startup. Parsing is
// best-effort: a non-JSON body just means "not that case".
function startupErrorCode(stdout: string): string {
    try {
        return JSON.parse(stdout || '{}').error || '';
    } catch {
        return '';
    }
}

// Which host a project lives on, by name. Actions take a name from the DOM, so
// this is where the name is turned back into a machine.
//
// Defaults to local when the project is unknown — but a project is only unknown
// if the grid is mid-refresh, and the alternative (refusing) would make buttons
// intermittently dead. The wrong-host risk is bounded because a name that
// exists on two hosts resolves to whichever the grid currently holds, and the
// grid is what the user clicked.
function hostOf(projectName: string): string {
    const p = projects.find((x) => x.name === projectName);
    return (p as any)?.hostId || 'local';
}

// Same shape as `execute-zeltro` but aimed at the project's own machine.
function zeltroFor(projectName: string, subcommand: string, args: string[] = []): Promise<any> {
    return ipcRenderer.invoke('execute-zeltro-on', hostOf(projectName), subcommand, args);
}

async function startProject(projectName: string): Promise<void> {
    try {
        setTileBusy(projectName, 'Starting…');
        // In a finally, not after the await: a throw here would otherwise leave
        // the tile blocked for the rest of the session with its own buttons
        // disabled, and nothing to un-stick it but a restart.
        let result;
        try {
            result = await zeltroFor(projectName, 'up', [projectName, '--json-output']);
        } finally {
            clearTileBusy(projectName);
        }
        
        if (result.code === 0) {
            showSuccess(`Project ${projectName} started successfully`);
        } else if (startupErrorCode(result.stdout) === 'project_disabled') {
            // Key on the error CODE, not the message text, as the CLI asked.
            // Reaching this means the grid was stale rather than that the user
            // did something wrong, so say what to do instead of showing a
            // failure they cannot act on.
            showError(`${projectName} is disabled. Enable it first — it is under the "Disabled" filter.`);
        } else {
            showError(`Failed to start project: ${result.stderr || result.stdout}`);
        }
        
        // Refresh project list
        setTimeout(() => {
            loadProjects();
            loadServices();
        }, 2000);
    } catch (error) {
        hideLoadingOverlay();
        showError('Error starting project: ' + (error as Error).message);
    }
}

async function stopProject(projectName: string): Promise<void> {
    try {
        setTileBusy(projectName, 'Stopping…');
        // In a finally, not after the await: a throw here would otherwise leave
        // the tile blocked for the rest of the session with its own buttons
        // disabled, and nothing to un-stick it but a restart.
        let result;
        try {
            result = await zeltroFor(projectName, 'down', [projectName, '--json-output']);
        } finally {
            clearTileBusy(projectName);
        }
        
        if (result.code === 0) {
            showSuccess(`Project ${projectName} stopped successfully`);
        } else {
            showError(`Failed to stop project: ${result.stderr || result.stdout}`);
        }
        
        // Refresh project list
        setTimeout(() => {
            loadProjects();
            loadServices();
        }, 2000);
    } catch (error) {
        hideLoadingOverlay();
        showError('Error stopping project: ' + (error as Error).message);
    }
}

async function removeProject(projectName: string): Promise<void> {
    // First confirmation
    if (!confirm(`Are you sure you want to remove project "${projectName}"?\n\nThis will remove the project files and Docker container.`)) {
        return;
    }

    // Asked so that OK is the DESTRUCTIVE answer, not the safe one.
    //
    // This used to ask "keep the database?" with OK = keep. confirm() returns
    // false when the dialog is dismissed, so Escape or the window X deleted the
    // data — the destructive path was what you got for not answering. Now
    // dismissing keeps everything and destroying requires a deliberate OK.
    //
    // The wording names the volumes too: --force-db-delete now removes the
    // project's named volumes as well as its database (CLI 77484a0), which for
    // most apps is uploads, config and media. Saying only "database" would
    // promise less than the flag destroys.
    const deleteData = confirm(
        `Also delete the stored data for "${projectName}"?\n\n`
        + `This drops its database AND its Docker volumes — uploads, configuration `
        + `and media are destroyed and cannot be recovered.\n\n`
        + `OK to delete everything. Cancel to keep the data.`);
    const preserveDatabase = !deleteData;

    try {
        showLoadingOverlay('Removing Project', `Removing project ${projectName}...`);
        
        // zeltro remove PRESERVES the database by default; --force-db-delete is
        // what drops it. (The legacy --force flag is an alias for
        // --force-db-delete, not "skip prompts" — passing it here used to delete
        // databases the user asked to keep.)
        const args = [projectName, '--json-output'];
        args.push(preserveDatabase ? '--preserve-database' : '--force-db-delete');

        const result = await zeltroFor(projectName, 'remove', args);
        
        hideLoadingOverlay();
        
        if (result.code === 0) {
            const dbMessage = preserveDatabase
                ? ' (database and stored data kept)'
                : ' (database and stored data deleted)';
            showSuccess(`Project ${projectName} removed successfully${dbMessage}`);
        } else {
            showError(`Failed to remove project: ${result.stderr || result.stdout}`);
        }
        
        // Refresh project list
        setTimeout(() => {
            loadProjects();
            loadServices();
        }, 2000);
    } catch (error) {
        hideLoadingOverlay();
        showError('Error removing project: ' + (error as Error).message);
    }
}

// ---------------------------------------------------------------------------
// Disable / enable — parking a project rather than deleting it
// ---------------------------------------------------------------------------

async function disableProject(projectName: string): Promise<void> {
    if (!confirm(`Disable "${projectName}"?\n\n`
        + `It stops, disappears from the project list, and cannot be started or `
        + `edited until you enable it again.\n\n`
        + `Files, database and volumes are all kept — nothing is deleted.\n\n`
        + `Find it again with the "Disabled" filter.`)) return;

    setTileBusy(projectName, 'Disabling…');
    let result;
    try {
        result = await zeltroFor(projectName, 'disable', [projectName, '--json-output']);
    } finally {
        clearTileBusy(projectName);
    }
    if (result.code === 0) {
        // Say where it went. A project vanishing from the grid with only a
        // "done" toast is indistinguishable from having deleted it.
        showSuccess(`${projectName} disabled — find it under the "Disabled" filter.`);
    } else {
        showError(`Could not disable ${projectName}: ${result.stderr || result.stdout}`);
    }
    await loadProjects();
    renderFilterBar();
}

async function enableProject(projectName: string): Promise<void> {
    setTileBusy(projectName, 'Enabling…');
    let result;
    try {
        result = await zeltroFor(projectName, 'enable', [projectName, '--json-output']);
    } finally {
        clearTileBusy(projectName);
    }
    if (result.code === 0) {
        // enable deliberately does not start it, so do not imply that it did.
        showSuccess(`${projectName} enabled. Start it when you are ready.`);
    } else {
        showError(`Could not enable ${projectName}: ${result.stderr || result.stdout}`);
    }
    await loadProjects();
    renderFilterBar();
}

function refreshProjects(): void {
    manualRefresh();
    
    // Show completion notification after a brief delay
    setTimeout(() => {
        showNotification('✅ Projects refreshed', 'success', 2000);
    }, 1000);
}

function openUrl(url: string): void {
    shell.openExternal(url);
}

async function showCreateProject(): Promise<void> {
    showModal('new-project-modal');
    refreshMicButtons();
    await showProjectHostStep();
}

// ---------------------------------------------------------------------------
// New Project, step one: framework or ready-made app
//
// The header used to carry a separate Install App button. Both flows create a
// project, so the question belongs at the front of one flow rather than in two
// competing buttons the user has to tell apart before clicking.
// ---------------------------------------------------------------------------

// Which machine a new project is created on. 'local' or an SSH profile id.
let newProjectHost = 'local';

// Step zero: pick the host, if there is a choice to make.
//
// Skipped when there is exactly one option, because a question with one answer
// is friction rather than a choice. That is the common case: one machine, no
// profiles.
async function showProjectHostStep(): Promise<void> {
    const hostEl = document.getElementById('new-project-host');
    const choice = document.getElementById('new-project-choice');
    const form = document.getElementById('new-project-form');
    const footer = document.getElementById('new-project-footer');
    if (!hostEl) return;

    if (form) form.style.display = 'none';
    if (footer) footer.style.display = 'none';

    const caps = await ipcRenderer.invoke('get-platform-capabilities');
    await loadSshProfiles();

    // Windows has no local Zeltro and never will, so "local" is not offered
    // there at all rather than offered and failing.
    const options: Array<{ id: string; label: string; note: string }> = [];
    if (caps.localZeltro) {
        options.push({ id: 'local', label: 'This computer',
                       note: 'The Zeltro install on this machine.' });
    }
    for (const p of sshProfiles) {
        if (!p.host) continue;   // half-entered host
        // The username lives on the credential now. Reading it off the host
        // gave "undefined@192.168.1.10" — the field moved and this did not.
        const cred = sshCredentials.find((c) => c.id === p.credentialId);
        options.push({
            id: p.id,
            label: p.label || p.host,
            note: cred?.user ? `${cred.user}@${p.host}` : p.host
        });
    }

    if (options.length === 0) {
        // Windows with no hosts yet. Nothing to choose, and the fix is in
        // Settings, so say so rather than showing an empty chooser.
        hostEl.style.display = 'block';
        if (choice) choice.style.display = 'none';
        hostEl.innerHTML = `
            <p class="app-list-empty" data-testid="no-hosts">
                No Zeltro hosts available.<br>
                ${caps.remoteOnly
                    ? 'Windows runs projects on a remote host. Add one under Settings → SSH Hosts.'
                    : 'Add an SSH host under Settings, or install Zeltro on this machine.'}
            </p>
            <button class="btn btn-primary" data-testid="no-hosts-settings"
                    onclick="closeModal(); showSettings('hosts')">Open SSH Hosts settings</button>`;
        return;
    }

    if (options.length === 1) {
        newProjectHost = options[0]!.id;
        hostEl.style.display = 'none';
        showProjectKindStep();
        return;
    }

    hostEl.style.display = 'grid';
    if (choice) choice.style.display = 'none';
    hostEl.innerHTML = options.map((o) => `
        <button type="button" class="kind-option" data-testid="host-${escapeHtml(o.id)}"
                onclick="chooseProjectHost('${escapeHtml(o.id)}')">
            <span class="kind-icon">${o.id === 'local' ? '💻' : '🖧'}</span>
            <strong>${escapeHtml(o.label)}</strong>
            <span class="kind-note">${escapeHtml(o.note)}</span>
        </button>`).join('');
}

function chooseProjectHost(hostId: string): void {
    newProjectHost = hostId;
    const hostEl = document.getElementById('new-project-host');
    if (hostEl) hostEl.style.display = 'none';
    showProjectKindStep();
}

function showProjectKindStep(): void {
    const choice = document.getElementById('new-project-choice');
    const form = document.getElementById('new-project-form');
    const footer = document.getElementById('new-project-footer');
    const hostEl = document.getElementById('new-project-host');

    if (hostEl) hostEl.style.display = 'none';
    if (choice) choice.style.display = 'grid';
    if (form) form.style.display = 'none';
    // The footer's Create button acts on the form; showing it beside the
    // choice would offer to submit a form that is not on screen.
    if (footer) footer.style.display = 'none';
}

async function chooseProjectKind(kind: 'framework' | 'app'): Promise<void> {
    if (kind === 'app') {
        // Unchanged installer flow — only the way into it has moved.
        closeModal();
        await showInstallApp();
        return;
    }

    const choice = document.getElementById('new-project-choice');
    const form = document.getElementById('new-project-form');
    const footer = document.getElementById('new-project-footer');

    if (choice) choice.style.display = 'none';
    if (form) form.style.display = '';
    if (footer) footer.style.display = '';

    // From the chosen host's CLI, not this machine's — a remote host offers
    // whatever ITS install ships.
    await loadFrameworkCatalog(newProjectHost);
}

// Back out of the install picker to the choice, rather than closing outright
// and making the user find New Project again.
function backToProjectKind(): void {
    closeModal();
    showModal('new-project-modal');
    showProjectKindStep();
}



// Modal management
function showModal(modalId: string): void {
    console.log('DEBUG: showModal called with modalId:', modalId);
    const modal: HTMLElement | null = document.getElementById(modalId);
    console.log('DEBUG: modal element found:', !!modal);
    if (modal) {
        modal.classList.add('show');
        console.log('DEBUG: modal show class added');
    }
}

// Make showModal available globally immediately
(window as any).showModal = showModal;

function hideModal(modalId: string): void {
    const modal: HTMLElement | null = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
    }
}

// Auto-refresh projects and services every 10 seconds (disabled in debug mode)
function startAutoRefresh(): void {
    if (!isDebugMode && !autoRefreshInterval) {
        autoRefreshInterval = setInterval((): void => {
            loadProjects();
            loadServices();
        }, 10000);
        console.log('Auto-refresh started (10s interval)');
    } else if (isDebugMode) {
        console.log('Auto-refresh disabled in debug mode - use F5 to refresh manually');
    }
}

function stopAutoRefresh(): void {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        console.log('Auto-refresh stopped');
    }
}

// Manual refresh function
function manualRefresh(): void {
    console.log('Manual refresh triggered');
    showNotification('🔄 Refreshing...', 'info', 2000);
    loadProjects();
    loadServices();
}

// Start auto-refresh unless in debug mode
startAutoRefresh();

// Loading overlay functions
// When `streamOutput` is set, the overlay grows a live output pane fed by
// command-stream-data. Long operations (scaffolding a framework pulls
// composer/npm/pip) otherwise showed a spinner and nothing else for minutes.
let overlayStreaming = false;

function showLoadingOverlay(
    message: string = 'Please wait...',
    details: string = 'Processing your request',
    streamOutput: boolean = false
): void {
    const overlay = document.getElementById('loading-overlay');
    const messageEl = document.getElementById('loading-message');
    const detailsEl = document.getElementById('loading-details');
    const output = document.getElementById('loading-output');

    if (overlay && messageEl && detailsEl) {
        messageEl.textContent = message;
        detailsEl.textContent = details;
        overlay.style.display = 'flex';
    }

    overlayStreaming = streamOutput;
    if (output) {
        output.textContent = '';
        output.style.display = streamOutput ? 'block' : 'none';
    }
}

// Fed by execute-command-stream. Kept separate from the install modal's pane so
// the two can be open independently.
ipcRenderer.on('command-stream-data', (_event: any, payload: { type: string; data: string }) => {
    if (!overlayStreaming) return;

    const output = document.getElementById('loading-output');
    if (!output) return;

    // Strip ANSI colour — this is a plain <pre>, not a terminal.
    output.textContent += payload.data.replace(/\x1b\[[0-9;]*m/g, '');
    output.scrollTop = output.scrollHeight;
});

// Keep the overlay up with its output when something fails, so the user can
// actually read why. Previously the whole of stdout — curl progress bars and
// all — was concatenated into a toast, which was unreadable.
function failLoadingOverlay(message: string, details: string): void {
    overlayStreaming = false;

    const messageEl = document.getElementById('loading-message');
    const detailsEl = document.getElementById('loading-details');
    const spinner = document.querySelector('#loading-overlay .loading-spinner') as HTMLElement;
    const dismiss = document.getElementById('loading-dismiss');

    if (messageEl) messageEl.textContent = message;
    if (detailsEl) detailsEl.textContent = details;
    if (spinner) spinner.style.display = 'none';
    if (dismiss) dismiss.style.display = 'inline-block';
}

function hideLoadingOverlay(): void {
    overlayStreaming = false;

    const spinner = document.querySelector('#loading-overlay .loading-spinner') as HTMLElement;
    const dismiss = document.getElementById('loading-dismiss');
    if (spinner) spinner.style.display = '';
    if (dismiss) dismiss.style.display = 'none';
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

// Initial loading screen functions
function showInitialLoading(): void {
    const initialLoading = document.getElementById('initial-loading');
    if (initialLoading) {
        initialLoading.style.display = 'flex';
        initialLoading.classList.remove('hide');
    }
}

function hideInitialLoading(): void {
    const initialLoading = document.getElementById('initial-loading');
    if (initialLoading) {
        initialLoading.classList.add('hide');
        // Remove from DOM after transition completes
        setTimeout(() => {
            initialLoading.style.display = 'none';
        }, 500);
    }
}

// Utility functions
let currentNotification: HTMLElement | null = null;

function showLoading(message: string): void {
    hideNotification();
    currentNotification = showNotification(message, 'loading', 0);
}

function showSuccess(message: string): void {
    hideNotification();
    currentNotification = showNotification(message, 'success', 5000);
}

function showError(message: string): void {
    hideNotification();
    currentNotification = showNotification(message, 'error', 8000);
}

function hideNotification(): void {
    if (currentNotification) {
        currentNotification.remove();
        currentNotification = null;
    }
}

function showNotification(message: string, type: 'success' | 'error' | 'warning' | 'info' | 'loading' = 'info', duration: number = 5000): HTMLElement {
    hideNotification();

    const notification: HTMLElement = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
        <div class="notification-content">
            <span class="notification-message">${message}</span>
            <button class="notification-close" onclick="this.parentElement.parentElement.remove()">×</button>
        </div>
    `;

    document.body.appendChild(notification);

    // Auto-hide after duration (if duration > 0)
    if (duration > 0) {
        setTimeout((): void => {
            if (notification.parentNode) {
                notification.remove();
                if (currentNotification === notification) {
                    currentNotification = null;
                }
            }
        }, duration);
    }

    return notification;
}

// Debug logging for renderer
if (ipcRenderer) {
    const originalConsoleLog = console.log;
    console.log = function(...args: any[]): void {
        originalConsoleLog.apply(console, args);
        if (ipcRenderer) {
            ipcRenderer.invoke('renderer-log', ...args);
        }
    }
    
    // Log that renderer is ready
    if (document.readyState === 'loading') {
        ipcRenderer.invoke('renderer-log', '🎯 DOM loaded, initializing...');
    }
    
    loadProjects();
    loadServices();
    
    // Add functions to global scope for debugging
    (window as any).testStartProject = testStartProject;
    (window as any).startProject = startProject;
    
    console.log('✅ Initialization complete, functions available:', {
        testStartProject: typeof (window as any).testStartProject,
        startProject: typeof (window as any).startProject
    });
}

// Test function for debugging
async function testStartProject(projectName: string): Promise<void> {
    console.log('🧪 Testing startProject with:', projectName);
    try {
        const result = await zeltroFor(projectName, 'up', [projectName]);
        console.log('✅ Command result:', result);
    } catch (error) {
        console.error('❌ Command failed:', error);
    }
}

// Service management functions
async function startServices(): Promise<void> {
    try {
        showLoadingOverlay('Starting Services', 'Starting all shared services...');
        // No flags: the zeltro dispatcher invokes start_services.sh/stop_services.sh
        // without forwarding arguments, so --json-output never reaches them.
        // Success is judged by the exit code.
        const result = await ipcRenderer.invoke('execute-zeltro-on', servicesHost, 'start-services', []);
        
        hideLoadingOverlay();
        
        if (result.code === 0) {
            showSuccess('Shared services started successfully');
        } else {
            showError(`Failed to start services: ${result.stderr || result.stdout}`);
        }
        
        // Refresh both services and projects status
        setTimeout(() => {
            loadServices();
            loadProjects();
        }, 2000);
    } catch (error) {
        hideLoadingOverlay();
        showError('Error starting services: ' + (error as Error).message);
    }
}

async function stopServices(): Promise<void> {
    try {
        showLoadingOverlay('Stopping Services', 'Stopping all shared services...');
        const result = await ipcRenderer.invoke('execute-zeltro-on', servicesHost, 'stop-services', []);
        
        hideLoadingOverlay();
        
        if (result.code === 0) {
            showSuccess('Shared services stopped successfully');
        } else {
            showError(`Failed to stop services: ${result.stderr || result.stdout}`);
        }
        
        // Refresh both services and projects status
        setTimeout(() => {
            loadServices();
            loadProjects();
        }, 2000);
    } catch (error) {
        hideLoadingOverlay();
        showError('Error stopping services: ' + (error as Error).message);
    }
}

async function startAllProjects(): Promise<void> {
    if (projects.length === 0) {
        showNotification('No projects to start', 'info', 3000);
        return;
    }
    
    try {
        // Start all stopped projects
        const stoppedProjects = projects.filter(p => p.status === 'stopped');
        
        if (stoppedProjects.length === 0) {
            showNotification('All projects are already running', 'info', 3000);
            return;
        }
        
        // Show loading overlay
        showLoadingOverlay('Starting All Projects', `Starting ${stoppedProjects.length} project(s)...`);
        
        let successCount = 0;
        let failCount = 0;
        
        for (let i = 0; i < stoppedProjects.length; i++) {
            const project = stoppedProjects[i];
            if (!project) continue;
            
            // Update progress
            showLoadingOverlay(
                'Starting All Projects', 
                `Starting ${project.name} (${i + 1} of ${stoppedProjects.length})...`
            );
            
            try {
                const result = await zeltroFor(project.name, 'up', [project.name, '--json-output']);
                if (result.code === 0) {
                    successCount++;
                } else {
                    failCount++;
                    console.error(`Failed to start ${project.name}:`, result.stderr);
                }
            } catch (error) {
                failCount++;
                console.error(`Error starting ${project.name}:`, error);
            }
        }
        
        // Hide loading overlay
        hideLoadingOverlay();
        
        if (failCount === 0) {
            showSuccess(`Successfully started ${successCount} projects`);
        } else if (successCount > 0) {
            showNotification(`Started ${successCount} projects, ${failCount} failed`, 'info', 5000);
        } else {
            showError(`Failed to start all ${failCount} projects`);
        }
        
        // Refresh project list
        setTimeout(() => {
            loadProjects();
            loadServices();
        }, 3000);
    } catch (error) {
        hideLoadingOverlay();
        showError('Error starting projects: ' + (error as Error).message);
    }
}

async function stopAllProjects(): Promise<void> {
    if (projects.length === 0) {
        showNotification('No projects to stop', 'info', 3000);
        return;
    }
    
    try {
        // Stop all running projects
        const runningProjects = projects.filter(p => p.status === 'running' || p.status === 'starting');
        
        if (runningProjects.length === 0) {
            showNotification('All projects are already stopped', 'info', 3000);
            return;
        }
        
        // Show loading overlay
        showLoadingOverlay('Stopping All Projects', `Stopping ${runningProjects.length} project(s)...`);
        
        let successCount = 0;
        let failCount = 0;
        
        for (let i = 0; i < runningProjects.length; i++) {
            const project = runningProjects[i];
            if (!project) continue;
            
            // Update progress
            showLoadingOverlay(
                'Stopping All Projects', 
                `Stopping ${project.name} (${i + 1} of ${runningProjects.length})...`
            );
            
            try {
                const result = await zeltroFor(project.name, 'down', [project.name, '--json-output']);
                if (result.code === 0) {
                    successCount++;
                } else {
                    failCount++;
                    console.error(`Failed to stop ${project.name}:`, result.stderr);
                }
            } catch (error) {
                failCount++;
                console.error(`Error stopping ${project.name}:`, error);
            }
        }
        
        // Hide loading overlay
        hideLoadingOverlay();
        
        if (failCount === 0) {
            showSuccess(`Successfully stopped ${successCount} projects`);
        } else if (successCount > 0) {
            showNotification(`Stopped ${successCount} projects, ${failCount} failed`, 'info', 5000);
        } else {
            showError(`Failed to stop all ${failCount} projects`);
        }
        
        // Refresh project list
        setTimeout(() => {
            loadProjects();
            loadServices();
        }, 3000);
    } catch (error) {
        hideLoadingOverlay();
        showError('Error stopping projects: ' + (error as Error).message);
    }
}

// Additional GUI functions
async function createNewProject(): Promise<void> {
    console.log('DEBUG: createNewProject called');

    showModal('new-project-modal');
    // The catalogue is loaded when the framework path is chosen, not here —
    // someone heading for the app installer should not wait on it. And the host
    // comes first, because which catalogue to load depends on it.
    await showProjectHostStep();
}

// Make this function available globally immediately
(window as any).createNewProject = createNewProject;

function handleCreateProject(): void {
    console.log('DEBUG: handleCreateProject called');
    submitNewProject().catch(error => {
        console.error('Error creating project:', error);
        showError(`Failed to create project: ${error.message}`);
    });
}

// Functions made globally available at end of file

// ---------------------------------------------------------------------------
// Version lock step
//
// Reported, never acted on. The GUI and CLI are separate products on separate
// release cycles and their versions are not expected to match, so a difference
// is neither a warning nor a gate — it is just something worth knowing when
// someone files a bug.
//
// Compatibility is handled by per-feature capability probes, which are
// finer-grained than any version comparison and already caught the missing qwen
// support. They answer "can I do this" rather than "are these numbers equal".
// ---------------------------------------------------------------------------

async function showAboutVersions(): Promise<void> {
    const el = document.getElementById('about-version');
    if (!el) return;
    const [gui, cli] = await Promise.all([
        ipcRenderer.invoke('get-gui-version'),
        ipcRenderer.invoke('get-cli-version')
    ]);
    el.textContent = `GUI ${gui} · CLI ${cli}`;
}

// The GUI and the CLI are separate products on separate release cycles, and
// their version numbers are NOT expected to match. They both read 1.0.0-beta.1
// today because that is where they started, not because anything holds them
// together.
//
// So there is deliberately no mismatch warning. A banner that fires during
// ordinary operation is worse than no banner — it trains people to dismiss the
// one that matters. The capability probes (see `get-cli-capabilities`) are the
// real mechanism and always were: asking `ai-set --help` whether qwen exists
// answers "can I do this" rather than "are these numbers equal", and degrades
// one feature at a time instead of all at once.
//
// Both versions are still shown in About, as fact rather than as a problem —
// it is the first thing worth knowing in a bug report.

// ---------------------------------------------------------------------------
// AI agent settings (`zeltro ai-set`)
//
// Saving can INSTALL the agent — ai_set.sh's ensure_ai_agent_installed runs
// `npm install -g` for codex/gemini and curl installers for claude/aider — so
// this streams rather than spinning silently.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THEMES
//
// The page itself themes through CSS custom properties, so all this has to do
// is set an attribute. The terminals are the part that needs real work: xterm
// paints ANSI colours from its own palette, not from CSS, so a theme that only
// sets the page leaves terminal output in the previous scheme.
//
// Each theme therefore carries a full 16-colour palette rather than just a
// background and foreground. It matters most in Light: the standard ANSI
// brights assume a dark terminal — bright yellow (#ffff00) and bright white on
// white are invisible — so Light uses darkened variants that stay legible on a
// white background. Everything a build prints (npm warnings in yellow, docker
// progress in cyan, test failures in bright red) goes through these.
// ---------------------------------------------------------------------------
type ThemeName = 'retro' | 'dark' | 'light' | 'matrix' | 'zeltro';

const THEMES: { id: ThemeName; label: string; hint: string }[] = [
    { id: 'retro',  label: 'Retro',  hint: 'The original synthwave look' },
    { id: 'dark',   label: 'Dark',   hint: 'Neutral slate, no neon' },
    { id: 'light',  label: 'Light',  hint: 'For bright rooms' },
    { id: 'matrix', label: 'Matrix', hint: 'Green on black' },
    { id: 'zeltro', label: 'Zeltro', hint: 'Matches the Zeltro site' }
];

type XtermTheme = Record<string, string>;

const TERMINAL_THEMES: Record<ThemeName, XtermTheme> = {
    retro: {
        background: '#0f0f23', foreground: '#f8fafc',
        cursor: '#00d4ff', selectionBackground: '#8b5cf655',
        black: '#1e293b', red: '#ff5c8a', green: '#10b981', yellow: '#ffb454',
        blue: '#0ea5e9', magenta: '#c084fc', cyan: '#00d4ff', white: '#cbd5e1',
        brightBlack: '#64748b', brightRed: '#ff0080', brightGreen: '#34d399',
        brightYellow: '#ffd166', brightBlue: '#38bdf8', brightMagenta: '#e879f9',
        brightCyan: '#67e8f9', brightWhite: '#f8fafc'
    },
    dark: {
        background: '#0d1117', foreground: '#e6edf3',
        cursor: '#60a5fa', selectionBackground: '#818cf855',
        black: '#161b22', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
        blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
        brightBlack: '#8b949e', brightRed: '#ffa198', brightGreen: '#56d364',
        brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd', brightWhite: '#f0f6fc'
    },
    // Solarized-Light-style ANSI: every colour is dark enough to read on white.
    // Using the dark themes' palette here would render yellow and cyan output
    // as near-invisible pastel, which is exactly the "theme looks fine until
    // you run a build" failure worth avoiding.
    light: {
        background: '#ffffff', foreground: '#1f2328',
        cursor: '#0369a1', selectionBackground: '#0369a133',
        // Yellow is the problem colour on white — #ca8a04 measures 2.9:1 and
        // npm/composer warnings are printed in it. Both yellows are shifted a
        // step darker so bright stays visibly brighter than normal and both
        // still clear 3:1.
        black: '#1f2328', red: '#b91c1c', green: '#15803d', yellow: '#854d0e',
        blue: '#1d4ed8', magenta: '#a21caf', cyan: '#0e7490', white: '#57606a',
        brightBlack: '#636c76', brightRed: '#dc2626', brightGreen: '#16a34a',
        brightYellow: '#a16207', brightBlue: '#2563eb', brightMagenta: '#c026d3',
        brightCyan: '#0891b2', brightWhite: '#1f2328'
    },
    matrix: {
        background: '#000600', foreground: '#39ff14',
        cursor: '#39ff14', selectionBackground: '#39ff1444',
        black: '#01210a', red: '#7fff00', green: '#39ff14', yellow: '#9dff5e',
        blue: '#00ff9c', magenta: '#00e676', cyan: '#00ff9c', white: '#c8ffc8',
        brightBlack: '#3f9f5a', brightRed: '#aaff56', brightGreen: '#6bff8f',
        brightYellow: '#c8ffc8', brightBlue: '#5cffc0', brightMagenta: '#5cffa8',
        brightCyan: '#8affd6', brightWhite: '#e8ffe8'
    },
    zeltro: {
        background: '#04081d', foreground: '#e6edff',
        cursor: '#38bdf8', selectionBackground: '#38bdf844',
        black: '#0f1a45', red: '#f87171', green: '#34d399', yellow: '#fbbf24',
        blue: '#38bdf8', magenta: '#a78bfa', cyan: '#67e8f9', white: '#b9c4e0',
        brightBlack: '#9ba6c4', brightRed: '#fca5a5', brightGreen: '#6ee7b7',
        brightYellow: '#fcd34d', brightBlue: '#7dd3fc', brightMagenta: '#c4b5fd',
        brightCyan: '#a5f3fc', brightWhite: '#ffffff'
    }
};

// Exposed so the e2e suite can assert contrast across the whole palette
// rather than eyeballing screenshots. Reading the real table beats the test
// keeping its own copy, which would pass while the app shipped bad colours.
(window as any).__terminalThemes = TERMINAL_THEMES;

const THEME_STORAGE_KEY = 'zeltro-gui-theme';
let currentTheme: ThemeName = 'retro';

function terminalThemeFor(name: ThemeName): XtermTheme {
    return TERMINAL_THEMES[name] || TERMINAL_THEMES.retro;
}

function isThemeName(v: string | null): v is ThemeName {
    return !!v && THEMES.some(t => t.id === v);
}

function applyTheme(name: ThemeName, persist = true): void {
    currentTheme = name;
    document.documentElement.setAttribute('data-theme', name);
    if (persist) {
        try { localStorage.setItem(THEME_STORAGE_KEY, name); } catch { /* private mode */ }
    }

    // Repaint live terminals. Without this a theme switch leaves every open
    // session on the old palette until it is closed and reopened, which reads
    // as "the theme didn't apply" when the terminal is the visible pane.
    for (const session of terminalSessions.values()) {
        try { session.term.options.theme = terminalThemeFor(name); } catch { /* disposed */ }
    }

    document.querySelectorAll<HTMLElement>('[data-theme-option]').forEach(el => {
        el.classList.toggle('active', el.dataset.themeOption === name);
    });
}

function loadTheme(): void {
    let saved: string | null = null;
    try { saved = storedSetting(THEME_STORAGE_KEY); } catch { /* ignore */ }
    applyTheme(isThemeName(saved) ? saved : 'retro', false);
}

function renderThemePicker(): void {
    const host = document.getElementById('theme-picker');
    if (!host) return;
    host.innerHTML = THEMES.map(t => `
        <button class="theme-swatch" data-theme-option="${t.id}"
                data-testid="theme-${t.id}" onclick="selectTheme('${t.id}')"
                title="${t.hint}">
            <span class="theme-swatch-preview theme-preview-${t.id}">
                <span class="tsp-bar"></span><span class="tsp-bar"></span><span class="tsp-bar"></span>
            </span>
            <span class="theme-swatch-label">${t.label}</span>
        </button>
    `).join('');
    applyTheme(currentTheme, false);
}

function selectTheme(name: string): void {
    if (isThemeName(name)) applyTheme(name);
}

// Which fields each agent actually uses, from `zeltro ai-set --help` and the
// CLI's endpoint table. `--api-base` is no longer aider-only: Zeltro passes it
// to whichever env var each agent CLI reads. gemini has no endpoint at all
// (Google account auth), and claude needs an ANTHROPIC-compatible proxy rather
// than a raw Ollama URL — worth saying, or people point it at :11434 and it fails.
const AI_AGENT_RULES: Record<string, {
    modelRequired: boolean;
    keyRequired: boolean;
    apiBase: boolean;
    // True when talking to the vendor is the normal case, so the endpoint is
    // an advanced option rather than a field waiting to be filled in.
    apiBaseAdvanced?: boolean;
    apiBaseNote: string;
    // Which known-good endpoints make sense for this agent's wire format.
    endpoints?: string[];
    minNode?: number;
}> = {
    claude: { modelRequired: false, keyRequired: false, apiBase: true, apiBaseAdvanced: true,
              apiBaseNote: 'Must be Anthropic-compatible — a LiteLLM proxy for local models, not a raw Ollama URL.' },
    codex:  { modelRequired: false, keyRequired: false, apiBase: true,
              apiBaseNote: 'OpenAI-compatible endpoint.', endpoints: ['ollama', 'lmstudio', 'openrouter'] },
    gemini: { modelRequired: false, keyRequired: false, apiBase: false,
              apiBaseNote: '' },
    qwen:   { modelRequired: true,  keyRequired: false, apiBase: true,
              apiBaseNote: 'OpenAI-compatible endpoint.',
              endpoints: ['ollama', 'lmstudio', 'openrouter'], minNode: 22 },
    aider:  { modelRequired: true,  keyRequired: true,  apiBase: true,
              apiBaseNote: 'OpenAI-compatible endpoint.', endpoints: ['ollama', 'lmstudio', 'openrouter'] }
};

// Endpoints worth not having to remember. These fill the URL field and, where
// the service wants a placeholder token rather than a real key, the key field.
// They deliberately do NOT touch the agent: the previous Preset dropdown did,
// which meant picking a model host silently reassigned the agent above it.
const AI_ENDPOINTS: Record<string, { label: string; url: string; key?: string }> = {
    ollama:     { label: 'Ollama',     url: 'http://localhost:11434/v1', key: 'ollama' },
    lmstudio:   { label: 'LM Studio',  url: 'http://localhost:1234/v1',  key: 'local' },
    openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' }
};

function isLocalEndpoint(url: string): boolean {
    return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url || '');
}

function renderEndpointPresets(agent: string): void {
    const host = document.getElementById('ai-endpoint-presets');
    if (!host) return;

    const keys = (AI_AGENT_RULES[agent]?.endpoints || []).filter((k) => AI_ENDPOINTS[k]);
    host.innerHTML = keys.map((k) => {
        const e = AI_ENDPOINTS[k]!;
        return `<button type="button" class="endpoint-chip" data-testid="endpoint-${k}"
                        onclick="applyEndpoint('${k}')" title="${escapeHtml(e.url)}">${escapeHtml(e.label)}</button>`;
    }).join('');
    host.style.display = keys.length ? 'flex' : 'none';
}

async function applyEndpoint(key: string): Promise<void> {
    const preset = AI_ENDPOINTS[key];
    if (!preset) return;

    (document.getElementById('ai-api-base') as HTMLInputElement).value = preset.url;

    // Only fill a key the service treats as a placeholder, and only over a
    // blank field — overwriting a real key the user typed would be worse than
    // leaving them to paste it again.
    const keyInput = document.getElementById('ai-api-key') as HTMLInputElement;
    if (preset.key && keyInput && !keyInput.value) keyInput.value = preset.key;

    await onAiAgentChange();
}

function debugAiState(state: any): void {
    console.log('ai-set now reports:', JSON.stringify(state));
}

// Cached per session; the installed CLI does not change underneath us.
let cliCaps: { qwen: boolean; clearableEndpoint: boolean; unattended: boolean } =
    { qwen: true, clearableEndpoint: true, unattended: false };

// Settings is now the single entry point; the AI form is one tab inside it.
// `showAiSettings()` is kept as an alias rather than removed — it is referenced
// from the first-run prompt and from tests, and there is no reason to break
// those to rename a button.
function showDonateModal(): void {
    showModal('donate-modal');
}

// ---------------------------------------------------------------------------
// SSH host profiles
//
// Edited here, stored and used by the main process. No secrets: a profile holds
// a path to a private key, never a key and never a password.
// ---------------------------------------------------------------------------

interface SshCredential {
    id: string;
    label: string;
    user: string;
    authType: 'key' | 'password';
    keyPath?: string;
    /** Whether a secret is stored. Never the secret — that stays in main. */
    hasSecret?: boolean;
    /** A newly typed password, sent once on save and then forgotten. */
    newSecret?: string;
    /** Explicitly remove a stored secret, as distinct from not changing it. */
    clearSecret?: boolean;
}

interface SshProfile {
    id: string;
    label: string;
    host: string;
    port: number;
    credentialId?: string;
    user?: string;
    keyPath?: string;
    // Filled in by the connection test, editable. Not fixed: script installers
    // use /usr/local/bin, the .deb uses /usr/bin.
    zeltroPath?: string;
}

let sshProfiles: SshProfile[] = [];
let sshCredentials: SshCredential[] = [];
// Whether the store has been read yet. Saving before it has been is how an
// empty in-memory list gets written over a real configuration — and the write
// looks entirely successful, so nothing reports it.
let sshStoreLoaded = false;
// What the platform's secret storage actually is, so the UI can say so rather
// than implying a protection the machine may not provide.
let sshEncryption = { available: false, backend: 'unknown' };
// Keyed by profile id so a result belongs to the row that produced it — a
// single shared status line would attribute a slow host's failure to whichever
// row was tested last.
let sshTestResults: Record<string, { ok: boolean; stage: string; detail: string; testing?: boolean }> = {};

async function loadSshProfiles(): Promise<void> {
    const store = await ipcRenderer.invoke('get-ssh-store');
    sshProfiles = store?.hosts || [];
    sshCredentials = store?.credentials || [];
    sshEncryption = store?.encryption || { available: false, backend: 'unknown' };
    sshStoreLoaded = true;
}

async function persistSshProfiles(): Promise<void> {
    // Never write what has not been read. Both lists start empty, so a save
    // that beats the initial load replaces every host and credential with
    // nothing — and reports success while doing it.
    if (!sshStoreLoaded) {
        console.warn('Refusing to save SSH settings before they have been loaded');
        return;
    }

    const result = await ipcRenderer.invoke('save-ssh-store',
        { credentials: sshCredentials, hosts: sshProfiles });
    if (!result.success) { showError(`Could not save SSH settings: ${result.error}`); return; }

    // Re-read so a just-typed password becomes "stored" rather than lingering
    // in the renderer, and so hasSecret reflects what is actually on disk.
    await loadSshProfiles();
}

// --- Credentials -----------------------------------------------------------

function renderSshCredentials(): void {
    const host = document.getElementById('ssh-credential-list');
    if (!host) return;

    if (sshCredentials.length === 0) {
        host.innerHTML = `<p class="app-list-empty">No profiles yet. Add one to connect to a host.</p>`;
    } else {
        host.innerHTML = sshCredentials.map((c, i) => `
            <div class="ssh-profile" data-testid="cred-${i}">
                <div class="form-group">
                    <label>Name</label>
                    <input type="text" value="${escapeHtml(c.label)}" data-testid="cred-label-${i}"
                           oninput="updateSshCredential(${i}, 'label', this.value)"
                           placeholder="e.g. shawn on the LAN">
                </div>
                <div class="ssh-row">
                    <div class="form-group">
                        <label>Username</label>
                        <input type="text" value="${escapeHtml(c.user)}" data-testid="cred-user-${i}"
                               oninput="updateSshCredential(${i}, 'user', this.value)">
                    </div>
                    <div class="form-group">
                        <label>Authentication</label>
                        <select data-testid="cred-auth-${i}"
                                onchange="updateSshCredential(${i}, 'authType', this.value)">
                            <option value="key"${c.authType !== 'password' ? ' selected' : ''}>Key file</option>
                            <option value="password"${c.authType === 'password' ? ' selected' : ''}>Password</option>
                        </select>
                    </div>
                </div>
                ${c.authType === 'password' ? `
                    <div class="form-group">
                        <label>Password</label>
                        <input type="password" data-testid="cred-password-${i}"
                               placeholder="${c.hasSecret ? 'saved - type to replace' : 'not set'}"
                               oninput="updateSshCredential(${i}, 'newSecret', this.value)">
                        ${c.hasSecret ? `<button class="btn btn-secondary btn-small" data-testid="cred-clear-${i}"
                                    onclick="clearSshSecret(${i})">Remove saved password</button>` : ''}
                    </div>`
                : `
                    <div class="form-group">
                        <label>Key file</label>
                        <div class="ssh-row">
                            <input type="text" readonly value="${escapeHtml(c.keyPath || '')}"
                                   data-testid="cred-key-${i}" placeholder="none selected">
                            <button class="btn btn-secondary btn-small" data-testid="cred-browse-${i}"
                                    onclick="browseForKey(${i})">Browse...</button>
                        </div>
                    </div>`}
                <div class="ssh-actions">
                    <button class="btn btn-danger btn-small" data-testid="cred-remove-${i}"
                            onclick="removeSshCredential(${i})">Remove</button>
                </div>
            </div>`).join('');
    }

    // Say what the storage actually is. Electron falls back to a hardcoded key
    // where the OS store is unreachable, which is obfuscation rather than
    // encryption — measured as exactly that on this workstation.
    const note = document.getElementById('ssh-encryption-note');
    if (note) {
        const usesPassword = sshCredentials.some((c) => c.authType === 'password');
        note.textContent = !usesPassword ? ''
            : sshEncryption.available
                ? "Passwords are encrypted using this machine's credential store."
                // Accurate rather than reassuring: it is base64 in a 0600 file,
                // which is the same protection an unencrypted key in ~/.ssh has.
                : 'This machine has no credential store, so saved passwords are kept '
                  + 'unencrypted - protected by file permissions only, the same as an '
                  + 'unencrypted key in ~/.ssh.';
    }
}

// Hosts and profiles are separate lists that happen to reference each other,
// and stacking them made the panel a scroll. Two subtabs, hosts first because
// that is what people come here to add.
function showRemotesTab(which: 'hosts' | 'profiles'): void {
    document.querySelectorAll('[data-remotes-panel]').forEach((el) => {
        (el as HTMLElement).style.display =
            el.getAttribute('data-remotes-panel') === which ? '' : 'none';
    });
    document.querySelectorAll('[data-remotes-tab]').forEach((el) => {
        el.classList.toggle('active', el.getAttribute('data-remotes-tab') === which);
    });
}

async function addSshCredential(): Promise<void> {
    sshCredentials.push({
        id: `cred-${Date.now()}`, label: '', user: '', authType: 'key', keyPath: ''
    });
    renderSshCredentials();
    await persistSshProfiles();
    renderSshCredentials();
    renderSshProfiles();
}

async function updateSshCredential(index: number, field: string, value: string): Promise<void> {
    const c = sshCredentials[index];
    if (!c) return;
    (c as any)[field] = value;
    if (field === 'newSecret') c.clearSecret = false;
    // Switching auth type re-renders, since the fields below it change.
    if (field === 'authType') { renderSshCredentials(); }
    await persistSshProfiles();
    if (field === 'authType' || field === 'newSecret') renderSshCredentials();
    // A renamed credential is shown by name in every host's dropdown.
    if (field === 'label' || field === 'user') renderSshProfiles();
}

async function clearSshSecret(index: number): Promise<void> {
    const c = sshCredentials[index];
    if (!c) return;
    c.clearSecret = true;
    c.newSecret = '';
    c.hasSecret = false;
    await persistSshProfiles();
    renderSshCredentials();
}

// A path chosen from disk rather than typed. A mistyped key path fails as a
// connection error, which sends people to look at the host instead of the path.
async function browseForKey(index: number): Promise<void> {
    const chosen = await ipcRenderer.invoke('browse-for-key');
    if (!chosen) return;
    const c = sshCredentials[index];
    if (!c) return;
    c.keyPath = chosen;
    await persistSshProfiles();
    renderSshCredentials();
}

async function removeSshCredential(index: number): Promise<void> {
    const c = sshCredentials[index];
    if (!c) return;

    // A credential in use is a host that stops working, so say which rather
    // than letting them fail one by one later.
    const users = sshProfiles.filter((p) => p.credentialId === c.id);
    if (users.length > 0) {
        const names = users.map((p) => p.label || p.host).join(', ');
        if (!confirm(`"${c.label || c.user}" is used by ${names}. Remove it anyway?`)) return;
    }
    sshCredentials.splice(index, 1);
    await persistSshProfiles();
    renderSshCredentials();
    renderSshProfiles();
}

function renderSshProfiles(): void {
    const host = document.getElementById('ssh-profile-list');
    if (!host) return;

    if (sshProfiles.length === 0) {
        host.innerHTML = `<p class="app-list-empty" data-testid="ssh-empty">
            No hosts yet. Add one to create projects on another machine.</p>`;
        return;
    }

    host.innerHTML = sshProfiles.map((p, i) => {
        const r = sshTestResults[p.id];
        const status = r?.testing
            ? '<span class="ssh-status testing">testing…</span>'
            : r
                ? `<span class="ssh-status ${r.ok ? 'ok' : 'bad'}">${r.ok ? `reachable — ${escapeHtml(r.detail)}` : `${escapeHtml(r.stage)}: ${escapeHtml(r.detail)}`}</span>`
                : '';

        return `
        <div class="ssh-profile" data-testid="ssh-profile-${i}">
            <div class="form-group">
                <label>Name</label>
                <input type="text" value="${escapeHtml(p.label)}" data-testid="ssh-label-${i}"
                       oninput="updateSshProfile(${i}, 'label', this.value)" placeholder="EC2 Ubuntu">
            </div>
            <div class="ssh-row">
                <div class="form-group">
                    <label>Host</label>
                    <input type="text" value="${escapeHtml(p.host)}" data-testid="ssh-host-${i}"
                           oninput="updateSshProfile(${i}, 'host', this.value)" placeholder="44.202.33.176">
                </div>
                <div class="form-group ssh-port">
                    <label>Port</label>
                    <input type="number" value="${p.port || 22}" data-testid="ssh-port-${i}"
                           oninput="updateSshProfile(${i}, 'port', this.value)">
                </div>
                </div>
                <div class="form-group">
                <label>Profile</label>
                <select data-testid="ssh-cred-${i}"
                        onchange="updateSshProfile(${i}, 'credentialId', this.value)">
                    <option value="">-- choose a profile --</option>
                    ${sshCredentials.map((c) => `
                        <option value="${escapeHtml(c.id)}"${p.credentialId === c.id ? ' selected' : ''}
                            >${escapeHtml(c.label || c.user || 'unnamed')}</option>`).join('')}
                </select>
                </div>
            <div class="form-group">
                <label>Zeltro path <span class="form-help">found automatically; override only if needed</span></label>
                <input type="text" value="${escapeHtml(p.zeltroPath || '')}" data-testid="ssh-zeltro-${i}"
                       oninput="updateSshProfile(${i}, 'zeltroPath', this.value)"
                       placeholder="detected when you test the connection">
            </div>
            <div class="ssh-actions">
                <button class="btn btn-secondary btn-small" data-testid="ssh-test-${i}"
                        onclick="testSshProfile(${i})">Test connection</button>
                <button class="btn btn-danger btn-small" data-testid="ssh-remove-${i}"
                        onclick="removeSshProfile(${i})">Remove</button>
                ${r?.stage === 'configure'
                    ? `<button class="btn btn-primary btn-small" data-testid="ssh-configure-${i}"
                               onclick="configureSshHost(${i})">Run configure</button>`
                    : ''}
                ${status}
            </div>
        </div>`;
    }).join('');
}

function addSshProfile(): void {
    sshProfiles.push({
        // Stable across reorder and rename, so a test result cannot follow the
        // wrong row.
        id: `host-${Date.now()}-${sshProfiles.length}`,
        label: '', host: '', port: 22, user: '', keyPath: '~/.ssh/id_rsa'
    });
    renderSshProfiles();
    persistSshProfiles();
}

function updateSshProfile(index: number, field: string, value: string): void {
    const p = sshProfiles[index];
    if (!p) return;
    (p as any)[field] = field === 'port' ? (parseInt(value, 10) || 22) : value;
    // A stale "reachable" beside edited connection details is a claim about a
    // host that is no longer described here. Editing the zeltro path clears it
    // too — it is part of what "reachable" asserted.
    delete sshTestResults[p.id];
    persistSshProfiles();
}

async function removeSshProfile(index: number): Promise<void> {
    const p = sshProfiles[index];
    if (!p) return;
    if (!confirm(`Remove the host "${p.label || p.host || 'unnamed'}"?\n\n`
        + `Projects on it are not touched — this only removes it from Zeltro's list.`)) return;
    delete sshTestResults[p.id];
    sshProfiles.splice(index, 1);
    renderSshProfiles();
    await persistSshProfiles();
}

// Offered only when the connection test found Zeltro installed but not
// configured. Not offered speculatively: on a host that needs a sudo password
// it cannot work, and a button that usually fails is worse than none.
async function configureSshHost(index: number): Promise<void> {
    const p = sshProfiles[index];
    if (!p) return;

    sshTestResults[p.id] = { ok: false, stage: '', detail: 'configuring…', testing: true };
    renderSshProfiles();

    const result = await ipcRenderer.invoke('configure-ssh-host', p);
    if (result.ok) {
        showSuccess(`${p.label || p.host} configured.`);
        // Re-test rather than assuming: configure succeeding is not the same as
        // the host now answering a status call.
        await testSshProfile(index);
        return;
    }

    showError(result.detail);
    sshTestResults[p.id] = { ok: false, stage: 'configure', detail: result.detail };
    renderSshProfiles();
}

async function testSshProfile(index: number): Promise<void> {
    const p = sshProfiles[index];
    if (!p) return;

    sshTestResults[p.id] = { ok: false, stage: '', detail: '', testing: true };
    renderSshProfiles();

    const result = await ipcRenderer.invoke('test-ssh-profile', p);
    sshTestResults[p.id] = result;

    // Remember where zeltro was found, so later calls skip the probe and the
    // user can see and override what was chosen.
    if (result.ok && result.zeltroPath && result.zeltroPath !== p.zeltroPath) {
        p.zeltroPath = result.zeltroPath;
        await persistSshProfiles();
    }
    renderSshProfiles();
}

async function showSettings(tab: 'appearance' | 'layout' | 'hosts' | 'ai' = 'appearance'): Promise<void> {
    renderThemePicker();
    await loadSshProfiles();
    renderSshCredentials();
    renderSshProfiles();

    // Reflect the stored preference rather than the markup's default.
    const autoBox = document.getElementById('auto-update-check') as HTMLInputElement | null;
    if (autoBox) autoBox.checked = autoUpdateCheckEnabled();
    const warnBox = document.getElementById('warn-unreachable-hosts') as HTMLInputElement | null;
    if (warnBox) warnBox.checked = warnUnreachableHosts();

    renderGithubHosts();
    if (!githubStatus) void loadGithubStatus();

    const dictBox = document.getElementById('dictation-enabled') as HTMLInputElement | null;
    if (dictBox) dictBox.checked = dictationEnabled();
    const qualityBox = document.getElementById('dictation-quality') as HTMLSelectElement | null;
    if (qualityBox) qualityBox.value = dictationQuality();
    const langBox = document.getElementById('dictation-language') as HTMLSelectElement | null;
    if (langBox) langBox.value = dictationMultilingual() ? 'multi' : 'en';
    // Enabled but not loaded means a restart happened; bring it back rather
    // than showing a ticked box above an empty panel.
    if (dictationEnabled() && !whisperPipeline && dictationState !== 'downloading') {
        void restoreDictation();
    } else if (dictationEnabled() && whisperPipeline) {
        dictationState = 'ready';
        void listMicrophones();
    }
    renderDictationStatus();
    switchSettingsTab(tab);
    // Populate BEFORE showing. Loading afterwards made Appearance open a beat
    // sooner, but it also meant the form finished loading after the panel was
    // interactive and reset #ai-agent to the stored value — silently discarding
    // an agent the user had just picked. A snappier open is not worth a control
    // that undoes your input.
    await loadAiSettingsForm();
    showModal('settings-modal');
}

async function showAiSettings(): Promise<void> {
    await showSettings('ai');
}

function switchSettingsTab(tab: string): void {
    document.querySelectorAll<HTMLElement>('[data-settings-tab]').forEach(el => {
        el.classList.toggle('active', el.dataset.settingsTab === tab);
    });
    document.querySelectorAll<HTMLElement>('[data-settings-panel]').forEach(el => {
        el.style.display = el.dataset.settingsPanel === tab ? 'block' : 'none';
    });
}

async function loadAiSettingsForm(): Promise<void> {
    clearFieldErrors();
    // Which machine this panel is configuring. The agent runs on the host that
    // runs the project, so the setting belongs to a host rather than to the app.
    renderAiHostPicker();

    // Hide agents this CLI cannot actually run. The cheap-models support is on
    // zeltro-cli `dev` and not its `master`, so a current install has no qwen —
    // offering it would produce "Unsupported AI agent" at the point of use.
    cliCaps = await ipcRenderer.invoke('get-cli-capabilities');
    const qwenOption = document.querySelector('#ai-agent option[value="qwen"]') as HTMLOptionElement;
    if (qwenOption) {
        qwenOption.hidden = !cliCaps.qwen;
        qwenOption.disabled = !cliCaps.qwen;
    }
    const output = document.getElementById('ai-settings-output');
    const wrap = document.getElementById('ai-settings-output-wrap');
    if (output) output.textContent = '';
    if (wrap) wrap.style.display = 'none';

    const current = await ipcRenderer.invoke('get-ai-agent-full');

    (document.getElementById('ai-agent') as HTMLSelectElement).value = current.agent || '';
    (document.getElementById('ai-model') as HTMLInputElement).value = current.model || '';
    (document.getElementById('ai-api-base') as HTMLInputElement).value = current.api_base || '';
    (document.getElementById('ai-api-key') as HTMLInputElement).value = '';

    // Autonomy reflects what is actually stored in the AGENT's own config, which
    // the CLI reports as "true"/"false"/"unknown". Anything but an explicit
    // "true" shows unchecked: this is the setting where guessing in the
    // permissive direction is the one mistake that matters.
    const unattendedBox = document.getElementById('ai-unattended') as HTMLInputElement;
    const unattendedGroup = document.getElementById('ai-unattended-group');
    const unattendedHelp = document.getElementById('ai-unattended-help');
    if (unattendedBox) unattendedBox.checked = current.unattended === 'true';
    if (unattendedGroup) unattendedGroup.style.display = cliCaps.unattended ? 'block' : 'none';
    if (unattendedHelp) {
        unattendedHelp.textContent = current.unattended === 'unknown'
            ? 'Zeltro could not read this from the agent\'s config; shown as off.'
            : 'Stored in the agent\'s own config file, so it can be undone outside Zeltro.';
    }
    // Deliberately NOT through onUnattendedChange(): that asks for confirmation,
    // and merely opening Settings must never put a dialog in front of someone
    // who did not touch the control. Worse, dismissing that dialog turned the
    // setting off on screen while it was still on in the agent's config — the
    // panel would have been lying about a safety setting.
    syncUnattendedWarning();

    const note = document.getElementById('ai-key-note');
    if (note) {
        note.textContent = current.has_api_key
            ? 'A key is stored. Leave blank to keep it.'
            : 'No key stored.';
    }

    // Only offer "clear the key" when there is one to clear.
    const clearGroup = document.getElementById('ai-clear-key-group');
    const clearBox = document.getElementById('ai-clear-key') as HTMLInputElement;
    if (clearGroup) clearGroup.style.display = current.has_api_key ? 'block' : 'none';
    if (clearBox) clearBox.checked = false;

    // Reopening Settings starts from the stored configuration, so an endpoint
    // revealed by hand last time must fold away again if nothing was saved.
    apiBaseRevealed = false;

    await onAiAgentChange();
}

// Turning autonomy ON is a deliberate act, so it asks. Turning it off is not
// confirmed — making the safe direction harder than the unsafe one is exactly
// the mistake the removal dialog had.
function onUnattendedChange(): void {
    const box = document.getElementById('ai-unattended') as HTMLInputElement;
    if (!box) return;

    // Only ticking it ON asks. Turning it off is never confirmed — making the
    // safe direction harder than the unsafe one is the mistake the project
    // removal dialog used to have.
    if (box.checked) {
        const ok = confirm(
            'Let the AI agent act without asking permission?\n\n'
            + 'It will edit files, run commands and install packages in your projects '
            + 'without stopping for approval each time.\n\n'
            + 'This is stored in the agent\'s own config and applies wherever you run it, '
            + 'not just inside Zeltro.');
        if (!ok) box.checked = false;
    }

    syncUnattendedWarning();
}

// Display only. Used by the load path, which must not ask anything.
function syncUnattendedWarning(): void {
    const box = document.getElementById('ai-unattended') as HTMLInputElement;
    const warning = document.getElementById('ai-unattended-warning');
    if (warning) warning.style.display = box?.checked ? 'block' : 'none';
}

// Set when the user asks to see an endpoint field that is folded away by
// default; reset each time the form reloads from the stored configuration.
let apiBaseRevealed = false;

async function revealApiBase(): Promise<void> {
    apiBaseRevealed = true;
    await onAiAgentChange();
    (document.getElementById('ai-api-base') as HTMLInputElement)?.focus();
}

async function onAiAgentChange(): Promise<void> {
    // Switching agents invalidates any previous validation message. Without
    // this, selecting aider, failing validation, then switching to Claude left
    // "aider requires a model" sitting under a field marked optional.
    clearFieldErrors();

    const agent = (document.getElementById('ai-agent') as HTMLSelectElement)?.value || '';
    const rules = AI_AGENT_RULES[agent];

    const status = document.getElementById('ai-agent-status');
    if (status) {
        status.textContent = agent
            ? 'Zeltro installs this agent if it is not already present.'
            : 'Create with AI and Modify with AI stay disabled without an agent.';
    }

    // Claude Code talks to Anthropic unless told otherwise, so its endpoint sits
    // behind a disclosure. An endpoint that is already set always shows — hiding
    // a value that is in force would make the panel lie about the configuration.
    const storedBase = (document.getElementById('ai-api-base') as HTMLInputElement)?.value || '';
    const foldAway = !!rules?.apiBaseAdvanced && !storedBase && !apiBaseRevealed;

    const baseGroup = document.getElementById('ai-api-base-group');
    if (baseGroup) baseGroup.style.display = rules?.apiBase && !foldAway ? 'block' : 'none';

    const baseAdvanced = document.getElementById('ai-api-base-advanced');
    if (baseAdvanced) baseAdvanced.style.display = rules?.apiBase && foldAway ? 'block' : 'none';

    const advancedHelp = document.getElementById('ai-api-base-advanced-help');
    if (advancedHelp) {
        advancedHelp.textContent = agent === 'claude'
            ? 'Claude Code signs in to Anthropic on its own. Only needed if you are proxying it.'
            : 'Only needed if you are pointing this agent somewhere other than its default.';
    }

    const baseHelp = document.getElementById('ai-api-base-help');
    if (baseHelp) baseHelp.textContent = rules?.apiBaseNote || '';

    renderEndpointPresets(agent);

    const modelReq = document.getElementById('ai-model-req');
    if (modelReq) modelReq.textContent = rules?.modelRequired ? '(required)' : '(optional)';

    const keyReq = document.getElementById('ai-key-req');
    if (keyReq) keyReq.textContent = rules?.keyRequired ? '(required)' : '(optional)';

    // The endpoint is never enforced on save — blank means "use the agent's
    // default" — so it is always optional wherever the field is shown at all.
    // It was the only one of the three without a marker, which read as required
    // by omission next to two that said otherwise.
    const baseReq = document.getElementById('ai-base-req');
    if (baseReq) baseReq.textContent = '(optional)';

    // Qwen Code wants Node 22+. It runs on 20 with an EBADENGINE warning, which
    // is unsupported — and our own installers pin 20, so say so rather than
    // offering to install something this machine cannot properly run.
    const nodeWarning = document.getElementById('ai-node-warning');
    if (nodeWarning) {
        nodeWarning.style.display = 'none';
        if (rules?.minNode) {
            const major = await ipcRenderer.invoke('get-node-major');
            if (major > 0 && major < rules.minNode) {
                nodeWarning.textContent =
                    `${agent} needs Node ${rules.minNode}+. This machine has Node ${major}, `
                    + `where it installs with an EBADENGINE warning and is unsupported.`;
                nodeWarning.style.display = 'block';
            }
        }
    }

    const apiBase = (document.getElementById('ai-api-base') as HTMLInputElement)?.value || '';
    const localWarning = document.getElementById('ai-local-warning');
    if (localWarning) localWarning.style.display = isLocalEndpoint(apiBase) ? 'block' : 'none';

    await refreshModelOptions(apiBase);
}

// Offer whatever models the configured endpoint actually reports.
//
// This used to ask Ollama only, and only for local endpoints — so anyone using
// a hosted endpoint got an empty field and had to know a model name from
// memory. The lookup now speaks the OpenAI-compatible /v1/models shape as well,
// which OpenRouter, LM Studio, vLLM, Groq and OpenAI all serve. OpenRouter
// answers it with no key at all.
//
// Always falls back to free text: a list that cannot be fetched should not stop
// someone typing a name they already know.
async function refreshModelOptions(apiBase: string): Promise<void> {
    const list = document.getElementById('ai-model-options');
    const hint = document.getElementById('ai-model-hint');
    if (!list) return;

    list.innerHTML = '';
    if (hint) hint.textContent = 'Looking for available models…';

    // A key is sent only if one is set here; most endpoints that need one will
    // simply return nothing without it, which is the same as not knowing.
    const apiKey = (document.getElementById('ai-api-key') as HTMLInputElement)?.value || '';
    const result = await ipcRenderer.invoke('list-models', apiBase, apiKey);
    const models: string[] = result?.models || [];

    if (models.length === 0) {
        if (hint) {
            hint.textContent = isLocalEndpoint(apiBase)
                ? 'No local server reachable — type the model name.'
                : 'Could not list models for this endpoint — type the model name.';
        }
        return;
    }

    // Capped: OpenRouter alone returns several hundred, and a datalist that long
    // is slower to scroll than the name is to type. Typing filters it anyway.
    const shown = models.slice(0, 200);
    list.innerHTML = shown.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
    if (hint) {
        hint.textContent = models.length > shown.length
            ? `${models.length} models available — start typing to filter (showing ${shown.length}).`
            : `${models.length} model(s) available — start typing to pick one.`;
    }
}

let aiSettingsStreaming = false;

ipcRenderer.on('command-stream-data', (_event: any, payload: { type: string; data: string }) => {
    if (!aiSettingsStreaming) return;
    const output = document.getElementById('ai-settings-output');
    if (!output) return;
    output.textContent += payload.data.replace(/\x1b\[[0-9;]*m/g, '');
    output.scrollTop = output.scrollHeight;
});

async function saveAiSettings(): Promise<void> {
    clearFieldErrors();

    const agent = (document.getElementById('ai-agent') as HTMLSelectElement)?.value || '';
    const model = (document.getElementById('ai-model') as HTMLInputElement)?.value?.trim() || '';
    const apiKey = (document.getElementById('ai-api-key') as HTMLInputElement)?.value?.trim() || '';
    const apiBase = (document.getElementById('ai-api-base') as HTMLInputElement)?.value?.trim() || '';
    const rules = AI_AGENT_RULES[agent];

    if (agent && rules?.modelRequired && !model) {
        showFieldError('ai-model', `${agent} requires a model.`);
        return;
    }

    const args = ['ai-set', '--agent', agent];
    if (model) args.push('--model', model);

    // Endpoint is sent EVERY time, as a value or as `none`. Omitting it leaves
    // whatever the previous agent stored, so switching from a local preset back
    // to hosted would silently keep pointing at localhost.
    //
    // Older CLIs store `none` VERBATIM rather than clearing, which would leave a
    // nonsense endpoint behind — worse than the stale one. There, only send a
    // real value.
    const endpoint = rules?.apiBase ? apiBase : '';
    if (endpoint) {
        args.push('--api-base', endpoint);
    } else if (cliCaps.clearableEndpoint) {
        args.push('--api-base', 'none');
    }

    // Autonomy is sent EVERY time, in whichever direction the box is in. Sending
    // it only when enabling would make the checkbox one-way: unticking it would
    // silently leave the agent unattended.
    if (cliCaps.unattended) {
        const unattended = (document.getElementById('ai-unattended') as HTMLInputElement)?.checked;
        args.push(unattended ? '--allow-unattended' : '--no-allow-unattended');
    }

    // The key is write-only — blank means "keep what is stored", because the
    // field never shows it. Clearing therefore has to be explicit.
    const clearKey = (document.getElementById('ai-clear-key') as HTMLInputElement)?.checked;
    if (apiKey) {
        args.push('--api-key', apiKey);
    } else if (clearKey) {
        args.push('--api-key', '');
    }

    const wrap = document.getElementById('ai-settings-output-wrap');
    const output = document.getElementById('ai-settings-output');
    if (wrap) wrap.style.display = 'block';
    if (output) output.textContent = '';
    aiSettingsStreaming = true;

    try {
        // Not --json-output: that suppresses the installer's progress, which is
        // the whole reason this streams.
        // Routed to the chosen host rather than spawned locally. On Windows
        // there is no local CLI at all, which is what the bug report showed:
        // `spawn zeltro ENOENT` from a machine that was never meant to have one.
        const result = await ipcRenderer.invoke('execute-zeltro-stream-on',
            aiHost, args[0], args.slice(1));
        aiSettingsStreaming = false;

        if (result.code === 0) {
            // Read back rather than trusting the exit code — the clearing
            // semantics are the fiddly part of this panel — but do not announce
            // it. Closing the panel is the confirmation; reciting the setting
            // back tells someone what they just typed.
            debugAiState(await ipcRenderer.invoke('get-ai-agent-full'));
            closeModal();
        } else {
            showError(`Could not set the AI agent (exit ${result.code}). See the output above.`);
        }
    } catch (error) {
        aiSettingsStreaming = false;
        showError('Error setting the AI agent: ' + (error as Error).message);
    }
}

// ---------------------------------------------------------------------------
// Create with AI (`zeltro create`, driven phase by phase)
//
// Phase 1 classify -> render choices natively -> phase 2 create -> phase 3 build.
// Shelling out to `zeltro create` in one call is not an option: it presents
// interactive terminal menus a GUI cannot answer, and --json-output silently
// auto-picks the top recommendation instead.
// ---------------------------------------------------------------------------

interface ClassifyCandidate {
    kind: 'app' | 'framework';
    slug: string;
    display: string;
    reason: string;
    database?: string;
    databases?: string[];
}

interface Classification {
    status: 'success' | 'error';
    message?: string;
    project_name: string | null;
    recommended: 'app' | 'framework';
    customization_requested: boolean;
    database?: { slug: string; reason: string } | null;
    candidates: ClassifyCandidate[];
}

let classification: Classification | null = null;
let chosenCandidate: ClassifyCandidate | null = null;
let currentIdea = '';

async function showCreateWithAI(): Promise<void> {
    refreshMicButtons();
    classification = null;
    chosenCandidate = null;
    currentIdea = '';

    (document.getElementById('create-idea') as HTMLTextAreaElement).value = '';
    (document.getElementById('create-name') as HTMLInputElement).value = '';
    (document.getElementById('create-output') as HTMLElement).textContent = '';
    clearFieldErrors();
    setCreateStage('idea');
    showModal('create-ai-modal');

    // Creating is meaningless without an agent; say so up front rather than
    // failing a minute later inside the classifier.
    const { agent } = await ipcRenderer.invoke('get-ai-agent');
    const warning = document.getElementById('create-no-agent');
    const classifyBtn = document.getElementById('create-classify-btn') as HTMLButtonElement;

    if (warning) warning.style.display = agent ? 'none' : 'block';
    if (classifyBtn) classifyBtn.disabled = !agent;
}

function setCreateStage(stage: 'idea' | 'thinking' | 'choose' | 'building'): void {
    const stages: Record<string, string> = {
        idea: 'create-stage-idea',
        thinking: 'create-stage-thinking',
        choose: 'create-stage-choose',
        building: 'create-stage-building'
    };

    for (const [name, id] of Object.entries(stages)) {
        const el = document.getElementById(id);
        if (el) el.style.display = name === stage ? 'block' : 'none';
    }

    const classifyBtn = document.getElementById('create-classify-btn') as HTMLButtonElement;
    const confirmBtn = document.getElementById('create-confirm-btn') as HTMLButtonElement;
    const cancelBtn = document.getElementById('create-cancel-btn') as HTMLButtonElement;

    if (classifyBtn) classifyBtn.style.display = stage === 'idea' ? '' : 'none';
    if (confirmBtn) confirmBtn.style.display = stage === 'choose' ? '' : 'none';
    if (cancelBtn) cancelBtn.textContent = stage === 'building' ? 'Close' : 'Cancel';
}

async function handleClassifyIdea(): Promise<void> {
    const idea = (document.getElementById('create-idea') as HTMLTextAreaElement)?.value?.trim() || '';

    clearFieldErrors();
    if (!idea) {
        showFieldError('create-idea', 'Describe what you want to build.');
        return;
    }

    // A leading dash is read as a command-line flag. `zeltro create` honours
    // `--` so classification could be made to work, but the same text is later
    // handed to `zeltro ai`, where the AGENT's own CLI parses the dash — `--`
    // only stops Zeltro rejecting it, it does not make the agent accept it.
    // Half-working is worse than declining, so decline with a reason.
    if (idea.startsWith('-')) {
        showFieldError('create-idea',
            'Start your description with a word — a leading dash is read as a command-line flag.');
        return;
    }

    currentIdea = idea;
    setCreateStage('thinking');

    const result: Classification = await ipcRenderer.invoke('classify-idea', idea);

    if (result.status !== 'success' || result.candidates.length === 0) {
        setCreateStage('idea');
        showFieldError('create-idea', result.message || 'Could not work out a stack for that.');
        return;
    }

    renderClassification(result);
    setCreateStage('choose');
}

// Split out so the rendering can be tested with a fixture rather than a live
// AI round-trip, which is slow and non-deterministic.
function renderClassification(result: Classification): void {
    const list = document.getElementById('create-candidates');
    if (!list) return;

    // Rendering a classification makes it the current one. selectCandidate and
    // handleCreateFromChoice both read this, so setting it here keeps the two
    // in step and makes the function usable on its own.
    classification = result;

    // The CLI orders these apps-first, framework-last, and marks whichever kind
    // it actually recommends — not simply the first row.
    const recommendedIndex = result.candidates.findIndex((c) => c.kind === result.recommended);

    list.innerHTML = result.candidates.map((candidate, index) => {
        const tag = candidate.kind === 'app'
            ? 'ready to run — live in about 2 minutes'
            : 'custom build — exactly what you asked for, more time and tokens';
        const badge = index === recommendedIndex
            ? '<span class="rec-badge">Recommended</span>'
            : '';

        return `
            <div class="candidate" onclick="selectCandidate(${index})" data-testid="candidate-${escapeHtml(candidate.slug)}">
                <div class="candidate-header">
                    <strong>${escapeHtml(candidate.display)}</strong>
                    <code class="app-slug">${escapeHtml(candidate.slug)}</code>
                    ${badge}
                </div>
                <p class="candidate-tag">${tag}</p>
                <p class="app-note">${escapeHtml(candidate.reason)}</p>
            </div>
        `;
    }).join('');

    // Prefill the name only when the idea implied a real subject; the CLI
    // returns null rather than inventing "flask-app", and that means ask.
    const nameInput = document.getElementById('create-name') as HTMLInputElement;
    const nameHelp = document.getElementById('create-name-help');
    if (nameInput) nameInput.value = result.project_name || '';
    if (nameHelp) {
        nameHelp.textContent = result.project_name
            ? 'Becomes the project directory and the hostname.'
            : 'Your description does not suggest a name — pick one.';
    }

    selectCandidate(recommendedIndex >= 0 ? recommendedIndex : 0);
}

function selectCandidate(index: number): void {
    if (!classification) return;

    const candidate = classification.candidates[index];
    if (!candidate) return;

    chosenCandidate = candidate;

    document.querySelectorAll('#create-candidates .candidate').forEach((el, i) => {
        el.classList.toggle('selected', i === index);
    });

    const dbGroup = document.getElementById('create-database-group');
    const dbSelect = document.getElementById('create-database') as HTMLSelectElement;
    const dbWhy = document.getElementById('create-database-why');
    const fixed = document.getElementById('create-fixed-db');
    const fixedText = document.getElementById('create-fixed-db-text');

    if (candidate.kind === 'app') {
        // The installer's compose fixes the engine — never offer a choice here.
        if (dbGroup) dbGroup.style.display = 'none';
        if (fixed) fixed.style.display = 'block';
        if (fixedText) {
            fixedText.textContent = candidate.database
                ? `Database: ${candidate.database} — set by the ${candidate.display} installer.`
                : `Database: managed internally by ${candidate.display}.`;
        }
    } else {
        if (fixed) fixed.style.display = 'none';
        if (dbGroup) dbGroup.style.display = 'block';

        // Offer only engines this framework actually supports, recommended first.
        const allowed = candidate.databases || [];
        const recommended = classification.database?.slug || '';
        const ordered = allowed.includes(recommended)
            ? [recommended, ...allowed.filter((d) => d !== recommended)]
            : allowed;

        if (dbSelect) {
            dbSelect.innerHTML = ordered.map((db, i) =>
                `<option value="${escapeHtml(db)}">${escapeHtml(db)}${i === 0 && db === recommended ? ' (recommended)' : ''}</option>`
            ).join('');
        }
        if (dbWhy) {
            dbWhy.textContent = allowed.includes(recommended)
                ? (classification.database?.reason || '')
                : `Only engines ${candidate.display} supports are offered.`;
        }
    }

    const confirmBtn = document.getElementById('create-confirm-btn') as HTMLButtonElement;
    if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = candidate.kind === 'app'
            ? `Install ${candidate.display}`
            : `Create ${candidate.display} project`;
    }
}

async function handleCreateFromChoice(): Promise<void> {
    if (!classification || !chosenCandidate) return;

    clearFieldErrors();

    const name = (document.getElementById('create-name') as HTMLInputElement)?.value?.trim() || '';
    const validation = validateProjectName(name);
    if (!validation.valid) {
        showFieldError('create-name', validation.error!);
        return;
    }

    const sanitized = sanitizeContainerName(name);
    if (!sanitized) {
        showFieldError('create-name', 'Project name must contain at least one valid character.');
        return;
    }

    const sudoOk = await ipcRenderer.invoke('ensure-sudo');
    if (!sudoOk) {
        showError('Could not authenticate for the hosts file change. Run it from a terminal instead.');
        return;
    }

    const candidate = chosenCandidate;
    installInProgress = true;
    setCreateStage('building');

    const title = document.getElementById('create-build-title');
    if (title) {
        title.textContent = candidate.kind === 'app'
            ? `Installing ${candidate.display} as "${sanitized}"…`
            : `Creating ${candidate.display} project "${sanitized}"…`;
    }

    // Phase 2 is deterministic and identical to the existing flows — no AI.
    const args = candidate.kind === 'app'
        ? ['install', candidate.slug, sanitized, '--one-off']
        : ['new', candidate.slug, sanitized,
           ...((document.getElementById('create-database') as HTMLSelectElement)?.value
               ? ['--database', (document.getElementById('create-database') as HTMLSelectElement).value]
               : []),
           '--one-off'];

    try {
        const result = await ipcRenderer.invoke('execute-command-stream', 'zeltro', args);
        installInProgress = false;

        if (result.code !== 0) {
            showError(`Create failed (exit ${result.code}). See the output above.`);
            if (title) title.textContent = `Creating "${sanitized}" failed (exit ${result.code}).`;
            return;
        }

        loadProjects();
        loadServices();

        // Phase 3. The build is skipped only for a ready-to-run app that the
        // idea asked nothing extra of — a framework scaffold is empty, so it
        // always needs building regardless of customization_requested.
        const needsBuild = !(candidate.kind === 'app' && classification!.customization_requested === false);

        if (needsBuild) {
            if (title) title.textContent = `"${sanitized}" is ready — now building your idea.`;
            openBuildTerminal(sanitized, currentIdea);
        } else {
            if (title) title.textContent = `${candidate.display} is installed — http://${sanitized}/`;
            showSuccess(`${candidate.display} installed at http://${sanitized}/`);
        }
    } catch (error) {
        installInProgress = false;
        showError('Error creating project: ' + (error as Error).message);
    }
}

// ---------------------------------------------------------------------------
// Phase 3: the AI build session, in a real embedded terminal
// ---------------------------------------------------------------------------

interface TerminalSession {
    id: string;
    key: string;          // stable per target, so re-opening focuses rather than duplicates
    label: string;
    term: any;
    fit: any;
    pane: HTMLElement;
    exited: boolean;
    status: string;
    // Where this session is shown. Tile sessions live in a project's card and
    // stay out of the modal's tab bar entirely.
    host: 'modal' | 'tile';
    project?: string | undefined;
    wrapper?: HTMLElement | undefined;
    collapsed?: boolean | undefined;
}

// Sessions outlive the window: hiding the terminal modal leaves them running,
// and the header's Terminals button brings them back. Only the tab's × (or
// "End session") kills a pty. The main process already keys ptys by id, so
// nothing there needed changing.
const terminalSessions = new Map<string, TerminalSession>();
let activeTerminalId = '';
let terminalResizeHandler: (() => void) | null = null;


function killTerminal(id: string): void {
    const session = terminalSessions.get(id);
    if (!session) return;

    ipcRenderer.invoke('pty-kill', id);
    try { session.term.dispose(); } catch (error) { /* already gone */ }
    // Tile sessions own a wrapper around the pane; removing only the pane
    // would leave an empty bar sitting in the card.
    (session.wrapper || session.pane).remove();
    terminalSessions.delete(id);

    if (terminalSessions.size === 0 && terminalResizeHandler) {
        window.removeEventListener('resize', terminalResizeHandler);
        terminalResizeHandler = null;
    }

    // Every terminal lives in a project tile now, so closing one is just
    // removing it from that card. There is no window to tidy up, no tab bar to
    // reconcile, and no "which one is active" to track.
    if (activeTerminalId === id) activeTerminalId = '';
    loadProjects();
}

function closeActiveTerminal(): void {
    if (activeTerminalId) killTerminal(activeTerminalId);
}

// ---------------------------------------------------------------------------
// Terminals hosted inside a project tile
//
// The grid is rebuilt from scratch on every status poll, so a terminal living
// in it has to survive having its surroundings replaced. The pane is never
// re-created: it is parked in a detached holder before the rebuild and moved
// back into the new markup afterwards, which xterm tolerates fine as long as
// it gets a fit() once it is back on screen.
// ---------------------------------------------------------------------------

function tileSessionFor(project: string): TerminalSession | undefined {
    return [...terminalSessions.values()].find((s) => s.host === 'tile' && s.project === project);
}

function hasTileTerminal(project: string): boolean {
    return tileSessionFor(project) !== undefined;
}

function tileHolder(): HTMLElement {
    let holder = document.getElementById('tile-terminal-holder');
    if (!holder) {
        holder = document.createElement('div');
        holder.id = 'tile-terminal-holder';
        holder.style.display = 'none';
        document.body.appendChild(holder);
    }
    return holder;
}

function detachTileTerminals(): void {
    const holder = tileHolder();
    for (const session of terminalSessions.values()) {
        if (session.host === 'tile' && session.wrapper) holder.appendChild(session.wrapper);
    }
}

// Where the caret was when the grid was last rebuilt.
//
// Replacing #projects-grid.innerHTML blurs whatever was focused inside it, and
// that happens on every ten-second poll — so typing into a compose box lost
// focus and the caret mid-sentence, roughly twice a minute. This has to be
// captured BEFORE the rebuild; by the time the panes are reattached,
// document.activeElement is already <body> and there is nothing left to read.
let pendingFocus: { el: HTMLTextAreaElement | HTMLInputElement; start: number; end: number } | null = null;

function captureTileFocus(): void {
    const active = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
    if (!active || !active.closest('.tile-terminal') || !('selectionStart' in active)) {
        // Deliberately NOT cleared here. renderProjects runs several times in a
        // single refresh, and the first call is the only one that still sees the
        // focused element — the rest run after the rebuild has already blurred
        // it. Clearing on those wiped the one good capture every time.
        return;
    }
    pendingFocus = { el: active, start: active.selectionStart ?? 0, end: active.selectionEnd ?? 0 };
}

function reattachTileTerminals(): void {
    for (const session of terminalSessions.values()) {
        if (session.host !== 'tile' || !session.wrapper || !session.project) continue;

        const host = document.querySelector(`[data-terminal-host="${CSS.escape(session.project)}"]`);
        // No tile for it this pass (the project vanished from the list): leave
        // the pane parked rather than dropping it — the pty is still alive.
        if (!host) continue;

        // Already in the right place: moving it again would blur for nothing.
        if (session.wrapper.parentElement === host) continue;

        host.appendChild(session.wrapper);
    }

    // Notices and busy overlays are restored the same way the panes are: the
    // grid was just rebuilt, so anything written directly into a tile is gone.
    paintTileNotices();
    paintTileBusy();

    if (pendingFocus && document.contains(pendingFocus.el)) {
        pendingFocus.el.focus({ preventScroll: true });
        // Restoring focus alone drops the caret to the end, which is just as
        // disruptive halfway through a sentence.
        try { pendingFocus.el.setSelectionRange(pendingFocus.start, pendingFocus.end); }
        catch { /* not a text field after all */ }
    }
    pendingFocus = null;

    refitTileTerminals();
}

// Fit after the move, not during: a pane measured while detached reports zero
// rows, and the pty would be resized to nothing.
function refitTileTerminals(): void {
    setTimeout(() => {
        for (const session of terminalSessions.values()) {
            if (session.host === 'tile' && !session.collapsed) fitTerminal(session);
        }
    }, 30);
}

// Tile terminals resize when a tile expands or the window changes, so the pty
// has to be told the new size or its output wraps at the old width.
function fitTerminal(session: TerminalSession): void {
    try {
        session.fit.fit();
        ipcRenderer.invoke('pty-resize', session.id, session.term.cols, session.term.rows);
    } catch (error) {
        // A fit racing teardown is not worth surfacing.
    }
}

function tileTerminalStatus(session: TerminalSession): void {
    const label = session.wrapper?.querySelector('.tile-terminal-status');
    if (label) label.textContent = session.status;
    session.wrapper?.classList.toggle('exited', session.exited);
}

// Slide the pane so the cursor's row sits at the bottom of the sliver.
//
// Clipping to the pane's bottom edge is not the same thing: a session that has
// printed three lines into a 24-row terminal has 21 blank rows at the bottom,
// so the sliver came up empty and looked broken. What "recent output" means is
// the line the agent is writing on, which is where the cursor is.
function anchorSliver(session: TerminalSession): void {
    if (!session.wrapper || !session.collapsed) return;

    const rows = session.term.rows || 1;
    const paneHeight = session.pane.getBoundingClientRect().height;
    if (!paneHeight) return;

    const rowHeight = paneHeight / rows;
    const cursorRow = session.term.buffer?.active?.cursorY ?? rows - 1;
    const sliver = session.wrapper.querySelector('.tile-terminal-viewport')
        ?.getBoundingClientRect().height || 58;

    // Never positive: the pane only ever moves up, never down past its own top.
    const offset = Math.min(0, sliver - (cursorRow + 1) * rowHeight - 6);
    session.pane.style.marginTop = `${offset}px`;
}

// Output arrives a byte at a time from a pty; re-measuring on each chunk would
// mean layout work on every keystroke the agent prints.
let sliverPending = false;
function scheduleSliverAnchor(): void {
    if (sliverPending) return;
    sliverPending = true;
    setTimeout(() => {
        sliverPending = false;
        for (const session of terminalSessions.values()) {
            if (session.host === 'tile' && session.collapsed) anchorSliver(session);
        }
    }, 120);
}

function toggleTileTerminal(project: string): void {
    const session = tileSessionFor(project);
    if (!session || !session.wrapper) return;

    session.collapsed = !session.collapsed;
    session.wrapper.classList.toggle('collapsed', session.collapsed);

    const chevron = session.wrapper.querySelector('.tile-terminal-toggle');
    if (chevron) {
        chevron.textContent = session.collapsed ? '▸' : '▾';
        chevron.setAttribute('title', session.collapsed ? 'Expand this session' : 'Collapse to a sliver');
    }

    // Collapsing deliberately does NOT refit. The pane keeps its pixel height
    // and is clipped, so the pty's rows never change — refitting to the sliver
    // would resize the agent's display to two lines and wreck its output.
    if (session.collapsed) {
        anchorSliver(session);
    } else {
        session.pane.style.marginTop = '';
        setTimeout(() => fitTerminal(session), 30);
    }
}

function closeTileTerminal(project: string): void {
    const session = tileSessionFor(project);
    if (session) killTerminal(session.id);
}

// Build the chrome around a tile-hosted pane: a bar that names the session,
// shows its status, collapses it, and ends it.
function buildTileWrapper(session: TerminalSession, project: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'tile-terminal';
    wrapper.dataset.testid = `tile-terminal-${project}`;

    const bar = document.createElement('div');
    bar.className = 'tile-terminal-bar';
    bar.innerHTML = `
        <span class="tile-terminal-label">${escapeHtml(session.label)}</span>
        <span class="tile-terminal-status">${escapeHtml(session.status)}</span>
        <button class="tile-terminal-toggle" title="Collapse to a sliver"
                data-testid="tile-terminal-toggle-${escapeHtml(project)}"
                onclick="toggleTileTerminal('${escapeHtml(project)}')">▾</button>
        <button class="tile-terminal-close" title="End this session"
                data-testid="tile-terminal-close-${escapeHtml(project)}"
                onclick="closeTileTerminal('${escapeHtml(project)}')">&times;</button>
    `;

    // The pane sits inside its own clipping viewport so collapsing can pull it
    // up without painting over the bar above it.
    const viewport = document.createElement('div');
    viewport.className = 'tile-terminal-viewport';
    viewport.appendChild(session.pane);

    // A compose box ALONGSIDE the terminal, not instead of it.
    //
    // An agent CLI is a poor text editor: no cursor movement worth the name, no
    // selection, and a stray Ctrl-C ends the session. Most people asking an agent
    // to change something are writing a sentence or two and want to fix a typo
    // halfway through. But the terminal remains fully typable, because a
    // one-keystroke answer to "proceed? (y/n)" is faster where it is asked.
    const compose = document.createElement('div');
    compose.className = 'tile-compose';
    compose.innerHTML = `
        <textarea class="tile-compose-input" rows="5"
                  data-testid="compose-input-${escapeHtml(project)}"
                  placeholder="Tell the agent what to change…  (Ctrl+Enter to send)"></textarea>
        <div class="tile-compose-actions">
            <button class="btn btn-secondary btn-small"
                    data-testid="compose-attach-${escapeHtml(project)}"
                    title="Attach files for the agent to read"
                    onclick="attachFiles('${escapeHtml(project)}')">📎</button>
            <button class="btn btn-secondary btn-small mic-button"
                    data-testid="compose-mic-${escapeHtml(project)}"
                    title="Dictate" onclick="toggleDictation(this)">🎤</button>
            <button class="btn btn-primary btn-small"
                    data-testid="compose-send-${escapeHtml(project)}"
                    onclick="sendCompose('${escapeHtml(project)}')">Send</button>
        </div>`;

    // Ctrl+Enter sends; plain Enter is a newline.
    //
    // The other way round is the chat convention, but this box is not a chat
    // box: it holds a paragraph describing a change, written over a minute or
    // two, and a stray Enter halfway through would fire it half-written at an
    // agent that then acts on it. Sending is the rarer, more consequential
    // action here, so it takes the deliberate chord.
    const input = compose.querySelector('.tile-compose-input') as HTMLTextAreaElement;
    input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            sendCompose(project);
        }
    });

    wrapper.appendChild(bar);
    wrapper.appendChild(viewport);
    wrapper.appendChild(compose);
    // A newly built tile has to agree with the current setting, not the markup.
    setTimeout(refreshMicButtons, 0);
    return wrapper;
}

// --- GitHub ----------------------------------------------------------------
//
// `zeltro new --github` creates the repository from the machine running the
// project, so gh has to be authenticated THERE. Per host, like services.

let aiHost = 'local';

async function setAiHost(hostId: string): Promise<void> {
    aiHost = hostId;
    await loadAiSettingsForm();
}

function renderAiHostPicker(): void {
    const sel = document.getElementById('ai-host') as HTMLSelectElement | null;
    if (!sel) return;

    // A host removed from settings leaves this pointing at nothing.
    if (!dashboardHosts.some((h) => h.id === aiHost)) {
        aiHost = dashboardHosts[0]?.id || 'local';
    }
    sel.innerHTML = dashboardHosts.map((h) =>
        `<option value="${escapeHtml(h.id)}"${h.id === aiHost ? ' selected' : ''}>${escapeHtml(h.label)}</option>`
    ).join('');
    // One host needs no choosing.
    const group = document.getElementById('ai-host-group');
    if (group) group.style.display = dashboardHosts.length > 1 ? '' : 'none';
}

let githubHost = 'local';
let githubStatus: any = null;

function setGithubHost(hostId: string): void {
    githubHost = hostId;
    void loadGithubStatus();
}

async function loadGithubStatus(): Promise<void> {
    const el = document.getElementById('github-status');
    if (el) el.innerHTML = `<p class="ssh-status testing">Checking…</p>`;
    githubStatus = await ipcRenderer.invoke('get-github-status', githubHost);
    renderGithubStatus();
}

function renderGithubHosts(): void {
    const sel = document.getElementById('github-host') as HTMLSelectElement | null;
    if (!sel) return;
    if (!dashboardHosts.some((h) => h.id === githubHost)) {
        githubHost = dashboardHosts[0]?.id || 'local';
    }
    sel.innerHTML = dashboardHosts.map((h) =>
        `<option value="${escapeHtml(h.id)}"${h.id === githubHost ? ' selected' : ''}>${escapeHtml(h.label)}</option>`).join('');
}

function renderGithubStatus(): void {
    const el = document.getElementById('github-status');
    if (!el || !githubStatus) return;
    const st = githubStatus;

    if (!st.installed) {
        el.innerHTML = `
            <p class="ssh-status bad" data-testid="github-missing">
                The GitHub CLI is not installed on this host.</p>
            <p class="settings-note">Install <code>gh</code> there, then check again.
               Projects can still be created without it — only the "create a repository"
               option needs it.</p>
            <button class="btn btn-secondary btn-small" onclick="loadGithubStatus()">Check again</button>`;
        return;
    }

    if (!st.loggedIn) {
        // A token rather than the browser flow: `gh auth login --web` wants a
        // terminal to print a code in and a browser on the machine running it,
        // and over SSH there is neither.
        el.innerHTML = `
            <p class="ssh-status bad" data-testid="github-signed-out">Not signed in.</p>
            <div class="form-group">
                <label for="github-token">Personal access token</label>
                <input type="password" id="github-token" data-testid="github-token"
                       placeholder="ghp_…">
                <span class="form-help">
                    Needs the <code>repo</code> scope. Add <code>admin:org</code> only if
                    you create repositories under an organisation.
                </span>
            </div>
            <button class="btn btn-primary btn-small" data-testid="github-signin"
                    onclick="githubSignIn()">Sign in</button>
            <button class="btn btn-secondary btn-small"
                    onclick="openUrl('https://github.com/settings/tokens/new?scopes=repo&description=Zeltro')">
                Create a token</button>
            <p class="settings-note">The token is handed to <code>gh</code> on that host and stored by it.
               Zeltro does not keep a copy.</p>`;
        return;
    }

    const missing = st.missingScopes || [];
    el.innerHTML = `
        <p class="ssh-status ok" data-testid="github-signed-in">
            Signed in as <strong>${escapeHtml(st.login)}</strong></p>
        ${missing.length > 0
            ? `<p class="ssh-status bad" data-testid="github-scopes">
                 This token is missing ${escapeHtml(missing.join(', '))} — creating a
                 repository will fail until it is replaced.</p>`
            : ''}
        <p class="settings-note gh-version">${escapeHtml(st.version || '')}</p>
        <button class="btn btn-secondary btn-small" onclick="loadGithubStatus()">Check again</button>
        <button class="btn btn-danger btn-small" data-testid="github-signout"
                onclick="githubSignOut()">Sign out</button>`;
}

async function githubSignIn(): Promise<void> {
    const field = document.getElementById('github-token') as HTMLInputElement | null;
    const token = field?.value?.trim() || '';
    if (!token) { showError('Paste a token first.'); return; }

    const result = await ipcRenderer.invoke('github-login', githubHost, token);
    // Cleared either way: a token that failed is no more welcome in the DOM
    // than one that worked.
    if (field) field.value = '';
    if (result.ok) showSuccess(result.detail); else showError(result.detail);
    await loadGithubStatus();
}

async function githubSignOut(): Promise<void> {
    if (!confirm('Sign out of GitHub on this host?')) return;
    const result = await ipcRenderer.invoke('github-logout', githubHost);
    if (result.ok) showSuccess(result.detail); else showError(result.detail);
    await loadGithubStatus();
}

// --- Dictation -------------------------------------------------------------
//
// Whisper runs locally: the audio never leaves the machine, there is no API key
// and no per-minute cost. transformers.js rather than whisper.cpp because it is
// WASM — no native module to build per platform, which matters given Windows is
// a supported target and node-pty already taught us what that costs.
//
// The model is downloaded on first use and cached by the browser, so the first
// dictation is slow and later ones are not. Loading it at startup would make
// every launch pay for a feature most sessions never touch.

// Which speech model to use. Named for the result rather than the model, since
// "base" and "small" say nothing about the trade being made.
//
// Both are English-only: the .en variants are trained on English alone, which is
// what makes them this accurate at this size.
const DICTATION_MODELS: Record<string, { base: string; mb: number }> = {
    good: { base: 'Xenova/whisper-base',  mb: 180 },
    best: { base: 'Xenova/whisper-small', mb: 547 }
};

function dictationQuality(): 'good' | 'best' {
    return storedSetting('zeltro-dictation-quality') === 'best' ? 'best' : 'good';
}

// English or multilingual, because that is the only choice there is: Whisper
// ships an English-only variant and one covering 99 languages, not a model per
// language. The multilingual one detects the language itself.
function dictationMultilingual(): boolean {
    return storedSetting('zeltro-dictation-multilingual') === 'on';
}

// The .en model is the same download as the multilingual one and more accurate
// on English, having spent none of its capacity on the other 98 languages. So
// English is a free upgrade rather than a restriction.
function dictationModelId(): string {
    const model = DICTATION_MODELS[dictationQuality()]!;
    return dictationMultilingual() ? model.base : `${model.base}.en`;
}


async function setDictationLanguageMode(multilingual: boolean): Promise<void> {
    if (multilingual === dictationMultilingual()) return;
    localStorage.setItem('zeltro-dictation-multilingual', multilingual ? 'on' : 'off');
    await reloadSpeechModel();
}

// Shared by both settings: each switches which model is loaded, so the one in
// memory is the wrong one either way.
async function reloadSpeechModel(): Promise<void> {
    try { await whisperPipeline?.dispose?.(); } catch { /* nothing to free */ }
    whisperPipeline = null;
    whisperLoading = null;
    refreshMicButtons();
    // Only if dictation is already on: changing a setting should not trigger a
    // download nobody asked for.
    if (dictationEnabled()) await restoreDictation();
    renderDictationStatus();
}

async function setDictationQuality(quality: string): Promise<void> {
    if (quality !== 'good' && quality !== 'best') return;
    if (quality === dictationQuality()) return;
    localStorage.setItem('zeltro-dictation-quality', quality);
    await reloadSpeechModel();
}

// Off until someone turns it on, because turning it on costs a download.
// A feature that quietly downloads that on first click is a feature that
// surprises people on a metered connection.
function dictationEnabled(): boolean {
    return storedSetting('zeltro-dictation') === 'on';
}

async function setDictationEnabled(on: boolean): Promise<void> {
    localStorage.setItem('zeltro-dictation', on ? 'on' : 'off');

    if (!on) {
        // Free the weights. A loaded Whisper sits on a few hundred MB of tensors,
        // and someone turning the feature off has said they are not using it —
        // holding that for the rest of the session would make "off" mean nothing
        // except a hidden button.
        //
        // The DOWNLOAD stays cached, so turning it back on is fast. Deleting it
        // would punish a person for changing their mind.
        try { await whisperPipeline?.dispose?.(); } catch { /* nothing to free */ }
        whisperPipeline = null;
        dictationState = 'off';
        stopLevelMeter();
        // A recording in flight has nowhere to go now.
        if (activeRecorder) {
            try { activeRecorder.recorder.stop(); } catch { /* already stopped */ }
            activeRecorder = null;
        }
        renderDictationStatus();
        refreshMicButtons();
        return;
    }

    // Fetch it now rather than at first use, so the wait happens where it was
    // asked for and can be watched.
    if (!whisperPipeline) {
        dictationState = 'downloading';
        dictationDetail = 'Downloading speech model…';
        renderDictationStatus();
        try {
            await loadWhisper((msg) => {
                dictationState = msg ? 'downloading' : 'starting';
                dictationDetail = msg;
                renderDictationStatus();
            });
            dictationState = 'ready';
        } catch (error) {
            dictationState = 'error';
            dictationDetail = `Could not load the model: ${(error as Error).message}`;
        }
    } else {
        dictationState = 'ready';
    }

    renderDictationStatus();
    if (dictationState === 'ready') await listMicrophones();
    refreshMicButtons();
}

// Load the model again after a restart.
//
// The PREFERENCE survives a restart; the loaded model does not — it is a few
// hundred MB of tensors in this process's memory. Nothing reloaded it, so a
// relaunch left a ticked "Enable dictation" box above an empty panel and no mic
// buttons anywhere. It looked like the setting had not saved. Unchecking and
// re-checking was the only way back, which is not something anyone should have
// to discover.
//
// The download is cached, so this is a load rather than a fetch — seconds, not
// minutes — but it is still reported, because on a slow machine silence for
// several seconds is indistinguishable from nothing happening.
async function restoreDictation(): Promise<void> {
    if (whisperPipeline || !dictationEnabled()) return;

    dictationState = 'starting';
    renderDictationStatus();
    try {
        await loadWhisper((msg) => {
            // A download here means the cache was cleared since last time.
            dictationState = msg ? 'downloading' : 'starting';
            dictationDetail = msg;
            renderDictationStatus();
        });
        dictationState = 'ready';
        await listMicrophones();
    } catch (error) {
        dictationState = 'error';
        dictationDetail = `Could not load the model: ${(error as Error).message}`;
    }
    renderDictationStatus();
    refreshMicButtons();
}

// --- Microphone selection and level ----------------------------------------

function dictationDeviceId(): string { return storedSetting('zeltro-mic-device') || ''; }
function dictationGain(): number { return parseFloat(storedSetting('zeltro-mic-gain') || '1') || 1; }

function setDictationDevice(id: string): void {
    localStorage.setItem('zeltro-mic-device', id);
    startLevelMeter();
}

function setDictationGain(value: string): void {
    localStorage.setItem('zeltro-mic-gain', value);
    const label = document.getElementById('dictation-gain-value');
    if (label) label.textContent = `${parseFloat(value).toFixed(1)}×`;
}

// Labels are only populated once permission has been granted, so ask first —
// otherwise the list is a set of blank entries with opaque ids.
async function listMicrophones(): Promise<void> {
    const select = document.getElementById('dictation-device') as HTMLSelectElement | null;
    if (!select) return;
    try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());
    } catch {
        select.innerHTML = '<option value="">No microphone access</option>';
        return;
    }

    const devices = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === 'audioinput');
    select.innerHTML = devices.map((d, i) =>
        `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Microphone ${i + 1}`)}</option>`).join('');
    if (dictationDeviceId()) select.value = dictationDeviceId();

    const gainInput = document.getElementById('dictation-gain') as HTMLInputElement | null;
    if (gainInput) gainInput.value = String(dictationGain());
    setDictationGain(String(dictationGain()));
    startLevelMeter();
}

let levelStream: MediaStream | null = null;
let levelCtx: AudioContext | null = null;
let levelTimer: number | null = null;

// A live level bar, because "is this microphone the one that hears me" cannot be
// answered by a device name — several will be plausible and only one is plugged in.
async function startLevelMeter(): Promise<void> {
    stopLevelMeter();
    const bar = document.getElementById('dictation-level');
    if (!bar) return;

    try {
        const id = dictationDeviceId();
        levelStream = await navigator.mediaDevices.getUserMedia({
            audio: id ? { deviceId: { exact: id } } : true
        });
        levelCtx = new AudioContext();
        const src = levelCtx.createMediaStreamSource(levelStream);
        const analyser = levelCtx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);
        levelTimer = window.setInterval(() => {
            analyser.getByteTimeDomainData(data);
            let peak = 0;
            for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
            bar.style.width = `${Math.min(100, peak * dictationGain() * 100)}%`;
        }, 100);
    } catch (error) {
        bar.style.width = '0%';
    }
}

function stopLevelMeter(): void {
    if (levelTimer !== null) { clearInterval(levelTimer); levelTimer = null; }
    levelStream?.getTracks().forEach((t) => t.stop());
    levelStream = null;
    void levelCtx?.close();
    levelCtx = null;
}

// An explicit state rather than inferring one from whether the pipeline exists.
//
// Inferring it meant anything that re-rendered mid-download — switching settings
// tabs, for one — replaced the progress with a bare "Preparing…" that then never
// changed. It read as stuck because there was nothing left to say otherwise.
type DictationState = 'off' | 'downloading' | 'starting' | 'ready' | 'error';
let dictationState: DictationState = 'off';
let dictationDetail = '';

function renderDictationStatus(): void {
    const el = document.getElementById('dictation-status');
    const group = document.getElementById('dictation-device-group');
    if (!el) return;

    if (group) group.style.display = dictationState === 'ready' ? '' : 'none';

    const line: Record<DictationState, string> = {
        off: '',
        // Percentage included so a slow connection still looks like movement.
        downloading: `<p class="ssh-status testing" data-testid="dictation-progress">${escapeHtml(dictationDetail)}</p>`,
        starting: `<p class="ssh-status testing" data-testid="dictation-progress">Starting the model…</p>`,
        ready: `<p class="ssh-status ok" data-testid="dictation-ready">Ready</p>`,
        error: `<p class="ssh-status bad" data-testid="dictation-error">${escapeHtml(dictationDetail)}</p>`
    };
    el.innerHTML = line[dictationState];
}

// Mic buttons exist only when dictation is on and ready. A button that responds
// Greyed out rather than hidden when dictation is off.
//
// Hiding it meant the compose box quietly had a different set of buttons
// depending on a setting three tabs away, and nothing on screen said the
// feature existed. A disabled control is discoverable; an absent one is not.
function refreshMicButtons(): void {
    const ready = dictationEnabled() && Boolean(whisperPipeline);
    document.querySelectorAll('.mic-button').forEach((b) => {
        const button = b as HTMLButtonElement;
        button.style.display = '';
        button.disabled = !ready;
        button.classList.toggle('mic-button-off', !ready);
        button.title = ready
            ? 'Dictate'
            : dictationEnabled()
                ? 'Preparing the speech model…'
                : 'Dictation is off — turn it on in Settings';
    });
}

let whisperPipeline: any = null;
let whisperLoading: Promise<any> | null = null;
let activeRecorder: { recorder: { stop: () => Promise<void> }; target: HTMLTextAreaElement } | null = null;

async function loadWhisper(onProgress?: (msg: string) => void): Promise<any> {
    if (whisperPipeline) return whisperPipeline;
    if (whisperLoading) return whisperLoading;

    whisperLoading = (async () => {
        const { pipeline, env } = require('@huggingface/transformers');
        // No local model directory is shipped, so do not look for one — without
        // this it probes a path that will never exist and the failure reads as a
        // missing file rather than a download.
        env.allowLocalModels = false;

        const pipe = await pipeline('automatic-speech-recognition', dictationModelId(), {
            progress_callback: (p: any) => {
                if (p.status === 'progress' && p.total) {
                    onProgress?.(`Downloading speech model ${Math.round((p.loaded / p.total) * 100)}%`);
                }
            }
        });
        whisperPipeline = pipe;
        return pipe;
    })();

    try { return await whisperLoading; } finally { whisperLoading = null; }
}

// Down to 16kHz mono, which is what Whisper takes.
//
// Plain linear interpolation rather than a WebAudio resampler. Speech at 16k is
// forgiving, and the alternative pulls in an API this Electron build cannot be
// trusted with — see captureMicrophone.
function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
    if (inputRate === 16000) return input;
    const ratio = inputRate / 16000;
    const out = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) {
        const at = i * ratio;
        const lo = Math.floor(at);
        const hi = Math.min(lo + 1, input.length - 1);
        const frac = at - lo;
        out[i] = input[lo]! * (1 - frac) + input[hi]! * frac;
    }
    return out;
}

// The textarea this mic button belongs to. Both entry points — a project tile
// and Create with AI — use the same button, so it finds its own box rather than
// each caller passing one.
function boxForMic(button: HTMLElement): HTMLTextAreaElement | null {
    const scope = button.closest('.tile-compose') || button.closest('.dictation-scope');
    return (scope?.querySelector('textarea') as HTMLTextAreaElement | null) || null;
}

async function toggleDictation(button: HTMLElement): Promise<void> {
    if (!dictationEnabled()) {
        showError('Dictation is off. Turn it on under Settings → Dictation.');
        return;
    }
    if (activeRecorder) { stopDictation(button); return; }

    const target = boxForMic(button);
    if (!target) return;

    let stream: MediaStream;
    try {
        const chosen = dictationDeviceId();
        stream = await navigator.mediaDevices.getUserMedia({
            audio: chosen ? { deviceId: { exact: chosen } } : true
        });
    } catch (error) {
        // Denied or absent. Saying which is the difference between "click allow"
        // and "this machine has no microphone".
        showError(`No microphone available: ${(error as Error).message}`);
        return;
    }

    // Raw samples, not a recording.
    //
    // The obvious route is MediaRecorder -> Blob -> decodeAudioData, and
    // decodeAudioData CRASHES this Electron's renderer — not throws, crashes,
    // so nothing can catch it. Reproduced on a synthetic in-memory WAV with no
    // file access involved, in a normal desktop session as well as a headless
    // one, which rules out both the harness and codec licensing.
    //
    // Tapping the stream gives Float32 samples directly. No container, no codec,
    // and no decode step to crash in.
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const blocks: Float32Array[] = [];

    const gain = dictationGain();
    processor.onaudioprocess = (e) => {
        // Copied, because the event's buffer is reused for the next block. Gain
        // is applied here rather than with a GainNode so the samples Whisper
        // sees are the ones the level meter showed.
        const block = new Float32Array(e.inputBuffer.getChannelData(0));
        if (gain !== 1) {
            for (let i = 0; i < block.length; i++) {
                block[i] = Math.max(-1, Math.min(1, block[i]! * gain));
            }
        }
        blocks.push(block);
    };
    source.connect(processor);
    // ScriptProcessor only runs while connected to a destination, even though
    // nothing should be audible — so the gain is zeroed rather than skipped.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(ctx.destination);

    const recorder = {
        stop: async () => {
            processor.disconnect();
            source.disconnect();
            mute.disconnect();
            stream.getTracks().forEach((t) => t.stop());

            button.classList.remove('recording');
            button.textContent = '⏳';

            const total = blocks.reduce((n, b) => n + b.length, 0);
            const joined = new Float32Array(total);
            let at = 0;
            for (const b of blocks) { joined.set(b, at); at += b.length; }
            const audio = resampleTo16k(joined, ctx.sampleRate);
            await ctx.close();

            try {
                const pipe = await loadWhisper((msg) => { button.title = msg; });
                const result = await pipe(audio);
                const text = (result?.text || '').trim();
                if (text) {
                    // Appended, not replaced: dictation adds to what is already
                    // typed rather than discarding it.
                    target.value = target.value ? `${target.value.trimEnd()} ${text}` : text;
                    target.focus();
                } else {
                    showError('Nothing was transcribed. Try speaking closer to the microphone.');
                }
            } catch (error) {
                showError(`Dictation failed: ${(error as Error).message}`);
            } finally {
                button.textContent = '🎤';
                button.title = 'Dictate';
                activeRecorder = null;
            }
        }
    };

    activeRecorder = { recorder, target };
    button.classList.add('recording');
    button.textContent = '⏹';
    button.title = 'Stop dictation';
}

function stopDictation(button: HTMLElement): void {
    if (!activeRecorder) return;
    void activeRecorder.recorder.stop();
}

// Send the compose box's contents to the agent, then clear it.
//
// A trailing carriage return submits it, the same as pressing Enter in the
// terminal would.
// Attach files to a project and reference them in the message being written.
//
// The reference goes into the COMPOSE BOX rather than straight to the agent.
// Sending on its own would interrupt whatever the agent is mid-way through, and
// a bare path tells it nothing about what to do with the file — the person
// attaching it is the one who knows that.
//
// No extraction here either: Claude, Codex and Gemini read PDFs, images and
// documents themselves, and better than a bundled parser would. Handing over a
// path is what makes the file usable, not describing it first.
// Messages pinned inside a project's tile, where its terminal would have gone.
//
// Held in state rather than written once into the DOM: the grid is rebuilt on
// every ten-second poll, so a notice written directly survived less than ten
// seconds — barely better than the toast it was meant to replace. Re-applied
// after each render, next to the terminals, which are restored the same way.
const tileNotices = new Map<string, string>();

// Projects that are mid-action, and what to say about each.
//
// Held in state like the notices, because the grid is rebuilt on every
// ten-second poll — an overlay written straight into a card would vanish partway
// through the very operation it is reporting.
const busyTiles = new Map<string, string>();

// Starting one project used to block the whole window. It is one tile's
// business: everything else stays usable, and the thing that is working is the
// thing that looks like it.
function setTileBusy(project: string, label: string): void {
    busyTiles.set(project, label);
    paintTileBusy();
}

function clearTileBusy(project: string): void {
    busyTiles.delete(project);
    document.querySelector(`[data-testid="tile-busy-${CSS.escape(project)}"]`)?.remove();
    const card = document.querySelector(`.project-card[data-project="${CSS.escape(project)}"]`);
    card?.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = false));
}

function paintTileBusy(): void {
    for (const [project, label] of busyTiles) {
        const card = document.querySelector(`.project-card[data-project="${CSS.escape(project)}"]`);
        if (!card || card.querySelector('.tile-busy')) continue;

        // Its own buttons go dead: a second Start while the first is running is
        // never what someone means.
        card.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));

        const busy = document.createElement('div');
        busy.className = 'tile-busy';
        busy.setAttribute('data-testid', `tile-busy-${project}`);
        busy.innerHTML = `<div class="robot-reveal tile-robot"></div>
            <span>${escapeHtml(label)}</span>`;
        card.appendChild(busy);
    }
}

function showTileNotice(project: string, message: string): void {
    tileNotices.set(project, message);
    paintTileNotices();
}

function dismissTileNotice(project: string): void {
    tileNotices.delete(project);
    document.querySelector(`[data-testid="tile-notice-${CSS.escape(project)}"]`)?.remove();
}

function paintTileNotices(): void {
    for (const [project, message] of tileNotices) {
        const host = document.querySelector(`[data-terminal-host="${CSS.escape(project)}"]`);
        if (!host) continue;
        // A terminal that has since opened is the better answer to the same
        // question, so the notice steps aside rather than sitting above it.
        if (host.querySelector('.tile-terminal')) { tileNotices.delete(project); continue; }
        if (host.querySelector('.tile-notice')) continue;

        const notice = document.createElement('div');
        notice.className = 'tile-notice';
        notice.setAttribute('data-testid', `tile-notice-${project}`);
        notice.innerHTML = `<span>${escapeHtml(message)}</span>
            <button class="btn btn-secondary btn-small"
                    onclick="dismissTileNotice('${escapeHtml(project)}')">Dismiss</button>`;
        host.appendChild(notice);
    }
}

async function attachFiles(project: string): Promise<void> {
    const paths: string[] = await ipcRenderer.invoke('choose-files');
    if (!paths || paths.length === 0) return;

    const host = hostOf(project);
    const box = document.querySelector(
        `[data-testid="compose-input-${CSS.escape(project)}"]`) as HTMLTextAreaElement | null;
    const button = document.querySelector(
        `[data-testid="compose-attach-${CSS.escape(project)}"]`) as HTMLButtonElement | null;

    // A large file over sftp is not instant, and a button that looks idle
    // invites a second click that uploads everything twice.
    if (button) { button.disabled = true; button.textContent = '⏳'; }

    try {
        const result = await ipcRenderer.invoke('attach-files', host, project, paths);
        if (!result.ok) { showError(result.error || 'Could not attach the files.'); return; }

        // Named, not counted: the agent needs the paths, and so does the person
        // deciding what to say about them.
        const list = result.attached.join(', ');
        showSuccess(`Attached ${list}`);

        if (box) {
            const lead = box.value.trim() ? box.value.replace(/\s*$/, '\n') : '';
            box.value = `${lead}I've attached ${list} — `;
            box.focus();
            // Caret at the end, ready for the sentence saying what to do with it
            // — the only part the person still has to write.
            box.setSelectionRange(box.value.length, box.value.length);
        }
    } finally {
        if (button) { button.disabled = false; button.textContent = '📎'; }
    }
}

function sendCompose(project: string): void {
    const wrapper = document.querySelector(`[data-testid="tile-terminal-${CSS.escape(project)}"]`);
    const input = wrapper?.querySelector('.tile-compose-input') as HTMLTextAreaElement | null;
    if (!input) return;

    const text = input.value;
    if (!text.trim()) return;

    const session = [...terminalSessions.values()].find((s) => s.project === project);
    if (!session) { showError('That session has ended.'); return; }

    ipcRenderer.invoke('pty-input', session.id, text + '\r');
    input.value = '';
    input.focus();
}

interface AgentTerminalOptions {
    title: string;
    status: string;
    cwd: string;
    command: string;
    args: string[];
    sessionKey: string;
    /** Shown if the pty cannot start, so the user can run it themselves. */
    fallbackHint?: string;
    /** Which project's tile hosts this session. Omitted means the modal. */
    tileProject?: string;
    /** Which machine the command runs on. Defaults to this one. */
    hostId?: string;
}

// One embedded-terminal implementation for both agent entry points: the build
// hand-off after `create`, and "Modify with AI" on an existing project.
async function openAgentTerminal(options: AgentTerminalOptions): Promise<void> {
    const { Terminal } = require('@xterm/xterm');
    const { FitAddon } = require('@xterm/addon-fit');

    const inTile = !!options.tileProject;
    const panes = document.getElementById('terminal-panes');
    if (!panes && !inTile) return;

    closeModal();

    // Re-opening the same target focuses the live session rather than starting a
    // second agent in the same directory.
    const existing = [...terminalSessions.values()].find((s) => s.key === options.sessionKey && !s.exited);
    if (existing) {
        if (existing.host === 'tile') {
            // Already in its tile. Expand it if it was collapsed and scroll to
            // it, rather than silently doing nothing to a button press.
            if (existing.collapsed) toggleTileTerminal(existing.project!);
            existing.wrapper?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            existing.term.focus();
            return;
        }
        // Its tile is gone — the project was removed or filtered out of view.
        existing.term.focus();
        return;
    }

    const id = `${options.sessionKey}-${performance.now()}`;
    const pane = document.createElement('div');
    pane.className = 'terminal-pane';
    pane.dataset.sessionId = id;
    if (!inTile) panes!.appendChild(pane);

    const term = new Terminal({
        fontSize: 13,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        // The terminal stays fully typable — keystrokes go straight to the pty,
        // so the cursor is shown. The compose box is an easier way to write a
        // paragraph, not a replacement for the terminal: an agent that asks a
        // yes/no question is faster to answer in place.
        cursorBlink: true,
        theme: terminalThemeFor(currentTheme)
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    // Keystrokes go to the compose box, not the pty.
    //
    // Returning false stops xterm handling the key at all. Copy shortcuts and
    // Ctrl-C for SIGINT still pass, because both are things people legitimately
    // need at a running agent — Ctrl-C especially, since a compose box gives no
    // other way to interrupt one that has gone wrong.
    if (inTile) {
        term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
            if (e.type !== 'keydown') return true;
            const copyOrInterrupt = (e.ctrlKey || e.metaKey)
                && ['c', 'C', 'v', 'V', 'a', 'A'].includes(e.key);
            if (copyOrInterrupt) return true;
            // Everything else goes to the pty. The compose box is the easier
            // way to write a paragraph, but redirecting keystrokes out of the
            // terminal made it feel broken — and a one-key answer to
            // "proceed? (y/n)" belongs where the question was asked.
            return true;
        });
    }

    const session: TerminalSession = {
        id, key: options.sessionKey, label: options.title,
        term, fit, pane, exited: false, status: options.status,
        host: inTile ? 'tile' : 'modal',
        project: options.tileProject,
        collapsed: false
    };
    terminalSessions.set(id, session);

    // The pane has to be in the document before xterm measures it, or the first
    // fit reports zero rows and the pty starts sized for nothing.
    if (inTile) {
        session.wrapper = buildTileWrapper(session, options.tileProject!);
        const host = document.querySelector(`[data-terminal-host="${CSS.escape(options.tileProject!)}"]`);
        // No tile on screen for it — a filter, or a status poll mid-flight.
        // Park it and let the next render place it, so the pty still starts.
        (host || tileHolder()).appendChild(session.wrapper);
    }
    term.open(pane);

    term.onData((data: string) => ipcRenderer.invoke('pty-input', id, data));

    if (!terminalResizeHandler) {
        terminalResizeHandler = () => {
            const active = terminalSessions.get(activeTerminalId);
            if (active) fitTerminal(active);
        };
        window.addEventListener('resize', terminalResizeHandler);
    }

    if (inTile) {
        session.wrapper!.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setTimeout(() => { fitTerminal(session); term.focus(); }, 30);
    } else {
        // Terminals live in project tiles now. Without one there is nowhere to
        // put it, so say what to run instead of starting something invisible.
        showError(`No tile for ${options.tileProject || 'this project'}. `
            + `Run it yourself: ${options.fallbackHint}`);
    }

    const started = await ipcRenderer.invoke('pty-start-on', options.hostId || 'local',
        id, options.cwd, options.command, options.args);

    if (!started.ok) {
        term.writeln('\r\n\x1b[31mCould not start an embedded terminal.\x1b[0m');
        term.writeln(`\x1b[2m${started.error || ''}\x1b[0m`);
        term.writeln('');
        term.writeln('Run this yourself instead:');
        term.writeln(`\x1b[36m  ${options.fallbackHint || `cd ${options.cwd} && ${options.command} ${options.args.join(' ')}`}\x1b[0m`);
        session.status = 'Embedded terminal unavailable — run the command above.';
        session.exited = true;
        tileTerminalStatus(session);
    }
}

// Continue the AI session on an existing project.
//
// `zeltro resume <project>` starts the project, prints its status and URL, then
// reopens the agent with its previous conversation (claude --continue,
// codex resume --last, gemini --resume latest, aider --restore-chat-history).
async function modifyWithAI(projectName: string): Promise<void> {
    // A remote project's agent runs on that host, so everything here is asked
    // of that host: whether an agent is configured, where its projects live,
    // and which machine the terminal opens on.
    const host = hostOf(projectName);
    const hostLabel = dashboardHosts.find((h) => h.id === host)?.label || host;

    const { agent } = await ipcRenderer.invoke('get-ai-agent', host);
    if (!agent) {
        const message = host === 'local'
            ? 'No AI agent is configured. Run `zeltro ai-set` in a terminal first.'
            : `No AI agent is configured on ${hostLabel}. The agent runs there, `
              + `so run \`zeltro ai-set\` on that machine.`;
        // On the tile as well as in a toast. Someone pressed a button on this
        // card and expects something to happen on this card — a notification
        // that fades after a few seconds reads as the button doing nothing,
        // which is exactly how this was reported.
        showTileNotice(projectName, message);
        showError(message);
        return;
    }

    // resume takes the project name and cds itself, so run it from the projects
    // directory rather than inside the project.
    const projectsDir = await ipcRenderer.invoke('get-projects-dir-on', host);

    if (terminalHost === 'system') {
        const opened = await ipcRenderer.invoke('open-system-terminal',
            projectsDir, 'zeltro', ['resume', projectName]);
        if (!opened.ok) {
            showError(`Could not open a terminal (${opened.error}). `
                + `Run this yourself: cd ${projectsDir} && zeltro resume ${projectName}`);
        }
        return;
    }

    await openAgentTerminal({
        title: `✨ ${projectName}`,
        status: 'Resuming the AI session in this project.',
        cwd: projectsDir,
        command: 'zeltro',
        args: ['resume', projectName],
        // Host-scoped: two hosts can each have a project of this name, and a
        // shared key would focus the wrong machine's session.
        sessionKey: `resume-${host}-${projectName}`,
        fallbackHint: `cd ${projectsDir} && zeltro resume ${projectName}`,
        tileProject: projectName,
        hostId: host
    });
}

// Phase 3 of create: hand the original idea to the agent inside the finished
// project, which picks up the AGENTS.md handoff file written there.
async function openBuildTerminal(projectName: string, idea: string): Promise<void> {
    const host = newProjectHost || 'local';
    const projectsDir = await ipcRenderer.invoke('get-projects-dir-on', host);

    // The grid has to hold the new project before its tile can host a terminal.
    await loadProjects();

    await openAgentTerminal({
        title: `🛠️ ${projectName}`,
        status: 'Session running — type to answer the agent.',
        cwd: `${projectsDir}/${projectName}`,
        command: 'zeltro',
        args: ['ai', idea],
        sessionKey: `build-${host}-${projectName}`,
        fallbackHint: `cd ${projectsDir}/${projectName} && zeltro ai`,
        tileProject: projectName,
        hostId: host
    });
}

ipcRenderer.on('pty-data', (_event: any, payload: { sessionId: string; data: string }) => {
    const session = terminalSessions.get(payload.sessionId);
    if (!session) return;

    session.term.write(payload.data);
    // A collapsed sliver has to follow the output, or it freezes on whatever
    // was on screen when it was collapsed.
    if (session.host === 'tile' && session.collapsed) scheduleSliverAnchor();
});

ipcRenderer.on('pty-exit', (_event: any, payload: { sessionId: string; exitCode: number }) => {
    const session = terminalSessions.get(payload.sessionId);
    if (!session) return;

    session.exited = true;
    session.status = payload.exitCode === 0
        ? 'Session finished.'
        : `Session exited with code ${payload.exitCode}.`;
    session.term.writeln(`\r\n\x1b[2m[session ended: ${payload.exitCode}]\x1b[0m`);

    if (session.host === 'tile') {
        // The bar is the only place a collapsed session can report anything,
        // so it has to say the agent is done even when the pane is a sliver.
        tileTerminalStatus(session);
        loadProjects();
        return;
    }

    if (session.id === activeTerminalId) {
        const status = document.getElementById('build-terminal-status');
        if (status) status.textContent = session.status;
    }
    loadProjects();
});

// ---------------------------------------------------------------------------
// Install an app (`zeltro install <app> [name]`)
//
// Distinct from New Project on purpose: `new` scaffolds a framework you write,
// `install` deploys finished software. The database is fixed by each installer,
// so it is shown as information and never offered as a choice.
// ---------------------------------------------------------------------------

interface CatalogApp {
    slug: string;
    display: string;
    database: string;
    note: string;
}

let appCatalog: CatalogApp[] = [];
let selectedApp: CatalogApp | null = null;
let installInProgress = false;

// Separate from installInProgress on purpose. Streaming used to be gated on
// that flag, which is cleared the moment `execute-command-stream` resolves —
// and the invoke's reply travels on a different channel from the stream events,
// so it can arrive first. The last chunk was then dropped, which is precisely
// where the CLI prints the URL, credentials and notes. This flag is cleared
// only when a NEW install starts or the modal is closed, never on completion.
let installStreamActive = false;

async function showInstallApp(): Promise<void> {
    selectedApp = null;
    installInProgress = false;

    // Reset the modal from any previous run
    const search = document.getElementById('install-search') as HTMLInputElement;
    const nameInput = document.getElementById('install-project-name') as HTMLInputElement;
    const output = document.getElementById('install-output');
    if (search) search.value = '';
    if (nameInput) nameInput.value = '';
    if (output) output.textContent = '';
    installStreamActive = false;

    setInstallView('picker');
    showModal('install-app-modal');

    if (appCatalog.length === 0) {
        const result = await ipcRenderer.invoke('get-app-catalog');
        appCatalog = result.apps || [];

        if (result.error) {
            console.error('Failed to load app catalogue:', result.error);
            const list = document.getElementById('install-app-list');
            if (list) {
                list.innerHTML = `<p class="app-list-empty">Could not read the app catalogue.<br><small>${escapeHtml(result.error)}</small></p>`;
            }
            return;
        }
    }

    renderAppCatalog();
}

function setInstallView(view: 'picker' | 'progress'): void {
    const picker = document.getElementById('install-picker');
    const progress = document.getElementById('install-progress');
    const submit = document.getElementById('install-submit-btn') as HTMLButtonElement;
    const cancel = document.getElementById('install-cancel-btn') as HTMLButtonElement;
    const back = document.getElementById('install-back-btn') as HTMLButtonElement;

    if (picker) picker.style.display = view === 'picker' ? 'block' : 'none';
    if (progress) progress.style.display = view === 'progress' ? 'block' : 'none';
    if (submit) submit.style.display = view === 'picker' ? '' : 'none';
    // Going "back" mid-install would hide a running install behind a form.
    if (back) back.style.display = view === 'picker' ? '' : 'none';
    if (cancel) cancel.textContent = view === 'picker' ? 'Cancel' : 'Close';
}

function escapeHtml(value: string): string {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
}

function renderAppCatalog(): void {
    const list = document.getElementById('install-app-list');
    const countLabel = document.getElementById('install-app-count');
    if (!list) return;

    const query = ((document.getElementById('install-search') as HTMLInputElement)?.value || '')
        .trim()
        .toLowerCase();

    const matches = query === ''
        ? appCatalog
        : appCatalog.filter((app: CatalogApp) =>
            app.slug.toLowerCase().includes(query) ||
            app.display.toLowerCase().includes(query) ||
            app.note.toLowerCase().includes(query));

    if (countLabel) {
        countLabel.textContent = query === ''
            ? `(${appCatalog.length} apps)`
            : `(${matches.length} of ${appCatalog.length})`;
    }

    if (matches.length === 0) {
        list.innerHTML = '<p class="app-list-empty">No apps match that search.</p>';
        return;
    }

    list.innerHTML = matches.map((app: CatalogApp) => {
        const selected = selectedApp?.slug === app.slug ? ' selected' : '';
        // Empty database means the app manages its own storage internally.
        const database = app.database
            ? `<span class="app-db">${escapeHtml(app.database)}</span>`
            : '<span class="app-db app-db-none">self-contained</span>';
        const note = app.note ? `<p class="app-note">${escapeHtml(app.note)}</p>` : '';

        return `
            <div class="app-entry${selected}" onclick="selectApp('${escapeHtml(app.slug)}')" data-testid="app-${escapeHtml(app.slug)}">
                <div class="app-entry-header">
                    <strong>${escapeHtml(app.display)}</strong>
                    <code class="app-slug">${escapeHtml(app.slug)}</code>
                    ${database}
                </div>
                ${note}
            </div>
        `;
    }).join('');
}

function selectApp(slug: string): void {
    selectedApp = appCatalog.find((app: CatalogApp) => app.slug === slug) || null;

    const submit = document.getElementById('install-submit-btn') as HTMLButtonElement;
    if (submit) {
        submit.disabled = selectedApp === null;
        submit.textContent = selectedApp ? `Install ${selectedApp.display}` : 'Install';
    }

    renderAppCatalog();
}

async function handleInstallApp(): Promise<void> {
    if (!selectedApp || installInProgress) return;

    clearFieldErrors();

    const projectName = (document.getElementById('install-project-name') as HTMLInputElement)?.value?.trim() || '';
    if (projectName) {
        const validation = validateProjectName(projectName);
        if (!validation.valid) {
            showFieldError('install-project-name', validation.error!);
            return;
        }
    }

    // Installing writes /etc/hosts through setup + up.
    const sudoOk = await ipcRenderer.invoke('ensure-sudo');
    if (!sudoOk) {
        showError('Could not authenticate for the hosts file change. Run the install from a terminal instead.');
        return;
    }

    const app = selectedApp;
    const target = projectName || app.slug;

    installInProgress = true;
    installStreamActive = true;
    setInstallView('progress');

    const title = document.getElementById('install-progress-title');
    // A slow app goes quiet for a full minute during its readiness retries —
    // measured at 60s on mautic. A static pane and a static line are
    // indistinguishable from a hang, so keep something visibly moving.
    startInstallClock(app.display, target);

    // Deliberately NOT --json-output: it suppresses all human-readable output,
    // including the URL, credentials and notes printed at the end, and would
    // leave a failure with an empty stdout. --one-off skips the AI handoff,
    // which has nothing to attach to in a GUI.
    const args = ['install', app.slug];
    if (projectName) args.push(projectName);
    args.push('--one-off');

    try {
        const result = await ipcRenderer.invoke('execute-command-stream', 'zeltro', args);

        installInProgress = false;
        stopInstallClock();
        // The result carries the complete captured output, so use it to close
        // any gap the stream left. Belt and braces with the flag change above:
        // the summary block is the whole point of not passing --json-output.
        reconcileInstallOutput(result);

        if (result.code === 0) {
            // Exit 0 is not "it works". `zeltro install` exits 0 after its
            // readiness retries are exhausted, printing "returned HTTP 000 — it
            // may still be initializing". Reporting that as success gave a green
            // toast and a URL for a crash-looping app. Ask the app instead —
            // this runs after the CLI gave up, so it can only be more current.
            // Ask the CLI where the project actually is rather than assuming
            // its name resolves. Zeltro stopped writing /etc/hosts, so
            // http://<name>/ resolves nowhere — this probe would have failed on
            // a perfectly working install and reported it as still initialising.
            const installedUrl = await projectLocalUrl(target);
            const probe = await ipcRenderer.invoke('check-project-url',
                installedUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''));
            const serving = probe.code >= 200 && probe.code < 400;

            if (serving) {
                showSuccess(`${app.display} installed at ${installedUrl}`);
                if (title) title.textContent = `${app.display} is installed — http://${target}/`;
            } else {
                showNotification(
                    `${app.display} installed, but http://${target}/ is not responding yet.`,
                    'warning', 8000);
                if (title) {
                    title.textContent = `${app.display} is installed but not responding yet `
                        + `(HTTP ${probe.code || 'no response'}) — it may still be starting. `
                        + `Check: zeltro logs ${target}`;
                }
            }
        } else {
            showError(`Install failed (exit ${result.code}). See the output above.`);
            if (title) title.textContent = `Install of ${app.display} failed (exit ${result.code}).`;
        }

        loadProjects();
        loadServices();
    } catch (error) {
        installInProgress = false;
        stopInstallClock();
        showError('Error installing app: ' + (error as Error).message);
    }
}

// Elapsed-time counter for the install progress line.
let installClock: ReturnType<typeof setInterval> | null = null;

function startInstallClock(display: string, target: string): void {
    stopInstallClock();
    const started = Date.now();

    const tick = () => {
        const title = document.getElementById('install-progress-title');
        if (!title) return;
        const secs = Math.floor((Date.now() - started) / 1000);
        const mins = Math.floor(secs / 60);
        const elapsed = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
        title.textContent =
            `Installing ${display} as "${target}"… ${elapsed} elapsed. Some apps take several minutes.`;
    };

    tick();
    installClock = setInterval(tick, 1000);
}

function stopInstallClock(): void {
    if (installClock) {
        clearInterval(installClock);
        installClock = null;
    }
}

// Live output from the streamed install
ipcRenderer.on('command-stream-data', (_event: any, payload: { type: string; data: string }) => {
    const output = document.getElementById('install-output');
    if (!output || !installStreamActive) return;

    output.textContent += payload.data;
    output.scrollTop = output.scrollHeight;
});

// Reconcile the pane against the command's own captured output.
//
// Appends only what is missing rather than replacing wholesale: the stream
// interleaves stdout and stderr in the order they were produced, and replacing
// with stdout alone would reorder or lose that. When the shown text is a clean
// prefix of the captured stdout — the case when a trailing chunk was lost —
// this restores the tail exactly.
function reconcileInstallOutput(result: { stdout?: string; stderr?: string }): void {
    const output = document.getElementById('install-output');
    if (!output) return;

    const captured = result.stdout || '';
    const shown = output.textContent || '';
    if (!captured || captured === shown) return;

    if (captured.startsWith(shown)) {
        output.textContent = captured;
    } else if (!shown.includes(captured.trimEnd().split('\n').pop() || '')) {
        // Not a clean prefix (stderr interleaved) and the final line never
        // arrived — append the captured tail rather than lose it.
        output.textContent = `${shown}\n${captured.slice(shown.length)}`;
    }
    output.scrollTop = output.scrollHeight;
}

function cloneProject(): void {
    showModal('clone-project-modal');
}

async function submitCloneProject(): Promise<void> {
    const form = document.getElementById('clone-project-form') as HTMLFormElement;
    const formData = new FormData(form);
    
    const repoUrl = formData.get('repoUrl') as string;
    const projectName = formData.get('projectName') as string;
    
    // Clear previous errors
    clearFieldErrors();
    
    // Validate URL
    if (!repoUrl || !repoUrl.trim()) {
        showFieldError('clone-repo-url', 'Repository URL is required');
        return;
    }
    
    try {
        new URL(repoUrl); // This will throw if invalid URL
    } catch {
        showFieldError('clone-repo-url', 'Please enter a valid URL');
        return;
    }
    
    // Validate project name if provided
    if (projectName && projectName.trim()) {
        if (!/^[a-zA-Z0-9_\s-]+$/.test(projectName.trim())) {
            showFieldError('clone-project-name', 'Project name can only contain letters, numbers, spaces, underscores, and dashes');
            return;
        }
        if (projectName.trim().length > 50) {
            showFieldError('clone-project-name', 'Project name must be 50 characters or less');
            return;
        }
    }
    
    try {
        closeModal();
        showLoadingOverlay('Cloning Project', `Cloning ${repoUrl}...`);
        
        // Signature is `zeltro clone <mode> <repo> [name]` — the mode positional
        // is required and the command hard-errors without it.
        const cloneMode = (document.getElementById('clone-mode') as HTMLSelectElement)?.value || 'work-directly';

        const args = [cloneMode, repoUrl];
        if (projectName && projectName.trim()) {
            args.push(projectName.trim());
        }
        args.push('--json-output');

        const result = await ipcRenderer.invoke('execute-zeltro', 'clone', args);
        
        hideLoadingOverlay();
        
        if (result.code === 0) {
            const finalProjectName = projectName?.trim() || repoUrl.split('/').pop()?.replace('.git', '') || 'cloned-project';
            showSuccess(`Project "${finalProjectName}" cloned successfully!`);
            // Clear form
            form.reset();
            // Refresh project list
            setTimeout(() => {
                loadProjects();
            }, 1000);
        } else {
            showError(`Failed to clone project: ${result.stderr || result.stdout}`);
        }
    } catch (error) {
        hideLoadingOverlay();
        showError('Error cloning project: ' + (error as Error).message);
    }
}

function closeModal(): void {
    // Close all modals
    const modals = document.querySelectorAll('.modal');
    modals.forEach(modal => {
        (modal as HTMLElement).classList.remove('show');
    });
}

// Function to validate project name: only allow alpha, numbers, underscore, space, dash
function validateProjectName(name: string): { valid: boolean; error?: string } {
    if (!name || name.trim().length === 0) {
        return { valid: false, error: 'Project name is required' };
    }
    
    if (name.length > 50) {
        return { valid: false, error: 'Project name must be 50 characters or less' };
    }
    
    const validPattern = /^[a-zA-Z0-9_\s-]+$/;
    if (!validPattern.test(name)) {
        return { valid: false, error: 'Project name can only contain letters, numbers, spaces, underscores, and dashes' };
    }
    
    return { valid: true };
}

// Function to validate description: anything except double quotes (since it goes in YAML as description: "VALUE")
function validateDescription(description: string): { valid: boolean; error?: string } {
    if (description.length > 200) {
        return { valid: false, error: 'Description must be 200 characters or less' };
    }
    
    if (description.includes('"')) {
        return { valid: false, error: 'Description cannot contain double quotes (used in YAML formatting)' };
    }
    
    return { valid: true };
}

// Function to validate version input
function validateVersion(version: string, framework: string): { valid: boolean; error?: string } {
    // Allow "latest" for all frameworks
    if (version === 'latest') return { valid: true };
    
    // Empty version defaults to "latest" so it's valid
    if (version.trim() === '') return { valid: true };
    
    if (framework === 'laravel') {
        // Laravel versions: major.minor.patch (e.g., 11.2.1)
        if (!/^\d+(\.\d+){0,2}$/.test(version)) {
            return { valid: false, error: 'Laravel version must be in format: major.minor.patch (e.g., 11.2.1)' };
        }
    } else if (framework === 'wordpress') {
        // WordPress versions: major.minor or major.minor.patch (e.g., 6.4 or 6.4.2)
        if (!/^\d+\.\d+(\.\d+)?$/.test(version)) {
            return { valid: false, error: 'WordPress version must be in format: major.minor or major.minor.patch (e.g., 6.4.2)' };
        }
    }
    
    return { valid: true };
}

// Function to sanitize container name: remove special chars, spaces to dashes, lowercase
function sanitizeContainerName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '') // Remove all special characters except spaces and dashes
        .replace(/\s+/g, '-') // Convert spaces to dashes
        .replace(/-+/g, '-') // Convert multiple dashes to single dash
        .replace(/^-|-$/g, ''); // Remove leading/trailing dashes
}

// Function to sanitize metadata strings: escape quotes and problematic characters
function sanitizeMetadata(text: string): string {
    return text
        .replace(/"/g, '\\"') // Escape double quotes
        .replace(/\\/g, '\\\\') // Escape backslashes
        .replace(/\n/g, '\\n') // Escape newlines
        .replace(/\r/g, '\\r'); // Escape carriage returns
}

// Function to show form validation errors
function showFieldError(fieldId: string, message: string): void {
    const field = document.getElementById(fieldId) as HTMLInputElement;
    if (!field) return;

    field.style.borderColor = '#e74c3c';

    // Reuse the markup's own <div id="<field>-error"> when it exists. The
    // previous version removed it and appended a replacement with no id, which
    // made every id in the HTML dead weight and the errors unaddressable.
    const named = document.getElementById(`${fieldId}-error`);
    if (named) {
        named.textContent = message;
        named.classList.add('field-error');
        return;
    }

    const existingError = field.parentNode?.querySelector('.field-error');
    if (existingError) {
        existingError.remove();
    }

    const errorDiv = document.createElement('div');
    errorDiv.className = 'field-error';
    errorDiv.textContent = message;
    field.parentNode?.appendChild(errorDiv);
}

// Function to clear field errors
function clearFieldErrors(): void {
    // Clear every error slot rather than a hardcoded pair of fields — the forms
    // have grown well past project-name/description, and errors on the others
    // used to persist across reopening a modal.
    //
    // Empty the markup's own <div id="…-error"> instead of removing it; those
    // elements are addressable and must survive.
    document.querySelectorAll('.field-error').forEach((el) => {
        if (el.id.endsWith('-error')) {
            el.textContent = '';
        } else {
            el.remove();
        }
    });

    document.querySelectorAll<HTMLElement>('input, select, textarea').forEach((field) => {
        field.style.borderColor = '';
    });
}

async function submitNewProject(): Promise<void> {
    console.log('DEBUG: submitNewProject called');
    
    // Clear any previous errors
    clearFieldErrors();
    
    const projectName = (document.getElementById('project-name') as HTMLInputElement)?.value;
    const projectDescription = (document.getElementById('project-description') as HTMLInputElement)?.value || '';
    const projectEmoji = (document.getElementById('project-emoji') as HTMLSelectElement)?.value || '🚀';
    const projectType = (document.getElementById('framework-choice') as HTMLInputElement)?.value;
    
    console.log('DEBUG: Form values:', { projectName, projectDescription, projectEmoji, projectType });
    
    // Validate project name
    const nameValidation = validateProjectName(projectName);
    console.log('DEBUG: Name validation:', nameValidation);
    if (!nameValidation.valid) {
        console.log('DEBUG: Name validation failed');
        showFieldError('project-name', nameValidation.error!);
        return;
    }
    
    // Validate description
    const descriptionValidation = validateDescription(projectDescription);
    if (!descriptionValidation.valid) {
        showFieldError('project-description', descriptionValidation.error!);
        return;
    }
    
    // Validate version if applicable
    if (projectType === 'laravel') {
        const versionInput = document.getElementById('laravel-version') as HTMLInputElement;
        const version = versionInput?.value?.trim() || 'latest';
        const versionValidation = validateVersion(version, 'laravel');
        if (!versionValidation.valid) {
            showFieldError('laravel-version', versionValidation.error!);
            return;
        }
    } else if (projectType === 'wordpress') {
        const versionInput = document.getElementById('wordpress-version') as HTMLInputElement;
        const version = versionInput?.value?.trim() || 'latest';
        const versionValidation = validateVersion(version, 'wordpress');
        if (!versionValidation.valid) {
            showFieldError('wordpress-version', versionValidation.error!);
            return;
        }
    }
    
    // Check project type is selected
    if (!projectType) {
        showError('Please select a project type');
        return;
    }
    
    // Sanitize the project name for use as container name
    const sanitizedContainerName = sanitizeContainerName(projectName);
    if (!sanitizedContainerName) {
        showFieldError('project-name', 'Project name must contain at least one valid character');
        return;
    }
    
    try {
        closeModal();
        showLoadingOverlay('Creating Project', `Creating ${projectType} project: ${projectName}...`, true);
        
        // Signature is `zeltro new <framework> <name>` — framework is the FIRST
        // positional, not a flag. There is no --framework option, and the
        // display-name/description/emoji flags no longer exist; the GUI stores
        // that metadata itself after creation (see updateMetadataAfterCreate).
        const args = [projectType, sanitizedContainerName, '--json-output'];

        // Only send --database when the user picked a specific engine. Left on
        // "Auto" the CLI applies its own per-framework default, which is better
        // than the GUI guessing: it used to hardcode mysql for every framework,
        // and the CLI silently coerced it to something the framework supports.
        const database = (document.getElementById('project-database') as HTMLSelectElement)?.value || '';
        if (database) {
            args.push('--database', database);
        }

        // --version only means something for these three.
        if (projectType === 'laravel' || projectType === 'wordpress') {
            const versionInput = document.getElementById(`${projectType}-version`) as HTMLInputElement;
            const version = versionInput?.value?.trim();
            if (version) {
                args.push('--version', version);
            }
        }

        // GitHub: exactly one of these, never both. The org flag is
        // --github-org (not --org, which the CLI rejects as unknown).
        const createGithub = (document.getElementById('create-github-repo') as HTMLInputElement)?.checked;
        if (createGithub) {
            const org = (document.getElementById('organization') as HTMLInputElement)?.value?.trim();
            if (org) {
                args.push('--github-org', org);
            } else {
                args.push('--github');
            }
        } else {
            args.push('--no-github');
        }

        // Streamed rather than buffered, so the overlay can show progress.
        // --json-output is dropped here: it suppresses exactly the human-readable
        // output we now want to display, and success is judged by exit code.
        // Routed to the chosen host. The remote path streams on the same
        // channel, so the progress pane above needs no knowledge of which
        // machine is doing the work.
        const cleanArgs = args.filter((a) => a !== '--json-output');
        const result = newProjectHost === 'local'
            ? await ipcRenderer.invoke('execute-command-stream', 'zeltro', ['new', ...cleanArgs])
            : await ipcRenderer.invoke('execute-zeltro-stream-on', newProjectHost, 'new', cleanArgs);

        if (result.code !== 0) {
            // Leave the overlay up: the output pane above already holds the real
            // reason, and it is far more use than a toast full of progress bars.
            failLoadingOverlay(
                'Could not create the project',
                `zeltro new exited with code ${result.code}. The output above shows why.`
            );
            return;
        }

        hideLoadingOverlay();

        if (result.code === 0) {
            // The CLI no longer stores display metadata, so persist it here.
            await ipcRenderer.invoke('update-project-metadata', sanitizedContainerName, {
                display_name: sanitizeMetadata(projectName),
                description: projectDescription ? sanitizeMetadata(projectDescription) : '',
                emoji: projectEmoji
            });

            showSuccess(`Project "${projectName}" created successfully!`);
        }
        
        // Refresh project list
        setTimeout(() => {
            loadProjects();
            loadServices();
        }, 3000);
    } catch (error) {
        hideLoadingOverlay();
        showError('Error creating project: ' + (error as Error).message);
    }
}

// Variables to track current project being edited/removed
let currentProjectName = '';
let currentServiceName = '';

// Show manage service modal
async function showManageModal(serviceName: string): Promise<void> {
    currentServiceName = serviceName;
    
    const titleElement = document.getElementById('manage-service-title');
    if (titleElement) {
        titleElement.textContent = `Manage ${serviceName.charAt(0).toUpperCase() + serviceName.slice(1)}`;
    }
    
    showModal('manage-service-modal');
    
    // Load initial stats
    await refreshServiceStats();
}

// Refresh service statistics
async function refreshServiceStats(): Promise<void> {
    if (!currentServiceName) return;
    
    const statsContainer = document.getElementById('service-stats');
    if (!statsContainer) return;
    
    try {
        // Show loading state
        statsContainer.innerHTML = '<div class="stat-item"><div class="stat-value">...</div><div class="stat-label">Loading</div></div>';
        
        // Get service statistics
        const result = await ipcRenderer.invoke('get-service-stats', currentServiceName);
        
        if (result.success) {
            renderServiceStats(result.stats);
        } else {
            statsContainer.innerHTML = `<div class="stat-item"><div class="stat-value">Error</div><div class="stat-label">${result.error}</div></div>`;
        }
    } catch (error) {
        statsContainer.innerHTML = `<div class="stat-item"><div class="stat-value">Error</div><div class="stat-label">Failed to load stats</div></div>`;
        console.error('Failed to load service stats:', error);
    }
}

// Render service statistics in the modal
function renderServiceStats(stats: any): void {
    const statsContainer = document.getElementById('service-stats');
    if (!statsContainer) return;
    
    if (currentServiceName === 'redis') {
        statsContainer.innerHTML = `
            <div class="stat-item">
                <div class="stat-value">${stats.used_memory_human || 'N/A'}</div>
                <div class="stat-label">Memory Used</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${stats.total_commands_processed || '0'}</div>
                <div class="stat-label">Commands Processed</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${stats.connected_clients || '0'}</div>
                <div class="stat-label">Connected Clients</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${stats.keyspace_hits || '0'}</div>
                <div class="stat-label">Keyspace Hits</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${stats.keyspace_misses || '0'}</div>
                <div class="stat-label">Keyspace Misses</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${stats.total_keys || '0'}</div>
                <div class="stat-label">Total Keys</div>
            </div>
        `;
    } else if (currentServiceName === 'memcached') {
        statsContainer.innerHTML = `
            <div class="stat-item">
                <div class="stat-value">${stats.bytes || 'N/A'}</div>
                <div class="stat-label">Memory Used</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${stats.cmd_get || '0'}</div>
                <div class="stat-label">GET Commands</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${stats.cmd_set || '0'}</div>
                <div class="stat-label">SET Commands</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${stats.curr_connections || '0'}</div>
                <div class="stat-label">Current Connections</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${stats.get_hits || '0'}</div>
                <div class="stat-label">Cache Hits</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${stats.get_misses || '0'}</div>
                <div class="stat-label">Cache Misses</div>
            </div>
        `;
    }
}

// Flush service data
async function flushServiceData(): Promise<void> {
    if (!currentServiceName) return;
    
    const confirmed = confirm(`⚠️ Are you sure you want to flush ALL data from ${currentServiceName}?\n\nThis action cannot be undone!`);
    if (!confirmed) return;
    
    try {
        showLoadingOverlay('Flushing Data', `Clearing all data from ${currentServiceName}...`);
        
        const result = await ipcRenderer.invoke('flush-service-data', currentServiceName);
        
        hideLoadingOverlay();
        
        if (result.success) {
            showSuccess(`${currentServiceName} data flushed successfully!`);
            // Refresh stats to show empty state
            await refreshServiceStats();
        } else {
            showError(`Failed to flush ${currentServiceName}: ${result.error}`);
        }
    } catch (error) {
        hideLoadingOverlay();
        showError('Error flushing service data: ' + (error as Error).message);
    }
}

// Show remove project modal
function showRemoveProjectModal(projectName: string): void {
    currentProjectName = projectName;
    const nameElement = document.getElementById('remove-project-name');
    if (nameElement) {
        nameElement.textContent = projectName;
    }
    
    // Reset checkbox
    const preserveCheckbox = document.getElementById('preserve-database') as HTMLInputElement;
    if (preserveCheckbox) {
        preserveCheckbox.checked = false;
    }
    
    showModal('remove-project-modal');
}

// Confirm project removal
async function confirmRemoveProject(): Promise<void> {
    if (!currentProjectName) return;
    
    try {
        closeModal();
        showLoadingOverlay('Removing Project', `Removing ${currentProjectName}...`);
        
        const preserveDatabase = (document.getElementById('preserve-database') as HTMLInputElement)?.checked || false;
        const args = [currentProjectName, '--json-output'];
        
        if (preserveDatabase) {
            args.push('--preserve-database');
        }
        
        const result = await zeltroFor(currentProjectName, 'remove', args);

        hideLoadingOverlay();
        
        if (result.code === 0) {
            showSuccess(`Project "${currentProjectName}" removed successfully!`);
        } else {
            showError(`Failed to remove project: ${result.stderr || result.stdout}`);
        }
        
        // Refresh project list
        setTimeout(() => {
            loadProjects();
            loadServices();
        }, 1000);
    } catch (error) {
        hideLoadingOverlay();
        showError('Error removing project: ' + (error as Error).message);
    }
}

// Show edit project modal
function editProject(projectName: string): void {
    currentProjectName = projectName;
    
    // Find the project data
    const parsed = projects.find(p => p.name === projectName);
    if (!parsed) {
        showError('Project not found');
        return;
    }

    // Same reason as renderProjects: read display metadata from the cache, not
    // from the parsed status object, which does not carry it.
    const project = withMetadata(parsed);

    // Populate the form
    const displayNameField = document.getElementById('edit-display-name') as HTMLInputElement;
    const descriptionField = document.getElementById('edit-description') as HTMLInputElement;
    const emojiField = document.getElementById('edit-emoji') as HTMLSelectElement;
    
    if (displayNameField) displayNameField.value = project.display_name || project.name;
    if (descriptionField) descriptionField.value = project.description || '';
    if (emojiField) emojiField.value = project.emoji || '🚀';
    
    showModal('edit-project-modal');
}

// Submit edit project changes
async function submitEditProject(): Promise<void> {
    if (!currentProjectName) return;
    
    const displayName = (document.getElementById('edit-display-name') as HTMLInputElement)?.value;
    const description = (document.getElementById('edit-description') as HTMLInputElement)?.value || '';
    const emoji = (document.getElementById('edit-emoji') as HTMLSelectElement)?.value || '🚀';
    
    // Validate inputs
    const nameValidation = validateProjectName(displayName);
    if (!nameValidation.valid) {
        showError(nameValidation.error!);
        return;
    }
    
    const descriptionValidation = validateDescription(description);
    if (!descriptionValidation.valid) {
        showError(descriptionValidation.error!);
        return;
    }
    
    try {
        closeModal();
        showLoadingOverlay('Updating Project', `Updating ${displayName}...`);
        
        // Update the docker-compose.yaml file directly
        const result = await ipcRenderer.invoke('update-project-metadata', currentProjectName, {
            display_name: displayName,
            description: description,
            emoji: emoji
        });
        
        hideLoadingOverlay();
        
        if (result.success) {
            // Update the project in place so the grid reflects the edit at once
            // rather than after the next poll. There is no separate cache to
            // keep in step any more — this IS the state the grid renders.
            const edited = projects.find(p => p.name === currentProjectName);
            if (edited) {
                edited.display_name = displayName;
                edited.description = description;
                edited.emoji = emoji;
            }

            showSuccess(`Project "${displayName}" updated successfully!`);
            renderProjects();
            renderFilterBar();   // counts derive from the project list

            // Refresh project list
            setTimeout(() => {
                loadProjects();
            }, 1000);
        } else {
            showError(`Failed to update project: ${result.error}`);
        }
    } catch (error) {
        hideLoadingOverlay();
        showError('Error updating project: ' + (error as Error).message);
    }
}

// Export functions for global access
(window as any).showLoadingOverlay = showLoadingOverlay;
(window as any).failLoadingOverlay = failLoadingOverlay;
(window as any).hideLoadingOverlay = hideLoadingOverlay;
// Test hook: feed the overlay as if execute-command-stream had emitted.
(window as any).__feedOverlay = (data: string) => {
    const output = document.getElementById('loading-output');
    if (overlayStreaming && output) output.textContent += data;
};
(window as any).showAiSettings = showAiSettings;
(window as any).showSettings = showSettings;
(window as any).showDonateModal = showDonateModal;
(window as any).setRunFilter = setRunFilter;
(window as any).setHostFilter = setHostFilter;
(window as any).__hostFilter = () => hostFilter;
(window as any).setSortKey = setSortKey;
(window as any).toggleEmojiFilter = toggleEmojiFilter;
(window as any).clearEmojiFilter = clearEmojiFilter;
(window as any).resetFilters = resetFilters;
(window as any).setProjectsPerRow = setProjectsPerRow;
(window as any).setTerminalHost = setTerminalHost;
(window as any).toggleTileTerminal = toggleTileTerminal;
(window as any).closeTileTerminal = closeTileTerminal;
(window as any).hasTileTerminal = hasTileTerminal;
(window as any).selectTheme = selectTheme;
(window as any).switchSettingsTab = switchSettingsTab;
(window as any).onAiAgentChange = onAiAgentChange;
(window as any).onUnattendedChange = onUnattendedChange;
(window as any).addSshProfile = addSshProfile;
(window as any).updateSshProfile = updateSshProfile;
(window as any).removeSshProfile = removeSshProfile;
(window as any).testSshProfile = testSshProfile;
(window as any).showRemotesTab = showRemotesTab;
(window as any).showUpdates = showUpdates;
(window as any).setAutoUpdateCheck = setAutoUpdateCheck;
(window as any).setWarnUnreachableHosts = setWarnUnreachableHosts;
(window as any).__warnUnreachableHosts = warnUnreachableHosts;
(window as any).dismissUpdateBanner = dismissUpdateBanner;
(window as any).__autoUpdateCheck = autoUpdateCheckEnabled;
(window as any).runUpdate = runUpdate;
(window as any).__updateStatus = () => updateStatus;
(window as any).addSshCredential = addSshCredential;
(window as any).updateSshCredential = updateSshCredential;
(window as any).removeSshCredential = removeSshCredential;
(window as any).clearSshSecret = clearSshSecret;
(window as any).browseForKey = browseForKey;
(window as any).__sshCredentials = () => sshCredentials;
(window as any).configureSshHost = configureSshHost;
(window as any).__sshProfiles = () => sshProfiles;
(window as any).applyEndpoint = applyEndpoint;
(window as any).revealApiBase = revealApiBase;
(window as any).saveAiSettings = saveAiSettings;
(window as any).showCreateWithAI = showCreateWithAI;
(window as any).handleClassifyIdea = handleClassifyIdea;
(window as any).selectCandidate = selectCandidate;
(window as any).handleCreateFromChoice = handleCreateFromChoice;
(window as any).renderClassification = renderClassification;
(window as any).setCreateStage = setCreateStage;
(window as any).killTerminal = killTerminal;
(window as any).closeActiveTerminal = closeActiveTerminal;
(window as any).openAgentTerminal = openAgentTerminal;
// Small hooks so the e2e suite can inspect and tear down sessions without
// reaching into module state.
(window as any).__terminalCount = () => terminalSessions.size;
(window as any).__killFirstTerminal = () => {
    const first = [...terminalSessions.keys()][0];
    if (first) killTerminal(first);
};
(window as any).__killAllTerminals = () => {
    [...terminalSessions.keys()].forEach((id) => killTerminal(id));
};
// Rows of the first live session — collapsing a tile terminal must not change
// this, and there is no way to observe it from the DOM.
(window as any).__terminalRows = () => [...terminalSessions.values()][0]?.term?.rows ?? 0;
(window as any).renderProjects = renderProjects;
(window as any).disableProject = disableProject;
(window as any).enableProject = enableProject;
(window as any).isDisabled = isDisabled;
(window as any).showServiceManager = showServiceManager;
(window as any).toggleOptionalService = toggleOptionalService;
(window as any).setServicesHost = setServicesHost;
(window as any).__servicesHost = () => servicesHost;
(window as any).setServiceRowBusy = setServiceRowBusy;
(window as any).__optionalServices = () => optionalServices.map(s => s.slug);
// Unfiltered, unlike __visibleProjects — the suite needs to reason about
// projects the default view deliberately hides.
(window as any).__allProjects = () => projects.map(withMetadata);
// Feed synthetic status JSON through the real parser. Every project on this
// machine carries metadata, so the shapes that matter most for existing users —
// an empty metadata object, or none at all — cannot occur here naturally.
(window as any).__parseStatus = (json: string) => { parseProjectStatusJSON(json); return projects; };
// Test hook: drive the disabled state without shelling out to the CLI and
// mutating a real project's compose file.
(window as any).__setMetaStatus = (name: string, value: any) => {
    const p = projects.find(x => x.name === name) as any;
    if (!p) return;
    p.status_meta = (value === undefined || value === null) ? '' : value;
};
// The filtered+sorted list the grid is built from, so the suite can assert on
// the ordering rather than on tile text.
(window as any).__visibleProjects = () => visibleProjects().map(withMetadata);
(window as any).modifyWithAI = modifyWithAI;
(window as any).showInstallApp = showInstallApp;
(window as any).showProjectKindStep = showProjectKindStep;
(window as any).chooseProjectKind = chooseProjectKind;
(window as any).showProjectHostStep = showProjectHostStep;
(window as any).chooseProjectHost = chooseProjectHost;
(window as any).__newProjectHost = () => newProjectHost;
(window as any).backToProjectKind = backToProjectKind;
(window as any).renderAppCatalog = renderAppCatalog;
(window as any).selectApp = selectApp;
(window as any).handleInstallApp = handleInstallApp;
(window as any).reconcileInstallOutput = reconcileInstallOutput;
(window as any).showNotification = showNotification;
(window as any).refreshProjects = refreshProjects;
(window as any).manualRefresh = manualRefresh;
(window as any).startAutoRefresh = startAutoRefresh;
(window as any).stopAutoRefresh = stopAutoRefresh;
(window as any).showCreateProject = showCreateProject;
(window as any).onFrameworkChange = onFrameworkChange;
(window as any).onRuntimeChange = onRuntimeChange;
(window as any).sendCompose = sendCompose;
(window as any).toggleDictation = toggleDictation;
(window as any).attachFiles = attachFiles;
(window as any).dismissTileNotice = dismissTileNotice;
(window as any).__resampleTo16k = resampleTo16k;
(window as any).setDictationEnabled = setDictationEnabled;
(window as any).setDictationQuality = setDictationQuality;
(window as any).setDictationLanguageMode = setDictationLanguageMode;
(window as any).__dictationModelId = dictationModelId;
(window as any).__dictationQuality = dictationQuality;
(window as any).setGithubHost = setGithubHost;
(window as any).setAiHost = setAiHost;
(window as any).__dashboardHosts = () => dashboardHosts;
(window as any).__aiHost = () => aiHost;
(window as any).loadGithubStatus = loadGithubStatus;
(window as any).githubSignIn = githubSignIn;
(window as any).githubSignOut = githubSignOut;
(window as any).__githubStatus = () => githubStatus;
(window as any).setDictationDevice = setDictationDevice;
(window as any).setDictationGain = setDictationGain;
(window as any).__dictationState = () => dictationState;
(window as any).restoreDictation = restoreDictation;
// Test-only: drive the panel through each state without a 150MB download.
(window as any).__setDictationState = (st: DictationState) => {
    dictationState = st;
    dictationDetail = st === 'downloading' ? 'Downloading speech model 42%'
        : st === 'error' ? 'Could not load the model: test' : '';
    renderDictationStatus();
};
(window as any).refreshMicButtons = refreshMicButtons;
(window as any).__dictationEnabled = dictationEnabled;
(window as any).loadFrameworkCatalog = loadFrameworkCatalog;
(window as any).startProject = startProject;
(window as any).stopProject = stopProject;
(window as any).removeProject = removeProject;
(window as any).showRemoveProjectModal = showRemoveProjectModal;
(window as any).confirmRemoveProject = confirmRemoveProject;
(window as any).editProject = editProject;
(window as any).submitEditProject = submitEditProject;
(window as any).showManageModal = showManageModal;
(window as any).refreshServiceStats = refreshServiceStats;
(window as any).flushServiceData = flushServiceData;

// Dropdown and Modal functions
function toggleDropdown(): void {
    const dropdown = document.getElementById('help-dropdown');
    if (dropdown) {
        dropdown.classList.toggle('show');
    }
}

// --- Updates ---------------------------------------------------------------

let updateStatus: any[] = [];

// Checked at startup by default. Off is a deliberate choice someone makes, so
// the absence of the setting means on rather than off.
function autoUpdateCheckEnabled(): boolean {
    return storedSetting('zeltro-auto-update-check') !== 'off';
}

function setAutoUpdateCheck(on: boolean): void {
    localStorage.setItem('zeltro-auto-update-check', on ? 'on' : 'off');
    if (!on) dismissUpdateBanner();
}

// Whether to warn about an SSH remote that did not answer.
//
// On by default: silently dropping a host's projects is the worse failure, and
// someone who has not thought about it should be told. Off is for the case
// Shawn described — a remote that is usually powered down, where the warning is
// noise about a state you already know.
function warnUnreachableHosts(): boolean {
    return storedSetting('zeltro-warn-unreachable') !== 'off';
}

function setWarnUnreachableHosts(on: boolean): void {
    localStorage.setItem('zeltro-warn-unreachable', on ? 'on' : 'off');
    renderProjects();
}

function dismissUpdateBanner(): void {
    const bar = document.getElementById('update-banner');
    if (bar) bar.style.display = 'none';
}

// A bar at the top, not a toast: a toast disappears, and this is a state rather
// than an event.
function renderUpdateBanner(): void {
    const bar = document.getElementById('update-banner');
    if (!bar) return;

    const behind = updateStatus.filter((r) => r.behind > 0);
    if (behind.length === 0 || !autoUpdateCheckEnabled()) {
        bar.style.display = 'none';
        return;
    }
    const names = behind.map((r) => `${r.label} (${r.behind} behind)`).join(', ');
    bar.style.display = '';
    bar.innerHTML = `
        <span>Update available — ${escapeHtml(names)}</span>
        <button class="btn btn-primary btn-small" onclick="showUpdates()">Review</button>
        <button class="btn btn-secondary btn-small" data-testid="update-banner-dismiss"
                onclick="dismissUpdateBanner()">Dismiss</button>`;
}

// Checked once at startup, in the background. A network call on the critical
// path would delay the dashboard for something nobody asked for yet.
async function checkUpdatesInBackground(): Promise<void> {
    try {
        updateStatus = await ipcRenderer.invoke('check-updates') || [];
    } catch {
        updateStatus = [];
    }
    renderUpdateBanner();
    const behind = updateStatus.filter((r) => r.behind > 0);
    const badge = document.getElementById('update-badge');
    if (badge) {
        // Only shown when there is something to do. A permanent badge is
        // wallpaper within a day.
        badge.style.display = behind.length > 0 ? '' : 'none';
        badge.textContent = behind.length > 0 ? String(behind.length) : '';
    }
}

function renderUpdates(): void {
    const host = document.getElementById('updates-list');
    if (!host) return;

    if (updateStatus.length === 0) {
        host.innerHTML = `<p class="app-list-empty">No Zeltro checkouts found to update.</p>`;
        return;
    }

    host.innerHTML = updateStatus.map((r) => {
        let state: string;
        let cls: string;
        if (r.error)            { state = r.error; cls = 'bad'; }
        else if (r.behind > 0)  { state = `${r.behind} commit${r.behind === 1 ? '' : 's'} behind`; cls = 'bad'; }
        else if (r.ahead > 0)   { state = `${r.ahead} ahead — nothing to pull`; cls = 'ok'; }
        else                    { state = 'up to date'; cls = 'ok'; }

        return `
        <div class="update-row" data-testid="update-${escapeHtml(r.id)}">
            <div class="update-head">
                <strong>${escapeHtml(r.label)}</strong>
                <span class="update-branch">${escapeHtml(r.branch)} @ ${escapeHtml(r.local || '?')}</span>
            </div>
            <p class="ssh-status ${cls}" data-testid="update-state-${escapeHtml(r.id)}">${escapeHtml(state)}</p>
            ${r.dirty ? `<p class="settings-note">Uncommitted changes — commit or stash before updating.</p>` : ''}
            ${r.behind > 0 && !r.dirty
                ? `<button class="btn btn-primary btn-small" data-testid="update-run-${escapeHtml(r.id)}"
                           onclick="runUpdate('${escapeHtml(r.id)}')">Update</button>`
                : ''}
        </div>`;
    }).join('');
}

async function showUpdates(): Promise<void> {
    showModal('updates-modal');
    const host = document.getElementById('updates-list');
    if (host) host.innerHTML = `<p class="app-list-empty">Checking…</p>`;
    await checkUpdatesInBackground();
    renderUpdates();
}

async function runUpdate(repoId: string): Promise<void> {
    const row = document.querySelector(`[data-testid="update-state-${repoId}"]`);
    if (row) { row.textContent = 'Updating…'; row.className = 'ssh-status testing'; }

    const result = await ipcRenderer.invoke('update-repo', repoId);
    if (result.ok) {
        showSuccess(result.detail);
    } else {
        // A refusal or a conflict is shown as-is. Summarising git's own message
        // loses the part that says which file, which is the part that matters.
        showError(result.detail);
    }
    await checkUpdatesInBackground();
    renderUpdates();
}

function showAboutModal(): void {
    const modal = document.getElementById('about-modal');
    if (modal) modal.classList.add('show');
    // Versions are read from the CLI, so refresh them each time rather than
    // showing whatever was true when the app started.
    showAboutVersions();
    // Close dropdown when opening modal (if it exists)
    const dropdown = document.getElementById('help-dropdown');
    if (dropdown) {
        dropdown.classList.remove('show');
    }
}

// Make showAboutModal available globally immediately
(window as any).showAboutModal = showAboutModal;

function closeAboutModal(): void {
    console.log('DEBUG: closeAboutModal called');
    const modal = document.getElementById('about-modal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// Make closeAboutModal available globally immediately
(window as any).closeAboutModal = closeAboutModal;

// Close dropdown when clicking outside
document.addEventListener('click', function(event: Event) {
    const dropdown = document.getElementById('help-dropdown');
    const target = event.target as HTMLElement;
    
    if (dropdown && !target.closest('.dropdown')) {
        dropdown.classList.remove('show');
    }
});

// Close modal when clicking outside content
document.addEventListener('click', function(event: Event) {
    const modal = document.getElementById('about-modal');
    const target = event.target as HTMLElement;
    
    if (modal && target === modal) {
        closeAboutModal();
    }
});



(window as any).showModal = showModal;
(window as any).hideModal = hideModal;
(window as any).openUrl = openUrl;
(window as any).openProjectUrl = openProjectUrl;
(window as any).__projectUrls = projectUrls;
(window as any).startServices = startServices;
(window as any).stopServices = stopServices;
(window as any).startAllProjects = startAllProjects;
(window as any).stopAllProjects = stopAllProjects;
(window as any).createNewProject = createNewProject;
(window as any).cloneProject = cloneProject;
(window as any).closeModal = closeModal;
(window as any).showFieldError = showFieldError;
(window as any).clearFieldErrors = clearFieldErrors;
(window as any).submitNewProject = submitNewProject;
(window as any).submitCloneProject = submitCloneProject;
(window as any).handleCreateProject = handleCreateProject;
(window as any).toggleDropdown = toggleDropdown;
(window as any).showAboutModal = showAboutModal;
(window as any).closeAboutModal = closeAboutModal;
(window as any).showModal = showModal;
