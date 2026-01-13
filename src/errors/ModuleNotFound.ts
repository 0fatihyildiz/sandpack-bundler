import { SandpackError } from './SandpackError';

export class ModuleNotFoundError extends SandpackError {
  code = 'MODULE_NOT_FOUND';

  filepath: string;
  parent: string;

  constructor(filepath: string, parent: string) {
    super(`Cannot find module '${filepath}' from '${parent}'`);
    this.parent = parent;
    this.filepath = filepath;

    // Debug: Log stack trace to see where this error originated
    console.error('[ModuleNotFoundError] Module:', filepath, 'Parent:', parent);
    console.error('[ModuleNotFoundError] Stack:', new Error().stack);
  }
}
