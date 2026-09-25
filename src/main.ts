import { CLI_BIN, PRODUCT, CLI_CONFIG_DIR } from './branding';
import { app, BrowserWindow, ipcMain, dialog, IpcMainInvokeEvent, Menu, shell, safeStorage } from 'electron';
import * as path from 'path';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';

// Debug log file path
const debugLogPath: string = path.join(os.tmpdir(), 'zeltro-gui-debug.log');

// Debug logging function
function debugLog(message: string, data: any = null): void {
  const timestamp: string = new Date().toISOString();
  const logEntry: string = `[${timestamp}] ${message}${data ? '\n' + JSON.stringify(data, null, 2) : ''}\n`;
  
  // Console log for immediate viewing
  console.log(message, data || '');
  
  // Only write to file if in debug mode (--dev flag)
  if (process.argv.includes('--dev')) {
    try {
      // Overwrite file each time (not append)
      if (!fs.existsSync(debugLogPath)) {
        fs.writeFileSync(debugLogPath, '=== ZELTRO GUI DEBUG LOG ===\n');
      }
      fs.appendFileSync(debugLogPath, logEntry);
    } catch (error) {
      console.error('Failed to write debug log:', error);
    }
  }
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  // Clear debug log at startup
  if (process.argv.includes('--dev')) {
    try {
      fs.writeFileSync(debugLogPath, '=== ZELTRO GUI DEBUG LOG ===\n');
      debugLog('Debug logging initialized', { logPath: debugLogPath });
    } catch (error) {
      console.error('Failed to initialize debug log:', error);
    }
  }

  // --no-focus: open without stealing focus, and try to come up behind whatever
  // the user is working in. Meant for automated/background launches (the e2e
  // harness passes it) so a test run does not grab the keyboard mid-sentence.
  // A normal double-click launch still focuses, which is what people expect.
  const noFocus: boolean = process.argv.includes('--no-focus');

  mainWindow = new BrowserWindow({
    width: 2000,
    height: 1200,
    // Render offscreen first, then decide how to present it.
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      additionalArguments: process.argv.includes('--dev') ? ['--debug-mode'] : []
    },
    icon: path.join(__dirname, '../assets/icon.png'),
    title: 'Zeltro',
    // Electron's default window background is WHITE, and it shows through on
    // any frame the page has not painted. That is what the splash animation was
    // exposing: six images changing opacity forces enough compositing that
    // Chromium occasionally presents the window before the page, and the whole
    // screen flashes white.
    //
    // I first blamed mix-blend-mode and removing it helped — fewer layers, so
    // fewer dropped frames — but it was treating the symptom. The window has
    // always been able to flash; the animation only made it frequent enough to
    // notice.
    //
    // Matches the default theme's --bg-primary so the base colour is never a
    // colour the app does not use.
    backgroundColor: '#0f0f23'
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;

    if (!noFocus) {
      mainWindow.show();
      return;
    }

    // showInactive presents the window without activating it — no focus steal.
    mainWindow.showInactive();
    mainWindow.blur();

    // Stacking order is the window manager's call and Electron has no
    // "send to back", so on X11 ask the WM directly. Best-effort by design:
    // if neither tool is installed the window simply stays where it is,
    // unfocused, which is the part that actually matters.
    //
    // The `below` state has to be added and then REMOVED. Adding it drops the
    // window to the bottom; leaving it set makes that permanent, so the window
    // stays behind everything else even after the user clicks it — which is
    // worse than the problem being solved. Clearing the state afterwards keeps
    // the position without keeping the rule. `demands_attention` goes too:
    // that is the taskbar highlight, and a background launch should not be
    // asking for attention at all.
    if (process.platform === 'linux') {
      const title = 'Zeltro';
      const wm = (state: string) =>
        `xdotool search --name '${title}' set_window --urgency 0 2>/dev/null; ` +
        `wmctrl -r '${title}' -b ${state} 2>/dev/null`;

      setTimeout(() => {
        const lower = spawn('sh', ['-c', wm('add,below')], { stdio: 'ignore' });
        lower.on('error', () => { /* no wmctrl/xdotool; nothing to do */ });
      }, 120);

      // Clear the rule the moment the user actually clicks the window, not on
      // a timer. A timer either fires too early (the window drifts back up the
      // stack) or leaves the state set (the window is stuck behind everything
      // forever). Tying it to focus gives both halves: it opens underneath
      // everything and behaves like a normal window as soon as it is wanted.
      mainWindow.once('focus', () => {
        const clear = spawn('sh', ['-c', wm('remove,below,demands_attention')], { stdio: 'ignore' });
        clear.on('error', () => { /* as above */ });
      });
    }
  });

  // Set up custom application menu
  const template: any[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow?.webContents.executeJavaScript('createNewProject()');
          }
        },
        {
          label: 'Clone Project',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            mainWindow?.webContents.executeJavaScript('cloneProject()');
          }
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectall' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            mainWindow?.webContents.executeJavaScript('openAboutModal()');
          }
        },
        { type: 'separator' },
        {
          label: 'Patreon',
          click: () => {
            shell.openExternal('https://patreon.com/canebaycomputers');
          }
        },
        {
          label: 'Donate',
          click: () => {
            shell.openExternal('https://donate.zeltro.build');
          }
        }
      ]
    }
  ];

  // macOS specific menu adjustments
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services', submenu: [] },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideothers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });

    // Window menu
    template[5].submenu = [
      { role: 'close' },
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      { role: 'front' }
    ];
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Check if Zeltro CLI is installed and configured
  const zeltroStatus: string = checkZeltroStatus();
  debugLog('Zeltro status check result', { status: zeltroStatus, platform: process.platform });

  // Windows has no local Zeltro and never will: Zeltro is Docker plus bash
  // scripts, and the deliberate decision is remote hosts rather than WSL. So
  // the installer — which installs and configures a LOCAL CLI — has nothing to
  // do there, and showing it would offer an install that cannot succeed.
  //
  // Go straight to the dashboard, which is remote-only on Windows. Configuring
  // a host is part of adding an SSH profile instead.
  if (process.platform === 'win32') {
    debugLog('Loading index.html - Windows is remote-only, no local install to make');
    mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  } else if (zeltroStatus === 'not-installed') {
    debugLog('Loading installer.html - Zeltro not installed');
    mainWindow.loadFile(path.join(__dirname, '..', 'src', 'installer.html'));
  } else if (zeltroStatus === 'not-configured') {
    debugLog('Loading installer.html - Zeltro not configured');
    mainWindow.loadFile(path.join(__dirname, '..', 'src', 'installer.html'));
  } else {
    debugLog('Loading index.html - Zeltro ready');
    mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  }

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

type ZeltroStatus = 'configured' | 'not-configured' | 'not-installed';

// Zeltro's machine-wide config. Written by `zeltro configure`; the CLI reads it
// from this fixed path, so there is nothing to search for.
// Same transition as the binary name: the CLI moves its config directory
// separately, so a machine can be mid-rename with the old one still in place.
// Whichever exists is the real one; a GUI that only looks at the new path
// reports "not configured" on a configured install.
const ZELTRO_ENV_CANDIDATES = ['/etc/zeltro-cli/.env', '/etc/podium-cli/.env'];

function zeltroEnvPath(): string {
  return ZELTRO_ENV_CANDIDATES.find((p) => fs.existsSync(p)) || ZELTRO_ENV_CANDIDATES[0]!;
}

// Installed location of the CLI itself. Only used as a fallback when `zeltro`
// is not on PATH.
// Same transition as the binary and the config dir. Observed mid-rename on this
// machine: the CLI's entry script had already become src/zeltro while the
// install directory was still podium-cli and /usr/local/bin/podium had become a
// DANGLING symlink — so neither name resolved and a working install looked
// absent. Whichever directory exists is the real one.
const ZELTRO_CLI_DIR_CANDIDATES = [
  '/usr/local/share/zeltro-cli',
  '/usr/local/share/podium-cli',
  '/opt/zeltro-cli',
  '/opt/podium-cli'
];

function zeltroCliDir(): string {
  return ZELTRO_CLI_DIR_CANDIDATES.find((d) => fs.existsSync(d)) || ZELTRO_CLI_DIR_CANDIDATES[0]!;
}

const ZELTRO_CLI_DIR = zeltroCliDir();

// Where `zeltro` actually is, as an argv pair.
//
// Bare spawn(CLI_BIN) only works when the launching environment has the CLI on
// PATH. A shell has it; a .desktop launcher started by the panel does not, and
// a packaged install therefore failed with "spawn zeltro ENOENT" for every
// command while working perfectly from a terminal. Resolving it here means each
// call site gets the same answer instead of one of them having a fallback.
//
// Deliberately not cached. It is a handful of stat calls at human frequency,
// and a cache would make the resolution untestable — the first call would fix
// the answer before any test could vary the environment.
// Find an executable without trusting PATH.
//
// A .desktop launch on Linux has no /usr/local/bin, and a macOS app launched
// from Finder has no /opt/homebrew/bin — Homebrew adds that in ~/.zprofile,
// which a GUI launch never sources. Both are silent: the command simply is not
// found, and whatever depended on it degrades without saying why.
function resolveBinary(name: string): string | null {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = [
    // PATH first, so a dev or user-installed copy wins the way it would in a
    // shell, then the locations a GUI launch cannot see.
    ...pathDirs.map((dir) => path.join(dir, name)),
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    `/opt/homebrew/bin/${name}`
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not there, or not executable — keep looking.
    }
  }
  return null;
}

// The CLI was renamed from podium to zeltro, and the two do not update in
// lockstep — a GUI update can land before the CLI one, or the other way round.
// A machine mid-upgrade has the old binary and nothing else, and a GUI that
// only knows the new name reports "not installed" on a working install.
//
// Transitional on purpose: remove the fallback once the rename has been out
// long enough that nobody is running the old CLI.
const LEGACY_CLI_BIN = 'podium';

function resolveZeltro(): { command: string; prefix: string[] } {
  const found = resolveBinary(CLI_BIN) || resolveBinary(LEGACY_CLI_BIN);
  if (found) return { command: found, prefix: [] };

  // Last resort: the CLI's own entry script, run through bash so it does not
  // need its executable bit.
  // Re-read the directory rather than trusting the value captured at load: an
  // install can flip while the app is running, which is precisely what happened
  // here.
  for (const dir of ZELTRO_CLI_DIR_CANDIDATES) {
    for (const name of [CLI_BIN, LEGACY_CLI_BIN]) {
      const shipped = path.join(dir, 'src', name);
      if (fs.existsSync(shipped)) {
        return { command: 'bash', prefix: [shipped] };
      }
    }
  }

  // Nothing found. Return the bare name so the failure is the familiar ENOENT
  // rather than something invented here.
  return { command: CLI_BIN, prefix: [] };
}

// Terminal emulators that can be told "run this command", in the order worth
// trying. Each entry is the flag that precedes the command, because they do not
// agree: -e takes a command, --  takes the rest of the argv, and gnome-terminal
// wants both. Ordered so a desktop's own terminal wins over a stray xterm.
const TERMINAL_EMULATORS: Array<{ bin: string; args: (cmd: string[]) => string[] }> = [
  { bin: 'x-terminal-emulator', args: (c) => ['-e', ...c] },
  { bin: 'gnome-terminal',      args: (c) => ['--', ...c] },
  { bin: 'konsole',             args: (c) => ['-e', ...c] },
  { bin: 'xfce4-terminal',      args: (c) => ['-e', c.join(' ')] },
  { bin: 'mate-terminal',       args: (c) => ['--', ...c] },
  { bin: 'kitty',               args: (c) => [...c] },
  { bin: 'alacritty',           args: (c) => ['-e', ...c] },
  { bin: 'xterm',               args: (c) => ['-e', ...c] }
];

