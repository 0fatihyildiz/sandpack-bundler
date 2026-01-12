import { WebContainer, FileSystemTree, WebContainerProcess } from '@webcontainer/api';
import { Emitter } from '../utils/emitter';
import * as logger from '../utils/logger';

export interface WebContainerFile {
  path: string;
  code: string;
}

export interface ProcessOutput {
  type: 'stdout' | 'stderr' | 'exit';
  data: string;
  exitCode?: number;
}

export class WebContainerManager {
  private static instance: WebContainerManager | null = null;
  private container: WebContainer | null = null;
  private isBooting = false;
  private bootPromise: Promise<WebContainer> | null = null;
  private currentProcess: WebContainerProcess | null = null;
  private serverUrl: string | null = null;

  // Event emitters
  private onOutputEmitter = new Emitter<ProcessOutput>();
  onOutput = this.onOutputEmitter.event;

  private onServerReadyEmitter = new Emitter<string>();
  onServerReady = this.onServerReadyEmitter.event;

  private onErrorEmitter = new Emitter<Error>();
  onError = this.onErrorEmitter.event;

  private constructor() {}

  static getInstance(): WebContainerManager {
    if (!WebContainerManager.instance) {
      WebContainerManager.instance = new WebContainerManager();
    }
    return WebContainerManager.instance;
  }

  async boot(): Promise<WebContainer> {
    if (this.container) {
      return this.container;
    }

    if (this.bootPromise) {
      return this.bootPromise;
    }

    this.isBooting = true;
    this.bootPromise = this._boot();
    return this.bootPromise;
  }

  private async _boot(): Promise<WebContainer> {
    try {
      logger.debug('Booting WebContainer...');
      this.container = await WebContainer.boot();
      logger.debug('WebContainer booted successfully');

      // Listen for server-ready events
      this.container.on('server-ready', (port, url) => {
        logger.debug(`Server ready on port ${port}: ${url}`);
        this.serverUrl = url;
        this.onServerReadyEmitter.fire(url);
      });

      this.container.on('error', (error) => {
        logger.error('WebContainer error:', error);
        this.onErrorEmitter.fire(error);
      });

      return this.container;
    } catch (error) {
      logger.error('Failed to boot WebContainer:', error);
      this.bootPromise = null;
      this.isBooting = false;
      throw error;
    }
  }

  async writeFiles(files: WebContainerFile[]): Promise<void> {
    const container = await this.boot();

    // Convert files to FileSystemTree format
    const fsTree: FileSystemTree = {};

    for (const file of files) {
      const pathParts = file.path.replace(/^\//, '').split('/');
      let current: any = fsTree;

      for (let i = 0; i < pathParts.length - 1; i++) {
        const part = pathParts[i];
        if (!current[part]) {
          current[part] = { directory: {} };
        }
        current = current[part].directory;
      }

      const fileName = pathParts[pathParts.length - 1];
      current[fileName] = {
        file: {
          contents: file.code,
        },
      };
    }

    logger.debug('Writing files to WebContainer:', Object.keys(fsTree));
    await container.mount(fsTree);
  }

  async runCommand(command: string, args: string[] = []): Promise<number> {
    const container = await this.boot();

    logger.debug(`Running command: ${command} ${args.join(' ')}`);

    const process = await container.spawn(command, args);
    this.currentProcess = process;

    // Stream stdout
    process.output.pipeTo(
      new WritableStream({
        write: (data) => {
          this.onOutputEmitter.fire({ type: 'stdout', data });
        },
      })
    );

    const exitCode = await process.exit;
    this.onOutputEmitter.fire({ type: 'exit', data: '', exitCode });
    this.currentProcess = null;

    return exitCode;
  }

  async npmInstall(): Promise<number> {
    logger.debug('Running npm install...');
    return this.runCommand('npm', ['install']);
  }

  async npmRunDev(): Promise<WebContainerProcess> {
    const container = await this.boot();

    logger.debug('Running npm run dev...');

    // Kill any existing process
    if (this.currentProcess) {
      this.currentProcess.kill();
    }

    const process = await container.spawn('npm', ['run', 'dev']);
    this.currentProcess = process;

    // Stream stdout
    process.output.pipeTo(
      new WritableStream({
        write: (data) => {
          this.onOutputEmitter.fire({ type: 'stdout', data });
        },
      })
    );

    return process;
  }

  async npmRunStart(): Promise<WebContainerProcess> {
    const container = await this.boot();

    logger.debug('Running npm run start...');

    if (this.currentProcess) {
      this.currentProcess.kill();
    }

    const process = await container.spawn('npm', ['run', 'start']);
    this.currentProcess = process;

    process.output.pipeTo(
      new WritableStream({
        write: (data) => {
          this.onOutputEmitter.fire({ type: 'stdout', data });
        },
      })
    );

    return process;
  }

  async npmRunBuild(): Promise<number> {
    logger.debug('Running npm run build...');
    return this.runCommand('npm', ['run', 'build']);
  }

  async runScript(scriptName: string): Promise<WebContainerProcess | number> {
    const container = await this.boot();

    // Check if it's a long-running script (dev, start, serve)
    const longRunning = ['dev', 'start', 'serve', 'watch'].includes(scriptName);

    if (longRunning) {
      if (this.currentProcess) {
        this.currentProcess.kill();
      }

      const process = await container.spawn('npm', ['run', scriptName]);
      this.currentProcess = process;

      process.output.pipeTo(
        new WritableStream({
          write: (data) => {
            this.onOutputEmitter.fire({ type: 'stdout', data });
          },
        })
      );

      return process;
    } else {
      return this.runCommand('npm', ['run', scriptName]);
    }
  }

  getServerUrl(): string | null {
    return this.serverUrl;
  }

  killCurrentProcess(): void {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }

  async teardown(): Promise<void> {
    this.killCurrentProcess();
    if (this.container) {
      await this.container.teardown();
      this.container = null;
      this.bootPromise = null;
      this.isBooting = false;
      this.serverUrl = null;
    }
  }

  isReady(): boolean {
    return this.container !== null;
  }
}

// Export singleton
export const webContainerManager = WebContainerManager.getInstance();
