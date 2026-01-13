import { BundlerError } from '../errors/BundlerError';
import { FileSystem } from '../FileSystem';
import { IFrameFSLayer } from '../FileSystem/layers/IFrameFSLayer';
import { MemoryFSLayer } from '../FileSystem/layers/MemoryFSLayer';
import { NodeModuleFSLayer } from '../FileSystem/layers/NodeModuleFSLayer';
import { IFrameParentMessageBus } from '../protocol/iframe';
import { BundlerStatus } from '../protocol/message-types';
import { ResolverCache, resolveAsync } from '../resolver/resolver';
import { IPackageJSON, ISandboxFile } from '../types';
import { Emitter } from '../utils/emitter';
import { replaceHTML } from '../utils/html';
import * as logger from '../utils/logger';
import { NamedPromiseQueue } from '../utils/NamedPromiseQueue';
import { nullthrows } from '../utils/nullthrows';
import { ModuleRegistry } from './module-registry';
import { Module } from './module/Module';
import { Preset } from './presets/Preset';
import { getPreset } from './presets/registry';

export type TransformationQueue = NamedPromiseQueue<Module>;

interface IBundlerOpts {
  messageBus: IFrameParentMessageBus;
}

interface IFSOptions {
  hasAsyncFileResolver?: boolean;
}

export class Bundler {
  private lastHTML: string | null = null;
  private messageBus: IFrameParentMessageBus;

  fs: FileSystem;
  moduleRegistry: ModuleRegistry;

  parsedPackageJSON: IPackageJSON | null = null;
  // Map filepath => Module
  modules: Map<string, Module> = new Map();
  transformationQueue: TransformationQueue;
  resolverCache: ResolverCache = new Map();
  hasHMR = false;
  isFirstLoad = true;
  preset: Preset | undefined;

  // Map from module id => parent module ids
  initiators = new Map<string, Set<string>>();
  runtimes: string[] = [];

  private onStatusChangeEmitter = new Emitter<BundlerStatus>();
  onStatusChange = this.onStatusChangeEmitter.event;

  private _previousDepString: string | null = null;
  private iFrameFsLayer: IFrameFSLayer;

  constructor(options: IBundlerOpts) {
    this.transformationQueue = new NamedPromiseQueue(true, 50);
    this.moduleRegistry = new ModuleRegistry(this);
    const memoryFS = new MemoryFSLayer();
    memoryFS.writeFile('//empty.js', 'module.exports = () => {};');

    // Add Node.js built-in module polyfills/shims for browser environment
    this.writeNodeBuiltinShims(memoryFS);

    this.iFrameFsLayer = new IFrameFSLayer(memoryFS, options.messageBus);
    this.fs = new FileSystem([memoryFS, this.iFrameFsLayer, new NodeModuleFSLayer(this.moduleRegistry)]);
    this.messageBus = options.messageBus;
  }