// Hand a command to the user's own terminal emulator.
//
// The shell keeps running after the command exits (`exec bash` style) so a
// finished agent does not take its output with it — the whole reason someone
// picks a system terminal is to keep the scrollback.
ipcMain.handle('open-system-terminal', async (
  _event: IpcMainInvokeEvent,
  cwd: string,
  command: string,
  args: string[] = []
): Promise<{ ok: boolean; error?: string }> => {
  const resolved = resolveIfZeltro(command, args);
  const quoted = [resolved.command, ...resolved.args]
    .map((part) => `'${part.replace(/'/g, `'\\''`)}'`)
    .join(' ');
  const inner = ['bash', '-lc', `cd ${JSON.stringify(cwd)} && ${quoted}; exec bash`];

  if (process.platform === 'darwin') {
    try {
      const script = `tell application "Terminal" to do script ${JSON.stringify(`cd ${cwd} && ${quoted}`)}`;
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  for (const emulator of TERMINAL_EMULATORS) {
    const found = resolveOnPath(emulator.bin);
    if (!found) continue;

    try {
      const child = spawn(found, emulator.args(inner), { detached: true, stdio: 'ignore' });
      child.unref();
      debugLog('Opened system terminal', { emulator: found, cwd, command, args });
      return { ok: true };
    } catch (error) {
      debugLog('System terminal failed to start', { emulator: found, error });
      // Installed but unusable — keep going rather than giving up on the rest.
    }
  }

  return { ok: false, error: 'no terminal emulator found' };
});

function resolveOnPath(bin: string): string | null {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Next directory.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SSH host profiles
//
// A Zeltro installation on another machine. Stored in the main process rather
// than localStorage because the executor lives here — the renderer only edits
// them.
//
// No secrets are stored: a profile holds a PATH to a private key, never a key
// or a password. Anything requiring a passphrase or a password is out of scope
// deliberately; key-based auth is what the executor will use.
// ---------------------------------------------------------------------------

// A credential: who to log in as and how. Separate from the host so one set of
// details can serve several machines — which is the common case here, where the
// same account and key reach every box.
interface SshCredential {
  id: string;
  label: string;
  user: string;
  authType: 'key' | 'password';
  /** Absolute path, chosen with a file picker rather than typed. */
  keyPath?: string;
  /**
   * safeStorage ciphertext, base64. Never the password itself, and never sent
   * back to the renderer once saved — the UI shows whether one is set, not what
   * it is.
   */
  secret?: string;
}

interface SshProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  /** Which credential to log in with. */
  credentialId?: string;
  // Kept for profiles written before credentials existed. Migrated on read;
  // never written again.
  user?: string;
  keyPath?: string;
  // Resolved by the connection test, editable in the form. Not a fixed path,
  // because it genuinely varies: the four script installers put zeltro at
  // /usr/local/bin -> /usr/local/share/zeltro-cli, while the .deb puts it at
  // /usr/bin -> /opt/zeltro-cli, deliberately so the two can coexist. Hardcoding
  // one would make a .deb install report "command not found", which — given a
  // non-interactive PATH — is indistinguishable from "Zeltro is not installed".
  zeltroPath?: string;
}

function sshProfilesPath(): string {
  return path.join(app.getPath('userData'), 'ssh-hosts.json');
}

interface SshStore {
  credentials: SshCredential[];
  hosts: SshProfile[];
}

// Read the store, migrating the old shape if that is what is on disk.
//
// The original format was a bare array of hosts, each carrying its own user and
// keyPath. Those become one credential per distinct (user, keyPath) pair, so two
// hosts sharing an account end up sharing a credential rather than duplicating
// it. Migration happens on read and is written back on the next save, so an
// existing setup keeps working without anyone re-entering anything.
function readSshStore(): SshStore {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(sshProfilesPath(), 'utf8'));
  } catch {
    // Absent or unreadable: nothing configured is a normal state, not an error.
    return { credentials: [], hosts: [] };
  }

  if (parsed && Array.isArray(parsed.hosts)) {
    return {
      credentials: Array.isArray(parsed.credentials) ? parsed.credentials : [],
      hosts: parsed.hosts
    };
  }

  if (!Array.isArray(parsed)) return { credentials: [], hosts: [] };

  const credentials: SshCredential[] = [];
  const hosts: SshProfile[] = parsed.map((old: any) => {
    const user = old.user || '';
    const keyPath = old.keyPath || '';
    let cred = credentials.find((c) => c.user === user && c.keyPath === keyPath);
    if (!cred) {
      cred = {
        id: `cred-${credentials.length + 1}`,
        label: keyPath ? `${user} (key)` : user,
        user,
        authType: 'key',
        keyPath
      };
      credentials.push(cred);
    }
    return {
      id: old.id, label: old.label, host: old.host, port: old.port,
      credentialId: cred.id, zeltroPath: old.zeltroPath
    };
  });
  debugLog('Migrated SSH hosts to the credential model',
    { hosts: hosts.length, credentials: credentials.length });
  return { credentials, hosts };
}

/** Hosts only. Most callers want these and do not care about credentials. */
function readSshProfiles(): SshProfile[] {
  return readSshStore().hosts;
}

/** The credential a host logs in with, or null if it names one that is gone. */
function credentialFor(profile: SshProfile): SshCredential | null {
  const store = readSshStore();
  return store.credentials.find((c) => c.id === profile.credentialId) || null;
}

// Build the ssh2 connection options for a host.
//
// Shared by the connection test and the executor. Two auth paths existing in two
// places is how one of them ends up supporting passwords and the other not.
function connectOptionsFor(profile: SshProfile): {
  options?: any; error?: string; stage?: string;
} {
  const cred = credentialFor(profile);
  if (!cred) {
    return { error: 'No credential is set for this host. Choose one in Settings.', stage: 'credential' };
  }

  const base = {
    host: profile.host,
    port: profile.port || 22,
    username: cred.user,
    readyTimeout: 10000,
    keepaliveInterval: 20000
  };

  if (cred.authType === 'password') {
    const password = decryptSecret(cred.secret);
    if (!password) {
      // A credential set to password auth with nothing stored would otherwise
      // fail as a rejected login, sending someone to check the wrong thing.
      return { error: `No password is saved for "${cred.label}".`, stage: 'credential' };
    }
    return { options: { ...base, password } };
  }

  if (!cred.keyPath) {
    return { error: `No key is selected for "${cred.label}".`, stage: 'credential' };
  }
  try {
    const privateKey = fs.readFileSync(cred.keyPath.replace(/^~/, os.homedir()));
    const passphrase = decryptSecret(cred.secret);
    return { options: passphrase ? { ...base, privateKey, passphrase } : { ...base, privateKey } };
  } catch (error) {
    // Distinguished from a connection failure: the fix is a different path, not
    // a different host.
    return { error: `Cannot read key: ${(error as Error).message}`, stage: 'key' };
  }
}

// Store a secret using the OS credential store where there is one, and plainly
// where there is not.
//
// safeStorage.encryptString THROWS when encryption is unavailable — it does not
// return something weaker. Measured on this workstation: isEncryptionAvailable()
// is false and the backend is basic_text even with --password-store forced, so
// saving a password failed outright with "Encryption is not available".
//
// Refusing to save would be worse than saving plainly. The file is already mode
// 0600 in the user's home, which is exactly the protection an unencrypted
// private key in ~/.ssh has — and that is how most people already store the
// credential this replaces. The UI says which of the two it got.
//
// Marked with a prefix so reading knows how it was written, rather than
// guessing from whether decryption happens to fail.
function encryptSecret(plain: string): string {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(plain).toString('base64');
    }
  } catch {
    // Fall through: a store that claims to be available can still refuse.
  }
  return 'plain:' + Buffer.from(plain, 'utf8').toString('base64');
}

function decryptSecret(secret: string | undefined): string {
  if (!secret) return '';
  try {
    if (secret.startsWith('plain:')) {
      return Buffer.from(secret.slice(6), 'base64').toString('utf8');
    }
    const body = secret.startsWith('enc:') ? secret.slice(4) : secret;
    return safeStorage.decryptString(Buffer.from(body, 'base64'));
  } catch {
    return '';
  }
}

ipcMain.handle('get-ssh-profiles', async (): Promise<SshProfile[]> => readSshProfiles());

// The store as the renderer is allowed to see it: a stored secret becomes a
// boolean. The password itself has no reason to travel back, and a renderer
// with nodeIntegration is the last place to put one.
ipcMain.handle('get-ssh-store', async (): Promise<{
  credentials: Array<Omit<SshCredential, 'secret'> & { hasSecret: boolean }>;
  hosts: SshProfile[];
  encryption: { available: boolean; backend: string };
}> => {
  const store = readSshStore();
  return {
    credentials: store.credentials.map(({ secret, ...rest }) => ({
      ...rest, hasSecret: Boolean(secret)
    })),
    hosts: store.hosts,
    encryption: {
      available: safeStorage.isEncryptionAvailable(),
      backend: (safeStorage as any).getSelectedStorageBackend?.() ?? 'unknown'
    }
  };
});

// Save credentials and hosts together.
//
// A credential arrives with `secret` set to a new plaintext password, or absent
// to keep whatever is stored. That distinction is what lets the UI show "a
// password is set" without ever holding the password.
ipcMain.handle('save-ssh-store', async (
  _event: IpcMainInvokeEvent,
  incoming: { credentials: any[]; hosts: SshProfile[] }
): Promise<{ success: boolean; error?: string }> => {
  try {
    disposeExecutors();
    const existing = readSshStore();


    const credentials: SshCredential[] = (incoming.credentials || []).map((c) => {
      const prior = existing.credentials.find((p) => p.id === c.id);
      const out: SshCredential = {
        id: c.id, label: c.label, user: c.user,
        authType: c.authType === 'password' ? 'password' : 'key',
        keyPath: c.keyPath || ''
      };
      if (typeof c.newSecret === 'string' && c.newSecret !== '') {
        out.secret = encryptSecret(c.newSecret);
      } else if (c.clearSecret) {
        // Explicitly removed rather than merely absent.
      } else if (prior?.secret) {
        out.secret = prior.secret;
      }
      return out;
    });

    const store: SshStore = { credentials, hosts: incoming.hosts || [] };
    // Keep the last non-empty version beside the live one.
    //
    // Losing every host and credential to a bug is unrecoverable otherwise —
    // there is nothing to re-derive them from, and the write reports success.
    // Cheap insurance: one extra file, only rewritten when the store is about
    // to go from something to nothing.
    if ((existing.hosts.length > 0 || existing.credentials.length > 0)
        && store.hosts.length === 0 && store.credentials.length === 0) {
      try {
        fs.writeFileSync(sshProfilesPath() + '.last', JSON.stringify(existing, null, 2), { mode: 0o600 });
        debugLog('SSH store emptied; previous contents kept alongside', {
          had: { hosts: existing.hosts.length, credentials: existing.credentials.length },
          stack: new Error().stack
        });
      } catch { /* the backup failing must not block the save */ }
    }

    fs.writeFileSync(sshProfilesPath(), JSON.stringify(store, null, 2), { mode: 0o600 });
    // Re-applied on every write: an existing file keeps its old mode, so a
    // file created before this was set would stay world-readable forever.
    fs.chmodSync(sshProfilesPath(), 0o600);
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

// Browse for a private key rather than typing a path.
//
// Defaults to ~/.ssh, and filters nothing: keys have no consistent extension —
// id_rsa, id_ed25519, something.pem — so an extension filter would hide most of
// them.
ipcMain.handle('browse-for-key', async (): Promise<string> => {
  const result = await dialog.showOpenDialog({
    title: 'Select a private key',
    defaultPath: path.join(os.homedir(), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
    buttonLabel: 'Use this key'
  });
  return result.canceled ? '' : (result.filePaths[0] || '');
});

const REMOTE_ZELTRO_CANDIDATES = ['/usr/local/bin/zeltro', '/usr/bin/zeltro'];

// Zeltro's own scripts shell out to docker, git and sed. A non-interactive ssh
// command inherits a PATH those are not on - verified on the Mac rig, where
// `/usr/local/bin/zeltro status` ran and then died on
// "status.sh: line 137: docker: command not found" while
// /usr/local/bin/docker existed the whole time.
//
// So resolving zeltro absolutely is necessary but NOT sufficient: the child
// processes it spawns need a usable PATH too. Prepending rather than replacing,
// so a host with its own additions keeps them.
const REMOTE_PATH_PREFIX = 'PATH=/usr/local/bin:/opt/homebrew/bin:$PATH';

// `save-ssh-profiles` is deliberately absent. It wrote a bare array, which is
// the pre-credential shape — calling it now would silently discard every
// credential and leave each host pointing at an id that no longer exists. Use
// `save-ssh-store`, which writes both halves together.

ipcMain.handle('test-ssh-profile', async (
  _event: IpcMainInvokeEvent,
  profile: SshProfile
): Promise<{ ok: boolean; stage: string; detail: string; zeltroPath?: string }> => {
  const { Client } = require('ssh2');

  return new Promise((resolve) => {
    let settled = false;
    let resolvedPath = '';
    const done = (ok: boolean, stage: string, detail: string) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* already closed */ }
      // Hand the resolved path back so the profile can remember it and the
      // form can show it, rather than probing on every call.
      resolve({ ok, stage, detail, zeltroPath: resolvedPath });
    };

    const built = connectOptionsFor(profile);
    if (!built.options) {
      return resolve({ ok: false, stage: built.stage || 'key', detail: built.error || 'Cannot connect' });
    }

    const conn = new Client();

    // A host that is off does not refuse, it goes silent — without this the
    // dialog sits on "Testing..." indefinitely.
    const timer = setTimeout(() => done(false, 'connect', 'Timed out after 12s'), 12000);

    conn.on('ready', () => {
      // Probe absolute paths rather than `command -v zeltro`, which needs a
      // login shell to have a usable PATH — and a login shell sources rc files,
      // putting the user's aliases and version-manager chatter into a stream
      // being parsed as JSON.
      // Probe for the binary AND for configuration, in one round trip.
      //
      // Locally these are separate states — checkZeltroStatus returns
      // not-installed, not-configured or configured, and the GUI shows the
      // installer for the middle one. A remote host has the same three states,
      // and without this an installed-but-unconfigured host reports either
      // "0 projects" or an unparseable-output error, neither of which tells
      // anyone to run `zeltro configure`.
      //
      // `zeltro configure` writes PROJECTS_DIR into that file, and every project
      // command depends on it — same file path on macOS as on Linux.
      const probe = REMOTE_ZELTRO_CANDIDATES.map((c) => `test -x ${c} && echo BIN=${c}`).join('; ')
        + '; { grep -qs "^PROJECTS_DIR=" /etc/zeltro-cli/.env || grep -qs "^PROJECTS_DIR=" /etc/podium-cli/.env; }'
        + ' && echo CONFIGURED';

      conn.exec(probe, (probeErr: any, probeStream: any) => {
        if (probeErr) return done(false, 'exec', probeErr.message);

        let found = '';
        probeStream.on('data', (d: Buffer) => { found += d.toString(); });
        probeStream.on('close', () => {
          const lines = found.split('\n').map((l) => l.trim()).filter(Boolean);
          const bin = lines.find((l) => l.startsWith('BIN='))?.slice(4);
          const configured = lines.includes('CONFIGURED');

          if (!bin) {
            return done(false, 'zeltro',
              `Not found at ${REMOTE_ZELTRO_CANDIDATES.join(' or ')} — set the path in the host's settings.`);
          }
          if (!configured) {
            // Distinct from "not installed": the fix is a command on that host,
            // not an install, and saying so is the whole value of the message.
            return done(false, 'configure',
              'Zeltro is installed but not configured. Run `zeltro configure` on that host.');
          }
          resolvedPath = bin;
          runStatus(bin);
        });
      });

      const runStatus = (bin: string) => {
      conn.exec(`${REMOTE_PATH_PREFIX} ${bin} status --all --json-output`, (err: any, stream: any) => {
        if (err) return done(false, 'exec', err.message);

        let out = '';
        let errOut = '';
        stream.on('data', (d: Buffer) => { out += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { errOut += d.toString(); });
        stream.on('close', (code: number) => {
          clearTimeout(timer);
          if (code !== 0) {
            return done(false, 'zeltro', errOut.trim() || `zeltro exited ${code}`);
          }
          // Parse it, rather than trusting exit 0. The executor will parse this
          // exact output, so a host that connects but returns something
          // unparseable is not a working host.
          try {
            const parsed = JSON.parse(out);
            const projects = Array.isArray(parsed.projects) ? parsed.projects.length : 0;
            done(true, 'ok', `${projects} project${projects === 1 ? '' : 's'} · ${resolvedPath}`);
          } catch {
            done(false, 'parse', 'zeltro ran but its output was not JSON');
          }
        });
      });
      };
    });

    conn.on('error', (err: any) => {
      clearTimeout(timer);
      done(false, 'connect', err.message);
    });

    conn.connect(built.options);
  });
});

