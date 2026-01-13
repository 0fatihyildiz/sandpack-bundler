import { Bundler } from './bundler/bundler';
import { ErrorRecord, listenToRuntimeErrors } from './error-listener';
import { BundlerError } from './errors/BundlerError';
import { CompilationError } from './errors/CompilationError';
import { errorMessage } from './errors/util';
import { handleEvaluate, hookConsole } from './integrations/console';
import { IFrameParentMessageBus } from './protocol/iframe';
import { ICompileRequest } from './protocol/message-types';
import { Debouncer } from './utils/Debouncer';
import { DisposableStore } from './utils/Disposable';
import { getDocumentHeight } from './utils/document';
import * as logger from './utils/logger';

const bundlerStartTime = Date.now();

// Check if we're in preview mode (URL: /preview/:bundleId)
function getPreviewBundleId(): string | null {
  const match = window.location.pathname.match(/^\/preview\/([^/]+)/);
  return match ? match[1] : null;
}

class SandpackInstance {
  private messageBus: IFrameParentMessageBus;
  private disposableStore = new DisposableStore();
  private bundler;
  private compileDebouncer = new Debouncer(50);
  private lastHeight: number = 0;
  private resizePollingTimer: NodeJS.Timer | undefined;

  constructor() {
    this.messageBus = new IFrameParentMessageBus();

    this.bundler = new Bundler({ messageBus: this.messageBus });

    const disposeOnMessage = this.messageBus.onMessage((msg) => {
      this.handleParentMessage(msg);
    });
    this.disposableStore.add(disposeOnMessage);

    this.init().catch(logger.error);

    listenToRuntimeErrors(this.bundler, (runtimeError: ErrorRecord) => {
      const stackFrame = runtimeError.stackFrames[0] ?? {};

      this.messageBus.sendMessage('action', {
        action: 'show-error',

        title: 'Runtime Exception',
        line: stackFrame._originalLineNumber,
        column: stackFrame._originalColumnNumber,
        // @ts-ignore
        path: runtimeError.error.path,
        message: runtimeError.error.message,
        payload: { frames: runtimeError.stackFrames },
      });
    });

    // Console logic
    hookConsole((log) => {
      this.messageBus.sendMessage('console', { log });
    });
    this.messageBus.onMessage((data: any) => {
      if (typeof data === 'object' && data.type === 'evaluate') {
        const result = handleEvaluate(data.command);
        if (result) {
          this.messageBus.sendMessage('console', result);
        }
      }
    });
  }

  handleParentMessage(message: any) {
    switch (message.type) {
      case 'compile':
        this.compileDebouncer.debounce(() => this.handleCompile(message).catch(logger.error));
        break;
      case 'refresh':
        window.location.reload();
        this.messageBus.sendMessage('refresh');
        break;
    }
  }

  sendResizeEvent = () => {
    const height = getDocumentHeight();

    if (this.lastHeight !== height) {
      this.messageBus.sendMessage('resize', { height });
    }

    this.lastHeight = height;
  };

  initResizeEvent() {
    const resizePolling = () => {
      if (this.resizePollingTimer) {
        clearInterval(this.resizePollingTimer as NodeJS.Timeout);
      }

      this.resizePollingTimer = setInterval(this.sendResizeEvent, 300);
    };

    resizePolling();

    /**
     * Ideally we should only use a `MutationObserver` to trigger a resize event,
     * however, we noted that it's not 100% reliable, so we went for polling strategy as well
     */
    let throttle: NodeJS.Timeout | undefined;
    const observer = new MutationObserver(() => {
      if (throttle === undefined) {
        this.sendResizeEvent();

        throttle = setTimeout(() => {
          throttle = undefined;
        }, 300);
      }
    });
    observer.observe(document, { attributes: true, childList: true, subtree: true });
  }

  async init() {
    this.messageBus.sendMessage('initialized');

    this.bundler.onStatusChange((newStatus) => {
      this.messageBus.sendMessage('status', { status: newStatus });
    });
  }

