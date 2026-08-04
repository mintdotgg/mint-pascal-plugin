# Mint Pascal Plugin Changelog

User-facing changes for each public `@mint/pascal-plugin` release are recorded here.

<!-- releases -->

## 0.1.5 - 2026-08-04

### Harden Pascal host authentication

- Uses a configured Pascal origin for OAuth redirects, mutation checks, and secure cookies instead of forwarded request headers.
- Fails closed when the host does not provide a trusted origin.
- Adds verified compatibility with Pascal 1.0.0-beta.4 and a bounded prerelease peer range.

## 0.1.4 - 2026-08-04

### Support Pascal 1.0.0-beta.3

- Adds verified compatibility with Pascal 1.0.0-beta.3 while retaining 1.0.0-beta.1 and 0.9.2 support.

## 0.1.3 - 2026-08-04

### Reliable optimized placement

- Refreshes completed model state before placement so auto-optimized models add directly without duplicate work.
- Reconciles concurrent or already-completed optimizations instead of showing a false failure.
- Presents a shorter public README with a centered plugin preview and clear integration path.

## 0.1.2 - 2026-08-04

### Make host setup production-safe

- Use public Mint endpoints by default while preserving explicit endpoint overrides for internal local development.
- Ship a concise Pascal maintainer handoff with every release.

## 0.1.1 - 2026-08-03

### Add diagnosable plugin releases

- Display the exact Mint Pascal Plugin version in the panel for faster support diagnostics.
- Include synchronized release notes with every plugin version.

## 0.1.0 - 2026-08-03

### Complete Mint asset workflow

- Sign in securely with Mint through OAuth without exposing access or refresh tokens to browser JavaScript.
- Generate 3D models from prompts, local reference images, or imported public image URLs and follow concurrent work inside Pascal.
- Browse model details, prompts, geometry metrics, file sizes, and durable Mint links without leaving the plugin panel.
- Optimize existing models before placement and add optimized GLBs through Pascal's native scene tools.