// Exposed so the resolution can be exercised against a stripped PATH — the
// exact condition that broke every packaged menu launch.
ipcMain.handle('get-zeltro-command', async (): Promise<{ command: string; prefix: string[] }> =>
  resolveZeltro());

// Same, for the install check. It is a separate handler because it exercises a
// separate code path: `resolveZeltro` was already PATH-independent while
// checkZeltroStatus still ran a bare `zeltro`, so testing the first said
// nothing about the second.
ipcMain.handle('get-zeltro-status', async (): Promise<string> => checkZeltroStatus());

// Whether this machine can run Zeltro locally at all. The dashboard uses it to
// decide whether "local" is an option when creating a project, and to explain
// an empty project list on a machine with no hosts configured yet.
// --- Updates ---------------------------------------------------------------
//
// Both Zeltro repos are source checkouts, so an update is a git pull. This
// reports where each one stands relative to its remote, and can pull them.
//
// Read-only by default: checking must never modify a working tree. `git fetch`
// is the only network call, and it touches remote refs, not the checkout.

function repoPaths(): Array<{ id: string; label: string; dir: string }> {
  const repos: Array<{ id: string; label: string; dir: string }> = [];

  // The GUI is running from its own checkout, so find it relative to this file
  // rather than guessing a path.
  const guiDir = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(guiDir, '.git'))) {
    repos.push({ id: 'gui', label: 'Zeltro GUI', dir: guiDir });
  }

  // The CLI is wherever `zeltro` resolves to. The binary is a symlink into the
  // install, so follow it rather than assuming /usr/local/share or /opt.
  try {
    const zeltro = resolveZeltro().command;
    const real = fs.realpathSync(zeltro);           // <install>/src/zeltro
    const cliDir = path.resolve(path.dirname(real), '..');
    if (fs.existsSync(path.join(cliDir, '.git'))) {
      repos.push({ id: 'cli', label: 'Zeltro CLI', dir: cliDir });
    }
  } catch {
    // No zeltro on PATH, or not a checkout — normal on Windows.
  }
  return repos;
}

// npm, spelled the way the platform spells it. On Windows the executable is
// npm.cmd; spawning a bare `npm` there fails with ENOENT, which is the same
// trap that produced issue #64.
function runNpm(dir: string, args: string[]): { code: number; out: string } {
  const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const out = execSync(`${bin} ${args.join(' ')}`, {
      cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000
    });
    return { code: 0, out: out.trim() };
  } catch (error: any) {
    return { code: error.status ?? 1, out: ((error.stdout || '') + (error.stderr || '')).trim() };
  }
}

/**
 * Create or refresh the Windows Desktop and Start Menu shortcuts.
 *
 * The installer does this too, but the in-app updater is how most people
 * actually take a new version, and it only pulled and built. So anyone who
 * installed before the shortcuts existed never got them, and anyone who had
 * the old ones kept a target that cannot be pinned to the taskbar. Refreshing
 * here means updating in the app is enough.
 *
 * Kept in step with scripts/install-windows.ps1 — same target, arguments and
 * icon. Change one, change the other.
 */
function refreshWindowsShortcuts(repoDir: string): { ok: boolean; out: string } {
  // NOT JSON.stringify. PowerShell has no backslash escapes, so a JSON-quoted
  // path arrives with every separator doubled — "C:\\dir". Windows collapses
  // duplicate separators when resolving a path, so TargetPath still worked and
  // the breakage hid; Arguments, WorkingDirectory and IconLocation are stored
  // as written, and the shortcut came out with a doubled icon path and
  // `dist\\main.js` as its argument. A single-quoted PowerShell literal is
  // verbatim, with '' as the only escape.
  const psLiteral = (v: string) => `'${v.replace(/'/g, "''")}'`;

  // Targets electron.exe rather than a .bat because Windows silently refuses
  // to pin a batch file to the taskbar.
  const ps = `
$ErrorActionPreference = 'Stop'
$repo = ${psLiteral(repoDir)}
$exe  = Join-Path $repo 'node_modules\\electron\\dist\\electron.exe'
if (-not (Test-Path $exe)) { throw "electron.exe not found at $exe" }
$icon = Join-Path $repo 'assets\\icon.ico'
$shell = New-Object -ComObject WScript.Shell
foreach ($p in @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Zeltro.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Zeltro.lnk'))) {
    $sc = $shell.CreateShortcut($p)
    $sc.TargetPath = $exe
    $sc.Arguments = 'dist\\main.js'
    $sc.WorkingDirectory = $repo
    $sc.Description = 'Zeltro - local development environments'
    if (Test-Path $icon) { $sc.IconLocation = $icon }
    $sc.Save()
}
`.trim();
  try {
    // -EncodedCommand avoids every layer of quoting between here and
    // PowerShell; the script has backslashes, quotes and $ in it.
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
      cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000
    });
    return { ok: true, out: '' };
  } catch (error: any) {
    return { ok: false, out: ((error.stdout || '') + (error.stderr || '')).trim() };
  }
}

function git(dir: string, args: string[]): { code: number; out: string } {
  try {
    const out = execSync(`git ${args.join(' ')}`, {
      cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000
    });
    return { code: 0, out: out.trim() };
  } catch (error: any) {
    return { code: error.status ?? 1, out: ((error.stdout || '') + (error.stderr || '')).trim() };
  }
}

interface RepoStatus {
  id: string; label: string; dir: string;
  branch: string; local: string; remote: string;
  behind: number; ahead: number;
  dirty: boolean;
  error?: string;
}

ipcMain.handle('check-updates', async (): Promise<RepoStatus[]> => {
  return repoPaths().map(({ id, label, dir }) => {
    const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
    const base: RepoStatus = {
      id, label, dir, branch, local: '', remote: '', behind: 0, ahead: 0, dirty: false
    };

    // Fetch touches remote-tracking refs only; the working tree is untouched.
    const fetched = git(dir, ['fetch', '--quiet', 'origin', branch]);
    if (fetched.code !== 0) {
      return { ...base, error: `Could not reach the remote: ${fetched.out.split('\n')[0]}` };
    }

    const local = git(dir, ['rev-parse', '--short', 'HEAD']).out;
    const remote = git(dir, ['rev-parse', '--short', `origin/${branch}`]).out;
    // Counted both ways: being ahead is not a problem to fix by pulling, and
    // saying "out of date" to someone with unpushed work would be wrong.
    const counts = git(dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]).out;
    const [ahead, behind] = counts.split(/\s+/).map((n) => parseInt(n, 10) || 0);
    const dirty = git(dir, ['status', '--porcelain']).out !== '';

    return { ...base, local, remote, ahead: ahead || 0, behind: behind || 0, dirty };
  });
});

// Pull one repo. Refuses rather than risking someone's uncommitted work.
ipcMain.handle('update-repo', async (
  _event: IpcMainInvokeEvent,
  repoId: string
): Promise<{ ok: boolean; detail: string }> => {
  const repo = repoPaths().find((r) => r.id === repoId);
  if (!repo) return { ok: false, detail: `No checkout found for ${repoId}.` };

  // A dirty tree is the case where a pull can destroy work, and it is also the
  // case where the fix is a human decision — commit, stash or discard — not
  // something to guess at.
  if (git(repo.dir, ['status', '--porcelain']).out !== '') {
    return { ok: false, detail:
      `${repo.label} has uncommitted changes. Commit or stash them first — `
      + `pulling over them could lose work.` };
  }

  const branch = git(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  // --ff-only so a divergent history stops instead of producing a merge commit
  // or a conflicted tree that the person then has to unpick by hand.
  const pulled = git(repo.dir, ['pull', '--ff-only', 'origin', branch]);
  if (pulled.code !== 0) {
    return { ok: false, detail: pulled.out.split('\n').slice(0, 4).join(' ') || 'git pull failed' };
  }

  // The GUI is TypeScript and dist/ is gitignored, so a pull on its own changes
  // nothing that actually runs. Building here rather than on every launch is
  // what lets the Windows shortcut point straight at electron.exe — and only a
  // real executable can be pinned to the Windows taskbar, which a .bat cannot.
  if (repoId === 'gui') {
    const built = runNpm(repo.dir, ['run', 'build-ts']);
    if (built.code !== 0) {
      return { ok: false, detail:
        'Updated, but the build failed, so the previous version is still what runs. '
        + built.out.split('\n').slice(0, 3).join(' ') };
    }

    // Best effort, and deliberately not fatal: the update itself succeeded, and
    // a missing desktop icon is not a reason to report it as failed.
    if (process.platform === 'win32') {
      const shortcuts = refreshWindowsShortcuts(repo.dir);
      if (!shortcuts.ok) {
        // The renderer adds the restart notice, so this must not repeat it.
        return { ok: true, detail:
          'Updated, but the Desktop and Start Menu shortcuts could not be '
          + 'refreshed — re-run install-windows.bat to get them.' };
      }
    }
  }
  return { ok: true, detail: pulled.out.split('\n')[0] || 'Updated.' };
});

// --- GitHub ----------------------------------------------------------------
//
// Creating a repo during `zeltro new` needs `gh` authenticated ON THE HOST that
// runs the command, since that is where the git operations happen. So this is
// per host, like services and the AI agent.

interface GithubStatus {
  installed: boolean;
  version?: string;
  loggedIn: boolean;
  login?: string;
  scopes?: string[];
  /** Scopes `zeltro new --github` needs that the token does not have. */
  missingScopes?: string[];
  error?: string;
}

// What creating a repository actually requires. `repo` alone covers a personal
// repo; `admin:org` is only needed for one under an organisation, so it is
// reported rather than demanded.
const GH_REQUIRED_SCOPES = ['repo'];

async function ghOn(hostId: string, command: string): Promise<CommandResult> {
  const exec = executorFor(hostId) as any;
  if (hostId === 'local') {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', command], { env: { ...process.env, NO_COLOR: '1' } });
      let out = ''; let err = '';
      child.stdout?.on('data', (d) => { out += d.toString(); });
      child.stderr?.on('data', (d) => { err += d.toString(); });
      child.on('close', (code) => resolve({ code: code ?? 1, stdout: out.trim(), stderr: err.trim() }));
      child.on('error', (e) => resolve({ code: 1, stdout: '', stderr: e.message }));
    });
  }
  if (typeof exec.execRaw !== 'function') {
    return { code: 1, stdout: '', stderr: `Cannot run commands on ${hostId}` };
  }
  return exec.execRaw(`${REMOTE_PATH_PREFIX} ${command}`);
}

ipcMain.handle('get-github-status', async (
  _event: IpcMainInvokeEvent,
  hostId: string = 'local'
): Promise<GithubStatus> => {
  const version = await ghOn(hostId, 'gh --version');
  if (version.code !== 0) {
    return { installed: false, loggedIn: false };
  }

  // JSON rather than the human output: the prose form is a formatted block with
  // ticks and indentation that changes between releases, and it goes to stderr.
  const status = await ghOn(hostId, 'gh auth status --json hosts 2>/dev/null');
  if (status.code !== 0 || !status.stdout.trim().startsWith('{')) {
    return {
      installed: true,
      version: version.stdout.split('\n')[0] || 'gh',
      loggedIn: false
    };
  }

  try {
    const parsed = JSON.parse(status.stdout);
    const accounts = Object.values(parsed.hosts || {}).flat() as any[];
    const active = accounts.find((a) => a.active) || accounts[0];
    if (!active) {
      return { installed: true, version: version.stdout.split('\n')[0] || 'gh', loggedIn: false };
    }

    const scopes = String(active.scopes || '').split(',').map((x) => x.trim()).filter(Boolean);
    return {
      installed: true,
      version: version.stdout.split('\n')[0] || 'gh',
      loggedIn: active.state === 'success',
      login: active.login,
      scopes,
      missingScopes: GH_REQUIRED_SCOPES.filter((need) => !scopes.includes(need))
    };
  } catch (error) {
    return { installed: true, loggedIn: false, error: 'Could not read gh auth status.' };
  }
});

