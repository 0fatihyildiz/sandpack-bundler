import { BundlerError } from '../../errors/BundlerError';
import { Bundler } from '../bundler';
import { Evaluation } from './Evaluation';
import { HotContext } from './hot';

// Node.js built-in modules - these should resolve to our shims
const NODE_BUILTIN_MODULES = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'https',
  'module', 'net', 'os', 'path', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'tty',
  'url', 'util', 'vm', 'zlib', 'process', '_stream_duplex', '_stream_passthrough',
  '_stream_readable', '_stream_transform', '_stream_writable'
]);

function getBuiltinShimPath(specifier: string): string | null {
  // Handle node: prefix
  let moduleName = specifier;
  if (moduleName.startsWith('node:')) {
    moduleName = moduleName.slice(5);
  }

  // Get the base module name (e.g., 'stream' from 'stream/promises')
  const baseName = moduleName.split('/')[0];

  if (NODE_BUILTIN_MODULES.has(baseName)) {
    return `/node_modules/${baseName}/index.js`;
  }

  return null;
}

export interface IDependencyEvent {
  specifier: string;
}

export class Module {
  id: string;
  filepath: string;
  isEntry = false;
  source: string;
  compiled: string | null;
  bundler: Bundler;
  evaluation: Evaluation | null = null;
  hot: HotContext;

  compilationError: BundlerError | null = null;

  dependencies: Set<string>;
  // Keeping this seperate from dependencies as there might be duplicates otherwise
  dependencyMap: Map<string, string>;

  constructor(filepath: string, source: string, isCompiled: boolean = false, bundler: Bundler) {
    this.id = filepath;
    this.filepath = filepath;
    this.source = source;
    this.compiled = isCompiled ? source : null;
    this.dependencies = new Set();
    this.dependencyMap = new Map();
    this.bundler = bundler;
    this.hot = new HotContext(this);
  }

  get initiators() {
    return this.bundler.getInitiators(this.id);
  }

  isHot(): boolean {
    return Boolean(this.hot.hmrConfig?.isHot());
  }

  /** Add dependency */
  async addDependency(depSpecifier: string): Promise<void> {
    // Check if this is a Node.js built-in module - use shim path directly
    const shimPath = getBuiltinShimPath(depSpecifier);
    if (shimPath) {
      this.dependencies.add(shimPath);
      this.dependencyMap.set(depSpecifier, shimPath);
      this.bundler.addInitiator(shimPath, this.id);
      return;
    }

    const resolved = await this.bundler.resolveAsync(depSpecifier, this.filepath);
    this.dependencies.add(resolved);
    this.dependencyMap.set(depSpecifier, resolved);
    this.bundler.addInitiator(resolved, this.id);
  }

  async compile(): Promise<void> {
    if (this.compiled != null || this.compilationError != null) {
      return;
    }
    try {
      const preset = this.bundler.preset;
      if (!preset) {
        throw new Error('Preset has not been initialized');
      }

      const transformers = preset.getTransformers(this);
      if (!transformers.length) {
        throw new Error(`No transformers found for ${this.filepath}`);
      }

      let code = this.source;
      for (const [transformer, config] of transformers) {
        const transformationResult = await transformer.transform(
          {
            module: this,
            code,
          },
          config
        );

        if (transformationResult instanceof BundlerError) {
          this.compilationError = transformationResult;
        } else {
          code = transformationResult.code;
          await Promise.all(
            Array.from(transformationResult.dependencies).map((d) => {
              return this.addDependency(d);
            })
          );
        }
      }

      this.compiled = code;
    } catch (err: any) {
      this.compilationError = err;
    }
  }

  resetCompilation(): void {
    // We always reset compilation errors as this will be non-null while compilation is null
    this.compilationError = null;

    // Skip modules that don't have any compilation
    if (this.compiled == null) return;

    this.compiled = null;
    this.evaluation = null;

    if (this.hot.hmrConfig && this.hot.hmrConfig.isHot()) {
      this.hot.hmrConfig.setDirty(true);
    } else {
      // for (let initiator of this.initiators) {
      //   const module = this.bundler.getModule(initiator);
      //   module?.resetCompilation();
      // }

      // // If this is an entry we want all direct entries to be reset as well.
      // // Entries generally have side effects
      // if (this.isEntry) {
      //   for (let dependency of this.dependencies) {
      //     const module = this.bundler.getModule(dependency);
      //     module?.resetCompilation();
      //   }
      // }

      location.reload();
    }

    this.bundler.transformModule(this.filepath);
  }

  evaluate(): Evaluation {
    if (this.evaluation) {
      return this.evaluation;
    }

    if (this.hot.hmrConfig) {
      // this.bundler.setHmrStatus('dispose');
      // Call module.hot.dispose handler
      // https://webpack.js.org/api/hot-module-replacement/#dispose-or-adddisposehandler-
      this.hot.hmrConfig.callDisposeHandler();
      // this.bundler.setHmrStatus('apply');
    }

    // Reset hmr context while keeping the previous hot data
    this.hot = this.hot.clone();
    this.evaluation = new Evaluation(this);

    // this.bundler.setHmrStatus('apply');
    if (this.hot.hmrConfig && this.hot.hmrConfig.isHot()) {
      this.hot.hmrConfig.setDirty(false);
      this.hot.hmrConfig.callAcceptCallback();
    }
    // this.bundler.setHmrStatus('idle');

    return this.evaluation;
  }
}