  /** Write Node.js built-in module shims for browser compatibility */
  private writeNodeBuiltinShims(memoryFS: MemoryFSLayer): void {
    // Empty shim for modules that don't need functionality in browser
    const emptyShim = 'module.exports = {};';

    // Stream shim - minimal implementation
    const streamShim = `
      var EventEmitter = require('events').EventEmitter || function() {};
      function Stream() { EventEmitter.call(this); }
      Stream.prototype = Object.create(EventEmitter.prototype || {});
      Stream.prototype.constructor = Stream;
      Stream.prototype.pipe = function(dest) { return dest; };
      module.exports = Stream;
      module.exports.Stream = Stream;
      module.exports.Readable = Stream;
      module.exports.Writable = Stream;
      module.exports.Duplex = Stream;
      module.exports.Transform = Stream;
      module.exports.PassThrough = Stream;
    `;

    // Events shim - minimal EventEmitter
    const eventsShim = `
      function EventEmitter() { this._events = {}; }
      EventEmitter.prototype.on = function(event, listener) {
        if (!this._events[event]) this._events[event] = [];
        this._events[event].push(listener);
        return this;
      };
      EventEmitter.prototype.addListener = EventEmitter.prototype.on;
      EventEmitter.prototype.once = function(event, listener) {
        var self = this;
        function onceWrapper() {
          self.removeListener(event, onceWrapper);
          listener.apply(this, arguments);
        }
        return this.on(event, onceWrapper);
      };
      EventEmitter.prototype.emit = function(event) {
        var args = Array.prototype.slice.call(arguments, 1);
        var listeners = this._events[event] || [];
        listeners.forEach(function(listener) { listener.apply(null, args); });
        return listeners.length > 0;
      };
      EventEmitter.prototype.removeListener = function(event, listener) {
        if (this._events[event]) {
          this._events[event] = this._events[event].filter(function(l) { return l !== listener; });
        }
        return this;
      };
      EventEmitter.prototype.removeAllListeners = function(event) {
        if (event) { this._events[event] = []; } else { this._events = {}; }
        return this;
      };
      EventEmitter.prototype.listeners = function(event) { return this._events[event] || []; };
      EventEmitter.prototype.setMaxListeners = function() { return this; };
      module.exports = EventEmitter;
      module.exports.EventEmitter = EventEmitter;
    `;

    // Util shim - minimal implementation
    const utilShim = `
      module.exports = {
        inherits: function(ctor, superCtor) {
          ctor.prototype = Object.create(superCtor.prototype);
          ctor.prototype.constructor = ctor;
        },
        inspect: function(obj) { return JSON.stringify(obj); },
        isArray: Array.isArray,
        isBoolean: function(v) { return typeof v === 'boolean'; },
        isNull: function(v) { return v === null; },
        isNumber: function(v) { return typeof v === 'number'; },
        isString: function(v) { return typeof v === 'string'; },
        isUndefined: function(v) { return v === undefined; },
        isObject: function(v) { return typeof v === 'object' && v !== null; },
        isFunction: function(v) { return typeof v === 'function'; },
        isBuffer: function(v) { return false; },
        isRegExp: function(v) { return v instanceof RegExp; },
        isDate: function(v) { return v instanceof Date; },
        isError: function(v) { return v instanceof Error; },
        format: function(f) {
          var args = Array.prototype.slice.call(arguments, 1);
          return f.replace(/%[sdj%]/g, function(x) {
            if (x === '%%') return '%';
            if (!args.length) return x;
            var arg = args.shift();
            if (x === '%s') return String(arg);
            if (x === '%d') return Number(arg);
            if (x === '%j') return JSON.stringify(arg);
            return x;
          });
        },
        deprecate: function(fn) { return fn; },
        debuglog: function() { return function() {}; },
        promisify: function(fn) {
          return function() {
            var args = Array.prototype.slice.call(arguments);
            return new Promise(function(resolve, reject) {
              args.push(function(err, result) {
                if (err) reject(err); else resolve(result);
              });
              fn.apply(null, args);
            });
          };
        }
      };
    `;

    // Process shim
    const processShim = `
      module.exports = {
        env: {},
        cwd: function() { return '/'; },
        nextTick: function(fn) { setTimeout(fn, 0); },
        browser: true,
        version: '',
        versions: {},
        platform: 'browser',
        argv: [],
        stderr: { write: function(s) { console.error(s); } },
        stdout: { write: function(s) { console.log(s); } },
        on: function() { return this; },
        once: function() { return this; },
        off: function() { return this; },
        emit: function() {},
        binding: function() { throw new Error('process.binding is not supported'); }
      };
    `;

    // Buffer shim - basic implementation
    const bufferShim = `
      var Buffer = {
        isBuffer: function(obj) { return false; },
        from: function(data) { return new Uint8Array(data); },
        alloc: function(size) { return new Uint8Array(size); },
        allocUnsafe: function(size) { return new Uint8Array(size); },
        concat: function(list) {
          var totalLength = list.reduce(function(acc, buf) { return acc + buf.length; }, 0);
          var result = new Uint8Array(totalLength);
          var offset = 0;
          list.forEach(function(buf) { result.set(buf, offset); offset += buf.length; });
          return result;
        }
      };
      module.exports = { Buffer: Buffer };
      module.exports.Buffer = Buffer;
    `;

    // Assert shim
    const assertShim = `
      function assert(value, message) {
        if (!value) throw new Error(message || 'Assertion failed');
      }
      assert.ok = assert;
      assert.equal = function(a, b, msg) { if (a != b) throw new Error(msg || a + ' != ' + b); };
      assert.strictEqual = function(a, b, msg) { if (a !== b) throw new Error(msg || a + ' !== ' + b); };
      assert.notEqual = function(a, b, msg) { if (a == b) throw new Error(msg || a + ' == ' + b); };
      assert.deepEqual = function(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg); };
      assert.throws = function(fn, expected, msg) {
        try { fn(); throw new Error(msg || 'Expected function to throw'); } catch(e) {}
      };
      assert.fail = function(msg) { throw new Error(msg || 'Assert.fail()'); };
      module.exports = assert;
    `;

    // Node.js built-in modules to shim
    const nodeBuiltins: Record<string, string> = {
      'stream': streamShim,
      'events': eventsShim,
      'util': utilShim,
      'process': processShim,
      'buffer': bufferShim,
      'assert': assertShim,
      // Empty shims for modules that can't work in browser
      'fs': emptyShim,
      'path': `
        module.exports = {
          join: function() { return Array.prototype.slice.call(arguments).join('/').replace(/\\/+/g, '/'); },
          resolve: function() { return Array.prototype.slice.call(arguments).join('/').replace(/\\/+/g, '/'); },
          dirname: function(p) { return p.split('/').slice(0, -1).join('/') || '/'; },
          basename: function(p, ext) { var b = p.split('/').pop() || ''; if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; },
          extname: function(p) { var m = p.match(/\\.[^.]+$/); return m ? m[0] : ''; },
          normalize: function(p) { return p.replace(/\\/+/g, '/'); },
          isAbsolute: function(p) { return p[0] === '/'; },
          relative: function(from, to) { return to; },
          sep: '/',
          delimiter: ':'
        };
      `,
      'os': `
        module.exports = {
          platform: function() { return 'browser'; },
          type: function() { return 'Browser'; },
          arch: function() { return 'javascript'; },
          release: function() { return ''; },
          tmpdir: function() { return '/tmp'; },
          homedir: function() { return '/'; },
          hostname: function() { return 'localhost'; },
          cpus: function() { return []; },
          totalmem: function() { return 0; },
          freemem: function() { return 0; },
          loadavg: function() { return [0, 0, 0]; },
          uptime: function() { return 0; },
          networkInterfaces: function() { return {}; },
          EOL: '\\n'
        };
      `,
      'crypto': emptyShim,
      'http': emptyShim,
      'https': emptyShim,
      'net': emptyShim,
      'tls': emptyShim,
      'dns': emptyShim,
      'dgram': emptyShim,
      'child_process': emptyShim,
      'cluster': emptyShim,
      'readline': emptyShim,
      'repl': emptyShim,
      'tty': emptyShim,
      'vm': emptyShim,
      'zlib': emptyShim,
      'constants': 'module.exports = {};',
      'module': emptyShim,
      'domain': emptyShim,
      'punycode': emptyShim,
      'querystring': `
        module.exports = {
          parse: function(str) {
            var obj = {};
            str.split('&').forEach(function(pair) {
              var parts = pair.split('=');
              if (parts[0]) obj[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '');
            });
            return obj;
          },
          stringify: function(obj) {
            return Object.keys(obj).map(function(k) {
              return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]);
            }).join('&');
          }
        };
      `,
      'string_decoder': `
        function StringDecoder(encoding) { this.encoding = encoding || 'utf8'; }
        StringDecoder.prototype.write = function(buffer) { return String.fromCharCode.apply(null, buffer); };
        StringDecoder.prototype.end = function() { return ''; };
        module.exports = { StringDecoder: StringDecoder };
      `,
      'url': `
        module.exports = {
          parse: function(urlStr) {
            var a = document.createElement('a');
            a.href = urlStr;
            return {
              protocol: a.protocol,
              host: a.host,
              hostname: a.hostname,
              port: a.port,
              pathname: a.pathname,
              search: a.search,
              hash: a.hash,
              href: a.href
            };
          },
          format: function(obj) { return obj.href || ''; },
          resolve: function(from, to) { return new URL(to, from).href; }
        };
      `,
      'timers': `
        module.exports = {
          setTimeout: setTimeout,
          clearTimeout: clearTimeout,
          setInterval: setInterval,
          clearInterval: clearInterval,
          setImmediate: function(fn) { return setTimeout(fn, 0); },
          clearImmediate: clearTimeout
        };
      `
    };

    // Write all shims
    for (const name in nodeBuiltins) {
      if (Object.prototype.hasOwnProperty.call(nodeBuiltins, name)) {
        const code = nodeBuiltins[name];
        memoryFS.writeFile(`/node_modules/${name}/index.js`, code);
        memoryFS.writeFile(`/node_modules/${name}/package.json`, JSON.stringify({ name, main: 'index.js' }));
      }
    }
  }