// Authenticate with a token the user pastes in.
//
// `--with-token` reads from stdin and is the only non-interactive way in. The
// browser flow needs a terminal to show a code in and a browser on the machine
// running it — neither of which exists over SSH.
//
// The token is piped straight through and never stored here: gh writes it to
// its own config on that host, which is where anything else would look for it.
ipcMain.handle('github-login', async (
  _event: IpcMainInvokeEvent,
  hostId: string,
  token: string
): Promise<{ ok: boolean; detail: string }> => {
  if (!/^gh[pousr]_[A-Za-z0-9]{20,}$/.test(token.trim())) {
    // Checked before it is sent anywhere, so a pasted password or a truncated
    // copy fails here rather than as an opaque gh error.
    return { ok: false, detail: 'That does not look like a GitHub token. They start with ghp_, gho_, ghu_, ghs_ or ghr_.' };
  }

  const exec = executorFor(hostId) as any;
  const command = 'gh auth login --with-token';

  if (hostId === 'local') {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', command], { env: { ...process.env, NO_COLOR: '1' } });
      let err = '';
      child.stderr?.on('data', (d) => { err += d.toString(); });
      child.on('close', (code) => resolve(code === 0
        ? { ok: true, detail: 'Signed in.' }
        : { ok: false, detail: err.trim().split('\n')[0] || `gh exited ${code}` }));
      child.on('error', (e) => resolve({ ok: false, detail: e.message }));
      child.stdin?.end(token.trim() + '\n');
    });
  }

  if (typeof exec.execRawWithInput !== 'function') {
    return { ok: false, detail: `Cannot sign in on ${hostId}.` };
  }
  const result = await exec.execRawWithInput(`${REMOTE_PATH_PREFIX} ${command}`, token.trim() + '\n');
  return result.code === 0
    ? { ok: true, detail: 'Signed in.' }
    : { ok: false, detail: (result.stderr || result.stdout).split('\n')[0] || 'gh refused the token' };
});

ipcMain.handle('github-logout', async (
  _event: IpcMainInvokeEvent,
  hostId: string
): Promise<{ ok: boolean; detail: string }> => {
  const r = await ghOn(hostId, 'gh auth logout --hostname github.com');
  return r.code === 0
    ? { ok: true, detail: 'Signed out.' }
    : { ok: false, detail: (r.stderr || r.stdout).split('\n')[0] || 'gh refused' };
});

// --- Attaching files to a project ------------------------------------------
//
// Files land in <project>/uploads/ and the agent is told the path. Deliberately
// no extraction here: Claude, Codex and Gemini all read PDFs, images and
// documents themselves, and far better than a bundled parser would. Building a
// pipeline to describe a PDF would duplicate — worse — something the thing on
// the other end already does. Transport and a path is the whole job.
//
// Works for remote projects over sftp, because the file has to be next to the
// code the agent is editing, and that code is on the host.

// Dot-prefixed and Zeltro-named on purpose. A bare `uploads/` collides with
// directories projects already have — WordPress has wp-content/uploads, Laravel
// has storage/app/public/uploads — and a name that might be the project's own is
// a name someone will eventually commit, deploy or delete by mistake.
const UPLOAD_DIR = '.zeltro-uploads';

// Keep the name, drop the path and anything that could climb out of the folder.
function safeUploadName(original: string): string {
  const base = path.basename(original).replace(/[/\\]/g, '');
  return base.replace(/^\.+/, '').replace(/[\x00-\x1f]/g, '') || 'upload';
}

ipcMain.handle('attach-files', async (
  _event: IpcMainInvokeEvent,
  hostId: string,
  projectName: string,
  filePaths: string[]
): Promise<{ ok: boolean; attached: string[]; error?: string }> => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { ok: false, attached: [], error: 'No files selected.' };
  }

  try {
    if (hostId === 'local') {
      const dir = path.join(getProjectsDir(), projectName, UPLOAD_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const attached: string[] = [];
      for (const src of filePaths) {
        const name = safeUploadName(src);
        fs.copyFileSync(src, path.join(dir, name));
        attached.push(`${UPLOAD_DIR}/${name}`);
      }
      return { ok: true, attached };
    }

    // Remote: the projects directory is whatever THAT host's config says.
    const executor = executorFor(hostId) as any;
    const dirResult = await executor.exec(['projects-dir']);
    const projectsDir = (dirResult.stdout || '').trim();
    if (dirResult.code !== 0 || !projectsDir) {
      return { ok: false, attached: [], error: `Could not find the projects directory on ${hostId}.` };
    }

    const remoteDir = `${projectsDir}/${projectName}/${UPLOAD_DIR}`;
    const mk = await executor.execRaw(`mkdir -p ${JSON.stringify(remoteDir)}`);
    if (mk.code !== 0) {
      return { ok: false, attached: [], error: `Could not create ${remoteDir}: ${mk.stderr}` };
    }

    const conn = await executor.connect();
    const attached = await new Promise<string[]>((resolve, reject) => {
      conn.sftp((err: any, sftp: any) => {
        if (err) return reject(err);
        const done: string[] = [];
        const next = (i: number): void => {
          if (i >= filePaths.length) { resolve(done); return; }
          const name = safeUploadName(filePaths[i]!);
          sftp.fastPut(filePaths[i], `${remoteDir}/${name}`, (putErr: any) => {
            if (putErr) return reject(putErr);
            done.push(`${UPLOAD_DIR}/${name}`);
            next(i + 1);
          });
        };
        next(0);
      });
    });
    return { ok: true, attached };
  } catch (error) {
    return { ok: false, attached: [], error: (error as Error).message };
  }
});

