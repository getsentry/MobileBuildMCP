import type { RenderHints, ToolHandlerContext } from '../rendering/types.ts';
import type {
  AppPathDomainResult,
  AppPathRequest,
  BasicDiagnostics,
  BuildTarget,
  BundleIdDomainResult,
} from '../types/domain-results.ts';
import { extractQueryDiagnostics } from './xcodebuild-error-utils.ts';

export const APP_PATH_STRUCTURED_OUTPUT_SCHEMA = 'mobilebuildmcp.output.app-path';
export const BUNDLE_ID_STRUCTURED_OUTPUT_SCHEMA = 'mobilebuildmcp.output.bundle-id';

export function appPathErrorMessages(rawMessage: string): string[] {
  return extractQueryDiagnostics(rawMessage).errors.map((error) => error.message);
}

export function buildAppPathSuccess(
  appPath: string,
  request: AppPathRequest,
  target: BuildTarget,
  durationMs?: number,
): AppPathDomainResult {
  return {
    kind: 'app-path',
    didError: false,
    error: null,
    request,
    summary: { status: 'SUCCEEDED', target, ...(durationMs !== undefined ? { durationMs } : {}) },
    artifacts: { appPath },
  };
}

export function buildAppPathFailure(
  rawMessage: string,
  request: AppPathRequest,
  target: BuildTarget,
  errorLabel: string,
): AppPathDomainResult {
  return {
    kind: 'app-path',
    didError: true,
    error: errorLabel,
    request,
    summary: { status: 'FAILED', target },
    diagnostics: extractQueryDiagnostics(rawMessage),
  };
}

export function getAppPathArtifact(result: AppPathDomainResult): string | null {
  if ('artifacts' in result && result.artifacts && 'appPath' in result.artifacts) {
    return result.artifacts.appPath;
  }
  return null;
}

export function setAppPathStructuredOutput(
  ctx: ToolHandlerContext,
  result: AppPathDomainResult,
): void {
  ctx.structuredOutput = {
    result,
    schema: APP_PATH_STRUCTURED_OUTPUT_SCHEMA,
    schemaVersion: '2',
  };
}

export function buildBundleIdResult(
  appPath: string,
  bundleId?: string,
  error?: string,
  diagnostics?: BasicDiagnostics,
): BundleIdDomainResult {
  return {
    kind: 'bundle-id',
    didError: typeof error === 'string',
    error: error ?? null,
    artifacts: {
      appPath,
      ...(bundleId ? { bundleId } : {}),
    },
    ...(diagnostics ? { diagnostics } : {}),
  };
}

export function setBundleIdStructuredOutput(
  ctx: ToolHandlerContext,
  result: BundleIdDomainResult,
  renderHints?: RenderHints,
): void {
  ctx.structuredOutput = {
    result,
    schema: BUNDLE_ID_STRUCTURED_OUTPUT_SCHEMA,
    schemaVersion: '2',
    ...(renderHints ? { renderHints } : {}),
  };
}