  /** Reset all compilation data */
  resetModules(): void {
    this.preset = undefined;
    this.modules = new Map();
    this.resolverCache = new Map();
  }

  configureFS(opts: IFSOptions): void {
    if (opts.hasAsyncFileResolver) {
      this.iFrameFsLayer.enableIFrameFS();
    }
  }

  async initPreset(preset: string): Promise<void> {
    if (!this.preset) {
      this.preset = getPreset(preset);
      await this.preset.init(this);
    }
  }

  registerRuntime(id: string, code: string): void {
    const filepath = `/node_modules/__csb_runtimes/${id}.js`;
    this.fs.writeFile(filepath, code);
    const module = new Module(filepath, code, false, this);
    this.modules.set(filepath, module);
    this.runtimes.push(filepath);
  }

  getModule(filepath: string): Module | undefined {
    return this.modules.get(filepath);
  }

  enableHMR(): void {
    this.hasHMR = true;
  }

  getInitiators(id: string): Set<string> {
    return this.initiators.get(id) ?? new Set();
  }

  addInitiator(moduleId: string, initiatorId: string): void {
    const initiators = this.getInitiators(moduleId);
    initiators.add(initiatorId);
    this.initiators.set(moduleId, initiators);
  }

  async processPackageJSON(): Promise<void> {
    const foundPackageJSON = await this.fs.readFileAsync('/package.json');
    try {
      this.parsedPackageJSON = JSON.parse(foundPackageJSON);
    } catch (err) {
      // Makes the bundler a bit more error-prone to invalid pkg.json's
      if (!this.parsedPackageJSON) {
        throw err;
      }
    }
  }

