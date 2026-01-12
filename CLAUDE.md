# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is the Sandpack Bundler - a browser-based JavaScript bundler that runs inside an iframe to power CodeSandbox's Sandpack. It compiles and executes code in real-time with Hot Module Replacement (HMR) support.

## Commands

```bash
# Install dependencies
yarn

# Development server (serves at http://localhost:1234)
yarn dev

# Production build
yarn build

# Run tests
yarn test

# Type checking
yarn typecheck

# Linting
yarn lint

# Format code
yarn format
```

## Architecture

### Core Flow

1. **SandpackInstance** ([src/index.ts](src/index.ts)) - Entry point that initializes the bundler and handles parent iframe communication
2. **Bundler** ([src/bundler/bundler.ts](src/bundler/bundler.ts)) - Orchestrates compilation: resolves entry points, manages modules, coordinates transformation, and triggers evaluation
3. **Module** ([src/bundler/module/Module.ts](src/bundler/module/Module.ts)) - Represents a single file with source, compiled output, dependencies, and HMR state

### Key Systems

**FileSystem** ([src/FileSystem/](src/FileSystem/)) - Layered virtual filesystem:
- `MemoryFSLayer` - In-memory file storage for user files
- `IFrameFSLayer` - Async file resolution via parent iframe communication
- `NodeModuleFSLayer` - Serves pre-compiled node_modules from CDN

**Presets** ([src/bundler/presets/](src/bundler/presets/)) - Configure transformers per file type:
- `ReactPreset` - Babel + React Refresh for .jsx/.tsx, CSS handling
- `SolidPreset` - Solid.js specific transforms
- Presets define `mapTransformers()` to route files to appropriate transforms

**Transformers** ([src/bundler/transforms/](src/bundler/transforms/)) - File compilation:
- `BabelTransformer` - JavaScript/TypeScript via @babel/standalone
- `CSSTransformer` - CSS imports via PostCSS
- `StyleTransformer` - Injects CSS into DOM
- `ReactRefreshTransformer` - HMR for React components

**Resolver** ([src/resolver/resolver.ts](src/resolver/resolver.ts)) - Node-style module resolution supporting:
- Relative/absolute imports
- Node modules from `/node_modules`
- Package.json aliases and exports
- tsconfig/jsconfig paths

**ModuleRegistry** ([src/bundler/module-registry/](src/bundler/module-registry/)) - Fetches pre-compiled node_modules from CDN via manifest API

**Protocol** ([src/protocol/](src/protocol/)) - Parent iframe communication:
- `IFrameParentMessageBus` handles compile requests, status updates, errors
- Messages include: compile, refresh, console, resize, state

### Compilation Pipeline

1. Parent sends `compile` message with files
2. Bundler writes files to FS, initializes preset
3. Fetches node_modules manifest and preloads dependencies
4. Resolves entry point from package.json (main/source/module) or defaults
5. Recursively transforms entry + dependencies via preset's transformers
6. Returns evaluation function that executes compiled modules
7. HMR updates re-evaluate only dirty modules