  async handleCompile(compileRequest: ICompileRequest) {
    if (compileRequest.logLevel != null) {
      logger.setLogLevel(compileRequest.logLevel);
    }

    logger.debug(logger.logFactory('Init'));

    // -- FileSystem
    const initStartTimeFileSystem = Date.now();
    logger.debug(logger.logFactory('FileSystem'));
    this.bundler.configureFS({
      hasAsyncFileResolver: compileRequest.hasFileResolver,
    });

    this.messageBus.sendMessage('start', {
      firstLoad: this.bundler.isFirstLoad,
    });

    this.messageBus.sendMessage('status', { status: 'initializing' });

    if (this.bundler.isFirstLoad) {
      this.bundler.resetModules();
    }
    logger.debug(logger.logFactory('FileSystem', `finished in ${Date.now() - initStartTimeFileSystem}ms`));

    // --- Load preset
    logger.groupCollapsed(logger.logFactory('Preset and transformers'));
    const initStartTime = Date.now();
    await this.bundler.initPreset(compileRequest.template);
    logger.debug(logger.logFactory('Preset and transformers', `finished in ${Date.now() - initStartTime}ms`));
    logger.groupEnd();

    // --- Bundling / Compiling
    logger.groupCollapsed(logger.logFactory('Bundling'));
    const bundlingStartTime = Date.now();
    const files = Object.values(compileRequest.modules);
    const evaluate = await this.bundler
      .compile(files)
      .then((val) => {
        this.messageBus.sendMessage('done', {
          compilatonError: false,
        });

        return val;
      })
      .catch((error: CompilationError) => {
        logger.error(error);

        // Check if it's an empty project / no entry point error
        const isEmptyProject = error?.message?.includes('Could not resolve entry point');

        if (isEmptyProject) {
          // Show a friendly empty state instead of error
          this.showEmptyState();
        } else {
          this.messageBus.sendMessage('action', errorMessage(error));
        }

        this.messageBus.sendMessage('done', {
          compilatonError: !isEmptyProject,
        });
      })
      .finally(() => {
        logger.debug(logger.logFactory('Bundling', `finished in  ${Date.now() - bundlingStartTime}ms`));
        logger.groupEnd();
      });

    // --- Replace HTML
    this.bundler.replaceHTML();

    // --- Evaluation
    if (evaluate) {
      this.messageBus.sendMessage('status', { status: 'evaluating' });

      try {
        logger.groupCollapsed(logger.logFactory('Evaluation'));
        const evalStartTime = Date.now();

        evaluate();

        this.messageBus.sendMessage('success');

        logger.debug(logger.logFactory('Evaluation', `finished in ${Date.now() - evalStartTime}ms`));
        logger.groupEnd();
      } catch (error: unknown) {
        logger.error(error);

        this.messageBus.sendMessage(
          'action',
          errorMessage(error as BundlerError) // TODO: create a evaluation error
        );
      }

      this.initResizeEvent();
    }

    logger.debug(logger.logFactory('Finished', `in ${Date.now() - bundlerStartTime}ms`));
    this.messageBus.sendMessage('status', { status: 'done' });
  }

