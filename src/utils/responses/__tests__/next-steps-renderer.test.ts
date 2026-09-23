import { describe, it, expect } from 'vitest';
import {
  processToolResponse,
  renderNextStep,
  renderNextStepsSection,
} from '../next-steps-renderer.ts';
import type { NextStep } from '../../../types/common.ts';

describe('next-steps-renderer', () => {
  describe('renderNextStep', () => {
    it('should format step for CLI with workflow and no params', () => {
      const step: NextStep = {
        tool: 'open_sim',
        cliTool: 'open-sim',
        workflow: 'simulator',
        label: 'Open the Simulator app',
        params: {},
      };

      const result = renderNextStep(step, 'cli');
      expect(result).toBe('Open the Simulator app: mobilebuildmcp simulator open-sim');
    });

    it('should format step for CLI with workflow and params', () => {
      const step: NextStep = {
        tool: 'install_app_sim',
        cliTool: 'install-app-sim',
        workflow: 'simulator',
        label: 'Install an app',
        params: { simulatorId: 'ABC123', appPath: '/path/to/app' },
      };

      const result = renderNextStep(step, 'cli');
      expect(result).toBe(
        'Install an app: mobilebuildmcp simulator install-app-sim --simulator-id ABC123 --app-path /path/to/app',
      );
    });

    it('should use cliTool for CLI rendering', () => {
      const step: NextStep = {
        tool: 'install_app_sim',
        cliTool: 'install-app',
        workflow: 'simulator',
        label: 'Install an app',
        params: { simulatorId: 'ABC123' },
      };

      const result = renderNextStep(step, 'cli');
      expect(result).toBe(
        'Install an app: mobilebuildmcp simulator install-app --simulator-id ABC123',
      );
    });

    it('should fallback to kebab-case tool name for CLI without cliTool', () => {
      const step: NextStep = {
        tool: 'open_sim',
        label: 'Open the Simulator app',
      };

      expect(renderNextStep(step, 'cli')).toBe('Open the Simulator app: mobilebuildmcp open-sim');
    });

    it('should format step for CLI without workflow', () => {
      const step: NextStep = {
        tool: 'open_sim',
        cliTool: 'open-sim',
        label: 'Open the Simulator app',
        params: {},
      };

      const result = renderNextStep(step, 'cli');
      expect(result).toBe('Open the Simulator app: mobilebuildmcp open-sim');
    });

    it('should format step for CLI with boolean param (true)', () => {
      const step: NextStep = {
        tool: 'some_tool',
        cliTool: 'some-tool',
        label: 'Do something',
        params: { verbose: true },
      };

      const result = renderNextStep(step, 'cli');
      expect(result).toBe('Do something: mobilebuildmcp some-tool --verbose');
    });

    it('should format step for CLI with boolean param (false)', () => {
      const step: NextStep = {
        tool: 'some_tool',
        cliTool: 'some-tool',
        label: 'Do something',
        params: { verbose: false },
      };

      const result = renderNextStep(step, 'cli');
      expect(result).toBe('Do something: mobilebuildmcp some-tool');
    });

    it('should shell-escape CLI text params that start with a dash', () => {
      const step: NextStep = {
        tool: 'test_sim',
        cliTool: 'test',
        workflow: 'simulator',
        label: 'Run focused test',
        params: { extraArg: '-only-testing:AppTests' },
      };

      const result = renderNextStep(step, 'cli');
      expect(result).toBe(
        "Run focused test: mobilebuildmcp simulator test --extra-arg '-only-testing:AppTests'",
      );
    });

    it('should shell-escape CLI text params that contain shell metacharacters', () => {
      const step: NextStep = {
        tool: 'launch_app_sim',
        cliTool: 'launch-app',
        workflow: 'simulator',
        label: 'Launch app',
        params: {
          simulatorName: 'Cam "Debug" App',
          bundleId: 'com.example.$APP\\debug',
          launchArg: 'line1\nline2',
        },
      };

      const result = renderNextStep(step, 'cli');
      expect(result).toBe(
        "Launch app: mobilebuildmcp simulator launch-app --simulator-name 'Cam \"Debug\" App' --bundle-id 'com.example.$APP\\debug' --launch-arg 'line1\nline2'",
      );
    });

    it('should format complex CLI params through json', () => {
      const step: NextStep = {
        tool: 'batch',
        cliTool: 'batch',
        workflow: 'ui-automation',
        label: 'Batch same-screen taps',
        params: {
          simulatorId: 'ABC123',
          steps: [
            { action: 'tap', elementRef: 'e1' },
            { action: 'tap', elementRef: 'e2' },
          ],
        },
      };

      const result = renderNextStep(step, 'cli');
      expect(result).toBe(
        'Batch same-screen taps: mobilebuildmcp ui-automation batch --json \'{"simulatorId":"ABC123","steps":[{"action":"tap","elementRef":"e1"},{"action":"tap","elementRef":"e2"}]}\'',
      );
    });

    it('should format step for MCP with no params', () => {
      const step: NextStep = {
        tool: 'open_sim',
        label: 'Open the Simulator app',
      };

      const result = renderNextStep(step, 'mcp');
      expect(result).toBe('Open the Simulator app: open_sim()');
    });

    it('should format step for MCP with params', () => {
      const step: NextStep = {
        tool: 'install_app_sim',
        label: 'Install an app',
        params: { simulatorId: 'ABC123', appPath: '/path/to/app' },
      };

      const result = renderNextStep(step, 'mcp');
      expect(result).toBe(
        'Install an app: install_app_sim({ simulatorId: "ABC123", appPath: "/path/to/app" })',
      );
    });

    it('should format step for MCP with numeric param', () => {
      const step: NextStep = {
        tool: 'some_tool',
        label: 'Do something',
        params: { count: 42 },
      };

      const result = renderNextStep(step, 'mcp');
      expect(result).toBe('Do something: some_tool({ count: 42 })');
    });

    it('should format step for MCP with boolean param', () => {
      const step: NextStep = {
        tool: 'some_tool',
        label: 'Do something',
        params: { verbose: true },
      };

      const result = renderNextStep(step, 'mcp');
      expect(result).toBe('Do something: some_tool({ verbose: true })');
    });

    it('should format complex MCP params as JSON instead of object string coercions', () => {
      const step: NextStep = {
        tool: 'batch',
        label: 'Batch same-screen taps',
        params: {
          simulatorId: 'ABC123',
          steps: [
            { action: 'tap', elementRef: 'e1' },
            { action: 'tap', elementRef: 'e2' },
          ],
        },
      };

      const result = renderNextStep(step, 'mcp');
      expect(result).toBe(
        'Batch same-screen taps: batch({ simulatorId: "ABC123", steps: [{"action":"tap","elementRef":"e1"},{"action":"tap","elementRef":"e2"}] })',
      );
    });

    it('should handle daemon runtime same as MCP', () => {
      const step: NextStep = {
        tool: 'open_sim',
        label: 'Open the Simulator app',
      };

      const result = renderNextStep(step, 'daemon');
      expect(result).toBe('Open the Simulator app: open_sim()');
    });

    it('trims label whitespace before rendering command steps', () => {
      const step: NextStep = {
        tool: 'boot_sim',
        cliTool: 'boot',
        workflow: 'simulator',
        label: '  Boot simulator  ',
        params: { simulatorId: 'SIM-1' },
      };

      expect(renderNextStep(step, 'cli')).toBe(
        'Boot simulator: mobilebuildmcp simulator boot --simulator-id SIM-1',
      );
    });

    it('should render label-only step as plain text', () => {
      const step: NextStep = {
        label: 'Verify layout visually before continuing',
      };

      expect(renderNextStep(step, 'cli')).toBe('Verify layout visually before continuing');
      expect(renderNextStep(step, 'mcp')).toBe('Verify layout visually before continuing');
    });
  });

  describe('processToolResponse', () => {
    it('appends next steps to the last text content item even when a non-text item follows', () => {
      const result = processToolResponse(
        {
          content: [
            { type: 'text', text: 'Initial text' },
            { type: 'image', data: 'base64', mimeType: 'image/png' },
          ],
          nextSteps: [{ tool: 'open_sim', label: 'Open Simulator' }],
        },
        'mcp',
      );

      expect(result.content).toEqual([
        { type: 'text', text: 'Initial text\n\nNext steps:\n1. Open Simulator: open_sim()' },
        { type: 'image', data: 'base64', mimeType: 'image/png' },
      ]);
      expect(result).not.toHaveProperty('nextSteps');
    });

    it('adds a new text item when no text content exists', () => {
      const result = processToolResponse(
        {
          content: [{ type: 'image', data: 'base64', mimeType: 'image/png' }],
          nextSteps: [{ tool: 'open_sim', label: 'Open Simulator' }],
        },
        'mcp',
      );

      expect(result.content).toEqual([
        { type: 'image', data: 'base64', mimeType: 'image/png' },
        { type: 'text', text: 'Next steps:\n1. Open Simulator: open_sim()' },
      ]);
    });
  });

  describe('renderNextStepsSection', () => {
    it('should return empty string for empty steps', () => {
      const result = renderNextStepsSection([], 'cli');
      expect(result).toBe('');
    });

    it('should render numbered list for CLI', () => {
      const steps: NextStep[] = [
        { tool: 'open_sim', cliTool: 'open-sim', label: 'Open Simulator', params: {} },
        {
          tool: 'install_app_sim',
          cliTool: 'install-app-sim',
          label: 'Install app',
          params: { simulatorId: 'X' },
        },
      ];

      const result = renderNextStepsSection(steps, 'cli');
      expect(result).toBe(
        'Next steps:\n' +
          '1. Open Simulator: mobilebuildmcp open-sim\n' +
          '2. Install app: mobilebuildmcp install-app-sim --simulator-id X',
      );
    });

    it('should render numbered list for MCP', () => {
      const steps: NextStep[] = [
        { tool: 'open_sim', label: 'Open Simulator', params: {} },
        { tool: 'install_app_sim', label: 'Install app', params: { simulatorId: 'X' } },
      ];

      const result = renderNextStepsSection(steps, 'mcp');
      expect(result).toBe(
        'Next steps:\n' +
          '1. Open Simulator: open_sim()\n' +
          '2. Install app: install_app_sim({ simulatorId: "X" })',
      );
    });

    it('should sort by priority', () => {
      const steps: NextStep[] = [
        { tool: 'third', label: 'Third', params: {}, priority: 3 },
        { tool: 'first', label: 'First', params: {}, priority: 1 },
        { tool: 'second', label: 'Second', params: {}, priority: 2 },
      ];

      const result = renderNextStepsSection(steps, 'mcp');
      expect(result).toContain('1. First: first()');
      expect(result).toContain('2. Second: second()');
      expect(result).toContain('3. Third: third()');
    });

    it('should render label-only next step without command', () => {
      const steps: NextStep[] = [
        { label: 'Take a look at the screenshot' },
        { tool: 'open_sim', label: 'Open simulator', params: {} },
      ];

      const result = renderNextStepsSection(steps, 'cli');
      expect(result).toContain('1. Take a look at the screenshot');
      expect(result).toContain('2. Open simulator: mobilebuildmcp open-sim');
    });

    it('should not throw when cliTool is absent and tool name contains underscores (regression for #226)', () => {
      // In v2.0.7, snapshot_ui next steps referenced 'tap_coordinate' and 'take_screenshot',
      // which had no catalog entries, so enrichNextStepsForCli left cliTool undefined.
      // The renderer then threw: "Next step for tool 'tap_coordinate' is missing cliTool".
      // The fix: fall back to toKebabCase(tool) instead of throwing.
      const steps: NextStep[] = [
        {
          tool: 'tap_coordinate',
          label: 'Tap on element',
          params: { simulatorId: 'ABC', x: 0, y: 0 },
        },
        {
          tool: 'take_screenshot',
          label: 'Take screenshot for verification',
          params: { simulatorId: 'ABC' },
        },
      ];

      expect(() => renderNextStepsSection(steps, 'cli')).not.toThrow();
      const result = renderNextStepsSection(steps, 'cli');
      expect(result).toContain('mobilebuildmcp tap-coordinate');
      expect(result).toContain('mobilebuildmcp take-screenshot');
    });
  });
});
