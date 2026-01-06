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

// Initialize based on URL
const bundleId = getPreviewBundleId();
if (bundleId) {
  new PreviewInstance(bundleId);
} else {
  new SandpackInstance();
}