  private showEmptyState() {
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#fafafa;">
        <div style="text-align:center;max-width:400px;padding:40px;">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="1.5" style="margin:0 auto 20px;">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
            <polyline points="13 2 13 9 20 9"></polyline>
          </svg>
          <h2 style="color:#333;font-size:18px;margin:0 0 8px;font-weight:500;">No Preview Available</h2>
          <p style="color:#888;font-size:14px;margin:0;line-height:1.5;">
            Add an <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px;">index.html</code> or <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px;">index.js</code> file to see a preview.
          </p>
        </div>
      </div>
    `;
  }

  dispose() {
    this.disposableStore.dispose();
  }
}

// Standalone preview mode - loads bundle from server
class PreviewInstance {
  private bundler: Bundler;
  private messageBus: IFrameParentMessageBus;

  constructor(private bundleId: string) {
    this.messageBus = new IFrameParentMessageBus();
    this.bundler = new Bundler({ messageBus: this.messageBus });
    this.loadBundle();
  }

  private async loadBundle() {
    try {
      const response = await fetch(`/api/bundle/${this.bundleId}`);
      if (!response.ok) {
        this.showError('Bundle not found or expired');
        return;
      }

      const bundle = await response.json();
      await this.compile(bundle);
    } catch (error) {
      logger.error(error);
      this.showError('Failed to load bundle');
    }
  }

  private showError(message: string, isEmptyProject = false) {
    if (isEmptyProject) {
      document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#fafafa;">
          <div style="text-align:center;max-width:400px;padding:40px;">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="1.5" style="margin:0 auto 20px;">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
              <polyline points="13 2 13 9 20 9"></polyline>
            </svg>
            <h2 style="color:#333;font-size:18px;margin:0 0 8px;font-weight:500;">No Preview Available</h2>
            <p style="color:#888;font-size:14px;margin:0;line-height:1.5;">
              Add an <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px;">index.html</code> or <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px;">index.js</code> file to see a preview.
            </p>
          </div>
        </div>
      `;
    } else {
      document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;color:#666;">
          <div style="text-align:center;">
            <h2 style="color:#333;">Preview Error</h2>
            <p>${message}</p>
          </div>
        </div>
      `;
    }
  }

  private async compile(bundle: { files: Record<string, { code: string }>; entry: string; template?: string }) {
    // Convert files to expected format
    const files = Object.entries(bundle.files).map(([path, file]) => ({
      path,
      code: file.code,
    }));

    // Check if there are any meaningful files
    const hasContent = files.some((f) => {
      const isConfig = f.path === '/package.json' || f.path === '/tsconfig.json';
      return !isConfig && f.code.trim().length > 0;
    });

    if (!hasContent || files.length === 0) {
      this.showError('', true);
      return;
    }

    // Detect template from entry point or use provided template
    const template = bundle.template || this.detectTemplate(bundle.entry, files);

    try {
      this.bundler.resetModules();
      await this.bundler.initPreset(template);

      const evaluate = await this.bundler.compile(files);

      this.bundler.replaceHTML();

      if (evaluate) {
        evaluate();
      }
    } catch (error: any) {
      // Check if it's an entry point error
      if (error?.message?.includes('Could not resolve entry point')) {
        this.showError('', true);
      } else {
        logger.error(error);
        this.showError(error?.message || 'Compilation failed');
      }
    }
  }

  private detectTemplate(entry: string, files: { path: string; code: string }[]): string {
    // Check if entry is HTML
    if (entry.endsWith('.html') || entry.endsWith('.htm')) {
      return 'vanilla';
    }

    // Check if project has React
    const pkgJson = files.find((f) => f.path === '/package.json');
    if (pkgJson) {
      try {
        const pkg = JSON.parse(pkgJson.code);
        if (pkg.dependencies?.react || pkg.devDependencies?.react) {
          return 'react';
        }
        if (pkg.dependencies?.['solid-js'] || pkg.devDependencies?.['solid-js']) {
          return 'solid';
        }
      } catch {
        // ignore parse error
      }
    }

    // Check file extensions for JSX/TSX
    const hasJsx = files.some((f) => /\.(jsx|tsx)$/.test(f.path));
    if (hasJsx) {
      return 'react';
    }

    return 'vanilla';
  }
}

// WebContainer-based preview instance for full Node.js support
class WebContainerPreviewInstance {
  private container: any = null;
  private serverUrl: string | null = null;
  private outputDiv: HTMLDivElement | null = null;

  constructor(private bundleId: string) {
    this.init();
  }

  private async init() {
    this.showLoading('Initializing WebContainer...');

    try {
      // Fetch bundle data
      const response = await fetch(`/api/bundle/${this.bundleId}`);
      if (!response.ok) {
        this.showError('Bundle not found or expired');
        return;
      }

      const bundle = await response.json();

      // Check if this project needs WebContainer (has scripts in package.json)
      const needsWebContainer = this.needsWebContainer(bundle.files);

      if (needsWebContainer) {
        await this.runWithWebContainer(bundle);
      } else {
        // Fall back to standard bundler for simple projects
        const previewInstance = new PreviewInstance(this.bundleId);
      }
    } catch (error: any) {
      logger.error(error);
      this.showError(error?.message || 'Failed to initialize');
    }
  }

  private needsWebContainer(files: Record<string, { code: string }>): boolean {
    const pkgJson = files['/package.json'];
    if (!pkgJson) return false;

    try {
      const pkg = JSON.parse(pkgJson.code);
      // Check if there are dev/start scripts
      return !!(pkg.scripts?.dev || pkg.scripts?.start || pkg.scripts?.serve);
    } catch {
      return false;
    }
  }

  private async runWithWebContainer(bundle: { files: Record<string, { code: string }>; entry: string }) {
    try {
      // Dynamic import to avoid loading WebContainer for simple projects
      const { webContainerManager } = await import('./webcontainer');

      this.showLoading('Booting WebContainer...');
      await webContainerManager.boot();

      // Convert files
      const files = Object.entries(bundle.files).map(([path, file]) => ({
        path,
        code: file.code,
      }));

      this.showLoading('Writing files...');
      await webContainerManager.writeFiles(files);

      // Listen for output
      webContainerManager.onOutput((output) => {
        this.appendOutput(output.data, output.type);
      });

      // Listen for server ready
      webContainerManager.onServerReady((url) => {
        this.serverUrl = url;
        this.showPreview(url);
      });

      this.showLoading('Installing dependencies...');
      this.showTerminal();
      const installCode = await webContainerManager.npmInstall();

      if (installCode !== 0) {
        this.showError('npm install failed');
        return;
      }

      this.appendOutput('\n--- Running dev server ---\n', 'stdout');

      // Try to run dev script
      const pkgJson = bundle.files['/package.json'];
      if (pkgJson) {
        const pkg = JSON.parse(pkgJson.code);
        if (pkg.scripts?.dev) {
          await webContainerManager.runScript('dev');
        } else if (pkg.scripts?.start) {
          await webContainerManager.runScript('start');
        } else if (pkg.scripts?.serve) {
          await webContainerManager.runScript('serve');
        }
      }
    } catch (error: any) {
      logger.error(error);
      this.showError(`WebContainer error: ${error?.message}`);
    }
  }

  private showLoading(message: string) {
    document.body.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#1a1a1a;">
        <div style="margin-bottom:20px;">
          <div style="width:40px;height:40px;border:3px solid #333;border-top-color:#0ea5e9;border-radius:50%;animation:spin 1s linear infinite;"></div>
        </div>
        <p style="color:#888;font-size:14px;">${message}</p>
      </div>
      <style>
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
    `;
  }

