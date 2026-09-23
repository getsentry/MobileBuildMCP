import type { RenderHints, ToolHandlerContext } from '../../../../rendering/types.ts';
import type {
  BasicDiagnostics,
  CapturePayload,
  CaptureResultDomainResult,
  UiAction,
  UiActionResultDomainResult,
} from '../../../../types/domain-results.ts';
import type {
  RuntimeElementV1,
  RuntimeSnapshotV1,
  UiAutomationRecoverableError,
  UiAutomationRecoverableErrorCode,
  UiWaitMatch,
} from '../../../../types/ui-snapshot.ts';
import { AXE_NOT_AVAILABLE_MESSAGE } from '../../../../utils/axe-helpers.ts';
import { createBasicDiagnostics } from '../../../../utils/diagnostics.ts';
import { AxeError, DependencyError, SystemError } from '../../../../utils/errors.ts';
import {
  createRuntimeSnapshotNextSteps,
  getForegroundCompletionSuppressedRuntimeTargetRefs,
} from './runtime-next-steps.ts';
import type {
  RuntimeSnapshotNextStepActionContext,
  RuntimeSnapshotNextStepActionTarget,
} from './runtime-next-steps.ts';

const UI_ACTION_SCHEMA = 'mobilebuildmcp.output.ui-action-result';
const CAPTURE_SCHEMA = 'mobilebuildmcp.output.capture-result';
const REFRESH_SNAPSHOT_RECOVERY_HINT =
  'Run snapshot_ui again and retry with a current element reference from the refreshed snapshot.';

const uiActionNextStepContexts = new WeakMap<
  UiActionResultDomainResult,
  RuntimeSnapshotNextStepActionContext
>();

function createDiagnostics(
  warnings: readonly string[] = [],
  errors: readonly string[] = [],
): BasicDiagnostics | undefined {
  if (warnings.length === 0 && errors.length === 0) {
    return undefined;
  }

  return createBasicDiagnostics({ warnings, errors });
}

