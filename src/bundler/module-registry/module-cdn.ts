import { decode as decodeMsgPack } from '@msgpack/msgpack';
import urlJoin from 'url-join';

import { retryFetch } from '../../utils/fetch';
import * as logger from '../../utils/logger';
import { DepMap } from '.';

const CDN_ROOT = 'https://sandpack-cdn-staging.blazingly.io/';
const ESM_SH_ROOT = 'https://esm.sh/';
const SKYPACK_ROOT = 'https://cdn.skypack.dev/';
const UNPKG_ROOT = 'https://unpkg.com/';

export interface IResolvedDependency {
  // name
  n: string;
  // version
  v: string;
  // depth
  d: number;
}

const CDN_VERSION = 5;

function encodePayload(payload: string): string {
  return btoa(`${CDN_VERSION}(${payload})`);
}

export async function fetchManifest(deps: DepMap): Promise<IResolvedDependency[]> {
  try {
    const encoded_manifest = encodePayload(JSON.stringify(deps));
    const result = await retryFetch(urlJoin(CDN_ROOT, `/dep_tree/${encoded_manifest}`), {
      maxRetries: 3,
      retryDelay: 500,
    });
    const buffer = await result.arrayBuffer();
    return decodeMsgPack(buffer) as IResolvedDependency[];
  } catch (err) {
    logger.warn('Sandpack CDN failed, using fallback manifest generation');
    // Generate manifest from deps directly
    const entries: Array<[string, string]> = [];
    for (const key in deps) {
      if (Object.prototype.hasOwnProperty.call(deps, key)) {
        entries.push([key, deps[key]]);
      }
    }
    return entries.map(([name, version]: [string, string], index: number) => ({
      n: name,
      v: version.replace(/[\^~>=<]/g, '') || 'latest',
      d: index,
    }));
  }
}

export type CDNModuleFileType = ICDNModuleFile | number;

export interface ICDNModuleFile {
  // content
  c: string;
  // dependencies
  d: string[];
  // is transpiled
  t: boolean;
}

export interface ICDNModule {
  // files
  f: Record<string, CDNModuleFileType>;
  // transient dependencies
  m: string[];
}

// Fetch module from esm.sh
async function fetchFromEsmSh(name: string, version: string): Promise<string> {
  const url = `${ESM_SH_ROOT}${name}@${version}?bundle`;
  const response = await retryFetch(url, { maxRetries: 2 });
  return response.text();
}

// Fetch module from Skypack
async function fetchFromSkypack(name: string, version: string): Promise<string> {
  const url = `${SKYPACK_ROOT}${name}@${version}?min`;
  const response = await retryFetch(url, { maxRetries: 2 });
  return response.text();
}

// Fetch module from unpkg
async function fetchFromUnpkg(name: string, version: string): Promise<string> {
  // Try to get the package.json first to find the main file
  try {
    const pkgUrl = `${UNPKG_ROOT}${name}@${version}/package.json`;
    const pkgResponse = await retryFetch(pkgUrl, { maxRetries: 2 });
    const pkg = await pkgResponse.json();

    const mainFile = pkg.module || pkg.main || 'index.js';
    const mainUrl = `${UNPKG_ROOT}${name}@${version}/${mainFile}`;
    const response = await retryFetch(mainUrl, { maxRetries: 2 });
    return response.text();
  } catch {
    // Fallback to direct URL
    const url = `${UNPKG_ROOT}${name}@${version}`;
    const response = await retryFetch(url, { maxRetries: 2 });
    return response.text();
  }
}

export async function fetchModule(name: string, version: string): Promise<ICDNModule> {
  // Try Sandpack CDN first
  try {
    const specifier = `${name}@${version}`;
    const encoded_specifier = encodePayload(specifier);
    const result = await retryFetch(urlJoin(CDN_ROOT, `/package/${encoded_specifier}`), { maxRetries: 2 });
    const buffer = await result.arrayBuffer();
    return decodeMsgPack(buffer) as ICDNModule;
  } catch (err) {
    logger.warn(`Sandpack CDN failed for ${name}@${version}, trying fallback CDNs`);
  }

  // Try fallback CDNs
  let code: string | null = null;

  // Try esm.sh first (best for modern ESM)
  try {
    code = await fetchFromEsmSh(name, version);
    logger.debug(`Fetched ${name}@${version} from esm.sh`);
  } catch {
    logger.debug(`esm.sh failed for ${name}@${version}`);
  }

  // Try Skypack
  if (!code) {
    try {
      code = await fetchFromSkypack(name, version);
      logger.debug(`Fetched ${name}@${version} from Skypack`);
    } catch {
      logger.debug(`Skypack failed for ${name}@${version}`);
    }
  }

  // Try unpkg as last resort
  if (!code) {
    try {
      code = await fetchFromUnpkg(name, version);
      logger.debug(`Fetched ${name}@${version} from unpkg`);
    } catch {
      logger.debug(`unpkg failed for ${name}@${version}`);
    }
  }

  if (!code) {
    throw new Error(`Failed to fetch module ${name}@${version} from all CDNs`);
  }

  // Convert to ICDNModule format
  return {
    f: {
      'index.js': {
        c: code,
        d: [],
        t: true,
      },
    },
    m: [],
  };
}