// Pick files to attach. Multi-select, no extension filter: the agent decides
// what it can make sense of, and a filter here would only be a guess at that.
ipcMain.handle('choose-files', async (): Promise<string[]> => {
  const result = await dialog.showOpenDialog({
    title: 'Attach files to this project',
    properties: ['openFile', 'multiSelections'],
    buttonLabel: 'Attach'
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('get-platform-capabilities', async (): Promise<{
  platform: string; localZeltro: boolean; remoteOnly: boolean;
}> => ({
  platform: process.platform,
  localZeltro: process.platform !== 'win32' && checkZeltroStatus() === 'configured',
  remoteOnly: process.platform === 'win32'
}));

// Run `zeltro configure` on a remote host.
//
// Offered when the connection test finds Zeltro installed but unconfigured.
// It needs sudo — it writes /etc/hosts and sets up Docker networks — and sudo
// over a non-interactive ssh session cannot answer a password prompt. Hosts with
// passwordless sudo succeed; the rest get told exactly that rather than a
// timeout, because the fix is a one-off on that machine and no amount of
// retrying from here will help.
ipcMain.handle('configure-ssh-host', async (
  _event: IpcMainInvokeEvent,
  profile: SshProfile
): Promise<{ ok: boolean; detail: string }> => {
  const exec = new SshExecutor(profile);
  try {
    // -n so sudo fails immediately rather than waiting on a prompt nobody can
    // answer. Without it this hangs until the ssh timeout, and the user is told
    // "timed out" for what is really "this host needs a password".
    const probe = await exec.execRaw('sudo -n true');
    if (probe.code !== 0) {
      return { ok: false, detail:
        'That host needs a password for sudo, which cannot be answered from here. '
        + 'Run `zeltro configure` on it directly, once.' };
    }

    const result = await exec.exec(['configure', '--non-interactive', '--json-output']);
    if (result.code !== 0) {
      return { ok: false, detail: result.stderr || result.stdout || `configure exited ${result.code}` };
    }
    return { ok: true, detail: 'Configured.' };
  } finally {
    exec.dispose();
  }
});

// The renderer asks for commands by name. Rewrite the one command that is ours
// and leave everything else (docker, git) alone — those genuinely are expected
// to be on PATH, and silently rewriting them would hide a real misconfiguration.
function resolveIfZeltro(command: string, args: string[]): { command: string; args: string[] } {
  if (command !== 'zeltro') return { command, args };

  const zeltro = resolveZeltro();
  return { command: zeltro.command, args: [...zeltro.prefix, ...args] };
}

// Read a single KEY=value out of Zeltro's config. Returns null when the file is
// absent, the key is missing, or the value is empty.
function readEnvValue(key: string): string | null {
  try {
    const envPath = zeltroEnvPath();
    if (!fs.existsSync(envPath)) return null;

    const match = fs.readFileSync(envPath, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';

    return value === '' ? null : value;
  } catch (error) {
    debugLog('Failed to read Zeltro config', { key, error: (error as Error).message });
    return null;
  }
}

function checkZeltroStatus(): ZeltroStatus {
  try {
    // Resolve rather than trusting PATH. This ran a bare `zeltro`, so on any
    // launch without /usr/local/bin on PATH — a .desktop entry, or a macOS app
    // opened from Finder — it threw and the app decided Zeltro was not
    // installed, showing the installer instead of the dashboard. It is the
    // first decision the app makes, so getting it wrong replaces the whole UI.
    const zeltro = resolveZeltro();
    execSync([...[zeltro.command, ...zeltro.prefix].map((part) => `'${part}'`), 'help', '--no-colors'].join(' '),
             { stdio: 'pipe' });

    // Installed. Configured means the env file exists AND names a projects
    // directory — `zeltro configure` writes PROJECTS_DIR, and every project
    // command depends on it.
    if (!fs.existsSync(zeltroEnvPath())) {
      return 'not-configured';
    }

    return readEnvValue('PROJECTS_DIR') !== null ? 'configured' : 'not-configured';
  } catch (error) {
    return 'not-installed';
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', (): void => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', (): void => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handler for renderer console messages
ipcMain.handle('renderer-log', async (event: IpcMainInvokeEvent, ...args: any[]): Promise<void> => {
  console.log('🔥 RENDERER LOG:', ...args);
  debugLog('RENDERER LOG', args);
});

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

// IPC handlers for communicating with Zeltro CLI
ipcMain.handle('execute-zeltro-script', async (event: IpcMainInvokeEvent, scriptName: string, args: string[] = []): Promise<CommandResult> => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(ZELTRO_CLI_DIR)) {
      reject(new Error('Zeltro CLI not found'));
      return;
    }

    // Scripts live under src/scripts/, not scripts/.
    const scriptPath: string = path.join(ZELTRO_CLI_DIR, 'src', 'scripts', scriptName);

    const childProcess: ChildProcess = spawn('bash', [scriptPath, ...args], {
      cwd: ZELTRO_CLI_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' }
    });

    let stdout: string = '';
    let stderr: string = '';

    childProcess.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    childProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    childProcess.on('close', (code: number | null) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });

    childProcess.on('error', (error: Error) => {
      reject(error);
    });
  });
});

// New handler for zeltro command
// Function to refresh sudo timestamp for operations that need it
async function refreshSudoTimestamp(): Promise<boolean> {
  return new Promise((resolve) => {
    debugLog('Refreshing sudo timestamp for hosts file modification');
    
    const childProcess: ChildProcess = spawn('sudo', ['-v'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    childProcess.on('close', (code: number) => {
      if (code === 0) {
        debugLog('Sudo timestamp refreshed successfully');
        resolve(true);
      } else {
        debugLog('Failed to refresh sudo timestamp', { exitCode: code });
        resolve(false);
      }
    });
    
    childProcess.on('error', (error: Error) => {
      debugLog('Error refreshing sudo timestamp', error);
      resolve(false);
    });
  });
}

ipcMain.handle('execute-zeltro', async (event: IpcMainInvokeEvent, subcommand: string, args: string[] = []): Promise<CommandResult> => {
  return new Promise(async (resolve, reject) => {
    // Commands that modify hosts file need sudo timestamp. `install` runs
    // `zeltro setup` + `zeltro up` internally, so it needs one too.
    const sudoCommands = ['new', 'clone', 'setup', 'install'];
    if (sudoCommands.includes(subcommand)) {
      debugLog(`Command '${subcommand}' requires sudo, refreshing timestamp`);
      const sudoSuccess = await refreshSudoTimestamp();
      if (!sudoSuccess) {
        resolve({
          code: 1,
          stdout: '',
          stderr: 'Failed to authenticate for hosts file modification. Please run the command from terminal.'
        });
        return;
      }
    }
    
    // Callers own their flags. `--json-output` is NOT added here: it suppresses
    // all human-readable output including error text, so a command can fail with
    // an empty stdout. Only pass it where the caller actually parses JSON, and
    // always judge success by the exit code.
    const allArgs: string[] = [subcommand, ...args];

    // Collect a spawned process into a CommandResult. Listeners are attached to
    // the process that is actually running — the previous version re-assigned
    // the variable in the fallback path and left the listeners on the dead one,
    // so the fallback never resolved.
    const run = (command: string, commandArgs: string[]): ChildProcess => {
      const child: ChildProcess = spawn(command, commandArgs, {
        cwd: os.homedir(), // Run from user's home directory
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' }
      });

      let stdout: string = '';
      let stderr: string = '';

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', (code: number | null) => {
        debugLog('Zeltro command finished', { subcommand, args, code });
        resolve({ code: code ?? 1, stdout, stderr });
      });

      return child;
    };

    const zeltro = resolveZeltro();
    const child: ChildProcess = run(zeltro.command, [...zeltro.prefix, ...allArgs]);
    child.on('error', (error: Error) => reject(error));
  });
});

interface CatalogApp {
  slug: string;
  display: string;
  database: string;
  note: string;
}

// The app catalogue is generated by the CLI from its installers
// (src/scripts/build_catalog.sh), so it is read at runtime rather than
// duplicated here — a hardcoded copy would rot on every installer change.
ipcMain.handle('get-app-catalog', async (): Promise<{ apps: CatalogApp[]; error?: string }> => {
  const catalogPath = path.join(ZELTRO_CLI_DIR, 'src', 'catalog', 'apps.json');

  try {
    if (!fs.existsSync(catalogPath)) {
      return { apps: [], error: `App catalogue not found at ${catalogPath}` };
    }

    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const apps: CatalogApp[] = (parsed.apps ?? []).map((app: any) => ({
      slug: app.slug ?? '',
      display: app.display ?? app.slug ?? '',
      // Empty database means the app manages its own storage internally.
      database: app.database ?? '',
      note: app.note ?? ''
    })).filter((app: CatalogApp) => app.slug !== '');

    debugLog('Loaded app catalogue', { count: apps.length });
    return { apps };
  } catch (error) {
    debugLog('Failed to read app catalogue', { error: (error as Error).message });
    return { apps: [], error: (error as Error).message };
  }
});

// MinIO and Meilisearch are OPTIONAL shared services, off unless enabled per
// machine with `zeltro enable-service`. `zeltro status` reports them as
// "stopped" either way, which in the UI reads as "a service is down" rather
// than "you never turned this on" — so the GUI filters them by what is actually
// enabled in OPTIONAL_SERVICES.
interface CatalogFramework {
  slug: string;
  display: string;
  runtime: string;
  databases: string[];
  note: string;
}

// Read at runtime for the same reason as the app catalogue: frameworks.json is
// the CLI's authority on which engines each framework ACTUALLY works with, and
// a copy here would drift. The GUI previously hardcoded three of the thirteen
// and sent `--database mysql` for all of them.
// Shared by the local and remote paths so the two cannot shape the same data
// differently — a remote framework list that quietly lost its `databases` array
// would offer engines the host does not support.
function normaliseFrameworks(parsed: any): CatalogFramework[] {
  return (parsed.frameworks ?? []).map((fw: any) => ({
    slug: fw.slug ?? '',
    display: fw.display ?? fw.slug ?? '',
    runtime: fw.runtime ?? '',
    // An empty/absent list means every engine is fine.
    databases: Array.isArray(fw.databases) ? fw.databases : [],
    note: fw.note ?? ''
  })).filter((fw: CatalogFramework) => fw.slug !== '');
}

// Read a catalogue file from whichever host will run the command.
//
// Frameworks and apps come from the CLI install, so a remote host's list is
// whatever ITS CLI ships — not this machine's. Reading the local copy and
// offering it for a remote create would present frameworks that host may not
// have, and the failure would arrive at creation time.
//
// The install directory is derived from the zeltro symlink rather than assumed:
// script installs put it under /usr/local/share/zeltro-cli, the .deb under
// /opt/zeltro-cli, and `readlink -f` on the binary resolves either.
async function readRemoteCatalog(hostId: string, file: string): Promise<string | null> {
  const exec = executorFor(hostId) as any;
  if (typeof exec.execRaw !== 'function') return null;

  const result = await exec.execRaw(
    `d=$(dirname "$(dirname "$(readlink -f /usr/local/bin/zeltro 2>/dev/null || readlink -f /usr/bin/zeltro)")")`
    + `; cat "$d/src/catalog/${file}" 2>/dev/null || cat "$d/catalog/${file}" 2>/dev/null`);

  return result.code === 0 && result.stdout.trim().startsWith('{') ? result.stdout : null;
}

ipcMain.handle('get-framework-catalog', async (
  _event: IpcMainInvokeEvent,
  hostId: string = 'local'
): Promise<{ frameworks: CatalogFramework[]; error?: string }> => {
  if (hostId !== 'local') {
    const raw = await readRemoteCatalog(hostId, 'frameworks.json');
    if (!raw) {
      return { frameworks: [], error: `Could not read the framework catalogue from ${hostId}.` };
    }
    try {
      const parsed = JSON.parse(raw);
      return { frameworks: normaliseFrameworks(parsed) };
    } catch (error) {
      return { frameworks: [], error: `Framework catalogue from ${hostId} did not parse.` };
    }
  }

  const catalogPath = path.join(ZELTRO_CLI_DIR, 'src', 'catalog', 'frameworks.json');

  try {
    if (!fs.existsSync(catalogPath)) {
      return { frameworks: [], error: `Framework catalogue not found at ${catalogPath}` };
    }

    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const frameworks = normaliseFrameworks(parsed);

    debugLog('Loaded framework catalogue', { count: frameworks.length });
    return { frameworks };
  } catch (error) {
    debugLog('Failed to read framework catalogue', { error: (error as Error).message });
    return { frameworks: [], error: (error as Error).message };
  }
});

// What the INSTALLED CLI actually supports, probed once.
//
// The cheap-models work lives on zeltro-cli `dev` and is not on its `master`,
// so a current install has no qwen and stores `--api-base none` as a literal
// string. Offering qwen there produces an agent the CLI rejects. Rather than
// couple the GUI's release to the CLI's, ask the CLI what it can do.
let cliCapabilities: { qwen: boolean; clearableEndpoint: boolean; unattended: boolean } | null = null;

ipcMain.handle('get-cli-capabilities', async (): Promise<{ qwen: boolean; clearableEndpoint: boolean; unattended: boolean }> => {
  if (cliCapabilities) return cliCapabilities;

  const help = await runZeltro(['ai-set', '--help']);
  const text = help.stdout + help.stderr;

  cliCapabilities = {
    qwen: /\bqwen\b/.test(text),
    // Same commit added both, so qwen is a reliable proxy for "endpoint clearing
    // works" — on older CLIs `none` is stored verbatim.
    clearableEndpoint: /\bqwen\b/.test(text),
    // Offering a control the installed CLI cannot honour would silently do
    // nothing — worse here than elsewhere, since the user would believe they
    // had changed how much the agent is allowed to do on its own.
    unattended: /--allow-unattended/.test(text)
  };

  debugLog('CLI capabilities', cliCapabilities);
  return cliCapabilities;
});

// Does a freshly installed project actually serve anything?
//
// `zeltro install` exits 0 even when its readiness retries are exhausted — it
// prints "returned HTTP 000 — it may still be initializing" and gives up, which
// is the right call for a CLI that cannot wait forever. The GUI was reading only
// the exit code, so a crash-looping app produced a green "installed" toast and a
// URL that had never served a request. Ask the app directly instead.
// Two callers with genuinely different patience, so the timeout is a parameter
// rather than a constant:
//
//   install verification — slow is expected and worth waiting for
//   a clicked link       — the user is waiting, and fast-wrong beats frozen
//
// The failure that makes this matter is a dropped SYN with no RST, which is what
// a cloud security group does. Measured: an unroutable address errors in 7ms and
// bad DNS in 11ms, but a security-group-blocked port runs the timeout out in
// full. Only the blocked case is slow, and it is the common one for a cloud host.
//
// `address` is a hostname for a local project and host:port for a remote one.
ipcMain.handle('check-project-url', async (
  _event: IpcMainInvokeEvent,
  address: string,
  timeoutMs: number = 6000
): Promise<{ code: number; timedOut?: boolean }> => {
  return new Promise((resolve) => {
    const request = http.get(`http://${address}/`, { timeout: timeoutMs }, (res) => {
      // Any response at all is the answer; the body is irrelevant.
      res.resume();
      resolve({ code: res.statusCode ?? 0 });
    });

    // 0 mirrors curl's "no response" convention, which is what the CLI prints.
    request.on('error', () => resolve({ code: 0 }));
    // Distinguished from a refusal on purpose. "Nothing answered in 2.5s" and
    // "the network said no" are different facts, and only one of them justifies
    // telling someone their security group needs a rule.
    request.on('timeout', () => {
      request.destroy();
      resolve({ code: 0, timedOut: true });
    });
  });
});

// Ollama exposes what the user has actually pulled. Turning the hardest step of
// a local setup — "type the exact model tag" — into a picker is most of the value
// of the local presets. Fails quietly to free text when Ollama is not running.
// What models an endpoint offers.
//
// Generalised from an Ollama-only lookup, which could not reach anything else:
// it spoke only /api/tags and used the http module, so every https endpoint
// failed silently and the field fell back to free text.
//
// Two shapes cover nearly everything:
//   /api/tags    Ollama's own, no key
//   /v1/models   the OpenAI-compatible shape, which OpenRouter, LM Studio,
//                vLLM, llama.cpp, Groq, Together and OpenAI itself all serve
//
// Measured: OpenRouter answers /v1/models with 414 models and NO key, so a
// custom-endpoint setup gets a real list without anyone pasting a secret.
// api.anthropic.com returns 401 without one, which is why the key is sent when
// there is one to send.
function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 4000): Promise<any> {
  return new Promise((resolve) => {
    let mod: typeof http | typeof https;
    try {
      mod = new URL(url).protocol === 'https:' ? https : http;
    } catch {
      return resolve(null);      // not a URL at all
    }

    const request = mod.get(url, { timeout: timeoutMs, headers }, (res: any) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}

ipcMain.handle('list-models', async (
  _event: IpcMainInvokeEvent,
  baseUrl: string,
  apiKey: string = ''
): Promise<{ models: string[]; source: string }> => {
  const base = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  // The agent endpoint is .../v1; Ollama's tags API sits at the host root.
  const root = base.replace(/\/v1$/, '');

  // Ollama first: it is the only one that needs no key and no guessing.
  const tags = await fetchJson(`${root}/api/tags`, {}, 1500);
  if (tags && Array.isArray(tags.models)) {
    const models = tags.models
      .map((m: any) => m.name)
      .filter((n: any) => typeof n === 'string' && n !== '');
    if (models.length > 0) return { models, source: 'ollama' };
  }

  // Anthropic authenticates with x-api-key and a version header rather than a
  // bearer token, so sending Authorization would just 401.
  const isAnthropic = /anthropic\.com/.test(base);
  const headers: Record<string, string> = {};
  if (apiKey) {
    if (isAnthropic) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  const v1 = base.endsWith('/v1') ? `${base}/models` : `${root}/v1/models`;
  const listed = await fetchJson(v1, headers);
  if (listed && Array.isArray(listed.data)) {
    const models = listed.data
      .map((m: any) => m.id)
      .filter((n: any) => typeof n === 'string' && n !== '')
      .sort();
    if (models.length > 0) return { models, source: 'openai-compatible' };
  }

  return { models: [], source: 'none' };
});

// Qwen Code wants Node 22+. It installs on 20 with an EBADENGINE warning, which
// is unsupported — and the GUI's own installers pin 20 as the floor, so the app
// can end up offering an agent this machine cannot properly run.
ipcMain.handle('get-node-major', async (): Promise<number> => {
  try {
    // Bare `node` fails on a macOS GUI launch when node came from Homebrew:
    // /opt/homebrew/bin is added by ~/.zprofile, which Finder does not source.
    // It failed quietly, returning 0, which silently suppressed the Node
    // version warning for qwen rather than showing a wrong one.
    const nodeBin = resolveBinary('node');
    if (!nodeBin) return 0;
    const out = execSync(`'${nodeBin}' -v`, { encoding: 'utf8' }).trim();
    return parseInt(out.replace(/^v/, '').split('.')[0] || '0', 10);
  } catch (error) {
    return 0;
  }
});

// CLI version, for the lock-step check. A dedicated command rather than reading
// it off `status`, which touches Docker and can be slow — this is just a string.
// Returns 'unknown' on an older CLI that has no version command at all, which is
// distinguishable from a real version and means "too old to say".
ipcMain.handle('get-cli-version', async (): Promise<string> => {
  const result = await runZeltro(['version', '--json-output']);
  if (result.code !== 0) return 'unknown';

  try {
    return JSON.parse(result.stdout).version || 'unknown';
  } catch (error) {
    return 'unknown';
  }
});

// `app.getVersion()` only returns the app's own version when the app is
// packaged. Run unpackaged — which is every `npm run dev` and every e2e run —
// Electron returns *its* version instead, so the lock-step check compared
// "1.0.0-beta.1" against "28.3.3" and showed a mismatch banner permanently.
// package.json is the single source of truth for the version, so read it.
ipcMain.handle('get-gui-version', async (): Promise<string> => {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    if (version) return version;
  } catch {
    // Packaged builds resolve it fine through Electron.
  }
  return app.getVersion();
});

ipcMain.handle('get-projects-dir', async (): Promise<string> => getProjectsDir());

ipcMain.handle('get-optional-services', async (): Promise<string[]> => {
  const raw = readEnvValue('OPTIONAL_SERVICES');
  if (!raw) return [];

  return raw
    .split(/[\s,]+/)
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
});

// The CLI's own service listing, which it generates from the same catalogue it
// validates against. Replaces a copy that lived in the GUI: the copy existed
// only because `enable-service` had no machine-readable output, and it drifted
// the moment the CLI grew from two services to nine.
ipcMain.handle('get-service-catalog', async (
  _event: IpcMainInvokeEvent,
  hostId: string = 'local'
): Promise<{
  always_on: string[];
  services: Array<{ slug: string; group: string; description: string; address: string; state: string }>;
  error?: string;
}> => {
  // From the host being managed. A remote CLI may support a different set, and
  // rendering this machine's list for another machine would offer services it
  // does not have — the failure arriving at enable time.
  const result = await executorFor(hostId).exec(['enable-service', '--json-output']);

  try {
    const parsed = JSON.parse(result.stdout || '{}');
    if (!Array.isArray(parsed.services)) {
      // An older CLI prints usage text here rather than JSON. Say so instead of
      // rendering an empty manager that looks like "no services exist".
      return { always_on: [], services: [], error: 'This Zeltro CLI has no machine-readable service listing.' };
    }
    return { always_on: parsed.always_on || [], services: parsed.services };
  } catch (error) {
    return { always_on: [], services: [], error: 'Could not read the service listing from the CLI.' };
  }
});

// Does this text name the host somewhere other than a comment?
//
// Found for real on a remote box: a compose comment reading "still resolved
// zeltro-mariadb ... by name" made the guard report a project as depending on
// MariaDB, which would have blocked disabling a service nothing used.
function mentionedOutsideAComment(body: string, host: string): boolean {
  return body.split('\n').some((line) => {
    const at = line.indexOf(host);
    if (at === -1) return false;
    const hash = line.indexOf('#');
    return hash === -1 || at < hash;
  });
}

// The service hostnames a project's compose file would name if it used them.
// Shared by the local scan and the remote grep so the two cannot disagree about
// what "in use" means.
// Both prefixes, deliberately.
//
// The rename moved these to zeltro-*, and that silently broke the guard: the
// containers on an upgraded machine are still podium-* (the CLI pins
// COMPOSE_PROJECT_NAME so the shared network keeps its name and existing
// projects are not orphaned), and every project .env still says
// DB_HOST=podium-mariadb. Twelve projects here reference the old hostname, so
// the guard matched none of them and would have let someone disable a database
// all twelve depend on — which is exactly the bug this guard exists to prevent,
// reintroduced by a find-and-replace.
const SERVICE_HOSTNAME_PREFIXES = ['zeltro', 'podium'];

function serviceHostnames(service: string): string[] {
  const suffix = SERVICE_HOSTNAMES[service];
  if (!suffix) return [];
  const bare = suffix.replace(/^(zeltro|podium)-/, '');
  return SERVICE_HOSTNAME_PREFIXES.map((prefix) => `${prefix}-${bare}`);
}

const SERVICE_HOSTNAMES: Record<string, string> = {
  mysql: 'zeltro-mariadb',
  postgres: 'zeltro-postgres',
  mongo: 'zeltro-mongo',
  minio: 'zeltro-minio',
  meilisearch: 'zeltro-meilisearch'
};

// Same question as the local scan, asked over SSH. One grep per service across
// the remote projects directory rather than a round trip per project — the
// dashboard polls, and per-project round trips would multiply by project count.
async function servicesInUseRemote(hostId: string): Promise<Record<string, string[]>> {
  const exec = executorFor(hostId) as any;
  if (typeof exec.execRaw !== 'function') return {};

  const dirResult = await exec.exec(['projects-dir']);
  const dir = (dirResult.stdout || '').trim();
  if (dirResult.code !== 0 || !dir) return {};

  const inUse: Record<string, string[]> = {};
  for (const [service, hostname] of Object.entries(SERVICE_HOSTNAMES)) {
    // `^[^#]*` refuses to cross a #, so a hostname mentioned in a comment does
    // not count. Found for real: a compose file whose comment reads "still
    // resolved zeltro-mariadb ... by name" was reported as a project depending
    // on MariaDB, which would have blocked disabling a service nothing used.
    const alternation = serviceHostnames(service).join('|');
    const r = await exec.execRaw(
      `grep -rlE '^[^#]*(${alternation})' '${dir}'/*/.env '${dir}'/*/docker-compose.y*ml 2>/dev/null | head -50`);
    if (r.code !== 0 || !r.stdout.trim()) continue;
    const names: string[] = r.stdout.trim().split('\n')
      .map((line: string) => line.split('/').slice(-2)[0] || '')
      .filter((n: string) => n !== '');
    // .env and docker-compose.yaml both match for the same project.
    inUse[service] = Array.from(new Set(names));
  }
  return inUse;
}

// Which shared services a project actually depends on.
//
// Disabling a database a project is using leaves it unable to connect, and
// nothing in the CLI stops that today. The compose files name the service
// hostnames directly (DB_HOST: zeltro-mariadb and friends), so ask them rather
// than inferring from the framework or trusting metadata.
ipcMain.handle('get-services-in-use', async (
  _event: IpcMainInvokeEvent,
  hostId: string = 'local'
): Promise<Record<string, string[]>> => {
  // Which projects depend on which service, on the host being managed.
  //
  // Remote hosts are asked over SSH rather than scanned locally: the projects
  // that matter are the ones on THAT machine, and reading this machine's
  // compose files would guard the wrong set — potentially letting someone
  // disable a database a remote project is using while blocking one nothing
  // uses.
  if (hostId !== 'local') return servicesInUseRemote(hostId);

  const inUse: Record<string, string[]> = {};
  const hosts = SERVICE_HOSTNAMES;

  try {
    const dir = getProjectsDir();
    if (!fs.existsSync(dir)) return inUse;

    for (const project of fs.readdirSync(dir)) {
      const compose = composePathFor(project);
      if (!compose) continue;

      // Read .env as well as the compose file. A Laravel project names its
      // database in .env (DB_HOST=zeltro-mariadb) and not in compose at all, so
      // scanning compose alone found nothing on this machine — 12 of 15 local
      // projects declare DB_HOST there and every one was missed.
      let body = '';
      for (const file of [compose, path.join(path.dirname(compose), '.env')]) {
        try { body += fs.readFileSync(file, 'utf8') + '\n'; } catch { /* absent is fine */ }
      }
      if (!body) continue;

      for (const service of Object.keys(hosts)) {
        if (serviceHostnames(service).some((h) => mentionedOutsideAComment(body, h))) {
          (inUse[service] ||= []).push(project);
        }
      }
    }
  } catch (error) {
    debugLog('Could not scan projects for service use', error);
  }

  return inUse;
});

// ---------------------------------------------------------------------------
// Embedded terminal (phase 3 of create)
//
// The build hand-off is a genuinely interactive agent session — it asks
// clarifying questions and expects answers. Streaming a one-off would lose
// that, so the GUI hosts a real pty and lets `zeltro ai` run in it exactly as
// it would in a terminal.
// ---------------------------------------------------------------------------

const ptySessions = new Map<string, any>();

ipcMain.handle('pty-start', async (
  event: IpcMainInvokeEvent,
  sessionId: string,
  cwd: string,
  command: string,
  args: string[] = []
): Promise<{ ok: boolean; error?: string }> => {
  try {
    // Required lazily: node-pty is a native module, and a machine where the
    // rebuild did not run should degrade to "open a terminal yourself" rather
    // than taking the whole app down at startup.
    const pty = require('node-pty');

    if (ptySessions.has(sessionId)) {
      ptySessions.get(sessionId).kill();
      ptySessions.delete(sessionId);
    }

    const resolved = resolveIfZeltro(command, args);
    const shell = pty.spawn(resolved.command, resolved.args, {
      name: 'xterm-color',
      cols: 100,
      rows: 28,
      cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    shell.onData((data: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('pty-data', { sessionId, data });
      }
    });

    shell.onExit(({ exitCode }: { exitCode: number }) => {
      ptySessions.delete(sessionId);
      if (!event.sender.isDestroyed()) {
        event.sender.send('pty-exit', { sessionId, exitCode });
      }
    });

    ptySessions.set(sessionId, shell);
    debugLog('Started pty session', { sessionId, command, args, cwd });
    return { ok: true };
  } catch (error) {
    debugLog('Failed to start pty', { sessionId, error: (error as Error).message });
    return { ok: false, error: (error as Error).message };
  }
});

// A pty on a remote host, for an agent session on a remote project.
//
// Shawn's decision: a remote project runs its agent remotely. That is the only
// coherent option — `zeltro resume` cds into the project directory and starts
// the agent there, so the files, the container and the agent all live on the
// same machine. Running the agent locally would mean an agent editing a
// directory that does not exist here.
//
// It follows that the agent's own install and API key live on that host too.
// The AI settings panel therefore configures a host, not the app.
//
// Registered in the same ptySessions map as local ones, behind a uniform
// write/resize/kill shape, so the renderer's session registry needs no idea
// which kind it holds.
ipcMain.handle('pty-start-on', async (
  event: IpcMainInvokeEvent,
  hostId: string,
  sessionId: string,
  cwd: string,
  command: string,
  args: string[] = []
): Promise<{ ok: boolean; error?: string }> => {
  if (hostId === 'local') {
    const local = ipcMain as any;
    return local._invokeHandlers.get('pty-start')(event, sessionId, cwd, command, args);
  }

  const executor = executorFor(hostId) as any;
  if (typeof executor.openPty !== 'function') {
    return { ok: false, error: `Host ${hostId} cannot open a terminal.` };
  }

  try {
    const stream = await executor.openPty(cwd, command, args);

    stream.on('data', (d: Buffer) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('pty-data', { sessionId, data: d.toString() });
      }
    });
    stream.on('close', (code: number) => {
      ptySessions.delete(sessionId);
      if (!event.sender.isDestroyed()) {
        event.sender.send('pty-exit', { sessionId, exitCode: code ?? 0 });
      }
    });

    // Adapted to the same shape node-pty exposes, so pty-input, pty-resize and
    // pty-kill work on either kind without knowing the difference.
    ptySessions.set(sessionId, {
      write: (data: string) => stream.write(data),
      resize: (cols: number, rows: number) => stream.setWindow(rows, cols, 0, 0),
      kill: () => { try { stream.signal('KILL'); } catch { /* best effort */ } stream.end(); }
    });

    debugLog('Started remote pty session', { sessionId, hostId, command, args, cwd });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
});

ipcMain.handle('pty-input', async (event: IpcMainInvokeEvent, sessionId: string, data: string): Promise<void> => {
  ptySessions.get(sessionId)?.write(data);
});

ipcMain.handle('pty-resize', async (event: IpcMainInvokeEvent, sessionId: string, cols: number, rows: number): Promise<void> => {
  try {
    ptySessions.get(sessionId)?.resize(cols, rows);
  } catch (error) {
    // A resize racing process exit is not worth surfacing.
  }
});

ipcMain.handle('pty-kill', async (event: IpcMainInvokeEvent, sessionId: string): Promise<void> => {
  const session = ptySessions.get(sessionId);
  if (session) {
    try { session.kill(); } catch (error) { /* already gone */ }
    ptySessions.delete(sessionId);
  }
});

interface ClassifyCandidate {
  kind: 'app' | 'framework';
  slug: string;
  display: string;
  reason: string;
  database?: string;      // apps: fixed by the installer ("" = self-contained)
  databases?: string[];   // frameworks: the engines this one actually supports
}

// Cached after the first successful probe; the CLI does not change mid-session.
let classifyOnlySupported = false;

interface Classification {
  status: 'success' | 'error';
  message?: string;
  project_name: string | null;
  recommended: 'app' | 'framework';
  customization_requested: boolean;
  database?: { slug: string; reason: string } | null;
  candidates: ClassifyCandidate[];
}

// Phase 1 of `zeltro create`, on its own. The CLI works out which stack fits and
// returns JSON; the GUI renders the choices natively instead of the terminal
// menus, then drives phase 2 with `zeltro install` / `zeltro new` directly.
//
// Deliberately NOT `zeltro create` in one shot: that presents interactive menus
// a GUI cannot answer, and its non-interactive path silently takes the top
// recommendation — which discards the user's choice, the whole point of asking.
ipcMain.handle('classify-idea', async (event: IpcMainInvokeEvent, idea: string): Promise<Classification> => {
  const failure = (message: string): Classification => ({
    status: 'error',
    message,
    project_name: null,
    recommended: 'framework',
    customization_requested: true,
    candidates: []
  });

  if (!idea || idea.trim() === '') {
    return failure('Describe what you want to build first.');
  }

  // Confirm the CLI actually supports --classify-only before using it.
  //
  // This is not defensive padding. A CLI predating the flag does not reject it:
  // it falls through to an ordinary `zeltro create --json-output`, which is
  // non-interactive, auto-picks the top recommendation and BUILDS THE PROJECT.
  // Observed on a machine running an older CLI — asking it to classify an idea
  // installed Gitea. The GUI and CLI ship separately, so this drift is normal
  // and has to be caught before the command runs, not after.
  if (!classifyOnlySupported) {
    const help = await runZeltro(['create', '--help']);
    if (!/--classify-only/.test(help.stdout + help.stderr)) {
      return failure(
        'This Zeltro CLI is too old to classify an idea safely — it has no ' +
        '--classify-only flag, and running create would build a project ' +
        'straight away. Update the CLI, then try again.'
      );
    }
    classifyOnlySupported = true;
  }

  // Classification is an AI round-trip — tens of seconds is normal.
  const result = await runZeltro(['create', '--classify-only', '--json-output', idea.trim()]);

  // Judge by exit code, never by whether the output happens to parse.
  if (result.code !== 0) {
    try {
      const parsed = JSON.parse(result.stdout || '{}');
      if (parsed.message) return failure(parsed.message);
    } catch (error) {
      // fall through to the generic message
    }
    return failure(result.stderr || 'Could not work out a stack for that description.');
  }

  try {
    const parsed = JSON.parse(result.stdout);
    debugLog('Classified idea', { idea, candidates: parsed.candidates?.length });
    return parsed as Classification;
  } catch (error) {
    return failure('The classifier returned something unreadable.');
  }
});

// `zeltro create` is meaningless without an AI agent, and AI_AGENT is empty on a
// fresh install. ai-set reports it as JSON (its own --help documents this), so
// there is no need to read the env file.
// Full ai-set state, for the settings panel.
ipcMain.handle('get-ai-agent-full', async (): Promise<any> => {
  const result = await runZeltro(['ai-set', '--json-output']);
  if (result.code !== 0) return { agent: '', model: '', api_base: '', has_api_key: false };
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return { agent: '', model: '', api_base: '', has_api_key: false };
  }
});

ipcMain.handle('get-ai-agent', async (
  _event: IpcMainInvokeEvent,
  hostId: string = 'local'
): Promise<{ agent: string; model: string }> => {
  // From the host the agent will RUN on. A remote project's agent runs
  // remotely, with that machine's install and its own API key, so asking this
  // machine whether an agent is configured would answer about the wrong one —
  // and would block or allow the session on the wrong evidence.
  const result = await executorFor(hostId).exec(['ai-set', '--json-output']);

  if (result.code !== 0) return { agent: '', model: '' };

  try {
    const parsed = JSON.parse(result.stdout);
    // Unconfigured is reported as "" rather than null.
    return { agent: parsed.agent || '', model: parsed.model || '' };
  } catch (error) {
    return { agent: '', model: '' };
  }
});

// Installing writes to /etc/hosts (via setup + up), so the renderer asks for a
// sudo timestamp before starting the streamed command.
ipcMain.handle('ensure-sudo', async (): Promise<boolean> => {
  return refreshSudoTimestamp();
});

interface ProjectStatusResult {
  error?: string;
}

ipcMain.handle('get-project-status', async (): Promise<ProjectStatusResult> => {
  try {
    const result = await ipcMain.emit('execute-zeltro-script', null, 'status.sh');
    return { error: 'Not implemented' }; // This function needs proper implementation
  } catch (error) {
    return { error: (error as Error).message };
  }
});

ipcMain.handle('select-zeltro-directory', async (): Promise<string | null> => {
  if (!mainWindow) return null;
  
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Zeltro CLI Directory'
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0] || null;
  }
  
  return null;
});

interface ExecuteCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  [key: string]: any;
}