  private showTerminal() {
    document.body.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100vh;font-family:system-ui;background:#1a1a1a;">
        <div style="padding:8px 12px;background:#252525;border-bottom:1px solid #333;display:flex;align-items:center;gap:8px;">
          <span style="color:#888;font-size:12px;">Terminal</span>
          <span id="status" style="color:#0ea5e9;font-size:11px;">Running...</span>
        </div>
        <div id="output" style="flex:1;overflow:auto;padding:12px;font-family:monospace;font-size:13px;color:#ccc;white-space:pre-wrap;"></div>
        <div id="preview-container" style="display:none;flex:1;"></div>
      </div>
    `;
    this.outputDiv = document.getElementById('output') as HTMLDivElement;
  }

  private appendOutput(data: string, type: 'stdout' | 'stderr' | 'exit') {
    if (!this.outputDiv) return;

    const span = document.createElement('span');
    span.style.color = type === 'stderr' ? '#ef4444' : '#ccc';
    span.textContent = data;
    this.outputDiv.appendChild(span);
    this.outputDiv.scrollTop = this.outputDiv.scrollHeight;
  }

  private showPreview(url: string) {
    const container = document.getElementById('preview-container');
    const output = document.getElementById('output');
    const status = document.getElementById('status');

    if (container && output && status) {
      status.textContent = 'Server ready';
      status.style.color = '#22c55e';

      // Create iframe for preview
      container.style.display = 'block';
      container.innerHTML = `
        <div style="padding:8px 12px;background:#252525;border-bottom:1px solid #333;display:flex;align-items:center;gap:8px;">
          <span style="color:#888;font-size:12px;">Preview</span>
          <a href="${url}" target="_blank" style="color:#0ea5e9;font-size:11px;text-decoration:none;">${url}</a>
        </div>
        <iframe src="${url}" style="width:100%;height:calc(100% - 36px);border:none;background:white;"></iframe>
      `;

      // Resize terminal
      output.style.maxHeight = '200px';
    }
  }

  private showError(message: string) {
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;background:#1a1a1a;">
        <div style="text-align:center;max-width:400px;padding:40px;">
          <div style="width:48px;height:48px;margin:0 auto 16px;border-radius:50%;background:#ef4444/20;display:flex;align-items:center;justify-content:center;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="15" y1="9" x2="9" y2="15"></line>
              <line x1="9" y1="9" x2="15" y2="15"></line>
            </svg>
          </div>
          <h2 style="color:#fff;font-size:18px;margin:0 0 8px;font-weight:500;">Error</h2>
          <p style="color:#888;font-size:14px;margin:0;">${message}</p>
        </div>
      </div>
    `;
  }
}

// Check for WebContainer preview mode (URL: /wc-preview/:bundleId)
function getWebContainerPreviewId(): string | null {
  const match = window.location.pathname.match(/^\/wc-preview\/([^/]+)/);
  return match ? match[1] : null;
}

// Initialize based on URL
const wcBundleId = getWebContainerPreviewId();
const bundleId = getPreviewBundleId();

if (wcBundleId) {
  new WebContainerPreviewInstance(wcBundleId);
} else if (bundleId) {
  new PreviewInstance(bundleId);
} else {
  new SandpackInstance();
}