  async resolveEntryPoint(): Promise<string> {
    if (!this.parsedPackageJSON) {
      throw new BundlerError('No parsed package.json found!');
    }

    if (!this.preset) {
      throw new BundlerError('Preset has not been loaded yet');
    }

    const potentialEntries = new Set(
      [
        this.parsedPackageJSON.main,
        this.parsedPackageJSON.source,
        this.parsedPackageJSON.module,
        ...this.preset.defaultEntryPoints,
      ].filter((e) => typeof e === 'string')
    );

    for (let potentialEntry of potentialEntries) {
      if (typeof potentialEntry === 'string') {
        try {
          // Normalize path
          const entryPoint =
            potentialEntry[0] !== '.' && potentialEntry[0] !== '/' ? `./${potentialEntry}` : potentialEntry;
          const resolvedEntryPont = await this.resolveAsync(entryPoint, '/index.js');
          return resolvedEntryPont;
        } catch (err) {
          logger.debug(`Could not resolve entrypoint ${potentialEntry}`);
          logger.debug(err);
        }
      }
    }
    throw new BundlerError(
      `Could not resolve entry point, potential entrypoints: ${Array.from(potentialEntries).join(
        ', '
      )}. You can define one by changing the "main" field in package.json.`
    );
  }

  async loadNodeModules() {
    if (!this.parsedPackageJSON) {
      throw new BundlerError('No parsed pkg.json found!');
    }

    let dependencies = this.parsedPackageJSON.dependencies;
    if (dependencies) {
      dependencies = nullthrows(
        this.preset,
        'Preset needs to be defined when loading node modules'
      ).augmentDependencies(dependencies);

      await this.moduleRegistry.fetchManifest(dependencies);

      // Load all modules
      await this.moduleRegistry.preloadModules();
      await this.moduleRegistry.loadModuleDependencies();
    }
  }

  async resolveAsync(
    specifier: string,
    filename: string,
    extensions: string[] = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte', '.html', '.htm']
  ): Promise<string> {
    try {
      const resolved = await resolveAsync(specifier, {
        filename,
        extensions,
        isFile: this.fs.isFile,
        readFile: this.fs.readFile,
        resolverCache: this.resolverCache,
      });
      return resolved;
    } catch (err) {
      logger.error(err);
      logger.error(Array.from(this.modules));
      // logger.error(Array.from(this.fs.files));
      throw err;
    }
  }

