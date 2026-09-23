import * as z from 'zod';
import type { ToolHandlerContext } from '../../../rendering/types.ts';
import type { WorkflowSelectionDomainResult } from '../../../types/domain-results.ts';
import type { NonStreamingExecutor } from '../../../types/tool-execution.ts';
import { nullifyEmptyStrings } from '../../../utils/schema-helpers.ts';
import { createTypedTool, getHandlerContext } from '../../../utils/typed-tool-factory.ts';
import { getDefaultCommandExecutor, type CommandExecutor } from '../../../utils/execution/index.ts';
import {
  applyWorkflowSelectionFromManifest,
  getRegisteredWorkflows,
  getMcpPredicateContext,
} from '../../../utils/tool-registry.ts';
import { toErrorMessage } from '../../../utils/errors.ts';

const baseSchemaObject = z.object({
  workflowNames: z.array(z.string()).describe('Workflow directory name(s).'),
  enable: z.boolean().describe('Enable or disable the selected workflows.'),
});

const manageWorkflowsSchema = z.preprocess(nullifyEmptyStrings, baseSchemaObject);

export type ManageWorkflowsParams = z.infer<typeof manageWorkflowsSchema>;
type ManageWorkflowsResult = WorkflowSelectionDomainResult;

const STRUCTURED_OUTPUT_SCHEMA = 'mobilebuildmcp.output.workflow-selection';

function createManageWorkflowsResult(
  enabledWorkflows: string[],
  registeredToolCount: number,
): ManageWorkflowsResult {
  return {
    kind: 'workflow-selection',
    didError: false,
    error: null,
    enabledWorkflows,
    registeredToolCount,
  };
}

function createManageWorkflowsErrorResult(message: string): ManageWorkflowsResult {
  return {
    kind: 'workflow-selection',
    didError: true,
    error: message,
    enabledWorkflows: [],
    registeredToolCount: 0,
  };
}

function setStructuredOutput(ctx: ToolHandlerContext, result: ManageWorkflowsResult): void {
  ctx.structuredOutput = {
    result,
    schema: STRUCTURED_OUTPUT_SCHEMA,
    schemaVersion: '2',
  };
}

export function createManageWorkflowsExecutor(): NonStreamingExecutor<
  ManageWorkflowsParams,
  ManageWorkflowsResult
> {
  return async (params) => {
    try {
      const workflowNames = params.workflowNames;
      const currentWorkflows = getRegisteredWorkflows();
      const requestedSet = new Set(
        workflowNames.map((name) => name.trim().toLowerCase()).filter(Boolean),
      );
      let nextWorkflows: string[];
      if (params.enable === false) {
        nextWorkflows = currentWorkflows.filter((name) => !requestedSet.has(name.toLowerCase()));
      } else {
        nextWorkflows = [...new Set([...currentWorkflows, ...workflowNames])];
      }

      const predicateContext = getMcpPredicateContext();
      const registryState = await applyWorkflowSelectionFromManifest(
        nextWorkflows,
        predicateContext,
      );

      return createManageWorkflowsResult(
        registryState.enabledWorkflows,
        registryState.registeredToolCount,
      );
    } catch (error) {
      const message = `Failed to update workflows: ${toErrorMessage(error)}`;
      return createManageWorkflowsErrorResult(message);
    }
  };
}

export async function manage_workflowsLogic(
  params: ManageWorkflowsParams,
  _neverExecutor: CommandExecutor,
): Promise<void> {
  const ctx = getHandlerContext();
  const executeManageWorkflows = createManageWorkflowsExecutor();
  const result = await executeManageWorkflows(params);

  setStructuredOutput(ctx, result);
}

export const schema = baseSchemaObject.shape;

export const handler = createTypedTool(
  manageWorkflowsSchema,
  manage_workflowsLogic,
  getDefaultCommandExecutor,
);