function compact(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function getUiActionTargetRef(action: UiAction): string | null {
  switch (action.type) {
    case 'tap':
    case 'touch':
    case 'long-press':
    case 'type-text':
      return action.elementRef;
    case 'swipe':
      return action.withinElementRef;
    case 'drag':
      return action.elementRef;
    default:
      return null;
  }
}

function createNextStepActionTarget(
  element: RuntimeElementV1,
): RuntimeSnapshotNextStepActionTarget {
  return {
    ...(element.label !== undefined ? { label: element.label } : {}),
    ...(element.value !== undefined ? { value: element.value } : {}),
    ...(element.identifier !== undefined ? { identifier: element.identifier } : {}),
    ...(element.role !== undefined ? { role: element.role } : {}),
    ...(element.state !== undefined ? { state: element.state } : {}),
  };
}

function findUiActionTargetElement(
  action: UiAction,
  runtimeSnapshot: RuntimeSnapshotV1,
): RuntimeElementV1 | null {
  const targetRef = getUiActionTargetRef(action);
  if (!targetRef) {
    return null;
  }

  return runtimeSnapshot.elements.find((element) => element.ref === targetRef) ?? null;
}

export function createUiAutomationRecoverableError(params: {
  code: UiAutomationRecoverableErrorCode;
  message: string;
  recoveryHint?: string;
  elementRef?: string;
}): UiAutomationRecoverableError {
  return {
    code: params.code,
    message: params.message,
    recoveryHint: params.recoveryHint ?? REFRESH_SNAPSHOT_RECOVERY_HINT,
    ...(params.elementRef ? { elementRef: params.elementRef } : {}),
  };
}

export function createUiActionSuccessResult(
  action: UiAction,
  simulatorId: string,
  warnings: Array<string | null | undefined> = [],
  options: {
    capture?: CapturePayload;
    uiError?: UiAutomationRecoverableError;
    previousRuntimeSnapshot?: RuntimeSnapshotV1;
  } = {},
): UiActionResultDomainResult {
  const result: UiActionResultDomainResult = {
    kind: 'ui-action-result',
    didError: false,
    error: null,
    summary: { status: 'SUCCEEDED' },
    action,
    artifacts: { simulatorId },
    ...(options.capture ? { capture: options.capture } : {}),
    diagnostics: createDiagnostics(compact(warnings), []),
    ...(options.uiError ? { uiError: options.uiError } : {}),
  };

  if (options.previousRuntimeSnapshot) {
    const actionTargetElement = findUiActionTargetElement(action, options.previousRuntimeSnapshot);
    uiActionNextStepContexts.set(result, {
      action,
      previousScreenHash: options.previousRuntimeSnapshot.screenHash,
      ...(actionTargetElement
        ? { actionTarget: createNextStepActionTarget(actionTargetElement) }
        : {}),
    });
  }

  return result;
}

export function createUiActionFailureResult(
  action: UiAction,
  simulatorId: string,
  message: string,
  options: {
    warnings?: Array<string | null | undefined>;
    details?: Array<string | null | undefined>;
    uiError?: UiAutomationRecoverableError;
  } = {},
): UiActionResultDomainResult {
  return {
    kind: 'ui-action-result',
    didError: true,
    error: message,
    summary: { status: 'FAILED' },
    action,
    artifacts: { simulatorId },
    diagnostics: createDiagnostics(compact(options.warnings ?? []), compact(options.details ?? [])),
    ...(options.uiError ? { uiError: options.uiError } : {}),
  };
}

export function createCaptureSuccessResult(
  simulatorId: string,
  options: {
    screenshotPath?: string;
    capture?: CapturePayload;
    warnings?: Array<string | null | undefined>;
    uiError?: UiAutomationRecoverableError;
    waitMatch?: UiWaitMatch;
  } = {},
): CaptureResultDomainResult {
  return {
    kind: 'capture-result',
    didError: false,
    error: null,
    summary: { status: 'SUCCEEDED' },
    artifacts: {
      simulatorId,
      ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
    },
    ...(options.capture ? { capture: options.capture } : {}),
    diagnostics: createDiagnostics(compact(options.warnings ?? []), []),
    ...(options.uiError ? { uiError: options.uiError } : {}),
    ...(options.waitMatch ? { waitMatch: options.waitMatch } : {}),
  };
}

export function createCaptureFailureResult(
  simulatorId: string,
  message: string,
  options: {
    screenshotPath?: string;
    capture?: CapturePayload;
    warnings?: Array<string | null | undefined>;
    details?: Array<string | null | undefined>;
    uiError?: UiAutomationRecoverableError;
  } = {},
): CaptureResultDomainResult {
  return {
    kind: 'capture-result',
    didError: true,
    error: message,
    summary: { status: 'FAILED' },
    artifacts: {
      simulatorId,
      ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
    },
    ...(options.capture ? { capture: options.capture } : {}),
    diagnostics: createDiagnostics(compact(options.warnings ?? []), compact(options.details ?? [])),
    ...(options.uiError ? { uiError: options.uiError } : {}),
  };
}

interface AxeErrorMessages {
  dependencyFailureMessage?: string;
  axeFailureMessage: (error: AxeError) => string;
  systemFailureMessage?: (error: SystemError) => string;
  unexpectedFailureMessage?: (message: string) => string;
}

export function shouldInvalidateRuntimeSnapshotAfterActionError(error: unknown): boolean {
  return error instanceof AxeError;
}

export function mapAxeCommandError(
  error: unknown,
  messages: AxeErrorMessages,
): {
  message: string;
  diagnostics?: BasicDiagnostics;
} {
  if (error instanceof DependencyError) {
    return { message: messages.dependencyFailureMessage ?? AXE_NOT_AVAILABLE_MESSAGE };
  }

  if (error instanceof AxeError) {
    return {
      message: messages.axeFailureMessage(error),
      diagnostics: createDiagnostics([], compact([error.axeOutput || error.message])),
    };
  }

  if (error instanceof SystemError) {
    return {
      message: messages.systemFailureMessage?.(error) ?? 'System error executing axe command.',
      diagnostics: createDiagnostics([], compact([error.message])),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    message: messages.unexpectedFailureMessage?.(message) ?? 'Unexpected UI automation failure.',
    diagnostics: createDiagnostics([], compact([message])),
  };
}

function mergeRuntimeSnapshotRenderHints(
  renderHints: RenderHints | undefined,
  suppressedTargetRefs: readonly string[],
): RenderHints | undefined {
  if (suppressedTargetRefs.length === 0) {
    return renderHints;
  }

  return {
    ...renderHints,
    runtimeSnapshot: {
      ...renderHints?.runtimeSnapshot,
      suppressedTargetRefs,
    },
  };
}

export function setUiActionStructuredOutput(
  ctx: ToolHandlerContext,
  result: UiActionResultDomainResult,
): void {
  if (result.capture && 'type' in result.capture && result.capture.type === 'runtime-snapshot') {
    const actionContext = uiActionNextStepContexts.get(result);
    const suppressedTargetRefs = getForegroundCompletionSuppressedRuntimeTargetRefs({
      simulatorId: result.artifacts.simulatorId,
      runtimeSnapshot: result.capture,
      ...(actionContext ? { actionContext } : {}),
    });
    ctx.structuredOutput = {
      result,
      schema: UI_ACTION_SCHEMA,
      schemaVersion: '2',
      ...(suppressedTargetRefs.length > 0
        ? {
            renderHints: {
              runtimeSnapshot: { suppressedTargetRefs },
            },
          }
        : {}),
    };
    ctx.nextSteps = createRuntimeSnapshotNextSteps({
      simulatorId: result.artifacts.simulatorId,
      runtimeSnapshot: result.capture,
      includeRefreshAndWait: false,
      ...(actionContext ? { actionContext } : {}),
    });
    return;
  }

  ctx.structuredOutput = {
    result,
    schema: UI_ACTION_SCHEMA,
    schemaVersion: '2',
  };
  if (!result.didError) {
    ctx.nextStepParams = { snapshot_ui: { simulatorId: result.artifacts.simulatorId } };
    ctx.nextStepConditionKeys = ['ui_action_needs_refresh'];
  }
}

export function setCaptureStructuredOutput(
  ctx: ToolHandlerContext,
  result: CaptureResultDomainResult,
  renderHints?: RenderHints,
): void {
  const suppressedTargetRefs =
    result.capture && 'type' in result.capture && result.capture.type === 'runtime-snapshot'
      ? getForegroundCompletionSuppressedRuntimeTargetRefs({
          simulatorId: result.artifacts.simulatorId,
          runtimeSnapshot: result.capture,
        })
      : [];
  const mergedRenderHints = mergeRuntimeSnapshotRenderHints(renderHints, suppressedTargetRefs);
  ctx.structuredOutput = {
    result,
    schema: CAPTURE_SCHEMA,
    schemaVersion: '2',
    ...(mergedRenderHints ? { renderHints: mergedRenderHints } : {}),
  };
}