  private async _transformModule(path: string): Promise<Module> {
    let module = this.modules.get(path);
    if (module) {
      if (module.compiled != null) {
        return Promise.resolve(module);
      } else {
        // compilation got reset, we re-read the source to ensure it's the latest version.
        // reset happens mostly when we receive changes from the editor, so this ensures we actually output the changes...
        module.source = await this.fs.readFileAsync(path);
      }
    } else {
      const content = await this.fs.readFileAsync(path);
      module = new Module(path, content, false, this);
      this.modules.set(path, module);
    }
    await module.compile();
    for (let dep of module.dependencies) {
      const resolvedDependency = await this.resolveAsync(dep, module.filepath);
      this.transformModule(resolvedDependency);
    }
    return module;
  }

  /** Transform file at a certain absolute path */
  async transformModule(path: string): Promise<Module> {
    let module = this.modules.get(path);
    if (module && module.compiled != null) {
      return Promise.resolve(module);
    }
    return this.transformationQueue.addEntry(path, () => {
      return this._transformModule(path);
    });
  }

  async moduleFinishedPromise(id: string, moduleIds: Set<string> = new Set()): Promise<any> {
    if (moduleIds.has(id)) return;

    const foundPromise = this.transformationQueue.getItem(id);
    if (foundPromise) {
      await foundPromise;
    }

    const asset = this.modules.get(id);
    if (!asset) {
      throw new BundlerError(`Asset not in the compilation tree ${id}`);
    } else {
      if (asset.compilationError != null) {
        throw asset.compilationError;
      } else if (asset.compiled == null) {
        throw new BundlerError(`Asset ${id} has not been compiled`);
      }
    }

    moduleIds.add(id);

    for (const dep of asset.dependencies) {
      if (!moduleIds.has(dep)) {
        try {
          await this.moduleFinishedPromise(dep, moduleIds);
        } catch (err) {
          logger.debug(`Failed awaiting transpilation ${dep} required by ${id}`);

          throw err;
        }
      }
    }
  }

  /** writes any new files and returns a list of updated modules */
  writeNewFiles(files: ISandboxFile[]): string[] {
    const res: string[] = [];
    for (let file of files) {
      try {
        const content = this.fs.readFileSync(file.path);
        if (content !== file.code) {
          res.push(file.path);
        }
      } catch (err) {
        // file does not exist
      }
      this.fs.writeFile(file.path, file.code);
    }
    return res;
  }

