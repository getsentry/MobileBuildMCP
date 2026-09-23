import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayPath } from '../../build-preflight.ts';
import { formatPathTree } from '../path-tree.ts';

const homePath = homedir();
const homeParentPath = dirname(homePath);
const homeDirectoryName = basename(homePath);
const workspaceKey = 'CalculatorApp-9f3a7c2d1b44';
const derivedDataDirectoryName = 'CalculatorApp-7834e7689e33';
const buildLogFileName = 'build_run_sim_2026-05-07T12-47-52-599Z_pid24748_31629ebe.log';
const runtimeLogFileName =
  'io.sentry.calculatorapp_2026-05-07T12-48-10-840Z_helperpid25309_ownerpid24748_88fd8a4f.log';
const osLogFileName =
  'io.sentry.calculatorapp_oslog_2026-05-07T12-48-12-805Z_helperpid25369_ownerpid24748_14da7d85.log';
const managedWorkspacePath = `${homePath}/Library/Developer/MobileBuildMCP/workspaces/${workspaceKey}`;

describe('formatPathTree', () => {
  it('groups paths by their shared ancestor before display formatting', () => {
    expect(
      formatPathTree(
        [
          {
            label: 'OSLog',
            path: `${managedWorkspacePath}/logs/${osLogFileName}`,
          },
          {
            label: 'App Path',
            path: `${managedWorkspacePath}/DerivedData/${derivedDataDirectoryName}/Build/Products/Debug-iphonesimulator/CalculatorApp.app`,
          },
          {
            label: 'Runtime Logs',
            path: `${managedWorkspacePath}/logs/${runtimeLogFileName}`,
          },
          {
            label: 'Build Logs',
            path: `${managedWorkspacePath}/logs/${buildLogFileName}`,
          },
        ],
        { formatPath: displayPath },
      ),
    ).toEqual([
      `└── ~/Library/Developer/MobileBuildMCP/workspaces/${workspaceKey}/`,
      `    ├── DerivedData/${derivedDataDirectoryName}/Build/Products/Debug-iphonesimulator/CalculatorApp.app — App Path`,
      '    └── logs/',
      `        ├── ${buildLogFileName} — Build Logs`,
      `        ├── ${runtimeLogFileName} — Runtime Logs`,
      `        └── ${osLogFileName} — OSLog`,
    ]);
  });

  it('renders separate roots when paths do not share a meaningful ancestor', () => {
    expect(
      formatPathTree(
        [
          {
            label: 'Build Logs',
            path: `${managedWorkspacePath}/logs/${buildLogFileName}`,
          },
          {
            label: 'App Path',
            path: '/Volumes/CustomDerivedData/CalculatorApp/Build/Products/Debug-iphonesimulator/CalculatorApp.app',
          },
          {
            label: 'Runtime Logs',
            path: `${managedWorkspacePath}/logs/${runtimeLogFileName}`,
          },
        ],
        { formatPath: displayPath },
      ),
    ).toEqual([
      `├── ~/Library/Developer/MobileBuildMCP/workspaces/${workspaceKey}/logs/`,
      `│   ├── ${buildLogFileName} — Build Logs`,
      `│   └── ${runtimeLogFileName} — Runtime Logs`,
      '└── /Volumes/CustomDerivedData/CalculatorApp/Build/Products/Debug-iphonesimulator/CalculatorApp.app — App Path',
    ]);
  });

  it('preserves raw shared ancestry even when a descendant path would display differently alone', () => {
    const childLines = [
      `${homeDirectoryName}/Library/Logs/build.log — User Logs`,
      'other/Library/Logs/build.log — Other Logs',
    ].sort();

    expect(
      formatPathTree(
        [
          { label: 'User Logs', path: `${homePath}/Library/Logs/build.log` },
          { label: 'Other Logs', path: `${homeParentPath}/other/Library/Logs/build.log` },
        ],
        { formatPath: displayPath },
      ),
    ).toEqual([`└── ${homeParentPath}/`, `    ├── ${childLines[0]}`, `    └── ${childLines[1]}`]);
  });

  it('sorts relative paths before rendering', () => {
    expect(
      formatPathTree([
        { label: 'Runtime Logs', path: 'tmp/runtime.log' },
        { label: 'Build Logs', path: 'tmp/build.log' },
        { label: 'App Path', path: 'build/Products/App.app' },
      ]),
    ).toEqual([
      '├── build/Products/App.app — App Path',
      '└── tmp/',
      '    ├── build.log — Build Logs',
      '    └── runtime.log — Runtime Logs',
    ]);
  });

  it('ignores blank paths', () => {
    expect(
      formatPathTree(
        [
          { label: 'Blank', path: ' ' },
          { label: 'Build Logs', path: `${homePath}/Library/Logs/build.log` },
        ],
        { formatPath: displayPath },
      ),
    ).toEqual(['└── ~/Library/Logs/build.log — Build Logs']);
  });
});
