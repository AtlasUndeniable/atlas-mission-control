/**
 * Lets plain Node load src/ modules the way Next's bundler does.
 *
 * Two specifier forms in src/ do not resolve under Node's ESM rules:
 *   - "next/server": next's package.json carries no ESM exports map, so the
 *     bare specifier used in src has to be pointed at the real file.
 *   - "./lib/artifact-pilot-auth" and friends: TypeScript and Next resolve an
 *     extensionless relative import; Node requires the extension. Rather than
 *     de-idiomatise the src imports, the extension is added here.
 *
 * Call this before the dynamic import of the module under test. Registering
 * the hook is what the five middleware tests each did inline for next/server
 * only, which is why they failed to load src/middleware.ts at all under
 * Node 25 once it grew an extensionless import.
 */
import { registerHooks } from "node:module";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];
const RELATIVE = /^\.{1,2}\//;
const HAS_EXTENSION = /\.[cm]?[jt]sx?$/;

export function registerSrcModuleResolve(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "next/server") return nextResolve("next/server.js", context);
      if (RELATIVE.test(specifier) && !HAS_EXTENSION.test(specifier)) {
        for (const extension of SOURCE_EXTENSIONS) {
          try {
            return nextResolve(specifier + extension, context);
          } catch {
            // try the next extension; fall through to the unmodified specifier
          }
        }
      }
      return nextResolve(specifier, context);
    },
  });
}