  async compile(files: ISandboxFile[]): Promise<() => any> {
    if (!this.preset) {
      throw new BundlerError('Cannot compile before preset has been initialized');
    }

    this.onStatusChangeEmitter.fire('installing-dependencies');

    // TODO: Have more fine-grained cache invalidation for the resolver
    // Reset resolver cache
    this.resolverCache = new Map();
    this.fs.resetCache();

    let changedFiles: string[] = [];
    if (!this.isFirstLoad) {
      logger.debug('Started incremental compilation');

      changedFiles = this.writeNewFiles(files);

      if (!changedFiles.length) {
        logger.debug('Skipping compilation, no changes detected');
        return () => {};
      }

      // If it's a change and we don't have any hmr modules we simply reload the application
      if (!this.hasHMR) {
        logger.debug('HMR is not enabled, doing a full page refresh');
        window.location.reload();
        return () => {};
      }
    } else {
      for (let file of files) {
        this.fs.writeFile(file.path, file.code);
      }
    }

    if (changedFiles.length) {
      const promises = [];
      for (let changedFile of changedFiles) {
        const module = this.getModule(changedFile);
        if (module) {
          module.resetCompilation();
          promises.push(this.transformModule(changedFile));
        }
      }
      await Promise.all(promises);
    }

    const pkgJsonChanged = changedFiles.find((f) => f === '/package.json');
    if (this.isFirstLoad || pkgJsonChanged) {
      logger.debug('Loading node modules');
      await this.processPackageJSON();

      const depString = Object.entries(this.parsedPackageJSON?.dependencies || {})
        .map((v) => `${v[0]}:${v[1]}`)
        .sort()
        .join(',');

      if (this._previousDepString != null && depString !== this._previousDepString) {
        logger.debug('Dependencies changed, reloading');
        location.reload();
        return () => {};
      }

      this._previousDepString = depString;

      await this.loadNodeModules();
    }

    this.onStatusChangeEmitter.fire('transpiling');

    // Check if this is an HTML-only project
    const isHTMLOnly = this.isHTMLOnlyProject();
    logger.debug('Is HTML-only project:', isHTMLOnly);

    if (isHTMLOnly) {
      // For HTML-only projects, just return an empty evaluate function
      // The HTML will be rendered by replaceHTML()
      logger.debug('HTML-only project detected, skipping JS bundling');

      this.messageBus.sendMessage('state', { state: { transpiledModules: {} } });

      return () => {
        logger.debug('HTML-only project - no JS to evaluate');
        this.isFirstLoad = false;
      };
    }

    // Transform runtimes
    if (this.isFirstLoad) {
      for (const runtime of this.runtimes) {
        await this.transformModule(runtime);
        await this.moduleFinishedPromise(runtime);
      }
    }

    // Resolve entrypoints
    const resolvedEntryPoint = await this.resolveEntryPoint();
    logger.debug('Resolved entrypoint:', resolvedEntryPoint);

    // Transform entrypoint and deps
    const entryModule = await this.transformModule(resolvedEntryPoint);
    await this.moduleFinishedPromise(resolvedEntryPoint);
    logger.debug('Bundling finished, manifest:');
    logger.debug(this.modules);

    entryModule.isEntry = true;

    const transpiledModules = Array.from(this.modules, ([name, value]) => {
      return {
        /**
         * TODO: adds trailing for backwards compatibility
         */
        [name + ':']: {
          source: {
            isEntry: entryModule.filepath === value.filepath,
            fileName: value.filepath,
            compiledCode: value.compiled,
          },
        },
      };
    }).reduce((prev, curr) => {
      return { ...prev, ...curr };
    }, {});

    this.messageBus.sendMessage('state', { state: { transpiledModules } });

    return () => {
      // Evaluate
      logger.debug('Evaluating...');

      if (this.isFirstLoad) {
        for (const runtime of this.runtimes) {
          const module = this.modules.get(runtime);
          if (!module) {
            throw new BundlerError(`Runtime ${runtime} is not defined`);
          } else {
            logger.debug(`Loading runtime ${runtime}...`);
            module.evaluate();
          }
        }

        entryModule.evaluate();
        this.isFirstLoad = false;
      } else {
        this.modules.forEach((module) => {
          if (module.hot.hmrConfig?.isDirty()) {
            module.evaluate();
          }
        });

        // TODO: Validate that this logic actually works...
        // Check if any module has been invalidated, because in that case we need to
        // restart evaluation.
        const invalidatedModules = Object.values(this.modules).filter((m: Module) => {
          if (m.hot.hmrConfig?.invalidated) {
            m.resetCompilation();
            this.transformModule(m.filepath);
            return true;
          }

          return false;
        });

        if (invalidatedModules.length > 0) {
          return this.compile(files);
        }
      }
    };
  }

  // TODO: Support template languages...
  getHTMLEntry(): string {
    const foundHTMLFilepath = ['/index.html', '/public/index.html'].find((filepath) => this.fs.isFileSync(filepath));

    if (foundHTMLFilepath) {
      return this.fs.readFileSync(foundHTMLFilepath);
    } else {
      if (!this.preset) {
        throw new BundlerError('Bundler has not been initialized with a preset');
      }
      return this.preset.defaultHtmlBody;
    }
  }

  /** Check if this is an HTML-only project (no JS entry point) */
  isHTMLOnlyProject(): boolean {
    const htmlExists = this.fs.isFileSync('/index.html') || this.fs.isFileSync('/public/index.html');
    if (!htmlExists) return false;

    // Check if there's a JS entry point
    const jsEntryPoints = ['index.js', 'index.ts', 'index.jsx', 'index.tsx', 'src/index.js', 'src/index.ts', 'src/index.jsx', 'src/index.tsx'];
    for (const entry of jsEntryPoints) {
      if (this.fs.isFileSync(`/${entry}`)) {
        return false;
      }
    }

    // Check package.json main field
    if (this.parsedPackageJSON?.main) {
      const mainFile = this.parsedPackageJSON.main.startsWith('/')
        ? this.parsedPackageJSON.main
        : `/${this.parsedPackageJSON.main}`;
      if (this.fs.isFileSync(mainFile) && !mainFile.endsWith('.html')) {
        return false;
      }
    }

    return true;
  }

  replaceHTML() {
    const html = this.getHTMLEntry() ?? '<div id="root"></div>';
    if (this.lastHTML) {
      if (this.lastHTML !== html) {
        window.location.reload();
      }
      return;
    } else {
      this.lastHTML = html;
      replaceHTML(html);
    }
  }
}