// Execute arbitrary commands (needed for Docker checks, etc.)
ipcMain.handle('execute-command', async (event: IpcMainInvokeEvent, command: string, args: string[] = [], options: ExecuteCommandOptions = {}): Promise<CommandResult> => {
  return new Promise((resolve, reject) => {
    debugLog('Executing command', { command, args, options });

    const resolved = resolveIfZeltro(command, args);
    const process: ChildProcess = spawn(resolved.command, resolved.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    });

    let stdout: string = '';
    let stderr: string = '';

    process.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    process.on('close', (code: number | null) => {
      const result: CommandResult = { code: code ?? 1, stdout, stderr };
      debugLog('Command completed', { command, result });
      resolve(result);
    });

    process.on('error', (error: Error) => {
      debugLog('Command error', { command, error: error.message });
      reject(error);
    });
  });
});

interface StreamCommandResult {
  success: boolean;
  code: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

ipcMain.handle('execute-command-stream', async (event: IpcMainInvokeEvent, command: string, args: string[] = [], options: ExecuteCommandOptions = {}): Promise<StreamCommandResult> => {
  return new Promise((resolve, reject) => {
    debugLog('Executing command stream', { command, args, options });
    
    // Create temp file for progress tracking
    const tempFile = `/tmp/zeltro-progress-${Date.now()}.log`;
    
    const resolved = resolveIfZeltro(command, args);
    const childProcess: ChildProcess = spawn(resolved.command, resolved.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
      ...options
    });

    let stdout: string = '';
    let stderr: string = '';
    let progressBuffer: string = '';

    // Stream stdout data to renderer in real-time
    childProcess.stdout?.on('data', (data: Buffer) => {
      const output: string = data.toString('utf8');
      stdout += output;
      progressBuffer += output;
      
      console.log('STDOUT:', output);
      debugLog('Command stdout', { command, output });
      
      // Write raw output to temp file for progress parsing
      require('fs').appendFileSync(tempFile, output);
      
      // Parse Docker progress from buffer
      const progressInfo = parseDockerProgress(progressBuffer);
      if (progressInfo) {
        event.sender.send('command-stream-progress', {
          command: command,
          progress: progressInfo
        });
        // Clear processed lines from buffer
        progressBuffer = progressBuffer.split('\n').slice(-5).join('\n'); // Keep last 5 lines
      }
      
      // Send streaming data to renderer process
      event.sender.send('command-stream-data', {
        type: 'stdout',
        data: output,
        command: command
      });
    });

    childProcess.stderr?.on('data', (data: Buffer) => {
      const output: string = data.toString('utf8');
      stderr += output;
      console.log('STDERR:', output);
      debugLog('Command stderr', { command, output });
      
      // Write stderr to temp file too (Docker sometimes outputs progress to stderr)
      require('fs').appendFileSync(tempFile, output);
      
      // Send streaming data to renderer process
      event.sender.send('command-stream-data', {
        type: 'stderr',
        data: output,
        command: command
      });
    });

    childProcess.on('close', (code: number | null) => {
      const result: StreamCommandResult = { 
        success: code === 0,
        code: code ?? 1,
        exitCode: code ?? 1,
        stdout,
        stderr
      };
      console.log('Process exited with code:', code);
      debugLog('Command completed', { command, result });
      
      // Clean up temp file
      try {
        require('fs').unlinkSync(tempFile);
      } catch (err) {
        console.warn('Could not clean up temp file:', tempFile);
      }
      
      // Send completion event to renderer
      event.sender.send('command-stream-complete', {
        command: command,
        result: result
      });
      
      resolve(result);
    });

    childProcess.on('error', (error: Error) => {
      console.error('Process error:', error);
      debugLog('Command error', { command, error: error.message });
      
      // Clean up temp file
      try {
        require('fs').unlinkSync(tempFile);
      } catch (err) {
        console.warn('Could not clean up temp file:', tempFile);
      }
      
      // Send error event to renderer
      event.sender.send('command-stream-error', {
        command: command,
        error: error.message
      });
      
      reject(error);
    });
  });
});

