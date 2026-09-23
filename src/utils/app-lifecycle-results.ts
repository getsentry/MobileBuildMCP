import type { ToolHandlerContext } from '../rendering/types.ts';
import type {
  InstallResultDomainResult,
  LaunchResultDomainResult,
  StopResultDomainResult,
} from '../types/domain-results.ts';
import { createBasicDiagnostics } from './diagnostics.ts';

export const INSTALL_RESULT_STRUCTURED_OUTPUT_SCHEMA = 'mobilebuildmcp.output.install-result';
export const LAUNCH_RESULT_STRUCTURED_OUTPUT_SCHEMA = 'mobilebuildmcp.output.launch-result';
export const STOP_RESULT_STRUCTURED_OUTPUT_SCHEMA = 'mobilebuildmcp.output.stop-result';

export type InstallResultArtifacts = InstallResultDomainResult['artifacts'];
export type LaunchResultArtifacts = LaunchResultDomainResult['artifacts'];
export type StopResultArtifacts = StopResultDomainResult['artifacts'];
export type StopResultDiagnosticMessage = StopResultDomainResult['diagnostics']['errors'][number];

type LaunchFailureTarget = 'simulator' | 'device' | 'macos';

function stripKnownPrefix(message: string, prefixes: readonly string[]): string {
  for (const prefix of prefixes) {
    if (message.startsWith(prefix)) {
      return message.slice(prefix.length).trim();
    }
  }
  return message;
}

function isMacLaunch(artifacts: LaunchResultArtifacts, target?: LaunchFailureTarget): boolean {
  if (target) {
    return target === 'macos';
  }

  return !('simulatorId' in artifacts) && !('deviceId' in artifacts);
}

function isMacStop(artifacts: StopResultArtifacts): boolean {
  return !('simulatorId' in artifacts) && !('deviceId' in artifacts) && 'appName' in artifacts;
}

export function buildInstallSuccess(artifacts: InstallResultArtifacts): InstallResultDomainResult {
  return {
    kind: 'install-result',
    didError: false,
    error: null,
    summary: { status: 'SUCCEEDED' },
    artifacts,
    diagnostics: { warnings: [], errors: [] },
  };
}

export function buildInstallFailure(
  artifacts: InstallResultArtifacts,
  message: string,
): InstallResultDomainResult {
  const diagnosticMessage = stripKnownPrefix(message, [
    'Failed to install app:',
    'Failed to install app on device:',
    'Install app in simulator operation failed:',
  ]);

  return {
    kind: 'install-result',
    didError: true,
    error: 'Failed to install app.',
    summary: { status: 'FAILED' },
    artifacts,
    diagnostics: createBasicDiagnostics({ errors: [diagnosticMessage] }),
  };
}

export function setInstallResultStructuredOutput(
  ctx: ToolHandlerContext,
  result: InstallResultDomainResult,
): void {
  ctx.structuredOutput = {
    result,
    schema: INSTALL_RESULT_STRUCTURED_OUTPUT_SCHEMA,
    schemaVersion: '2',
  };
}

export function buildLaunchSuccess(artifacts: LaunchResultArtifacts): LaunchResultDomainResult {
  return {
    kind: 'launch-result',
    didError: false,
    error: null,
    summary: { status: 'SUCCEEDED' },
    artifacts,
    diagnostics: { warnings: [], errors: [] },
  };
}

export function buildLaunchFailure(
  artifacts: LaunchResultArtifacts,
  message: string,
  options: { target?: LaunchFailureTarget } = {},
): LaunchResultDomainResult {
  const diagnosticMessage = stripKnownPrefix(message, [
    'Failed to launch app:',
    'Failed to launch app on device:',
    'Launch app in simulator operation failed:',
    'Launch macOS app operation failed:',
  ]);

  return {
    kind: 'launch-result',
    didError: true,
    error: isMacLaunch(artifacts, options.target)
      ? 'Failed to launch macOS app.'
      : 'Failed to launch app.',
    summary: { status: 'FAILED' },
    artifacts,
    diagnostics: createBasicDiagnostics({ errors: [diagnosticMessage] }),
  };
}

export function setLaunchResultStructuredOutput(
  ctx: ToolHandlerContext,
  result: LaunchResultDomainResult,
): void {
  ctx.structuredOutput = {
    result,
    schema: LAUNCH_RESULT_STRUCTURED_OUTPUT_SCHEMA,
    schemaVersion: '2',
  };
}

export function buildStopSuccess(
  artifacts: StopResultArtifacts,
  diagnosticErrors: StopResultDiagnosticMessage[] = [],
): StopResultDomainResult {
  return {
    kind: 'stop-result',
    didError: false,
    error: null,
    summary: { status: 'SUCCEEDED' },
    artifacts,
    diagnostics: { warnings: [], errors: diagnosticErrors },
  };
}

export function buildStopFailure(
  artifacts: StopResultArtifacts,
  message: string,
  diagnosticErrors: StopResultDiagnosticMessage[] = [],
): StopResultDomainResult {
  const diagnosticMessage = stripKnownPrefix(message, [
    'Failed to stop app:',
    'Failed to stop app on device:',
    'Stop app in simulator operation failed:',
    'Stop macOS app operation failed:',
  ]);
  const diagnostics =
    diagnosticErrors.length > 0
      ? { warnings: [], errors: diagnosticErrors }
      : createBasicDiagnostics({ errors: [diagnosticMessage] });

  return {
    kind: 'stop-result',
    didError: true,
    error: isMacStop(artifacts) ? 'Failed to stop macOS app.' : 'Failed to stop app.',
    summary: { status: 'FAILED' },
    artifacts,
    diagnostics,
  };
}

export function setStopResultStructuredOutput(
  ctx: ToolHandlerContext,
  result: StopResultDomainResult,
): void {
  ctx.structuredOutput = {
    result,
    schema: STOP_RESULT_STRUCTURED_OUTPUT_SCHEMA,
    schemaVersion: '2',
  };
}
