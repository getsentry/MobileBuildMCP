import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { log } from './logger.ts';
import { iOSTemplateVersion, macOSTemplateVersion } from '../version.ts';
import type { CommandExecutor } from './command.ts';
import type { FileSystemExecutor } from './FileSystemExecutor.ts';
import { getConfig } from './config-store.ts';

/**
 * Template manager for downloading and managing project templates
 */
export class TemplateManager {
  private static readonly GITHUB_ORG = 'getsentry';
  private static readonly IOS_TEMPLATE_REPO = 'XcodeBuildMCP-iOS-Template';
  private static readonly MACOS_TEMPLATE_REPO = 'XcodeBuildMCP-macOS-Template';

  /**
   * Get the template path for a specific platform
   * Checks for local override via environment variable first
   */
  static async getTemplatePath(
    platform: 'iOS' | 'macOS',
    commandExecutor: CommandExecutor,
    fileSystemExecutor: FileSystemExecutor,
  ): Promise<string> {
    const config = getConfig();
    const localPath = platform === 'iOS' ? config.iosTemplatePath : config.macosTemplatePath;
    log(
      'debug',
      `[TemplateManager] Checking config override for ${platform} template. Value: '${localPath}'`,
    );

    if (localPath) {
      const pathExists = fileSystemExecutor.existsSync(localPath);
      log(
        'debug',
        `[TemplateManager] Config override set. Path '${localPath}' exists? ${pathExists}`,
      );
      if (pathExists) {
        const templateSubdir = join(localPath, 'template');
        const subdirExists = fileSystemExecutor.existsSync(templateSubdir);
        log(
          'debug',
          `[TemplateManager] Checking for subdir '${templateSubdir}'. Exists? ${subdirExists}`,
        );
        if (subdirExists) {
          log('info', `Using local ${platform} template from: ${templateSubdir}`);
          return templateSubdir;
        } else {
          log('info', `Template directory not found in ${localPath}, using GitHub release`);
        }
      }
    }

    log('debug', '[TemplateManager] No valid config override, proceeding to download.');
    // Download from GitHub release
    return await this.downloadTemplate(platform, commandExecutor, fileSystemExecutor);
  }

  /**
   * Download template from GitHub release
   */
  private static async downloadTemplate(
    platform: 'iOS' | 'macOS',
    commandExecutor: CommandExecutor,
    fileSystemExecutor: FileSystemExecutor,
  ): Promise<string> {
    const repo = platform === 'iOS' ? this.IOS_TEMPLATE_REPO : this.MACOS_TEMPLATE_REPO;
    const defaultVersion =
      platform === 'iOS' ? String(iOSTemplateVersion) : String(macOSTemplateVersion);
    const config = getConfig();
    const version = String(
      platform === 'iOS'
        ? (config.iosTemplateVersion ?? defaultVersion)
        : (config.macosTemplateVersion ?? defaultVersion),
    );

    // Create temp directory for download
    const tempDir = join(tmpdir(), `mobilebuild-mcp-template-${randomUUID()}`);
    await fileSystemExecutor.mkdir(tempDir, { recursive: true });

    try {
      const downloadUrl = `https://github.com/${this.GITHUB_ORG}/${repo}/releases/download/${version}/${repo}-${version.substring(1)}.zip`;
      const zipPath = join(tempDir, 'template.zip');

      log('info', `Downloading ${platform} template ${version} from GitHub...`);
      log('info', `Download URL: ${downloadUrl}`);

      const curlResult = await commandExecutor(
        ['curl', '-L', '-f', '-o', zipPath, downloadUrl],
        'Download Template',
        true,
        undefined,
      );

      if (!curlResult.success) {
        throw new Error(`Failed to download template: ${curlResult.error}`);
      }

      const unzipResult = await commandExecutor(
        ['unzip', '-q', zipPath],
        'Extract Template',
        true,
        { cwd: tempDir },
      );

      if (!unzipResult.success) {
        throw new Error(`Failed to extract template: ${unzipResult.error}`);
      }

      // Find the extracted directory and return the template subdirectory
      const extractedDir = join(tempDir, `${repo}-${version.substring(1)}`);
      if (!fileSystemExecutor.existsSync(extractedDir)) {
        throw new Error(`Expected template directory not found: ${extractedDir}`);
      }

      log('info', `Successfully downloaded ${platform} template ${version}`);
      return extractedDir;
    } catch (error) {
      // Clean up on error
      log('error', `Failed to download ${platform} template ${version}: ${error}`);
      await this.cleanup(tempDir, fileSystemExecutor);
      throw error;
    }
  }

  /**
   * Clean up downloaded template directory
   */
  static async cleanup(
    templatePath: string,
    fileSystemExecutor: FileSystemExecutor,
  ): Promise<void> {
    // Only clean up if it's in temp directory
    if (templatePath.startsWith(tmpdir())) {
      await fileSystemExecutor.rm(templatePath, { recursive: true, force: true });
    }
  }
}