// Parse Docker progress from output buffer
function parseDockerProgress(buffer: string): any {
  const lines = buffer.split('\n');
  let latestProgress: any = null;
  
  for (const line of lines) {
    // Remove ANSI escape sequences
    const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
    
    // Parse Docker download progress: "Downloading [=====>     ] 45.2MB/89.1MB"
    const downloadMatch = cleanLine.match(/Downloading\s+\[([=>\s]+)\]\s+([0-9.]+[KMGT]?B)\/([0-9.]+[KMGT]?B)/);
    if (downloadMatch && downloadMatch[2] && downloadMatch[3]) {
      const [, progressBar, downloaded, total] = downloadMatch;
      const percentage = Math.round((parseSize(downloaded) / parseSize(total)) * 100);
      latestProgress = {
        type: 'download',
        percentage: Math.min(percentage, 100),
        downloaded,
        total,
        message: `Downloading images: ${percentage}% (${downloaded}/${total})`
      };
    }
    
    // Parse Docker extraction progress: "Extracting [=====>     ] 45.2MB/89.1MB"
    const extractMatch = cleanLine.match(/Extracting\s+\[([=>\s]+)\]\s+([0-9.]+[KMGT]?B)\/([0-9.]+[KMGT]?B)/);
    if (extractMatch && extractMatch[2] && extractMatch[3]) {
      const [, progressBar, extracted, total] = extractMatch;
      const percentage = Math.round((parseSize(extracted) / parseSize(total)) * 100);
      latestProgress = {
        type: 'extract',
        percentage: Math.min(percentage, 100),
        extracted,
        total,
        message: `Extracting images: ${percentage}% (${extracted}/${total})`
      };
    }
    
    // Parse "Pull complete" messages
    if (cleanLine.includes('Pull complete')) {
      latestProgress = {
        type: 'complete',
        percentage: 100,
        message: 'Image download complete'
      };
    }
    
    // Parse "Pulling from" messages
    const pullingMatch = cleanLine.match(/Pulling from (.+)/);
    if (pullingMatch && pullingMatch[1]) {
      const imageName = pullingMatch[1].split('/').pop() || pullingMatch[1];
      latestProgress = {
        type: 'pulling',
        percentage: 0,
        imageName,
        message: `Pulling ${imageName}...`
      };
    }
  }
  
  return latestProgress;
}

// Helper function to parse size strings like "45.2MB" to bytes
function parseSize(sizeStr: string): number {
  const match = sizeStr.match(/([0-9.]+)([KMGT]?B)/);
  if (!match || !match[1]) return 0;
  
  const [, num, unit] = match;
  const size = parseFloat(num);
  
  switch (unit) {
    case 'TB': return size * 1024 * 1024 * 1024 * 1024;
    case 'GB': return size * 1024 * 1024 * 1024;
    case 'MB': return size * 1024 * 1024;
    case 'KB': return size * 1024;
    default: return size;
  }
}

interface SelectDirectoryOptions {
  title?: string;
  defaultPath?: string;
}

ipcMain.handle('select-directory', async (event: IpcMainInvokeEvent, options: SelectDirectoryOptions = {}): Promise<string | null> => {
  if (!mainWindow) return null;
  
  const dialogOptions: Electron.OpenDialogOptions = {
    properties: ['openDirectory'],
    title: options.title || 'Select Directory'
  };
  
  if (options.defaultPath) {
    dialogOptions.defaultPath = options.defaultPath;
  }
  
  const result = await dialog.showOpenDialog(mainWindow, dialogOptions);
  
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0] || null;
  }
  
  return null;
});

// Handler for getting home directory
ipcMain.handle('get-home-directory', async (): Promise<string> => {
  const homeDir = os.homedir();
  debugLog('Get home directory request', { homeDir });
  return homeDir;
});

// Handler for showing directory dialog (alias for select-directory)
ipcMain.handle('show-directory-dialog', async (event: IpcMainInvokeEvent, options: SelectDirectoryOptions = {}): Promise<{ filePaths: string[] } | null> => {
  debugLog('Show directory dialog request', { options, mainWindowExists: !!mainWindow });
  
  if (!mainWindow) {
    debugLog('Show directory dialog failed - no main window');
    return null;
  }
  
  const dialogOptions: Electron.OpenDialogOptions = {
    properties: ['openDirectory'],
    title: options.title || 'Select Projects Directory'
  };
  
  if (options.defaultPath) {
    dialogOptions.defaultPath = options.defaultPath;
  }
  
  debugLog('Opening directory dialog with options', dialogOptions);
  
  try {
    const result = await dialog.showOpenDialog(mainWindow, dialogOptions);
    debugLog('Directory dialog result', { canceled: result.canceled, filePaths: result.filePaths });
    
    if (!result.canceled) {
      return { filePaths: result.filePaths };
    }
    
    return null;
  } catch (error) {
    debugLog('Directory dialog error', { error: (error as Error).message });
    throw error;
  }
});

interface ProjectMetadata {
  display_name: string;
  description: string;
  emoji: string;
  // Written by the CLI, never by the GUI. ISO-8601 UTC, stamped on both start
  // and stop so it means "last time this was up" rather than "last time
  // somebody started it" — the latter sorts a project that ran for a week and
  // stopped yesterday into the wrong place. Absent on projects that have not
  // been started or stopped since the CLI began writing it; there is no
  // backfill, and inventing a timestamp would be worse than an absent one.
  // Optional because the GUI's write path never supplies it.
  last_on?: string;
  // Parked, not deleted. Written by `zeltro disable` / `zeltro enable`.
  // ONLY the exact string "disabled" disables — missing, empty or anything
  // unrecognised means enabled, so a project can never become unusable
  // because a read returned something unexpected.
  status?: string;
}

// Resolve the projects directory from Zeltro's own config rather than guessing
// at a list of candidate paths. `zeltro projects-dir` prints the same value.
// The projects directory on a given host. `zeltro projects-dir` prints it, and
// a remote host's is whatever ITS config says — not this machine's.
ipcMain.handle('get-projects-dir-on', async (
  _event: IpcMainInvokeEvent,
  hostId: string = 'local'
): Promise<string> => {
  if (hostId === 'local') return getProjectsDir();
  const result = await executorFor(hostId).exec(['projects-dir']);
  return result.code === 0 ? result.stdout.trim() : '';
});

function getProjectsDir(): string {
  return readEnvValue('PROJECTS_DIR') ?? path.join(os.homedir(), 'podium-projects');
}

// Run a zeltro subcommand and collect its text output. The service panels use
// this rather than driving docker directly, so custom container names and any
// future CLI fixes are picked up for free.
// ---------------------------------------------------------------------------
// Executors
//
// One interface over "run a zeltro command", with a local and an SSH
// implementation. Everything that shells out to zeltro goes through this, so
// remote support is a matter of which executor a call gets rather than a second
// code path beside every existing one.
//
// Deliberately just `exec` for now. Streaming and pty are separate channels the
// dashboard does not need, and adding them before there is a caller would be
// guessing at their shape.
// ---------------------------------------------------------------------------

interface Executor {
  /** Human-readable, for errors and for tagging which host a project is on. */
  readonly label: string;
  exec(args: string[]): Promise<CommandResult>;
  /**
   * Same, but emitting output as it arrives. Creating a project takes tens of
   * seconds — 46s measured on a remote host — and buffering that is a minute of
   * a blank overlay followed by everything at once.
   */
  execStream(args: string[], onData: (chunk: string) => void): Promise<CommandResult>;
  dispose(): void;
}

class LocalExecutor implements Executor {
  readonly label = 'local';
  exec(args: string[]): Promise<CommandResult> { return runZeltro(args); }

  execStream(args: string[], onData: (chunk: string) => void): Promise<CommandResult> {
    return new Promise((resolve) => {
      const zeltro = resolveZeltro();
      const child = spawn(zeltro.command, [...zeltro.prefix, ...args], {
        cwd: os.homedir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' }
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { const t = d.toString(); stdout += t; onData(t); });
      child.stderr?.on('data', (d: Buffer) => { const t = d.toString(); stderr += t; onData(t); });
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.on('error', (e) => resolve({ code: 1, stdout: '', stderr: e.message }));
      child.stdin?.end();
    });
  }

  dispose(): void { /* nothing to release */ }
}

// One ssh2 connection per host, reused.
//
// The dashboard polls on a timer, and a fresh SSH handshake costs 200-500ms —
// paid on every poll, per host, it is the difference between usable and not.
// The connection is re-established on demand if the host drops it.
class SshExecutor implements Executor {
  readonly label: string;
  private profile: SshProfile;
  private conn: any = null;
  private connecting: Promise<any> | null = null;

  constructor(profile: SshProfile) {
    this.profile = profile;
    this.label = profile.label || profile.host;
  }

  // Absolute zeltro path, and an explicit PATH for the processes zeltro itself
  // spawns. Both are required and for different reasons — see
  // REMOTE_ZELTRO_CANDIDATES and REMOTE_PATH_PREFIX. Shared by exec and
  // execStream so the two cannot drift apart on either point.
  private zeltroCommand(args: string[]): string {
    const bin = this.profile.zeltroPath || REMOTE_ZELTRO_CANDIDATES[0];
    const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    return `${REMOTE_PATH_PREFIX} NO_COLOR=1 ${bin} ${quoted}`;
  }

  private connect(): Promise<any> {
    if (this.conn) return Promise.resolve(this.conn);
    // Concurrent calls during connect must share one handshake rather than
    // racing to open several.
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const { Client } = require('ssh2');
      const built = connectOptionsFor(this.profile);
      if (!built.options) {
        this.connecting = null;
        return reject(new Error(built.error || 'Cannot connect'));
      }

      const conn = new Client();
      conn.on('ready', () => {
        this.conn = conn;
        this.connecting = null;
        resolve(conn);
      });
      conn.on('error', (err: any) => {
        this.conn = null;
        this.connecting = null;
        reject(err);
      });
      // A dropped connection must not leave a dead handle that every later
      // call tries to reuse.
      conn.on('close', () => { this.conn = null; });

      conn.connect(built.options);
    });
    return this.connecting;
  }

  async exec(args: string[]): Promise<CommandResult> {
    let conn;
    try {
      conn = await this.connect();
    } catch (error) {
      return { code: 1, stdout: '', stderr: `${this.label}: ${(error as Error).message}` };
    }

    return new Promise((resolve) => {
      conn.exec(this.zeltroCommand(args), (err: any, stream: any) => {
        if (err) return resolve({ code: 1, stdout: '', stderr: `${this.label}: ${err.message}` });

        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        stream.on('close', (code: number) => {
          resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
        });
      });
    });
  }

  async execStream(args: string[], onData: (chunk: string) => void): Promise<CommandResult> {
    let conn;
    try {
      conn = await this.connect();
    } catch (error) {
      return { code: 1, stdout: '', stderr: `${this.label}: ${(error as Error).message}` };
    }

    return new Promise((resolve) => {
      conn.exec(this.zeltroCommand(args), (err: any, stream: any) => {
        if (err) return resolve({ code: 1, stdout: '', stderr: `${this.label}: ${err.message}` });

        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => { const t = d.toString(); stdout += t; onData(t); });
        stream.stderr.on('data', (d: Buffer) => { const t = d.toString(); stderr += t; onData(t); });
        stream.on('close', (code: number) => {
          resolve({ code: code ?? 1, stdout, stderr });
        });
      });
    });
  }

  /**
   * An interactive pty on the remote host.
   *
   * `pty: true` matters: `zeltro resume` starts an AI agent, which needs a
   * terminal to render into and to read keystrokes from. Without it the agent
   * sees a pipe, and most of them refuse to run interactively at all.
   */
  async openPty(cwd: string, command: string, args: string[]): Promise<any> {
    const conn = await this.connect();
    const bin = command === 'zeltro'
      ? (this.profile.zeltroPath || REMOTE_ZELTRO_CANDIDATES[0])
      : command;
    const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    const full = `cd ${JSON.stringify(cwd)} && ${REMOTE_PATH_PREFIX} ${bin} ${quoted}`;

    return new Promise((resolve, reject) => {
      conn.exec(full, { pty: { term: 'xterm-256color', cols: 100, rows: 28 } },
        (err: any, stream: any) => err ? reject(err) : resolve(stream));
    });
  }

  /**
   * A raw command with something on stdin.
   *
   * `gh auth login --with-token` reads the token from stdin, which is the only
   * non-interactive way to authenticate — the browser flow wants a terminal and
   * a browser on the machine running it, and over SSH there is neither.
   */
  async execRawWithInput(command: string, input: string): Promise<CommandResult> {
    let conn;
    try {
      conn = await this.connect();
    } catch (error) {
      return { code: 1, stdout: '', stderr: `${this.label}: ${(error as Error).message}` };
    }
    return new Promise((resolve) => {
      conn.exec(command, (err: any, stream: any) => {
        if (err) return resolve({ code: 1, stdout: '', stderr: err.message });
        let stdout = ''; let stderr = '';
        stream.on('data', (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        stream.on('close', (code: number) => {
          resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
        });
        stream.end(input);
      });
    });
  }

  /** Run a raw command rather than a zeltro subcommand. Used for probes. */
  async execRaw(command: string): Promise<CommandResult> {
    let conn;
    try {
      conn = await this.connect();
    } catch (error) {
      return { code: 1, stdout: '', stderr: `${this.label}: ${(error as Error).message}` };
    }
    return new Promise((resolve) => {
      conn.exec(command, (err: any, stream: any) => {
        if (err) return resolve({ code: 1, stdout: '', stderr: err.message });
        let stdout = ''; let stderr = '';
        stream.on('data', (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        stream.on('close', (code: number) => {
          resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
        });
      });
    });
  }

  dispose(): void {
    try { this.conn?.end(); } catch { /* already gone */ }
    this.conn = null;
  }
}

// Cached so connections are reused across calls. Rebuilt when a profile changes,
// since host, user or key may all have moved.
const executors = new Map<string, Executor>();

function executorFor(hostId: string): Executor {
  if (hostId === 'local') {
    if (!executors.has('local')) executors.set('local', new LocalExecutor());
    return executors.get('local')!;
  }

  const profile = readSshProfiles().find((p) => p.id === hostId);
  if (!profile) {
    // A project pointing at a host that has been removed. Fail with something
    // that says so rather than silently falling back to local, which would run
    // a command against the wrong machine.
    const missing = async () => ({
      code: 1, stdout: '', stderr: `No SSH host configured with id ${hostId}`
    });
    return { label: hostId, exec: missing, execStream: missing, dispose: () => { /* nothing */ } };
  }

  const cached = executors.get(hostId) as SshExecutor | undefined;
  if (cached && (cached as any).profile
      && JSON.stringify((cached as any).profile) === JSON.stringify(profile)) {
    return cached;
  }
  cached?.dispose();

  const made = new SshExecutor(profile);
  executors.set(hostId, made);
  return made;
}

function disposeExecutors(): void {
  executors.forEach((e) => e.dispose());
  executors.clear();
}

// Run a zeltro command on a named host. `local` is the local install.
ipcMain.handle('execute-zeltro-on', async (
  _event: IpcMainInvokeEvent,
  hostId: string,
  subcommand: string,
  args: string[] = []
): Promise<CommandResult> => executorFor(hostId).exec([subcommand, ...args]));

// Streaming variant. Emits on the same channel the local streaming path uses,
// so the renderer's progress panes need no knowledge of which host is running.
ipcMain.handle('execute-zeltro-stream-on', async (
  event: IpcMainInvokeEvent,
  hostId: string,
  subcommand: string,
  args: string[] = []
): Promise<CommandResult> => {
  return executorFor(hostId).execStream([subcommand, ...args], (chunk) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('command-stream-data', { type: 'stdout', data: chunk, command: 'zeltro' });
    }
  });
});

function runZeltro(args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const zeltro = resolveZeltro();
    const child = spawn(zeltro.command, [...zeltro.prefix, ...args], {
      cwd: os.homedir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' }
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('close', (code: number | null) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on('error', (error: Error) => {
      resolve({ code: 1, stdout: '', stderr: error.message });
    });

    child.stdin?.end();
  });
}

function parseMemcachedStats(output: string): Record<string, string> {
  const stats: Record<string, string> = {};

  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('STAT ')) continue;

    const parts = line.trim().split(' ');
    if (parts.length >= 3 && parts[1] && parts[2]) {
      stats[parts[1]] = parts[2];
    }
  }

  // Format bytes as human readable
  if (stats.bytes) {
    const bytes = parseInt(stats.bytes);
    if (bytes > 1024 * 1024) {
      stats.bytes = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    } else if (bytes > 1024) {
      stats.bytes = `${(bytes / 1024).toFixed(2)} KB`;
    } else {
      stats.bytes = `${bytes} B`;
    }
  }

  return stats;
}

function composePathFor(projectName: string): string | null {
  const composePath = path.join(getProjectsDir(), projectName, 'docker-compose.yaml');
  return fs.existsSync(composePath) ? composePath : null;
}

// Display metadata is no longer read here. `zeltro status --json-output` carries
// it per project (CLI 36109a7), so the GUI parses it alongside operational state
// instead of opening each project's docker-compose.yaml. That removed a
// per-project filesystem read, the cache it fed, and the two bugs that existed
// only because the two arrived by different routes.

// Metadata writes go through `zeltro set-metadata` (CLI 36109a7) rather than
// editing docker-compose.yaml here.
//
// The careful part — replacing only the three keys the GUI owns and leaving the
// CLI's last_on and status untouched — is now a property of that command, which
// writes one key at a time through the CLI's own helper. It used to be a
// property of three targeted regexes in this file. The test pinning that
// behaviour still earns its place; it tests the CLI's code now, which is where
// it belongs.
//
// This was also the last filesystem write, which is what lets a remote host
// need no file access at all.
ipcMain.handle('update-project-metadata', async (
  _event: IpcMainInvokeEvent,
  projectName: string,
  metadata: ProjectMetadata
): Promise<{ success: boolean; error?: string }> => {
  const args = ['set-metadata', projectName, '--json-output'];
  if (metadata.emoji) args.push('--emoji', metadata.emoji);
  if (metadata.display_name) args.push('--name', metadata.display_name);
  if (metadata.description) args.push('--description', metadata.description);

  const result = await runZeltro(args);
  if (result.code !== 0) {
    return { success: false, error: result.stderr || result.stdout || 'set-metadata failed' };
  }
  return { success: true };
});

// Handler for getting service statistics
ipcMain.handle("get-service-stats", async (event: IpcMainInvokeEvent, serviceName: string): Promise<{ success: boolean; stats?: any; error?: string }> => {
  try {
    if (serviceName === "memcached") {
      const memcached = await runZeltro(["memcache-stats"]);
      if (memcached.code !== 0) {
        return { success: false, error: memcached.stderr || "Failed to get stats" };
      }
      return { success: true, stats: parseMemcachedStats(memcached.stdout) };
    }

    if (serviceName !== "redis") {
      return { success: false, error: "Unsupported service" };
    }

    const result = await runZeltro(["redis", "INFO"]);
    
    if (result.code !== 0) {
      return { success: false, error: result.stderr || "Failed to get stats" };
    }
    
    let stats: any = {};
    
    if (serviceName === "redis") {
      // Parse Redis INFO output. Note: this split used to be "\\n", which is a
      // literal backslash-n, so no line ever matched and stats came back empty.
      for (const line of result.stdout.split(/\r?\n/)) {
        if (line.startsWith("#") || !line.includes(":")) continue;

        const separator = line.indexOf(":");
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (key && value) {
          stats[key] = value;
        }
      }

      // Calculate total keys from keyspace info
      let totalKeys = 0;
      for (const [key, value] of Object.entries(stats)) {
        if (key.startsWith("db") && typeof value === "string") {
          const match = value.match(/keys=([0-9]+)/);
          if (match && match[1]) totalKeys += parseInt(match[1]);
        }
      }
      stats.total_keys = totalKeys.toString();
    }

    debugLog("Service stats retrieved", { serviceName, stats });
    return { success: true, stats };
  } catch (error) {
    debugLog("Error getting service stats", { error: (error as Error).message });
    return { success: false, error: (error as Error).message };
  }
});

// Handler for flushing service data
ipcMain.handle("flush-service-data", async (event: IpcMainInvokeEvent, serviceName: string): Promise<{ success: boolean; error?: string }> => {
  try {
    if (serviceName !== "redis" && serviceName !== "memcached") {
      return { success: false, error: "Unsupported service" };
    }

    const result = await runZeltro([serviceName === "redis" ? "redis-flush" : "memcache-flush"]);

    if (result.code !== 0) {
      return { success: false, error: result.stderr || "Failed to flush data" };
    }
    
    debugLog("Service data flushed", { serviceName });
    return { success: true };
  } catch (error) {
    debugLog("Error flushing service data", { error: (error as Error).message });
    return { success: false, error: (error as Error).message };
  }
});
